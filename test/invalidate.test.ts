import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AnchorStore,
  PRUNE_MARKER,
  alreadySpilled,
  invalidate,
  looksPruned,
} from '../src/gate/invalidate.ts'
import { registerHooks } from '../src/hooks/post-execute.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { fakeHost } from './fakes/host.ts'

// ---------------------------------------------------------------------------
// 任务简报的六个测试（逐字保留）
// ---------------------------------------------------------------------------

test('识别宿主 pruner 的截断标记', () => {
  assert.equal(looksPruned(`head${PRUNE_MARKER}tail`), true)
  assert.equal(looksPruned('plain output'), false)
})

test('已含 spill 页脚的回执不再二次投影', () => {
  assert.equal(alreadySpilled('x', () => true), true)
  assert.equal(alreadySpilled('x', () => false), false)
})

test('marker 出现即判 pruned-reset（锚点仍相等，pruner 保留锚点）', () => {
  const t = `head${PRUNE_MARKER}tail`
  const pending = { stepId: 'A', anchors: { A: t } } as any
  assert.equal(invalidate(pending, t), 'pruned-reset')
})

test('锚点不符且无 marker 判 compaction-reset', () => {
  const pending = { stepId: 'A', anchors: { A: 'original text' } } as any
  assert.equal(invalidate(pending, 'completely different'), 'compaction-reset')
})

test('锚点相等且无 marker 不触发', () => {
  const pending = { stepId: 'A', anchors: { A: 'same' } } as any
  assert.equal(invalidate(pending, 'same'), undefined)
})

test('无 pending 不触发', () => {
  assert.equal(invalidate(undefined, 'x'), undefined)
})

// ---------------------------------------------------------------------------
// 规则 2：marker 只按完整子串识别，位置无关，近失配必须为 false
// ---------------------------------------------------------------------------

test('marker 在文本最前、最后或整段时也识别', () => {
  assert.equal(looksPruned(`${PRUNE_MARKER}tail`), true)
  assert.equal(looksPruned(`head${PRUNE_MARKER}`), true)
  assert.equal(looksPruned(PRUNE_MARKER), true)
})

test('近似 marker（改一个字符）不识别，方向安全', () => {
  const nearMiss = PRUNE_MARKER.replace('pruned', 'prunef')
  assert.notEqual(nearMiss, PRUNE_MARKER)
  assert.equal(looksPruned(`head${nearMiss}tail`), false)
})

// ---------------------------------------------------------------------------
// 规则 4：marker 优先于锚点比对；anchor 缺失 / 相等都不触发
// ---------------------------------------------------------------------------

test('marker 与锚点同时不符：marker 优先判 pruned-reset', () => {
  const pending = { stepId: 'A', anchors: { A: 'original text' } } as any
  const t = `head${PRUNE_MARKER}tail`
  assert.equal(invalidate(pending, t), 'pruned-reset')
})

test('回执恰好就是 marker：判 pruned-reset', () => {
  const pending = { stepId: 'A', anchors: { A: PRUNE_MARKER } } as any
  assert.equal(invalidate(pending, PRUNE_MARKER), 'pruned-reset')
})

test('anchor 缺失且无 marker 不触发', () => {
  const pending = { stepId: 'A', anchors: {} } as any
  assert.equal(invalidate(pending, 'anything'), undefined)
})

test('空串 anchor 与空串回执相等：不触发（不是"缺失"）', () => {
  const pending = { stepId: 'A', anchors: { A: '' } } as any
  assert.equal(invalidate(pending, ''), undefined)
})

test('已含 spill 页脚但无 marker：alreadySpilled 拦截且 invalidate 沉默', () => {
  const footer = 'head\n\n(Omitted 12 bytes. Full formatted result stored at: /spill/x.txt. Use read.)'
  assert.equal(alreadySpilled(footer, (t) => t === footer), true)
  const pending = { stepId: 'A', anchors: { A: footer } } as any
  assert.equal(invalidate(pending, footer), undefined)
})

// ---------------------------------------------------------------------------
// 规则 6：AnchorStore 是纯会话键映射
// ---------------------------------------------------------------------------

test('AnchorStore 按会话隔离、覆盖与清除', () => {
  const store = new AnchorStore()
  const first = { stepId: 'A', anchors: { A: 'one' } }
  const second = { stepId: 'B', anchors: { B: 'two' } }

  assert.equal(store.get('s1'), undefined)
  store.set('s1', first)
  store.set('s2', second)
  assert.equal(store.get('s1'), first)
  assert.equal(store.get('s2'), second)

  const overwritten = { stepId: 'C', anchors: { C: 'three' } }
  store.set('s1', overwritten)
  assert.equal(store.get('s1'), overwritten)
  assert.equal(store.get('s2'), second)

  store.clear('s1')
  assert.equal(store.get('s1'), undefined)
  assert.equal(store.get('s2'), second)
  assert.doesNotThrow(() => store.clear('never-set'))
})

// ---------------------------------------------------------------------------
// 规则 5 / 7：post-execute 接线
// ---------------------------------------------------------------------------

const SESSION = 's1'

/** One post-execute `exec` with the real nested agent shape. */
function agentExec(name = 'read'): any {
  return { name, agent: { session: { header: { id: SESSION, cwd: '/w' } } } }
}

/** Mount the hooks against a fake host with a recording receipt store. */
function hookSetup(over: {
  anchors?: any
  hasSpillNotice?: (text: string) => boolean
  receipts?: any
} = {}): { host: any; receipts: any[] } {
  const host = fakeHost()
  const receipts: any[] = []
  const deps: any = {
    config: DEFAULT_CONFIG,
    scope: {},
    receipts: over.receipts ?? { append: async (r: any) => { receipts.push(r) } },
    // Default: no host notice, so the suite never needs the host spill package.
    hasSpillNotice: over.hasSpillNotice ?? (() => false),
  }
  if (over.anchors !== undefined) deps.anchors = over.anchors
  registerHooks(host, deps)
  return { host, receipts }
}

/** Run the post-execute waterfall once with one text receipt. */
async function runPost(host: any, text: string, decision: any = { kind: 'accept' }): Promise<any> {
  return host.callHook(
    'tools/post-execute',
    [agentExec(), { content: [{ type: 'text', text }] }],
    async () => decision,
  )
}

test('post-execute 命中 pruned-reset：清空 pending 并写 reset 收据', async () => {
  const anchors = new AnchorStore()
  const text = `head${PRUNE_MARKER}tail`
  anchors.set(SESSION, { stepId: 'A', anchors: { A: text } })
  const { host, receipts } = hookSetup({ anchors })
  const decision = { kind: 'accept' }

  const res = await runPost(host, text, decision)

  assert.equal(res, decision)
  assert.equal(anchors.get(SESSION), undefined)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].version, 1)
  assert.equal(receipts[0].kind, 'reset')
  assert.equal(receipts[0].code, 'pruned-reset')
  assert.equal(receipts[0].sessionId, SESSION)
  assert.equal(receipts[0].stepId, 'A')
  assert.equal(receipts[0].tool, 'read')
  assert.equal(typeof receipts[0].turn, 'number')
})

test('post-execute 命中 compaction-reset：清空 pending 并写 reset 收据', async () => {
  const anchors = new AnchorStore()
  anchors.set(SESSION, { stepId: 'B', anchors: { B: 'original text' } })
  const { host, receipts } = hookSetup({ anchors })
  const decision = { kind: 'accept' }

  const res = await runPost(host, 'completely different', decision)

  assert.equal(res, decision)
  assert.equal(anchors.get(SESSION), undefined)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].kind, 'reset')
  assert.equal(receipts[0].code, 'compaction-reset')
  assert.equal(receipts[0].stepId, 'B')
})

test('锚点相等且无 marker：post-execute 不清 pending、不写 reset 收据', async () => {
  const anchors = new AnchorStore()
  anchors.set(SESSION, { stepId: 'A', anchors: { A: 'same' } })
  const { host, receipts } = hookSetup({ anchors })
  const decision = { kind: 'accept' }

  const res = await runPost(host, 'same', decision)

  assert.equal(res, decision)
  assert.notEqual(anchors.get(SESSION), undefined)
  assert.equal(receipts.length, 0)
})

test('无锚点时 post-execute 不写 reset 收据', async () => {
  const { host, receipts } = hookSetup()
  const decision = { kind: 'accept' }

  const res = await runPost(host, `head${PRUNE_MARKER}tail`, decision)

  assert.equal(res, decision)
  assert.equal(receipts.length, 0)
})

test('锚点存储 get 抛错时 post-execute 不抛，下游 decision 原样返回', async () => {
  const anchors = {
    get(): never { throw new Error('anchor get boom') },
    clear(): never { throw new Error('anchor clear boom') },
  }
  const { host, receipts } = hookSetup({ anchors })
  const decision = { kind: 'accept' }

  const res = await runPost(host, `head${PRUNE_MARKER}tail`, decision)

  assert.equal(res, decision)
  assert.equal(receipts.length, 0)
})

test('锚点存储 clear 抛错时仍然写 reset 收据且不抛', async () => {
  const anchors = {
    get: () => ({ stepId: 'A', anchors: { A: 'original text' } }),
    clear(): never { throw new Error('anchor clear boom') },
  }
  const { host, receipts } = hookSetup({ anchors })
  const decision = { kind: 'accept' }

  const res = await runPost(host, 'completely different', decision)

  assert.equal(res, decision)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].code, 'compaction-reset')
})

test('锚点存储返回 null 且回执带 marker 时 post-execute 不抛', async () => {
  const anchors = {
    get: () => null,
    clear: () => {},
  }
  const { host, receipts } = hookSetup({ anchors })
  const decision = { kind: 'accept' }

  const res = await runPost(host, `head${PRUNE_MARKER}tail`, decision)

  assert.equal(res, decision)
  assert.equal(receipts.length, 0)
})

test('收据写失败时 post-execute 不抛，pending 仍被清空', async () => {
  const anchors = new AnchorStore()
  anchors.set(SESSION, { stepId: 'A', anchors: { A: 'same' } })
  const { host } = hookSetup({
    anchors,
    receipts: { append: async (): Promise<void> => { throw new Error('receipt boom') } },
  })
  const decision = { kind: 'accept' }

  const res = await runPost(host, 'completely different', decision)

  assert.equal(res, decision)
  assert.equal(anchors.get(SESSION), undefined)
})

test('notice 断言抛错时 post-execute 不抛，下游 decision 原样返回', async () => {
  const { host, receipts } = hookSetup({
    hasSpillNotice: () => { throw new Error('notice boom') },
  })
  const decision = { kind: 'accept' }

  const res = await runPost(host, 'plain output', decision)

  assert.equal(res, decision)
  assert.equal(receipts.length, 0)
})

test('已含 spill 页脚：post-execute 先问 notice 断言，且不写 reset 收据', async () => {
  const seen: string[] = []
  const footer = 'head\n\n(Omitted 12 bytes. Full formatted result stored at: /spill/x.txt. Use read.)'
  const anchors = new AnchorStore()
  anchors.set(SESSION, { stepId: 'A', anchors: { A: footer } })
  const { host, receipts } = hookSetup({
    anchors,
    hasSpillNotice: (text) => { seen.push(text); return true },
  })
  const decision = { kind: 'accept' }

  const res = await runPost(host, footer, decision)

  assert.equal(res, decision)
  assert.deepEqual(seen, [footer])
  assert.equal(receipts.length, 0)
  assert.notEqual(anchors.get(SESSION), undefined)
})
