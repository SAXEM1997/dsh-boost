/**
 * Task 23c-2: the production assembly.
 *
 * This file drives the **real `apply`** over the fake host — no hand-built
 * `HookDeps` anywhere. The point is the trap the task exists to close: every
 * unit test can be green over `registerHooks` while the shipped plugin is
 * inert, because `apply` still passes `resolveSession: () => undefined`, no
 * queue, no clock and no plans. Each test here starts from
 * `plugin.apply(host, …)`, writes the real `scope.json` under a temporary
 * `$DSH_HOME`, and asserts on the chunk stream the host would consume.
 *
 * Obligations pinned:
 * 1. `deps` is hoisted, so `clearSession` reaches the state `registerHooks`
 *    publishes (the stale-receipt test is the observable proof).
 * 2. `resolveSession` answers live visibility, not just a workspace mapping:
 *    disabling the workspace between commit and synthesis passes the request
 *    through and clears the parked decision.
 * 3. `agent/request` drives the host clock and warms the visibility cache
 *    before the first `post-execute` that matters.
 * 4. `ask-selector` commits the **bound** args from the decision, never the
 *    plan's `$public` template.
 * 5. `session/disposed` reaches `clearSession` (queue and receipt-state cases).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import { callIdFor } from '../src/hooks/pending.ts'
import { ReceiptStore } from '../src/receipts/store.ts'
import { SELECTOR_PURPOSE } from '../src/selector/jev.ts'
import { fakeHost } from './fakes/host.ts'

const SESSION = 's1'
const WORKSPACE = 'w1'
const CWD = '/w'
const ROUTE = { provider: 'p', model: 'm' }

const agent = { session: { header: { id: SESSION, cwd: CWD } } }
const session = { header: { id: SESSION } }

type Any = any

/** The visible scope document the test writes to disk; revision bumps per edit. */
function scopeDoc(revision: number, workspaceIds: readonly string[] = [WORKSPACE]): Any {
  return {
    version: 2,
    revision,
    mode: 'selected',
    workspaceIds: [...workspaceIds],
    shadow: false,
    projection: 'off',
  }
}

/** Candidate A literal, candidate B copied from the root receipt. */
const CANDIDATE_A = {
  id: 'A',
  tool: 'read',
  args: { file_path: '/a' },
  // Passes on the arrival receipt, fails once B's receipt has been filed.
  guards: [{ text_not_contains: 'B-RECEIPT' }],
}

const CANDIDATE_B = {
  id: 'B',
  tool: 'read',
  args: { file_path: { $public: { after: 'root', field: '$scalar' } } },
  guards: [{ text_contains: 'BOUND' }],
}

/** Candidate C binds from B's executed receipt, which must be gone after session end. */
const CANDIDATE_C = {
  id: 'C',
  tool: 'read',
  args: { file_path: { $public: { after: 'B', field: '$scalar' } } },
  guards: [{ text_contains: 'NEW-VALUE' }],
}

/** B bound by a named field, so a long receipt can carry its value at the head. */
const LONG_CANDIDATE_B = {
  id: 'B',
  tool: 'read',
  args: { file_path: { $public: { after: 'root', field: 'name' } } },
  guards: [{ text_contains: 'BOUND' }],
}

function planText(steps: readonly Any[]): string {
  return `intro\n<CHISEL_PLAN>${JSON.stringify({ goal: 'g', steps })}</CHISEL_PLAN>\nend`
}

function streamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

/** The outgoing request bodies that carry an anchored receipt. */
function anchorMessages(text: string): Any[] {
  return [{ role: 'tool', content: [{ type: 'text', text }] }]
}

/**
 * The step's admission set, shaped like the host's `ResolvedToolSet`.
 *
 * `dsh-tools`' pipeline attaches it to every execution it builds from a model
 * step (`...toolSet === void 0 ? {} : { toolSet }`), so a real step always has
 * one. The fixture supplies the read-only trio; the dedicated row-7 test below
 * omits it on purpose.
 */
export function toolSetOf(names: readonly string[] = ['read', 'grep', 'glob']) {
  return {
    dispose: () => {},
    view: () => new Map(names.map((name) => [name, { name }])),
  }
}

/** The registered `boost` tool's status payload. */
export async function statusOf(host: Any): Promise<Any> {
  const registration = host.tools.definitions.find((entry: Any) => entry.def?.name === 'boost')
  assert.ok(registration, 'boost tool must be registered')
  const result = await registration.def.execute({ cmd: 'status' }, {})
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.data
}

type Assembly = {
  host: Any
  dir: string
  state: {
    main: StreamChunk[]
    selector: StreamChunk[]
    selectorRequests: Any[]
    tokenMeterCalls: number
  }
  setScope: (doc: Any) => Promise<void>
  dispose: () => Promise<void>
}

/**
 * Real `apply` over the fake host, with the real scope store rooted at a
 * temporary `$DSH_HOME`.
 *
 * The fake `get('workspaceRegistry')` is the host registry in the same shape
 * `@deepseek-ai/dsh-workspace` publishes: a synchronous `list()`. The fake
 * `llm.stream` separates a real request from the selector by `purpose`, and
 * records the selector's `GenerateOptions` so the test can assert the route and
 * the purpose marker the host will actually see.
 */
async function createAssembly(options: { spill?: Any; tokenMeter?: Any; config?: Any } = {}): Promise<Assembly> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-assembly-'))
  const root = join(dir, 'boost')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'scope.json'), `${JSON.stringify(scopeDoc(0))}\n`, 'utf8')

  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir

  const state: Assembly['state'] = {
    main: [],
    selector: [],
    selectorRequests: [],
    tokenMeterCalls: 0,
  }
  const registry = { list: () => [{ id: WORKSPACE, path: CWD }] }
  // A host with `dsh-token-meter` is the realistic production shape, and the
  // meter is now a substitution prerequisite (design §9). `tokenMeter: null`
  // opts out so the degradation path can be exercised explicitly.
  const tokenMeter =
    options.tokenMeter === null
      ? undefined
      : options.tokenMeter === undefined
        ? {
            estimateMessage(message: Any): number {
              state.tokenMeterCalls += 1
              return Math.ceil(String(message.content[0].text).length / 4) + 8
            },
          }
        : {
            estimateMessage(message: Any): number {
              state.tokenMeterCalls += 1
              return options.tokenMeter.estimateMessage(message)
            },
          }
  // `llm` is a soft service reached through `ctx.get`; a real cordis context
  // exposes the same object on both paths, so the fake does too.
  const llm = {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (options.purpose === SELECTOR_PURPOSE) {
        state.selectorRequests.push(options)
        return streamOf(state.selector)
      }
      return streamOf(state.main)
    },
  }
  const host = fakeHost({
    get(name: string) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'spillStore') return options.spill
      if (name === 'tokenMeter') return tokenMeter
      if (name === 'llm') return llm
      return undefined
    },
    llm,
  })
  plugin.apply(host, { stepsPerTurn: 8, ...(options.config ?? {}) })

  return {
    host,
    dir,
    state,
    async setScope(doc: Any): Promise<void> {
      await writeFile(join(root, 'scope.json'), `${JSON.stringify(doc)}\n`, 'utf8')
    },
    async dispose(): Promise<void> {
      await rm(dir, { recursive: true, force: true })
      if (savedHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedHome
    },
  }
}

/**
 * Drive one host model request through the mounted `agent/request` waterfall.
 *
 * This is the host's own clock source: turn is 1-based and one turn contains
 * several requests. The terminal `next()` returns the effective route, which
 * the assembly records for the selector call.
 */
async function agentRequest(host: Any, turn: number, step: number): Promise<Any> {
  return host.callHook(
    'agent/request',
    [{ agent, turn, step, signal: new AbortController().signal }],
    async () => ({ ...ROUTE }),
  )
}

/** Read the receipts the real assembly appended under its temporary data root. */
async function receiptsOf(a: Assembly): Promise<Any[]> {
  const store = new ReceiptStore(join(a.dir, 'boost'))
  const out: Any[] = []
  for await (const receipt of store.scan(SESSION)) out.push(receipt)
  return out
}

/**
 * Seed a visible plan, run the post-execute decision and have the selector
 * choose B. Returns the deterministic call id of the queued decision.
 *
 * The request stream carries a large `usage` chunk: a two-candidate plan pays
 * the selector, so admission must see a real measured saving before it commits.
 */
async function commitB(
  a: Assembly,
  options: {
    turn?: number
    step?: number
    inputTokens?: number
    cacheReadTokens?: number
  } = {},
): Promise<{ callId: string }> {
  const turn = options.turn ?? 1
  const step = options.step ?? 0
  await agentRequest(a.host, turn, step)
  a.state.main = [
    { type: 'text-delta', index: 0, text: planText([CANDIDATE_A, CANDIDATE_B]) },
    {
      type: 'usage',
      usage: {
        inputTokens: options.inputTokens ?? 100_000,
        cacheReadTokens: options.cacheReadTokens ?? 100_000,
        outputTokens: 1,
      },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  a.host.nextCalls = 0
  await collect(a.host.stream(SESSION, {}))

  a.state.selector = [
    { type: 'text-delta', index: 0, text: 'B' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  await a.host.callHook(
    'tools/post-execute',
    [
      { name: 'read', callId: 'root-call', agent },
      { content: [{ type: 'text', text: 'BOUND-VALUE' }] },
    ],
    async () => ({ kind: 'accept' }),
  )

  return { callId: callIdFor(SESSION, turn, step, 'B') }
}

/**
 * Seed a two-candidate plan against a long root receipt and run one
 * post-execute. The long receipt makes the selector's computed input charge
 * materially larger than the old flat 512; B binds from the named field.
 */
async function runLongPlan(a: Assembly, savedTokens: number): Promise<void> {
  await agentRequest(a.host, 1, 0)
  a.state.main = [
    { type: 'text-delta', index: 0, text: planText([CANDIDATE_A, LONG_CANDIDATE_B]) },
    {
      type: 'usage',
      usage: { inputTokens: savedTokens, cacheReadTokens: 0, outputTokens: 1 },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  await collect(a.host.stream(SESSION, {}))

  a.state.selector = [
    { type: 'text-delta', index: 0, text: 'B' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const root = `name: "BOUND-VALUE"\n${'x'.repeat(10_000)}`
  await a.host.callHook(
    'tools/post-execute',
    [{ name: 'read', callId: 'root', agent }, { content: [{ type: 'text', text: root }] }],
    async () => ({ kind: 'accept' }),
  )
}

/** A host spill double that records the canonical original it is given. */
function recordingSpill(): Any {
  const spill = {
    saved: [] as Any[],
    async saveText(input: Any) {
      spill.saved.push(input)
      return { locator: '/spill/read-1.txt', retrievalHint: 'read it with offset/limit' }
    },
  }
  return spill
}

test('row 37: the selector route is captured from agent/pre-step modelSelection', async (t) => {
  const a = await createAssembly()
  t.after(() => a.dispose())

  // Warm visibility through the real assembly seam (no agent/request yet).
  const assembly = { sections: [], contexts: [], variables: {} }
  await a.host.callHook(
    'system-prompt/assemble',
    [assembly, { agent, scope: agent }],
    async () => assembly,
  )
  // The host's non-deprecated preStep carries the captured selection.
  await a.host.callHook(
    'agent/pre-step',
    [
      { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal, modelSelection: { ...ROUTE } },
    ],
    async () => ({ kind: 'enter', messages: [] }),
  )

  a.state.main = [
    { type: 'text-delta', index: 0, text: planText([CANDIDATE_A, CANDIDATE_B]) },
    { type: 'usage', usage: { inputTokens: 100_000, cacheReadTokens: 100_000, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  await collect(a.host.stream(SESSION, {}))
  a.state.selector = [
    { type: 'text-delta', index: 0, text: 'B' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  await a.host.callHook(
    'tools/post-execute',
    [{ name: 'read', callId: 'root-call', agent }, { content: [{ type: 'text', text: 'BOUND-VALUE' }] }],
    async () => ({ kind: 'accept' }),
  )
  assert.equal(a.state.selectorRequests.length, 1, 'the multi-candidate plan must reach the selector')
  assert.equal(a.state.selectorRequests[0].provider, ROUTE.provider)
  assert.equal(a.state.selectorRequests[0].model, ROUTE.model)
})

// ---------------------------------------------------------------------------
// Obligations 2/3/4: visibility, the clock warm, and the selector's bound args
// ---------------------------------------------------------------------------

test('real apply: a visible session warms, selects B and synthesizes the bound call', async (t) => {
  const a = await createAssembly()
  t.after(() => a.dispose())

  // Non-default host numbers: the first real host step is 1, not 0, and a turn
  // can be anything. The call id must carry the host's turn/step exactly.
  const { callId } = await commitB(a, { turn: 2, step: 3 })
  assert.equal(callId, callIdFor(SESSION, 2, 3, 'B'), 'the call id must use the host turn/step')

  // The selector is the plugin's own aux request: purpose-tagged and carrying
  // the boundary request's route (captured from the agent/request waterfall).
  assert.equal(a.state.selectorRequests.length, 1, 'ask-selector must actually call the selector')
  const selectorRequest = a.state.selectorRequests[0]
  assert.equal(selectorRequest.purpose, SELECTOR_PURPOSE)
  assert.equal(selectorRequest.provider, ROUTE.provider)
  assert.equal(selectorRequest.model, ROUTE.model)

  // The next model request of the same turn must answer with B's bound args.
  await agentRequest(a.host, 2, 4)
  a.state.main = []
  a.host.nextCalls = 0
  const chunks = await collect(a.host.stream(SESSION, { messages: anchorMessages('BOUND-VALUE') }))

  assert.equal(a.host.nextCalls, 0, 'the synthesized turn must not call the real model')
  assert.equal(a.host.synthesized, 1)
  const delta = chunks.find((chunk) => chunk.type === 'tool-call-delta') as Any
  assert.ok(delta, 'the stream must carry the substituted tool call')
  assert.equal(delta.name, 'read')
  assert.deepEqual(
    JSON.parse(delta.argumentsDelta),
    { file_path: 'BOUND-VALUE' },
    'the commit must use decision.candidates[].args, already bound from root',
  )
  assert.ok(
    !delta.argumentsDelta.includes('$public'),
    'the plan template must never reach a tool call',
  )

  // The queue's call id is the host turn/step, not a default: a tampered call
  // carrying this id must be rejected. Dropping the `step` argument from
  // `onModelRequest` (or ignoring the turn change) leaves no entry under this
  // id, so the tampered call would pass through instead.
  const tampered = await a.host.callHook(
    'tools/execute',
    [{ name: 'bash', arguments: { command: 'nope' }, callId, agent }],
    async () => ({ ok: true }),
  )
  assert.equal(
    (tampered as Any).error?.info?.code,
    'dispatch-rejected',
    'the call id must carry the non-default host turn/step',
  )
})

test('turn change drops a parked decision: a constant clock cannot ship', async (t) => {
  const a = await createAssembly()
  t.after(() => a.dispose())

  const { callId } = await commitB(a, { turn: 2, step: 3 })
  assert.equal(callId, callIdFor(SESSION, 2, 3, 'B'))

  // The host starts a new turn. The parked entry belongs to turn 2; if the
  // clock ignored the turn change (or were constant), it would still match and
  // synthesize here.
  await agentRequest(a.host, 3, 1)
  a.state.main = []
  a.host.nextCalls = 0
  const chunks = await collect(a.host.stream(SESSION, { messages: anchorMessages('BOUND-VALUE') }))

  assert.equal(a.host.nextCalls, 1, 'a previous turn must not synthesize')
  assert.equal(a.host.synthesized, 0)
  assert.equal(chunks.some((chunk) => chunk.type === 'tool-call-delta'), false)
})

// ---------------------------------------------------------------------------
// Selector economics: the 512-token bound is paid before choose(), and the
// receipt handed to the selector is bounded.
// ---------------------------------------------------------------------------

test('selector admission: a saving below the computed bound + threshold makes zero selector calls', async (t) => {
  const a = await createAssembly()
  t.after(() => a.dispose())

  // 1,500 saved is already below the 1,024 threshold; the computed selector
  // charge only makes the refusal more certain.
  await commitB(a, { inputTokens: 1_500, cacheReadTokens: 0 })
  assert.equal(a.state.selectorRequests.length, 0, 'the selector must not be paid for')
  assert.equal(a.host.synthesized, 0)

  await agentRequest(a.host, 1, 1)
  a.state.main = []
  a.host.nextCalls = 0
  const chunks = await collect(a.host.stream(SESSION, { messages: anchorMessages('BOUND-VALUE') }))

  assert.equal(a.host.nextCalls, 1, 'the model must fall back')
  assert.equal(a.host.synthesized, 0)
  assert.equal(chunks.some((chunk) => chunk.type === 'tool-call-delta'), false)
  const receipts = await receiptsOf(a)
  assert.ok(
    receipts.some((receipt) => receipt.kind === 'skip' && receipt.code === 'not-admitted'),
    'the refusal must be auditable',
  )
})

test('selector admission: a saving above the computed bound + threshold pays exactly one selector call', async (t) => {
  const a = await createAssembly()
  t.after(() => a.dispose())

  // 2,000 saved clears the 1,024 threshold with room for the computed charge.
  const { callId } = await commitB(a, { inputTokens: 2_000, cacheReadTokens: 0 })
  assert.equal(a.state.selectorRequests.length, 1, 'exactly one selector call')
  assert.equal(callId, callIdFor(SESSION, 1, 0, 'B'))

  await agentRequest(a.host, 1, 1)
  a.state.main = []
  a.host.nextCalls = 0
  const chunks = await collect(a.host.stream(SESSION, { messages: anchorMessages('BOUND-VALUE') }))

  assert.equal(a.host.nextCalls, 0, 'the admitted commit must synthesize')
  assert.equal(a.host.synthesized, 1)
  const delta = chunks.find((chunk) => chunk.type === 'tool-call-delta') as Any
  assert.ok(delta)
  assert.deepEqual(JSON.parse(delta.argumentsDelta), { file_path: 'BOUND-VALUE' })
})

test('selector admission uses the computed input bound, not a flat 512', async (t) => {
  const a = await createAssembly()
  t.after(() => a.dispose())

  // 1,700 saved - the old flat 512 = 1,188 > 1,024, so the old constant would
  // have admitted and called the selector. The windowed receipt makes the
  // computed input charge larger, so the same saving must now be refused.
  await runLongPlan(a, 1_700)
  assert.equal(a.state.selectorRequests.length, 0, 'the computed charge must refuse this saving')
  const receipts = await receiptsOf(a)
  assert.ok(
    receipts.some((receipt) => receipt.kind === 'skip' && receipt.code === 'not-admitted'),
    'the refusal must be auditable',
  )

  await agentRequest(a.host, 1, 1)
  a.state.main = []
  a.host.nextCalls = 0
  const chunks = await collect(a.host.stream(SESSION, { messages: anchorMessages('BOUND-VALUE') }))
  assert.equal(a.host.nextCalls, 1, 'the model must fall back')
  assert.equal(a.host.synthesized, 0)
  assert.equal(chunks.some((chunk) => chunk.type === 'tool-call-delta'), false)
})

test('raising selector.maxTokens raises the computed selector charge', async (t) => {
  const standard = await createAssembly()
  t.after(() => standard.dispose())
  await runLongPlan(standard, 2_000)
  assert.equal(standard.state.selectorRequests.length, 1, 'the default 512 budget admits 2,000')

  const raised = await createAssembly({ config: { selector: { maxTokens: 2_000 } } })
  t.after(() => raised.dispose())
  await runLongPlan(raised, 2_000)
  assert.equal(raised.state.selectorRequests.length, 0, 'a raised budget must raise the charge')
  const receipts = await receiptsOf(raised)
  assert.ok(
    receipts.some((receipt) => receipt.kind === 'skip' && receipt.code === 'not-admitted'),
    'the raised charge must refuse the same saving',
  )
})

test('a single survivor pays no selector overhead', async (t) => {
  const a = await createAssembly()
  t.after(() => a.dispose())

  await agentRequest(a.host, 1, 0)
  a.state.main = [
    {
      type: 'text-delta',
      index: 0,
      // A is filtered by its guard; B is the only survivor, so the decision is
      // commit and there is no selector call to charge.
      text: planText([
        { id: 'A', tool: 'read', args: { file_path: '/a' }, guards: [{ text_contains: 'NEVER' }] },
        CANDIDATE_B,
      ]),
    },
    { type: 'usage', usage: { inputTokens: 1_200, cacheReadTokens: 0, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  await collect(a.host.stream(SESSION, {}))

  await a.host.callHook(
    'tools/post-execute',
    [
      { name: 'read', callId: 'root', agent },
      { content: [{ type: 'text', text: 'BOUND-VALUE' }] },
    ],
    async () => ({ kind: 'accept' }),
  )

  assert.equal(a.state.selectorRequests.length, 0, 'a single survivor has no selector call')
  await agentRequest(a.host, 1, 1)
  a.state.main = []
  a.host.nextCalls = 0
  const chunks = await collect(a.host.stream(SESSION, { messages: anchorMessages('BOUND-VALUE') }))

  assert.equal(a.host.nextCalls, 0, 'the survivor must still be admitted')
  assert.equal(a.host.synthesized, 1)
  const delta = chunks.find((chunk) => chunk.type === 'tool-call-delta') as Any
  assert.ok(delta)
  assert.deepEqual(JSON.parse(delta.argumentsDelta), { file_path: 'BOUND-VALUE' })
})

test('shadow with a non-finite host estimate records unknown, never null', async (t) => {
  const a = await createAssembly({ tokenMeter: { estimateMessage: () => Number.NaN } })
  t.after(() => a.dispose())

  await a.setScope({ ...scopeDoc(1), projection: 'shadow' })
  await agentRequest(a.host, 1, 0)
  await a.host.callHook(
    'tools/post-execute',
    [
      { name: 'read', callId: 'shadow', agent },
      { content: [{ type: 'text', text: 'x'.repeat(5_000) }] },
    ],
    async () => ({ kind: 'accept' }),
  )

  const receipts = await receiptsOf(a)
  const shadow = receipts.find((receipt) => receipt.kind === 'shadow' && receipt.code === 'projection-shadow')
  assert.ok(shadow, 'shadow mode must still write its accounting record')
  assert.equal(shadow.estimate, 'unknown')
  assert.equal(Object.hasOwn(shadow, 'before'), false)
  assert.equal(Object.hasOwn(shadow, 'after'), false)
  assert.equal(Object.hasOwn(shadow, 'saved_projection_tokens'), false)
  assert.equal(JSON.stringify(shadow).includes('null'), false)
})

test('the selector gets the head/tail window, not the full canonical receipt', async (t) => {
  const a = await createAssembly()
  t.after(() => a.dispose())

  await agentRequest(a.host, 1, 0)
  a.state.main = [
    {
      type: 'text-delta',
      index: 0,
      text: planText([
        CANDIDATE_A,
        {
          id: 'B',
          tool: 'read',
          args: { file_path: { $public: { after: 'root', field: 'name' } } },
          guards: [{ text_contains: 'BOUND' }],
        },
      ]),
    },
    { type: 'usage', usage: { inputTokens: 100_000, cacheReadTokens: 100_000, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  await collect(a.host.stream(SESSION, {}))

  a.state.selector = [
    { type: 'text-delta', index: 0, text: 'B' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const full = `name: "BOUND-VALUE"\n${'x'.repeat(10_000)}`
  await a.host.callHook(
    'tools/post-execute',
    [{ name: 'read', callId: 'root', agent }, { content: [{ type: 'text', text: full }] }],
    async () => ({ kind: 'accept' }),
  )

  assert.equal(a.state.selectorRequests.length, 1)
  const prompt = a.state.selectorRequests[0].messages[0].content[0].text as string
  assert.ok(prompt.length < 2_000, `selector prompt must be bounded, got ${prompt.length}`)
  assert.ok(prompt.includes('[selector window:'), 'the window marker must be visible')
  assert.equal(prompt.includes('x'.repeat(10_000)), false, 'the full receipt must not be sent')
})

// ---------------------------------------------------------------------------
// The cold-cache exposure gate is fail-closed, but not silent.
// ---------------------------------------------------------------------------

test('cold-cache post-execute records skip:no-scope', async (t) => {
  const a = await createAssembly()
  t.after(() => a.dispose())

  // No agentRequest: the judgement cache is cold, so the hook returns before
  // the decision chain. It still has to leave evidence for the shadow week.
  await a.host.callHook(
    'tools/post-execute',
    [{ name: 'read', callId: 'cold', agent }, { content: [{ type: 'text', text: 'COLD' }] }],
    async () => ({ kind: 'accept' }),
  )

  const receipts = await receiptsOf(a)
  const skip = receipts.find((receipt) => receipt.kind === 'skip' && receipt.code === 'skip:no-scope')
  assert.ok(skip, 'the cold path must be auditable')
  assert.equal(skip.sessionId, SESSION)
})

test('resolveSession answers live visibility: a disabled workspace passes the request through', async (t) => {
  const a = await createAssembly()
  t.after(() => a.dispose())

  await commitB(a)
  assert.equal(a.state.selectorRequests.length, 1, 'the visible commit is the precondition')

  // Disable the workspace after the commit but before the synthesized turn.
  await a.setScope(scopeDoc(1, []))

  // A model request precedes every llm/stream in the host; the warm must
  // overwrite the cached "visible" answer before the decision is read.
  await agentRequest(a.host, 1, 1)
  a.state.main = []
  a.host.nextCalls = 0
  const chunks = await collect(a.host.stream(SESSION, { messages: anchorMessages('BOUND-VALUE') }))

  assert.equal(a.host.nextCalls, 1, 'an invisible workspace must fall through to the real model')
  assert.equal(a.host.synthesized, 0)
  assert.equal(chunks.some((chunk) => chunk.type === 'tool-call-delta'), false)

  // The pass-through also clears the parked entry. Re-enabling the workspace
  // must not resurrect it: the next real request still falls through.
  await a.setScope(scopeDoc(2))
  await agentRequest(a.host, 1, 2)
  a.state.main = []
  a.host.nextCalls = 0
  const after = await collect(a.host.stream(SESSION, { messages: anchorMessages('BOUND-VALUE') }))

  assert.equal(a.host.nextCalls, 1, 'the disabled workspace must have cleared the pending entry')
  assert.equal(a.host.synthesized, 0)
  assert.equal(after.some((chunk) => chunk.type === 'tool-call-delta'), false)
})

// ---------------------------------------------------------------------------
// Obligation 5: session-end cleanup is reachable from the assembly
// ---------------------------------------------------------------------------

test('session/disposed clears the pending queue so a stale call id cannot be rejected', async (t) => {
  const a = await createAssembly()
  t.after(() => a.dispose())

  const committed = await commitB(a)
  assert.equal(a.host.hookCount('session/disposed'), 1, 'the assembly must mount session/disposed')

  await a.host.callHook('session/disposed', [session], async () => undefined)

  // A dispatch carrying the parked id but different arguments would be a
  // tamper rejection if the entry survived. After session end it is an
  // ordinary call and must pass through untouched.
  const result = await a.host.callHook(
    'tools/execute',
    [{ name: 'bash', arguments: { command: 'rm -rf /' }, callId: committed.callId, agent }],
    async () => ({ ok: true }),
  )
  assert.deepEqual(result, { ok: true }, 'the queue must be gone after session/disposed')
})

test('hoisted deps: session end drops the receipt state registerHooks published', async (t) => {
  const a = await createAssembly()
  t.after(() => a.dispose())

  const committed = await commitB(a)
  assert.equal(a.state.selectorRequests.length, 1, 'the visible commit is the precondition')

  // Execute B and file its receipt under candidate id B in the session state.
  await a.host.callHook(
    'tools/execute',
    [
      { name: 'read', arguments: { file_path: 'BOUND-VALUE' }, callId: committed.callId, agent },
    ],
    async () => ({ content: [{ type: 'text', text: 'B-RECEIPT' }] }),
  )
  await a.host.callHook(
    'tools/post-execute',
    [
      { name: 'read', callId: committed.callId, agent },
      { content: [{ type: 'text', text: 'B-RECEIPT' }] },
    ],
    async () => ({ kind: 'accept' }),
  )

  await a.host.callHook('session/disposed', [session], async () => undefined)

  // Same session id and turn after disposal (the artificial case that makes a
  // leaked map observable): a new plan's C can only bind if B's receipt
  // survived. clearSession must have dropped it.
  await agentRequest(a.host, 1, 2)
  a.state.main = [
    { type: 'text-delta', index: 0, text: planText([CANDIDATE_C]) },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  a.host.nextCalls = 0
  await collect(a.host.stream(SESSION, {}))

  await a.host.callHook(
    'tools/post-execute',
    [
      { name: 'read', callId: 'new-call', agent },
      { content: [{ type: 'text', text: 'NEW-VALUE' }] },
    ],
    async () => ({ kind: 'accept' }),
  )

  await agentRequest(a.host, 1, 3)
  a.state.main = []
  a.host.nextCalls = 0
  // Both receipts are in history: NEW-VALUE is the new root, B-RECEIPT is the
  // one a leaked state would still bind C from. With clearSession both anchors
  // are gone; with a leaked map the scheduler sees a complete anchor set and
  // synthesizes.
  const chunks = await collect(
    a.host.stream(SESSION, {
      messages: [...anchorMessages('NEW-VALUE'), ...anchorMessages('B-RECEIPT')],
    }),
  )

  assert.equal(a.host.nextCalls, 1, 'a stale B receipt would have re-committed C and synthesized')
  assert.equal(a.host.synthesized, 0)
  assert.equal(chunks.some((chunk) => chunk.type === 'tool-call-delta'), false)
})

// ---------------------------------------------------------------------------
// Obligation 6: the optional host services (spill + estimator) are wired
// ---------------------------------------------------------------------------

test('real apply projects an apply-mode receipt through the host spill backend', async (t) => {
  const spill = recordingSpill()
  // No meter: clipping still runs, but the ledger records `unknown` rather
  // than fabricating token numbers (design §9).
  const a = await createAssembly({ spill, tokenMeter: null })
  t.after(() => a.dispose())

  await a.setScope({ ...scopeDoc(1), projection: 'on' })
  await agentRequest(a.host, 1, 0)

  const text = `${'line of text\n'.repeat(2000)}END`
  const decision = await a.host.callHook(
    'tools/post-execute',
    [
      { name: 'read', callId: 'read-1', agent },
      { content: [{ type: 'text', text }] },
    ],
    async () => ({ kind: 'accept' }),
  )

  assert.equal(spill.saved.length, 1, 'apply mode must persist the canonical original')
  assert.equal(spill.saved[0].owner.sessionId, SESSION)
  assert.equal(spill.saved[0].source.toolName, 'read')
  assert.equal(spill.saved[0].content, text)
  assert.ok(Array.isArray(decision.content), 'the projected decision must replace content')
  const projected = decision.content[0].text as string
  assert.ok(projected.length < text.length, 'the projection must be shorter than the receipt')

  const receipts = await receiptsOf(a)
  const projection = receipts.find((receipt) => receipt.kind === 'projection')
  assert.ok(projection, 'apply mode must write a projection receipt')
  assert.equal(projection.estimate, 'unknown', 'no meter must never fabricate a token count')
  assert.equal(Object.hasOwn(projection, 'before'), false)
  assert.equal(Object.hasOwn(projection, 'after'), false)
  assert.equal(Object.hasOwn(projection, 'saved_projection_tokens'), false)
})

test('real apply prefers the host token meter and labels its receipt host', async (t) => {
  const spill = recordingSpill()
  const a = await createAssembly({
    spill,
    tokenMeter: {
      estimateMessage(message: Any): number {
        return Math.ceil(String(message.content[0].text).length / 4) + 8
      },
    },
  })
  t.after(() => a.dispose())

  await a.setScope({ ...scopeDoc(1), projection: 'on' })
  await agentRequest(a.host, 1, 0)
  const text = `${'line of text\n'.repeat(2000)}END`
  await a.host.callHook(
    'tools/post-execute',
    [{ name: 'read', callId: 'read-1', agent }, { content: [{ type: 'text', text }] }],
    async () => ({ kind: 'accept' }),
  )

  assert.ok(a.state.tokenMeterCalls > 0, 'the host estimator must be preferred')
  const receipts = await receiptsOf(a)
  const projection = receipts.find((receipt) => receipt.kind === 'projection')
  assert.ok(projection, 'apply mode must write a projection receipt')
  assert.equal(projection.estimate, 'host', 'the host estimator must be labelled as such')
})
