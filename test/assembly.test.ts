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

type Assembly = {
  host: Any
  dir: string
  state: {
    main: StreamChunk[]
    selector: StreamChunk[]
    selectorRequests: Any[]
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
async function createAssembly(options: { spill?: Any } = {}): Promise<Assembly> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-assembly-'))
  const root = join(dir, 'boost')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'scope.json'), `${JSON.stringify(scopeDoc(0))}\n`, 'utf8')

  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir

  const state: Assembly['state'] = { main: [], selector: [], selectorRequests: [] }
  const registry = { list: () => [{ id: WORKSPACE, path: CWD }] }
  const host = fakeHost({
    get(name: string) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'spillStore') return options.spill
      return undefined
    },
    llm: {
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (options.purpose === SELECTOR_PURPOSE) {
          state.selectorRequests.push(options)
          return streamOf(state.selector)
        }
        return streamOf(state.main)
      },
    },
  })
  plugin.apply(host, { stepsPerTurn: 8 })

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

/**
 * Seed a visible plan, run the post-execute decision and have the selector
 * choose B. Returns the deterministic call id of the queued decision.
 *
 * The request stream carries a large `usage` chunk: a two-candidate plan pays
 * the selector, so admission must see a real measured saving before it commits.
 */
async function commitB(a: Assembly): Promise<{ callId: string }> {
  await agentRequest(a.host, 1, 0)
  a.state.main = [
    { type: 'text-delta', index: 0, text: planText([CANDIDATE_A, CANDIDATE_B]) },
    { type: 'usage', usage: { inputTokens: 100_000, cacheReadTokens: 100_000, outputTokens: 1 } },
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

  return { callId: callIdFor(SESSION, 1, 0, 'B') }
}

// ---------------------------------------------------------------------------
// Obligations 2/3/4: visibility, the clock warm, and the selector's bound args
// ---------------------------------------------------------------------------

test('real apply: a visible session warms, selects B and synthesizes the bound call', async (t) => {
  const a = await createAssembly()
  t.after(() => a.dispose())

  await commitB(a)

  // The selector is the plugin's own aux request: purpose-tagged and carrying
  // the boundary request's route (captured from the agent/request waterfall).
  assert.equal(a.state.selectorRequests.length, 1, 'ask-selector must actually call the selector')
  const selectorRequest = a.state.selectorRequests[0]
  assert.equal(selectorRequest.purpose, SELECTOR_PURPOSE)
  assert.equal(selectorRequest.provider, ROUTE.provider)
  assert.equal(selectorRequest.model, ROUTE.model)

  // The next model request of the same turn must answer with B's bound args.
  await agentRequest(a.host, 1, 1)
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
  const spill = {
    saved: [] as Any[],
    async saveText(input: Any) {
      spill.saved.push(input)
      return { locator: '/spill/read-1.txt', retrievalHint: 'read it with offset/limit' }
    },
  }
  const a = await createAssembly({ spill })
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
})
