/**
 * Task 23b: the post-execute assembly.
 *
 * Every test group below pins one of the twelve review obligations. The
 * helpers build a real `registerHooks` assembly over the fake host: no seam is
 * faked except the host itself, so a wiring regression in production shows up
 * here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeHost } from './fakes/host.ts'
import { AnchorStore, PRUNE_MARKER } from '../src/gate/invalidate.ts'
import { PendingQueue, callIdFor } from '../src/hooks/pending.ts'
import { registerHooks, SUBSTITUTION_WHITELIST } from '../src/hooks/post-execute.ts'
import type { HookDeps } from '../src/hooks/post-execute.ts'
import { StepBudget } from '../src/admission/ledger.ts'
import { RetrievalLedger } from '../src/admission/retrieval.ts'
import { UsageLedger } from '../src/admission/usage.ts'
import { TurnClock } from '../src/hooks/clock.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { ProjectionCounters } from '../src/projection/counters.ts'
import { receiptHash } from '../src/receipts/store.ts'
import { DEFAULT_SCOPE } from '../src/scope/doc.ts'

const SESSION = 's1'
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

/** One hook assembly with recording stores; `over` replaces any dependency. */
function setup(over: { doc?: Any; deps?: Record<string, unknown> } = {}) {
  const host = fakeHost()
  const receipts: Any[] = []
  const anchors = new AnchorStore()
  const queue = new PendingQueue()
  const clock = new TurnClock()
  clock.onModelRequest(1, 0)
  const plans = new Map<string, Any>()
  const usage = new UsageLedger()
  usage.request({ input: 100_000, cacheRead: 100_000, output: 1 })
  const deps: Any = {
    config: DEFAULT_CONFIG,
    scope: {
      judgement: () => true,
      read: async () => ({ doc: over.doc ?? doc() }),
    },
    receipts: {
      append: async (r: Any) => {
        receipts.push(r)
      },
    },
    anchors,
    resolveSession: () => WORKSPACE,
    queue,
    budget: new StepBudget(8),
    usage,
    clock,
    plans,
    // Substitution now requires a token meter (design §9). The real host
    // profile loads `dsh-token-meter`; tests that need the degradation pass
    // `estimateText: undefined` explicitly.
    estimateText: (text: string) => Math.ceil(text.length / 4),
    ...over.deps,
  }
  registerHooks(host, deps)
  return { host, receipts, anchors, queue, clock, plans, usage, deps }
}

/** One post-execute call with the real nested agent shape. */
function runPost(
  host: Any,
  text: string,
  decision: Any = { kind: 'accept' },
  execOver: Record<string, unknown> = {},
): Promise<Any> {
  return host.callHook(
    'tools/post-execute',
    [
      { name: 'read', callId: 'root-call', agent, ...execOver },
      { content: [{ type: 'text', text }] },
    ],
    async () => decision,
  )
}

/** One candidate whose guard passes on any receipt containing `needle`. */
function candidate(id: string, needle: string, args: Record<string, unknown> = { file_path: '/x' }) {
  return { id, tool: 'read', args, guards: [{ text_contains: needle }] }
}

// ---------------------------------------------------------------------------
// Obligation 1: `step` comes from clock.step(), never a plugin counter
// ---------------------------------------------------------------------------

test('O1 commit 的 step/turn 取自 clock，callId 可用 clock 值复算', async () => {
  const env = setup()
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })
  env.clock.onModelRequest(2, 7)

  await runPost(env.host, 'TRIGGER here')

  const entry = env.queue.peek(SESSION)
  assert.ok(entry, 'a non-shadow commit must enqueue')
  assert.equal(entry.step, 7, 'step must be the host step from clock.step()')
  assert.equal(entry.turn, 2)
  assert.equal(entry.callId, callIdFor(SESSION, 2, 7, 'A'))
  assert.equal(entry.candidateId, 'A')
  assert.equal(entry.name, 'read')
})

test('O1 没有 clock 时不伪造步号、不入队（fail-closed）', async () => {
  const env = setup({ deps: { clock: undefined } })
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })

  await runPost(env.host, 'TRIGGER here')

  assert.equal(env.queue.peek(SESSION), undefined)
  const skip = env.receipts.find((r) => r.code === 'substitution-unavailable')
  assert.ok(skip, 'missing clock must be recorded, not guessed')
  assert.equal(skip.reason, 'no-step')
  assert.equal(skip.kind, 'skip')
})

test('TurnClock.step() 记录宿主步号：新 turn 归零、同 turn 单调前进、非有限值忽略', () => {
  const c = new TurnClock()
  assert.equal(c.step(), 0)
  c.onModelRequest(1, 3)
  assert.equal(c.step(), 3)
  c.onModelRequest(1, 5)
  assert.equal(c.step(), 5)
  c.onModelRequest(1, 4) // backwards inside one turn must not reuse an older id
  assert.equal(c.step(), 5)
  c.onModelRequest(1, NaN)
  assert.equal(c.step(), 5)
  c.onModelRequest(2, 0)
  assert.equal(c.turn(), 2)
  assert.equal(c.step(), 0, 'a new turn restarts the host step index')
  c.onModelRequest(2, 9)
  assert.equal(c.step(), 9)
})

// ---------------------------------------------------------------------------
// Obligation 2: the receipt map keys `root` and executed candidate ids
// ---------------------------------------------------------------------------

test('O2 root 是刚到达的回执，后续调用看到的是最新一条', async () => {
  const env = setup()
  const templated = {
    id: 'A',
    tool: 'read',
    args: { file_path: { $public: { after: 'root', field: '$scalar' } } },
    guards: [{ text_contains: '/' }],
  }
  env.plans.set(SESSION, { goal: 'g', steps: [templated] })
  await runPost(env.host, '/first')
  assert.deepEqual(env.queue.peek(SESSION)?.args, { file_path: '/first' })

  env.queue.clear(SESSION)
  env.anchors.clear(SESSION)
  env.plans.set(SESSION, { goal: 'g', steps: [templated] })
  await runPost(env.host, '/second')
  assert.deepEqual(env.queue.peek(SESSION)?.args, { file_path: '/second' })
})

test('O2 被派发候选的回执按 candidateId 入图，后续步骤的 $public 可引用', async () => {
  const env = setup()
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [
      {
        id: 'A',
        tool: 'read',
        args: { file_path: { $public: { after: 'root', field: '$scalar' } } },
        guards: [{ text_contains: 'A-TRIGGER' }],
      },
      {
        id: 'B',
        tool: 'read',
        args: { file_path: { $public: { after: 'A', field: '$scalar' } } },
        guards: [{ text_contains: 'B-TRIGGER' }],
      },
    ],
  })

  // Step 1: the root receipt commits A.
  await runPost(env.host, 'A-TRIGGER')
  const first = env.queue.peek(SESSION)
  assert.equal(first?.candidateId, 'A')
  assert.deepEqual(first?.args, { file_path: 'A-TRIGGER' })

  // Step 2: the synthesized call is dispatched and accepted; the execute hook
  // records the callId -> candidate mapping and keeps the queue entry alive
  // until this point.
  const dispatched = await env.host.callHook(
    'tools/execute',
    [{ name: 'read', callId: first?.callId, arguments: first?.args, agent }],
    async () => 'DISPATCHED',
  )
  assert.equal(dispatched, 'DISPATCHED')
  assert.equal(env.queue.peek(SESSION), undefined, 'execute clears on the accept path')

  // Step 3: A's own receipt arrives. The plan was spent when A was committed,
  // so this receipt is not a second decision; the receipt is still filed under A.
  await runPost(env.host, '/from-a', { kind: 'accept' }, { callId: first?.callId })
  assert.equal(env.plans.has(SESSION), false, 'the plan is one-shot per receipt')
  env.anchors.clear(SESSION)

  // Step 4: the model writes a fresh plan in its next response. B's template
  // must still bind A's receipt text, which the session state kept.
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [
      {
        id: 'B',
        tool: 'read',
        args: { file_path: { $public: { after: 'A', field: '$scalar' } } },
        guards: [{ text_contains: 'B-TRIGGER' }],
      },
    ],
  })
  await runPost(env.host, 'B-TRIGGER')
  const second = env.queue.peek(SESSION)
  assert.equal(second?.candidateId, 'B')
  assert.deepEqual(second?.args, { file_path: '/from-a' }, 'B bound the receipt filed under A')
})

// ---------------------------------------------------------------------------
// Obligation 3: executable args are the bound decision tree, never the plan's
// ---------------------------------------------------------------------------

test('O3 入队参数是绑定后的字面量，绝不重新读 plan.steps 里的 $public 模板', async () => {
  const env = setup()
  const templated = {
    id: 'A',
    tool: 'read',
    args: { file_path: { $public: { after: 'root', field: '$scalar' } } },
    guards: [{ text_contains: 'TRIGGER' }],
  }
  env.plans.set(SESSION, { goal: 'g', steps: [templated] })

  await runPost(env.host, 'TRIGGER')

  const entry = env.queue.peek(SESSION)
  assert.deepEqual(entry?.args, { file_path: 'TRIGGER' })
  assert.equal(JSON.stringify(entry?.args).includes('$public'), false)
  // The plan object still holds the template; the queue must not have used it.
  assert.ok(JSON.stringify(templated.args).includes('$public'))
})

// ---------------------------------------------------------------------------
// Obligation 4: a committed candidate is consumed from the plan
// ---------------------------------------------------------------------------

test('O4 计划按回执一次性使用：commit 后整份计划清空，后续回执不得复用', async () => {
  const env = setup()
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [candidate('A', 'TRIGGER'), candidate('B', 'IMPOSSIBLE')],
  })

  await runPost(env.host, 'TRIGGER')
  assert.equal(env.queue.peek(SESSION)?.candidateId, 'A')
  assert.equal(env.plans.has(SESSION), false, 'the plan is spent once its receipt was considered')

  // A second trigger must not re-commit A from a plan the model no longer owns.
  env.queue.clear(SESSION)
  env.anchors.clear(SESSION)
  await runPost(env.host, 'TRIGGER')
  assert.equal(env.queue.peek(SESSION), undefined, 'A must not be committed twice')
  assert.equal(env.receipts.some((r) => r.code === 'no-candidate'), false, 'no plan, no decision')

  // The model's next response can write a fresh plan; this one has nothing viable
  // and is consumed without committing.
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('B', 'IMPOSSIBLE')] })
  await runPost(env.host, 'TRIGGER')
  assert.equal(env.queue.peek(SESSION), undefined)
  assert.ok(env.receipts.some((r) => r.code === 'no-candidate'))
  assert.equal(env.plans.has(SESSION), false, 'a failing plan must not outlive its receipt')
})

test('O4 ask-selector 无 llm/route 时只记 selector-unavailable，不猜、不消费', async () => {
  const env = setup()
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [candidate('A', 'TRIGGER'), candidate('B', 'TRIGGER')],
  })

  await runPost(env.host, 'TRIGGER')

  assert.equal(env.queue.peek(SESSION), undefined, 'without a selector seam nothing may be queued')
  assert.equal(
    env.plans.has(SESSION),
    false,
    'a plan considered once is spent even when the selector is unavailable',
  )
  assert.ok(
    env.receipts.some((r) => r.kind === 'skip' && r.code === 'selector-unavailable'),
    'the missing seam must be recorded, not guessed',
  )
})

test('O1 无 estimator 时拒绝替换：不入队、不调 selector、写 ERR_HOST_NO_TOKENMETER', async () => {
  const env = setup({ deps: { estimateText: undefined } })
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })

  await runPost(env.host, 'TRIGGER here')

  assert.equal(env.queue.peek(SESSION), undefined, 'no meter must never queue a replacement')
  const skip = env.receipts.find((receipt) => receipt.code === 'ERR_HOST_NO_TOKENMETER')
  assert.ok(skip, 'the refusal must carry the stable code')
  assert.equal(skip.kind, 'skip')
  assert.equal(skip.reason, 'no-token-meter')
})

// ---------------------------------------------------------------------------
// Obligation 5: one shadow flag drives decide and the record-only branch
// ---------------------------------------------------------------------------

test('O5 影子期 commit：shadow 与 projection 两账独立，队列/预算/usage 不动', async () => {
  let estimated = 0
  const big = 'T'.repeat(6000) + ' TRIGGER'
  const env = setup({
    doc: doc({ shadow: true, projection: 'shadow' }),
    deps: { estimateText: (t: string) => (estimated += 1, Math.ceil(t.length / 4)) },
  })
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [{ id: 'A', tool: 'bash', args: { command: 'ls' }, guards: [{ text_contains: 'TRIGGER' }] }],
  })

  const res = await runPost(env.host, big, { kind: 'accept' }, { arguments: { path: '/big' } })

  const shadow = env.receipts.find((r) => r.kind === 'shadow' && r.code === 'ok')
  assert.ok(shadow, 'a shadow commit writes a shadow receipt')
  assert.equal(shadow.decision, 'commit')
  assert.equal(shadow.candidateId, 'A')
  assert.equal(shadow.candidateTool, 'bash', 'byFamily keys on the candidate, not the executed call')
  assert.equal(typeof shadow.admitted, 'boolean')
  assert.equal(shadow.whitelisted, false, 'shadow records families outside the whitelist')

  // §5.2-5: the two switches are independent. A shadow substitution must not
  // hide the projection ledger on exactly the receipts the gate acts on.
  const projection = env.receipts.find(
    (r) => r.kind === 'shadow' && r.code === 'projection-shadow',
  )
  assert.ok(projection, 'the shadow commit must still write projection accounting')
  assert.equal(projection.unit, 'raw')
  assert.equal(typeof projection.before, 'number')
  assert.equal(typeof projection.after, 'number')
  assert.equal(typeof projection.saved_projection_tokens, 'number')
  assert.equal(projection.estimate, 'unknown', 'no estimateKind wired means unknown')
  assert.ok(estimated > 0, 'projection accounting prices the receipt')

  assert.equal(env.queue.peek(SESSION), undefined)
  assert.equal(env.deps.budget.count(), 0, 'shadow must not take budget')
  assert.equal(env.deps.usage.pendingCandidateId(), undefined, 'shadow must not mark a substitution')
  assert.equal(env.receipts.filter((r) => r.kind === 'projection').length, 0, 'shadow projection applies nothing')
  assert.equal(Object.hasOwn(res, 'content'), false, 'projection-shadow must not replace content')
})

test('O5 shadow 替换 + projection on：两开关独立，投影仍然生效', async () => {
  const big = 'T'.repeat(6000) + ' TRIGGER'
  const env = setup({
    doc: doc({ shadow: true, projection: 'on' }),
    deps: {
      spill: {
        saveText: async () => ({ locator: '/spill/read.txt', retrievalHint: 'read it' }),
      },
      hasSpillNotice: () => false,
    },
  })
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [{ id: 'A', tool: 'bash', args: { command: 'ls' }, guards: [{ text_contains: 'TRIGGER' }] }],
  })

  const res = await runPost(env.host, big)

  assert.ok(env.receipts.some((r) => r.kind === 'shadow' && r.decision === 'commit'))
  assert.ok(env.receipts.some((r) => r.kind === 'projection' && r.code === 'projected'))
  assert.ok(res.content[0].text.length < big.length, 'projection on replaces content')
  assert.equal(env.queue.peek(SESSION), undefined, 'the substitution side stays record-only')
  assert.equal(env.deps.budget.count(), 0)
})

test('O5 同一 shadow flag 也传给 decide：bash 在影子期 commit，非影子期被白名单拒绝', async () => {
  const bashPlan = (env: ReturnType<typeof setup>) =>
    env.plans.set(SESSION, {
      goal: 'g',
      steps: [{ id: 'A', tool: 'bash', args: { command: 'ls' }, guards: [{ text_contains: 'TRIGGER' }] }],
    })

  const shadowEnv = setup({ doc: doc({ shadow: true }) })
  bashPlan(shadowEnv)
  await runPost(shadowEnv.host, 'TRIGGER')
  assert.equal(shadowEnv.receipts.find((r) => r.kind === 'shadow')?.candidateId, 'A')

  const realEnv = setup()
  bashPlan(realEnv)
  await runPost(realEnv.host, 'TRIGGER')
  assert.equal(realEnv.queue.peek(SESSION), undefined)
  assert.ok(realEnv.receipts.some((r) => r.code === 'tool-not-whitelisted'))
})

test('O5 影子期也走 live visibility：越权会话不记影子（F2 复核）', async () => {
  const env = setup({
    doc: doc({ shadow: true }),
    deps: { resolveSession: () => undefined },
  })
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })

  await runPost(env.host, 'TRIGGER')

  assert.equal(env.receipts.some((r) => r.kind === 'shadow'), false)
  assert.ok(env.receipts.some((r) => r.code === 'skip:no-scope'))
  assert.equal(env.queue.peek(SESSION), undefined)
  assert.equal(env.plans.has(SESSION), false, 'the plan was considered and is spent')
})

// ---------------------------------------------------------------------------
// Obligation 6: worthSubstituting, then budget.take(); never budget for a
// call that is not substituted
// ---------------------------------------------------------------------------

test('O6 没有决定时不扣预算；准入通过后才 take（顺序颠倒则预算先耗尽）', async () => {
  const budget = new StepBudget(1)
  const env = setup({ deps: { budget } })
  // A plan whose single guard fails: decide returns no-candidate.
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [candidate('A', 'IMPOSSIBLE')],
  })
  await runPost(env.host, 'TRIGGER')
  assert.ok(env.receipts.some((r) => r.code === 'no-candidate'))
  assert.equal(budget.count(), 0, 'a fallback must not take budget')
  assert.equal(env.plans.has(SESSION), false, 'a failing plan must not outlive its receipt')

  // A viable candidate that is admitted: only now may the budget be spent.
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [candidate('A', 'TRIGGER'), candidate('B', 'IMPOSSIBLE')],
  })
  await runPost(env.host, 'TRIGGER')
  const entry = env.queue.peek(SESSION)
  assert.equal(entry?.candidateId, 'A')
  assert.equal(budget.count(), 1)
  assert.equal(env.deps.usage.pendingCandidateId(), 'A', 'commit marks the usage pairing')
})

test('O6 预算耗尽：不覆盖已有条目，写 steps-exhausted', async () => {
  const budget = new StepBudget(8)
  for (let i = 0; i < 8; i += 1) budget.take()
  const env = setup({ deps: { budget } })
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [candidate('A', 'TRIGGER'), candidate('B', 'IMPOSSIBLE')],
  })
  // A live entry from another call in the same step: this invocation enqueued
  // nothing, so it must not cancel it (review F2).
  env.queue.set(SESSION, {
    callId: 'live-call',
    candidateId: 'LIVE',
    name: 'read',
    args: { file_path: '/live' },
    turn: 1,
    step: 0,
  })

  await runPost(env.host, 'TRIGGER')

  assert.equal(env.queue.peek(SESSION)?.callId, 'live-call', 'the live entry survives')
  assert.ok(env.receipts.some((r) => r.code === 'steps-exhausted'))
})

test('O6 准入不过时不入队（worthSubstituting 为假）', async () => {
  const env = setup({
    deps: {
      config: { ...DEFAULT_CONFIG, admission: { thresholdTokens: 10 ** 6 } },
    },
  })
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [candidate('A', 'TRIGGER'), candidate('B', 'IMPOSSIBLE')],
  })

  await runPost(env.host, 'TRIGGER')

  assert.equal(env.queue.peek(SESSION), undefined)
  assert.ok(env.receipts.some((r) => r.code === 'not-admitted'))
})

test('O6 fallback 不清空另一调用的 pending 条目（F2）', async () => {
  const env = setup()
  env.queue.set(SESSION, {
    callId: 'live-call',
    candidateId: 'LIVE',
    name: 'read',
    args: { file_path: '/live' },
    turn: 1,
    step: 0,
  })
  // A plan whose only guard fails: decide returns no-candidate (a fallback).
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'IMPOSSIBLE')] })

  await runPost(env.host, 'TRIGGER')

  assert.ok(env.receipts.some((r) => r.code === 'no-candidate'))
  assert.equal(env.queue.peek(SESSION)?.callId, 'live-call', 'the live entry survives')
  assert.equal(env.deps.budget.count(), 0, 'the fallback itself spends nothing')
})

// ---------------------------------------------------------------------------
// Obligation 7: the execute hook peeks, compares callId, and clears both paths
// ---------------------------------------------------------------------------

test('O7 callId 不同是普通调用：直通、不写收据、条目保留（F2）', async () => {
  const env = setup()
  env.queue.set(SESSION, {
    callId: 'decided-call',
    candidateId: 'A',
    name: 'read',
    args: { file_path: '/a' },
    turn: 1,
    step: 0,
  })
  let dispatched = 0
  const out: Any = await env.host.callHook(
    'tools/execute',
    [{ name: 'grep', callId: 'someone-else', arguments: { pattern: 'x' }, agent }],
    async () => {
      dispatched += 1
      return 'OTHER'
    },
  )

  // The host assigns call ids; a call with a different id is not our dispatch.
  assert.equal(out, 'OTHER')
  assert.equal(dispatched, 1, 'the ordinary call must reach its tool')
  assert.equal(env.queue.peek(SESSION)?.callId, 'decided-call', 'the entry survives')
  assert.equal(env.receipts.some((r) => r.code === 'dispatch-rejected'), false)
})

test('O7 名/参不符走 rejectIfTampered，且同样清队列', async () => {
  const env = setup()
  env.queue.set(SESSION, {
    callId: 'decided-call',
    candidateId: 'A',
    name: 'read',
    args: { file_path: '/a' },
    turn: 1,
    step: 0,
  })
  const out: Any = await env.host.callHook(
    'tools/execute',
    [{ name: 'read', callId: 'decided-call', arguments: { file_path: '/b' }, agent }],
    async () => 'DISPATCHED',
  )

  assert.equal(out.isError, true)
  assert.equal(out.error.info.code, 'dispatch-rejected')
  assert.equal(env.queue.peek(SESSION), undefined)

  const rejected = env.receipts.find((r) => r.code === 'dispatch-rejected')
  assert.ok(rejected)
  assert.deepEqual(rejected.args, { file_path: '/b' }, 'the executed (tampered) args are evidence')
  assert.match(rejected.preview, /read/)
  assert.match(rejected.preview, /\/b/)
  assert.ok(Array.from(rejected.preview).length <= 256)
})

test('O7 accept 路径清队列（条目完成使命后不得残留）', async () => {
  const env = setup()
  env.queue.set(SESSION, {
    callId: 'decided-call',
    candidateId: 'A',
    name: 'read',
    args: { file_path: '/a' },
    turn: 1,
    step: 0,
  })

  const first = await env.host.callHook(
    'tools/execute',
    [{ name: 'read', callId: 'decided-call', arguments: { file_path: '/a' }, agent }],
    async () => 'DISPATCHED',
  )
  assert.equal(first, 'DISPATCHED')

  // A later call with a different callId now passes through either way; the
  // pinning observation is that the accepted entry did not survive.
  const second = await env.host.callHook(
    'tools/execute',
    [{ name: 'grep', callId: 'other-call', arguments: { pattern: 'x' }, agent }],
    async () => 'DISPATCHED-2',
  )
  assert.equal(second, 'DISPATCHED-2')
  assert.equal(env.queue.peek(SESSION), undefined, 'the accept path must clear too')
})

test('O7 queue.peek 抛错时 tools/execute 不抛、直通', async () => {
  const env = setup({
    deps: {
      queue: {
        peek: () => {
          throw new Error('queue boom')
        },
        clear: () => {},
      },
    },
  })
  const out = await env.host.callHook(
    'tools/execute',
    [{ name: 'read', callId: 'c1', arguments: { file_path: '/a' }, agent }],
    async () => 'DISPATCHED',
  )
  assert.equal(out, 'DISPATCHED')
})

// ---------------------------------------------------------------------------
// Obligation 8: the whitelist is exactly read/grep/glob
// ---------------------------------------------------------------------------

test('O8 白名单常量恰为 read/grep/glob（decide 与收据共用同一常量）', async () => {
  assert.deepEqual([...SUBSTITUTION_WHITELIST].sort(), ['glob', 'grep', 'read'])

  const env = setup()
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [{ id: 'A', tool: 'bash', args: { command: 'ls' }, guards: [{ text_contains: 'TRIGGER' }] }],
  })
  await runPost(env.host, 'TRIGGER')
  assert.ok(env.receipts.some((r) => r.code === 'tool-not-whitelisted'))

  env.plans.set(SESSION, {
    goal: 'g',
    steps: [{ id: 'A', tool: 'glob', args: { pattern: '*.x' }, guards: [{ text_contains: 'TRIGGER' }] }],
  })
  await runPost(env.host, 'TRIGGER')
  assert.equal(env.queue.peek(SESSION)?.name, 'glob')
})

// ---------------------------------------------------------------------------
// Obligation 9: usage.markSubstituted(candidateId) on a commit
// ---------------------------------------------------------------------------

test('O9 非影子 commit 标记 usage；settle 仍由 23c 写（本钩子不写 substitute 收据）', async () => {
  const env = setup()
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })

  await runPost(env.host, 'TRIGGER')

  assert.equal(env.deps.usage.pendingCandidateId(), 'A')
  assert.equal(env.receipts.some((r) => r.kind === 'substitute'), false)
})

// ---------------------------------------------------------------------------
// Obligation 10: anchors on commit, cleared at turn end
// ---------------------------------------------------------------------------

test('O10 commit 写 anchors（stepId root + root 文本），新 turn 清空', async () => {
  const text = 'TRIGGER/a'
  const env = setup()
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [
      {
        id: 'A',
        tool: 'read',
        args: { file_path: { $public: { after: 'root', field: '$scalar' } } },
        guards: [{ text_contains: 'TRIGGER' }],
      },
    ],
  })

  await runPost(env.host, text)
  const anchors = env.anchors.get(SESSION)
  assert.ok(anchors, 'a commit records anchors')
  assert.equal(anchors.stepId, 'root')
  assert.deepEqual(anchors.anchors, { root: text })

  // Same text on the next turn: only the turn-end clear can remove the anchors
  // (an equal anchor would otherwise survive invalidate).
  env.clock.onModelRequest(2, 0)
  await runPost(env.host, text)
  assert.equal(env.anchors.get(SESSION), undefined, 'turn end clears the session anchors')
  assert.equal(env.queue.peek(SESSION), undefined, 'turn end clears the pending entry too (F2)')
  assert.equal(env.receipts.some((r) => r.kind === 'reset'), false)
})

test('O10 anchors 同时记录候选引用的历史回执 id', async () => {
  const env = setup()
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [
      {
        id: 'A',
        tool: 'read',
        args: { file_path: { $public: { after: 'root', field: '$scalar' } } },
        guards: [{ text_contains: 'A-TRIGGER' }],
      },
      {
        id: 'B',
        tool: 'read',
        args: { file_path: { $public: { after: 'A', field: '$scalar' } } },
        guards: [{ text_contains: 'B-TRIGGER' }],
      },
    ],
  })

  await runPost(env.host, 'A-TRIGGER')
  const first = env.queue.peek(SESSION)
  // Execute and file A's receipt under its candidate id (the execute hook
  // consumes the entry; clearing it here would lose the dispatch mapping).
  await env.host.callHook(
    'tools/execute',
    [{ name: 'read', callId: first?.callId, arguments: first?.args, agent }],
    async () => 'DISPATCHED',
  )
  await runPost(env.host, '/from-a', { kind: 'accept' }, { callId: first?.callId })
  env.anchors.clear(SESSION)

  // The plan is one-shot, so B arrives in the model's next response and still
  // binds the receipt cached under A.
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [
      {
        id: 'B',
        tool: 'read',
        args: { file_path: { $public: { after: 'A', field: '$scalar' } } },
        guards: [{ text_contains: 'B-TRIGGER' }],
      },
    ],
  })
  await runPost(env.host, 'B-TRIGGER')
  const anchors = env.anchors.get(SESSION)
  assert.deepEqual(anchors?.anchors, { root: 'B-TRIGGER', A: '/from-a' })
  assert.equal(anchors?.stepId, 'root')
})

// ---------------------------------------------------------------------------
// Review F1: post-execute runs the marker branch only, never the anchor compare
// ---------------------------------------------------------------------------

test('F1 commit 后的下一条回执不触发 compaction-reset，anchors 保留', async () => {
  const env = setup()
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })

  await runPost(env.host, 'TRIGGER')
  assert.ok(env.queue.peek(SESSION), 'the commit is live')
  assert.notEqual(env.anchors.get(SESSION), undefined, 'the commit sets anchors')

  // The substituted call's own result (or any unrelated result) is a different
  // call's text: the anchor comparison cannot establish identity here and would
  // always fire a false compaction-reset (review F1).
  await runPost(env.host, 'a different tool result')

  assert.equal(env.receipts.some((r) => r.kind === 'reset'), false, 'no false reset')
  assert.notEqual(env.anchors.get(SESSION), undefined, 'anchors must survive for 23c')
  assert.ok(env.queue.peek(SESSION), 'the pending entry must survive too')
})

test('F2 重置清空 pending 条目并写真实 turn（设计 §5.2-7）', async () => {
  const env = setup()
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })

  await runPost(env.host, 'TRIGGER')
  assert.ok(env.queue.peek(SESSION), 'the commit is pending')

  env.plans.set(SESSION, { goal: 'late', steps: [candidate('B', 'tail')] })
  await runPost(env.host, `head${PRUNE_MARKER}tail`)

  assert.equal(env.queue.peek(SESSION), undefined, 'a reset empties pending')
  assert.equal(env.plans.has(SESSION), false, 'a reset also drops the plan it invalidated')
  assert.equal(env.anchors.get(SESSION), undefined)
  const reset = env.receipts.find((r) => r.kind === 'reset')
  assert.equal(reset?.code, 'pruned-reset')
  assert.equal(reset?.turn, 1, 'the reset receipt carries the clock turn')
})

// ---------------------------------------------------------------------------
// Row 1 (P0): an invalidated decision settles its usage mark
// ---------------------------------------------------------------------------

test('P0 reset 结算决策期的 usage mark：下一条真实请求不写 substitute-settled', async () => {
  const env = setup()
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })

  await runPost(env.host, 'TRIGGER')
  assert.equal(env.usage.pendingCandidateId(), 'A', 'the commit marked the usage pairing')

  // A later receipt carrying the pruner literal triggers the reset path.
  await runPost(env.host, `head${PRUNE_MARKER}tail`)
  assert.equal(env.queue.peek(SESSION), undefined, 'the reset emptied pending')
  assert.equal(
    env.usage.pendingCandidateId(),
    undefined,
    'the abandoned decision must settle its mark, like applyAbandon',
  )

  // The next real request must not report a saving for a substitution that
  // never ran.
  for await (const _chunk of env.host.stream(SESSION)) {
    // drain
  }
  assert.equal(
    env.receipts.some((r) => r.kind === 'substitute-settled'),
    false,
    'a reset is not a measurement',
  )
})

// ---------------------------------------------------------------------------
// Rows 2 and 36: the selector is paid for only when it is affordable and the
// admission charge covers everything the call sends
// ---------------------------------------------------------------------------

test('row 2：预算耗尽时先记 steps-exhausted，选择器一次也不调用', async () => {
  let selectorCalls = 0
  const env = setup({
    deps: {
      budget: new StepBudget(0),
      llm: {
        stream: async function* () {
          selectorCalls += 1
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      selectorRoute: () => ({ provider: 'p', model: 'm' }),
    },
  })
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [candidate('A', 'TRIGGER'), candidate('B', 'TRIGGER')],
  })

  await runPost(env.host, 'TRIGGER')

  assert.equal(selectorCalls, 0, 'an exhausted budget must not pay for a selector call')
  assert.ok(env.receipts.some((r) => r.code === 'steps-exhausted'))
  assert.equal(env.queue.peek(SESSION), undefined)
  assert.equal(env.receipts.some((r) => r.code.startsWith('selector-')), false)
})

test('row 36：选择器准入按它真正发送的 system prompt 与模板计价', async () => {
  const priced: string[] = []
  const env = setup({
    deps: {
      estimateText: (text: string) => {
        priced.push(text)
        return Math.ceil(text.length / 4)
      },
      llm: {
        stream: async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      selectorRoute: () => ({ provider: 'p', model: 'm' }),
    },
  })
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [candidate('A', 'TRIGGER'), candidate('B', 'TRIGGER')],
  })

  await runPost(env.host, 'TRIGGER')

  const selectorText = priced.find((text) => text.includes('Candidates:'))
  assert.ok(selectorText, 'the selector input must be priced before the call')
  assert.ok(selectorText.includes('You are a selector'), 'the system prompt is input too')
  assert.ok(selectorText.includes('Latest receipt:'), 'the user template is input too')
  assert.ok(selectorText.includes('TRIGGER'), 'the receipt text is input too')
  assert.ok(selectorText.includes('A: read'), 'the candidate list is input too')
})

test('row 73 下游 decision 已带 spill footer：二次投影守卫必须拦下投影', async () => {
  const big = 'x'.repeat(4000)
  const downstream = `SPILLED-NOTICE ${big}`
  const env = setup({
    doc: doc({ projection: 'on' }),
    deps: {
      estimateText: (text: string) => Math.ceil(text.length / 4),
      hasSpillNotice: (text: string) => text.includes('SPILLED-NOTICE'),
      spill: {
        saveText: async () => ({ locator: '/spill/x', retrievalHint: 'read it' }),
      },
    },
  })
  const decision = { kind: 'accept', content: [{ type: 'text', text: downstream }] }

  // The receiver is clean; only the downstream decision carries the footer an
  // inner listener already wrote. A second projection would hide it twice.
  const res = await runPost(env.host, 'original receipt', decision)

  assert.equal(res.content[0].text, downstream, 'the downstream decision is returned untouched')
  assert.equal(
    env.receipts.some((r) => r.kind === 'projection'),
    false,
    'the downstream double-projection check must stop the projection',
  )
})

test('row 74 savedTokensOf 拒绝非有限/负样本：不得把 Infinity 当节省', async () => {
  const env = setup()
  // A finite-looking request sample containing a non-finite count must not be
  // admitted: without the guard, input+cacheRead is Infinity and clears any
  // threshold.
  env.usage.request({ input: -1, cacheRead: Number.POSITIVE_INFINITY, output: 0 })
  env.plans.set(SESSION, {
    goal: 'g',
    // Two steps: not the deterministic-single exemption, so the threshold runs.
    steps: [candidate('A', 'TRIGGER'), candidate('B', 'NEVER')],
  })

  await runPost(env.host, 'TRIGGER')

  assert.equal(env.queue.peek(SESSION), undefined, 'an unusable sample saves nothing')
  assert.ok(env.receipts.some((r) => r.code === 'not-admitted'))
})

// ---------------------------------------------------------------------------
// Obligation 11: projection receipts carry the design's field names
// ---------------------------------------------------------------------------

test('O11 投影收据：kind=projection、unit=raw、before/after 为数字、带 saved_projection_tokens', async () => {
  const estimate = (t: string) => Math.ceil(t.length / 4)
  const big = 'x'.repeat(4000)
  const env = setup({
    doc: doc({ projection: 'on' }),
    deps: {
      estimateText: estimate,
      spill: {
        saveText: async (_input: { content: string }) => ({
          locator: '/spill/read.txt',
          retrievalHint: 'read it',
        }),
      },
    },
  })
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'IMPOSSIBLE')] })

  const res = await runPost(env.host, big, { kind: 'accept' }, { arguments: { file_path: '/big' } })

  const projection = env.receipts.find((r) => r.kind === 'projection')
  assert.ok(projection, 'projection mode on writes a projection receipt')
  assert.equal(projection.unit, 'raw')
  assert.equal(projection.code, 'projected')
  assert.equal(projection.preview, big.slice(0, 256))
  assert.deepEqual(projection.args, { file_path: '/big' }, 'the applied call args are evidence')
  assert.equal(typeof projection.before, 'number')
  assert.equal(typeof projection.after, 'number')
  assert.equal(projection.before, estimate(big))
  assert.equal(projection.saved_projection_tokens, projection.before - projection.after)
  assert.ok(res.content[0].text.length < big.length, 'the decision carries the projected text')
})

test('O11 投影 shadow 只记账：kind=shadow、before/after、decision 不被替换', async () => {
  const big = 'x'.repeat(4000)
  const env = setup({
    doc: doc({ projection: 'shadow' }),
    deps: { estimateText: (t: string) => Math.ceil(t.length / 4) },
  })
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'IMPOSSIBLE')] })

  const res = await runPost(env.host, big)

  assert.equal(Object.hasOwn(res, 'content'), false)
  const shadow = env.receipts.find((r) => r.kind === 'shadow' && r.code === 'projection-shadow')
  assert.ok(shadow)
  assert.equal(shadow.unit, 'raw')
  assert.equal(typeof shadow.before, 'number')
  assert.equal(typeof shadow.after, 'number')
  assert.equal(env.receipts.some((r) => r.kind === 'projection'), false)
})

test('O11 projection off 不投影、不写投影收据', async () => {
  const env = setup({ doc: doc({ projection: 'off' }), deps: { estimateText: () => 1 } })
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'IMPOSSIBLE')] })
  const res = await runPost(env.host, 'y'.repeat(4000))
  assert.equal(Object.hasOwn(res, 'content'), false)
  assert.equal(env.receipts.some((r) => r.kind === 'projection' || r.kind === 'shadow'), false)
})

test('O11 缺 spill 时 on 模式原样放行并写 projection-skipped:no-spill', async () => {
  const env = setup({
    doc: doc({ projection: 'on' }),
    deps: { estimateText: () => 10 },
  })
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'IMPOSSIBLE')] })
  const res = await runPost(env.host, 'z'.repeat(4000))
  assert.equal(Object.hasOwn(res, 'content'), false)
  assert.ok(env.receipts.some((r) => r.code === 'projection-skipped:no-spill'))
})

// ---------------------------------------------------------------------------
// Obligation 12: nothing throws out of either listener
// ---------------------------------------------------------------------------

test('O12 外来依赖抛错时 post-execute 不抛、decision 原样返回', async () => {
  const decision = { kind: 'accept' }
  const env = setup({
    doc: doc({ projection: 'shadow' }),
    deps: {
      anchors: {
        get: () => {
          throw new Error('anchors boom')
        },
        set: () => {
          throw new Error('anchors set boom')
        },
        clear: () => {
          throw new Error('anchors clear boom')
        },
      },
      resolveSession: () => {
        throw new Error('resolve boom')
      },
      receipts: {
        append: async () => {
          throw new Error('receipt boom')
        },
      },
      estimateText: () => {
        throw new Error('estimate boom')
      },
      queue: {
        peek: () => undefined,
        set: () => {
          throw new Error('queue set boom')
        },
        clear: () => {},
      },
      usage: {
        last: () => ({ input: 1, cacheRead: 1, output: 1 }),
        markSubstituted: () => {
          throw new Error('usage boom')
        },
      },
    },
  })
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })

  const res = await runPost(env.host, 'TRIGGER', decision)

  assert.equal(res, decision)
})

test('O12 无 agent 时 next() 只调一次并写 skip:no-scope（计划第五条）', async () => {
  const env = setup()
  const res = await env.host.callHook(
    'tools/post-execute',
    [{ name: 'read', agent: undefined }, { content: [{ type: 'text', text: 'x' }] }],
    async () => ({ kind: 'accept' }),
  )
  assert.equal(res.kind, 'accept')
  assert.equal(env.host.nextCalls, 1)
  assert.ok(env.receipts.some((r) => r.code === 'skip:no-scope'))
})

test('O12 越权会话（judgement 假）整条决策链都不跑', async () => {
  let estimated = 0
  const env = setup({
    deps: {
      scope: {
        judgement: () => false,
        read: async () => ({ doc: doc({ projection: 'on' }) }),
      },
      estimateText: () => (estimated += 1, 1),
    },
  })
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })
  await runPost(env.host, 'TRIGGER')
  assert.equal(env.queue.peek(SESSION), undefined)
  assert.equal(env.receipts.length, 1)
  assert.equal(env.receipts[0]?.code, 'skip:no-scope')
  assert.equal(estimated, 0)
})

// ---------------------------------------------------------------------------
// Gate 3 review: lifecycle and measurement defects
// ---------------------------------------------------------------------------

test('I3 守卫失败后计划按回执作废：下一条回执不得复用旧计划', async () => {
  const env = setup()
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'IMPOSSIBLE')] })

  await runPost(env.host, 'TRIGGER')
  assert.ok(env.receipts.some((r) => r.code === 'no-candidate'))
  assert.equal(env.plans.has(SESSION), false, 'the considered plan must be dropped')

  // The model omitted the block; this receipt must not fire the old candidate.
  await runPost(env.host, 'TRIGGER')
  assert.equal(env.queue.peek(SESSION), undefined)
  assert.equal(env.receipts.some((r) => r.kind === 'shadow'), false)
  assert.equal(env.receipts.filter((r) => r.code === 'no-candidate').length, 1)
})

test('I2 PTC 内层回执不是 root：不决策、不入队、不写收据、不动 anchors', async () => {
  const env = setup({ doc: doc({ shadow: true, projection: 'off' }) })
  const previous = { stepId: 'root', anchors: { root: 'OLD-ANCHOR' } }
  env.anchors.set(SESSION, previous)
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })
  const innerAgent = { session: { header: { id: SESSION, cwd: '/w' } } }

  const res = await runPost(
    env.host,
    'TRIGGER',
    { kind: 'accept' },
    { parent: { token: 'outer-step' }, agent: innerAgent },
  )

  assert.equal(res.kind, 'accept')
  assert.equal(env.queue.peek(SESSION), undefined)
  assert.equal(env.receipts.length, 0, 'an inner result is not a decision receipt')
  assert.deepEqual(env.anchors.get(SESSION), previous, 'anchors belong to the outer step')
  assert.ok(env.plans.get(SESSION), 'an inner receipt must not consume the outer plan')
  assert.equal(env.deps.sessionState.receiptsFor(SESSION, 1).size, 0, 'no root receipt is filed')

  // The following outer receipt still decides normally.
  await runPost(env.host, 'TRIGGER')
  assert.ok(env.receipts.some((r) => r.kind === 'shadow' && r.decision === 'commit'))
})

test('I3 被 pre-execute 拒绝的替换调用在 post-execute 清 pending（无 dispatch 映射）', async () => {
  const env = setup()
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })

  await runPost(env.host, 'TRIGGER')
  const entry = env.queue.peek(SESSION)
  assert.ok(entry)

  // A denied substituted call never reaches tools/execute, so this post-execute
  // is the only place that can see the matching callId.
  await runPost(env.host, 'Error: approval denied', { kind: 'accept' }, { callId: entry.callId })

  assert.equal(env.queue.peek(SESSION), undefined, 'the denied dispatch must not survive')
})

test('I4 receipts.stopped()：替换在 selector/准入/预算之前 fail-closed', async () => {
  let selectorCalls = 0
  const receipts: Any[] = []
  const env = setup({
    deps: {
      receipts: {
        append: async (r: Any) => {
          receipts.push(r)
        },
        stopped: () => true,
      },
      llm: {
        stream: async function* () {
          selectorCalls += 1
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      selectorRoute: () => ({ provider: 'p', model: 'm' }),
    },
  })
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [candidate('A', 'TRIGGER'), candidate('B', 'TRIGGER')],
  })

  await runPost(env.host, 'TRIGGER')

  assert.equal(selectorCalls, 0, 'a stopped receipt store must not pay for a selector call')
  assert.equal(env.deps.budget.count(), 0, 'a stopped store must not spend budget')
  assert.equal(env.deps.usage.pendingCandidateId(), undefined)
  assert.equal(env.queue.peek(SESSION), undefined)
  assert.equal(receipts.length, 0, 'no receipt can be recorded while the store is stopped')
})

test('I5 projection 收据带 preview 与 args：同 tool/同 turn 的不同调用 hash 不同', async () => {
  const text = 'x'.repeat(4000)
  const env = setup({ doc: doc({ projection: 'shadow' }) })

  await runPost(
    env.host,
    text,
    { kind: 'accept' },
    { callId: 'call-a', arguments: { file_path: '/a' } },
  )
  await runPost(
    env.host,
    text,
    { kind: 'accept' },
    { callId: 'call-b', arguments: { file_path: '/b' } },
  )

  const projections = env.receipts.filter((r) => r.code === 'projection-shadow')
  assert.equal(projections.length, 2)
  const expectedPreview = Array.from(text).slice(0, 256).join('')
  for (const projection of projections) {
    assert.equal(projection.preview, expectedPreview, 'preview is the canonical receipt head')
  }
  assert.deepEqual(projections[0].args, { file_path: '/a' })
  assert.deepEqual(projections[1].args, { file_path: '/b' })
  assert.notEqual(
    receiptHash(projections[0]),
    receiptHash(projections[1]),
    'args must distinguish two calls of the same tool in one turn',
  )
})

test('I5 shadow commit 收据带 preview 与绑定后的 args', async () => {
  const env = setup({ doc: doc({ shadow: true, projection: 'off' }) })
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })

  await runPost(env.host, 'TRIGGER', { kind: 'accept' }, { arguments: { file_path: '/exec' } })

  const shadow = env.receipts.find((r) => r.kind === 'shadow' && r.code === 'ok')
  assert.ok(shadow)
  assert.deepEqual(shadow.args, { file_path: '/x' }, 'args are the bound decision tree')
  assert.equal(shadow.preview, 'TRIGGER')
})

test('I10 projection_unknown_tools 只计装饰名（mcp__*），普通未配置工具不冒充 mapper gap', async () => {
  const counters = new ProjectionCounters()
  const env = setup({
    doc: doc({ projection: 'shadow' }),
    deps: { projectionCounters: counters },
  })

  await runPost(env.host, 'x'.repeat(4000), { kind: 'accept' }, { name: 'edit' })
  assert.equal(counters.unknownFamilies(), 0, 'edit is a by-design pass, not a mapper gap')

  await runPost(env.host, 'y'.repeat(4000), { kind: 'accept' }, { name: 'mcp__custom__do-thing' })
  assert.equal(counters.unknownFamilies(), 1)
  assert.deepEqual(counters.unknownToolCounts(), { 'mcp__custom__do-thing': 1 })
})

test('I10 selector 调用抛错记 selector-error，而不是 selector-abstain(error)', async () => {
  const env = setup({
    deps: {
      llm: {
        stream: async function* () {
          throw new Error('selector boom')
        },
      },
      selectorRoute: () => ({ provider: 'p', model: 'm' }),
    },
  })
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [candidate('A', 'TRIGGER'), candidate('B', 'TRIGGER')],
  })

  await runPost(env.host, 'TRIGGER')

  const error = env.receipts.find((r) => r.code === 'selector-error')
  assert.ok(error, 'a throwing selector call is a selector-error, not an abstention')
  assert.equal(error.kind, 'skip')
  assert.equal(env.receipts.some((r) => r.code === 'selector-abstain'), false)
})

// ---------------------------------------------------------------------------
// Mutation re-review: each test below must redden when its fix is removed
// ---------------------------------------------------------------------------

test('M1 stopped 早退也清计划：库恢复后旧计划不得驱动后续回执', async () => {
  const env = setup()
  let stopped = true
  // The store keeps recording, it only reports that it is not writing.
  env.deps.receipts.stopped = () => stopped
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'TRIGGER')] })

  await runPost(env.host, 'TRIGGER')
  assert.equal(
    env.plans.has(SESSION),
    false,
    'the plan belongs to this receipt alone; a stopped store cannot use it, so it must be consumed',
  )

  stopped = false
  await runPost(env.host, 'TRIGGER')
  assert.equal(env.queue.peek(SESSION), undefined, 'the recovered store must not consume the earlier plan')
  assert.equal(env.receipts.some((r) => r.kind === 'shadow'), false)
  assert.equal(env.receipts.some((r) => r.code === 'no-candidate'), false)
})

test('M3 stopped 检查先于准入：停止的库上不读准入计量', async () => {
  let lastCalls = 0
  const env = setup({
    deps: {
      receipts: {
        append: async () => {},
        stopped: () => true,
      },
      selectorRoute: () => ({ provider: 'p', model: 'm' }),
      llm: {
        stream: async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    },
  })
  // `admittedFor` has exactly one measurement: `savedTokensOf` -> `usage.last`.
  // A deps-level spy there observes admission having been entered, which the
  // queue/budget/selector assertions cannot while the store is stopped.
  const usage = env.deps.usage
  const realLast = usage.last.bind(usage)
  usage.last = () => {
    lastCalls += 1
    return realLast()
  }
  env.plans.set(SESSION, {
    goal: 'g',
    steps: [candidate('A', 'TRIGGER'), candidate('B', 'TRIGGER')],
  })

  await runPost(env.host, 'TRIGGER')

  assert.equal(lastCalls, 0, 'admission must not run on a stopped store')
  assert.equal(env.deps.budget.count(), 0)
  assert.equal(env.queue.peek(SESSION), undefined)
})

test('M4 两次 read 的 projection-retrieval 收据 preview/args 必须可区分', async () => {
  const retrievals = new RetrievalLedger()
  retrievals.record(SESSION, '/spill/a')
  retrievals.record(SESSION, '/spill/b')
  const env = setup({ deps: { retrievals } })

  await runPost(
    env.host,
    'alpha retrieval body',
    { kind: 'accept' },
    { callId: 'read-a', arguments: { file_path: '/spill/a' } },
  )
  await runPost(
    env.host,
    'beta retrieval body',
    { kind: 'accept' },
    { callId: 'read-b', arguments: { file_path: '/spill/b' } },
  )

  const receipts = env.receipts.filter((r) => r.code === 'projection-retrieval')
  assert.equal(receipts.length, 2, 'both reads retrieve a projected artifact')
  assert.equal(receipts[0].locator, '/spill/a')
  assert.equal(receipts[1].locator, '/spill/b')
  assert.equal(receipts[0].preview, 'alpha retrieval body')
  assert.equal(receipts[1].preview, 'beta retrieval body')
  assert.deepEqual(receipts[0].args, { file_path: '/spill/a' })
  assert.deepEqual(receipts[1].args, { file_path: '/spill/b' })
  assert.notEqual(
    receiptHash(receipts[0]),
    receiptHash(receipts[1]),
    'two same-tool same-turn retrievals must not hash identically',
  )
})

test('M6 投影前重读 live scope：装配后禁用的 workspace 不得投影', async () => {
  let saves = 0
  const env = setup({
    // The judgement cache says visible (assembly happened before the disable);
    // the live document no longer lists the workspace.
    doc: doc({ mode: 'selected', workspaceIds: [], projection: 'on' }),
    deps: {
      spill: {
        saveText: async () => {
          saves += 1
          return { locator: '/spill/read.txt', retrievalHint: 'read it' }
        },
      },
      hasSpillNotice: () => false,
    },
  })
  env.plans.set(SESSION, { goal: 'g', steps: [candidate('A', 'IMPOSSIBLE')] })

  const res = await runPost(
    env.host,
    'x'.repeat(4000),
    { kind: 'accept' },
    { arguments: { file_path: '/big' } },
  )

  assert.equal(saves, 0, 'a disabled workspace must not spill the receipt')
  assert.equal(Object.hasOwn(res, 'content'), false, 'the decision must stay untouched')
  assert.equal(
    env.receipts.some((r) => r.kind === 'projection' || r.kind === 'shadow'),
    false,
    'no projection accounting for a workspace the live document excludes',
  )
})

test('M5 estimateKind 只有 host/unknown：chars/4 的类型关已封死', () => {
  // A type-level pin. `chars/4` was removed from `HookDeps.estimateKind` so no
  // future producer can present a fixed-density guess as a meter reading.
  // @ts-expect-error -- if the arm is re-added this directive becomes unused
  // and `npm run typecheck` fails, which is the red state for this item.
  const removed: NonNullable<HookDeps['estimateKind']> = 'chars/4'
  assert.equal(removed, 'chars/4')
})
