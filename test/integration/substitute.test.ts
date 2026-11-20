/**
 * Task 24: the five end-to-end substitution outcomes.
 *
 * Every case here starts at the shipped plugin — `plugin.apply(host, config)`
 * over the fake host, with the real `scope.json` under a temporary `$DSH_HOME`
 * and a real model route — and asserts on what the **host** observes (the
 * chunk stream, the `nextCalls`/`synthesized` counters, the selector request,
 * the receipts on disk). None of them builds a `HookDeps` by hand: that is the
 * trap Task 23c-2 closed, because unit tests over `registerHooks` stay green
 * while the shipped assembly is inert.
 *
 * The five outcomes:
 *
 * 1. success         — post-execute commits, llm/stream synthesizes the bound
 *                     call, tools/execute accepts it, and the next real
 *                     request settles the mark with measured tokens;
 * 2. guard failure   — decide() returns `no-candidate`, nothing is queued, and
 *                     the following request reaches the model;
 * 3. multi-candidate — two survivors, the selector answers `B`, and the
 *                     synthesized arguments are B's bound tree (not A's);
 * 4. admission       — a threshold the saving cannot clear refuses before the
 *                     selector is paid for;
 * 5. budget          — the ninth substitution of a turn is steps-exhausted.
 *
 * One deeper question no unit test can answer is pinned at the bottom: the
 * `reasoning` sibling Task 23a added is assembled into the durable assistant
 * turn, but on this host build that turn has no `replayState`, so the pi-ai
 * adapter takes its `foreignAssistant` path and pi-ai's `transformMessages`
 * drops the thinking block. The test feeds the real `synthesizeTurn` through
 * the real `BlockAssembler`, then (when the host's pi-ai packages are
 * reachable) through the real `transformMessages`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as plugin from '../../src/index.ts'
import { callIdFor } from '../../src/hooks/pending.ts'
import type { PendingEntry } from '../../src/hooks/pending.ts'
import { synthesizeTurn } from '../../src/hooks/synthesize.ts'
import { ReceiptStore } from '../../src/receipts/store.ts'
import { SELECTOR_PURPOSE } from '../../src/selector/jev.ts'
import { fakeHost } from '../fakes/host.ts'

const SESSION = 's1'
const WORKSPACE = 'w1'
const CWD = '/w'
const ROUTE = { provider: 'p', model: 'm' }

const agent = { session: { header: { id: SESSION, cwd: CWD } } }

type Any = any

/** The visible scope document the test writes to disk. */
function scopeDoc(revision: number): Any {
  return {
    version: 2,
    revision,
    mode: 'selected',
    workspaceIds: [WORKSPACE],
    shadow: false,
    projection: 'off',
  }
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

type Integration = {
  host: Any
  dir: string
  state: {
    main: StreamChunk[]
    selector: StreamChunk[]
    selectorRequests: Any[]
  }
  dispose: () => Promise<void>
}

/**
 * The real plugin over the fake host.
 *
 * `get('workspaceRegistry')` is the synchronous `list()` shape the host
 * publishes; `llm.stream` separates the plugin's selector request by `purpose`
 * and records it, so "the selector was not paid for" is observable. The data
 * root is the real `$DSH_HOME/boost`, written before `apply` reads it.
 */
async function createIntegration(options: { config?: Any } = {}): Promise<Integration> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-substitute-'))
  const root = join(dir, 'boost')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'scope.json'), `${JSON.stringify(scopeDoc(0))}\n`, 'utf8')

  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir

  const state: Integration['state'] = { main: [], selector: [], selectorRequests: [] }
  const registry = { list: () => [{ id: WORKSPACE, path: CWD }] }
  // `llm` is a soft service: the selector reaches it through `ctx.get`, so the
  // fake must expose the same object both ways (a real cordis context does).
  const llm = {
    stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      if (request.purpose === SELECTOR_PURPOSE) {
        state.selectorRequests.push(request)
        return streamOf(state.selector)
      }
      return streamOf(state.main)
    },
  }
  const host = fakeHost({
    get(name: string) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'llm') return llm
      // Substitution is now gated on the token meter (design §9); the shipped
      // `dsh-base` profile loads `dsh-token-meter`, so this is the realistic
      // host these end-to-end paths run on.
      if (name === 'tokenMeter') {
        return {
          estimateMessage(message: Any): number {
            return Math.ceil(String(message.content[0].text).length / 4) + 8
          },
        }
      }
      return undefined
    },
    llm,
  })
  plugin.apply(host, { stepsPerTurn: 8, ...(options.config ?? {}) })

  return {
    host,
    dir,
    state,
    async dispose(): Promise<void> {
      await rm(dir, { recursive: true, force: true })
      if (savedHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedHome
    },
  }
}

/** Drive one host model request through `agent/request` and then `llm/stream`. */
async function modelStep(
  a: Integration,
  turn: number,
  step: number,
  chunks: readonly StreamChunk[],
  messages: Any[] = [],
): Promise<StreamChunk[]> {
  await a.host.callHook(
    'agent/request',
    [{ agent, turn, step, signal: new AbortController().signal }],
    async () => ({ ...ROUTE }),
  )
  a.state.main = [...chunks]
  a.host.nextCalls = 0
  return collect(a.host.stream(SESSION, { messages }))
}

/** Run one `tools/post-execute` listener pass (the host's waterfall shape). */
async function postExecute(a: Integration, callId: string, text: string): Promise<Any> {
  return a.host.callHook(
    'tools/post-execute',
    [
      { name: 'read', callId, agent },
      { content: [{ type: 'text', text }] },
    ],
    async () => ({ kind: 'accept' }),
  )
}

/** Run one `tools/execute` listener pass; `next()` is the real tool. */
async function dispatch(a: Integration, callId: string, args: Any): Promise<Any> {
  return a.host.callHook(
    'tools/execute',
    [{ name: 'read', arguments: args, callId, agent }],
    async () => ({ ok: true }),
  )
}

/** Read the receipts the real assembly appended under its temporary data root. */
async function receiptsOf(a: Integration): Promise<Any[]> {
  const store = new ReceiptStore(join(a.dir, 'boost'))
  const out: Any[] = []
  for await (const receipt of store.scan(SESSION)) out.push(receipt)
  return out
}

function toolCall(chunks: readonly StreamChunk[]): Any | undefined {
  return chunks.find((chunk) => chunk.type === 'tool-call-delta')
}

// ---------------------------------------------------------------------------
// 1. Success: synthesize, dispatch, then settle with measured tokens
// ---------------------------------------------------------------------------

test('success: the bound call is synthesized and the next request settles it', async (t) => {
  const a = await createIntegration()
  t.after(() => a.dispose())

  // The host's numbers are non-default on purpose: the call id must use them.
  const turn = 2
  const step = 3
  const callId = callIdFor(SESSION, turn, step, 'B')

  // A one-step plan binding its argument from the receipt that just arrived.
  await modelStep(a, turn, step, [
    {
      type: 'text-delta',
      index: 0,
      text: planText([
        {
          id: 'B',
          tool: 'read',
          args: { file_path: { $public: { after: 'root', field: '$scalar' } } },
          guards: [{ text_contains: 'BOUND' }],
        },
      ]),
    },
    {
      type: 'usage',
      usage: { inputTokens: 40_000, cacheReadTokens: 40_000, outputTokens: 1 },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ])

  await postExecute(a, 'root-call', 'BOUND-ARGS')

  const chunks = await modelStep(a, turn, step + 1, [], anchorMessages('BOUND-ARGS'))
  assert.equal(a.host.nextCalls, 0, 'a committed substitution must not call the model')
  assert.equal(a.host.synthesized, 1, 'the host must see one synthesized turn')

  const delta = toolCall(chunks)
  assert.ok(delta, 'the synthesized turn must carry a tool-call-delta')
  assert.equal(delta.id, callId, 'the call id must carry the host turn/step')
  assert.equal(delta.name, 'read')
  assert.equal(
    delta.argumentsDelta,
    JSON.stringify({ file_path: 'BOUND-ARGS' }),
    'argumentsDelta must be the decision’s bound args, not the $public template',
  )
  assert.equal(
    delta.argumentsDelta.includes('$public'),
    false,
    'the plan template must never reach a tool call',
  )
  assert.ok(
    chunks.some((chunk) => chunk.type === 'reasoning-delta'),
    'the synthesized turn still carries the reasoning sibling Task 23a added',
  )

  let receipts = await receiptsOf(a)
  const substitute = receipts.find((receipt) => receipt.kind === 'substitute')
  assert.ok(substitute, 'synthesis must file a substitute receipt')
  assert.equal(substitute.code, 'substituted')
  assert.equal(substitute.candidateId, 'B')
  assert.equal(substitute.callId, callId)
  assert.equal(substitute.saved_input_tokens, 'unknown', 'no measurement exists yet')

  // The host dispatches what it saw; the execute hook accepts it, and the
  // following post-execute files the candidate receipt.
  const accepted = await dispatch(a, callId, { file_path: 'BOUND-ARGS' })
  assert.deepEqual(accepted, { ok: true }, 'the matching dispatch must reach the real tool')
  await postExecute(a, callId, 'BOUND-ARGS')

  // The next real request is the settlement point: input + cacheRead is the
  // measured saving the substitution bought.
  const after = await modelStep(a, turn, step + 2, [
    {
      type: 'usage',
      usage: { inputTokens: 321, cacheReadTokens: 123, outputTokens: 7 },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(a.host.nextCalls, 1, 'the settlement request is a real model request')
  assert.equal(after.some((chunk) => chunk.type === 'tool-call-delta'), false)

  receipts = await receiptsOf(a)
  const settled = receipts.find((receipt) => receipt.kind === 'substitute-settled')
  assert.ok(settled, 'the following real request must write substitute-settled')
  assert.equal(settled.code, 'substitute-settled')
  assert.equal(settled.candidateId, 'B')
  assert.equal(settled.saved_input_tokens, 444, 'saved = input + cacheRead of the next request')
  assert.equal(settled.output_tokens, 7)
  assert.equal(typeof settled.cache_hit_delta, 'number')
})

// ---------------------------------------------------------------------------
// 2. Guard failure: no synthesis, nothing queued, the real code is recorded
// ---------------------------------------------------------------------------

test('guard failure: no synthesis, no pending entry, and the real code is recorded', async (t) => {
  const a = await createIntegration()
  t.after(() => a.dispose())

  await modelStep(a, 1, 0, [
    {
      type: 'text-delta',
      index: 0,
      text: planText([
        {
          id: 'B',
          tool: 'read',
          args: { file_path: '/x' },
          guards: [{ text_contains: 'NEVER-ARRIVES' }],
        },
      ]),
    },
    {
      type: 'usage',
      usage: { inputTokens: 100_000, cacheReadTokens: 100_000, outputTokens: 1 },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ])

  await postExecute(a, 'root-call', 'ARRIVED')

  // decide() really emits `no-candidate` for a failed guard (gate/decide.ts
  // `resolve`: zero survivors -> fallback('no-candidate')). The receipt must
  // carry that string, not one invented by the test.
  let receipts = await receiptsOf(a)
  const skip = receipts.find((receipt) => receipt.kind === 'skip')
  assert.ok(skip, 'a guard failure must be auditable')
  assert.equal(skip.code, 'no-candidate')
  assert.equal(
    receipts.some((receipt) => receipt.kind === 'substitute'),
    false,
    'a failed guard must not synthesize',
  )

  // Nothing is parked: a dispatch carrying the id the commit *would* have used
  // is an ordinary call and must pass straight through to `next()`.
  const wouldBeCallId = callIdFor(SESSION, 1, 0, 'B')
  const passed = await dispatch(a, wouldBeCallId, { file_path: '/x' })
  assert.deepEqual(passed, { ok: true }, 'no pending entry may exist after a guard failure')

  const chunks = await modelStep(a, 1, 1, [])
  assert.equal(a.host.nextCalls, 1, 'the model must answer the turn')
  assert.equal(a.host.synthesized, 0)
  assert.equal(toolCall(chunks), undefined)

  receipts = await receiptsOf(a)
  assert.equal(receipts.filter((receipt) => receipt.kind === 'skip').length, 1)
})

// ---------------------------------------------------------------------------
// 3. Multi-candidate: the selector chooses B and B's bound args are dispatched
// ---------------------------------------------------------------------------

test('multi-candidate: selector B is synthesized with B’s bound args', async (t) => {
  const a = await createIntegration()
  t.after(() => a.dispose())

  await modelStep(a, 1, 0, [
    {
      type: 'text-delta',
      index: 0,
      text: planText([
        {
          id: 'A',
          tool: 'read',
          args: { file_path: '/a-literal' },
          guards: [{ text_contains: 'BOUND' }],
        },
        {
          id: 'B',
          tool: 'read',
          args: { file_path: { $public: { after: 'root', field: '$scalar' } } },
          guards: [{ text_contains: 'BOUND' }],
        },
      ]),
    },
    {
      type: 'usage',
      usage: { inputTokens: 100_000, cacheReadTokens: 100_000, outputTokens: 1 },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ])

  a.state.selector = [
    { type: 'text-delta', index: 0, text: 'B' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  await postExecute(a, 'root-call', 'BOUND-B')

  assert.equal(a.state.selectorRequests.length, 1, 'two survivors must pay exactly one selector')
  assert.equal(a.state.selectorRequests[0].purpose, SELECTOR_PURPOSE)

  const chunks = await modelStep(a, 1, 1, [], anchorMessages('BOUND-B'))
  assert.equal(a.host.nextCalls, 0)
  assert.equal(a.host.synthesized, 1)

  const delta = toolCall(chunks)
  assert.ok(delta)
  // A's literal would be `/a-literal`; only a selector-aware commit can produce
  // the bound value, and the exact text (not just the tool name) is asserted.
  assert.equal(delta.argumentsDelta, JSON.stringify({ file_path: 'BOUND-B' }))
  assert.equal(delta.id, callIdFor(SESSION, 1, 0, 'B'), 'the id must name the chosen candidate')
})

// ---------------------------------------------------------------------------
// 4. Admission refusal: refuse before the selector is paid for
// ---------------------------------------------------------------------------

test('admission refusal: no selector call, no synthesis, refusal recorded', async (t) => {
  // A threshold no saving can clear: 200k measured against 1M.
  const a = await createIntegration({ config: { admission: { thresholdTokens: 10 ** 6 } } })
  t.after(() => a.dispose())

  await modelStep(a, 1, 0, [
    {
      type: 'text-delta',
      index: 0,
      text: planText([
        {
          id: 'A',
          tool: 'read',
          args: { file_path: '/a' },
          guards: [{ text_contains: 'ARRIVED' }],
        },
        {
          id: 'B',
          tool: 'read',
          args: { file_path: '/b' },
          guards: [{ text_contains: 'ARRIVED' }],
        },
      ]),
    },
    {
      type: 'usage',
      usage: { inputTokens: 100_000, cacheReadTokens: 100_000, outputTokens: 1 },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ])

  await postExecute(a, 'root-call', 'ARRIVED')

  assert.equal(a.state.selectorRequests.length, 0, 'admission must refuse before choose() is paid')
  const receipts = await receiptsOf(a)
  const refusal = receipts.find((receipt) => receipt.kind === 'skip')
  assert.ok(refusal, 'the refusal must be recorded')
  assert.equal(refusal.code, 'not-admitted')
  assert.equal(
    receipts.some((receipt) => receipt.kind === 'substitute'),
    false,
  )

  const chunks = await modelStep(a, 1, 1, [])
  assert.equal(a.host.nextCalls, 1, 'the model must answer the turn')
  assert.equal(a.host.synthesized, 0)
  assert.equal(toolCall(chunks), undefined)
})

// ---------------------------------------------------------------------------
// 5. Budget exhaustion: the ninth substitution of one turn
// ---------------------------------------------------------------------------

test('budget exhaustion: the ninth substitution is refused with steps-exhausted', async (t) => {
  const a = await createIntegration({ config: { stepsPerTurn: 8 } })
  t.after(() => a.dispose())

  // Eight full substitutions in one turn: seed the plan, commit at
  // post-execute, synthesize the next request, dispatch, and file the executed
  // candidate. Each synthesized turn is one substitute receipt, so the budget
  // spend is observable, not inferred.
  let step = 0
  for (let index = 0; index < 8; index += 1) {
    const id = String.fromCharCode(65 + index) // plan candidate ids are A-Z
    const path = `/c${index}`
    const planStep = step
    await modelStep(a, 1, planStep, [
      {
        type: 'text-delta',
        index: 0,
        text: planText([
          { id, tool: 'read', args: { file_path: path }, guards: [{ text_contains: 'RESULT' }] },
        ]),
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await postExecute(a, `root-${index}`, 'RESULT')
    step += 1

    const callId = callIdFor(SESSION, 1, planStep, id)
    const synthesized = await modelStep(a, 1, step, [], anchorMessages('RESULT'))
    step += 1
    assert.equal(toolCall(synthesized)?.id, callId, `substitution ${index + 1} must synthesize`)

    assert.deepEqual(await dispatch(a, callId, { file_path: path }), { ok: true })
    await postExecute(a, callId, 'RESULT')
  }

  const commits = (await receiptsOf(a)).filter((receipt) => receipt.kind === 'substitute')
  assert.equal(commits.length, 8, 'the first eight substitutions must have committed')

  // The ninth plan is well-formed and admissible by itself; only the budget is
  // spent. It must not reach the queue.
  await modelStep(a, 1, step, [
    {
      type: 'text-delta',
      index: 0,
      text: planText([
        { id: 'Z', tool: 'read', args: { file_path: '/d' }, guards: [{ text_contains: 'RESULT' }] },
      ]),
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  step += 1
  await postExecute(a, 'root-8', 'RESULT')

  const receipts = await receiptsOf(a)
  const exhausted = receipts.find((receipt) => receipt.kind === 'skip' && receipt.code === 'steps-exhausted')
  assert.ok(exhausted, 'the ninth substitution must record steps-exhausted')
  assert.equal(
    receipts.filter((receipt) => receipt.kind === 'substitute').length,
    8,
    'the ninth decision must not synthesize',
  )

  a.host.synthesized = 0
  const chunks = await modelStep(a, 1, step, [])
  assert.equal(a.host.nextCalls, 1, 'the model must answer the turn')
  assert.equal(a.host.synthesized, 0)
  assert.equal(toolCall(chunks), undefined)
})

// ---------------------------------------------------------------------------
// The deeper question: does the reasoning sibling survive to the wire?
// ---------------------------------------------------------------------------

/**
 * The synthesized entry under test: exactly the shape `tools/execute` would
 * eventually dispatch, with arguments that must stay byte-identical.
 */
const SYNTH_ENTRY: PendingEntry = {
  callId: '0123456789abcdef',
  candidateId: 'B',
  name: 'read',
  args: { file_path: 'BOUND-ARGS' },
  turn: 1,
  step: 0,
}

async function assembleSynthesis(entry: PendingEntry): Promise<{ assembler: BlockAssembler; message: Any }> {
  const assembler = new BlockAssembler()
  for await (const chunk of synthesizeTurn(entry)) assembler.push(chunk)
  return {
    assembler,
    message: assembler.message({ provider: 'deepseek', model: 'deepseek-chat' }),
  }
}

type HostPiAi = {
  transformMessages: (messages: Any[], model: Any, normalizeToolCallId?: Any) => Any[]
  adapterSource: string
}

/**
 * The pi-ai transformer the installed host actually uses, when reachable.
 *
 * Neither `@deepseek-ai/dsh-llm-pi-ai` nor `@earendil-works/pi-ai` is a
 * dependency of this plugin, so a bare checkout cannot import them. The test
 * probes an explicit `DSH_HOST_NODE_MODULES` override and the harness
 * profile's `node_modules`, which is where the host build under test lives
 * (`$DSH_HOME/profiles/web/node_modules`). Missing is a skip, never a silent
 * pass: the always-on assembler test above still pins the `replayState`
 * precondition.
 */
async function loadHostPiAi(): Promise<HostPiAi | undefined> {
  const roots: string[] = []
  const configured = process.env.DSH_HOST_NODE_MODULES?.trim()
  if (configured) roots.push(configured)
  const home = process.env.DSH_HOME?.trim()
  if (home) roots.push(join(home, 'profiles', 'web', 'node_modules'))
  roots.push(join(homedir(), '.dsh', 'profiles', 'web', 'node_modules'))

  for (const root of roots) {
    const transformPath = join(root, '@earendil-works/pi-ai/dist/api/transform-messages.js')
    const adapterPath = join(root, '@deepseek-ai/dsh-llm-pi-ai/lib/index.js')
    if (!existsSync(transformPath) || !existsSync(adapterPath)) continue
    const transform = await import(pathToFileURL(transformPath).href)
    return {
      transformMessages: transform.transformMessages,
      adapterSource: await readFile(adapterPath, 'utf8'),
    }
  }
  return undefined
}

test('the assembled synthesized turn has a reasoning block but no replayState', async () => {
  const { assembler, message } = await assembleSynthesis(SYNTH_ENTRY)

  assert.deepEqual(
    assembler.blocks().map((block) => block.type),
    ['reasoning', 'tool-call'],
    'the sibling is emitted before the tool call',
  )
  assert.equal(message.role, 'assistant')
  assert.equal(message.source.kind, 'model')
  assert.equal(message.source.provider, 'deepseek')
  assert.equal(message.source.model, 'deepseek-chat')
  assert.equal(
    Object.hasOwn(message.source, 'replayState'),
    false,
    'no replay envelope exists: toPiAssistant must take the foreignAssistant branch',
  )
  assert.equal(assembler.replayState, undefined)

  const call = message.content.find((block: Any) => block.type === 'tool-call')
  assert.equal(call.id, SYNTH_ENTRY.callId)
  assert.equal(call.arguments, JSON.stringify(SYNTH_ENTRY.args))
})

test('the installed pi-ai adapter drops the thinking block from a foreign turn', async (t) => {
  const host = await loadHostPiAi()
  if (host === undefined) {
    t.skip('host pi-ai packages are not installed in this checkout')
    return
  }

  // 1. The installed adapter's branch. Both literals are load-bearing: no
  //    replayState routes to foreignAssistant, which stamps api:'dsh-foreign'.
  assert.match(
    host.adapterSource,
    /if \(source\.replayState === void 0\) return foreignAssistant\(message\)/,
    'an unreplayable assistant message must take the foreign path',
  )
  const foreignBody = host.adapterSource.slice(host.adapterSource.indexOf('function foreignAssistant'))
  assert.match(
    foreignBody.slice(0, 2_000),
    /api: "dsh-foreign"/,
    'the foreign assistant must be stamped with an api no provider route uses',
  )

  // 2. The durable turn assembled from the real chunks. `foreignAssistant`
  //    converts exactly these blocks; the mapping is repeated here because the
  //    function itself is module-private in the installed adapter.
  const { message } = await assembleSynthesis(SYNTH_ENTRY)
  const reasoning = message.content.find((block: Any) => block.type === 'reasoning')
  const call = message.content.find((block: Any) => block.type === 'tool-call')
  const foreignAssistant = {
    role: 'assistant',
    api: 'dsh-foreign',
    provider: message.source.provider,
    model: message.source.model,
    content: [
      { type: 'thinking', thinking: reasoning.text },
      { type: 'toolCall', id: call.id, name: call.name, arguments: JSON.parse(call.arguments) },
    ],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: 'toolUse',
    timestamp: 0,
  }
  const route = { provider: 'deepseek', api: 'openai-completions', id: 'deepseek-chat', input: ['text'] }
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'next' }], timestamp: 0 },
    foreignAssistant,
  ]

  // 3. The real transformer every pi-ai API calls before the wire.
  const wire = host.transformMessages(history, route, undefined)
  const sent = wire.find((entry: Any) => entry.role === 'assistant')
  assert.equal(sent.api, 'dsh-foreign')
  assert.deepEqual(
    sent.content.map((block: Any) => block.type),
    ['toolCall'],
    'the thinking sibling is dropped: the foreign api never equals the route api',
  )

  // Control: the same blocks stamped with the route's own api are kept. That
  // proves the drop is the api/provider/model mismatch, not some other filter,
  // and that a same-model replay would have carried the signature.
  const sameModel = host.transformMessages(
    [history[0], { ...foreignAssistant, api: route.api }],
    route,
    undefined,
  )
  const kept = sameModel.find((entry: Any) => entry.role === 'assistant')
  assert.deepEqual(kept.content.map((block: Any) => block.type), ['thinking', 'toolCall'])
})
