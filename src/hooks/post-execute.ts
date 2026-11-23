/**
 * Host hook assembly: the four mount points the plugin owns, and the
 * post-execute decision path that turns the gate into a working product.
 *
 * Registration stays split one function per mount so each body can be replaced
 * without rewriting the mount:
 *
 * - `tools/post-execute` first gates on the same cached scope judgement the
 *   protocol section reads, then canonicalises the result and runs a
 *   conservative invalidation check. It files the arriving receipt under
 *   `'root'`, then — only when the decision leaves that receipt visible
 *   (`projectionTargetOf`) — works the substitution decision (`decide` →
 *   admission → pending queue / shadow receipt / fallback), then the
 *   double-projection guard, and finally projects the receipt when the scope
 *   document asks for it. Order is fixed: `next() → scope gate → canonicalise
 *   → invalidate → visibility gate → decide → (shadow receipt | admit and
 *   enqueue | fallback) → double-projection guard → projection → return the
 *   decision` (plan §Task 23b). A call with no `exec.agent` is not the
 *   plugin's to inspect: the downstream decision is returned untouched and a
 *   `skip:no-scope` receipt keeps the pass visible (design §5.5). A call
 *   carrying `exec.parent` is a PTC inner dispatch and returns before any of
 *   this: it is not the step's root receipt.
 * - `llm/stream` is the model-request waterfall. Its body lives in
 *   `./llm-stream.ts` (Task 23c-1) and is re-exported below: it lets the
 *   plugin's own selector request through untouched, then answers a pending
 *   decision with a synthesized turn or delegates to `next()` after the
 *   turn/anchor checks. The mount is registered here because `registerHooks`
 *   is the single assembly surface.
 * - `tools/execute` looks the session's pending substitution up with `peek`
 *   (never `take`: the entry must survive to this hook), compares the arriving
 *   `callId` itself. A **differing** `callId` is not tampering: the host assigns
 *   call ids and our synthesized turn sets the one we chose, so a call carrying
 *   a different id is an ordinary call that has nothing to do with the
 *   substitution — it passes through untouched. Only when the ids are equal does
 *   `rejectIfTampered` run, and only then is the entry cleared (on accept or
 *   reject), because the entry has then served its purpose.
 * - the `systemPrompt` section reads the per-agent judgement cache
 *   synchronously. Its `text` must be a function, never a static string: a
 *   static string would inject the protocol into every session unconditionally
 *   and defeat the scope document (design §5.5).
 *
 * ## What Task 23b added
 *
 * The receipt map (`ReceiptSessionState`) keys `'root'` to the receipt that
 * just arrived and each executed candidate's id to its own receipt, so guards
 * and `$public` templates always read the arrival-time canonical text and a
 * later step can project a value from an earlier step. The executable args
 * always come from the *decision* (`decision.args` / `decision.candidates[i]
 * .args`), never from `plan.steps[i].args`, which still holds `$public`
 * templates. A plan is one-shot per receipt: the first post-execute that reads
 * it removes it, so neither a guard failure nor a commit can leave the block
 * alive to fire against a later receipt (the model writes a new block for its
 * next call). It also means `decide` cannot re-commit the same step.
 *
 * The `shadow` flag from the scope document drives both `decide` (which skips
 * the whitelist) and the record-only branch: a shadow commit writes a
 * `{kind:'shadow'}` receipt and neither enqueues nor takes budget. It does
 * **not** suppress projection: `shadow` and `projection` are independent
 * switches (design §5.2-5), and projection-shadow mode writes only its
 * accounting receipt. Admission runs in the mandated order — existence,
 * `worthSubstituting`, then `budget.take()` — so a fallback never spends budget
 * for a call it did not substitute.
 *
 * Everything here is contained: the host turns a throwing `post-execute`
 * listener into an error result and the tool's real output is lost, so every
 * foreign call (stores, queue, clock, usage, estimator) is wrapped. The
 * `tools/execute` mount is contained too, failing open on an internal error:
 * the design's fail-closed definition is "pass through, do not substitute",
 * never "intercept the call" (design §5.5).
 *
 * The provider's `c.scope` is the agent itself at runtime: the host builds the
 * assembly context as `{ agent, scope: agent, signal }`
 * (`@deepseek-ai/dsh-agent/lib/index.js:410`), even though the declared type is
 * the opaque `ScopeKey`. Keying the cache on anything else — or falling back to
 * a no-argument judgement — would leak one session's visibility into another.
 *
 * @module dsh-boost/hooks/post-execute
 */
import { worthSubstituting } from '../admission/ledger.js'
import type { StepBudget } from '../admission/ledger.js'
import type { RetrievalLedger } from '../admission/retrieval.js'
import type { UsageLedger } from '../admission/usage.js'
import { DEFAULT_CONFIG } from '../config.js'
import { decide as decideDistill } from '../distill/decide.js'
import type { DistillAttempts } from '../distill/attempt.js'
import type { DistillOutcome } from '../distill/decide.js'
import { decide } from '../gate/decide.js'
import { alreadySpilled, looksPruned } from '../gate/invalidate.js'
import type { AnchorStore, ReceiptAnchors } from '../gate/invalidate.js'
import type { Candidate, Guard, Plan } from '../gate/plan.js'
import { isPosixOnly } from '../host/platform.js'
import type { ProjectionCounters } from '../projection/counters.js'
import { PROTOCOL_NAME, PROTOCOL_ORDER, PROTOCOL_TEXT } from '../prompt/protocol.js'
import { projectApply, projectShadow } from '../projection/apply.js'
import { renderHeadLine, truncate } from '../projection/truncate.js'
import type { FormatFooter, ProjectionMode, SpillBackend, SpillHandle } from '../projection/apply.js'
import { canonicalise } from '../projection/canonicalise.js'
import type { CanonicalReceipt } from '../projection/canonicalise.js'
import type { ReceiptStore } from '../receipts/store.js'
import { DEFAULT_SCOPE, isVisible } from '../scope/doc.js'
import type { ScopeDoc } from '../scope/doc.js'
import type { ScopeStore } from '../scope/store.js'
import type { DistillStore } from '../distill/store.js'
import type { DistillFn, DistillRequest } from '../distill/types.js'
import { SELECTOR_SYSTEM_PROMPT, choose, selectorPromptText } from '../selector/jev.js'
import type { LlmLike } from '../selector/jev.js'
import { familyOf } from '../tools/family.js'
import type {
  AbortSignalLike,
  AgentLike,
  BoostConfig,
  PluginContext,
  ResolvedToolSet,
  ToolFamily,
} from '../types.js'
import type { TurnClock } from './clock.js'
import { rejectIfTampered } from './execute.js'
import {
  budgetWired,
  receiptsStopped,
  sessionBudget,
  sessionClock,
  sessionUsage,
  settleDiscarded,
  streamHook,
} from './llm-stream.js'
import type { SessionRuntime } from './llm-stream.js'
import { callIdFor } from './pending.js'
import type { PendingEntry, PendingQueue } from './pending.js'
import {
  ReceiptSessionState,
  appendReceipt,
  callPreview,
  clearAnchors,
  clearPlan,
  clearPending,
  clockTurnOf,
  peekPending,
  previewOf,
} from './session-state.js'
import type { ReceiptInput } from './session-state.js'

/**
 * The `llm/stream` body lives in its own module (Task 23c-1). It is re-exported
 * here because `registerHooks` is the assembly surface the rest of the plugin
 * and the integration tests import; the mount below uses the same function.
 */
export { streamHook }

/**
 * The substitution whitelist: exactly the read-only trio (design §5.2-5).
 *
 * One constant drives both `decide` (non-shadow) and the `whitelisted` field
 * written to the shadow/substitute receipts, so the policy the gate enforced
 * and the policy the audit trail reports cannot drift. `bash`, `web_fetch` and
 * every write tool stay out: they have no deterministic read-only judgement.
 */
export const SUBSTITUTION_WHITELIST: ReadonlySet<string> = new Set(['read', 'grep', 'glob'])

/**
 * Hard cap on the receipt text shown to the selector.
 *
 * A full 40 KB receipt would dominate the selector call before the candidate
 * summaries are added. This cap keeps the receipt near 300 tokens even when the
 * tool family's projection window is larger, while still showing the
 * projection's head/tail shape. The actual input+output charge is computed
 * from the text that is sent, never from this cap alone.
 */
const SELECTOR_RECEIPT_MAX_CHARS = 1_200

/** The route an `ask-selector` request inherits from the boundary request. */
export interface SelectorRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The dependencies the mounts read; Task 23c constructs the whole set once. */
export interface HookDeps {
  config: BoostConfig
  scope: ScopeStore
  receipts: ReceiptStore
  /**
   * Per-session receipt anchors (design §5.2-7).
   *
   * Written by the decision path on a real commit and read here to detect an
   * external rewrite; a hit clears them. Required by the contract: without a
   * store the invalidation check is silently dead.
   */
  anchors: AnchorStore
  /**
   * Session id to workspace id.
   *
   * Required: substitution is refused for a session that does not resolve to a
   * workspace, or whose live scope document does not list that workspace. The
   * judgement cache alone can be stale, and the replacement path must never
   * run without a current visibility answer (design §5.5). Returning
   * `undefined` is fail-closed, never an error.
   */
  resolveSession: (sessionId: string) => string | undefined
  /** At most one pending substitution per session; absent means the path is inert. */
  queue?: PendingQueue
  /**
   * Per-turn substitution budget; absent **and with no `sessions` runtime**
   * means no cap is applied. Used only when `sessions` is absent, so a shared
   * instance is never preferred over the per-session runtime. A shared instance
   * that another session already borrowed is not "no budget": `sessionBudget`
   * answers `undefined` for the refused loan and the decision path treats it as
   * exhausted (row 21).
   */
  budget?: StepBudget
  /** Usage pairing; the shared fallback when `sessions` is absent (T21/T23c). */
  usage?: UsageLedger
  /**
   * The host turn/step clock; `step()` is the only source of a call id's step.
   * The shared fallback when `sessions` is absent.
   */
  clock?: TurnClock
  /**
   * Per-session clock, budget and usage (Task 23c).
   *
   * A shared `clock` lets another session's turn/step stamp this session's
   * `callId`; a shared `StepBudget` starves a session; a shared `UsageLedger`
   * pairs one session's substitution with another session's request. When
   * supplied, this runtime is authoritative and the three single instances
   * above are only the fallback for a plugin wired without it. 23c-2 constructs
   * one `SessionRuntime`, drives `onModelRequest` from the host's
   * `agent/request` payload, and passes it here.
   */
  sessions?: SessionRuntime
  /**
   * The host LLM service, used only for the `ask-selector` call.
   *
   * Optional so a minimal assembly (or a unit test of the decision path)
   * degrades to a record-only abstention rather than crashing. The selector
   * request carries `purpose: 'boost-selector'`, which the frozen stream hook
   * lets through untouched (Task 23c-2).
   */
  llm?: LlmLike
  /**
   * Receipt distillation (ADR 0001, ticket #10): the one model call that
   * answers a family's fixed question about a long `bash`/`ssh` receipt.
   *
   * Absent, or absent with `distillation.enabled: false` (the default), leaves
   * the projection path exactly as it was before distillation existed. The
   * call carries `purpose: 'boost-distill'`, which the stream hook passes
   * through untouched.
   */
  distill?: DistillFn
  /**
   * The route a distillation call uses: `distillation.route` when configured,
   * else the boundary route the selector inherits. `undefined` records
   * `distill-failed` without calling anything.
   */
  distillRoute?: (sessionId: string) => SelectorRoute | undefined
  /** Shared read/write handle to the pinned products under `<root>/distilled/`. */
  distillStore?: DistillStore
  /** A store bound lazily (production binds it to the resolved root); used when `distillStore` is absent. */
  distillStoreOf?: () => DistillStore | undefined
  /** The parked timed-out calls, so a late answer is persisted (see `distill/attempt.ts`). */
  distillAttempts?: DistillAttempts
  /**
   * The request constructor the distiller uses, given the attempts registry it
   * registers each request with. `decide` passes the same constructor through
   * its parking seam, so the request the hook drains is the one the timed-out
   * decision identifies.
   */
  distillRequestOptions?: (attempts: DistillAttempts) => (request: DistillRequest) => object
  /**
   * The effective provider/model of the session's latest model request.
   *
   * The selector request must inherit the boundary request's route; this hook
   * has no `GenerateOptions` of its own, so 23c-2 captures it from the
   * `agent/request` waterfall and exposes it here. Missing means the selector
   * cannot run and `ask-selector` records an abstention.
   */
  selectorRoute?: (sessionId: string) => SelectorRoute | undefined
  /** Parsed plans per session, written by 23c's stream hook. */
  plans?: Map<string, Plan>
  /**
   * The per-session receipt/dispatch store. Optional so 23c can own the
   * instance and call `clear(sessionId)` on a session-end signal; when omitted,
   * `registerHooks` creates one. Lifetime: the store keeps one host turn's
   * receipts and in-flight dispatches per session, folds them on the first call
   * of a new turn, and otherwise retains the last turn until `clear` (or process
   * exit). The class documents the reasoning.
   */
  sessionState?: ReceiptSessionState
  /** The host spill backend; absent skips apply-mode projection. */
  spill?: SpillBackend
  /**
   * Session → spill locators of the receipts this plugin projected.
   *
   * Its only producer is a real spill write (design §5.3): the applied outcome
   * carries the locator, and a later `read`/`grep` naming it becomes a
   * `projection-retrieval` receipt whose cost is subtracted from the projection
   * net. Optional so a minimal assembly degrades to uncounted retrievals rather
   * than crashing; `apply` constructs one and `clearSession` drops a session's
   * set on disposal.
   */
  retrievals?: RetrievalLedger
  /**
   * Projection skip counters (Task 25 review).
   *
   * `projectDecision` increments the unknown-family counter when a tool name has
   * no configured family, so status can distinguish "no window, by design"
   * from "the mapper missed a decorated name".
   */
  projectionCounters?: ProjectionCounters
  /**
   * Token estimator; absent means no meter.
   *
   * Projection still clips, but records `estimate:'unknown'` and no token
   * numbers; substitution is refused before it can spend money (design §9).
   */
  estimateText?: (t: string) => number
  /**
   * Which estimator produced a projection receipt's numbers.
   *
   * `host` means the synchronous host token meter priced it. `unknown` is the
   * only meterless value: a projection without a meter still clips, but its
   * receipt carries `estimate:'unknown'` and no numbers at all. There is
   * deliberately no characters-over-four arm — a fixed-density guess is not a
   * measurement, and admitting the type would let a future producer stamp a
   * fabricated figure as if the host had measured it.
   */
  estimateKind?: 'host' | 'unknown'
  /**
   * The host spill-notice predicate, injected instead of imported.
   *
   * Kept because the host spill policy is not declared as a dependency at all and a
   * test needs to hand over a throwing predicate without the host package.
   * Production omits it and the dynamically imported host function is used.
   */
  hasSpillNotice?: (text: string) => boolean
  /**
   * The host spill footer renderer, injected instead of imported.
   *
   * The same seam and the same reason as {@link hasSpillNotice}: the notice
   * module is reached by `import()` only, and a test must be able to exercise
   * the "module absent" path (which disables apply-mode projection) without
   * uninstalling the host package. Returning `undefined` means the module has
   * no renderer; production omits this and the dynamically imported host
   * function is used.
   */
  resolveFooter?: () => FormatFooter | undefined | Promise<FormatFooter | undefined>
  /**
   * The session's runtime replay horizon (design §5.3), when the assembly can
   * supply it.
   *
   * The horizon is `min(config horizon, mean of the session's last
   * `historyTurns` turns)`. Its instance (`RuntimeStepHorizon`) is built in
   * `src/index.ts` and read there by `status`; the decision path can only see
   * it through this seam. A projection receipt pins whatever this returns, so
   * a historical saving is never re-valued by a later cross-session minimum.
   * Absent (the current production wiring) means the resolved config's
   * `horizonSteps` is the horizon in effect.
   */
  horizonFor?: (sessionId: string) => number
  /**
   * Drop the per-session dispatch mirror on disposal.
   *
   * `clearSession` lives in the stream hook and the mirror lives here, so the
   * teardown reaches it through this seam rather than exporting the map. Wired
   * by `apply`; absent in tests, which is why it is optional and guarded.
   */
  clearAcceptedDispatch?: (sessionId: string) => void
  /**
   * Mirror a synthesized turn for a possible rollover settlement (row 27).
   *
   * `llm/stream` owns the synthesis but the mirror lives here next to the
   * execute-side record, so the fact crosses on a seam rather than by exporting
   * the map. It is written at synthesis time, not at dispatch acceptance: a
   * call denied by `tools/pre-execute` never reaches `tools/execute`, and the
   * skipped model round must still be reported when a late result rolls the
   * turn over. `registerHooks` wires it; absent means the mirror stays
   * execute-only (under-report, never a false saving).
   */
  noteSynthesis?: (
    sessionId: string,
    turn: number,
    candidateId: string,
    evidence: SubstitutionEvidence | undefined,
  ) => void
  /**
   * The host logger, for the few conditions that have no other surface.
   *
   * `registerHooks` fills it from `ctx.logger` when absent, so production never
   * passes it explicitly. A missing footer renderer is the one current caller:
   * it logs once, and `status` reports the same condition as a stable code.
   */
  logger?: { warn(message: string): void }
}

/** The execution facts a `tools/post-execute` listener reads here. */
type PostExecuteExec = {
  name?: string
  callId?: string
  agent?: AgentLike | undefined
  /**
   * The host's cancellation signal. `tools/post-execute` is async, and the
   * host contract requires async listeners to observe `exec.signal`; this
   * listener reads `aborted` before it does any projection work.
   */
  signal?: AbortSignalLike | undefined
  /** Parsed tool arguments; the retrieval matcher reads them (Task 25). */
  arguments?: unknown
  /**
   * The step's resolved tool admission (`dsh-tools`' `ResolvedToolSet`).
   *
   * A real model step always has one: the host's pipeline builds the execution
   * as `...toolSet === void 0 ? {} : { toolSet }`. It is optional here because
   * embedded/legacy call sites can omit it, and the decision path records
   * `substitute-skipped:no-toolset` rather than refusing (row 7).
   */
  toolSet?: ResolvedToolSet
  /**
   * PTC transport token. Present on an SDK sub-dispatch (`tools/execute` and
   * `tools/post-execute` run for inner calls too), where the result belongs to
   * the enclosing `run_code` step and is not the step's root receipt.
   */
  parent?: unknown
}

/** The normalized result fields canonicalisation reads. */
type PostExecuteResult = {
  content?: ReadonlyArray<{ type: string; text?: string }> | undefined
  isError?: boolean | undefined
}

/**
 * A post-execute decision.
 *
 * Only `kind` is interpreted here; every other field belongs to the host
 * contract (`accept` with content/value, or `block`).
 */
type PostExecuteDecision = {
  kind: 'accept' | 'block'
  [key: string]: unknown
}

/** The dispatch fields the tamper check reads (the host passes a `ToolExecution`). */
type DispatchExec = {
  name: string
  arguments: unknown
  /** Host-issued call id; compared here because `rejectIfTampered` never sees it. */
  callId?: string
  agent?: AgentLike | undefined
  /**
   * PTC transport token. An inner call belongs to the enclosing `run_code`
   * step: its host-assigned call id is not the root decision's, so the
   * tamper check must not read a collision as our dispatch (row 30).
   */
  parent?: unknown
}

/** Everything one decision pass needs, computed once by the listener. */
type DecisionContext = {
  sessionId: string
  exec: PostExecuteExec
  receipt: CanonicalReceipt
  doc: ScopeDoc
  result: PostExecuteResult | undefined
  state: ReceiptSessionState
  turn: number
  /** The tool call itself names one of this session's spill locators. */
  retrievalCall?: boolean
}

/** Skip reasons that mean the projection machinery degraded, not "nothing to cut". */
const PROJECTION_DEGRADATIONS: ReadonlySet<string> = new Set([
  'no-spill',
  // `no-owner` is emitted by `projectApply`'s direct-call contract, not by this
  // hook (design §5.4): the hook only calls it once an owner is known. Kept so
  // a future caller cannot silently lose the mapping.
  'no-owner',
  'projection-skipped:no-footer',
  'spill-failed',
  'footer-failed',
])

/** The judgement-cache key carried by the assembly context's `scope`. */
function agentKeyOf(scope: unknown): string | undefined {
  const id = (scope as AgentLike | undefined)?.session?.header?.id
  return typeof id === 'string' ? id : undefined
}

/** The session a hook call belongs to, or `undefined` when the host supplied none. */
function sessionIdOf(exec: PostExecuteExec | DispatchExec | undefined): string | undefined {
  const id = (exec as PostExecuteExec | undefined)?.agent?.session?.header?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * Whether the host cancelled the call that produced this result.
 *
 * `tools/post-execute` is async, and the host contract (`dsh-tools`'
 * `events.d.ts`) requires async listeners to observe `exec.signal`. A
 * cancelled call's result never reaches the model, so projecting it would pay
 * a spill write and persist an artifact nobody can read. The signal crosses
 * the host boundary, so a malformed one means "not cancelled" rather than a
 * reason to throw out of the hook.
 */
function cancelled(exec: PostExecuteExec | undefined): boolean {
  try {
    return exec?.signal?.aborted === true
  } catch {
    return false
  }
}

/**
 * The protocol section's synchronous provider.
 *
 * It may only read the cached judgement: the host assembles prompts
 * synchronously, so there is nothing to await. A missing store, a store without
 * `judgement`, a context without `scope`, and a scope without a session id all
 * mean "inject nothing" (fail-closed, design §5.5).
 */
function protocolText(scope: ScopeStore | undefined, context: { scope?: unknown }): string {
  if (scope == null || typeof scope.judgement !== 'function') return ''
  const key = agentKeyOf(context?.scope)
  if (key === undefined) return ''
  return scope.judgement(key) ? PROTOCOL_TEXT : ''
}

// ---------------------------------------------------------------------------
// Defensive readers: every foreign call is wrapped
// ---------------------------------------------------------------------------

/**
 * The host step index, or `undefined` when no clock can supply one.
 *
 * `undefined` is fail-closed: the decision path refuses to invent a step
 * (a plugin-side counter would collide two substitutions in one turn — T23a).
 */
function clockStepOf(deps: HookDeps, sessionId: string): number | undefined {
  try {
    const step = sessionClock(deps, sessionId)?.step()
    return typeof step === 'number' && Number.isFinite(step) ? step : undefined
  } catch {
    return undefined
  }
}

/** The session's anchors without ever failing the call. */
function pendingAnchorsOf(deps: HookDeps, sessionId: string): ReceiptAnchors | undefined {
  try {
    return deps.anchors?.get(sessionId)
  } catch {
    return undefined
  }
}

/**
 * The only invalidation branch that is live at this call site: the prune marker.
 *
 * `invalidate` also compares the anchor text, but a `tools/post-execute` receipt
 * is a *different* call's body, so that comparison can never establish the
 * anchored receipt's identity here; it would fire `compaction-reset` after every
 * commit, drop the anchors obligation 10 exists to keep for 23c, and skip one
 * decision (review F1). The anchor branch belongs on the model-request path
 * (`llm/stream`, 23c), where the compared text is the anchored receipt's current
 * body in the outgoing messages.
 */
function markerResetOf(receiptText: string): 'pruned-reset' | undefined {
  try {
    return looksPruned(receiptText) ? 'pruned-reset' : undefined
  } catch {
    return undefined
  }
}

/** Write one ledger record, keyed to the session and host turn. */
function ledgerEntry(
  ctx: DecisionContext,
  kind: 'shadow' | 'projection' | 'skip',
  code: string,
  extra: Record<string, unknown> = {},
): ReceiptInput {
  return {
    version: 1,
    ts: new Date().toISOString(),
    sessionId: ctx.sessionId,
    turn: ctx.turn,
    kind,
    code,
    ...(typeof ctx.exec.name === 'string' ? { tool: ctx.exec.name } : {}),
    // The operator's evidence line: the canonical receipt head and the executed
    // args. Without args every same-tool/same-turn receipt hashed identically
    // (stepId is always 'root').
    preview: previewOf(ctx.receipt.text),
    ...(ctx.exec.arguments !== undefined ? { args: ctx.exec.arguments } : {}),
    ...extra,
  }
}

/**
 * Caps on the plan evidence a substitution receipt carries.
 *
 * G2 (design line 71) requires the receipt to answer "why was the model not
 * asked" with 计划、守卫、绑定、回执、节省量; without the plan and the guards an
 * auditor sees what ran but not why it was legitimate. The plan is
 * model-written text though, and a receipt is one line: 256 code points of
 * goal (the same order as `preview`), at most 8 guards, and at most 300 code
 * points per guard. The bound is a *code-point* cap, not a byte cap: one
 * pathological plan can contribute up to ~9.6 KB from the guards alone
 * (8 × 300 code points × 4 UTF-8 bytes for 4-byte characters) plus up to
 * ~1 KB from the 256-code-point goal. That is bounded and auditable, but a
 * receipt line can exceed 10 KB — status and readers must not assume 2.7 KB.
 * Truncation is always visible: the goal ends in `…`, an oversized guard
 * becomes `{truncated_json: "…"}`, and `guards_total` is present whenever
 * guards were left out.
 */
const MAX_RECEIPT_PLAN_CODE_POINTS = 256
const MAX_RECEIPT_GUARDS = 8
const MAX_RECEIPT_GUARD_CODE_POINTS = 300

/** What a substitute, substitute-settled or shadow receipt adds about its plan. */
export interface SubstitutionEvidence {
  /** The plan's goal, capped to {@link MAX_RECEIPT_PLAN_CODE_POINTS}. */
  plan: string
  /** The committed candidate's guards, up to {@link MAX_RECEIPT_GUARDS}. */
  guards: unknown[]
  /** The plan's guard count, present only when `guards` was capped. */
  guards_total?: number
}

/**
 * A queued entry carrying the evidence the synth-time receipt needs.
 *
 * `PendingEntry` is the one object that travels from the commit (post-execute)
 * to synthesis (llm-stream), so the evidence rides on it; the settle afterwards
 * reads it back from the ledger pairing. The extra field is additive and never
 * dispatched: `synthesizeTurn` reads `name`/`args` only.
 */
export type AuditedPendingEntry = PendingEntry & { evidence?: SubstitutionEvidence }

/** Cap a string by code point so a surrogate pair is never split. */
function capText(value: string, cap: number): string {
  const points = Array.from(value)
  if (points.length <= cap) return value
  return `${points.slice(0, Math.max(0, cap - 1)).join('')}…`
}

/**
 * The plan/goal and guard evidence for one committed candidate.
 *
 * Guards are carried as written while they fit. Only a guard whose own JSON
 * exceeds {@link MAX_RECEIPT_GUARD_CODE_POINTS} (a multi-KB `text_contains`,
 * say) is replaced by a `truncated_json` marker, so the array stays bounded
 * without silently dropping the guard's form.
 */
export function substitutionEvidence(
  goal: unknown,
  guards: readonly Guard[],
): SubstitutionEvidence {
  const carried = guards.slice(0, MAX_RECEIPT_GUARDS).map((guard) => {
    const json = JSON.stringify(guard) ?? ''
    return Array.from(json).length <= MAX_RECEIPT_GUARD_CODE_POINTS
      ? guard
      : { truncated_json: capText(json, MAX_RECEIPT_GUARD_CODE_POINTS) }
  })
  return {
    plan: capText(typeof goal === 'string' ? goal : '', MAX_RECEIPT_PLAN_CODE_POINTS),
    guards: carried,
    ...(guards.length > MAX_RECEIPT_GUARDS ? { guards_total: guards.length } : {}),
  }
}

/**
 * Append one `skip:no-scope` receipt.
 *
 * The no-agent case has no session id and no turn; the empty session id and
 * turn zero are honest placeholders, and the `code` is the field status counts.
 */
async function appendSkipNoScope(
  receipts: ReceiptStore | undefined,
  exec: PostExecuteExec | undefined,
  sessionId = '',
  turn = 0,
): Promise<void> {
  if (receipts == null || typeof receipts.append !== 'function') return
  try {
    await receipts.append({
      version: 1,
      ts: new Date().toISOString(),
      sessionId,
      turn,
      kind: 'skip',
      code: 'skip:no-scope',
      tool: exec?.name,
    })
  } catch {
    // A receipt is evidence, not a precondition: never break the call for it.
  }
}

/** Append one invalidation receipt; a receipt failure never breaks the call. */
async function appendResetReceipt(
  receipts: ReceiptStore | undefined,
  exec: PostExecuteExec | undefined,
  sessionId: string,
  turn: number,
  stepId: string,
  code: 'pruned-reset' | 'compaction-reset',
): Promise<void> {
  if (receipts == null || typeof receipts.append !== 'function') return
  try {
    await receipts.append({
      version: 1,
      ts: new Date().toISOString(),
      sessionId,
      turn,
      stepId,
      kind: 'reset',
      code,
      tool: exec?.name,
    })
  } catch {
    // A receipt is evidence, not a precondition: never break the call for it.
  }
}

/**
 * Abandon the pending decision after an external rewrite.
 *
 * Only the plugin's own anchor record is touched — the session log's current
 * body is never read (design §5.2-7). Clearing happens before the receipt write
 * so a stalled store cannot leave the stale anchors in place; both steps are
 * contained so the tool result survives.
 *
 * The decision-time usage mark is settled **without** a settlement receipt
 * first, exactly like `applyAbandon`: the substitution was never synthesized,
 * so there is no saving to report. Leaving the mark would let the next real
 * request pair itself with it and write a `substitute-settled` line for a
 * substitution that never ran (row 1).
 */
async function resetInvalidatedPending(
  deps: HookDeps,
  exec: PostExecuteExec | undefined,
  sessionId: string,
  turn: number,
  pending: ReceiptAnchors,
  code: 'pruned-reset' | 'compaction-reset',
): Promise<void> {
  // Design §5.2-7: a reset returns to the slow path *and* empties pending, so no
  // queued substitution can fire from anchors that no longer name live text. The
  // plan is dropped too: it was written for the invalidated receipt, and leaving
  // it would let it fire against a later one. A dispatch accepted for the
  // invalidated decision must not settle a later mark that reuses its id.
  clearAcceptedDispatch(deps, sessionId)
  settleDiscarded(deps, sessionId)
  clearAnchors(deps, sessionId)
  clearPending(deps, sessionId)
  clearPlan(deps, sessionId)
  await appendResetReceipt(deps.receipts, exec, sessionId, turn, pending.stepId, code)
}

/**
 * The host's spill-notice predicate, resolved at most once per process.
 *
 * The spill policy is never declared as a dependency (design §5.4), so its notice module is
 * imported dynamically: a static import would make the plugin fail to load on
 * a host without it. A missing package means no receipt can carry its footer,
 * so the guard simply does not fire. The deps seam wins, which is what keeps
 * the guard testable without the host.
 */
let noticePredicate: Promise<((text: string) => boolean) | undefined> | undefined

function resolveNoticePredicate(
  deps: HookDeps,
): Promise<((text: string) => boolean) | undefined> {
  if (typeof deps.hasSpillNotice === 'function') return Promise.resolve(deps.hasSpillNotice)
  noticePredicate ??= import('@deepseek-ai/dsh-spill-policy/notice')
    .then((module) => (typeof module.hasSpillNotice === 'function' ? module.hasSpillNotice : undefined))
    .catch(() => undefined)
  return noticePredicate
}

/**
 * The host's spill footer renderer, resolved lazily.
 *
 * `projectApply` cannot statically import the spill policy for the same reason
 * the notice predicate cannot. A missing package makes apply-mode projection
 * degrade to `projection-skipped:no-footer` in `projectApply` itself — and,
 * because that turns the plugin's headline feature off, the first resolution
 * that yields nothing is logged once (never per receipt, which would drown the
 * log of a busy session). `status` maps the same receipt code to
 * `ERR_HOST_NO_SPILL_NOTICE`, so the degradation also reaches the operator who
 * never reads the log.
 */
let footerFormatter: Promise<FormatFooter | undefined> | undefined
/** One warning per process; a missing host module is not a per-call event. */
let footerMissingLogged = false

/** Log the missing-footer degradation once; a foreign logger must not throw. */
function noteMissingFooter(deps: HookDeps): void {
  if (footerMissingLogged) return
  footerMissingLogged = true
  try {
    deps.logger?.warn?.(
      'dsh-boost: ERR_HOST_NO_SPILL_NOTICE: @deepseek-ai/dsh-spill-policy/notice resolved no formatSpillNotice; ' +
        'apply-mode projection is disabled (projection-skipped:no-footer) until the host spill policy is available',
    )
  } catch {
    // A logger failure must not become a tool failure.
  }
}

function resolveFooterFormatter(deps: HookDeps): Promise<FormatFooter | undefined> {
  // The seam wins over the memoised import, exactly like `hasSpillNotice`: a
  // test states "the module resolved nothing" without uninstalling the host
  // package. It is deliberately not memoised — it belongs to one deps object.
  if (typeof deps.resolveFooter === 'function') {
    return Promise.resolve()
      .then(() => deps.resolveFooter?.())
      .then((formatter) => {
        if (formatter === undefined) noteMissingFooter(deps)
        return formatter
      })
      .catch(() => {
        noteMissingFooter(deps)
        return undefined
      })
  }
  footerFormatter ??= import('@deepseek-ai/dsh-spill-policy/notice')
    .then((module) => {
      if (typeof module.formatSpillNotice !== 'function') return undefined
      return (omitted: { kind: 'exact'; count: number }, ref: SpillHandle) =>
        // T6's `SpillBackend` widens the host's branded `SpillLocator` to
        // `string`; the value is the same at runtime.
        module.formatSpillNotice(
          omitted,
          ref as unknown as Parameters<typeof module.formatSpillNotice>[1],
        )
    })
    .catch(() => undefined)
    .then((formatter) => {
      if (formatter === undefined) noteMissingFooter(deps)
      return formatter
    })
  return footerFormatter
}

/**
 * The canonical text of the decision that will enter history, when it carries
 * a content array.
 *
 * The host spill policy registers with `{ prepend: true }`: it calls `next()`
 * and applies its footer to *that* decision, so the footer lives in
 * `decision.content` and never in the `result.content` this listener received.
 * `undefined` means "the decision carries no content"; the caller then falls
 * back to the receiver as it arrived.
 */
function decisionTextOf(decision: PostExecuteDecision): string | undefined {
  const content = decision.content
  if (!Array.isArray(content)) return undefined
  return canonicalise(content as ReadonlyArray<{ type: string; text?: string }>, false).text
}

/**
 * Whether projection must be skipped because the host already spilled this
 * receipt (design §5.4).
 *
 * A predicate that throws counts as "already spilled": when the notice cannot
 * be ruled out, a second projection could hide the original twice, so the safe
 * direction is to leave the receipt alone.
 */
async function isAlreadySpilled(deps: HookDeps, receiptText: string): Promise<boolean> {
  try {
    const hasNotice = await resolveNoticePredicate(deps)
    return hasNotice !== undefined && alreadySpilled(receiptText, hasNotice)
  } catch {
    return true
  }
}

/** Whether the plugin is active for this session (fail-closed on any doubt). */
function isActiveSession(deps: HookDeps, sessionId: string): boolean {
  const scope = deps.scope
  if (scope == null || typeof scope.judgement !== 'function') return false
  try {
    return scope.judgement(sessionId)
  } catch {
    return false
  }
}

/**
 * The live scope document, or the strict default when it cannot be read.
 *
 * Read once per decision pass rather than cached: `boost` writes the document
 * while the plugin runs, and the projection/shadow switches must follow it. A
 * missing or throwing reader degrades to `DEFAULT_SCOPE`, whose `shadow: true`
 * makes the substitution path record-only — the safe direction.
 */
async function scopeDocOf(deps: HookDeps): Promise<ScopeDoc> {
  try {
    const read = deps.scope?.read
    if (typeof read !== 'function') return DEFAULT_SCOPE
    const result = await read.call(deps.scope)
    const raw = (result as { doc?: unknown } | undefined)?.doc
    if (raw === null || typeof raw !== 'object') return DEFAULT_SCOPE
    return raw as ScopeDoc
  } catch {
    return DEFAULT_SCOPE
  }
}

// ---------------------------------------------------------------------------
// Retrieval accounting
// ---------------------------------------------------------------------------

/** The calls that can retrieve a spilled artifact (design §5.3). */
const RETRIEVAL_TOOLS: ReadonlySet<string> = new Set(['read', 'grep'])

/** A detected retrieval, held until the final visible content is known. */
type PendingRetrieval = { locator: string }

/**
 * Detect a retrieval without writing anything yet.
 *
 * Detection has to happen before the visibility gate (a projected receipt
 * consumed context whether or not the workspace is still visible), but the
 * cost must wait until projection has decided what the model will actually
 * see (review I3). The split keeps both properties.
 */
function pendingRetrievalOf(
  deps: HookDeps,
  exec: PostExecuteExec,
  sessionId: string,
): PendingRetrieval | undefined {
  try {
    const name = exec?.name
    if (typeof name !== 'string' || !RETRIEVAL_TOOLS.has(name)) return undefined
    const ledger = deps.retrievals
    if (ledger == null || typeof ledger.locate !== 'function') return undefined
    const locator = ledger.locate(sessionId, exec.arguments)
    return locator === undefined ? undefined : { locator }
  } catch {
    return undefined
  }
}

/**
 * The one-time cost of one retrieval, or `undefined` when it cannot be priced.
 *
 * This is the **per-receipt** figure: the call block (name + arguments) plus
 * the content the model saw. The replay multiplier is applied once, to both
 * sides of the net formula, in `status` — multiplying only the cost by the
 * horizon made a cheap partial re-read look like a loss (review C1).
 *
 * `content` is the decision's final visible text, so a retrieval that is itself
 * projected is charged for the window, not the raw result (review I3). A
 * missing/non-finite estimate is omitted rather than fabricated.
 */
function retrievalCostOf(
  deps: HookDeps,
  exec: PostExecuteExec,
  content: string,
): { callTokens: number; contentTokens: number; totalTokens: number } | undefined {
  const estimate = estimatorOf(deps)
  if (estimate === undefined) return undefined

  const contentTokens = safeEstimate(estimate, content)
  if (contentTokens === undefined) return undefined

  let params = ''
  try {
    params = JSON.stringify(exec.arguments) ?? ''
  } catch {
    params = ''
  }
  const callTokens = safeEstimate(estimate, `${exec.name ?? 'tool'} ${params}`)
  if (callTokens === undefined) return undefined

  const totalTokens = callTokens + contentTokens
  return Number.isFinite(totalTokens) ? { callTokens, contentTokens, totalTokens } : undefined
}

/**
 * Count a `read`/`grep` that names one of this session's spill locators.
 *
 * `appendReceipt` is the store's only write path, and `kind:'projection'` with
 * `retrieved:true` is exactly what `boost status` aggregates as
 * `projection_retrievals` and `projection_retrieval_tokens`. No
 * `saved_projection_tokens` is written: this line documents a cost, not
 * another gross saving.
 *
 * `visibleText` is the content that enters history after projection, which is
 * what the model must pay to replay.
 */
async function recordProjectionRetrieval(
  deps: HookDeps,
  exec: PostExecuteExec,
  sessionId: string,
  pending: PendingRetrieval,
  visibleText: string,
): Promise<void> {
  try {
    const name = exec?.name
    if (typeof name !== 'string') return
    const cost = retrievalCostOf(deps, exec, visibleText)
    const entry: ReceiptInput = {
      version: 1,
      ts: new Date().toISOString(),
      sessionId,
      turn: clockTurnOf(deps, sessionId) ?? 0,
      kind: 'projection',
      code: 'projection-retrieval',
      tool: name,
      retrieved: true,
      locator: pending.locator,
      // The visible content replays over this horizon in `status`'s net, so it
      // must be the horizon in effect when the retrieval happened, not one read
      // from the whole ledger later.
      horizon_steps: projectionHorizonOf(deps, sessionId),
      preview: previewOf(visibleText),
      ...(exec.arguments !== undefined ? { args: exec.arguments } : {}),
    }
    if (cost === undefined) {
      entry.estimate = 'unknown'
    } else {
      entry.retrieval_call_tokens = cost.callTokens
      entry.retrieval_content_tokens = cost.contentTokens
      entry.retrieval_tokens = cost.totalTokens
      entry.estimate = deps.estimateKind ?? 'unknown'
    }
    await appendReceipt(deps, entry)
  } catch {
    // A retrieval is evidence, never a precondition of the tool result.
  }
}

// ---------------------------------------------------------------------------
// Admission and the decision branch
// ---------------------------------------------------------------------------

/**
 * The saving of skipping one model step: the last real request's `totalTokens`
 * (`input + cacheRead + output`), which is what design §5.3 defines it as.
 *
 * All three parts are skipped when the model does not run: the replayed context
 * is not sent and the response is not generated. The context only grows as
 * receipts enter it, so the last request is a lower bound. A missing ledger or
 * sample is 0, never an interpolation, so admission falls back to the model when
 * it cannot measure (design §5.3: measured, not estimated).
 */
function savedTokensOf(deps: HookDeps, sessionId: string): number {
  try {
    const last = sessionUsage(deps, sessionId)?.last()
    if (last === undefined) return 0
    const { input, cacheRead, output } = last
    const parts = [input, cacheRead, output]
    if (parts.some((part) => !Number.isFinite(part) || part < 0)) return 0
    const total = input + cacheRead + output
    return Number.isFinite(total) ? total : 0
  } catch {
    return 0
  }
}

/**
 * Whether this commit clears the admission threshold.
 *
 * A plan with exactly one candidate is the design's deterministic-single
 * exemption: there is no selector call to pay for, so the threshold does not
 * apply. Any other plan pays no selector either once only one candidate
 * survives, but it still has to show a net win over the threshold; the
 * conservative direction here is to keep the gate on.
 */
function admittedFor(
  deps: HookDeps,
  sessionId: string,
  plan: Plan,
  overheadTokens: number,
): boolean {
  try {
    const threshold = deps.config?.admission?.thresholdTokens
    const thresholdTokens =
      typeof threshold === 'number' && Number.isFinite(threshold)
        ? threshold
        : DEFAULT_CONFIG.admission.thresholdTokens
    return worthSubstituting({
      savedTokens: savedTokensOf(deps, sessionId),
      overheadTokens,
      thresholdTokens,
      deterministicSingle: plan.steps.length === 1,
    })
  } catch {
    return false
  }
}

/**
 * Whether the session's turn budget is already empty, without consuming it.
 *
 * A selector call is real spend, so this check runs before the selector is
 * priced or called; the consuming `takeBudget` stays at the commit point.
 * `undefined` from `sessionBudget` has two different meanings (row 21): no
 * budget is wired at all (no cap), or one is wired but was not lent to this
 * session (exhausted, fail closed). Shadow mode never calls this: it spends no
 * step.
 */
function budgetExhausted(deps: HookDeps, sessionId: string): boolean {
  try {
    const budget = sessionBudget(deps, sessionId)
    if (budget == null) return budgetWired(deps)
    if (typeof budget.exhausted !== 'function') return false
    return budget.exhausted() === true
  } catch {
    return budgetWired(deps)
  }
}

/**
 * Claim one budget step.
 *
 * No budget wired means no cap is applied. A wired budget that this session may
 * not borrow is a refusal, not "no cap": `take` fails and the caller records
 * `steps-exhausted` without enqueueing (row 21).
 */
function takeBudget(deps: HookDeps, sessionId: string): boolean {
  try {
    const budget = sessionBudget(deps, sessionId)
    if (budget == null) return !budgetWired(deps)
    if (typeof budget.take !== 'function') return true
    return budget.take()
  } catch {
    return false
  }
}

/** Record the substitution for the usage pairing; the stream hook settles it. */
function markSubstituted(deps: HookDeps, sessionId: string, candidateId: string): void {
  try {
    sessionUsage(deps, sessionId)?.markSubstituted(candidateId)
  } catch {
    // A ledger miss costs a measurement, never this call.
  }
}

/** The session's pending usage-mark candidate, or `undefined` for a foreign ledger. */
function pendingCandidateOf(deps: HookDeps, sessionId: string): string | undefined {
  try {
    return sessionUsage(deps, sessionId)?.pendingCandidateId()
  } catch {
    return undefined
  }
}

/**
 * The last substitution dispatch `tools/execute` accepted for a session.
 *
 * `ReceiptSessionState` records the same callId -> candidate mapping, but the
 * candidate's own `tools/post-execute` consumes it when it files the receipt.
 * A turn rollover needs the fact *after* that consumption: a late parallel
 * tool result can roll the turn before the next real request, and the usage
 * mark must then be reported instead of discarded as if nothing ran. The
 * accepted dispatch is mirrored here together with the evidence that would
 * otherwise be parked for the next settlement.
 *
 * One record per session: a later accepted dispatch (or a later synthesis)
 * replaces it, a session whose usage mark is already gone drops it, and a
 * rollover consumes it. The `HookDeps` key keeps two assemblies in one process
 * from reading each other's sessions. The record is small and per-session; it
 * is never persisted. It is also written at synthesis time through
 * {@link HookDeps.noteSynthesis}: a dispatch denied by `tools/pre-execute`
 * never reaches `tools/execute`, and that skipped model round must still be
 * reportable at a rollover (row 27).
 */
const ACCEPTED_DISPATCH = new WeakMap<
  HookDeps,
  Map<string, { turn: number; candidateId: string; evidence?: SubstitutionEvidence }>
>()

/** Mirror an accepted dispatch for a possible rollover settlement. */
function noteAcceptedDispatch(
  deps: HookDeps,
  sessionId: string,
  turn: number,
  candidateId: string,
  evidence: SubstitutionEvidence | undefined,
): void {
  let bySession = ACCEPTED_DISPATCH.get(deps)
  if (bySession === undefined) {
    bySession = new Map()
    ACCEPTED_DISPATCH.set(deps, bySession)
  }
  bySession.set(sessionId, {
    turn,
    candidateId,
    ...(evidence === undefined ? {} : { evidence }),
  })
}

/**
 * Consume the accepted dispatch that matches `candidateId`, if any.
 *
 * The turn check is a staleness guard: the record that a pending mark belongs
 * to was written in the turn now rolling over. A record written in the new
 * turn cannot belong to it. The record's own turn is returned so the settled
 * receipt pairs with the dispatch, not with the rollover (row 26).
 */
function takeAcceptedDispatch(
  deps: HookDeps,
  sessionId: string,
  candidateId: string,
  turn: number,
): { turn: number; evidence?: SubstitutionEvidence } | undefined {
  const bySession = ACCEPTED_DISPATCH.get(deps)
  const record = bySession?.get(sessionId)
  bySession?.delete(sessionId)
  if (record === undefined || record.candidateId !== candidateId || record.turn === turn) {
    return undefined
  }
  return record.evidence === undefined
    ? { turn: record.turn }
    : { turn: record.turn, evidence: record.evidence }
}

/** Drop the mirrored dispatch; no pending mark is waiting to settle it. */
export function clearAcceptedDispatch(deps: HookDeps, sessionId: string): void {
  ACCEPTED_DISPATCH.get(deps)?.delete(sessionId)
}

/**
 * Settle the usage mark at a turn rollover, reporting a substitution that ran.
 *
 * The ordinary path settles at the first real request after synthesis. A late
 * parallel tool result can roll the turn before that request; the mark must not
 * survive into the new turn, where it would pair with a request that is not the
 * substitution's next one. If `tools/execute` never accepted the synthesized
 * dispatch, the substitution did not run and the mark is a discard. If it did
 * — or if the synthesis itself was mirrored before a `tools/pre-execute`
 * denial (row 27) — the model round really was skipped: the settlement line is
 * written with whatever sample the ledger holds (`'unknown'` when no after-mark
 * request has run yet), with the evidence captured at dispatch, and with the
 * dispatch turn the mirror recorded rather than the rollover turn (row 26), so
 * the substitution is reported instead of disappearing.
 */
async function settleRollover(deps: HookDeps, sessionId: string, turn: number): Promise<void> {
  const candidateId = pendingCandidateOf(deps, sessionId)
  if (candidateId === undefined) {
    settleDiscarded(deps, sessionId)
    return
  }

  const dispatched = takeAcceptedDispatch(deps, sessionId, candidateId, turn)
  if (dispatched === undefined) {
    settleDiscarded(deps, sessionId)
    return
  }

  let settled: ReturnType<UsageLedger['settle']>
  try {
    const ledger = sessionUsage(deps, sessionId)
    if (ledger === undefined) {
      settleDiscarded(deps, sessionId)
      return
    }
    settled = ledger.settle()
  } catch {
    settleDiscarded(deps, sessionId)
    return
  }

  // The parked evidence lives in `llm-stream`'s private map and would outlive
  // the mark. `settleDiscarded` is the module's idempotent cleanup: the ledger
  // was settled above, so this call only forgets that evidence. It runs before
  // the receipt write so the `await` cannot let a new mark be created and then
  // be consumed by this cleanup.
  settleDiscarded(deps, sessionId)

  await appendReceipt(deps, {
    version: 1,
    ts: new Date().toISOString(),
    sessionId,
    // Row 26: the substitution happened in the dispatch turn the mirror
    // recorded. Stamping the rollover turn paired a turn-1 substitution with a
    // turn-2 settled line, which reads as a saving from the wrong round.
    turn: dispatched.turn,
    stepId: 'root',
    kind: 'substitute-settled',
    code: 'substitute-settled',
    candidateId,
    ...(dispatched.evidence ?? {}),
    saved_input_tokens: settled.saved_input_tokens,
    // Row 7: the same pair of samples also yields the lower estimate; the
    // settled line is the only place a measured saving exists, so both numbers
    // travel together.
    avoided_total_tokens: settled.avoided_total_tokens,
    cache_hit_delta: settled.cache_hit_delta,
    output_tokens: settled.output_tokens,
  })
}

/**
 * The receipt ids a candidate's `$public` templates refer to, plus `'root'`.
 *
 * These are the anchors the invalidation check compares against: the chosen
 * candidate's arguments were computed from those receipts, so if any of them
 * is rewritten externally the decision is stale. The walk is iterative and
 * depth-capped because it runs over model-written args; `parsePlan` already
 * caps them at 64 levels, but the hook must not depend on that.
 */
function referencedReceiptIds(args: unknown): Set<string> {
  const ids = new Set<string>(['root'])
  const stack: Array<{ value: unknown; depth: number }> = [{ value: args, depth: 1 }]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) break
    if (frame.depth > 64) continue
    if (Array.isArray(frame.value)) {
      for (const child of frame.value) {
        if (typeof child === 'object' && child !== null) {
          stack.push({ value: child, depth: frame.depth + 1 })
        }
      }
      continue
    }
    if (typeof frame.value !== 'object' || frame.value === null) continue
    const { $public: template, ...rest } = frame.value as Record<string, unknown>
    if (
      typeof template === 'object' &&
      template !== null &&
      typeof (template as { after?: unknown }).after === 'string'
    ) {
      ids.add((template as { after: string }).after)
    }
    for (const child of Object.values(rest)) {
      if (typeof child === 'object' && child !== null) {
        stack.push({ value: child, depth: frame.depth + 1 })
      }
    }
  }
  return ids
}

/**
 * Store the session's anchors for the committed candidate.
 *
 * `stepId` is `'root'` because the guards and templates were evaluated against
 * the receipt that just arrived; the map carries that receipt's canonical text
 * plus the text of every receipt the candidate's `$public` templates reference
 * (design §5.2-7). Missing references are omitted rather than invented.
 */
function setAnchors(deps: HookDeps, ctx: DecisionContext, candidateArgs: unknown): void {
  try {
    const anchorsStore = deps.anchors
    if (anchorsStore == null || typeof anchorsStore.set !== 'function') return
    const receipts = ctx.state.receiptsFor(ctx.sessionId, ctx.turn)
    const anchors: Record<string, string> = {}
    for (const id of referencedReceiptIds(candidateArgs)) {
      const receipt = receipts.get(id)
      if (receipt !== undefined) anchors[id] = receipt.text
    }
    anchorsStore.set(ctx.sessionId, { stepId: 'root', anchors })
  } catch {
    // Anchors are a guard input, not the guard: losing them costs a reset.
  }
}

/**
 * Whether the session may be substituted for right now.
 *
 * Both gates must agree: the cached judgement said yes (the listener would
 * have returned otherwise), and the live document still lists the session's
 * workspace. The second check cannot be skipped: the cache is refreshed by a
 * different task, and a stale "visible" must never authorize a replacement.
 */
function substitutableSession(deps: HookDeps, sessionId: string, doc: ScopeDoc): boolean {
  try {
    const workspaceId = deps.resolveSession?.(sessionId)
    if (typeof workspaceId !== 'string') return false
    return isVisible(doc, workspaceId)
  } catch {
    return false
  }
}

/**
 * A selector-facing summary of one already-bound candidate.
 *
 * The selector only needs to tell candidates apart; the args are included so
 * two calls to the same tool with different paths are distinguishable. The
 * bound tree is safe to show (it is what will run) and bounded so one huge
 * argument cannot dominate the selector prompt.
 */
function selectorSummary(candidate: Candidate): string {
  let args = ''
  try {
    args = JSON.stringify(candidate.args) ?? ''
  } catch {
    // A model-written plan is already JSON, but the summary is evidence-shaped
    // and must not make the selector call throw.
  }
  const text = `${candidate.tool} ${args}`.trim()
  const points = Array.from(text)
  return points.length > 200 ? `${points.slice(0, 200).join('')}…` : text
}

/** Bound the receipt the selector pays for, using the projection's head/tail shape. */
function selectorReceiptOf(deps: HookDeps, ctx: DecisionContext): string {
  const text = ctx.receipt.text
  const points = Array.from(text)
  if (points.length <= SELECTOR_RECEIPT_MAX_CHARS) return text

  const toolName = ctx.exec.name
  const family = toolName === undefined ? undefined : familyOf(toolName)
  const params = family !== undefined ? deps.config.projection[family] : undefined
  const configured = params !== undefined ? params.headChars + params.tailChars : 0
  const total = Math.min(
    SELECTOR_RECEIPT_MAX_CHARS,
    configured > 0 ? configured : SELECTOR_RECEIPT_MAX_CHARS,
  )
  const ratio = configured > 0 && params !== undefined ? params.headChars / configured : 0.8
  const headChars = Math.min(total, Math.max(0, Math.round(total * ratio)))
  const tailChars = total - headChars
  const head = points.slice(0, headChars).join('')
  const tail = tailChars > 0 ? points.slice(-tailChars).join('') : ''
  const omitted = points.length - headChars - tailChars
  return `${head}\n…[selector window: omitted ${omitted} chars]…\n${tail}`
}

/** The configured selector output budget, with the design default as a fallback. */
function selectorMaxTokens(deps: HookDeps): number {
  const raw = deps.config?.selector?.maxTokens
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_CONFIG.selector.maxTokens
  }
  return Math.floor(raw)
}

/** The route the selector call would inherit, or `undefined` when it cannot run. */
function selectorRouteOf(deps: HookDeps, sessionId: string): SelectorRoute | undefined {
  try {
    const route = deps.selectorRoute?.(sessionId)
    if (
      route === undefined ||
      typeof route.provider !== 'string' ||
      typeof route.model !== 'string'
    ) {
      return undefined
    }
    return route
  } catch {
    return undefined
  }
}

/** Whether the selector is missing its LLM or its effective route. */
function selectorSeamUnavailable(deps: HookDeps, ctx: DecisionContext): boolean {
  const llm = deps.llm
  return llm == null || typeof llm.stream !== 'function' || selectorRouteOf(deps, ctx.sessionId) === undefined
}

/**
 * The selector's fast upper bound: its output cap plus the estimated input.
 *
 * `maxTokens` bounds only the output; everything the request sends is input:
 * the system prompt, the user template, the candidate list and the receipt.
 * Charging only the receipt and the candidates under-counts the call by the
 * prompt (about 60–70 tokens) and makes admission optimistic exactly where it
 * decides whether to call. The priced string is built with the selector's own
 * exported template, so the estimate cannot drift from the request (row 36).
 * `undefined` means the caller cannot price the call; it must not guess.
 */
function selectorChargeOf(
  deps: HookDeps,
  candidates: readonly Candidate[],
  receiptText: string,
): number | undefined {
  const estimate = deps.estimateText
  if (typeof estimate !== 'function') return undefined
  const prompt = selectorPromptText({
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      summary: selectorSummary(candidate),
    })),
    receiptText,
  })
  const input = safeEstimate(estimate, `${SELECTOR_SYSTEM_PROMPT}\n${prompt}`)
  if (input === undefined || input < 0) return undefined
  return selectorMaxTokens(deps) + input
}

/**
 * Ask the selector to pick one of `decision.candidates` and return that same
 * decision candidate, whose `args` are already bound.
 *
 * Never throws and never guesses. A missing LLM seam, a missing route, an
 * abstention or a thrown call all leave the plan untouched and write one
 * `skip` receipt explaining why; the next post-execute may try again. The
 * `SELECTOR_PURPOSE` marker is set by `choose` itself, so the frozen stream
 * hook can recognize and pass the aux request through.
 */
async function chooseCandidate(
  deps: HookDeps,
  ctx: DecisionContext,
  candidates: readonly Candidate[],
  receiptText: string,
): Promise<Candidate | undefined> {
  const llm = deps.llm
  if (llm == null || typeof llm.stream !== 'function') {
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'selector-unavailable', { stepId: 'root' }))
    return undefined
  }

  let route: SelectorRoute | undefined
  try {
    route = deps.selectorRoute?.(ctx.sessionId)
  } catch {
    route = undefined
  }
  if (
    route === undefined ||
    typeof route.provider !== 'string' ||
    typeof route.model !== 'string'
  ) {
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'selector-unavailable', { stepId: 'root' }))
    return undefined
  }

  try {
    const result = await choose({
      llm,
      provider: route.provider,
      model: route.model,
      ...(typeof route.reasoningEffort === 'string'
        ? { reasoningEffort: route.reasoningEffort }
        : {}),
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        summary: selectorSummary(candidate),
      })),
      receiptText,
      maxTokens: deps.config.selector.maxTokens,
    })
    if ('choice' in result) {
      // `candidates` are the decision's copies: their args are the bound tree.
      return candidates.find((candidate) => candidate.id === result.choice)
    }
    // §5.2-3 distinguishes a timeout/no-label abstention from a failed call:
    // `choose` maps its own dispatch failure to `abstain: 'error'`, and that is
    // the `selector-error` branch, not a second abstention reason.
    const code = result.abstain === 'error' ? 'selector-error' : 'selector-abstain'
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', code, { stepId: 'root', reason: result.abstain }),
    )
    return undefined
  } catch {
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', 'selector-error', { stepId: 'root', reason: 'error' }),
    )
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Row 7: the step's admitted tool set
// ---------------------------------------------------------------------------

/**
 * Read this step's admission predicate, or `undefined` when it cannot be
 * verified.
 *
 * `view(scope)` takes the exact requesting agent; the host admits no other
 * scope. A missing `toolSet`, a missing `view` and a throwing `view` are all
 * "no evidence" and take the documented `no-toolset` path: the substitution
 * proceeds and records that it ran without admission evidence. Refusing on
 * absence would silently disable the feature on paths we cannot enumerate,
 * while a real model step always carries one (row 7).
 */
function admissionViewOf(exec: PostExecuteExec | undefined): ((tool: string) => boolean) | undefined {
  const toolSet = exec?.toolSet
  if (toolSet == null || typeof toolSet.view !== 'function') return undefined
  try {
    const view = toolSet.view(exec?.agent)
    if (view == null || typeof view.has !== 'function') return undefined
    return (tool: string) => view.has(tool) === true
  } catch {
    return undefined
  }
}

/**
 * The args as they will arrive from the host.
 *
 * `JSON.stringify` collapses `-0` to `0` and rewrites non-finite numbers to
 * `null`, so a pending tree that skipped this round trip would disagree with
 * its own dispatched call: `sameLiteral` would report tampering and the planned
 * call would never run (review cod#2).
 */
function jsonNormalise(args: Record<string, unknown>): Record<string, unknown> {
  try {
    const text = JSON.stringify(args)
    if (text === undefined) return args
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return args
  } catch {
    return args
  }
}

/**
 * The substitution decision and its side effects.
 *
 * The fixed order is the plan's: existence of a plan and a receipt first, then
 * `worthSubstituting`, then `budget.take()`. The step's admission filter
 * (row 7) runs inside `decide`, before the selector is priced and before the
 * budget is taken; when its evidence is unavailable the commit still happens
 * and a `substitute-skipped:no-toolset` line records that it did.
 * Nothing below spends budget on a decision that will not be dispatched.
 *
 * `ask-selector` is fulfilled here since Task 23c-2: the decision carries only
 * already-bound candidates, so the selector's choice is committed from
 * `decision.candidates[].args` — never from `plan.steps[i].args`, which still
 * holds `$public` templates. The selector call is the plugin's own aux request
 * (`purpose: 'boost-selector'`), so the frozen stream hook passes it through.
 * A missing route or a missing LLM is a record-only abstention, never a guess.
 * `fallback` records the decision code and leaves the pending entry alone: this
 * invocation has enqueued nothing, so any entry it finds belongs to another
 * call, and clearing it would cancel a live substitution in a multi-call step.
 * A plan is **one-shot per receipt**: the first post-execute that reads it
 * removes it from the session map, whatever the outcome (commit, guard
 * failure, selector abstention, no candidate). The protocol says a block
 * describes the next call and may be omitted when unsure; retaining it would
 * let a plan the model has withdrawn fire against a much later receipt. The
 * remaining candidates are not reused either; the model writes a fresh block
 * for the next call (and may still reference an earlier receipt by id).
 *
 * A shadow commit parks nothing, but projection is independent of the shadow
 * flag (design §5.2-5) and still runs in `applyDecision`.
 */
async function decideSubstitution(
  deps: HookDeps,
  ctx: DecisionContext,
): Promise<void> {
  // Fail-closed gate (design §5.2-3): a store that cannot record evidence
  // cannot justify spending a selector call or a budget step. No receipt is
  // attempted here either; the store is already failing, and status exposes
  // `receipts.stopped()` to the operator.
  //
  // The plan is still consumed here. This receipt cannot use it, and a plan is
  // one-shot per receipt: keeping it for a later receipt is exactly the stale
  // plan the one-shot rule exists to prevent. A store that recovers mid-turn
  // would otherwise let the next receipt fire a decision the model wrote for
  // this one.
  if (receiptsStopped(deps)) {
    clearPlan(deps, ctx.sessionId)
    return
  }

  const plan = safePlan(deps, ctx.sessionId)
  if (plan === undefined) return
  // One-shot: capture the plan for this pass, then drop it before any branch can
  // return, so no later receipt can reuse it.
  clearPlan(deps, ctx.sessionId)

  // Design §9: no token meter means no substitution. The meter is what prices
  // `worthSubstituting` and the selector's input, so running without it would
  // spend real money on a fabricated estimate. Refuse before `decide`, before
  // the selector and before admission; shadow mode is record-only and may
  // still run. Projection is not gated (it needs no token numbers to clip).
  const estimator = estimatorOf(deps)
  if (
    !ctx.doc.shadow &&
    (estimator === undefined || safeEstimate(estimator, 'dsh-boost meter probe') === undefined)
  ) {
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', 'ERR_HOST_NO_TOKENMETER', {
        stepId: 'root',
        reason: 'no-token-meter',
      }),
    )
    return
  }

  // Row 7: this step's `ResolvedToolSet` is the host's admission set, so
  // `decide` drops a candidate whose tool it does not admit before the selector
  // or the budget is touched. Shadow mode is record-only and measures potential
  // across the whole whitelist, so it passes no admission filter.
  const admission = ctx.doc.shadow ? undefined : admissionViewOf(ctx.exec)
  const noToolset = !ctx.doc.shadow && admission === undefined

  let decision: ReturnType<typeof decide>
  try {
    decision = decide({
      plan,
      stepId: 'root',
      receipts: ctx.state.receiptsFor(ctx.sessionId, ctx.turn),
      whitelist: SUBSTITUTION_WHITELIST,
      shadow: ctx.doc.shadow,
      ...(admission === undefined ? {} : { admitted: admission }),
    })
  } catch {
    // A throwing gate silently disabled substitution for this receipt, so make
    // it visible in `status.counts` (review row 24). The plan was already
    // consumed above; nothing can fire later from this failure.
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', 'substitute-skipped:gate-error', { stepId: 'root' }),
    )
    return
  }

  // Substitution synthesises a dispatch and expects POSIX process semantics;
  // on Windows it is refused **before** the selector, admission and budget, so
  // the path cannot spend anything to decline. Shadow mode is record-only and
  // stays available: it changes nothing the model sees. The stable operator
  // signal is `boost status`'s `ERR_HOST_PLATFORM_UNSUPPORTED`; this receipt
  // keeps the refusal auditable per call rather than silently doing less.
  if (!isPosixOnly() && !ctx.doc.shadow) {
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', 'substitution-unavailable', {
        stepId: 'root',
        reason: 'platform-unsupported',
      }),
    )
    return
  }

  let candidate: Candidate | undefined
  let boundArgs: Record<string, unknown> | undefined
  let candidateId: string | undefined

  // A selector call pays its output cap plus the input actually sent. A single
  // surviving candidate pays no selector at all. This must run before `choose`:
  // a selector call that cannot be paid for is never sent.
  let selectorOverhead = 0
  let selectorReceiptText = ''
  if (decision.kind === 'ask-selector') {
    // Row 2: the budget is checked before the selector is paid for. Without
    // this, an exhausted step would still send a real model request and then
    // record `steps-exhausted` after the money was spent. Shadow mode is
    // record-only and takes no step, so it keeps measuring.
    if (!ctx.doc.shadow && budgetExhausted(deps, ctx.sessionId)) {
      await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'steps-exhausted', { stepId: 'root' }))
      return
    }
    // Availability is checked before pricing: a missing LLM/route is the
    // `selector-unavailable` degradation, not an admission decision.
    if (selectorSeamUnavailable(deps, ctx)) {
      await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'selector-unavailable', { stepId: 'root' }))
      return
    }
    selectorReceiptText = selectorReceiptOf(deps, ctx)
    const charge = selectorChargeOf(deps, decision.candidates, selectorReceiptText)
    if (charge === undefined) {
      await appendReceipt(
        deps,
        ledgerEntry(ctx, 'skip', 'not-admitted', { stepId: 'root', reason: 'no-estimator' }),
      )
      return
    }
    selectorOverhead = charge
    if (!admittedFor(deps, ctx.sessionId, plan, selectorOverhead)) {
      await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'not-admitted', { stepId: 'root' }))
      return
    }
    // The decision's candidates already carry the bound trees; committing from
    // the plan here would dispatch a `$public` template.
    const chosen = await chooseCandidate(deps, ctx, decision.candidates, selectorReceiptText)
    if (chosen === undefined) return
    candidate = chosen
    boundArgs = chosen.args
    candidateId = chosen.id
  } else if (decision.kind === 'fallback') {
    // This invocation enqueued nothing, so any pending entry belongs to another
    // call in the step; cancelling it would leave the budget spent and usage
    // marked for a substitution that never runs (review F2).
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', decision.code, { stepId: 'root' }))
    return
  } else {
    candidate = plan.steps.find((step) => step.id === decision.candidateId)
    boundArgs = decision.args
    candidateId = decision.candidateId
  }

  if (candidate === undefined || boundArgs === undefined || candidateId === undefined) {
    // decide only commits its own plan's ids; this is containment, not a path.
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'no-candidate', { stepId: 'root' }))
    return
  }

  // The live visibility check runs for the shadow path too: the record-only
  // measurement must describe the same population the real admission would
  // consider, not a broader one (review F2). The cached judgement passed above,
  // but the document may have changed while the session ran.
  if (!substitutableSession(deps, ctx.sessionId, ctx.doc)) {
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'skip:no-scope', { stepId: 'root' }))
    return
  }

  if (ctx.doc.shadow) {
    // Record-only: the same `shadow` flag was passed to `decide` above, so the
    // recorded potential matches the policy that produced it. No queue entry
    // and no budget. Projection is a separate switch and still runs afterwards
    // (design §5.2-5); this branch only stops the substitution side.
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'shadow', 'ok', {
        decision: 'commit',
        candidateId,
        // The executed tool is the model's call; the candidate's tool is what
        // the gate decided. The shadow report's per-family hit rate must use
        // the latter (the shadow receipt's `tool` is the former).
        candidateTool: candidate.tool,
        admitted: admittedFor(deps, ctx.sessionId, plan, selectorOverhead),
        whitelisted: SUBSTITUTION_WHITELIST.has(candidate.tool),
        stepId: 'root',
        args: boundArgs,
        // G2: the plan and the guards are why this candidate was legitimate.
        ...substitutionEvidence(plan.goal, candidate.guards),
      }),
    )
    return
  }

  const step = clockStepOf(deps, ctx.sessionId)
  if (step === undefined) {
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', 'substitution-unavailable', { stepId: 'root', reason: 'no-step' }),
    )
    return
  }
  if (deps.queue == null || typeof deps.queue.set !== 'function') {
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', 'substitution-unavailable', { stepId: 'root', reason: 'no-queue' }),
    )
    return
  }

  if (!admittedFor(deps, ctx.sessionId, plan, selectorOverhead)) {
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'not-admitted', { stepId: 'root' }))
    return
  }

  if (!takeBudget(deps, ctx.sessionId)) {
    // No entry is ours to clear here: this invocation enqueued nothing, so a
    // live entry belongs to another call in the step (review F2).
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'steps-exhausted', { stepId: 'root' }))
    return
  }

  const callId = callIdFor(ctx.sessionId, ctx.turn, step, candidateId)
const entry: AuditedPendingEntry = {
    callId,
    candidateId,
    // The candidate's tool name identifies the call; the executable args are
    // the *decision's* bound tree, never the plan's `$public` template.
    //
    // Normalised through a JSON round trip so the pending tree is byte-for-byte
    // what the host will hand back. `JSON.stringify` rewrites `-0` to `0` and
    // `Infinity`/`NaN` to `null`; without this, a legal plan arg of `-0` would
    // arrive as `0` and `sameLiteral` would report tampering, so the planned
    // call would never run (review cod#2).
    name: candidate.tool,
    args: jsonNormalise(boundArgs),
    turn: ctx.turn,
    step,
    // The plan is one-shot (cleared above), so the evidence must travel with
    // the entry: the synth-time receipt is written after this turn's plan is
    // gone, and the settled receipt only knows the candidate id.
    evidence: substitutionEvidence(plan.goal, candidate.guards),
  }
  try {
    deps.queue.set(ctx.sessionId, entry)
  } catch {
    await appendReceipt(
      deps,
      // The step was already taken and this receipt is the only evidence that
      // it bought no substitution; a throwing queue must not also hide the cost.
      ledgerEntry(ctx, 'skip', 'substitution-unavailable', {
        stepId: 'root',
        reason: 'queue-failed',
        budget: 'spent',
      }),
    )
    return
  }

  // Row 7: the commit is real but the admission evidence was not available.
  // Recording it here (not at the missing-evidence point above) means the note
  // names the candidate that actually committed and only exists when one did.
  if (noToolset) {
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', 'substitute-skipped:no-toolset', {
        stepId: 'root',
        candidateId,
      }),
    )
  }

  markSubstituted(deps, ctx.sessionId, candidateId)
  // Anchors name the templates the executed call was bound from: the decision's
  // args are already expanded, so only the plan copy still carries the
  // `$public` references. That tree is inspected here, never dispatched.
  setAnchors(deps, ctx, plan.steps.find((step) => step.id === candidateId)?.args ?? boundArgs)
  return
}

/** The session's plan, or `undefined` when none is known (or the map is foreign). */
function safePlan(deps: HookDeps, sessionId: string): Plan | undefined {
  try {
    const plans = deps.plans
    if (plans == null || typeof plans.get !== 'function') return undefined
    const plan = plans.get(sessionId)
    if (plan === undefined || plan === null) return undefined
    // A spent plan has nothing left to decide; skipping the call also avoids a
    // `guard-trivial` receipt on every later tool call of the turn.
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) return undefined
    return plan
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** The text projection may replace, or `undefined` when it must stay intact. */
function projectionTargetOf(
  decision: PostExecuteDecision,
  receipt: CanonicalReceipt,
  result: PostExecuteResult | undefined,
): string | undefined {
  // A `value` replacement cannot be combined with `content`: the host throws a
  // TypeError for both, which would replace the tool result with an error.
  if (Object.hasOwn(decision, 'value')) return undefined
  if (decision.kind !== 'accept') return undefined

  if (Object.hasOwn(decision, 'content')) {
    const content = decision.content
    if (!Array.isArray(content)) return undefined
    // Replacing a multi-block result with one text block is only lossless when
    // every block is text; an image or file block must stay where it is.
    if (!content.every((block) => textBlock(block))) return undefined
    return canonicalise(content as ReadonlyArray<{ type: string; text?: string }>, false).text
  }

  const content = result?.content
  if (content !== undefined && !(Array.isArray(content) && content.every((block) => textBlock(block)))) {
    return undefined
  }
  return receipt.text
}

/** Whether a block is a text block this hook can fold into one string. */
function textBlock(block: unknown): boolean {
  return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
}

/** The estimator, or `undefined` when none is wired (projection then stays off). */
function estimatorOf(deps: HookDeps): ((t: string) => number) | undefined {
  const estimate = deps.estimateText
  return typeof estimate === 'function' ? estimate : undefined
}

/** One estimate, sanitised: a non-finite or throwing result means "cannot price". */
function safeEstimate(estimate: (t: string) => number, text: string): number | undefined {
  try {
    const value = estimate(text)
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The replay horizon in effect for one projection decision, pinned on its receipt.
 *
 * `status` applies `(1 + horizon)` to every projection's saving. Reading one
 * current horizon at status time re-valued receipts from other sessions and
 * other moments whenever the cross-session minimum moved, so a historical net
 * saving jumped when an unrelated session started or ended. The receipt now
 * carries the horizon its decision was made under; `status` only falls back to
 * the current horizon for receipts that predate the field, and says how many
 * those were.
 *
 * The runtime horizon is design §5.3's `min(config, mean of the session's last
 * historyTurns turns)`. Its instance lives in `src/index.ts` (`apply` builds
 * one `RuntimeStepHorizon`), so the decision path can only read it through
 * {@link HookDeps.horizonFor}; until that one line is wired, the resolved
 * config's `horizonSteps` is the value in effect. A throwing or malformed
 * answer falls back the same way, never to a fabricated number.
 */
function projectionHorizonOf(deps: HookDeps, sessionId: string): number {
  try {
    const live = deps.horizonFor?.(sessionId)
    if (typeof live === 'number' && Number.isFinite(live) && live >= 0) return Math.floor(live)
  } catch {
    // A foreign horizon is evidence, never a reason to lose the receipt.
  }
  const raw = deps.config?.horizonSteps
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : DEFAULT_CONFIG.horizonSteps
}

/** `projection-skipped:<reason>`; `projectApply` already prefixes one reason. */
function projectionSkipCode(reason: string): string {
  return reason.startsWith('projection-skipped:') ? reason : `projection-skipped:${reason}`
}

/**
 * The stable receipt code for a distillation that was not adopted.
 *
 * An adopted distillation shares the projection's code and kind (`projected`),
 * because to every consumer that reads the ledger it *is* the projection of
 * this receipt; the `mode: 'adopted'` field and the `distill_*` fields say
 * where the body came from. A rejection is the code the ticket names
 * (`distill-rejected:<reason>`), and a failure is `distill-failed`.
 */
function distillReceiptCode(outcome: DistillOutcome): string {
  return outcome.mode === 'adopted' ? 'projected' : outcome.code
}

/**
 * The evidence fields a distillation receipt carries beyond the projection's.
 *
 * `mode` (adopted/rejected/fallback) and `reason` are what `status.distill`
 * counts; `distill_calls` is `1` only when this invocation called the model, so
 * a table hit is visible as a product that was adopted but not paid for;
 * `distill_tokens` and `distill_saved_tokens` are omitted — never zeroed —
 * when the model or the meter did not report a number.
 */
function distillEvidence(outcome: DistillOutcome, omittedCodePoints?: number): Record<string, unknown> {
  const e = outcome.evidence
  return {
    mode: outcome.mode === 'adopted' ? 'adopted' : e.reason !== undefined ? 'rejected' : 'fallback',
    distill_calls: e.called ? 1 : 0,
    ...(e.tokens === undefined ? {} : { distill_tokens: e.tokens }),
    ...(outcome.omittedBytes === undefined ? {} : { distill_omitted_bytes: outcome.omittedBytes }),
    ...(outcome.distillBytes === undefined ? {} : { distill_bytes: outcome.distillBytes }),
    ...(omittedCodePoints === undefined ? {} : { distill_omitted_code_points: omittedCodePoints }),
    ...(e.reason === undefined ? {} : { reason: e.reason }),
  }
}

/**
 * Try distillation for this receipt, or `null` when it is not a candidate.
 *
 * The decision reads no host state beyond its inputs: it checks the family's
 * pre-gate, looks the product up under `(receipt, question, version)`, calls
 * the bounded model only on a miss, verifies the quotes, compares the view
 * against the truncation view in bytes, and spills the original before either
 * outcome. Never throws: a broken store, route or store write is the
 * `distill-failed` fallback.
 */
async function distillDecision(
  deps: HookDeps,
  ctx: DecisionContext,
  family: ToolFamily,
  target: string,
): Promise<DistillOutcome | null> {
  // Enabled, listed families and the enabled fallback for everything else:
  // with distillation off (the default) this returns before touching any host
  // service, so the projection path is exactly the 0.2.7 path.
  const distillation = deps.config?.distillation
  if (distillation === undefined || distillation.enabled !== true) return null
  if (!Array.isArray(distillation.families) || !distillation.families.includes(family)) return null
  // A plugin wired without a store still distils, but cannot pin the answer.
  // `distillStoreOf` lets a caller bind the root lazily; a store with no root
  // is `undefined`, and that records `distill-failed` rather than adopting
  // bytes nothing persists (ADR 0001).
  let store: DistillStore | undefined
  try {
    store = deps.distillStore ?? deps.distillStoreOf?.()
  } catch {
    store = undefined
  }
  const routeOf = deps.distillRoute
  let route: SelectorRoute | undefined
  try {
    route = routeOf?.(ctx.sessionId)
  } catch {
    route = undefined
  }
  if (store === undefined) {
    // Enabled, but nothing can pin the answer: record the failure instead of
    // adopting bytes that would be lost.
    return { content: null, code: 'distill-failed', mode: 'fallback', evidence: { called: false, adopted: false } }
  }
  try {
    return await decideDistill({
      text: target,
      family,
      cfg: deps.config,
      sessionId: ctx.sessionId,
      store,
      distill: deps.distill,
      route,
      formatFooter: await resolveFooterFormatter(deps),
      spill: deps.spill,
      toolName: ctx.exec.name,
      ...(typeof ctx.exec.callId === 'string' ? { callId: ctx.exec.callId } : {}),
      ...(deps.distillAttempts === undefined ? {} : { park: (options, settled) => deps.distillAttempts?.park(options, settled) }),
      ...(deps.distillRequestOptions === undefined || deps.distillAttempts === undefined
        ? {}
        : { requestOptions: deps.distillRequestOptions(deps.distillAttempts) }),
    })
  } catch {
    return { content: null, code: 'distill-failed', mode: 'fallback', evidence: { called: false, adopted: false } }
  }
}

/**
 * Write the receipt for a distillation that was attempted, and replace the
 * content only when it was adopted.
 *
 * An adopted body replaces the receipt through the same `accept` shape an
 * applied projection uses, and it is priced against the truncated view
 * (`projection[family].trigger` windows) rather than against the original: the
 * distillation's job is to beat the fallback it would otherwise have paid for,
 * and that pair is what `saved_projection_tokens` records. A rejected attempt
 * leaves the decision to the ordinary truncation below, so a reject never
 * grows what the model sees.
 */
async function finishDistillDecision(
  deps: HookDeps,
  ctx: DecisionContext,
  decision: PostExecuteDecision,
  family: ToolFamily,
  target: string,
  outcome: DistillOutcome,
  estimate: ((text: string) => number) | undefined,
): Promise<PostExecuteDecision> {
  if (outcome.content === null || outcome.mode !== 'adopted') {
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', distillReceiptCode(outcome), distillEvidence(outcome)),
    )
    return decision
  }
  // The locator the distilled footer names is the same registered retrieval
  // site an applied projection uses, so a later read of it is charged the
  // same way.
  if (outcome.locator !== undefined) deps.retrievals?.record(ctx.sessionId, outcome.locator)

  const view = truncationViewOf(target, deps.config, family)
  const priced = view === undefined || estimate === undefined
    ? { before: undefined, after: undefined }
    : { before: safeEstimate(estimate, view), after: safeEstimate(estimate, outcome.content) }
  const distillSaved =
    priced.before !== undefined && priced.after !== undefined ? priced.before - priced.after : undefined
  await appendReceipt(
    deps,
    ledgerEntry(ctx, 'projection', 'projected', {
      unit: 'raw',
      horizon_steps: projectionHorizonOf(deps, ctx.sessionId),
      ...(ctx.retrievalCall === true ? { call_was_retrieval: true } : {}),
      ...(priced.before !== undefined && priced.after !== undefined
        ? { before: priced.before, after: priced.after, saved_projection_tokens: priced.before - priced.after }
        : {}),
      ...(outcome.omittedBytes === undefined ? {} : { omitted_bytes: outcome.omittedBytes }),
      estimate: priced.before !== undefined ? (deps.estimateKind ?? 'unknown') : 'unknown',
      ...distillEvidence(outcome),
      ...(distillSaved === undefined ? {} : { distill_saved_tokens: distillSaved }),
    }),
  )
  return { ...decision, content: [{ type: 'text', text: outcome.content }] }
}

/** The truncation view's rendered bytes, for pricing a distillation against it. */
function truncationViewOf(text: string, cfg: BoostConfig, family: ToolFamily): string | undefined {
  const params = cfg.projection[family]
  if (params === undefined) return undefined
  const truncation = truncate(text, params)
  if (truncation === null) return undefined
  return `${renderHeadLine(truncation)}\n${truncation.head}\n${truncation.tail}`
}

/**
 * Project the receipt that will enter history.
 *
 * Shadow mode only prices the receipt: it writes a `{kind:'shadow'}` record and
 * returns the decision untouched, so nothing the model sees changes. Apply mode
 * persists the canonical original through the host spill backend and replaces
 * the content only after `projectApply`'s own guards pass; a skip leaves the
 * decision intact. The regression guard (`assembled.length < original.length`)
 * lives inside `projectApply`; here only pricing and evidence are added.
 *
 * The live visibility recheck runs before either mode. The listener gate reads
 * the cached judgement from prompt assembly time; a workspace disabled since
 * then must not have its receipt clipped or accounted, in shadow or apply mode.
 */
async function projectDecision(
  deps: HookDeps,
  receipt: CanonicalReceipt,
  decision: PostExecuteDecision,
  ctx: DecisionContext,
): Promise<PostExecuteDecision> {
  const mode: ProjectionMode = ctx.doc.projection
  if (mode === 'off') return decision

  // Projection gets the same live recheck substitution performs. The cached
  // judgement passed the listener gate, but the prompt was assembled before
  // the tool ran: `boost` may have disabled the workspace in between, and a
  // projection changes what the model sees. The cache alone must not authorize
  // that (design §5.5).
  if (!substitutableSession(deps, ctx.sessionId, ctx.doc)) return decision

  const toolName = ctx.exec.name
  const family = toolName === undefined ? undefined : familyOf(toolName)
  if (family === undefined) {
    // `edit`, `web_fetch`, `todo_write`, `boost` and friends are by-design
    // passes, not mapper gaps. Only a decorated (`mcp__*`) name means the
    // mapper may have missed a real family, so only that is counted.
    if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
      try {
        deps.projectionCounters?.unknownFamily(toolName)
      } catch {
        // A counter is evidence, never a precondition.
      }
    }
    return decision
  }
  const target = projectionTargetOf(decision, receipt, ctx.result)
  if (target === undefined) return decision

  // Clipping does not need a token meter; only its accounting does (design
  // §9). With no estimator the replacement still happens, but the receipts
  // carry `estimate:'unknown'` and no fabricated numbers.
  const estimate = estimatorOf(deps)

  // Ticket #10: a family the configuration lists may try distillation first.
  // `null` means "not a candidate" — the whole path below is exactly the
  // pre-distillation projection, byte for byte.
  const distillation = await distillDecision(deps, ctx, family, target)

  try {
    if (mode === 'shadow') {
      const outcome = await projectShadow({
        text: target,
        isError: receipt.isError,
        family,
        cfg: deps.config,
        // Same sanitiser as the apply path: a throwing or non-finite host
        // estimate must never become `null` in the shadow account. Without a
        // meter the NaN makes `projectShadow` record an unpriced event.
        estimate: (text) =>
          estimate === undefined ? Number.NaN : (safeEstimate(estimate, text) ?? Number.NaN),
      })
      if (outcome.kind === 'shadow') {
        const priced =
          outcome.before !== undefined &&
          outcome.after !== undefined &&
          outcome.saved !== undefined
        await appendReceipt(
          deps,
          ledgerEntry(ctx, 'shadow', 'projection-shadow', {
            decision: 'projection',
            unit: 'raw',
            // The shadow ledger's one-time figure is replayable with the same
            // horizon as the applied one; pinning it keeps the two comparable.
            horizon_steps: projectionHorizonOf(deps, ctx.sessionId),
            ...(ctx.retrievalCall === true ? { call_was_retrieval: true } : {}),
            ...(priced
              ? {
                  before: outcome.before,
                  after: outcome.after,
                  saved_projection_tokens: outcome.saved,
                }
              : {}),
            estimate: priced ? (deps.estimateKind ?? 'unknown') : 'unknown',
          }),
        )
      }
      return decision
    }

    if (distillation !== null) {
      // `distillDecision` already spilled the original and wrote the product:
      // an adopted body replaces the receipt here, and anything else falls
      // through to the ordinary truncation below with its reason recorded.
      return await finishDistillDecision(deps, ctx, decision, family, target, distillation, estimate)
    }

    const { content, outcome } = await projectApply({
      text: target,
      isError: receipt.isError,
      family,
      cfg: deps.config,
      sessionId: ctx.sessionId,
      toolName: ctx.exec.name ?? 'tool',
      callId: typeof ctx.exec.callId === 'string' ? ctx.exec.callId : undefined,
      label: family,
      spill: deps.spill,
      formatFooter: await resolveFooterFormatter(deps),
    })

    if (outcome.kind === 'applied') {
      // Remember the artifact's only address: this is what makes a later read
      // of it a counted retrieval instead of a free one (design §5.3).
      if (outcome.locator !== undefined) deps.retrievals?.record(ctx.sessionId, outcome.locator)

      // The applied event is always recorded; only the token figures depend on
      // the meter. `estimate` is always present and names the producer
      // (`deps.estimateKind`, defaulting to `'unknown'`), never a guess.
      // One-time `before`/`after`/`saved_projection_tokens` are the
      // authoritative names (§5.3); `status` applies the replay factor once to
      // the aggregate, never per receipt. `horizon_steps` is the horizon this
      // decision was made under, so a later status cannot re-value it.
      const before = estimate === undefined ? undefined : safeEstimate(estimate, target)
      const after = estimate === undefined ? undefined : safeEstimate(estimate, content)
      if (before !== undefined && after !== undefined) {
        await appendReceipt(
          deps,
          ledgerEntry(ctx, 'projection', 'projected', {
            unit: 'raw',
            horizon_steps: projectionHorizonOf(deps, ctx.sessionId),
            ...(ctx.retrievalCall === true ? { call_was_retrieval: true } : {}),
            before,
            after,
            saved_projection_tokens: before - after,
            // How much the projection cut, in the units the footer names. Without
            // it a reader of the ledger cannot tell a 2 KB cut from a 200 KB one
            // (review cod#3: these fields had no consumer).
            ...(outcome.omittedBytes === undefined ? {} : { omitted_bytes: outcome.omittedBytes }),
            ...(outcome.omittedCodePoints === undefined
              ? {}
              : { omitted_code_points: outcome.omittedCodePoints }),
            estimate: deps.estimateKind ?? 'unknown',
          }),
        )
      } else {
        await appendReceipt(
          deps,
          ledgerEntry(ctx, 'projection', 'projected', {
            unit: 'raw',
            horizon_steps: projectionHorizonOf(deps, ctx.sessionId),
            ...(ctx.retrievalCall === true ? { call_was_retrieval: true } : {}),
            ...(outcome.omittedBytes === undefined ? {} : { omitted_bytes: outcome.omittedBytes }),
            ...(outcome.omittedCodePoints === undefined
              ? {}
              : { omitted_code_points: outcome.omittedCodePoints }),
            estimate: 'unknown',
          }),
        )
      }
      // Every other path is untouched by distillation; only this one can hand
      // it a different body.
      return { ...decision, content: [{ type: 'text', text: content }] }
    }

    if (
      outcome.kind === 'skipped' &&
      outcome.reason !== undefined &&
      PROJECTION_DEGRADATIONS.has(outcome.reason)
    ) {
      // `projection-skipped:no-spill` is the receipt behind
      // `boost status`'s `ERR_HOST_NO_SPILL`; the other degradation codes
      // exist for the same audit trail. Ordinary "not worth it" skips are
      // deterministic policy, not a per-call decision (design §5.3), so they
      // write nothing.
      // A skip projected nothing, so it is a `skip` receipt, not a
      // `projection` one. `kind:'projection'` is not a promise of numeric
      // fields: the meterless apply branch above always writes
      // `estimate:'unknown'` but omits `before`/`after`/
      // `saved_projection_tokens` entirely (design §9), and consumers must
      // treat those as unpriced rather than assume the numbers exist.
      await appendReceipt(
        deps,
        ledgerEntry(ctx, 'skip', projectionSkipCode(outcome.reason)),
      )
    }
    return decision
  } catch {
    // `projectApply`/`projectShadow` already contain their own host calls; this
    // is the last belt for a bug in either of them.
    return decision
  }
}

/**
 * The decision + projection stage.
 *
 * Both seams live in one place so the listener's order is visible in one
 * function: the receipt-visibility gate, then decide, then the
 * double-projection guard, then project. A shadow substitution does not stop
 * the projection: the two switches are independent (design §5.2-5), and in
 * projection-shadow mode the projection writes only its accounting line.
 */
async function applyDecision(
  deps: HookDeps,
  decision: PostExecuteDecision,
  ctx: DecisionContext,
): Promise<PostExecuteDecision> {
  // Substitution is only legitimate while the receipt is what the model sees.
  // `decide` and its guards were evaluated against `ctx.receipt.text`; a
  // `block`, or an `accept` carrying a replacement `value`, hides that text, so
  // a commit would dispatch a call whose evidence the model never received
  // (review row 11). `projectionTargetOf` is the same visibility predicate
  // projection uses: it rejects `block` and any `accept` with a `value`, and
  // accepts an `accept` whose content is text (possibly rewritten).
  //
  // A hidden receipt still consumes the one-shot plan: the plan was written for
  // the call that produced it, and keeping it would let it fire against a later
  // receipt whose text it was not written for.
  //
  // Projection below runs for a shadow commit too: the decision side never
  // suppresses the projection ledger.
  const visible = projectionTargetOf(decision, ctx.receipt, ctx.result)
  if (visible === undefined) {
    clearPlan(deps, ctx.sessionId)
  } else if (visible !== ctx.receipt.text) {
    // An `accept` carrying its own `content` shows the model text the plugin
    // never canonicalised, so every guard and every literal in the plan was
    // checked against something else. Projection may still run — it rewrites
    // the visible text deliberately — but a substitution must not commit on
    // evidence the model cannot see (review qr5#3).
    //
    // No receipt: this is the normal outer-shaper path (`dsh-spill-policy`
    // appends its footer in every session), not a degradation. A receipt here
    // would be one line per oversized receipt and would read as a failure.
    clearPlan(deps, ctx.sessionId)
  } else {
    await decideSubstitution(deps, ctx)
  }

  // Second-projection guard. Two host shapers are outer to this listener:
  //
  // - The spill policy registers with `{ prepend: true }`: it calls `next()`
  //   and adds its footer to *that* decision after this listener returns. So
  //   this check sees only a footer an inner listener already wrote, never the
  //   host's own; it must not be read as full double-spill detection.
  // - For `glob`/`grep`, `@deepseek-ai/dsh-tool-fs-search` is outer too
  //   (`dsh-base` loads it first) and would replace an over-cap result with its
  //   own spill-backed preview. The plugin pre-empts it **deliberately**:
  //   `acceptedDirectCallValue` does nothing as soon as the decision carries
  //   `content` (`dsh-tool-fs-search/lib/index.js:490-493`), so the projection
  //   accept below wins and the host preview never runs. That is the intended
  //   trade for these two families: the plugin's window triggers at 700
  //   characters, far below the host's 100-path / 250-match caps, and its own
  //   footer keeps the spill locator, so the host preview has nothing to add
  //   to a receipt this listener already clipped. A family the plugin does not
  //   project leaves the host shaper untouched.
  //
  // What these two checks can and cannot catch (review row 25):
  //
  // - The first reads `ctx.receipt.text`, captured before this listener
  //   returns. The outer spill policy appends its footer to the decision
  //   *after* this point, so this check can never see the host's own footer.
  //   It can only fire when the tool's output already ends in a spill notice —
  //   for example a `read` of a spill artifact, whose text carries the notice
  //   literally. That is still a receipt that is already a preview, so
  //   refusing to project it again is the intended, if narrow, guard.
  // - The second sees a replacement an inner listener wrote into the decision.
  //   An outer shaper's footer is invisible to it too.
  //
  // Neither check is full double-spill detection: at this point the host's
  // footer does not exist yet, so projection and the outer spill policy can
  // both act on one receipt. That is fail-safe, not prevention: the
  // projection's own footer keeps the original retrievable, and the host's
  // second notice points at the projected text.
  if (await isAlreadySpilled(deps, ctx.receipt.text)) return decision
  const downstreamText = decisionTextOf(decision) ?? ctx.receipt.text
  if (downstreamText !== ctx.receipt.text && await isAlreadySpilled(deps, downstreamText)) {
    return decision
  }
  return projectDecision(deps, ctx.receipt, decision, ctx)
}

// ---------------------------------------------------------------------------
// The two listeners
// ---------------------------------------------------------------------------

/**
 * The `tools/post-execute` body.
 *
 * `next()` runs first, exactly like the host's own spill policy: a listener
 * either returns a decision or calls `next()` and returns its result, and
 * bypassing it would silently drop the listeners mounted after this one. The
 * fixed order that follows is `scope gate → canonicalise → invalidate →
 * substitution decision → double-projection guard → projection → return the
 * decision` (design §5.2-7/§5.4-5).
 *
 * Everything after `next()` is contained: the host turns a throwing
 * `post-execute` listener into an error result and the real tool output is
 * lost. A failure in our own wiring must therefore return the decision as it
 * arrived, never a thrown error.
 */
async function postExecute(
  deps: HookDeps,
  state: ReceiptSessionState,
  exec: PostExecuteExec | undefined,
  result: PostExecuteResult | undefined,
  next: () => Promise<PostExecuteDecision>,
): Promise<PostExecuteDecision> {
  const decision = await next()

  // The host cancels a call by aborting `exec.signal`; an async listener must
  // observe it before doing work whose result the model will never receive.
  // `next()` still runs — the waterfall must not drop the listeners mounted
  // after this one, and the host only replaces a successful accepted outcome
  // after they settle — but nothing after it does.
  if (cancelled(exec)) return decision

  // A PTC inner call traverses this waterfall with `parent` set. Its result
  // belongs to the enclosing `run_code` step, not to a step of its own: it must
  // not become `root`, drive a decision, consume the outer plan or overwrite the
  // outer anchors. Leaving it untouched is what keeps a plan from being decided
  // from an inner receipt.
  if (exec !== undefined && exec.parent !== undefined) return decision

  if (exec?.agent === undefined) {
    await appendSkipNoScope(deps.receipts, exec)
    return decision
  }

  // Exposure gate: an out-of-scope session pays nothing. This is the same
  // cached judgement the protocol section reads; a miss is false (fail-closed,
  // design §5.5).
  const sessionId = sessionIdOf(exec)
  if (sessionId === undefined) {
    // The agent exists but carries no usable session id, so neither the scope
    // gate nor the retrieval ledger can attribute this call. Fail closed and
    // keep the pass visible; the no-agent branch above does the same.
    await appendSkipNoScope(deps.receipts, exec)
    return decision
  }

  // The mirrored dispatch is only meaningful while its usage mark is pending.
  // Once the mark is gone (settled by the next real request, or discarded), the
  // record is stale and a later turn's mark could reuse the candidate id.
  if (pendingCandidateOf(deps, sessionId) === undefined) clearAcceptedDispatch(deps, sessionId)

  // A substituted call denied by `tools/pre-execute` (approval or sandbox)
  // returns a post-result without invoking `tools/execute`, while post-execute
  // still runs. Matching the call id here clears the pending entry even though
  // no dispatch mapping exists, so the substitution is not re-synthesized on
  // every later step of the turn.
  clearMatchingPending(deps, sessionId, exec)

  // Detect the retrieval before the visibility gate (a projected receipt
  // already consumed context regardless of today's scope), but write its cost
  // only after projection, when the final visible content is known (review I3).
  const retrieval = pendingRetrievalOf(deps, exec, sessionId)

  if (!isActiveSession(deps, sessionId)) {
    if (retrieval !== undefined) {
      const arrival = canonicalise(result?.content ?? [], result?.isError === true)
      await recordProjectionRetrieval(deps, exec, sessionId, retrieval, arrival.text)
    }
    await appendSkipNoScope(deps.receipts, exec, sessionId, clockTurnOf(deps, sessionId) ?? 0)
    return decision
  }

  try {
    // Canonicalise the original receiver, not a downstream replacement: guards
    // and the selector read the receipt as it arrived.
    const receipt = canonicalise(result?.content ?? [], result?.isError === true)
    const turn = clockTurnOf(deps, sessionId) ?? 0

    // The receipt map is the gate's memory for this turn. `begin` folds the
    // previous turn away (anchors live in the store, receipts and in-flight
    // dispatches here), then the arriving receipt becomes `root` and, if it is
    // the call we substituted, also becomes the candidate's receipt.
    const { rolledOver } = state.begin(sessionId, turn)
    if (rolledOver) {
      // A pending entry and its decision-time usage mark from the previous turn
      // can never match a call in this one, so both are dead weight; the reset
      // path does the same mid-turn (F2). The mark is settled **without** a
      // settlement receipt when no substitution ran, exactly like
      // `resetInvalidatedPending` and `applyAbandon`. This branch is reachable
      // with a live mark because a parallel tool result can land after the host
      // advanced the turn but before this turn's first `llm/stream`, so the old
      // "the stream always runs first" argument does not hold (D1). When the
      // synthesized dispatch *was* accepted, the skipped model round is real:
      // `settleRollover` reports it with the sample the ledger has (row 28).
      await settleRollover(deps, sessionId, turn)
      clearAnchors(deps, sessionId)
      clearPending(deps, sessionId)
      // The plan map is normally reconciled by `SessionRuntime.notePlanTurn` on
      // the first real request of a turn. If that request has not run yet, a
      // plan still in the map belongs to the previous turn and would fire
      // against this new-turn receipt; drop it. When the request did run,
      // `notePlanTurn` reports false and the plan present was parsed by that
      // request's response: keep it, because clearing would discard a valid
      // new-turn plan.
      let planForThisTurn = false
      try {
        planForThisTurn = deps.sessions?.notePlanTurn(sessionId, turn) === false
      } catch {
        planForThisTurn = false
      }
      if (!planForThisTurn) clearPlan(deps, sessionId)
    }
    state.recordRoot(sessionId, turn, receipt)
    fileDispatchedReceipt(state, exec, sessionId, turn, receipt)

    // Conservative local invalidation check. The tool-result path cannot see
    // the host pruner (it rewrites session surface nodes, not this waterfall)
    // or compaction, so only the **marker** branch is meaningful here: it
    // catches a receipt whose tool output itself carries the pruner literal.
    // The anchor comparison needs the anchored receipt's current text and
    // belongs to the model-request path (23c); running it here would compare a
    // different call's text and fire a false compaction-reset after every
    // commit (review F1). A hit only abandons the decision, which is safe.
    const pending = pendingAnchorsOf(deps, sessionId)
    // `!= null` rather than `!== undefined`: a foreign store can hand back a
    // null, and dereferencing it would throw out of the hook.
    if (pending != null) {
      const reset = markerResetOf(receipt.text)
      if (reset !== undefined) {
        await resetInvalidatedPending(deps, exec, sessionId, turn, pending, reset)
        if (retrieval !== undefined) {
          await recordProjectionRetrieval(deps, exec, sessionId, retrieval, receipt.text)
        }
        return decision
      }
    }

    const ctx: DecisionContext = {
      sessionId,
      exec,
      receipt,
      doc: await scopeDocOf(deps),
      result,
      state,
      turn,
      retrievalCall: retrieval !== undefined,
    }
    const outgoing = await applyDecision(deps, decision, ctx)
    if (retrieval !== undefined) {
      // The retrieval receipt's content figure must price what enters history
      // after projection, not the raw result it arrived with.
      const visible = decisionTextOf(outgoing) ?? receipt.text
      await recordProjectionRetrieval(deps, exec, sessionId, retrieval, visible)
    }
    return outgoing
  } catch {
    // Never lose the tool's real output to a wiring bug in this listener.
    return decision
  }
}

/**
 * Drop a pending entry whose call id matches the arriving result.
 *
 * The execute hook clears the entry when it inspects an accepted or rejected
 * dispatch, but a call denied by `tools/pre-execute` never reaches that hook;
 * post-execute is then the only observer that knows the substituted call is
 * over. A different call id is an ordinary call and leaves the entry alone.
 */
function clearMatchingPending(
  deps: HookDeps,
  sessionId: string,
  exec: PostExecuteExec,
): void {
  const pending = peekPending(deps, sessionId)
  if (pending === undefined) return
  if (typeof exec.callId !== 'string' || exec.callId !== pending.callId) return
  clearPending(deps, sessionId)
}

/** File an executed candidate's receipt under its plan id, consuming the dispatch record. */
function fileDispatchedReceipt(
  state: ReceiptSessionState,
  exec: PostExecuteExec | undefined,
  sessionId: string,
  turn: number,
  receipt: CanonicalReceipt,
): void {
  const callId = exec?.callId
  if (typeof callId !== 'string') return
  const candidateId = state.takeDispatch(sessionId, turn, callId)
  if (candidateId === undefined) return
  state.recordCandidate(sessionId, turn, candidateId, receipt)
}

/** The host's `ToolExecutionResult` failure branch for a refused dispatch. */
function dispatchFailure(message: string): unknown {
  return {
    isError: true,
    error: {
      message,
      info: { name: 'DispatchRejectedError', code: 'dispatch-rejected' },
    },
    content: [{ type: 'text', text: `Error: ${message}` }],
  }
}

/** Record one refused dispatch; a receipt write never changes the verdict. */
async function appendDispatchRejected(
  deps: HookDeps,
  exec: DispatchExec,
  entry: PendingEntry,
  sessionId: string,
): Promise<void> {
  await appendReceipt(deps, {
    version: 1,
    ts: new Date().toISOString(),
    sessionId,
    turn: clockTurnOf(deps, sessionId) ?? 0,
    stepId: 'root',
    kind: 'skip',
    code: 'dispatch-rejected',
    tool: exec.name,
    callId: typeof exec.callId === 'string' ? exec.callId : undefined,
    candidateId: entry.candidateId,
    // The refused call's own args, not the pending decision's: the operator
    // needs to see exactly what the host was asked to run.
    args: exec.arguments,
    preview: callPreview(exec.name, exec.arguments),
  })
}

/**
 * The inspect half of `tools/execute`: no `next()` is called here, so a throw
 * can never cause the dispatch to run twice.
 *
 * Every operation is contained (the lookup, the clearing, the receipt write),
 * so the only throw this function can produce is a bug of its own; the caller
 * then fails open.
 */
async function inspectDispatch(
  deps: HookDeps,
  exec: DispatchExec,
): Promise<
  | { kind: 'next' }
  | { kind: 'reject'; message: string }
  | {
      kind: 'accept'
      sessionId: string
      callId: string
      candidateId: string
      /** The plan/guard evidence the entry carried; mirrored for a rollover settle. */
      evidence: SubstitutionEvidence | undefined
    }
> {
  // Row 30: a PTC inner call carries `parent` and belongs to the enclosing
  // `run_code` step. Its host-assigned call id is not the root decision's, so
  // even a collision must not be read as our dispatch.
  if (exec.parent !== undefined) return { kind: 'next' }

  const sessionId = sessionIdOf(exec)
  if (sessionId === undefined) return { kind: 'next' }

  const entry = peekPending(deps, sessionId)
  if (entry === undefined) return { kind: 'next' }

  const reject = async (message: string) => {
    clearPending(deps, sessionId)
    await appendDispatchRejected(deps, exec, entry, sessionId)
    return { kind: 'reject' as const, message }
  }

  // A different call id is an ordinary call, not tampering: the host assigns
  // call ids, so only a call that carries the id we chose is the dispatch under
  // inspection. Rejecting the rest would lose a legitimate tool's output (F2).
  if (typeof exec.callId !== 'string' || exec.callId !== entry.callId) {
    return { kind: 'next' }
  }
  // `rejectIfTampered` compares name and parsed arguments only; the call id was
  // compared above.
  if (rejectIfTampered(exec, entry).reject) {
    return reject(
      'dsh-boost refused a substituted call: the dispatched arguments do not match the pending decision',
    )
  }

  // Accept path: the entry has done its job, so drop it before dispatching.
  clearPending(deps, sessionId)
  return {
    kind: 'accept',
    sessionId,
    callId: entry.callId,
    candidateId: entry.candidateId,
    evidence: (entry as AuditedPendingEntry).evidence,
  }
}

/**
 * The `tools/execute` hook body: refuse a tampered substitution.
 *
 * With no pending entry the plugin is not substituting this call, so `next()`
 * runs untouched. The entry describes the dispatch we synthesised: a call that
 * carries the **same** call id is inspected, compared with the decision, and
 * the entry is cleared on both the accept and the reject path so it cannot
 * outlive its dispatch. A call with a **different** call id is an ordinary call
 * — the host assigns ids — and passes through without touching the entry
 * (review F2: rejecting it would lose a legitimate tool's output). On the
 * accept path the call id is remembered so the following `post-execute` can
 * file the receipt under its candidate id.
 *
 * The mount fails open on an internal error (the design's fail-closed means
 * "pass through, do not substitute", never "intercept"): a broken queue must
 * not block every tool call in the process.
 */
async function executeHook(
  deps: HookDeps,
  state: ReceiptSessionState,
  exec: DispatchExec,
  next: () => Promise<unknown>,
): Promise<unknown> {
  // Row 30: a PTC inner dispatch is the enclosing `run_code` step's business,
  // not this hook's; `next()` runs untouched so the inner tool still executes.
  if (exec?.parent !== undefined) return next()

  let outcome: Awaited<ReturnType<typeof inspectDispatch>>
  try {
    outcome = await inspectDispatch(deps, exec)
  } catch {
    return next()
  }

  if (outcome.kind === 'reject') return dispatchFailure(outcome.message)
  if (outcome.kind === 'accept') {
    const turn = clockTurnOf(deps, outcome.sessionId) ?? 0
    try {
      state.recordDispatch(outcome.sessionId, turn, outcome.callId, outcome.candidateId)
    } catch {
      // Losing the mapping costs the candidate receipt, not this call.
    }
    // The same fact, kept outside `ReceiptSessionState` because the candidate's
    // post-execute consumes that mapping before a rollover can look at it.
    noteAcceptedDispatch(
      deps,
      outcome.sessionId,
      turn,
      outcome.candidateId,
      outcome.evidence,
    )
  }
  return next()
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Mount the projection waterfall. */
function registerPostExecute(
  ctx: PluginContext,
  deps: HookDeps,
  state: ReceiptSessionState,
): void {
  ctx.on('tools/post-execute', (exec, result, next) => postExecute(deps, state, exec, result, next))
}

/** Mount the model-request waterfall; the hook function is built once per registration. */
function registerLlmStream(ctx: PluginContext, deps: HookDeps): void {
  const hook = streamHook(deps)
  ctx.on('llm/stream', (options, next) => hook(options, next))
}

/** Mount the dispatch waterfall. */
function registerExecute(ctx: PluginContext, deps: HookDeps, state: ReceiptSessionState): void {
  ctx.on('tools/execute', (exec, next) => executeHook(deps, state, exec, next))
}

/** Mount the protocol section, whose provider stays synchronous and per-agent. */
function registerProtocolSection(ctx: PluginContext, scope: ScopeStore | undefined): void {
  ctx.systemPrompt.section({
    name: PROTOCOL_NAME,
    order: PROTOCOL_ORDER,
    interpolate: false,
    text: (context) => protocolText(scope, context),
  })
}

/**
 * Register the plugin's four host integration points.
 *
 * The prompt section is registered first on purpose: it is the only mount that
 * rejects a duplicate name, so a second `apply` aborts here before any event
 * hook is mounted twice (the host turns a duplicate section into an error, and
 * `apply` treats that as "already mounted"). Registering it last would leave
 * three live duplicate listeners behind.
 *
 * One `ReceiptSessionState` belongs to the whole registration: the execute
 * mount writes the in-flight call mapping and the post-execute mount consumes
 * it, so the two waterfalls must share it.
 *
 * `scope`, `receipts`, `anchors` and `resolveSession` are required by
 * `HookDeps`, but they are still checked at the point of use: a host wiring the
 * plugin without one of the optional pieces still gets the four mount points,
 * and every degraded path is fail-closed instead of throwing during
 * registration.
 */
export function registerHooks(ctx: PluginContext, deps: HookDeps): void {
  const state = deps.sessionState ?? new ReceiptSessionState()
  // Publish the instance we created. `clearSession` and Task 23c-2's session-end
  // wiring reach the state through `deps.sessionState`; a caller that omits it
  // (the plan's 23c-2 assembly list does) would otherwise leave the created
  // receipt/dispatch maps unreachable and leaked per session.
  deps.sessionState = state
  // The logger is a host service the caller already has; publishing it here
  // keeps the degradation warnings reachable without widening every caller's
  // deps literal. A deps object that already names one keeps it.
  deps.logger ??= ctx.logger
  // Row 27: `llm/stream` records the synthesis through this seam, because the
  // mirror lives here and a denied dispatch never reaches `tools/execute`.
  deps.noteSynthesis ??= (sessionId, turn, candidateId, evidence) =>
    noteAcceptedDispatch(deps, sessionId, turn, candidateId, evidence)
  registerProtocolSection(ctx, deps.scope)
  registerPostExecute(ctx, deps, state)
  registerLlmStream(ctx, deps)
  registerExecute(ctx, deps, state)
}
