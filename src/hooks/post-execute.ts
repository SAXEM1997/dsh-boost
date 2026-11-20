/**
 * Host hook assembly: the four mount points the plugin owns, and the
 * post-execute decision path that turns the gate into a working product.
 *
 * Registration stays split one function per mount so each body can be replaced
 * without rewriting the mount:
 *
 * - `tools/post-execute` first gates on the same cached scope judgement the
 *   protocol section reads, then canonicalises the result and runs a
 *   conservative invalidation check plus the double-projection guard. It then
 *   files the arriving receipt under `'root'`, works the substitution decision
 *   (`decide` → admission → pending queue / shadow receipt / fallback), and
 *   finally projects the receipt when the scope document asks for it. Order is
 *   fixed: `next() → canonicalise → invalidate → decide → (shadow receipt |
 *   admit and enqueue | fallback) → projection → return the decision`
 *   (plan §Task 23b). A call with no `exec.agent` is not the plugin's to
 *   inspect: the downstream decision is returned untouched and a
 *   `skip:no-scope` receipt keeps the pass visible (design §5.5).
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
 * templates. A commit consumes that candidate from the session plan; without
 * it `decide` would re-commit the same step until the budget ran out.
 *
 * The `shadow` flag from the scope document drives both `decide` (which skips
 * the whitelist) and the record-only branch: a shadow commit writes a
 * `{kind:'shadow'}` receipt and neither enqueues, takes budget, nor projects.
 * Admission runs in the mandated order — existence, `worthSubstituting`, then
 * `budget.take()` — so a fallback never spends budget for a call it did not
 * substitute.
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
import { decide } from '../gate/decide.js'
import { alreadySpilled, looksPruned } from '../gate/invalidate.js'
import type { AnchorStore, ReceiptAnchors } from '../gate/invalidate.js'
import type { Candidate, Plan } from '../gate/plan.js'
import { isPosixOnly } from '../host/platform.js'
import type { ProjectionCounters } from '../projection/counters.js'
import { PROTOCOL_NAME, PROTOCOL_ORDER, PROTOCOL_TEXT } from '../prompt/protocol.js'
import { projectApply, projectShadow } from '../projection/apply.js'
import type { FormatFooter, ProjectionMode, SpillBackend, SpillHandle } from '../projection/apply.js'
import { canonicalise } from '../projection/canonicalise.js'
import type { CanonicalReceipt } from '../projection/canonicalise.js'
import type { ReceiptStore } from '../receipts/store.js'
import { DEFAULT_SCOPE, isVisible } from '../scope/doc.js'
import type { ScopeDoc } from '../scope/doc.js'
import type { ScopeStore } from '../scope/store.js'
import { choose } from '../selector/jev.js'
import type { LlmLike } from '../selector/jev.js'
import { familyOf } from '../tools/family.js'
import type { AgentLike, BoostConfig, PluginContext } from '../types.js'
import type { TurnClock } from './clock.js'
import { rejectIfTampered } from './execute.js'
import { sessionBudget, sessionClock, sessionUsage, streamHook } from './llm-stream.js'
import type { SessionRuntime } from './llm-stream.js'
import { callIdFor } from './pending.js'
import type { PendingEntry, PendingQueue } from './pending.js'
import { ReceiptSessionState } from './session-state.js'

/**
 * The `llm/stream` body lives in its own module (Task 23c-1). It is re-exported
 * here because `registerHooks` is the assembly surface the rest of the plugin
 * and the integration tests import; the mount below uses the same function.
 */
export { streamHook }

/** The store's append input, without exporting the private alias from T7. */
type ReceiptInput = Parameters<ReceiptStore['append']>[0]

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
   * Per-turn substitution budget; absent means no cap is applied. Used only
   * when `sessions` is absent, so a shared instance is never preferred over
   * the per-session runtime.
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
   * `host` means the synchronous host token meter priced it; `chars/4` means
   * the fixed-density fallback did. The field exists so an audit reader never
   * mistakes the fallback for a provider measurement.
   */
  estimateKind?: 'host' | 'chars/4' | 'unknown'
  /**
   * The host spill-notice predicate, injected instead of imported.
   *
   * Kept from Task 17 because the host spill policy is an optional peer and a
   * test needs to hand over a throwing predicate without the host package.
   * Production omits it and the dynamically imported host function is used.
   */
  hasSpillNotice?: (text: string) => boolean
}

/** The execution facts a `tools/post-execute` listener reads here. */
type PostExecuteExec = {
  name?: string
  callId?: string
  agent?: AgentLike | undefined
  /** Parsed tool arguments; the retrieval matcher reads them (Task 25). */
  arguments?: unknown
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

/** The session's host turn, or 0 when no clock is wired (receipts still carry `ts`). */
function clockTurnOf(deps: HookDeps, sessionId: string): number {
  try {
    const turn = sessionClock(deps, sessionId)?.turn()
    return typeof turn === 'number' && Number.isFinite(turn) ? turn : 0
  } catch {
    return 0
  }
}

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

/** The pending entry for a session, never removing it and never throwing. */
function peekPending(deps: HookDeps, sessionId: string): PendingEntry | undefined {
  try {
    const queue = deps.queue
    if (queue == null || typeof queue.peek !== 'function') return undefined
    return queue.peek(sessionId)
  } catch {
    return undefined
  }
}

/** Drop the session's pending entry; a foreign queue must not break the call. */
function clearPending(deps: HookDeps, sessionId: string): void {
  try {
    const queue = deps.queue
    if (queue == null || typeof queue.clear !== 'function') return
    queue.clear(sessionId)
  } catch {
    // Containment only: a stale entry costs a false reject later, not this call.
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
function markerResetOf(
  pending: ReceiptAnchors,
  receiptText: string,
): 'pruned-reset' | undefined {
  try {
    if (pending == null) return undefined
    return looksPruned(receiptText) ? 'pruned-reset' : undefined
  } catch {
    return undefined
  }
}

/** Clear the session's anchors; a foreign store must not turn the result into an error. */
function clearAnchors(deps: HookDeps, sessionId: string): void {
  try {
    deps.anchors?.clear(sessionId)
  } catch {
    // Containment only: the store is evidence, not a precondition.
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
    ...extra,
  }
}

/** Append one receipt; a receipt is evidence, never a precondition. */
async function appendReceipt(deps: HookDeps, receipt: ReceiptInput): Promise<void> {
  const store = deps.receipts
  if (store == null || typeof store.append !== 'function') return
  try {
    await store.append(receipt)
  } catch {
    // A receipt is evidence, not a precondition: never break the call for it.
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
  // queued substitution can fire from anchors that no longer name live text.
  clearAnchors(deps, sessionId)
  clearPending(deps, sessionId)
  await appendResetReceipt(deps.receipts, exec, sessionId, turn, pending.stepId, code)
}

/**
 * The host's spill-notice predicate, resolved at most once per process.
 *
 * The spill policy is an optional peer (design §5.4), so its notice module is
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
 * degrade to `projection-skipped:no-footer` in `projectApply` itself.
 */
let footerFormatter: Promise<FormatFooter | undefined> | undefined

function resolveFooterFormatter(): Promise<FormatFooter | undefined> {
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
      turn: clockTurnOf(deps, sessionId),
      kind: 'projection',
      code: 'projection-retrieval',
      tool: name,
      retrieved: true,
      locator: pending.locator,
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
 * The conservative saving of skipping one model step: the last real request's
 * replayed context (`input + cacheRead`).
 *
 * The step that is skipped would have replayed at least this much: the context
 * only grows as receipts enter it. A missing ledger or sample is 0, never an
 * interpolation, so admission falls back to the model when it cannot measure
 * (design §5.3: measured, not estimated).
 */
function savedTokensOf(deps: HookDeps, sessionId: string): number {
  try {
    const last = sessionUsage(deps, sessionId)?.last()
    if (last === undefined) return 0
    const { input, cacheRead } = last
    if (!Number.isFinite(input) || !Number.isFinite(cacheRead) || input < 0 || cacheRead < 0) return 0
    const total = input + cacheRead
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

/** Claim one budget step; no budget wired means no cap is applied. */
function takeBudget(deps: HookDeps, sessionId: string): boolean {
  try {
    const budget = sessionBudget(deps, sessionId)
    if (budget == null || typeof budget.take !== 'function') return true
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

/** Replace the session plan with one that no longer contains the committed candidate. */
function consumePlan(deps: HookDeps, sessionId: string, candidateId: string): void {
  try {
    const plans = deps.plans
    if (plans == null || typeof plans.get !== 'function' || typeof plans.set !== 'function') return
    const plan = plans.get(sessionId)
    if (plan === undefined) return
    if (!plan.steps.some((step) => step.id === candidateId)) return
    plans.set(sessionId, {
      goal: plan.goal,
      steps: plan.steps.filter((step) => step.id !== candidateId),
    })
  } catch {
    // A plan that cannot be updated only costs a re-decision later.
  }
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

/** The candidate list exactly as `choose` renders it, for pricing the input. */
function selectorCandidateList(candidates: readonly Candidate[]): string {
  return candidates.map((candidate) => `${candidate.id}: ${selectorSummary(candidate)}`).join('\n')
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
 * `maxTokens` bounds only the output; the receipt and candidate summaries are
 * input. Charging a flat 512 would under-count the input by hundreds of tokens
 * and make admission optimistic exactly where it decides whether to call.
 * `undefined` means the caller cannot price the call; it must not guess.
 */
function selectorChargeOf(
  deps: HookDeps,
  candidates: readonly Candidate[],
  receiptText: string,
): number | undefined {
  const estimate = deps.estimateText
  if (typeof estimate !== 'function') return undefined
  const input = safeEstimate(
    estimate,
    `${receiptText}\n${selectorCandidateList(candidates)}`,
  )
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
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', 'selector-abstain', { stepId: 'root', reason: result.abstain }),
    )
    return undefined
  } catch {
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', 'selector-abstain', { stepId: 'root', reason: 'error' }),
    )
    return undefined
  }
}

/**
 * The substitution decision and its side effects.
 *
 * The fixed order is the plan's: existence of a plan and a receipt first, then
 * `worthSubstituting`, then `budget.take()`. Nothing below spends budget on a
 * decision that will not be dispatched.
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
 * A commit consumes the candidate and, outside shadow mode, parks the
 * substituted call for `tools/execute`; the entry is dropped at turn rollover
 * or on a reset.
 */
async function decideSubstitution(
  deps: HookDeps,
  ctx: DecisionContext,
): Promise<{ shadowCommitted: boolean }> {
  const plan = safePlan(deps, ctx.sessionId)
  if (plan === undefined) return { shadowCommitted: false }

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
    return { shadowCommitted: false }
  }

  let decision: ReturnType<typeof decide>
  try {
    decision = decide({
      plan,
      stepId: 'root',
      receipts: ctx.state.receiptsFor(ctx.sessionId, ctx.turn),
      whitelist: SUBSTITUTION_WHITELIST,
      shadow: ctx.doc.shadow,
    })
  } catch {
    return { shadowCommitted: false }
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
    return { shadowCommitted: false }
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
    // Availability is checked before pricing: a missing LLM/route is the
    // `selector-unavailable` degradation, not an admission decision.
    if (selectorSeamUnavailable(deps, ctx)) {
      await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'selector-unavailable', { stepId: 'root' }))
      return { shadowCommitted: false }
    }
    selectorReceiptText = selectorReceiptOf(deps, ctx)
    const charge = selectorChargeOf(deps, decision.candidates, selectorReceiptText)
    if (charge === undefined) {
      await appendReceipt(
        deps,
        ledgerEntry(ctx, 'skip', 'not-admitted', { stepId: 'root', reason: 'no-estimator' }),
      )
      return { shadowCommitted: false }
    }
    selectorOverhead = charge
    if (!admittedFor(deps, ctx.sessionId, plan, selectorOverhead)) {
      await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'not-admitted', { stepId: 'root' }))
      return { shadowCommitted: false }
    }
    // The decision's candidates already carry the bound trees; committing from
    // the plan here would dispatch a `$public` template.
    const chosen = await chooseCandidate(deps, ctx, decision.candidates, selectorReceiptText)
    if (chosen === undefined) return { shadowCommitted: false }
    candidate = chosen
    boundArgs = chosen.args
    candidateId = chosen.id
  } else if (decision.kind === 'fallback') {
    // This invocation enqueued nothing, so any pending entry belongs to another
    // call in the step; cancelling it would leave the budget spent and usage
    // marked for a substitution that never runs (review F2).
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', decision.code, { stepId: 'root' }))
    return { shadowCommitted: false }
  } else {
    candidate = plan.steps.find((step) => step.id === decision.candidateId)
    boundArgs = decision.args
    candidateId = decision.candidateId
  }

  if (candidate === undefined || boundArgs === undefined || candidateId === undefined) {
    // decide only commits its own plan's ids; this is containment, not a path.
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'no-candidate', { stepId: 'root' }))
    return { shadowCommitted: false }
  }

  // The live visibility check runs for the shadow path too: the record-only
  // measurement must describe the same population the real admission would
  // consider, not a broader one (review F2). The cached judgement passed above,
  // but the document may have changed while the session ran.
  if (!substitutableSession(deps, ctx.sessionId, ctx.doc)) {
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'skip:no-scope', { stepId: 'root' }))
    return { shadowCommitted: false }
  }

  if (ctx.doc.shadow) {
    // Record-only: the same `shadow` flag was passed to `decide` above, so the
    // recorded potential matches the policy that produced it. No queue entry,
    // no budget, and no projection (obligation 5).
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
      }),
    )
    consumePlan(deps, ctx.sessionId, candidateId)
    return { shadowCommitted: true }
  }

  const step = clockStepOf(deps, ctx.sessionId)
  if (step === undefined) {
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', 'substitution-unavailable', { stepId: 'root', reason: 'no-step' }),
    )
    return { shadowCommitted: false }
  }
  if (deps.queue == null || typeof deps.queue.set !== 'function') {
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', 'substitution-unavailable', { stepId: 'root', reason: 'no-queue' }),
    )
    return { shadowCommitted: false }
  }

  if (!admittedFor(deps, ctx.sessionId, plan, selectorOverhead)) {
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'not-admitted', { stepId: 'root' }))
    return { shadowCommitted: false }
  }

  if (!takeBudget(deps, ctx.sessionId)) {
    // No entry is ours to clear here: this invocation enqueued nothing, so a
    // live entry belongs to another call in the step (review F2).
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'steps-exhausted', { stepId: 'root' }))
    return { shadowCommitted: false }
  }

  const callId = callIdFor(ctx.sessionId, ctx.turn, step, candidateId)
  const entry: PendingEntry = {
    callId,
    candidateId,
    // The candidate's tool name identifies the call; the executable args are
    // the *decision's* bound tree, never the plan's `$public` template.
    name: candidate.tool,
    args: boundArgs,
    turn: ctx.turn,
    step,
    createdAt: Date.now(),
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
    return { shadowCommitted: false }
  }

  markSubstituted(deps, ctx.sessionId, candidateId)
  // Anchors name the templates the executed call was bound from: the decision's
  // args are already expanded, so only the plan copy still carries the
  // `$public` references. That tree is inspected here, never dispatched.
  setAnchors(deps, ctx, plan.steps.find((step) => step.id === candidateId)?.args ?? boundArgs)
  consumePlan(deps, ctx.sessionId, candidateId)
  return { shadowCommitted: false }
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

/** `projection-skipped:<reason>`; `projectApply` already prefixes one reason. */
function projectionSkipCode(reason: string): string {
  return reason.startsWith('projection-skipped:') ? reason : `projection-skipped:${reason}`
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
 */
async function projectDecision(
  deps: HookDeps,
  receipt: CanonicalReceipt,
  decision: PostExecuteDecision,
  ctx: DecisionContext,
): Promise<PostExecuteDecision> {
  const mode: ProjectionMode = ctx.doc.projection
  if (mode === 'off') return decision

  const toolName = ctx.exec.name
  const family = toolName === undefined ? undefined : familyOf(toolName)
  if (family === undefined) {
    // The mapper missed a tool. Count it so status can distinguish "no window
    // configured, by design" from "a decorated name was never recognised".
    try {
      deps.projectionCounters?.unknownFamily(toolName)
    } catch {
      // A counter is evidence, never a precondition.
    }
    return decision
  }
  const target = projectionTargetOf(decision, receipt, ctx.result)
  if (target === undefined) return decision

  // Clipping does not need a token meter; only its accounting does (design
  // §9). With no estimator the replacement still happens, but the receipts
  // carry `estimate:'unknown'` and no fabricated numbers.
  const estimate = estimatorOf(deps)

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
      formatFooter: await resolveFooterFormatter(),
    })

    if (outcome.kind === 'applied') {
      // Remember the artifact's only address: this is what makes a later read
      // of it a counted retrieval instead of a free one (design §5.3).
      if (outcome.locator !== undefined) deps.retrievals?.record(ctx.sessionId, outcome.locator)

      // The applied event is always recorded; only the token figures depend on
      // the meter. One-time `before`/`after`/`saved_projection_tokens` are the
      // authoritative names (§5.3); `status` applies the replay factor once to
      // the aggregate, never per receipt.
      const before = estimate === undefined ? undefined : safeEstimate(estimate, target)
      const after = estimate === undefined ? undefined : safeEstimate(estimate, content)
      if (before !== undefined && after !== undefined) {
        await appendReceipt(
          deps,
          ledgerEntry(ctx, 'projection', 'projected', {
            unit: 'raw',
            ...(ctx.retrievalCall === true ? { call_was_retrieval: true } : {}),
            before,
            after,
            saved_projection_tokens: before - after,
            estimate: deps.estimateKind ?? 'unknown',
          }),
        )
      } else {
        await appendReceipt(
          deps,
          ledgerEntry(ctx, 'projection', 'projected', {
            unit: 'raw',
            ...(ctx.retrievalCall === true ? { call_was_retrieval: true } : {}),
            estimate: 'unknown',
          }),
        )
      }
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
      // `projection` one: every `kind:'projection'` receipt in this plugin
      // carries numeric before/after and `saved_projection_tokens`.
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
 * function: decide, then the double-projection guard, then project. A shadow
 * commit stops before the guard because it must neither project nor pay for
 * the notice predicate.
 */
async function applyDecision(
  deps: HookDeps,
  decision: PostExecuteDecision,
  ctx: DecisionContext,
): Promise<PostExecuteDecision> {
  const outcome = await decideSubstitution(deps, ctx)
  if (outcome.shadowCommitted) return decision

  // Second-projection guard. The host spiller registers with `{ prepend: true }`,
  // so its footer is applied to the decision *after* this listener's next(),
  // never to the `result.content` received here. Check the decision that will
  // enter history, and the receiver as it arrived (design §5.4).
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

  // Detect the retrieval before the visibility gate (a projected receipt
  // already consumed context regardless of today's scope), but write its cost
  // only after projection, when the final visible content is known (review I3).
  const retrieval = pendingRetrievalOf(deps, exec, sessionId)

  if (!isActiveSession(deps, sessionId)) {
    if (retrieval !== undefined) {
      const arrival = canonicalise(result?.content ?? [], result?.isError === true)
      await recordProjectionRetrieval(deps, exec, sessionId, retrieval, arrival.text)
    }
    await appendSkipNoScope(deps.receipts, exec, sessionId, clockTurnOf(deps, sessionId))
    return decision
  }

  try {
    // Canonicalise the original receiver, not a downstream replacement: guards
    // and the selector read the receipt as it arrived.
    const receipt = canonicalise(result?.content ?? [], result?.isError === true)
    const turn = clockTurnOf(deps, sessionId)

    // The receipt map is the gate's memory for this turn. `begin` folds the
    // previous turn away (anchors live in the store, receipts and in-flight
    // dispatches here), then the arriving receipt becomes `root` and, if it is
    // the call we substituted, also becomes the candidate's receipt.
    const { rolledOver } = state.begin(sessionId, turn)
    if (rolledOver) {
      // A pending entry from the previous turn can never match a call in this
      // one, so it is dead weight; the reset path clears mid-turn (F2).
      clearAnchors(deps, sessionId)
      clearPending(deps, sessionId)
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
      const reset = markerResetOf(pending, receipt.text)
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
    turn: clockTurnOf(deps, sessionId),
    stepId: 'root',
    kind: 'skip',
    code: 'dispatch-rejected',
    tool: exec.name,
    callId: typeof exec.callId === 'string' ? exec.callId : undefined,
    candidateId: entry.candidateId,
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
  state: ReceiptSessionState,
  exec: DispatchExec,
): Promise<
  | { kind: 'next' }
  | { kind: 'reject'; message: string }
  | { kind: 'accept'; sessionId: string; callId: string; candidateId: string }
> {
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
  return { kind: 'accept', sessionId, callId: entry.callId, candidateId: entry.candidateId }
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
  let outcome: Awaited<ReturnType<typeof inspectDispatch>>
  try {
    outcome = await inspectDispatch(deps, state, exec)
  } catch {
    return next()
  }

  if (outcome.kind === 'reject') return dispatchFailure(outcome.message)
  if (outcome.kind === 'accept') {
    try {
      state.recordDispatch(
        outcome.sessionId,
        clockTurnOf(deps, outcome.sessionId),
        outcome.callId,
        outcome.candidateId,
      )
    } catch {
      // Losing the mapping costs the candidate receipt, not this call.
    }
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
  registerProtocolSection(ctx, deps.scope)
  registerPostExecute(ctx, deps, state)
  registerLlmStream(ctx, deps)
  registerExecute(ctx, deps, state)
}
