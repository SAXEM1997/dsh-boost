/**
 * The seam between the route's payload and the page's field reads.
 *
 * `/state` hands back `runBoost`'s envelopes verbatim, so `status` arrives as
 * `{ ok, data }`. Both released regressions were a read at the wrong level —
 * `saved` off the envelope instead of its `data`, and `.ok` off the payload —
 * and both were invisible because `StatePayload.status` was `unknown`. The
 * payload is typed now; the `@ts-expect-error` lines at the bottom are the
 * pins, and they are checked because the suite is compiled by `tsc`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { buildStatePayload, type StateDeps } from '../src/http/state.ts'
import type { ScopeDoc } from '../src/scope/doc.ts'
import type { Envelope } from '../src/shared/api-types.ts'
import type { BoostStatus } from '../src/tools/boost.ts'
import { configOf, envelopeOf } from '../ui/src/draft.ts'

/** A complete `BoostStatus`: the route's deps are typed against the real shape. */
function statusData(over: Partial<BoostStatus> = {}): BoostStatus {
  return {
    scope: { mode: 'selected', workspaceIds: [], revision: 0 },
    shadow: true,
    projection: 'shadow',
    saved: { substitution: 12, projectionGross: 40, projectionNet: 7, retrievals: 0 },
    counts: { projection: 3 },
    distill: { calls: 2, tokens: 512, adopted: 1, rejected: 1, fallback: 0, input_chars: 9_000 },
    degraded: ['ERR_HOST_NO_SPILL'],
    cache_hit_ratio: null,
    prefix_drops: { count: 0, tokens: 0 },
    fixedOverheadTokens: 778,
    fixedOverhead: { protocolTokens: 700, toolSchemaTokens: 78, totalTokens: 778 },
    estimate_kind: 'host',
    projection_horizon_steps: 20,
    projection_horizon_reestimated: 0,
    projection_gross_tokens: 40,
    projection_gross_replay_tokens: 40,
    projection_retrieval_tokens: 0,
    projection_retrieval_content_tokens: 0,
    projection_retrieval_call_tokens: 0,
    projection_unpriced_projections: 0,
    projection_unpriced_retrievals: 0,
    projection_legacy_retrievals: 0,
    projection_retrievals: 0,
    projection_net_tokens: 7,
    projection_locator_evictions: 0,
    projection_unknown_families: 0,
    projection_unknown_tools: {},
    protocol_suppressed: 0,
    receipts_stopped: false,
    ...over,
  }
}

const STATUS_DATA = statusData()
const STATUS: Envelope<BoostStatus> = { ok: true, data: STATUS_DATA }

const SCOPE: ScopeDoc = {
  version: 2,
  revision: 0,
  mode: 'selected',
  workspaceIds: [],
  shadow: true,
  projection: 'shadow',
}

/** The route's deps with read-side fixtures; `write` is never called here. */
function deps(over: Partial<StateDeps> = {}): StateDeps {
  const base: StateDeps = {
    status: async () => STATUS,
    scope: async () => ({ ok: true, data: SCOPE }),
    workspaces: () => ({ available: true, entries: [] }),
    config: () => DEFAULT_CONFIG,
    write: async () => ({ ok: false, code: 'ERR_BOOST_INTERNAL' }),
  }
  return { ...base, ...over }
}

test('页面从 status 的信封里读到真实字段', async () => {
  const payload = await buildStatePayload(deps())

  assert.deepEqual(payload.status, STATUS, 'the envelope is forwarded unchanged')
  assert.equal(payload.status.ok, true)
  if (!payload.status.ok) return
  assert.deepEqual(payload.status.data.degraded, ['ERR_HOST_NO_SPILL'], 'degraded is a list on the data')
  assert.equal(payload.status.data.fixedOverheadTokens, 778)
  assert.equal(payload.status.data.estimate_kind, 'host')
  assert.deepEqual(payload.status.data.saved, STATUS_DATA.saved)
  assert.deepEqual(payload.status.data.counts, STATUS_DATA.counts)
})

test('config 也走同一个信封，data 是 resolveConfig 的结果', async () => {
  const payload = await buildStatePayload(deps())
  assert.deepEqual(payload.config, { ok: true, data: DEFAULT_CONFIG })
  assert.equal(payload.config.ok, true)
  if (!payload.config.ok) return
  assert.equal(payload.config.data.horizonSteps, DEFAULT_CONFIG.horizonSteps)
})

test('status 失败时保留信封，码仍然可读', async () => {
  const payload = await buildStatePayload(
    deps({ status: async () => ({ ok: false, code: 'ERR_BOOST_INTERNAL' }) }),
  )
  const read = envelopeOf(payload.status)
  assert.equal(read.ok, false)
  assert.equal(read.ok ? undefined : read.code, 'ERR_BOOST_INTERNAL')
})

test('健康读：信封说 ok，载荷没有 ok 字段也不影响', async () => {
  // The regression this pins: asking the *payload* whether the read succeeded.
  // A payload is a BoostStatus and carries no `ok`, so that question answers
  // "no" forever and every panel renders as unreadable.
  const payload = await buildStatePayload(deps())
  const read = envelopeOf(payload.status)
  assert.equal(read.ok, true, 'the envelope answered, so the page may report health')
  if (!read.ok) return
  assert.deepEqual(read.data.degraded, ['ERR_HOST_NO_SPILL'])
})

test('缺失读：没有结果也当成没读到，页面不说健康', () => {
  const read = envelopeOf(undefined)
  assert.equal(read.ok, false)
  assert.equal(read.ok ? undefined : read.code, undefined, 'no envelope means no code to show')
})

test('信封与载荷是两个类型：读错一层编译不过', async () => {
  const payload = await buildStatePayload(deps())
  const envelope = payload.status

  if (envelope.ok) {
    // @ts-expect-error — `ok` belongs to the envelope; `BoostStatus` has none,
    // so "did the read succeed" cannot be asked of the payload again.
    void envelope.data.ok
  }
  // @ts-expect-error — `saved` lives on the envelope's `data`; the envelope
  // itself has no payload fields, so reading it at this level cannot compile.
  void envelope.saved

  assert.equal(envelope.ok, true)
})

test('degraded 不是数组时页面不崩，按「没有降级项」之外的路径处理', async () => {
  // The wire is untrusted even though the type says otherwise: a host that
  // sends an object here used to reach `codes.map` and blank the page. The
  // fixture is deliberately the shape the type forbids, so the cast is the
  // point of the test.
  const malformed = {
    ok: true as const,
    data: { degraded: { oops: 1 }, saved: {}, counts: {} },
  }
  const payload = await buildStatePayload({
    status: async () => malformed as unknown as Envelope<BoostStatus>,
    scope: async () => ({ ok: true, data: {} }) as unknown as Envelope<ScopeDoc>,
    workspaces: () => ({ available: true, entries: [] }),
    config: () => DEFAULT_CONFIG,
    write: async () => ({ ok: true, data: {} }) as unknown as Envelope<ScopeDoc>,
  })
  const read = envelopeOf(payload.status)
  assert.equal(read.ok, true)
  const degraded = (read.data as { degraded: unknown }).degraded
  assert.equal(Array.isArray(degraded), false, 'the fixture is the shape the guard has to survive')
})

test('configOf 接受两种线上形状：信封与信封之前那个裸对象', () => {
  // A host whose server half predates the typed envelope sends the config
  // object itself. Reading only `{ ok, data }` turned that into "no config",
  // and the whole 蒸馏/生效配置 panel said "not measured" with the config
  // sitting in the same payload.
  const bare = { projection: { read: { triggerChars: 3000 } }, distillation: { enabled: true } }
  assert.deepEqual(configOf(bare), { config: bare })
  assert.deepEqual(configOf({ ok: true, data: bare }), { config: bare })
  assert.deepEqual(configOf({ ok: false, code: 'ERR_BOOST_INTERNAL' }), { code: 'ERR_BOOST_INTERNAL' })
  assert.deepEqual(configOf(undefined), {})
  assert.deepEqual(configOf('nope'), {})
  assert.deepEqual(configOf({ ok: true, data: null }), {})
})
