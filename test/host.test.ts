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
 * 4. `measureFixedOverhead` never fabricates a number: an unreachable estimator
 *    is `'unknown'`.
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
import { measureFixedOverhead } from '../src/admission/fixed-cost.ts'
import { recordRetrieval, RetrievalLedger } from '../src/admission/retrieval.ts'
import { loadOptional } from '../src/host/loader.ts'
import { isPosixOnly } from '../src/host/platform.ts'
import { resolveBoostRoot } from '../src/host/root.ts'
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
  warnings: string[]
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
async function createAssembly(options: { spill?: Any; tokenMeter?: Any; scope?: Any; llm?: Any } = {}): Promise<Assembly> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-host-'))
  const root = join(dir, 'boost')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'scope.json'), `${JSON.stringify(options.scope ?? scopeDoc())}\n`, 'utf8')

  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir

  let chunks: readonly StreamChunk[] = []
  const warnings: string[] = []
  const host = fakeHost({
    get(name: string) {
      if (name === 'workspaceRegistry') return { list: () => [{ id: WORKSPACE, path: CWD }] }
      if (name === 'spillStore') return options.spill
      if (name === 'tokenMeter') return options.tokenMeter
      if (name === 'llm') return options.llm
      return undefined
    },
    logger: {
      info: () => {},
      warn: (message: string) => warnings.push(message),
    },
    llm:
      options.llm ??
      {
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
    warnings,
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

// ---------------------------------------------------------------------------
// Obligation 5: retrieval detection as a predicate
// ---------------------------------------------------------------------------

test('measureFixedOverhead needs both components and never partially fabricates', async () => {
  const complete = {
    estimateSystemMessage: () => 10,
    estimateToolsTokens: () => 20,
  }
  assert.deepEqual(await measureFixedOverhead({}, 'x', (async () => complete) as never), {
    protocolTokens: 10,
    toolSchemaTokens: 20,
    totalTokens: 30,
  })

  assert.equal(
    await measureFixedOverhead({}, 'x', (async () => ({ estimateSystemMessage: () => 10 })) as never),
    'unknown',
    'the protocol alone is not the total',
  )
  assert.equal(
    await measureFixedOverhead(
      {},
      'x',
      (async () => ({ estimateSystemMessage: () => 10, estimateToolsTokens: () => Number.NaN })) as never,
    ),
    'unknown',
  )
  assert.equal(await measureFixedOverhead({}, 'x', (async () => undefined) as never), 'unknown')
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

  // Gross is one-time on the design-spelled top-level field, replay-aware on
  // the legacy `saved` object. The net replays the saved side and the retrieval
  // content, but charges the retrieval call block exactly once.
  const horizon = 20
  const expectedNet =
    (gross - retrieval.retrieval_content_tokens) * (1 + horizon) -
    retrieval.retrieval_call_tokens
  assert.equal(status.data.projection_horizon_steps, horizon)
  assert.equal(status.data.projection_gross_tokens, gross)
  assert.equal(status.data.projection_retrieval_tokens, retrieval.retrieval_tokens)
  assert.equal(status.data.projection_retrieval_content_tokens, retrieval.retrieval_content_tokens)
  assert.equal(status.data.projection_retrieval_call_tokens, retrieval.retrieval_call_tokens)
  assert.equal(status.data.projection_net_tokens, expectedNet)
  assert.equal(status.data.saved.projectionNet, expectedNet)
  assert.equal(status.data.saved.projectionGross, gross * (1 + horizon))
  assert.ok(status.data.projection_net_tokens > 0, 'a partial reread cannot flip the saving negative')
  const overhead = await measureBoostFixedOverhead()
  assert.notEqual(overhead, 'unknown')
  if (overhead === 'unknown') throw new Error('unreachable')
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
  assert.notEqual(projections[0]?.call_was_retrieval, true)

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
  const horizon = status.data.projection_horizon_steps
  const grossNonRetrieval = projections[0].saved_projection_tokens
  const expectedNet =
    (grossNonRetrieval - retrieval.retrieval_content_tokens) * (1 + horizon) -
    retrieval.retrieval_call_tokens

  assert.equal(status.data.projection_retrievals, 1)
  assert.equal(
    status.data.projection_gross_tokens,
    grossNonRetrieval,
    'the retrieval\'s own projection is not credited to gross',
  )
  assert.equal(status.data.projection_retrieval_content_tokens, retrieval.retrieval_content_tokens)
  assert.equal(status.data.projection_retrieval_call_tokens, retrieval.retrieval_call_tokens)
  assert.equal(status.data.projection_net_tokens, expectedNet)
  assert.equal(status.data.saved.projectionNet, expectedNet)
  assert.equal(status.data.saved.projectionGross, grossNonRetrieval * (1 + horizon))
})

test('the ordinary same-size re-read is a net loss, not a positive saving', async (t) => {
  const spill = recordingSpill()
  const a = await createAssembly({ spill, tokenMeter })
  t.after(() => a.dispose())

  await agentRequest(a.host)
  const text = 'a'.repeat(4_203)
  const first = await postExecute(a.host, { text, arguments: { path: '/ordinary' } })
  assert.ok(Array.isArray(first.content))

  const reread = await postExecute(a.host, {
    text,
    arguments: { path: LOCATOR },
    callId: 'same-size-reread',
  })
  assert.ok(Array.isArray(reread.content), 'the re-read is projected too')

  const receipts = await a.receipts()
  const originalProjection = receipts.find(
    (receipt) => receipt.kind === 'projection' && receipt.code === 'projected' && receipt.call_was_retrieval !== true,
  )
  const retrieval = receipts.find((receipt) => receipt.code === 'projection-retrieval')
  assert.ok(originalProjection)
  assert.ok(retrieval)
  assert.equal(retrieval.retrieval_content_tokens, Math.ceil(reread.content[0].text.length / 4) + 8)

  const status = await a.status()
  const expected =
    (originalProjection.saved_projection_tokens - retrieval.retrieval_content_tokens) *
      (1 + status.data.projection_horizon_steps) -
    retrieval.retrieval_call_tokens
  assert.equal(status.data.projection_net_tokens, expected)
  assert.ok(
    status.data.projection_net_tokens < 0,
    `the ordinary same-size re-read must be a loss: ${status.data.projection_net_tokens}`,
  )
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
  assert.equal(status.data.projection_gross_tokens, 'unknown', 'meterless projections cannot be priced')
  assert.equal(status.data.projection_net_tokens, 'unknown')
  assert.equal(status.data.estimate_kind, 'unknown')
  assert.equal(status.data.projection_retrievals, 0)
  assert.equal(status.data.projection_unpriced_projections, 1)
})

test('a throwing or non-finite meter is not a meter: substitution is refused', async (t) => {
  for (const broken of [
    { estimateMessage: () => { throw new Error('meter exploded') } },
    { estimateMessage: () => Number.NaN },
  ]) {
    const a = await createAssembly({ spill: recordingSpill(), tokenMeter: broken })
    t.after(() => a.dispose())
    await agentRequest(a.host)

    const before = await a.status()
    assert.equal(before.data.estimate_kind, 'unknown', 'a broken meter must not be labelled host')
    assert.ok(
      before.data.degraded.includes('ERR_HOST_NO_TOKENMETER'),
      `a broken meter must be reported as absent: ${JSON.stringify(before.data.degraded)}`,
    )

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
    assert.equal(
      receipts.some(
        (receipt) => receipt.kind === 'substitute' || receipt.kind === 'substitute-settled',
      ),
      false,
      'a broken meter must not commit a deterministic candidate',
    )
    assert.ok(receipts.some((receipt) => receipt.code === 'ERR_HOST_NO_TOKENMETER'))
  }
})

test('a meter that breaks after the startup probe is refused at the decision', async (t) => {
  let calls = 0
  const a = await createAssembly({
    spill: recordingSpill(),
    tokenMeter: {
      estimateMessage: () => {
        calls += 1
        return calls === 1 ? 10 : Number.NaN
      },
    },
  })
  t.after(() => a.dispose())
  await agentRequest(a.host)

  const before = await a.status()
  assert.equal(
    before.data.estimate_kind,
    'unknown',
    'status must re-probe: the meter is broken now, not when it was first resolved',
  )

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
  assert.ok(receipts.some((receipt) => receipt.code === 'ERR_HOST_NO_TOKENMETER'))
  assert.equal(
    receipts.some((receipt) => receipt.kind === 'substitute' || receipt.kind === 'substitute-settled'),
    false,
  )
})

test('estimate_kind re-probes the memoised estimator instead of keeping its first answer', async (t) => {
  const meter = {
    healthy: true,
    estimateMessage(): number {
      return meter.healthy ? 10 : Number.NaN
    },
  }
  const a = await createAssembly({ spill: recordingSpill(), tokenMeter: meter })
  t.after(() => a.dispose())

  const healthy = await a.status()
  assert.equal(healthy.data.estimate_kind, 'host')

  // The same service now answers NaN. Projection receipts describe that
  // assembly as `estimate:'unknown'`; the status label must not disagree.
  meter.healthy = false
  const broken = await a.status()
  assert.equal(broken.data.estimate_kind, 'unknown')
  assert.ok(
    broken.data.degraded.includes('ERR_HOST_NO_TOKENMETER'),
    `a meter that stopped answering must be visible: ${JSON.stringify(broken.data.degraded)}`,
  )

  // A live probe also recovers: the label is not sticky in either direction.
  meter.healthy = true
  const recovered = await a.status()
  assert.equal(recovered.data.estimate_kind, 'host')
})

// ---------------------------------------------------------------------------
// G2 (design line 71): a receipt must answer "why was the model not asked".
// ---------------------------------------------------------------------------

test('G2: the shadow receipt carries the plan goal and guards, bounded', async (t) => {
  const a = await createAssembly({
    spill: recordingSpill(),
    tokenMeter,
    scope: scopeDoc({ shadow: true }),
  })
  t.after(() => a.dispose())
  await agentRequest(a.host)

  const goal = `plan-goal:${'g'.repeat(4_000)}`
  const guards = [
    { text_not_contains: 'z'.repeat(4_000) },
    ...Array.from({ length: 29 }, () => ({ text_contains: 'ROOT' })),
  ]
  const plan = { goal, steps: [{ id: 'A', tool: 'read', args: { file_path: '/a' }, guards }] }
  a.setChunks([{ type: 'text-delta', index: 0, text: `<CHISEL_PLAN>${JSON.stringify(plan)}</CHISEL_PLAN>` }])
  await collect(a.host.stream(SESSION, {}))

  await postExecute(a.host, { text: 'ROOT-RECEIPT', arguments: { path: '/a' } })

  const receipts = await a.receipts()
  const shadow = receipts.find((receipt) => receipt.kind === 'shadow' && receipt.code === 'ok')
  assert.ok(shadow, `the shadow commit must be recorded: ${JSON.stringify(receipts)}`)

  // Goal: 256 code points including the truncation marker, and a prefix of the
  // real goal so an auditor can still recognise the plan.
  assert.equal(Array.from(shadow.plan).length, 256)
  assert.equal(shadow.plan.endsWith('…'), true)
  assert.equal(goal.startsWith(shadow.plan.slice(0, -1)), true)

  // Guards: the array is capped at 8 and says how many the plan had; the
  // multi-KB guard is carried as a marker, the ordinary ones verbatim.
  assert.equal(shadow.guards.length, 8)
  assert.equal(shadow.guards_total, 30)
  assert.deepEqual(shadow.guards[1], { text_contains: 'ROOT' })
  assert.deepEqual(Object.keys(shadow.guards[0]), ['truncated_json'])

  const line = JSON.stringify(shadow)
  assert.ok(line.length < 4_096, `a pathological plan inflated the receipt line to ${line.length}`)
})

test('G2: substitute and substitute-settled carry the same plan and guards', async (t) => {
  const a = await createAssembly({ spill: recordingSpill(), tokenMeter })
  t.after(() => a.dispose())
  await agentRequest(a.host)

  const plan = {
    goal: 'why this next call',
    steps: [
      {
        id: 'A',
        tool: 'read',
        args: { file_path: { $public: { after: 'root', field: '$scalar' } } },
        guards: [{ text_contains: 'ROOT' }],
      },
    ],
  }
  a.setChunks([{ type: 'text-delta', index: 0, text: `<CHISEL_PLAN>${JSON.stringify(plan)}</CHISEL_PLAN>` }])
  await collect(a.host.stream(SESSION, {}))

  await postExecute(a.host, { text: 'ROOT-RECEIPT', arguments: { path: '/a' } })

  a.setChunks([])
  a.host.nextCalls = 0
  const synthesized = await collect(
    a.host.stream(SESSION, {
      messages: [{ role: 'tool', content: [{ type: 'text', text: 'ROOT-RECEIPT' }] }],
    }),
  )
  const delta = synthesized.find((chunk) => chunk.type === 'tool-call-delta')
  assert.ok(delta, 'the committed substitution must synthesize a call')
  assert.equal(a.host.nextCalls, 0)

  // The host dispatches what it saw; the execute hook clears the pending entry
  // so the following real request can settle instead of abandoning at rollover.
  await a.host.callHook(
    'tools/execute',
    [{ name: 'read', arguments: { file_path: 'ROOT-RECEIPT' }, callId: delta.id, agent }],
    async () => ({ ok: true }),
  )

  let receipts = await a.receipts()
  const substitute = receipts.find((receipt) => receipt.kind === 'substitute')
  assert.ok(substitute, JSON.stringify(receipts))
  assert.equal(substitute.plan, 'why this next call')
  assert.deepEqual(substitute.guards, [{ text_contains: 'ROOT' }])

  a.setChunks([
    { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 2, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  await collect(a.host.stream(SESSION, { messages: [{ role: 'tool', content: [{ type: 'text', text: 'ROOT-RECEIPT' }] }] }))

  receipts = await a.receipts()
  const settled = receipts.find((receipt) => receipt.kind === 'substitute-settled')
  assert.ok(settled, 'the next real request settles the substitution')
  assert.equal(settled.plan, 'why this next call')
  assert.deepEqual(settled.guards, [{ text_contains: 'ROOT' }])
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
  if (overhead === 'unknown') throw new Error('unreachable')
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
  assert.equal(data.projection_unpriced_projections, 0)
  assert.equal(data.projection_unpriced_retrievals, 0)
  assert.equal(data.projection_legacy_retrievals, 0)
  assert.deepEqual(data.projection_unknown_tools, {})
})

test('status degrades with stable codes, not the internal scope-degraded label', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-status-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // A malformed document is a genuine degradation; a missing one is the clean
  // default and must stay silent (pinned in scope-store.test.ts).
  await writeFile(join(dir, 'scope.json'), '{ not json')
  const { runBoost } = await import('../src/tools/boost.ts')
  const { ScopeStore } = await import('../src/scope/store.ts')
  const r = await runBoost({ args: { cmd: 'status' }, scope: new ScopeStore(dir), receipts: new ReceiptStore(dir) })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const data = r.data as Any
  assert.deepEqual(data.degraded, ['ERR_SCOPE_PARSE_FAILED'])
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
    host: { hasTokenMeter: false, hasSpill: false },
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const degraded = (r.data as Any).degraded as string[]
  for (const code of ['ERR_HOST_NO_TOKENMETER', 'ERR_HOST_NO_SPILL']) {
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
  const measured = { protocolTokens: 379, toolSchemaTokens: 399, totalTokens: 778 }

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

test('config.dshHome 覆盖 $DSH_HOME，空白/非字符串回落到环境变量（row 75）', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/env-home'
    const absolute = join(tmpdir(), 'dsh-boost-config-home')
    assert.equal(resolveBoostRoot({ dshHome: absolute }), join(absolute, 'boost'))
    // Other host plugins resolve config.dshHome first; the plugin row's
    // override must not require changing the process environment.
    assert.equal(resolveBoostRoot({ dshHome: '   ' }), join('/tmp/env-home', 'boost'))
    assert.equal(resolveBoostRoot({ dshHome: 42 }), join('/tmp/env-home', 'boost'))
    assert.equal(resolveBoostRoot(null), join('/tmp/env-home', 'boost'))

    const relative = resolveBoostRoot({ dshHome: 'relative/config/home' })
    assert.equal(isAbsolute(relative), true)
    assert.ok(relative.endsWith(join('relative', 'config', 'home', 'boost')))

    delete process.env.DSH_HOME
    assert.equal(resolveBoostRoot({ dshHome: absolute }), join(absolute, 'boost'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
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

// ---------------------------------------------------------------------------
// Round 4: clock loans and the deprecated request event.
// ---------------------------------------------------------------------------

test('row 20: clockTurnOf refuses a shared clock lent to another session', async () => {
  const { TurnClock } = await import('../src/hooks/clock.ts')
  const { clockTurnOf } = await import('../src/hooks/session-state.ts')
  const { sessionClock } = await import('../src/hooks/llm-stream.ts')
  const clock = new TurnClock()
  clock.onModelRequest(1, 0)
  const warnings: string[] = []
  const deps: Any = { clock, logger: { warn: (message: string) => warnings.push(message) } }

  // Session A borrows the only clock; the per-session runtime is absent.
  assert.equal(sessionClock(deps, 'a'), clock)
  assert.equal(clockTurnOf(deps, 'a'), 1)
  // B must not read A's turn: a stale turn is how one session's pending
  // substitution is stamped with another session's number.
  assert.equal(clockTurnOf(deps, 'b'), undefined)
  assert.equal(warnings.length, 1, 'the refusal is still warned once')
})

test('row 22: agent/request only fills a route pre-step did not provide, and warns once', async (t) => {
  const a = await createAssembly({ spill: recordingSpill(), tokenMeter })
  t.after(() => a.dispose())

  // The non-deprecated seam carries no modelSelection, so the deprecated
  // event is the only route source: that is the compatibility path.
  await a.host.callHook(
    'agent/pre-step',
    [{ agent, turn: 1, step: 0, signal: new AbortController().signal }],
    async () => ({ kind: 'enter' }),
  )
  await agentRequest(a.host)
  await agentRequest(a.host)

  const warnings = a.warnings.filter(message => message.includes('ERR_HOST_NO_MODEL_SELECTION'))
  assert.equal(warnings.length, 1, JSON.stringify(a.warnings))
})

test('row 22: the pre-step modelSelection wins over the deprecated resolved config', async (t) => {
  const state: { main: StreamChunk[]; selectorRequests: Any[] } = { main: [], selectorRequests: [] }
  const llm = {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (options.purpose === 'boost-selector') {
        state.selectorRequests.push(options)
        return streamOf([
          { type: 'text-delta', index: 0, text: 'B' },
          { type: 'finish', reason: { kind: 'stop' } },
        ])
      }
      return streamOf(state.main)
    },
  }
  const a = await createAssembly({ spill: recordingSpill(), tokenMeter, llm })
  t.after(() => a.dispose())

  await a.host.callHook(
    'agent/pre-step',
    [
      {
        agent,
        turn: 1,
        step: 0,
        signal: new AbortController().signal,
        modelSelection: { provider: 'pre-step-provider', model: 'pre-step-model' },
      },
    ],
    async () => ({ kind: 'enter' }),
  )
  // The deprecated event resolves a different route; it must not overwrite the
  // non-deprecated capture.
  await a.host.callHook(
    'agent/request',
    [{ agent, turn: 1, step: 0, signal: new AbortController().signal }],
    async () => ({ provider: 'request-provider', model: 'request-model' }),
  )

  const plan = {
    goal: 'g',
    steps: [
      { id: 'A', tool: 'read', args: { file_path: '/a' }, guards: [{ text_not_contains: 'B-RECEIPT' }] },
      {
        id: 'B',
        tool: 'read',
        args: { file_path: { $public: { after: 'root', field: '$scalar' } } },
        guards: [{ text_contains: 'BOUND' }],
      },
    ],
  }
  state.main = [
    { type: 'text-delta', index: 0, text: `<CHISEL_PLAN>${JSON.stringify(plan)}</CHISEL_PLAN>` },
    {
      type: 'usage',
      usage: { inputTokens: 100_000, cacheReadTokens: 100_000, outputTokens: 1 },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  await collect(a.host.stream(SESSION, {}))
  await postExecute(a.host, { text: 'BOUND-VALUE', arguments: { path: '/a' }, callId: 'root' })

  assert.equal(state.selectorRequests.length, 1, 'the two-candidate plan must reach the selector')
  assert.equal(state.selectorRequests[0].provider, 'pre-step-provider')
  assert.equal(state.selectorRequests[0].model, 'pre-step-model')
  assert.equal(
    a.warnings.some(message => message.includes('ERR_HOST_NO_MODEL_SELECTION')),
    false,
    'the compatibility path must not run when pre-step supplied the route',
  )
})
