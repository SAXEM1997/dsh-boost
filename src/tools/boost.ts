/**
 * The `boost` control tool: the user's only way to see or change what the
 * plugin is doing.
 *
 * The plugin itself is invisible — it rewrites what the model sees and never
 * speaks — so this tool's output is part of the product, not a debugging aid.
 * `status` reports what the plugin has actually recorded: the scope document's
 * exposure surface, both switches (`shadow` and `projection`; "recording but
 * not replacing" is not "replacing"), per-code receipt counts over **every**
 * shard, the substitution and projection ledgers, and the stable degraded
 * codes observed. `scope-get` reads `scope.json`; `scope-set` and `shadow`
 * write it; both writes are compare-and-swap through `ScopeStore.write`, so a
 * stale caller gets `ERR_SCOPE_REVISION_CONFLICT` rather than silently
 * overwriting a concurrent change.
 *
 * ## Contracts this module keeps
 *
 * - Every failure is a stable code in a returned value; nothing throws out of
 *   `runBoost`. The store's own codes are passed through unchanged.
 * - `scope-set` never lets a caller set `version` or `revision`: `revision` is
 *   the store's, `version` is fixed at 2, and a body carrying either reserved
 *   field is rejected **before** the mutation runs. The store persists whatever
 *   `mutate` returns, so this rejection is what stops a v1-shaped document.
 * - Both ledger sides come from the receipts. This module never estimates a
 *   retrieval cost: an unpriced retrieval makes the net `'unknown'` rather
 *   than free, and `projection_unpriced_retrievals` says how many there were.
 *   A retrieval's own projection is excluded from gross because its visible
 *   window is already charged as retrieval content. The projection saving is
 *   read from `saved_projection_tokens` (the design §5.3 name T23b/T26 write),
 *   falling back to `saved`; a producer must write one of them, while a
 *   meterless projection has neither and makes gross/net `'unknown'`. The
 *   substitution saving is read only from the settled line, because the
 *   synth-time line predates any measurement.
 * - `status.degraded` is a list of **stable codes only** (`ERR_HOST_*` /
 *   `ERR_SCOPE_*`). The scope store's internal `scope-degraded` label and the
 *   receipt stream's `projection-skipped:*` are inputs, not output: a receipt
 *   code is mapped to `ERR_HOST_NO_SPILL`, and a degraded scope read passes its
 *   `ERR_SCOPE_*` code through. The two estimator absences are separate codes:
 *   `ERR_HOST_NO_TOKENMETER` is the host service probe (`apply` records whether
 *   the synchronous token meter exists), while `ERR_HOST_NO_ESTIMATOR` is the
 *   pure fixed-cost package being unreachable. One can exist without the other,
 *   and merging them sent the operator to the wrong host.
 *   `ERR_HOST_PLATFORM_UNSUPPORTED` is `isPosixOnly()` being false.
 * - The fixed overhead is measured **once at startup**
 *   (`measureBoostFixedOverhead`: protocol section + tool schema) and awaited
 *   by `status`; it is never on a request path (design §6.1).
 * - `runBoost` is pure orchestration over the two stores plus the host facts
 *   `apply` hands it: no `ctx`, no host calls beyond the one measurement. The
 *   tool definition is therefore testable without a host, and the host probe
 *   lives in `src/index.ts`.
 *
 * The command table is deliberately a plain record, one handler per
 * subcommand, so an unknown `cmd` is a lookup miss rather than a fallthrough.
 *
 * @module dsh-boost/tools/boost
 */
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { measureFixedOverhead } from '../admission/fixed-cost.js'
import type { FixedOverheadMeasurement } from '../admission/fixed-cost.js'
import { DEFAULT_CONFIG } from '../config.js'
import { isPosixOnly } from '../host/platform.js'
import type { ProjectionMode } from '../projection/apply.js'
import {
  ERR_SCOPE_ABORTED,
  ERR_SCOPE_FUTURE_VERSION,
  ERR_SCOPE_LOCKED,
  ERR_SCOPE_PARSE_FAILED,
  ERR_SCOPE_READ_FAILED,
  ERR_SCOPE_REVISION_CONFLICT,
  ERR_SCOPE_UNKNOWN_VERSION,
} from '../scope/doc.js'
import type { ScopeCode, ScopeDoc } from '../scope/doc.js'
import type { ScopeStore } from '../scope/store.js'
import type { Receipt, ReceiptStore } from '../receipts/store.js'

/** Stable failure code: `cmd` names no subcommand this tool implements. */
const ERR_BOOST_UNKNOWN_CMD = 'ERR_BOOST_UNKNOWN_CMD'

/** Stable failure code: a required argument (`baseRevision`) is missing or malformed. */
const ERR_BOOST_INVALID_ARGS = 'ERR_BOOST_INVALID_ARGS'

/** Stable failure code: `body` is not a valid, writable scope patch. */
const ERR_BOOST_INVALID_BODY = 'ERR_BOOST_INVALID_BODY'

/** Stable failure code: an unexpected internal failure, so the tool still answers. */
const ERR_BOOST_INTERNAL = 'ERR_BOOST_INTERNAL'

/** Every scope failure code, for passing the store's codes through unchanged. */
const SCOPE_CODES: ReadonlySet<string> = new Set([
  ERR_SCOPE_UNKNOWN_VERSION,
  ERR_SCOPE_FUTURE_VERSION,
  ERR_SCOPE_PARSE_FAILED,
  ERR_SCOPE_READ_FAILED,
  ERR_SCOPE_REVISION_CONFLICT,
  ERR_SCOPE_LOCKED,
  ERR_SCOPE_ABORTED,
])

/** Stable host degradation codes (design §9; the frozen set `status` reports). */
const ERR_HOST_NO_SPILL = 'ERR_HOST_NO_SPILL'
const ERR_HOST_NO_TOKENMETER = 'ERR_HOST_NO_TOKENMETER'
const ERR_HOST_NO_ESTIMATOR = 'ERR_HOST_NO_ESTIMATOR'
const ERR_HOST_PLATFORM_UNSUPPORTED = 'ERR_HOST_PLATFORM_UNSUPPORTED'
const ERR_HOST_NO_STEP_WHEN = 'ERR_HOST_NO_STEP_WHEN'
const ERR_HOST_NO_WORKSPACE_REGISTRY = 'ERR_HOST_NO_WORKSPACE_REGISTRY'

/**
 * Stable degradation code: at least one receipt shard could not be read.
 *
 * `status` scans every shard; a single unreadable file (EACCES, or a directory
 * named `x.jsonl`) must leave the healthy shards readable and the tool
 * answering. The store's per-shard containment reports skipped shards; a store
 * that throws instead is caught here and reported with the same code.
 */
const ERR_RECEIPTS_UNREADABLE = 'ERR_RECEIPTS_UNREADABLE'

/**
 * Stable degradation code: the final system prompt did not carry the protocol
 * section because a `complete: true` section replaced the assembly.
 *
 * Detected on the outgoing request (`llm/stream`), not at assembly time: the
 * host restores the complete section after the waterfall, so only the request
 * shows the loss. Substitution is refused for the affected request because the
 * model was never taught the plan grammar (review row 12).
 */
const ERR_HOST_COMPLETE_SECTION = 'ERR_HOST_COMPLETE_SECTION'

/**
 * Receipt codes that mean the host is degraded, mapped to the stable code
 * `status` reports.
 *
 * `projection-skipped:no-spill` is the code the projection path records when
 * the spill backend is absent (design §5.4), so it is the real producer behind
 * `ERR_HOST_NO_SPILL`. The same code is also derived from the host probe when
 * `projection: 'on'`; the two channels are deduplicated, not mutually exclusive.
 */
const RECEIPT_DEGRADATION: ReadonlyArray<{ readonly code: string; readonly degraded: string }> = [
  { code: 'projection-skipped:no-spill', degraded: ERR_HOST_NO_SPILL },
  // The substitution refusal writes the stable code itself, so a status built
  // without host facts still reports the reason the decision path recorded.
  { code: ERR_HOST_NO_TOKENMETER, degraded: ERR_HOST_NO_TOKENMETER },
]

/**
 * Host capabilities `apply` probes once and hands `status`.
 *
 * Every field is optional because `runBoost` is also usable without a host
 * (unit tests, and the control tool built before `apply` wires the probe). An
 * absent fact means "not probed", never "supported": the status code list then
 * simply omits the corresponding code rather than guessing.
 */
export interface BoostHostFacts {
  /** Whether `ctx.get('tokenMeter')` exposed the synchronous message estimator. */
  hasTokenMeter?: boolean
  /** Whether `ctx.get('spillStore')` exposed the projection backend. */
  hasSpill?: boolean
  /** Whether `ctx.tools.resolve` exists (step-level `when` support). */
  supportsStepWhen?: boolean
  /**
   * Whether `ctx.get('workspaceRegistry')` ever became available.
   *
   * A missing registry makes every session invisible, which presents to the
   * operator as "nothing ever happens" with no error anywhere. It is a host
   * fact rather than an assembly detail because that failure mode has to be
   * diagnosable from inside the product.
   */
  hasWorkspaceRegistry?: boolean
}

/** The two stores `runBoost` orchestrates, plus the host facts it reports. */
export interface BoostDeps {
  scope: ScopeStore
  receipts: ReceiptStore
  /** Host capabilities measured by `apply`; absent when no host was probed. */
  host?: BoostHostFacts
  /**
   * The one fixed-overhead measurement, started at plugin load.
   *
   * A function rather than a promise so `status` can await it lazily; the
   * default reuses the module-level memoised measurement.
   */
  fixedOverhead?: () => Promise<FixedOverheadMeasurement | 'unknown'>
  /**
   * Which estimator priced this assembly's figures.
   *
   * `host` means the synchronous host meter; `unknown` means no token meter,
   * so no number is fabricated (design §9). There is deliberately no
   * `chars/4` arm: a characters-over-four guess is not a measurement, and a
   * receipt that says `unknown` is more useful than one that is wrong.
   */
  estimateKind?: 'host' | 'unknown'
  /** Replay horizon used by the net formula; defaults to the design's 20. */
  horizonSteps?: number
  /** Locators evicted by the per-session cap; status-time read. */
  locatorEvictions?: () => number
  /**
   * Receipt shards a whole-store scan had to skip; status-time read.
   *
   * A store that contains an unreadable shard per shard reports it here so
   * `status` can add the stable code; absent means the store has no such
   * counter (or none was skipped). A store that throws instead is caught by
   * the status-side scan and reported with the same code.
   */
  receiptReadErrors?: () => number
  /** Calls skipped because no family matched; status-time read. */
  unknownFamilies?: () => number
  /** Retained unmapped tool names; status-time read. */
  unknownTools?: () => Record<string, number>
  /**
   * Prompt assemblies whose protocol section was suppressed; status-time read.
   *
   * The prompt path is the one mount that acts on every request, so design
   * §5.5:378 makes it a count rather than a receipt. It is exposed because the
   * shipped default scope is *correctly* inert: with no counter, "nothing
   * configured" and "assembly failed" look identical from `status`.
   */
  protocolSuppressed?: () => number
  /** Requests whose final prompt lost the protocol to a complete section; status-time read. */
  completeSectionSuppressions?: () => number
  /**
   * Cancellation for this invocation only.
   *
   * `runBoost` is also callable directly (tests, future hosts), so this is
   * optional; `boostTool.execute` fills it from the host's `exec.signal` and a
   * cancelled call leaves `scope.json` untouched.
   */
  signal?: AbortSignal
}

/** The scope document's caller-writable fields. Everything else is store-owned. */
const PATCH_FIELDS = ['mode', 'workspaceIds', 'shadow', 'projection'] as const

/** Fields a caller must never set: the store owns one, the format fixes the other. */
const RESERVED_FIELDS = ['version', 'revision'] as const

/** The four subcommands. */
type BoostCmd = 'status' | 'scope-get' | 'scope-set' | 'shadow'

/** Raw tool arguments, after the model (or a test) produced them. */
type BoostArgs = { cmd: BoostCmd; body?: unknown; baseRevision?: number }

/** Successful report or a stable failure code — never a thrown error. */
type BoostResult = { ok: true; data: unknown } | { ok: false; code: string }

/** What `status` reports. Both switches are top-level on purpose: they differ. */
export interface BoostStatus {
  scope: { mode: ScopeDoc['mode']; workspaceIds: string[]; revision: number }
  shadow: boolean
  projection: ProjectionMode
  saved: {
    /**
     * Σ numeric `saved_input_tokens` over settled substitutions only. The
     * synth-time `substitute` line predates any measurement (design §5.3 says
     * the field is measured), so its value is `'unknown'` or absent and never
     * contributes; `counts` keeps the event count.
     */
    substitution: number
    /**
     * Σ `saved_projection_tokens` over non-retrieval projections, **replayed**
     * by `(1 + horizonSteps)`.
     *
     * Replay-aware so this legacy object no longer mixes a one-time gross with
     * a replay net (review R2). The one-time figure is the top-level
     * `projection_gross_tokens`.
     */
    projectionGross: number | 'unknown'
    /**
     * `(gross_non_retrieval − retrieval_content) × (1 + horizon) − retrieval_calls`.
     *
     * `'unknown'` when any retrieval in the ledger is unpriced: an unmeasured
     * cost must never silently become zero (review R3).
     */
    projectionNet: number | 'unknown'
    /** Number of `kind:'projection'` receipts marked `retrieved: true`. */
    retrievals: number
  }
  /** Receipt count per `code`, over every shard (including the empty session id). */
  counts: Record<string, number>
  /** Stable degradation codes actually observed. */
  degraded: string[]
  /**
   * Whether the host ever exposed a workspace registry.
   *
   * Reported separately from {@link degraded} because it is the single fact
   * that explains "the plugin is installed and nothing ever happens": with no
   * registry, no session resolves to a workspace and every path is inert.
   * Absent when no host was probed.
   */
  hasWorkspaceRegistry?: boolean
  /**
   * The measured per-request fixed cost: protocol section + tool schema.
   *
   * `'unknown'` when the host estimator is unreachable: the measurement is
   * never fabricated (design §9). Status-time only; see
   * `src/admission/fixed-cost.ts`.
   */
  fixedOverheadTokens: number | 'unknown'
  /** The two components behind {@link fixedOverheadTokens}. */
  fixedOverhead: FixedOverheadMeasurement | 'unknown'
  /**
   * Whether the ledger figures are provider-metered or estimates.
   *
   * `unknown` means no token meter: projection still clips, but its receipts
   * carry `'unknown'` rather than invented numbers, and substitution is
   * refused (design §9).
   */
  estimate_kind: 'host' | 'unknown'
  /** The `(1 + horizon)` replay factor the net formula applies to both sides. */
  projection_horizon_steps: number
  /**
   * Σ one-time `saved_projection_tokens` over applied projections whose call
   * was **not** itself a retrieval.
   *
   * A retrieval's own projection is excluded: crediting it here while also
   * charging its visible window as retrieval cost would count the same tokens
   * from both sides (review I3).
   */
  projection_gross_tokens: number | 'unknown'
  /** {@link projection_gross_tokens} after `(1 + horizon)` replay. */
  projection_gross_replay_tokens: number | 'unknown'
  /** Σ one-time retrieval totals (call + content); `0` for unpriced receipts. */
  projection_retrieval_tokens: number
  /** Σ one-time retrieval content, the side that replays with the gross. */
  projection_retrieval_content_tokens: number
  /** Σ one-time retrieval call blocks; replay does not apply to these. */
  projection_retrieval_call_tokens: number
  /** Projections with no measured saving; the gross/net become `'unknown'`. */
  projection_unpriced_projections: number
  /** Retrievals with no usable token fields; their cost makes the net unknown. */
  projection_unpriced_retrievals: number
  /** Pre-schema retrievals priced through the old `retrievalCost` field. */
  projection_legacy_retrievals: number
  /**
   * The design's receipt-field spelling of `saved.retrievals`.
   *
   * Kept at the top level because the shadow-week operator reads the two
   * ledgers by the names §5.3 gives them; `saved` keeps the original camelCase
   * shape so existing consumers keep working. Both are derived from one
   * aggregation, so they cannot drift.
   */
  projection_retrievals: number
  /**
   * `(gross_non_retrieval − retrieval_content) × (1 + horizon) − retrieval_calls`.
   *
   * The retrieval's own projection is not in the gross, the content it made
   * visible replays, and its call block is charged once. `'unknown'` when a
   * retrieval is unpriced or a meterless projection was clipped: a lower bound
   * cannot be computed from a missing measurement.
   */
  projection_net_tokens: number | 'unknown'
  /** Locators dropped by the per-session cap; a lossy ledger is visible. */
  projection_locator_evictions: number
  /** Calls skipped because no projection family matched. */
  projection_unknown_families: number
  /** Retained unmapped tool names (at most 32), for mapper-gap diagnosis. */
  projection_unknown_tools: Record<string, number>
  /**
   * Prompt assemblies whose protocol section was suppressed.
   *
   * Counted, never receipted, because assembly runs on every request (design
   * §5.5:378). A live, monotonically increasing number is the only evidence
   * that the inert-looking default is "no workspace configured" rather than a
   * section that failed to inject.
   */
  protocol_suppressed: number
  /**
   * Whether the receipt store stopped accepting writes (fail-closed).
   *
   * Once true, substitution is refused outright (design §5.2-3) and every
   * figure above is a stale snapshot. Reported because the alternative is an
   * operator reading frozen numbers with no warning that they froze.
   */
  receipts_stopped: boolean
}

/** A validated scope patch: only the caller-writable fields survive. */
type ScopePatch = Partial<Pick<ScopeDoc, (typeof PATCH_FIELDS)[number]>>

/**
 * Yield the store's receipts, converting a throwing scan into a degraded flag.
 *
 * `ReceiptStore.scan` catches unreadable shards per shard; this wrapper is the
 * status-side backstop for a store that throws instead (another store
 * implementation, or a directory listing failure). The receipts yielded before
 * the failure are real and must still be counted; the flag tells `status` to
 * add {@link ERR_RECEIPTS_UNREADABLE} rather than fail the tool.
 */
async function* scanOrDegrade(
  receipts: ReceiptStore,
  state: { unreadable: boolean },
): AsyncIterable<Receipt> {
  try {
    yield* receipts.scan()
  } catch {
    state.unreadable = true
  }
}

/**
 * The receipt aggregation behind `status`, kept separate from the document
 * read so the accounting has one home and one test surface.
 *
 * `scan()` is called with no session id on purpose: `skip:no-scope` receipts
 * are not owned by one shard. The no-agent case writes the empty session id;
 * the cold-judgement path writes the real session id, once per tool call by
 * design (design §5.5:377), which is expected in unscoped workspaces and will
 * dominate their shards — not a leak. Only a whole-store scan sees both.
 */
async function aggregate(receipts: ReceiptStore): Promise<{
  counts: Record<string, number>
  substitution: number
  projectionGross: number
  unpricedProjections: number
  retrievalTokens: number
  retrievalContentTokens: number
  retrievalCallTokens: number
  retrievals: number
  unpricedRetrievals: number
  legacyRetrievals: number
  legacyRetrievalCost: number
  degraded: string[]
  unreadable: boolean
}> {
  const counts: Record<string, number> = Object.create(null)
  let substitution = 0
  let projectionGross = 0
  let unpricedProjections = 0
  let retrievalTokens = 0
  let retrievalContentTokens = 0
  let retrievalCallTokens = 0
  let retrievals = 0
  let unpricedRetrievals = 0
  let legacyRetrievals = 0
  let legacyRetrievalCost = 0

  /** Set when the whole-store scan threw instead of yielding every shard. */
  const scanState = { unreadable: false }
  for await (const receipt of scanOrDegrade(receipts, scanState)) {
    // A receipt is untrusted text from a file: `counts` has no prototype so a
    // code of `toString` or `__proto__` is an ordinary numeric key, never a
    // string concatenation and never a dropped assignment.
    if (typeof receipt.code === 'string') {
      counts[receipt.code] = (counts[receipt.code] ?? 0) + 1
    }

    // Only the settled line carries a measured saving; the synth-time line is
    // an event and is already visible in `counts`.
    if (receipt.kind === 'substitute-settled') {
      const saved = receipt.saved_input_tokens
      if (typeof saved === 'number' && Number.isFinite(saved)) substitution += saved
    }

    if (receipt.kind !== 'projection') continue

    if (receipt.unit === 'raw' && receipt.call_was_retrieval !== true && receipt.retrieved !== true) {
      // T23b/T26 write `saved_projection_tokens`; `saved` is the pre-T23b
      // spelling this consumer accepted first. Never estimate a value here.
      // A retrieval's own projection is excluded from gross: its visible
      // window is charged as retrieval content instead (review I3).
      const saved = receipt.saved_projection_tokens ?? receipt.saved
      if (typeof saved === 'number' && Number.isFinite(saved)) projectionGross += saved
      // A meterless projection carries `estimate:'unknown'` and no saved
      // figure. Reporting the remaining numeric sum as the gross would present
      // an unmeasured effect as zero (review R4).
      else unpricedProjections += 1
    }

    if (receipt.retrieved !== true) continue
    retrievals += 1

    const total = receipt.retrieval_tokens
    const call = receipt.retrieval_call_tokens
    const content = receipt.retrieval_content_tokens
    if (
      typeof total === 'number' &&
      Number.isFinite(total) &&
      total >= 0 &&
      typeof call === 'number' &&
      Number.isFinite(call) &&
      call >= 0 &&
      typeof content === 'number' &&
      Number.isFinite(content) &&
      content >= 0 &&
      total === call + content
    ) {
      retrievalTokens += total
      retrievalCallTokens += call
      retrievalContentTokens += content
      continue
    }

    // Pre-schema receipts (written before the split) carry only the old
    // already-replayed `retrievalCost` total. Subtracting it directly from the
    // replayed net avoids counting it as free (review R6). Its own projection,
    // if any, predates the `call_was_retrieval` marker and cannot be identified
    // from the file; that is documented in the report.
    const legacy = receipt.retrievalCost
    if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy >= 0) {
      legacyRetrievals += 1
      legacyRetrievalCost += legacy
      retrievalTokens += legacy
      continue
    }

    // Neither schema: the cost is unknown, not zero. The net is reported as
    // `'unknown'` rather than silently treating the retrieval as free.
    unpricedRetrievals += 1
  }

  const degraded = RECEIPT_DEGRADATION.filter(entry => counts[entry.code] !== undefined).map(
    entry => entry.degraded,
  )
  return {
    counts,
    substitution,
    projectionGross,
    unpricedProjections,
    retrievalTokens,
    retrievalContentTokens,
    retrievalCallTokens,
    retrievals,
    unpricedRetrievals,
    legacyRetrievals,
    legacyRetrievalCost,
    degraded,
    unreadable: scanState.unreadable,
  }
}

/**
 * The fixed overhead measurement, never a thrown status.
 *
 * The production deps carry the promise `apply` started at load; the default
 * is the same memoised measurement, so a direct `runBoost` (a unit test or a
 * host that built the tool itself) still reports a real number. A rejection or
 * an invalid breakdown is `'unknown'`, for the same reason the estimator's own
 * failure is.
 */
async function fixedOverheadOf(deps: BoostDeps): Promise<FixedOverheadMeasurement | 'unknown'> {
  try {
    const value = await (deps.fixedOverhead ?? measureBoostFixedOverhead)()
    if (value === 'unknown') return 'unknown'
    const { protocolTokens, toolSchemaTokens, totalTokens } = value
    if (
      !Number.isFinite(protocolTokens) ||
      !Number.isFinite(toolSchemaTokens) ||
      !Number.isFinite(totalTokens) ||
      protocolTokens < 0 ||
      toolSchemaTokens < 0 ||
      totalTokens !== protocolTokens + toolSchemaTokens
    ) {
      return 'unknown'
    }
    return value
  } catch {
    return 'unknown'
  }
}

/** The configured replay horizon, or the design default when absent/malformed. */
function horizonOf(deps: BoostDeps): number {
  const raw = deps.horizonSteps
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : DEFAULT_CONFIG.horizonSteps
}

/** The label for the assembly's estimator; unprobed is honestly `unknown`. */
function estimateKindOf(deps: BoostDeps): BoostStatus['estimate_kind'] {
  const kind = deps.estimateKind
  return kind === 'host' || kind === 'unknown' ? kind : 'unknown'
}

/**
 * Whether the receipt store has stopped writing, fail-closed.
 *
 * Mirrors `receiptsStopped` in `src/hooks/llm-stream.ts` for the control tool's
 * own store reference: a partial store is "not stopped", and a store that
 * throws cannot record evidence, which is what stopped means.
 */
function receiptsStopped(store: BoostDeps['receipts']): boolean {
  try {
    if (store == null || typeof store.stopped !== 'function') return false
    return store.stopped() === true
  } catch {
    return true
  }
}

/** A monotonic status counter, never a thrown status. */
function counterOf(read: (() => number) | undefined): number {
  try {
    const value = read?.()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0
  } catch {
    return 0
  }
}

/** A bounded unmapped-tool map, never a thrown status. */
function toolCountsOf(read: (() => Record<string, number>) | undefined): Record<string, number> {
  // Build through a Map: `counts['__proto__'] = n` on a plain object would
  // mutate its prototype, and tool names come from the host. `fromEntries` is
  // an own-property copy, so the returned object has the normal prototype and
  // deep-equality consumers see a plain record.
  const counts = new Map<string, number>()
  try {
    const value = read?.()
    if (value === null || typeof value !== 'object') return {}
    for (const [name, count] of Object.entries(value)) {
      if (typeof count === 'number' && Number.isFinite(count) && count >= 0) counts.set(name, count)
    }
  } catch {
    // A foreign counter is evidence, not a failure.
  }
  return Object.fromEntries(counts)
}

/**
 * The stable degradation codes for one status call.
 *
 * Inputs are the receipt-observed codes, the scope read's stable code, and the
 * host facts. Receipt codes are already mapped; the scope store's internal
 * `scope-degraded` label is deliberately **not** copied — the report's contract
 * is stable codes only. Order is deterministic (receipts, scope, host) and the
 * result is deduplicated, so one condition observed through two channels
 * appears once.
 *
 * Two different absences stay distinct: `ERR_HOST_NO_TOKENMETER` is the
 * **service** (`ctx.get('tokenMeter')`) being absent, which refuses
 * substitution; `ERR_HOST_NO_ESTIMATOR` is the pure estimate package being
 * unreachable, which makes the fixed-overhead figure `'unknown'`. A host with
 * the package but no service reports the latter only.
 *
 * `ERR_HOST_NO_STEP_WHEN` is a host fact, but on exactly that host `apply` does
 * not register the `boost` tool at all (design §5.5), so the code is normally
 * observed in the registration warning rather than through `status`; it is
 * still rendered when a fact reaches `runBoost` directly.
 */
function degradationCodes(
  observed: readonly string[],
  read: Awaited<ReturnType<ScopeStore['read']>>,
  host: BoostHostFacts | undefined,
  fixedOverhead: FixedOverheadMeasurement | 'unknown',
): string[] {
  const codes: string[] = [...observed]
  if (read.degraded !== undefined) codes.push(read.code ?? ERR_SCOPE_READ_FAILED)

  if (!isPosixOnly()) codes.push(ERR_HOST_PLATFORM_UNSUPPORTED)
  if (host?.hasTokenMeter === false) codes.push(ERR_HOST_NO_TOKENMETER)
  if (fixedOverhead === 'unknown') codes.push(ERR_HOST_NO_ESTIMATOR)
  // `spillStore` matters only in apply mode; shadow mode never touches it
  // (design §5.4), so reporting it while projection is `shadow` would be noise.
  if (host?.hasSpill === false && read.doc.projection === 'on') codes.push(ERR_HOST_NO_SPILL)
  if (host?.supportsStepWhen === false) codes.push(ERR_HOST_NO_STEP_WHEN)
  if (host?.hasWorkspaceRegistry === false) codes.push(ERR_HOST_NO_WORKSPACE_REGISTRY)

  return [...new Set(codes)]
}

/** `status`: the scope document plus the receipt ledgers, never a failure. */
async function statusCommand(deps: BoostDeps): Promise<BoostResult> {
  const read = await deps.scope.read()
  const totals = await aggregate(deps.receipts)
  const fixedOverhead = await fixedOverheadOf(deps)
  const degraded = degradationCodes(totals.degraded, read, deps.host, fixedOverhead)
  // A shard the scan could not read is evidence, not a status failure: the
  // healthy shards were counted and the operator gets a stable code saying the
  // ledger is incomplete.
  if (
    (totals.unreadable || counterOf(deps.receiptReadErrors) > 0) &&
    !degraded.includes(ERR_RECEIPTS_UNREADABLE)
  ) {
    degraded.push(ERR_RECEIPTS_UNREADABLE)
  }
  // A complete prompt section silently removed the protocol from the request:
  // the workspace is visible but substitution cannot be taught, so the operator
  // must see why the plugin is inert.
  if (counterOf(deps.completeSectionSuppressions) > 0) degraded.push(ERR_HOST_COMPLETE_SECTION)
  const horizon = horizonOf(deps)
  const estimateKind = estimateKindOf(deps)
  const factor = 1 + horizon

  // Meterless projections have `estimate:'unknown'` receipts with no saved
  // figure. Reporting the numeric sum of the rest as 0/0 would be
  // indistinguishable from "projection had no effect" (review R4).
  const meterlessEvidence = totals.unpricedProjections > 0
  const grossOneTime = meterlessEvidence ? 'unknown' : totals.projectionGross
  const grossReplay = grossOneTime === 'unknown' ? 'unknown' : grossOneTime * factor

  // A retrieval's own projection is excluded from gross; its content replays
  // with the gross, its call block is charged once, and a legacy cost was
  // already replay-aware (review I3/R6). An unpriced retrieval makes the whole
  // net unknown rather than free (review R3).
  const netUnknown = meterlessEvidence || totals.unpricedRetrievals > 0
  const projectionNet =
    netUnknown
      ? 'unknown'
      : (totals.projectionGross - totals.retrievalContentTokens) * factor -
        totals.retrievalCallTokens -
        totals.legacyRetrievalCost

  const saved: BoostStatus['saved'] = {
    substitution: totals.substitution,
    projectionGross: grossReplay,
    projectionNet,
    retrievals: totals.retrievals,
  }
  const data: BoostStatus = {
    scope: {
      mode: read.doc.mode,
      workspaceIds: read.doc.workspaceIds,
      revision: read.doc.revision,
    },
    shadow: read.doc.shadow,
    projection: read.doc.projection,
    saved,
    counts: totals.counts,
    degraded,
    fixedOverheadTokens: fixedOverhead === 'unknown' ? 'unknown' : fixedOverhead.totalTokens,
    fixedOverhead,
    estimate_kind: estimateKind,
    projection_horizon_steps: horizon,
    projection_gross_tokens: grossOneTime,
    projection_gross_replay_tokens: grossReplay,
    projection_retrieval_tokens: totals.retrievalTokens,
    projection_retrieval_content_tokens: totals.retrievalContentTokens,
    projection_retrieval_call_tokens: totals.retrievalCallTokens,
    projection_unpriced_projections: totals.unpricedProjections,
    projection_unpriced_retrievals: totals.unpricedRetrievals,
    projection_legacy_retrievals: totals.legacyRetrievals,
    projection_retrievals: totals.retrievals,
    projection_net_tokens: projectionNet,
    projection_locator_evictions: counterOf(deps.locatorEvictions),
    projection_unknown_families: counterOf(deps.unknownFamilies),
    projection_unknown_tools: toolCountsOf(deps.unknownTools),
    protocol_suppressed: counterOf(deps.protocolSuppressed),
    receipts_stopped: receiptsStopped(deps.receipts),
    // An absent host fact is "not probed", not `false`: `undefined` is not a
    // legal JSON value, so the key is omitted rather than handed to the host
    // boundary (review row 35).
    ...(deps.host?.hasWorkspaceRegistry === undefined
      ? {}
      : { hasWorkspaceRegistry: deps.host.hasWorkspaceRegistry }),
  }
  return { ok: true, data }
}

/** `scope-get`: a faithful read; a degraded read is a stable tool failure. */
async function scopeGetCommand(deps: BoostDeps): Promise<BoostResult> {
  const read = await deps.scope.read()
  if (read.degraded !== undefined) return { ok: false, code: read.code ?? ERR_SCOPE_READ_FAILED }
  return { ok: true, data: read.doc }
}

/** Whether a value can be a caller-supplied base revision. */
function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Whether `value` is one of the three projection modes. */
function isProjectionMode(value: unknown): value is ProjectionMode {
  return value === 'off' || value === 'shadow' || value === 'on'
}

/**
 * Validate a `scope-set` body and prune it to the writable fields.
 *
 * Reserved fields are checked **first**: the store persists whatever `mutate`
 * returns, so a body carrying `version` or `revision` must be refused before a
 * patch is built, not stripped and written as if the caller's intent were
 * merely advisory. Unknown keys are pruned; a known key with a wrong type is
 * rejected, never coerced.
 */
function scopePatchOf(body: unknown): { ok: true; patch: ScopePatch } | { ok: false; code: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: ERR_BOOST_INVALID_BODY }
  }
  const source = body as Record<string, unknown>
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(source, key)
  if (RESERVED_FIELDS.some(has)) return { ok: false, code: ERR_BOOST_INVALID_BODY }

  const patch: ScopePatch = {}
  if (has('mode')) {
    if (source.mode !== 'selected' && source.mode !== 'global') {
      return { ok: false, code: ERR_BOOST_INVALID_BODY }
    }
    patch.mode = source.mode
  }
  if (has('workspaceIds')) {
    const ids = source.workspaceIds
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) {
      return { ok: false, code: ERR_BOOST_INVALID_BODY }
    }
    patch.workspaceIds = [...ids]
  }
  if (has('shadow')) {
    if (typeof source.shadow !== 'boolean') return { ok: false, code: ERR_BOOST_INVALID_BODY }
    patch.shadow = source.shadow
  }
  if (has('projection')) {
    if (!isProjectionMode(source.projection)) return { ok: false, code: ERR_BOOST_INVALID_BODY }
    patch.projection = source.projection
  }
  return { ok: true, patch }
}

/** The store's stable code, or undefined for anything else (which never escapes). */
function scopeCodeOf(error: unknown): ScopeCode | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && SCOPE_CODES.has(code) ? (code as ScopeCode) : undefined
}

/**
 * One compare-and-swap write shared by `scope-set` and `shadow`.
 *
 * `version: 2` is forced even though `ScopeStore.write` bases a corrupt or
 * v1 file on `DEFAULT_SCOPE`: the invariant must hold at the mutation boundary,
 * where the store's "persist whatever `mutate` returns" contract makes it
 * binding. `revision` is deliberately absent — the store owns it.
 */
async function writeScope(
  scope: ScopeStore,
  mutate: (doc: ScopeDoc) => ScopeDoc,
  baseRevision: number,
  signal?: AbortSignal,
): Promise<BoostResult> {
  try {
    const doc = await scope.write(mutate, baseRevision, { signal })
    return { ok: true, data: doc }
  } catch (error) {
    const code = scopeCodeOf(error)
    if (code !== undefined) return { ok: false, code }
    throw error
  }
}

/** `scope-set`: validate, prune, then write with compare-and-swap. */
async function scopeSetCommand(deps: BoostDeps, args: BoostArgs): Promise<BoostResult> {
  const parsed = scopePatchOf(args.body)
  if (!parsed.ok) return parsed
  if (!isRevision(args.baseRevision)) return { ok: false, code: ERR_BOOST_INVALID_ARGS }
  const patch = parsed.patch
  return writeScope(
    deps.scope,
    doc => ({ ...doc, ...patch, version: 2 }),
    args.baseRevision,
    deps.signal,
  )
}

/**
 * `shadow`: the shadow-week switch, independent of `projection`.
 *
 * A version 1 document is **not** upgraded here. The store can carry a v1
 * document through a write, but design §5.5 makes `scope-set` the explicit
 * upgrade path: the other write refuses with the degraded read's stable code so
 * the operator performs the documented upgrade instead of a blind rewrite.
 */
async function shadowCommand(deps: BoostDeps, args: BoostArgs): Promise<BoostResult> {
  if (typeof args.body !== 'boolean') return { ok: false, code: ERR_BOOST_INVALID_BODY }
  if (!isRevision(args.baseRevision)) return { ok: false, code: ERR_BOOST_INVALID_ARGS }
  const current = await deps.scope.read()
  if (current.code === ERR_SCOPE_UNKNOWN_VERSION) {
    return { ok: false, code: ERR_SCOPE_UNKNOWN_VERSION }
  }
  const shadow = args.body
  return writeScope(deps.scope, doc => ({ ...doc, shadow }), args.baseRevision, deps.signal)
}

/** One handler per subcommand; the table is the dispatch and the documentation. */
const COMMANDS: Record<BoostCmd, (deps: BoostDeps, args: BoostArgs) => Promise<BoostResult>> = {
  status: statusCommand,
  'scope-get': scopeGetCommand,
  'scope-set': scopeSetCommand,
  shadow: shadowCommand,
}

/**
 * Run one `boost` invocation. Pure orchestration over the two stores.
 *
 * Failures are values: an unknown command, an invalid body or a store code all
 * come back as `{ ok: false, code }`. The `try` covers the argument read as
 * well as the handler, so a null call or an argument object with a throwing
 * getter answers a stable code instead of throwing. The catch exists only so
 * an unexpected store failure cannot turn the user's only control surface into
 * a thrown tool error; it is not an expected path.
 */
export async function runBoost(
  input: BoostDeps & {
    args: { cmd: BoostCmd; body?: unknown; baseRevision?: number }
  },
): Promise<{ ok: true; data: unknown } | { ok: false; code: string }> {
  try {
    const signal = (input as { signal?: AbortSignal } | null | undefined)?.signal
    if (signal?.aborted === true) return { ok: false, code: ERR_SCOPE_ABORTED }
    const args = (input as { args?: unknown } | null | undefined)?.args
    const cmd = (args as { cmd?: unknown } | null | undefined)?.cmd
    const handler =
      typeof cmd === 'string' && Object.prototype.hasOwnProperty.call(COMMANDS, cmd)
        ? COMMANDS[cmd as BoostCmd]
        : undefined
    if (handler === undefined) return { ok: false, code: ERR_BOOST_UNKNOWN_CMD }
    return await handler(input as BoostDeps, args as BoostArgs)
  } catch {
    return { ok: false, code: ERR_BOOST_INTERNAL }
  }
}

/**
 * The host's cancellation signal, or `undefined` for any other shape.
 *
 * `exec` crosses the host boundary and is untrusted here: a plain object with
 * an `aborted` boolean and an `addEventListener` function is the documented
 * `AbortSignal` contract this code relies on, and anything else is ignored
 * rather than dereferenced (a foreign host must not make `boost` throw).
 */
function signalOf(exec: unknown): AbortSignal | undefined {
  const candidate = (exec as { signal?: unknown } | null | undefined)?.signal
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const signal = candidate as { aborted?: unknown; addEventListener?: unknown }
  if (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function') {
    return undefined
  }
  return candidate as AbortSignal
}

/** Model-facing description: what each command does and what it returns. */
const DESCRIPTION = [
  'Inspect or change dsh-boost state. Commands:',
  'status reports the scope document, both switches (shadow, projection), receipt counts per code across all sessions, the substitution ledger, the projection ledger as a net amount with its retrieval count, the measured fixed overhead in tokens, and the stable degraded codes;',
  'scope-get reads the full scope document;',
  'scope-set replaces the given scope fields with compare-and-swap; body = { mode?, workspaceIds?, shadow?, projection? }; version and revision are store-owned and rejected;',
  'shadow persists the shadow-week switch; body = boolean; it refuses a version 1 document with ERR_SCOPE_UNKNOWN_VERSION — run scope-set once to upgrade it.',
  'scope-set and shadow require the baseRevision last seen via status or scope-get; a stale revision fails with ERR_SCOPE_REVISION_CONFLICT. Failures are { ok:false, code } values, never thrown.',
].join(' ')

/** The argument schema shown to the model; `status`/`scope-get` need only `cmd`. */
const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    cmd: {
      type: 'string',
      enum: ['status', 'scope-get', 'scope-set', 'shadow'],
      description: 'Which boost operation to run.',
    },
    body: {
      description:
        'scope-set: the desired scope fields (unknown keys are pruned, version/revision rejected). shadow: the desired boolean.',
      oneOf: [
        {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['selected', 'global'] },
            workspaceIds: { type: 'array', items: { type: 'string' } },
            shadow: { type: 'boolean' },
            projection: { type: 'string', enum: ['off', 'shadow', 'on'] },
          },
        },
        { type: 'boolean' },
      ],
    },
    baseRevision: {
      // `minimum` is outside the host's enforced JSON-Schema subset; the
      // runtime check in `isRevision` is the authority for `>= 0` (row 45).
      type: 'integer',
      description: 'Required by scope-set and shadow: the revision last seen (a non-negative integer).',
    },
  },
  required: ['cmd'],
  additionalProperties: false,
}

/**
 * The model-visible part of the `boost` tool definition.
 *
 * This is the second half of the fixed-overhead budget: `estimateToolsTokens`
 * prices the schema the model receives every request. `output` is a host-side
 * envelope and is not part of the request's tool list, so it is excluded.
 */
function boostSchema(): { name: 'boost'; description: string; parameters: Record<string, unknown> } {
  return { name: 'boost', description: DESCRIPTION, parameters: PARAMETERS }
}

/** The one memoised protocol + schema measurement, shared by startup and status. */
let boostFixedOverhead: Promise<FixedOverheadMeasurement | 'unknown'> | undefined

/**
 * The startup probe `apply` fires once and `status` awaits.
 *
 * Memoised per process: a status call must report the same number the startup
 * measured, and must not re-import or re-price the schema.
 */
export function measureBoostFixedOverhead(): Promise<FixedOverheadMeasurement | 'unknown'> {
  boostFixedOverhead ??= measureFixedOverhead(boostSchema())
  return boostFixedOverhead
}

/**
 * The canonical output envelope. The host validates every successful return
 * against this schema, and a failure is a successful call whose value is
 * `{ ok: false, code }` (the tool never throws its stable codes), so both
 * branches are declared.
 */
const OUTPUT_SCHEMA: JsonSchemaNode = {
  oneOf: [
    {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: true },
        data: {},
      },
      required: ['ok', 'data'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        ok: { type: 'boolean', const: false },
        code: { type: 'string' },
      },
      required: ['ok', 'code'],
      additionalProperties: false,
    },
  ],
}

/** Render the canonical envelope as one text block; `JSON.stringify` is the format. */
function renderResult(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) ?? 'undefined' }]
}

/**
 * Build the host tool definition.
 *
 * `output: { schema, render }` is mandatory in the host's `ToolDefinition`;
 * a definition missing it is rejected at registration. `execute` reuses
 * `runBoost`, so the tool and the pure orchestration cannot drift.
 */
export function boostTool(deps: BoostDeps): {
  name: 'boost'
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: JsonSchemaNode
    render: (args: unknown, value: unknown) => { type: 'text'; text: string }[]
  }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
} {
  return {
    name: 'boost',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    execute: (args, exec) => runBoost({ args: args as BoostArgs, ...deps, signal: signalOf(exec) }),
  }
}