/**
 * Task 23c-1: the `llm/stream` hook body.
 *
 * Every group pins one of the obligations the dispatch assigns to this task:
 * per-session clock/budget (1), no budget take here (2), `peek` not `take`
 * (3), turn validity (4), settle-and-discard (5), prune/compaction detection
 * (6), the selector exclusion (7), session-end cleanup (10) and settlement
 * receipts (11).
 *
 * The assembly is the real `registerHooks` over the fake host; only the host is
 * faked. The stream driver merges the session id into the request exactly like
 * the real loop, and the upstream chunk list is mutable so one test can drive a
 * synthesized turn followed by a real one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { AnchorStore, PRUNE_MARKER } from '../src/gate/invalidate.ts'
import { clearSession, SessionRuntime, streamHook } from '../src/hooks/llm-stream.ts'
import { PendingQueue } from '../src/hooks/pending.ts'
import { registerHooks, streamHook as reexportedStreamHook } from '../src/hooks/post-execute.ts'
import { ReceiptSessionState } from '../src/hooks/session-state.ts'
import { SELECTOR_PURPOSE } from '../src/selector/jev.ts'
import { DEFAULT_SCOPE } from '../src/scope/doc.ts'
import { fakeHost } from './fakes/host.ts'

const SESSION = 's1'
const OTHER = 's2'
const WORKSPACE = 'w1'
const agent = { session: { header: { id: SESSION, cwd: '/w' } } }

const doc = (over: Record<string, unknown> = {}) => ({
  ...DEFAULT_SCOPE,
  mode: 'global',
  shadow: false,
  projection: 'off',
  ...over,
})

type Any = any

/** Drain a stream; every test reads the chunks it asserts on. */
async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/**
 * Drive one model request and drain it.
 *
 * `host.nextCalls` is cumulative for the whole fake, and a test that first
 * commits through `tools/post-execute` has already passed that waterfall once;
 * resetting here makes the assertion about *this* request.
 */
async function streamOnce(
  env: ReturnType<typeof setup>,
  options: Any = {},
): Promise<StreamChunk[]> {
  env.host.nextCalls = 0
  return collect(env.host.stream(SESSION, options))
}

/** A canned upstream list, re-iterable per call. */
function streamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

/** One real `registerHooks` assembly with a per-session runtime. */
function setup(
  over: {
    doc?: Record<string, unknown>
    deps?: Record<string, unknown>
    chunks?: StreamChunk[]
    stepsPerTurn?: number
  } = {},
) {
  const runtime = new SessionRuntime(over.stepsPerTurn ?? DEFAULT_CONFIG.stepsPerTurn)
  const state = { chunks: [...(over.chunks ?? [])] as StreamChunk[], upstreamCalls: 0 }
  const host = fakeHost({
    llm: {
      stream() {
        state.upstreamCalls += 1
        return streamOf(state.chunks)
      },
    },
  })
  const receipts: Any[] = []
  const queue = new PendingQueue()
  const anchors = new AnchorStore()
  const plans = new Map<string, Any>()
  const sessionState = new ReceiptSessionState()
  const deps: Any = {
    config: DEFAULT_CONFIG,
    scope: { judgement: () => true, read: async () => ({ doc: over.doc ?? doc() }) },
    receipts: {
      append: async (r: Any) => {
        receipts.push(r)
      },
      stopped: () => false,
    },
    anchors,
    resolveSession: () => WORKSPACE,
    queue,
    plans,
    sessionState,
    sessions: runtime,
    // Substitution requires a token meter now (design §9); the stream tests
    // exercise the settlement path, which needs a real enqueue.
    estimateText: (text: string) => Math.ceil(text.length / 4),
    ...over.deps,
  }
  registerHooks(host, deps)
  return {
    host,
    runtime,
    receipts,
    queue,
    anchors,
    plans,
    sessionState,
    deps,
    upstreamCalls: () => state.upstreamCalls,
    setChunks(chunks: StreamChunk[]) {
      state.chunks = [...chunks]
    },
  }
}

/** One post-execute pass with the real nested agent shape. */
function runPost(
  env: ReturnType<typeof setup>,
  text: string,
  decision: Any = { kind: 'accept' },
  execOver: Record<string, unknown> = {},
): Promise<Any> {
  return env.host.callHook(
    'tools/post-execute',
    [
      { name: 'read', callId: 'root-call', agent, ...execOver },
      { content: [{ type: 'text', text }] },
    ],
    async () => decision,
  )
}

/** The one read-only candidate every end-to-end test commits. */
const candidate = (id = 'A', needle = 'TRIGGER') => ({
  id,
  tool: 'read',
  args: { file_path: '/x' },
  guards: [{ text_contains: needle }],
})

/** Seed the session queue directly (used where the decision path is not the subject). */
function seedPending(
  env: ReturnType<typeof setup>,
  over: Record<string, unknown> = {},
): Any {
  const entry = {
    callId: 'seeded-call',
    candidateId: 'A',
    name: 'read',
    args: { file_path: '/x' },
    turn: 1,
    step: 0,
    ...over,
  }
  env.queue.set(SESSION, entry)
  return entry
}

/** A tool-role request message carrying exactly `text`. */
const messagesWith = (text: string) => [{ role: 'tool', content: [{ type: 'text', text }] }]

/**
 * The body apply-mode projection composes: head line, head, footer, tail.
 *
 * The head line is the projection's own identity (`[output N chars; showing
 * first H and last T]`), and a real projected receipt always carries it. A body
 * that merely shares the head and tail of the anchor, with no rewrite evidence,
 * is a different receipt.
 */
function projectedBody(
  anchor: string,
  headChars: number,
  tailChars: number,
  footer = '(Omitted 99 bytes.)',
): string {
  const points = Array.from(anchor)
  const header = `[output ${points.length.toLocaleString('en-US')} chars; showing first ${headChars.toLocaleString('en-US')} and last ${tailChars.toLocaleString('en-US')}]`
  return `${header}\n${points.slice(0, headChars).join('')}\n${footer}\n${points.slice(-tailChars).join('')}`
}

// ---------------------------------------------------------------------------
// The sync contract: an async function makes the host for-await a Promise
// ---------------------------------------------------------------------------

test('streamHook 同步返回 AsyncIterable，且 post-execute 重新导出同一个函数', () => {
  const env = setup()
  const out = streamHook(env.deps)({ messages: [], sessionId: SESSION } as Any, () =>
    streamOf([]),
  )
  assert.equal(reexportedStreamHook, streamHook, 'the stub was replaced, not duplicated')
  assert.equal(typeof (out as Any).then, 'undefined', 'must not be a Promise')
  assert.equal(typeof (out as Any)[Symbol.asyncIterator], 'function')
})

// ---------------------------------------------------------------------------
// Obligation 7 + the plan's selector test
// ---------------------------------------------------------------------------

test('O7 selector 自身调用放行：不进 usage.request、不合成、不结算标记', async () => {
  const usage = { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 }
  const env = setup({ chunks: [{ type: 'usage', usage }, { type: 'finish', reason: { kind: 'stop' } }] })
  env.runtime.onModelRequest(SESSION, 1, 0)
  const entry = seedPending(env)
  const ledger = env.runtime.usageFor(SESSION)
  ledger.markSubstituted('A')

  const chunks = await streamOnce(env, { purpose: SELECTOR_PURPOSE, messages: [] })

  assert.deepEqual(chunks, [{ type: 'usage', usage }, { type: 'finish', reason: { kind: 'stop' } }])
  assert.equal(env.host.nextCalls, 1, 'the selector must be delegated to next()')
  assert.equal(env.upstreamCalls(), 1)
  assert.equal(ledger.last(), undefined, 'the selector request is not a pairing sample')
  assert.equal(ledger.pendingCandidateId(), 'A', 'the selector must not settle the mark either')
  assert.equal(env.queue.peek(SESSION), entry, 'a selector call is never substituted')
  assert.equal(
    env.receipts.some((r) => r.kind === 'substitute' || r.kind === 'substitute-settled'),
    false,
  )
})

// ---------------------------------------------------------------------------
// C1: every purpose-tagged call is auxiliary, not only the selector's
// ---------------------------------------------------------------------------

test('C1 purpose=compaction 一律透传：不合成、不观测 usage、不结算标记、队列与锚点不动', async () => {
  const usage = { inputTokens: 4000, cacheReadTokens: 0, outputTokens: 300 }
  const env = setup({
    chunks: [{ type: 'usage', usage }, { type: 'finish', reason: { kind: 'stop' } }],
  })
  env.runtime.onModelRequest(SESSION, 1, 0)
  const entry = seedPending(env)
  const anchors = { stepId: 'root', anchors: { root: 'ANCHORED-TEXT' } }
  env.anchors.set(SESSION, anchors)
  const ledger = env.runtime.usageFor(SESSION)
  ledger.markSubstituted('A')

  const chunks = await streamOnce(env, {
    purpose: 'compaction',
    messages: messagesWith('the shadowed span'),
  })

  assert.deepEqual(chunks, [{ type: 'usage', usage }, { type: 'finish', reason: { kind: 'stop' } }])
  assert.equal(env.host.nextCalls, 1)
  assert.equal(env.upstreamCalls(), 1)
  assert.equal(env.queue.peek(SESSION), entry, 'an auxiliary call never consumes the decision')
  assert.deepEqual(env.anchors.get(SESSION), anchors, 'an auxiliary call never invalidates evidence')
  assert.equal(ledger.last(), undefined, 'the summarizer request is not a pairing sample')
  assert.equal(ledger.pendingCandidateId(), 'A', 'the mark belongs to the next real request, not this one')
  assert.equal(env.receipts.length, 0, 'nothing is substituted, reset or settled')
})

test("C1 purpose='session-title' 同样透传：合成后再出现的辅助调用不结算也未观测", async () => {
  const usage = { inputTokens: 4000, cacheReadTokens: 0, outputTokens: 300 }
  const env = setup({
    chunks: [{ type: 'usage', usage }, { type: 'finish', reason: { kind: 'stop' } }],
  })
  env.runtime.onModelRequest(SESSION, 1, 0)
  // The post-synthesis window: the entry is gone, only the usage mark remains.
  const ledger = env.runtime.usageFor(SESSION)
  ledger.markSubstituted('A')

  const chunks = await streamOnce(env, { purpose: 'session-title', messages: [] })

  assert.equal(env.host.nextCalls, 1)
  assert.equal(env.upstreamCalls(), 1)
  assert.equal(env.queue.peek(SESSION), undefined)
  assert.equal(ledger.last(), undefined, 'the title request must not become the after-mark sample')
  assert.equal(ledger.pendingCandidateId(), 'A', 'the next real request still owns the settlement')
  assert.equal(env.receipts.length, 0)
  assert.deepEqual(chunks, [{ type: 'usage', usage }, { type: 'finish', reason: { kind: 'stop' } }])
})

test('P0 收据停写直通也结算决策期标记：之后的真实请求不写 substitute-settled', async () => {
  const env = setup({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  env.runtime.onModelRequest(SESSION, 1, 0)
  // The mark is written at decision time; no queue entry is left (the dispatch
  // already consumed it), and the store now reports that it stopped. A
  // pass-through that returns without an abandon used to keep the mark alive.
  const ledger = env.runtime.usageFor(SESSION)
  ledger.markSubstituted('A')
  const append = env.deps.receipts.append
  env.deps.receipts = { append, stopped: () => true }

  await streamOnce(env)
  assert.equal(env.host.nextCalls, 1, 'a stopped store passes through to the real model')
  assert.equal(ledger.pendingCandidateId(), undefined, 'the pass-through must discard the mark')

  // A later healthy request must not turn the decision-time mark into a saving.
  env.deps.receipts = { append, stopped: () => false }
  await streamOnce(env, {
    messages: [
      {
        role: 'tool',
        content: [{ type: 'text', text: 'some unrelated tool result' }],
      },
    ],
  })
  assert.equal(
    env.receipts.some((r) => r.kind === 'substitute-settled'),
    false,
    'the decision was never synthesized, so no settlement exists',
  )
})

test('P3 resolveStreamPlan 抛错走同一透传路径：丢弃标记、观测 usage、不写幽灵 settle', async () => {
  const usage = { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 }
  const env = setup({
    chunks: [{ type: 'usage', usage }, { type: 'finish', reason: { kind: 'stop' } }],
  })
  env.runtime.onModelRequest(SESSION, 1, 0)
  seedPending(env)
  const ledger = env.runtime.usageFor(SESSION)
  ledger.markSubstituted('A')
  // A throwing getter is not one of the store calls the defensive readers wrap,
  // so it escapes `resolveStreamPlan` and reaches the hook's catch. The catch
  // must not hand the raw upstream back: the decision-time mark would then be
  // settled by this unrelated real request.
  env.anchors.set(SESSION, {
    stepId: 'root',
    get anchors(): Record<string, string> {
      throw new Error('anchor store boom')
    },
  } as Any)

  const chunks = await streamOnce(env, { messages: messagesWith('anything') })

  assert.equal(env.host.nextCalls, 1, 'a decision bug must not take the request down')
  assert.deepEqual(chunks, [
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(ledger.pendingCandidateId(), undefined, 'the mark is discarded, not left for a later request')
  assert.deepEqual(ledger.last(), { input: 100, cacheRead: 900, output: 10 }, 'the pass path still observes usage')
  assert.equal(
    env.receipts.some((r) => r.kind === 'substitute-settled'),
    false,
    'a decision that never synthesized cannot report a saving',
  )
})

// ---------------------------------------------------------------------------
// Rows 71-72: anchor detection mutation survivors
// ---------------------------------------------------------------------------

test('row 71 锚点自身含 pruner marker：直接判 pruned-reset（marker 扫描捷径）', async () => {
  const env = setup()
  env.runtime.onModelRequest(SESSION, 1, 0)
  seedPending(env)
  // An anchored receipt whose own text already contains the pruner literal: the
  // short-circuit must classify it as pruned even when no message carries it.
  env.anchors.set(SESSION, { stepId: 'root', anchors: { root: `head${PRUNE_MARKER}tail` } })

  await streamOnce(env, { messages: messagesWith('a body that carries no anchor at all') })

  const reset = env.receipts.find((r) => r.kind === 'reset')
  assert.equal(reset?.code, 'pruned-reset')
  assert.equal(env.queue.peek(SESSION), undefined, 'a reset abandons the decision')
})

test('row 72 tail 必须出现在 head 之后：tail 在前不算承载', async () => {
  const env = setup()
  env.runtime.onModelRequest(SESSION, 1, 0)
  seedPending(env)
  // The probe windows default to 32 code points; the anchor is long enough for
  // both probes to be proper windows.
  const head = 'h'.repeat(32)
  const tail = 't'.repeat(32)
  const anchor = `${head}${'m'.repeat(20)}${tail}`
  env.anchors.set(SESSION, { stepId: 'root', anchors: { root: anchor } })

  // Both probes are present, but the tail precedes the head.
  const body = `${tail} middle ${head}`
  const chunks = await streamOnce(env, { messages: messagesWith(body) })

  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false, 'not synthesized')
  const reset = env.receipts.find((r) => r.kind === 'reset')
  assert.equal(reset?.code, 'compaction-reset', 'the ordered probe must not accept a tail-first body')
})

test('P2 头尾相同、中段不同的完整回执不是锚点：探针碰撞必须 fail closed', async () => {
  const env = setup({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  const anchor = `${'H'.repeat(120)}${'M'.repeat(60)}${'T'.repeat(120)}`
  seedAnchored(env, anchor)
  // The same file edited in the middle and re-read: the new receipt shares the
  // 32-character head and tail, but its body is not the anchored one and is not
  // an in-place rewrite either. Accepting the probes would substitute against
  // content the model no longer holds.
  const edited = `${'H'.repeat(120)}${'X'.repeat(60)}${'T'.repeat(120)}`

  const chunks = await streamOnce(env, { messages: messagesWith(edited) })

  assert.equal(env.host.nextCalls, 1, 'a changed body must not be synthesized over')
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  const reset = env.receipts.find((r) => r.kind === 'reset')
  assert.equal(reset?.code, 'compaction-reset', 'an unverifiable head/tail match is a lost anchor')
  assert.equal(env.queue.peek(SESSION), undefined)
})

test('P2 锚点形状无法校验（旧/外来值）：不崩溃且 fail closed', async () => {
  const env = setup({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  env.runtime.onModelRequest(SESSION, 1, 0)
  seedPending(env)
  // A value the stronger rule cannot verify: an object, not the canonical text.
  // It must not be treated as "no anchors" (which would vacuously pass) and it
  // must not throw out of the model request.
  env.anchors.set(SESSION, {
    stepId: 'root',
    anchors: { root: { text: 'old-shape' } },
  } as Any)

  const chunks = await streamOnce(env, { messages: messagesWith('old-shape') })

  assert.equal(env.host.nextCalls, 1)
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  const reset = env.receipts.find((r) => r.kind === 'reset')
  assert.equal(reset?.code, 'compaction-reset', 'an unverifiable anchor is not a match')
})

// ---------------------------------------------------------------------------
// The plan's pass-through tests
// ---------------------------------------------------------------------------

test('无 pending 时透传 next()，text-delta 拼成文本后 parsePlan 存入 plans', async () => {
  const text =
    'intro <CHISEL_PLAN>{"goal":"g","steps":[{"id":"A","tool":"read",' +
    '"args":{"file_path":"/x"},"guards":[{"ok":true}]}]}</CHISEL_PLAN> tail'
  const first = text.slice(0, 20)
  const second = text.slice(20)
  const env = setup({
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: first },
      { type: 'text-delta', index: 0, text: second },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  env.runtime.onModelRequest(SESSION, 1, 0)

  const chunks = await streamOnce(env)
  assert.equal(chunks.length, 4)
  assert.equal(env.host.nextCalls, 1)
  assert.equal(env.upstreamCalls(), 1)
  assert.equal(env.plans.get(SESSION)?.goal, 'g')
  assert.equal(env.plans.get(SESSION)?.steps[0].id, 'A')
})

test('scope 不可见放行 + 清该 session 队列，post-execute 侧记 skip:no-scope', async () => {
  const env = setup({ deps: { resolveSession: () => undefined } })
  env.runtime.onModelRequest(SESSION, 1, 0)
  env.plans.set(SESSION, { goal: 'g', steps: [candidate()] })
  await runPost(env, 'TRIGGER here')
  assert.ok(
    env.receipts.some((r) => r.code === 'skip:no-scope'),
    'the decision path is the one that records skip:no-scope',
  )

  seedPending(env)
  const chunks = await streamOnce(env)
  assert.equal(env.host.nextCalls, 1)
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  assert.equal(env.queue.peek(SESSION), undefined, 'the invisible session queue is cleared')
})

test('收据停写 fail-closed：放行、不合成、不吃预算、放弃的标记被结算', async () => {
  const env = setup({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  // Keep the recording append, then make the store report that it stopped:
  // a settlement receipt must not be masked by the store also swallowing it.
  const append = env.deps.receipts.append
  env.deps.receipts = { append, stopped: () => true }
  env.runtime.onModelRequest(SESSION, 1, 0)
  seedPending(env)
  const ledger = env.runtime.usageFor(SESSION)
  ledger.markSubstituted('A')
  const budget = env.runtime.budgetFor(SESSION)
  const before = budget.count()

  const chunks = await streamOnce(env)

  assert.equal(env.host.nextCalls, 1)
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  assert.equal(budget.count(), before, 'llm/stream must not take a step')
  assert.equal(ledger.pendingCandidateId(), undefined, 'a failed substitution is not left marked')
  assert.equal(
    env.receipts.some((r) => r.kind === 'substitute-settled'),
    false,
    'abandonment must not report a saving (the end-of-request fallback must not mask it)',
  )
})

test('预算耗尽回主模型：nextCalls === 1 且流里没有 tool-call-delta', async () => {
  const env = setup({ stepsPerTurn: 1 })
  env.runtime.onModelRequest(SESSION, 1, 0)
  assert.equal(env.runtime.budgetFor(SESSION).take(), true)
  env.plans.set(SESSION, { goal: 'g', steps: [candidate()] })
  await runPost(env, 'TRIGGER here')
  assert.equal(env.queue.peek(SESSION), undefined, 'post-execute refused to enqueue')
  assert.ok(env.receipts.some((r) => r.code === 'steps-exhausted'))

  const chunks = await streamOnce(env)
  assert.equal(env.host.nextCalls, 1)
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
})

test('P2 同一步不得合成两次：丢弃仍存活的条目、只写一条 substitute、不写幽灵 settle', async () => {
  const env = setup({ stepsPerTurn: 1, chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  env.runtime.onModelRequest(SESSION, 1, 0)
  const entry = await commit(env)
  const budget = env.runtime.budgetFor(SESSION)
  const ledger = env.runtime.usageFor(SESSION)

  // First request: the one budgeted step is spent and the turn is synthesized.
  const first = await streamOnce(env, { messages: messagesWith('TRIGGER here') })
  assert.equal(first.filter((c) => c.type === 'tool-call-delta').length, 1)
  assert.equal(env.receipts.filter((r) => r.kind === 'substitute').length, 1)
  assert.equal(ledger.pendingCandidateId(), 'A')

  // The next post-execute in the same turn cannot take a step: the decision it
  // would have made is refused, but the first entry is still live because the
  // synthesized call has not been dispatched yet.
  env.plans.set(SESSION, { goal: 'g', steps: [candidate()] })
  await runPost(env, 'TRIGGER here')
  assert.ok(env.receipts.some((r) => r.code === 'steps-exhausted'))
  assert.equal(env.queue.peek(SESSION)?.callId, entry.callId, 'the refused decision did not replace the entry')

  // A second request must not synthesize the same step again: that would write
  // a duplicate callId and spend a step the budget never granted.
  const second = await streamOnce(env, { messages: messagesWith('TRIGGER here') })
  assert.equal(env.host.nextCalls, 1, 'the model must answer instead of a duplicate synthesis')
  assert.equal(second.some((c) => c.type === 'tool-call-delta'), false)
  assert.equal(env.queue.peek(SESSION), undefined, 'the unhonourable entry is dropped')
  assert.equal(budget.count(), 1, 'no second step was taken')
  assert.equal(ledger.pendingCandidateId(), undefined, 'the dropped entry settles its mark as discarded')

  const substitutes = env.receipts.filter((r) => r.kind === 'substitute')
  assert.equal(substitutes.length, 1, 'the same step must never produce two substitute receipts')
  assert.equal(substitutes[0]?.callId, entry.callId)

  // The real request that follows must not report a saving for a substitution
  // that never ran twice.
  env.runtime.onModelRequest(SESSION, 2, 0)
  env.setChunks([
    { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  await streamOnce(env)
  assert.equal(
    env.receipts.some((r) => r.kind === 'substitute-settled'),
    false,
    'a dropped entry must not settle a phantom saving',
  )
})

test('P2 预算已耗尽时即使 callId 不同也不再合成：合成数不得超过已付步数', async () => {
  const env = setup({ stepsPerTurn: 1, chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  env.runtime.onModelRequest(SESSION, 1, 0)
  await commit(env)
  await streamOnce(env, { messages: messagesWith('TRIGGER here') })
  // A different decision parked in the same turn without a paid step: the
  // budget half alone must refuse it, independently of the call-id half.
  seedPending(env, { callId: 'unpaid-call', turn: 1 })

  const chunks = await streamOnce(env, { messages: messagesWith('TRIGGER here') })

  assert.equal(env.host.nextCalls, 1)
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  assert.equal(env.queue.peek(SESSION), undefined, 'the unpayable entry is dropped')
  assert.equal(
    env.receipts.filter((r) => r.kind === 'substitute').length,
    1,
    'the only substitute receipt is the one the budget paid for',
  )
})

// ---------------------------------------------------------------------------
// Obligation 2: the stream hook never charges the turn budget
// ---------------------------------------------------------------------------

test('O2 合成不取预算：一次替换只扣 post-execute 的 1 格（删掉此断言会被二次扣费）', async () => {
  const env = setup()
  env.runtime.onModelRequest(SESSION, 1, 0)
  const entry = await commit(env)
  const budget = env.runtime.budgetFor(SESSION)
  assert.equal(budget.count(), 1, 'the decision path took its one step')

  const chunks = await streamOnce(env, { messages: messagesWith('TRIGGER here') })
  assert.ok(chunks.some((c) => c.type === 'tool-call-delta'))
  assert.equal(budget.count(), 1, 'llm/stream must not take a second step')
  assert.equal(entry.callId, env.queue.peek(SESSION)?.callId)
})

// ---------------------------------------------------------------------------
// The plan's synthesis test + obligation 3 (peek, never take)
// ---------------------------------------------------------------------------

/** Commit A through the real decision path and return the queued entry. */
async function commit(env: ReturnType<typeof setup>, text = 'TRIGGER here'): Promise<Any> {
  env.plans.set(SESSION, { goal: 'g', steps: [candidate()] })
  await runPost(env, text)
  const entry = env.queue.peek(SESSION)
  assert.ok(entry, 'the decision path must enqueue for this fixture to mean anything')
  return entry
}

test('有 pending 时合成：nextCalls === 0、流里有 tool-call-delta、收据 kind substitute', async () => {
  const env = setup()
  env.runtime.onModelRequest(SESSION, 1, 0)
  const entry = await commit(env)

  const chunks = await streamOnce(env, { messages: messagesWith('TRIGGER here') })

  assert.equal(env.host.nextCalls, 0, 'the real model must not be called')
  assert.equal(env.upstreamCalls(), 0)
  const delta = chunks.find((c) => c.type === 'tool-call-delta') as Any
  assert.ok(delta, 'the synthesized turn asks for the decided call')
  assert.equal(delta.id, entry.callId)
  assert.equal(delta.name, 'read')
  assert.equal(delta.argumentsDelta, JSON.stringify(entry.args))

  const substitute = env.receipts.find((r) => r.kind === 'substitute')
  assert.ok(substitute)
  assert.equal(substitute.code, 'substituted')
  assert.equal(substitute.sessionId, SESSION)
  assert.equal(substitute.turn, 1)
  assert.equal(substitute.stepId, 'root')
  assert.equal(substitute.tool, 'read')
  assert.equal(substitute.callId, entry.callId)
  assert.equal(substitute.candidateId, 'A')
  assert.equal(substitute.saved_input_tokens, 'unknown')
  assert.equal(substitute.output_tokens, 'unknown')
  assert.deepEqual(substitute.args, entry.args, 'the synthesized call args are the evidence')
  assert.match(substitute.preview, /read/, 'preview names the call that ran')
  assert.match(substitute.preview, /\/x/, 'preview carries the bound arguments')
})

test('P3 entry 在生成器启动前消失：上游在瀑布点同步解析，回退观测同一请求', async () => {
  const env = setup()
  seedAnchored(env)
  let generation = 0
  const stream = streamHook(env.deps)(
    { sessionId: SESSION, messages: messagesWith(LONG_ANCHOR) } as Any,
    () => {
      const seen = generation
      return streamOf([{ type: 'text-delta', index: 0, text: `gen${seen}` }])
    },
  )
  // The host advances past the waterfall point before the generator is pulled,
  // and the entry vanishes in between. The fallback must use the upstream
  // resolved at the waterfall point, not one resolved lazily inside the
  // generator body.
  generation = 1
  env.queue.clear(SESSION)

  const chunks = await collect(stream)

  assert.deepEqual(chunks, [{ type: 'text-delta', index: 0, text: 'gen0' }])
})

test('O3 合成用 peek 不 take：条目活到 execute，篡改的派发仍被拒绝', async () => {
  const env = setup()
  env.runtime.onModelRequest(SESSION, 1, 0)
  const entry = await commit(env)
  await streamOnce(env, { messages: messagesWith('TRIGGER here') })

  assert.equal(env.queue.peek(SESSION)?.callId, entry.callId, 'take() here would empty the queue')

  const rejected = await env.host.callHook(
    'tools/execute',
    [
      {
        name: 'read',
        callId: entry.callId,
        arguments: { file_path: '/tampered' },
        agent,
      },
    ],
    async () => 'DISPATCHED',
  )
  assert.equal(rejected.isError, true)
  assert.equal(rejected.error.info.code, 'dispatch-rejected')
  assert.equal(env.queue.peek(SESSION), undefined, 'execute clears on the reject path')
})

// ---------------------------------------------------------------------------
// The plan's usage mapping test
// ---------------------------------------------------------------------------

test('usage 映射：inputTokens=100 / cacheReadTokens=900 → ledger.last() 的 input/cacheRead', async () => {
  const env = setup({
    chunks: [
      { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  env.runtime.onModelRequest(SESSION, 1, 0)

  await streamOnce(env)

  assert.deepEqual(env.runtime.usageFor(SESSION).last(), { input: 100, cacheRead: 900, output: 10 })
})

// ---------------------------------------------------------------------------
// The plan's cross-turn settlement test (obligation 11)
// ---------------------------------------------------------------------------

test('跨回合结算：合成后的下一次真实请求写 substitute-settled 收据', async () => {
  const env = setup()
  env.runtime.onModelRequest(SESSION, 1, 0)
  const entry = await commit(env)
  await streamOnce(env, { messages: messagesWith('TRIGGER here') })

  // The synthesized call is dispatched and accepted, so the entry is gone
  // before the next request and only the usage mark remains.
  const dispatched = await env.host.callHook(
    'tools/execute',
    [{ name: 'read', callId: entry.callId, arguments: entry.args, agent }],
    async () => 'DISPATCHED',
  )
  assert.equal(dispatched, 'DISPATCHED')
  assert.equal(env.queue.peek(SESSION), undefined)

  env.runtime.onModelRequest(SESSION, 2, 0)
  env.setChunks([
    { type: 'usage', usage: { inputTokens: 50, cacheReadTokens: 950, outputTokens: 7 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  await streamOnce(env)

  const settled = env.receipts.find((r) => r.kind === 'substitute-settled')
  assert.ok(settled, 'the next real request settles the substitution')
  assert.equal(settled.code, 'substitute-settled')
  assert.equal(settled.candidateId, 'A')
  assert.equal(settled.turn, 2)
  assert.equal(settled.saved_input_tokens, 1000, 'input + cacheRead of the first after-mark request')
  assert.equal(settled.output_tokens, 7)
  assert.equal(env.runtime.usageFor(SESSION).pendingCandidateId(), undefined)
})

test('O11 兜底结算：本请求没有 usage 块时，真实请求结束仍写 unknown 结算并消费标记', async () => {
  const env = setup({
    chunks: [
      { type: 'text-delta', index: 0, text: 'plain answer' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  env.runtime.onModelRequest(SESSION, 1, 0)
  const ledger = env.runtime.usageFor(SESSION)
  ledger.markSubstituted('A')

  await streamOnce(env)

  const settled = env.receipts.filter((r) => r.kind === 'substitute-settled')
  assert.equal(settled.length, 1, 'the request ends even when no usage chunk arrived')
  assert.equal(settled[0].candidateId, 'A')
  assert.equal(settled[0].saved_input_tokens, 'unknown')
  assert.equal(settled[0].output_tokens, 'unknown')
  assert.equal(ledger.pendingCandidateId(), undefined, 'the mark is consumed at request end')
})

// ---------------------------------------------------------------------------
// Obligation 1: clock and budget are per session
// ---------------------------------------------------------------------------

test('O1 SessionRuntime 按 session 存 clock/budget/usage：换回合只重置本会话预算', () => {
  const runtime = new SessionRuntime(2)
  runtime.onModelRequest(SESSION, 1, 0)
  runtime.onModelRequest(OTHER, 9, 4)
  assert.equal(runtime.clockFor(SESSION).turn(), 1)
  assert.equal(runtime.clockFor(SESSION).step(), 0)
  assert.equal(runtime.clockFor(OTHER).turn(), 9)
  assert.equal(runtime.clockFor(OTHER).step(), 4)

  assert.equal(runtime.budgetFor(SESSION).take(), true)
  assert.equal(runtime.budgetFor(SESSION).take(), true)
  assert.equal(runtime.budgetFor(SESSION).exhausted(), true)
  assert.equal(runtime.budgetFor(OTHER).take(), true, 'one session cannot starve another')

  runtime.onModelRequest(SESSION, 2, 0)
  assert.equal(runtime.budgetFor(SESSION).count(), 0, 'a new turn resets that session only')
  assert.equal(runtime.budgetFor(OTHER).count(), 1)

  assert.notEqual(runtime.clockFor(SESSION), runtime.clockFor(OTHER))
  assert.notEqual(runtime.usageFor(SESSION), runtime.usageFor(OTHER))
  assert.equal(runtime.size(), 2)
})

test('O1 llm/stream 读本会话的 clock：另一会话的 turn/step 不会让本会话的 pending 失效', async () => {
  const env = setup()
  env.runtime.onModelRequest(SESSION, 1, 0)
  // A decoy shared clock advanced by the other session: a hook that reached
  // for deps.clock instead of the per-session runtime would see turn 9 here.
  const otherClock = env.runtime.clockFor(OTHER)
  otherClock.onModelRequest(9, 4)
  env.deps.clock = otherClock
  seedPending(env, { turn: 1 })

  const chunks = await streamOnce(env)
  assert.equal(env.host.nextCalls, 0)
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), true)
  assert.equal(env.queue.peek(SESSION)?.callId, 'seeded-call')
})

// ---------------------------------------------------------------------------
// Obligation 4: the entry must belong to the current turn
// ---------------------------------------------------------------------------

test('O4 回合有效：上一回合的 pending 在换回合的第一次请求清掉并放行', async () => {
  const env = setup({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  env.runtime.onModelRequest(SESSION, 2, 0)
  seedPending(env, { turn: 1, callId: 'stale-call' })

  const chunks = await streamOnce(env)

  assert.equal(env.host.nextCalls, 1, 'a stale substitution must not answer the new turn')
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  assert.equal(env.queue.peek(SESSION), undefined)
})

test('O4 时钟未驱动（turn 0）不是回合：turn 0 的 pending 不会合成', async () => {
  const env = setup({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  // No onModelRequest: TurnClock.turn() is 0, which is not a host turn.
  seedPending(env, { turn: 0 })

  const chunks = await streamOnce(env)

  assert.equal(env.host.nextCalls, 1)
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  assert.equal(env.queue.peek(SESSION), undefined, 'an undecidable entry is cleared, not synthesized')
})

// ---------------------------------------------------------------------------
// Obligation 5: abandoning a marked entry settles the mark
// ---------------------------------------------------------------------------

test('O5 放弃 marked entry 时 settle-and-discard：后续真实请求不再结算不存在的替换', async () => {
  const env = setup({
    chunks: [
      { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  env.runtime.onModelRequest(SESSION, 2, 0)
  seedPending(env, { turn: 1 })
  const ledger = env.runtime.usageFor(SESSION)
  ledger.markSubstituted('A')

  await streamOnce(env)

  assert.equal(ledger.pendingCandidateId(), undefined, 'the mark is consumed at abandonment')
  assert.equal(
    env.receipts.some((r) => r.kind === 'substitute-settled'),
    false,
    'the request that never carried the substitution must not report a saving',
  )
})

// ---------------------------------------------------------------------------
// Obligation 6: prune / compaction detection against options.messages
// ---------------------------------------------------------------------------

const LONG_ANCHOR = `${'H'.repeat(120)}${'M'.repeat(60)}${'T'.repeat(120)}`

/** Seed a valid pending entry plus its anchors for the anchor tests. */
function seedAnchored(env: ReturnType<typeof setup>, anchor = LONG_ANCHOR): Any {
  env.runtime.onModelRequest(SESSION, 1, 0)
  const entry = seedPending(env)
  env.anchors.set(SESSION, { stepId: 'root', anchors: { root: anchor } })
  return entry
}

test('O6 锚点完好时合成（原文就在本请求的消息里）', async () => {
  const env = setup()
  seedAnchored(env)
  const chunks = await streamOnce(env, { messages: messagesWith(LONG_ANCHOR) })
  assert.equal(env.host.nextCalls, 0)
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), true)
  assert.equal(env.receipts.some((r) => r.kind === 'reset'), false)
})

test('O6 pruner 原位改写：承载消息含 PRUNE_MARKER → pruned-reset，清队列与锚点', async () => {
  const env = setup({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  seedAnchored(env)
  const pruned = `${LONG_ANCHOR.slice(0, 120)}${PRUNE_MARKER}${LONG_ANCHOR.slice(-120)}`

  const chunks = await streamOnce(env, { messages: messagesWith(pruned) })

  assert.equal(env.host.nextCalls, 1)
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  const reset = env.receipts.find((r) => r.kind === 'reset')
  assert.ok(reset)
  assert.equal(reset.code, 'pruned-reset')
  assert.equal(reset.stepId, 'root')
  assert.equal(env.queue.peek(SESSION), undefined)
  assert.equal(env.anchors.get(SESSION), undefined)
})

test('O6 compaction 删掉承载消息：锚点原文已不在 → compaction-reset', async () => {
  const env = setup({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  seedAnchored(env)

  const chunks = await streamOnce(env, {
    messages: messagesWith('an unrelated summary of older history'),
  })

  assert.equal(env.host.nextCalls, 1)
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), false)
  const reset = env.receipts.find((r) => r.kind === 'reset')
  assert.ok(reset)
  assert.equal(reset.code, 'compaction-reset')
  assert.equal(env.queue.peek(SESSION), undefined)
  assert.equal(env.anchors.get(SESSION), undefined)
})

test('O6 插件自己的投影（头行 + head + footer + tail）不得误判成 compaction', async () => {
  const env = setup()
  seedAnchored(env)
  // Apply-mode projection composes the head line, head, spill footer and tail;
  // no prune marker. The head line is what distinguishes our rewrite from a
  // different full receipt that happens to share the two windows.
  const projected = projectedBody(LONG_ANCHOR, 120, 120)

  const chunks = await streamOnce(env, { messages: messagesWith(projected) })
  assert.equal(env.host.nextCalls, 0)
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), true)
  assert.equal(env.receipts.some((r) => r.kind === 'reset'), false)
})

test('O6 窄投影窗口（headChars/tailChars=12）也认作投影，不误判 compaction', async () => {
  const narrow = {
    ...DEFAULT_CONFIG,
    projection: {
      ...DEFAULT_CONFIG.projection,
      read: { ...DEFAULT_CONFIG.projection.read, headChars: 12, tailChars: 12 },
    },
  }
  const env = setup({ deps: { config: narrow } })
  seedAnchored(env)
  const projected = projectedBody(LONG_ANCHOR, 12, 12)

  const chunks = await streamOnce(env, { messages: messagesWith(projected) })

  assert.equal(env.host.nextCalls, 0, 'a probe longer than the configured window would look like compaction')
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), true)
  assert.equal(env.receipts.some((r) => r.kind === 'reset'), false)
})

test('O6 代理对边界：投影头尾按码点切片，32 字符探测不切开 astral 字符', async () => {
  const anchor = `${'a'.repeat(31)}😀${'b'.repeat(40)}😀${'c'.repeat(31)}`
  const env = setup()
  seedAnchored(env, anchor)
  const projected = projectedBody(anchor, 32, 32, '(Omitted 40 bytes.)')

  const chunks = await streamOnce(env, { messages: messagesWith(projected) })

  assert.equal(env.host.nextCalls, 0)
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), true)
})

// ---------------------------------------------------------------------------
// Obligation 10: session-end cleanup is exposed, not leaked
// ---------------------------------------------------------------------------

test('O10 clearSession 清队列/锚点/计划/收据状态/会话预算，且不泄漏 map', () => {
  const env = setup()
  env.runtime.onModelRequest(SESSION, 1, 0)
  seedPending(env)
  env.anchors.set(SESSION, { stepId: 'root', anchors: { root: 't' } })
  env.plans.set(SESSION, { goal: 'g', steps: [] })
  env.sessionState.recordRoot(SESSION, 1, { text: 't', isError: false } as Any)
  env.runtime.budgetFor(SESSION).take()

  clearSession(env.deps, SESSION)

  assert.equal(env.queue.peek(SESSION), undefined)
  assert.equal(env.anchors.get(SESSION), undefined)
  assert.equal(env.plans.has(SESSION), false)
  assert.equal(env.sessionState.receiptsFor(SESSION, 1).size, 0)
  assert.equal(env.runtime.size(), 0)
  assert.equal(env.runtime.clockFor(SESSION).turn(), 0, 'a cleared session starts a fresh clock')
})

test('I1 registerHooks 自建的 sessionState 写回 deps：caller 省略时 clearSession 仍能清', async () => {
  const env = setup({ deps: { sessionState: undefined } })
  assert.ok(env.deps.sessionState, 'registerHooks publishes the instance it created')

  env.runtime.onModelRequest(SESSION, 3, 0)
  await runPost(env, 'TRIGGER here')
  assert.equal(
    env.deps.sessionState.receiptsFor(SESSION, 3).size,
    1,
    'the default state recorded the root receipt',
  )

  clearSession(env.deps, SESSION)
  assert.equal(
    env.deps.sessionState.receiptsFor(SESSION, 3).size,
    0,
    'the default state is reachable, so it is cleared instead of leaked',
  )
})

test('I2 换回合清计划：新回合第一次请求前丢弃上一回合的 plan', async () => {
  const planText = `<CHISEL_PLAN>${JSON.stringify({ goal: 'turn-1', steps: [candidate()] })}</CHISEL_PLAN>`
  const env = setup({
    chunks: [
      { type: 'text-delta', index: 0, text: planText },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  env.runtime.onModelRequest(SESSION, 1, 0)
  await streamOnce(env)
  assert.equal(env.plans.get(SESSION)?.goal, 'turn-1')

  env.setChunks([{ type: 'finish', reason: { kind: 'stop' } }])
  env.runtime.onModelRequest(SESSION, 2, 0)
  await streamOnce(env, { messages: [] })
  assert.equal(env.plans.has(SESSION), false, 'a new turn starts without the previous turn plan')
})

test('I3 无计划回应清空旧计划：模型省略块后旧计划不得再驱动替换', async () => {
  const env = setup({
    chunks: [
      { type: 'text-delta', index: 0, text: 'I am unsure; no plan this time.' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  env.runtime.onModelRequest(SESSION, 1, 0)
  // Establish the plan-turn note, then seed a plan the response will not renew.
  await streamOnce(env)
  env.plans.set(SESSION, { goal: 'old', steps: [candidate()] })

  await streamOnce(env)
  assert.equal(env.plans.has(SESSION), false, 'a plan-less response clears the stored plan')
})

test('I3 reset 清空计划：pruned 与 compaction 两个分支都不得留下旧计划', async () => {
  const cases = [
    ['pruned-reset', `${LONG_ANCHOR.slice(0, 120)}${PRUNE_MARKER}${LONG_ANCHOR.slice(-120)}`],
    ['compaction-reset', 'an unrelated summary of older history'],
  ] as const
  for (const [code, body] of cases) {
    const env = setup({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    env.runtime.onModelRequest(SESSION, 1, 0)
    await streamOnce(env)
    env.plans.set(SESSION, { goal: 'old', steps: [candidate()] })
    seedAnchored(env)

    // Cancel after one chunk: `applyAbandon` must clear the plan on its own,
    // without the normal end-of-response `rememberPlan` doing it.
    const stream = env.host.stream(SESSION, { messages: messagesWith(body) })
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.(undefined)

    const reset = env.receipts.find((r) => r.kind === 'reset')
    assert.equal(reset?.code, code)
    assert.equal(env.plans.has(SESSION), false, `${code} must clear the plan too`)
  }
})

// ---------------------------------------------------------------------------
// Mutation re-review: the no-chunk path must clear the old plan too
// ---------------------------------------------------------------------------

test('M2 无 text-delta 的响应清空旧计划（no-chunk 路径）', async () => {
  const env = setup({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  env.runtime.onModelRequest(SESSION, 1, 0)
  // First request of the turn establishes the plan-turn note, so the second is
  // the same turn and only `rememberPlan` can drop the seeded plan.
  await streamOnce(env)
  env.plans.set(SESSION, { goal: 'old', steps: [candidate()] })
  assert.ok(env.plans.has(SESSION), 'the stale plan is present before the response')

  const chunks = await streamOnce(env)

  assert.equal(
    chunks.some((chunk) => chunk.type === 'text-delta'),
    false,
    'this response carries no text-delta at all: it must take the no-chunk path',
  )
  assert.equal(
    env.plans.has(SESSION),
    false,
    'a response without a plan block withdraws the previous plan even when it had no text',
  )
})

test('没有 per-session runtime 时，共享的 clock/budget/usage 只借给第一个会话（行 35）', async () => {
  const { sessionClock, sessionBudget, sessionUsage } = await import(
    '../src/hooks/llm-stream.ts'
  )
  const warnings: string[] = []
  // An embedder that wires one shared runtime and no registry: legal, but the
  // three objects carry per-session state, so a second session must not see
  // them — mixing two sessions is how a fake saving gets produced.
  const deps: Any = {
    config: DEFAULT_CONFIG,
    clock: { step: () => 1, turn: () => 1 },
    budget: { take: () => true },
    usage: { markSubstituted: () => undefined },
    logger: { warn: (message: string) => warnings.push(message) },
  }

  assert.equal(sessionClock(deps, SESSION), deps.clock, 'the first session keeps the loan')
  assert.equal(sessionBudget(deps, SESSION), deps.budget)
  assert.equal(sessionUsage(deps, SESSION), deps.usage)

  assert.equal(sessionClock(deps, OTHER), undefined, 'a second session gets no shared clock')
  assert.equal(sessionBudget(deps, OTHER), undefined, 'a second session gets no shared budget')
  assert.equal(sessionUsage(deps, OTHER), undefined, 'a second session gets no shared usage')

  assert.equal(warnings.length, 1, 'the warning is emitted once, not per accessor call')
  assert.match(warnings[0] ?? '', new RegExp(OTHER))

  // A wired registry is unaffected: each session gets its own instance.
  const registry = new SessionRuntime(DEFAULT_CONFIG.stepsPerTurn)
  const wired: Any = { config: DEFAULT_CONFIG, sessions: registry }
  assert.notEqual(sessionUsage(wired, SESSION), sessionUsage(wired, OTHER))
  assert.ok(sessionUsage(wired, OTHER) !== undefined)
})

test('M26a 共享实例的贷款随属主会话 dispose 释放，后续会话可以借用（行 26）', async () => {
  const { sessionClock, sessionBudget, sessionUsage } = await import(
    '../src/hooks/llm-stream.ts'
  )
  const clock = { step: () => 1, turn: () => 1 }
  const budget = { take: () => true }
  const usage = { markSubstituted: () => undefined }
  const deps: Any = {
    config: DEFAULT_CONFIG,
    clock,
    budget,
    usage,
    logger: { warn: () => undefined },
  }

  assert.equal(sessionClock(deps, SESSION), clock, 'the first session owns the loan')
  assert.equal(sessionBudget(deps, SESSION), budget)
  assert.equal(sessionUsage(deps, SESSION), usage)

  // Disposing a different session must not release someone else's loan.
  clearSession(deps, OTHER)
  assert.equal(sessionClock(deps, SESSION), clock, 'a non-owner dispose leaves the loan alone')

  // The owner is disposed: the loan is free again for a later session, instead
  // of refusing substitution for the rest of the process lifetime.
  clearSession(deps, SESSION)
  assert.equal(sessionClock(deps, OTHER), clock, 'a later session may borrow the freed clock')
  assert.equal(sessionBudget(deps, OTHER), budget, 'a later session may borrow the freed budget')
  assert.equal(sessionUsage(deps, OTHER), usage, 'a later session may borrow the freed usage')
})

test('M26b 两个 deps 共享同一组实例时只有一个会话借到，第二个 deps 不重复认领（行 26）', async () => {
  const { sessionClock, sessionBudget, sessionUsage } = await import(
    '../src/hooks/llm-stream.ts'
  )
  const clock = { step: () => 1, turn: () => 1 }
  const budget = { take: () => true }
  const usage = { markSubstituted: () => undefined }
  const warnings: string[] = []
  const logger = { warn: (message: string) => warnings.push(message) }
  // An embedder pattern the fallback exists for: two assemblies over the same
  // three stateful instances. Ownership belongs to the instance, not to the
  // deps object, or each assembly claims its own loan and both borrow.
  const first: Any = { config: DEFAULT_CONFIG, clock, budget, usage, logger }
  const second: Any = { config: DEFAULT_CONFIG, clock, budget, usage, logger }

  assert.equal(sessionClock(first, SESSION), clock)
  assert.equal(sessionBudget(first, SESSION), budget)
  assert.equal(sessionUsage(first, SESSION), usage)

  assert.equal(sessionClock(second, OTHER), undefined, 'the shared clock is already lent')
  assert.equal(sessionBudget(second, OTHER), undefined, 'the shared budget is already lent')
  assert.equal(sessionUsage(second, OTHER), undefined, 'the shared usage is already lent')
  assert.equal(warnings.length, 1, 'the refusal is still warned once per deps object')

  // Per-instance ownership, not a process-wide single loan: an assembly with
  // its own instances is unaffected.
  const own: Any = {
    config: DEFAULT_CONFIG,
    clock: { step: () => 1, turn: () => 1 },
    budget: { take: () => true },
    usage: { markSubstituted: () => undefined },
  }
  assert.notEqual(sessionClock(own, OTHER), undefined, 'distinct instances still lend')
  assert.notEqual(sessionBudget(own, OTHER), undefined)
  assert.notEqual(sessionUsage(own, OTHER), undefined)
})

test('M27 上游在 usage 前抛错时仍结算标记并报 unknown，重放不得配给旧标记（行 27）', async () => {
  const env = setup({ chunks: [{ type: 'text-delta', index: 0, text: 'TRIGGER partial' }] })
  env.runtime.onModelRequest(SESSION, 1, 0)
  const ledger = env.runtime.usageFor(SESSION)
  ledger.markSubstituted('A')

  env.host.llm.stream = async function* () {
    yield { type: 'text-delta', index: 0, text: 'TRIGGER partial' }
    throw new Error('provider 500 mid-stream')
  }

  await assert.rejects(streamOnce(env), /provider 500 mid-stream/)

  const settled = env.receipts.filter((receipt) => receipt.kind === 'substitute-settled')
  assert.equal(settled.length, 1, 'an errored stream must still settle the pending mark')
  assert.equal(
    settled[0]?.saved_input_tokens,
    'unknown',
    'an errored stream has no usable sample, so the honest answer is unknown',
  )
  assert.equal(settled[0]?.output_tokens, 'unknown')
  assert.equal(ledger.pendingCandidateId(), undefined, 'the mark must not outlive the error')

  // The next request is strictly larger. Before the fix it paired with the
  // dead mark and reported the replay's 100000 as a saving.
  env.host.llm.stream = async function* () {
    yield { type: 'usage', usage: { inputTokens: 100_000, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  await streamOnce(env)

  assert.equal(
    env.receipts.filter((receipt) => receipt.kind === 'substitute-settled').length,
    1,
    'the replay must not settle a mark that the errored stream already consumed',
  )
  assert.equal(ledger.last()?.input, 100_000, 'the replay was observed as an ordinary request')
})
