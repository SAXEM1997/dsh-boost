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
    createdAt: 0,
    ...over,
  }
  env.queue.set(SESSION, entry)
  return entry
}

/** A tool-role request message carrying exactly `text`. */
const messagesWith = (text: string) => [{ role: 'tool', content: [{ type: 'text', text }] }]

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

test('O6 插件自己的投影也保留 head+tail：不得误判成 compaction', async () => {
  const env = setup()
  seedAnchored(env)
  // Apply-mode projection composes head + spill footer + tail; no prune marker.
  const projected = `${LONG_ANCHOR.slice(0, 120)}\n(Omitted 99 bytes.)\n${LONG_ANCHOR.slice(-120)}`

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
  const points = Array.from(LONG_ANCHOR)
  const projected = `${points.slice(0, 12).join('')}\n(Omitted 99 bytes.)\n${points.slice(-12).join('')}`

  const chunks = await streamOnce(env, { messages: messagesWith(projected) })

  assert.equal(env.host.nextCalls, 0, 'a probe longer than the configured window would look like compaction')
  assert.equal(chunks.some((c) => c.type === 'tool-call-delta'), true)
  assert.equal(env.receipts.some((r) => r.kind === 'reset'), false)
})

test('O6 代理对边界：投影头尾按码点切片，32 字符探测不切开 astral 字符', async () => {
  const anchor = `${'a'.repeat(31)}😀${'b'.repeat(40)}😀${'c'.repeat(31)}`
  const env = setup()
  seedAnchored(env, anchor)
  const points = Array.from(anchor)
  const projected = `${points.slice(0, 32).join('')}\n(Omitted 40 bytes.)\n${points.slice(-32).join('')}`

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
