import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AnchorStore,
  PRUNE_MARKER,
  alreadySpilled,
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
  scope?: any
} = {}): { host: any; receipts: any[] } {
  const host = fakeHost()
  const receipts: any[] = []
  const deps: any = {
    config: DEFAULT_CONFIG,
    // Same cached judgement the protocol section reads; in scope by default.
    scope: over.scope ?? { judgement: () => true },
    receipts: over.receipts ?? { append: async (r: any) => { receipts.push(r) } },
    // Default: no host notice, so the suite never needs the host spill package.
    hasSpillNotice: over.hasSpillNotice ?? (() => false),
  }
  if (over.anchors !== undefined) deps.anchors = over.anchors
  registerHooks(host, deps)
  return { host, receipts }
}

/** Run the post-execute waterfall once; `content` may be one string or several text blocks. */
async function runPost(
  host: any,
  content: string | ReadonlyArray<{ type: string; text?: string }>,
  decision: any = { kind: 'accept' },
): Promise<any> {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  return host.callHook(
    'tools/post-execute',
    [agentExec(), { content: blocks }],
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

test('post-execute 不跑锚点比较：文本不同但无 marker 时不写 reset（F1）', async () => {
  const anchors = new AnchorStore()
  anchors.set(SESSION, { stepId: 'B', anchors: { B: 'original text' } })
  const { host, receipts } = hookSetup({ anchors })
  const decision = { kind: 'accept' }

  const res = await runPost(host, 'completely different', decision)

  assert.equal(res, decision)
  assert.notEqual(anchors.get(SESSION), undefined, 'the anchor branch belongs to 23c')
  assert.equal(receipts.length, 0)
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

  const res = await runPost(host, `head${PRUNE_MARKER}tail`, decision)

  assert.equal(res, decision)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].code, 'pruned-reset')
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

  const res = await runPost(host, `head${PRUNE_MARKER}tail`, decision)

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

// ---------------------------------------------------------------------------
// 评审修复：scope 闸门、跨 block 页脚、marker 位置与优先级
// ---------------------------------------------------------------------------

test('超出 scope 的会话：两个守卫都不运行，pending 不动、notice 不调用', async () => {
  const seen: string[] = []
  const anchors = new AnchorStore()
  anchors.set(SESSION, { stepId: 'A', anchors: { A: 'original text' } })
  const { host, receipts } = hookSetup({
    anchors,
    scope: { judgement: () => false },
    hasSpillNotice: (text) => { seen.push(text); return false },
  })

  const res = await runPost(host, 'completely different')

  assert.equal(res.kind, 'accept')
  assert.notEqual(anchors.get(SESSION), undefined)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0]?.kind, 'skip')
  assert.equal(receipts[0]?.code, 'skip:no-scope')
  assert.deepEqual(seen, [])
})

test('judgement 缓存未命中（无 judgement 方法）同样 fail-closed：守卫不运行', async () => {
  const seen: string[] = []
  const anchors = new AnchorStore()
  anchors.set(SESSION, { stepId: 'A', anchors: { A: 'original text' } })
  const { host, receipts } = hookSetup({
    anchors,
    scope: {},
    hasSpillNotice: (text) => { seen.push(text); return false },
  })

  const res = await runPost(host, 'completely different')

  assert.equal(res.kind, 'accept')
  assert.notEqual(anchors.get(SESSION), undefined)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0]?.kind, 'skip')
  assert.equal(receipts[0]?.code, 'skip:no-scope')
  assert.deepEqual(seen, [])
})

test('marker 出现两次：只写一条 reset 收据', async () => {
  const anchors = new AnchorStore()
  const text = `${PRUNE_MARKER}body${PRUNE_MARKER}`
  anchors.set(SESSION, { stepId: 'A', anchors: { A: text } })
  const { host, receipts } = hookSetup({ anchors })

  const res = await runPost(host, text)

  assert.equal(res.kind, 'accept')
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].code, 'pruned-reset')
})

test('marker 在非第一个 text block 里也识别（canonicalise 合并后判定）', async () => {
  const anchors = new AnchorStore()
  const joined = `head${PRUNE_MARKER}tail`
  anchors.set(SESSION, { stepId: 'A', anchors: { A: joined } })
  const { host, receipts } = hookSetup({ anchors })

  const res = await runPost(host, [
    { type: 'text', text: 'head' },
    { type: 'text', text: PRUNE_MARKER },
    { type: 'text', text: 'tail' },
  ])

  assert.equal(res.kind, 'accept')
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].code, 'pruned-reset')
})

test('跨 block 的 spill 页脚：canonicalise 合并后仍被 notice 断言识别', async () => {
  const footer = 'head\n\n(Omitted 12 bytes. Full formatted result stored at: /spill/x.txt. Use read.)'
  const seen: string[] = []
  const { host, receipts } = hookSetup({
    hasSpillNotice: (text) => { seen.push(text); return text === footer },
  })

  const res = await runPost(host, [
    { type: 'text', text: 'head\n\n(Omitted 12 bytes. Full formatted ' },
    { type: 'text', text: 'result stored at: /spill/x.txt. Use read.)' },
  ])

  assert.equal(res.kind, 'accept')
  assert.deepEqual(seen, [footer])
  assert.equal(receipts.length, 0)
})

test('next() 的 decision 已带 spill 页脚（result 没有）：跳过投影', async () => {
  const footer = 'head\n\n(Omitted 12 bytes. Full formatted result stored at: /spill/x.txt. Use read.)'
  const seen: string[] = []
  const { host, receipts } = hookSetup({
    hasSpillNotice: (text) => { seen.push(text); return text === footer },
  })
  const decision = {
    kind: 'accept',
    content: [
      { type: 'text', text: 'head\n\n(Omitted 12 bytes. Full formatted ' },
      { type: 'text', text: 'result stored at: /spill/x.txt. Use read.)' },
    ],
  }

  const res = await runPost(host, 'plain tool output', decision)

  assert.equal(res, decision)
  // 先看到达时的原文，再看 next() 之后的 decision 正文；页脚只存在于后者。
  assert.deepEqual(seen, ['plain tool output', footer])
  assert.equal(receipts.length, 0)
})

test('pruned 与 already-spilled 同时成立：pruned-reset 先赢，只写一条收据', async () => {
  const footer = 'body\n\n(Omitted 12 bytes. Full formatted result stored at: /spill/x.txt. Use read.)'
  const text = `${PRUNE_MARKER}${footer}`
  const seen: string[] = []
  const anchors = new AnchorStore()
  anchors.set(SESSION, { stepId: 'A', anchors: { A: text } })
  const { host, receipts } = hookSetup({
    anchors,
    hasSpillNotice: (value) => { seen.push(value); return true },
  })

  const res = await runPost(host, text)

  assert.equal(res.kind, 'accept')
  assert.equal(anchors.get(SESSION), undefined)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].code, 'pruned-reset')
  assert.deepEqual(seen, [])
})

test('malformed anchor 记录在 hook 里不抛：marker 仍判 pruned-reset', async () => {
  const anchors = {
    get: () => ({ stepId: 'A' }),
    clear: () => {},
  }
  const { host, receipts } = hookSetup({ anchors })

  const res = await runPost(host, `head${PRUNE_MARKER}tail`)

  assert.equal(res.kind, 'accept')
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].code, 'pruned-reset')
})

test('非对象 anchors 且无 marker：hook 不写收据、不抛', async () => {
  const anchors = {
    get: () => ({ stepId: 'A', anchors: 'nope' }),
    clear: () => {},
  }
  const { host, receipts } = hookSetup({ anchors })

  const res = await runPost(host, 'plain output')

  assert.equal(res.kind, 'accept')
  assert.equal(receipts.length, 0)
})

// ---------------------------------------------------------------------------
// I9: `invalidate` had no production caller; the model-request path owns the
// identity check with `looksPruned`/`carriesAnchor` instead.
// ---------------------------------------------------------------------------

test('I9: the uncalled invalidate() arm is gone from the production module', async () => {
  const module = await import('../src/gate/invalidate.ts')
  assert.equal('invalidate' in module, false)
})
