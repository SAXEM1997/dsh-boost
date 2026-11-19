import test from 'node:test'
import assert from 'node:assert/strict'
import { choose, SELECTOR_PURPOSE } from '../src/selector/jev.ts'

const ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }

const llmOf = (chunks: string[], delay = 0) => ({
  async *stream(opts: any) {
    for (const c of chunks) { if (delay) await new Promise(r => setTimeout(r, delay)); yield { text: c } }
    return opts
  }
})

const cands = [{ id: 'A', summary: 'read /a' }, { id: 'B', summary: 'read /b' }]

test('单标签被解析为选择', async () => {
  const r = await choose({ llm: llmOf(['B']) as any, provider: 'deepseek', model: 'deepseek-chat', candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { choice: 'B' })
})

test('问号与其它字符一律 abstain:no-label', async () => {
  for (const s of ['?', 'AB', 'neither']) {
    const r = await choose({ llm: llmOf([s]) as any, provider: 'deepseek', model: 'deepseek-chat', candidates: cands, receiptText: 'x', maxTokens: 512 })
    assert.deepEqual(r, { abstain: 'no-label' })
  }
})

test('超时 abstain:timeout', async () => {
  const r = await choose({ llm: llmOf(['A'], 100) as any, provider: 'deepseek', model: 'deepseek-chat', candidates: cands, receiptText: 'x', maxTokens: 512, timeoutMs: 10 })
  assert.deepEqual(r, { abstain: 'timeout' })
})

test('调用抛错 abstain:error', async () => {
  const llm = { async *stream() { throw new Error('boom') } }
  const r = await choose({ llm: llm as any, provider: 'deepseek', model: 'deepseek-chat', candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { abstain: 'error' })
})

test('stream 收到 purpose 与 route（R17）', async () => {
  let seen: any
  const llm = { async *stream(opts: any) { seen = opts; yield { type: 'text-delta', index: 0, text: 'B' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  await choose({ llm: llm as any, provider: 'p', model: 'm', candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.equal(seen.purpose, SELECTOR_PURPOSE)
  assert.equal(seen.provider, 'p'); assert.equal(seen.model, 'm')
  assert.equal(seen.maxTokens, 512)
})

/* ------------------------------------------------------------------------- *
 * 补齐规则 2–7 的边界：分片累加、终止原因、空表、重试与计时器
 * ------------------------------------------------------------------------- */

const typed = (texts: string[], finish: any = { kind: 'stop' }) => ({
  async *stream() {
    for (const text of texts) yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: finish }
  },
})

test('多个 typed text-delta 累加，忽略 reasoning 与其它分支', async () => {
  const llm = {
    async *stream() {
      yield { type: 'reasoning-delta', index: 0, text: 'Z' }
      yield { type: 'text-delta', index: 0, text: ' ' }
      yield { type: 'text-delta', index: 0, text: 'B' }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '\n' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const r = await choose({ llm: llm as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { choice: 'B' })
})

test('标签两侧空白被裁剪', async () => {
  const r = await choose({ llm: typed(['\n  A \t']) as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { choice: 'A' })
})

test('文本之后 finish:error 仍判 error，且只调用一次', async () => {
  let calls = 0
  const llm = {
    async *stream() {
      calls++
      yield { type: 'text-delta', index: 0, text: 'A' }
      yield { type: 'finish', reason: { kind: 'error' } }
    },
  }
  const r = await choose({ llm: llm as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { abstain: 'error' })
  assert.equal(calls, 1)
})

test('finish:aborted 也判 error', async () => {
  const r = await choose({ llm: typed(['A'], { kind: 'aborted' }) as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { abstain: 'error' })
})

test('空候选表直接 no-label，不发起模型调用', async () => {
  let calls = 0
  const llm = {
    async *stream() {
      calls++
      yield { text: 'A' }
    },
  }
  const r = await choose({ llm: llm as any, ...ROUTE, candidates: [], receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { abstain: 'no-label' })
  assert.equal(calls, 0)
})

test('候选 id 为 ? 时，? 仍是 abstain', async () => {
  const r = await choose({ llm: llmOf(['?']) as any, ...ROUTE, candidates: [{ id: '?', summary: 'x' }], receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { abstain: 'no-label' })
})

test('每次调用都带 purpose，失败后的下一次仍然携带', async () => {
  const seen: any[] = []
  let calls = 0
  const llm = {
    async *stream(opts: any) {
      calls++
      seen.push(opts)
      if (calls === 1) {
        yield { type: 'finish', reason: { kind: 'error' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'A' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const failed = await choose({ llm: llm as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(failed, { abstain: 'error' })
  assert.equal(seen.length, 1)

  const next = await choose({ llm: llm as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(next, { choice: 'A' })
  assert.equal(seen.length, 2)
  assert.deepEqual(seen.map((opts) => opts.purpose), [SELECTOR_PURPOSE, SELECTOR_PURPOSE])
})

test('finish:error 后迭代器 close 抛错：保持 error 且不重试', async () => {
  let calls = 0
  const llm = {
    async *stream() {
      calls++
      try {
        yield { type: 'finish', reason: { kind: 'error' } }
      } finally {
        throw new Error('close boom')
      }
    },
  }
  const r = await choose({ llm: llm as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { abstain: 'error' })
  assert.equal(calls, 1)
})

test('已收到文本后抛错不重试，直接 error', async () => {
  let calls = 0
  const llm = {
    async *stream() {
      calls++
      yield { text: 'A' }
      throw new Error('late')
    },
  }
  const r = await choose({ llm: llm as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { abstain: 'error' })
  assert.equal(calls, 1)
})

test('reasoningEffort 缺省时省略，提供时透传', async () => {
  const seen: any[] = []
  const llm = {
    async *stream(opts: any) {
      seen.push(opts)
      yield { text: 'A' }
    },
  }
  await choose({ llm: llm as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.equal('reasoningEffort' in seen[0], false)
  await choose({ llm: llm as any, ...ROUTE, reasoningEffort: 'high', candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.equal(seen[1].reasoningEffort, 'high')
})

test('请求携带候选、回执与关闭式系统提示', async () => {
  let seen: any
  const llm = { async *stream(opts: any) { seen = opts; yield { text: 'A' } } }
  await choose({ llm: llm as any, ...ROUTE, candidates: cands, receiptText: 'receipt-body', maxTokens: 512 })
  const text = seen.messages[0].content.map((block: any) => block.text).join('')
  assert.match(text, /A: read \/a/)
  assert.match(text, /B: read \/b/)
  assert.match(text, /receipt-body/)
  assert.equal(seen.messages[0].role, 'user')
  assert.equal(typeof seen.system, 'string')
  assert.match(seen.system, /\?/)
})

test('选择完成后清除超时计时器', async () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const pending = new Set<ReturnType<typeof setTimeout>>()
  let created = 0
  globalThis.setTimeout = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    const handle = realSetTimeout(fn, ms, ...args)
    if (ms === 60_000) { created++; pending.add(handle) }
    return handle
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle !== undefined) pending.delete(handle)
    return realClearTimeout(handle)
  }) as typeof clearTimeout
  try {
    const r = await choose({ llm: llmOf(['A']) as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512, timeoutMs: 60_000 })
    assert.deepEqual(r, { choice: 'A' })
    assert.equal(created, 1)
    assert.equal(pending.size, 0)
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

test('timeoutMs 为 0 时立即超时，不发起模型调用', async () => {
  let calls = 0
  const llm = {
    async *stream() {
      calls++
      yield { text: 'A' }
    },
  }
  const r = await choose({ llm: llm as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512, timeoutMs: 0 })
  assert.deepEqual(r, { abstain: 'timeout' })
  assert.equal(calls, 0)
})

test('timeoutMs 为负数时立即超时，不发起模型调用', async () => {
  let calls = 0
  const llm = {
    async *stream() {
      calls++
      yield { text: 'A' }
    },
  }
  const r = await choose({ llm: llm as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512, timeoutMs: -1 })
  assert.deepEqual(r, { abstain: 'timeout' })
  assert.equal(calls, 0)
})

test('超长 timeoutMs 被钳到 Node 计时器上限', async () => {
  const realSetTimeout = globalThis.setTimeout
  const delays: number[] = []
  globalThis.setTimeout = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    delays.push(ms as number)
    return realSetTimeout(fn, 0, ...args)
  }) as typeof setTimeout
  try {
    const r = await choose({ llm: llmOf(['A']) as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512, timeoutMs: 3_000_000_000 })
    assert.deepEqual(r, { choice: 'A' })
    assert.ok(delays.includes(2_147_483_647), `setTimeout saw ${JSON.stringify(delays)}`)
    assert.equal(delays.filter((ms) => ms > 2_147_483_647).length, 0)
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

test('完成与被放弃的尝试都不留下 unhandled rejection', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const done = await choose({ llm: llmOf(['A']) as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512 })
    assert.deepEqual(done, { choice: 'A' })

    const late = {
      async *stream() {
        await new Promise((resolve) => setTimeout(resolve, 20))
        throw new Error('late-boom')
      },
    }
    const timed = await choose({ llm: late as any, ...ROUTE, candidates: cands, receiptText: 'x', maxTokens: 512, timeoutMs: 5 })
    assert.deepEqual(timed, { abstain: 'timeout' })

    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})
