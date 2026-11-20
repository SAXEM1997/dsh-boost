/**
 * Task 25: host capability probes and the observability surface.
 *
 * These tests pin the six host-facing obligations:
 *
 * 1. `loadOptional` turns a missing optional peer into `undefined` instead of
 *    the `ERR_MODULE_NOT_FOUND` a static import would raise at load time.
 * 2. `resolveBoostRoot` is the one root rule (`$DSH_HOME`, then `~/.dsh`).
 * 3. `familyOf` is exercised through the real `apply`, because a unit test of
 *    the mapping alone cannot catch the production hook still carrying its own
 *    private copy (the silent-disable trap).
 * 4. `measureFixedCost` never fabricates a number: an unreachable estimator is
 *    `'unknown'`.
 * 5. `recordRetrieval` counts a later read of a spill locator, and the count
 *    reaches `boost status` through the production path (`apply` → projection
 *    → retrieval receipt → `status`), not through hand-built deps.
 * 6. Windows disables substitution but keeps projection on, and `status`
 *    names the reason with `ERR_HOST_PLATFORM_UNSUPPORTED`.
 *
 * The Windows case overrides `process.platform` with
 * `Object.defineProperty`. That works on this Node (the property is
 * `configurable: true`); see the task report for the mutation evidence.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import { measureFixedCost, measureFixedOverhead } from '../src/admission/fixed-cost.ts'
import { recordRetrieval, RetrievalLedger } from '../src/admission/retrieval.ts'
import { loadOptional } from '../src/host/loader.ts'
import { isPosixOnly } from '../src/host/platform.ts'
import { resolveBoostRoot } from '../src/host/root.ts'
import { PROTOCOL_TEXT } from '../src/prompt/protocol.ts'
import { ReceiptStore } from '../src/receipts/store.ts'
import { measureBoostFixedOverhead } from '../src/tools/boost.ts'
import { fakeHost } from './fakes/host.ts'

const SESSION = 's1'
const WORKSPACE = 'w1'
const CWD = '/w'
const agent = { session: { header: { id: SESSION, cwd: CWD } } }

type Any = any

/** The scope document every assembly test starts from: visible, projection on. */
function scopeDoc(overrides: Record<string, unknown> = {}): Any {
  return {
    version: 2,
    revision: 1,
    mode: 'global',
    workspaceIds: [],
    shadow: false,
    projection: 'on',
    ...overrides,
  }
}

type Assembly = {
  host: Any
  dir: string
  spill: Any
  setChunks: (chunks: readonly StreamChunk[]) => void
  setScopeDoc: (doc: Any) => Promise<void>
  status: () => Promise<Any>
  receipts: () => Promise<Any[]>
  dispose: () => Promise<void>
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

/**
 * The real `apply` over the fake host, rooted at a temporary `$DSH_HOME`.
 *
 * No hook body is called here with hand-built `HookDeps`: every assertion goes
 * through what the shipped plugin does with the host it was actually given.
 */
async function createAssembly(options: { spill?: Any; tokenMeter?: Any; scope?: Any } = {}): Promise<Assembly> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-host-'))
  const root = join(dir, 'boost')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'scope.json'), `${JSON.stringify(options.scope ?? scopeDoc())}\n`, 'utf8')

  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir

  let chunks: readonly StreamChunk[] = []
  const host = fakeHost({
    get(name: string) {
      if (name === 'workspaceRegistry') return { list: () => [{ id: WORKSPACE, path: CWD }] }
      if (name === 'spillStore') return options.spill
      if (name === 'tokenMeter') return options.tokenMeter
      return undefined
    },
    llm: {
      stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        return streamOf(chunks)
      },
    },
  })
  plugin.apply(host, {})

  return {
    host,
    dir,
    spill: options.spill,
    setChunks(next): void {
      chunks = next
    },
    async setScopeDoc(doc: Any): Promise<void> {
      await writeFile(join(root, 'scope.json'), `${JSON.stringify(doc)}\n`, 'utf8')
    },
    async status(): Promise<Any> {
      const definition = host.tools.resolve().find((entry: Any) => entry.name === 'boost')
      assert.ok(definition, 'the boost tool must be registered by apply')
      return definition.execute({ cmd: 'status' }, {})
    },
    async receipts(): Promise<Any[]> {
      const store = new ReceiptStore(root)
      const out: Any[] = []
      for await (const receipt of store.scan(SESSION)) out.push(receipt)
      return out
    },
    async dispose(): Promise<void> {
      await rm(dir, { recursive: true, force: true })
      if (savedHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedHome
    },
  }
}

/** Drive the host's own clock/visibility warm, exactly as the agent loop does. */
async function agentRequest(host: Any, turn = 1, step = 0): Promise<void> {
  await host.callHook(
    'agent/request',
    [{ agent, turn, step, signal: new AbortController().signal }],
    async () => ({ provider: 'p', model: 'm' }),
  )
}

/** One tool result through the production post-execute waterfall. */
async function postExecute(
  host: Any,
  options: { name?: string; text: string; arguments?: unknown; callId?: string },
): Promise<Any> {
  return host.callHook(
    'tools/post-execute',
    [
      {
        name: options.name ?? 'read',
        callId: options.callId ?? 'call-1',
        agent,
        arguments: options.arguments ?? { path: '/receipt' },
      },
      { content: [{ type: 'text', text: options.text }] },
    ],
    async () => ({ kind: 'accept' }),
  )
}

/** A host spill double; the locator is what a later retrieval must name. */
const LOCATOR = '/spill/read-1.txt'
function recordingSpill(): Any {
  const spill = {
    saved: [] as Any[],
    async saveText(input: Any) {
      spill.saved.push(input)
      return { locator: LOCATOR, retrievalHint: 'read it with offset/limit' }
    },
  }
  return spill
}

/** A host token meter with the fixed-density shape the plugin prices through. */
const tokenMeter = {
  estimateMessage(message: Any): number {
    return Math.ceil(String(message.content[0].text).length / 4) + 8
  },
}

// ---------------------------------------------------------------------------
// Obligation 1: optional peers load through the dynamic seam
// ---------------------------------------------------------------------------

test('loadOptional: a missing peer is undefined, an installed module is itself', async () => {
  assert.equal(await loadOptional('@deepseek-ai/definitely-not-installed'), undefined)
  const path = await loadOptional<{ join?: unknown }>('node:path')
  assert.equal(typeof path?.join, 'function')
})

// ---------------------------------------------------------------------------
// Obligation 2: one root rule
// ---------------------------------------------------------------------------

test('resolveBoostRoot: $DSH_HOME wins, unset falls back to ~/.dsh/boost', () => {
  const saved = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    const fallback = resolveBoostRoot()
    assert.ok(fallback.endsWith('.dsh/boost'), fallback)
    assert.equal(fallback, resolveBoostRoot(), 'the fallback must not depend on cwd')

    process.env.DSH_HOME = '/tmp/dsh-home-probe'
    assert.equal(resolveBoostRoot(), join('/tmp/dsh-home-probe', 'boost'))

    process.env.DSH_HOME = '   '
    assert.ok(resolveBoostRoot().endsWith('.dsh/boost'), 'a blank home is unset')
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

// ---------------------------------------------------------------------------
// Obligation 4: the fixed-cost measurement never invents a number
// ---------------------------------------------------------------------------

test('measureFixedCost prices text with the host estimator', async () => {
  const measured = await measureFixedCost(PROTOCOL_TEXT)
  assert.equal(typeof measured, 'number')
  assert.ok((measured as number) > 0, 'the protocol section is not free')
  assert.ok(Number.isInteger(measured))
})

test('measureFixedCost is unknown when the estimator is unreachable or lies', async () => {
  assert.equal(await measureFixedCost('x', async () => undefined), 'unknown')
  assert.equal(await measureFixedCost('x', async () => ({})), 'unknown')
  assert.equal(
    await measureFixedCost('x', async () => ({ estimateSystemMessage: () => Number.NaN })),
    'unknown',
  )
  assert.equal(
    await measureFixedCost('x', async () => {
      throw new Error('peer exploded')
    }),
    'unknown',
  )
})

// ---------------------------------------------------------------------------
// Obligation 5: retrieval detection as a predicate
// ---------------------------------------------------------------------------

test('measureFixedOverhead needs both components and never partially fabricates', async () => {
  const complete = {
    estimateSystemMessage: () => 10,
    estimateToolsTokens: () => 20,
  }
  assert.deepEqual(await measureFixedOverhead({}, 'x', async () => complete), {
    protocolTokens: 10,
    toolSchemaTokens: 20,
    totalTokens: 30,
  })

  assert.equal(
    await measureFixedOverhead({}, 'x', async () => ({ estimateSystemMessage: () => 10 })),
    'unknown',
    'the protocol alone is not the total',
  )
  assert.equal(
    await measureFixedOverhead(
      {},
      'x',
      async () => ({ estimateSystemMessage: () => 10, estimateToolsTokens: () => Number.NaN }),
    ),
    'unknown',
  )
  assert.equal(await measureFixedOverhead({}, 'x', async () => undefined), 'unknown')
})

test('recordRetrieval matches a locator string anywhere in the tool params', () => {
  const locators = new Set(['/spill/read-1.txt'])
  assert.equal(recordRetrieval({ path: '/spill/read-1.txt' }, locators), true)
  assert.equal(recordRetrieval({ file_path: '/spill/read-1.txt', offset: 10 }, locators), true)
  assert.equal(recordRetrieval({ options: [{ path: '/spill/read-1.txt' }] }, locators), true)
  assert.equal(recordRetrieval({ path: '/other' }, locators), false)
  assert.equal(recordRetrieval({ path: '/spill/read-1.txt.bak' }, locators), false)
  assert.equal(recordRetrieval({}, locators), false)
  assert.equal(recordRetrieval(null, locators), false)
  assert.equal(recordRetrieval({ path: '/spill/read-1.txt' }, new Set()), false)
})

// ---------------------------------------------------------------------------
// Obligation 5 (production): projection → retrieval → status
// ---------------------------------------------------------------------------

test('real apply counts a spilled receipt re-read and reports the net projection ledger', async (t) => {
  const spill = recordingSpill()
  const a = await createAssembly({ spill, tokenMeter })
  t.after(() => a.dispose())

  await agentRequest(a.host)

  const original = `${'line of text\n'.repeat(2000)}END`
  const projected = await postExecute(a.host, { text: original, arguments: { path: '/big' } })
  assert.ok(Array.isArray(projected.content), 'the oversized read must be projected')
  assert.ok(projected.content[0].text.length < original.length)
  assert.equal(spill.saved[0].content, original)

  const before = await a.receipts()
  const projection = before.find((receipt) => receipt.kind === 'projection')
  assert.ok(projection, 'the projection must be receipted')
  const gross = projection.saved_projection_tokens
  assert.equal(typeof gross, 'number')

  // The model follows the footer: a plain read of the locator. This is the only
  // writer `projection_retrievals` has, and it is reached through `apply`.
  await postExecute(a.host, {
    text: 'the omitted middle',
    arguments: { path: LOCATOR, offset: 2000 },
    callId: 'retrieval-1',
  })

  const receipts = await a.receipts()
  const retrieval = receipts.find((receipt) => receipt.code === 'projection-retrieval')
  assert.ok(retrieval, 'a read of the spill locator must be counted as a retrieval')
  assert.equal(retrieval.kind, 'projection')
  assert.equal(retrieval.retrieved, true)
  assert.equal(retrieval.locator, LOCATOR)
  assert.equal(retrieval.unit, 'raw', 'every projection-kind receipt carries the literal unit')
  assert.equal(typeof retrieval.retrieval_tokens, 'number')
  assert.ok(retrieval.retrieval_tokens > 0, 'a retrieval is never free')
  assert.equal(
    retrieval.retrieval_call_tokens + retrieval.retrieval_content_tokens,
    retrieval.retrieval_tokens,
    'the one-time retrieval figure is the sum of its two measured parts',
  )
  assert.equal(retrieval.estimate, 'host')

  const status = await a.status()
  assert.equal(status.ok, true, JSON.stringify(status))
  assert.equal(status.data.projection_retrievals, 1)
  assert.equal(status.data.saved.retrievals, 1)
  assert.equal(status.data.estimate_kind, 'host')

  // One-time and replay figures are reported separately. The net applies the
  // same (1 + horizon) factor to both sides: the saved figure is what each
  // receipt removed once, and the retrieval figure is what the read cost once.
  const horizon = 20
  const expectedNet = (gross - retrieval.retrieval_tokens) * (1 + horizon)
  assert.equal(status.data.projection_horizon_steps, horizon)
  assert.equal(status.data.projection_gross_tokens, gross)
  assert.equal(status.data.projection_retrieval_tokens, retrieval.retrieval_tokens)
  assert.equal(status.data.projection_net_tokens, expectedNet)
  assert.equal(status.data.saved.projectionNet, expectedNet)
  assert.ok(status.data.projection_net_tokens > 0, 'a partial reread cannot flip the saving negative')
  const overhead = await measureBoostFixedOverhead()
  assert.notEqual(overhead, 'unknown')
  assert.equal(status.data.fixedOverheadTokens, overhead.totalTokens)
  assert.deepEqual(status.data.fixedOverhead, overhead)
})

test('a projected retrieval is priced on the visible content, not the raw result', async (t) => {
  const spill = recordingSpill()
  const a = await createAssembly({ spill, tokenMeter })
  t.after(() => a.dispose())

  await agentRequest(a.host)

  const first = `${'a'.repeat(24_000)}END`
  const firstDecision = await postExecute(a.host, { text: first, arguments: { path: '/big-1' } })
  assert.ok(Array.isArray(firstDecision.content), 'the first receipt must be projected')

  // The retrieval itself is oversized, so apply mode projects it too. Its
  // retrieval cost must be priced on the projected text the model will see,
  // never on the raw 24 KB result (the review's I3).
  const rawRetrieval = `${'b'.repeat(24_000)}END`
  const retrievalDecision = await postExecute(a.host, {
    text: rawRetrieval,
    arguments: { path: LOCATOR },
    callId: 'retrieval-big',
  })
  assert.ok(Array.isArray(retrievalDecision.content), 'the re-read must itself be projected')
  const visible = retrievalDecision.content[0].text

  const receipts = await a.receipts()
  const projections = receipts.filter((receipt) => receipt.kind === 'projection' && receipt.code === 'projected')
  assert.equal(projections.length, 2, 'both the original and the retrieval are projected')
  const gross = projections.reduce((sum, receipt) => sum + receipt.saved_projection_tokens, 0)
  const retrieval = receipts.find((receipt) => receipt.code === 'projection-retrieval')
  assert.ok(retrieval)
  assert.equal(
    retrieval.retrieval_content_tokens,
    Math.ceil(visible.length / 4) + 8,
    'the content side prices the decision content the model actually sees',
  )
  assert.ok(
    retrieval.retrieval_tokens < Math.ceil(rawRetrieval.length / 4),
    'the raw result must not be charged',
  )

  const status = await a.status()
  assert.equal(status.data.projection_retrievals, 1)
  assert.equal(status.data.projection_gross_tokens, gross)
  assert.equal(status.data.projection_retrieval_tokens, retrieval.retrieval_tokens)
  assert.equal(
    status.data.projection_net_tokens,
    (gross - retrieval.retrieval_tokens) * (1 + status.data.projection_horizon_steps),
  )
  assert.ok(status.data.projection_net_tokens > 0, 'the double-projection case must keep the sign positive')
})

test('an ordinary read that does not name the locator is not a retrieval', async (t) => {
  const a = await createAssembly({ spill: recordingSpill(), tokenMeter })
  t.after(() => a.dispose())

  await agentRequest(a.host)
  await postExecute(a.host, { text: `${'x'.repeat(9000)}END`, arguments: { path: '/big' } })
  await postExecute(a.host, { text: 'unrelated', arguments: { path: '/elsewhere' } })

  const receipts = await a.receipts()
  assert.equal(receipts.some((receipt) => receipt.code === 'projection-retrieval'), false)
  const status = await a.status()
  assert.equal(status.data.projection_retrievals, 0)
})

// ---------------------------------------------------------------------------
// Obligation 6: Windows degrades visibly and keeps projection
// ---------------------------------------------------------------------------

test('Windows: substitution is refused with a reason, projection still applies, status names the code', async (t) => {
  const saved = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  t.after(() => Object.defineProperty(process, 'platform', { value: saved, configurable: true }))

  assert.equal(isPosixOnly(), false)
  const spill = recordingSpill()
  const a = await createAssembly({ spill, tokenMeter })
  t.after(() => a.dispose())

  const status = await a.status()
  assert.equal(status.ok, true)
  assert.ok(
    status.data.degraded.includes('ERR_HOST_PLATFORM_UNSUPPORTED'),
    `status must name the platform: ${JSON.stringify(status.data.degraded)}`,
  )

  // Seed a one-step plan that would otherwise be committed without a selector.
  await agentRequest(a.host)
  const plan = {
    goal: 'g',
    steps: [
      {
        id: 'A',
        tool: 'read',
        args: { file_path: '/a' },
        guards: [{ text_contains: 'ROOT-RECEIPT' }],
      },
    ],
  }
  a.setChunks([{ type: 'text-delta', index: 0, text: `<CHISEL_PLAN>${JSON.stringify(plan)}</CHISEL_PLAN>` }])
  await collect(a.host.stream(SESSION, {}))

  await postExecute(a.host, { text: 'ROOT-RECEIPT', arguments: { path: '/a' } })

  const receipts = await a.receipts()
  const refusal = receipts.find(
    (receipt) => receipt.code === 'substitution-unavailable' && receipt.reason === 'platform-unsupported',
  )
  assert.ok(refusal, `the refused substitution must be receipted: ${JSON.stringify(receipts)}`)
  assert.equal(
    receipts.some((receipt) => receipt.kind === 'substitute' || receipt.kind === 'substitute-settled'),
    false,
  )

  // No parked decision means the next request is not synthesized.
  a.setChunks([])
  const chunks = await collect(
    a.host.stream(SESSION, { messages: [{ role: 'tool', content: [{ type: 'text', text: 'ROOT-RECEIPT' }] }] }),
  )
  assert.equal(a.host.synthesized, 0)
  assert.equal(chunks.some((chunk) => chunk.type === 'tool-call-delta'), false)

  // Projection is not platform-gated: the same host still replaces a receipt.
  const original = `${'line of text\n'.repeat(2000)}END`
  const projected = await postExecute(a.host, { text: original, arguments: { path: '/big' } })
  assert.ok(Array.isArray(projected.content), 'projection must stay on')
  assert.ok(projected.content[0].text.length < original.length)
})

test('no token meter: substitution is refused, projection still applies with unknown estimates', async (t) => {
  const spill = recordingSpill()
  const a = await createAssembly({ spill }) // explicitly no tokenMeter service
  t.after(() => a.dispose())

  const before = await a.status()
  assert.equal(before.data.estimate_kind, 'unknown')
  assert.ok(
    before.data.degraded.includes('ERR_HOST_NO_TOKENMETER'),
    `the missing service must be named: ${JSON.stringify(before.data.degraded)}`,
  )
  assert.equal(
    before.data.degraded.includes('ERR_HOST_NO_ESTIMATOR'),
    false,
    'the estimate package is installed; only the service is missing',
  )
  assert.equal(
    typeof before.data.fixedOverheadTokens,
    'number',
    'the fixed cost is still measurable through the pure package',
  )

  // Seed a one-step plan that would be committed without a selector.
  await agentRequest(a.host)
  const plan = {
    goal: 'g',
    steps: [
      { id: 'A', tool: 'read', args: { file_path: '/a' }, guards: [{ text_contains: 'ROOT-RECEIPT' }] },
    ],
  }
  a.setChunks([{ type: 'text-delta', index: 0, text: `<CHISEL_PLAN>${JSON.stringify(plan)}</CHISEL_PLAN>` }])
  await collect(a.host.stream(SESSION, {}))

  await postExecute(a.host, { text: 'ROOT-RECEIPT', arguments: { path: '/a' } })

  const receipts = await a.receipts()
  assert.ok(
    receipts.some((receipt) => receipt.code === 'ERR_HOST_NO_TOKENMETER'),
    `the refusal must carry the stable code: ${JSON.stringify(receipts)}`,
  )
  assert.equal(
    receipts.some((receipt) => receipt.kind === 'substitute' || receipt.kind === 'substitute-settled'),
    false,
  )

  a.setChunks([])
  const chunks = await collect(
    a.host.stream(SESSION, { messages: [{ role: 'tool', content: [{ type: 'text', text: 'ROOT-RECEIPT' }] }] }),
  )
  assert.equal(a.host.synthesized, 0, 'without a meter no replacement turn may be synthesized')
  assert.equal(chunks.some((chunk) => chunk.type === 'tool-call-delta'), false)

  // Projection is not gated on the meter: clipping still happens, but its
  // ledger may not invent token numbers.
  const original = `${'line of text\n'.repeat(2000)}END`
  const projected = await postExecute(a.host, { text: original, arguments: { path: '/big' } })
  assert.ok(Array.isArray(projected.content), 'projection must stay available without a meter')
  assert.ok(projected.content[0].text.length < original.length)

  const after = await a.receipts()
  const projection = after.find((receipt) => receipt.kind === 'projection' && receipt.code === 'projected')
  assert.ok(projection)
  assert.equal(projection.estimate, 'unknown')
  assert.equal(Object.hasOwn(projection, 'before'), false)
  assert.equal(Object.hasOwn(projection, 'after'), false)
  assert.equal(Object.hasOwn(projection, 'saved_projection_tokens'), false)

  const status = await a.status()
  assert.equal(status.data.saved.substitution, 0)
  assert.equal(status.data.projection_gross_tokens, 0)
  assert.equal(status.data.estimate_kind, 'unknown')
})

// ---------------------------------------------------------------------------
// Obligation 7: status carries the measurement and only stable codes
// ---------------------------------------------------------------------------

test('status reports fixedOverheadTokens and the snake_case projection ledger', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-status-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'scope.json'), `${JSON.stringify(scopeDoc({ mode: 'selected', workspaceIds: [] }))}\n`)

  const { runBoost } = await import('../src/tools/boost.ts')
  const { ScopeStore } = await import('../src/scope/store.ts')
  const r = await runBoost({ args: { cmd: 'status' }, scope: new ScopeStore(dir), receipts: new ReceiptStore(dir) })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const data = r.data as Any
  const overhead = await measureBoostFixedOverhead()
  assert.notEqual(overhead, 'unknown')
  assert.equal(data.fixedOverheadTokens, overhead.totalTokens)
  assert.deepEqual(data.fixedOverhead, overhead)
  assert.ok(overhead.protocolTokens > 0)
  assert.ok(overhead.toolSchemaTokens > 0)
  assert.equal(overhead.totalTokens, overhead.protocolTokens + overhead.toolSchemaTokens)
  assert.ok(overhead.totalTokens <= 800, `fixed overhead must fit the design budget: ${overhead.totalTokens}`)
  assert.equal(data.estimate_kind, 'unknown', 'no host was probed in this direct call')
  assert.equal(data.projection_horizon_steps, 20)
  assert.equal(data.projection_gross_tokens, data.saved.projectionGross)
  assert.equal(data.projection_retrievals, data.saved.retrievals)
  assert.equal(data.projection_net_tokens, data.saved.projectionNet)
  assert.equal(data.projection_locator_evictions, 0)
  assert.deepEqual(data.projection_unknown_tools, {})
})

test('status degrades with stable codes, not the internal scope-degraded label', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-status-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { runBoost } = await import('../src/tools/boost.ts')
  const { ScopeStore } = await import('../src/scope/store.ts')
  const r = await runBoost({ args: { cmd: 'status' }, scope: new ScopeStore(dir), receipts: new ReceiptStore(dir) })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const data = r.data as Any
  assert.deepEqual(data.degraded, ['ERR_SCOPE_READ_FAILED'])
  assert.equal(data.degraded.includes('scope-degraded'), false)
})

test('status probes the host: missing meter/spill/step-when are stable codes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-status-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'scope.json'), `${JSON.stringify(scopeDoc())}\n`)

  const { runBoost } = await import('../src/tools/boost.ts')
  const { ScopeStore } = await import('../src/scope/store.ts')
  const base = { scope: new ScopeStore(dir), receipts: new ReceiptStore(dir) }
  const r = await runBoost({
    args: { cmd: 'status' },
    ...base,
    host: { hasTokenMeter: false, hasSpill: false, supportsStepWhen: false },
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const degraded = (r.data as Any).degraded as string[]
  for (const code of ['ERR_HOST_NO_TOKENMETER', 'ERR_HOST_NO_SPILL', 'ERR_HOST_NO_STEP_WHEN']) {
    assert.ok(degraded.includes(code), `${code} missing from ${JSON.stringify(degraded)}`)
  }
  assert.equal(degraded.some((code) => !/^ERR_(HOST|SCOPE)_/.test(code)), false)
  assert.equal(new Set(degraded).size, degraded.length, 'codes are deduplicated')
})

test('status splits a missing meter service from an unreachable estimator package', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-status-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'scope.json'), `${JSON.stringify(scopeDoc())}\n`)

  const { runBoost } = await import('../src/tools/boost.ts')
  const { ScopeStore } = await import('../src/scope/store.ts')
  const base = { scope: new ScopeStore(dir), receipts: new ReceiptStore(dir) }
  const measured = { protocolTokens: 379, toolSchemaTokens: 393, totalTokens: 772 }

  const noService = await runBoost({
    args: { cmd: 'status' },
    ...base,
    host: { hasTokenMeter: false },
    fixedOverhead: async () => measured,
  })
  assert.equal(noService.ok, true)
  if (!noService.ok) return
  const noServiceCodes = (noService.data as Any).degraded as string[]
  assert.ok(noServiceCodes.includes('ERR_HOST_NO_TOKENMETER'))
  assert.equal(
    noServiceCodes.includes('ERR_HOST_NO_ESTIMATOR'),
    false,
    'the pure package still priced the overhead, so only the service is absent',
  )

  const noPackages = await runBoost({
    args: { cmd: 'status' },
    ...base,
    host: { hasTokenMeter: true },
    fixedOverhead: async () => 'unknown',
  })
  assert.equal(noPackages.ok, true)
  if (!noPackages.ok) return
  const noPackageCodes = (noPackages.data as Any).degraded as string[]
  assert.ok(noPackageCodes.includes('ERR_HOST_NO_ESTIMATOR'))
  assert.equal(noPackageCodes.includes('ERR_HOST_NO_TOKENMETER'), false)
  assert.equal((noPackages.data as Any).fixedOverheadTokens, 'unknown')
})

test('$DSH_HOME naming a file does not turn boost status into a failure', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-status-'))
  const homeFile = join(dir, 'not-a-directory')
  await writeFile(homeFile, 'x')
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = homeFile
  t.after(async () => {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await rm(dir, { recursive: true, force: true })
  })

  const { runBoost } = await import('../src/tools/boost.ts')
  const { ScopeStore } = await import('../src/scope/store.ts')
  const root = resolveBoostRoot()
  const r = await runBoost({ args: { cmd: 'status' }, scope: new ScopeStore(root), receipts: new ReceiptStore(root) })
  assert.equal(r.ok, true, JSON.stringify(r))
  if (!r.ok) return
  assert.deepEqual({ ...(r.data as Any).counts }, {})

  // The session-scoped read path must not throw either: it addresses the same
  // impossible shard directly instead of listing the directory.
  const scanned: Any[] = []
  for await (const receipt of new ReceiptStore(root).scan('s1')) scanned.push(receipt)
  assert.deepEqual(scanned, [])
})

test('relative $DSH_HOME resolves against the current cwd once, not per read', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'relative/home'
    assert.equal(isAbsolute(resolveBoostRoot()), true)
    assert.ok(resolveBoostRoot().endsWith(join('relative', 'home', 'boost')))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('locator eviction is counted instead of silently improving the net', () => {
  const ledger = new RetrievalLedger()
  for (let index = 0; index < 513; index += 1) ledger.record('s1', `/spill/${index}.txt`)
  assert.equal(ledger.evictions(), 1)
  assert.equal(ledger.hit('s1', { path: '/spill/0.txt' }), false, 'the oldest locator was evicted')
  assert.equal(ledger.hit('s1', { path: '/spill/512.txt' }), true)
})

test('status exposes locator evictions and unknown-family skips', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-status-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'scope.json'), `${JSON.stringify(scopeDoc())}\n`)

  const { runBoost } = await import('../src/tools/boost.ts')
  const { ScopeStore } = await import('../src/scope/store.ts')
  const r = await runBoost({
    args: { cmd: 'status' },
    scope: new ScopeStore(dir),
    receipts: new ReceiptStore(dir),
    locatorEvictions: () => 4,
    unknownFamilies: () => 2,
    unknownTools: () => ({ 'mcp__custom__do-thing': 2 }),
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const data = r.data as Any
  assert.equal(data.projection_locator_evictions, 4)
  assert.equal(data.projection_unknown_families, 2)
  assert.deepEqual(data.projection_unknown_tools, { 'mcp__custom__do-thing': 2 })
})

test('real apply counts a tool with no configured family and names it in status', async (t) => {
  const a = await createAssembly({ spill: recordingSpill(), tokenMeter })
  t.after(() => a.dispose())

  await agentRequest(a.host)
  await postExecute(a.host, {
    name: 'mcp__custom__do-thing',
    text: `${'x'.repeat(9000)}END`,
    arguments: { path: '/custom' },
  })

  const status = await a.status()
  assert.equal(status.data.projection_unknown_families, 1)
  assert.equal(status.data.projection_unknown_tools['mcp__custom__do-thing'], 1)
})
