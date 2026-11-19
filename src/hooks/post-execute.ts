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
 * - `llm/stream` lets the plugin's own selector request through before any
 *   synthesis exists; a boundary request is likewise delegated to `next()`
 *   until Task 23c adds the pending-turn branch.
 * - `tools/execute` looks the session's pending substitution up with `peek`
 *   (never `take`: the entry must survive to this hook), compares the arriving
 *   `callId` itself, then hands name/arguments to `rejectIfTampered`. The
 *   entry is cleared on **both** paths — accepted and rejected — because a
 *   stale entry would falsely reject every later differing call in the session.
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
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { worthSubstituting } from '../admission/ledger.js'
import type { StepBudget } from '../admission/ledger.js'
import type { UsageLedger } from '../admission/usage.js'
import { DEFAULT_CONFIG } from '../config.js'
import { decide } from '../gate/decide.js'
import { alreadySpilled, invalidate } from '../gate/invalidate.js'
import type { AnchorStore, ReceiptAnchors } from '../gate/invalidate.js'
import type { Plan } from '../gate/plan.js'
import { PROTOCOL_NAME, PROTOCOL_ORDER, PROTOCOL_TEXT } from '../prompt/protocol.js'
import { projectApply, projectShadow } from '../projection/apply.js'
import type { FormatFooter, ProjectionMode, SpillBackend, SpillHandle } from '../projection/apply.js'
import { canonicalise } from '../projection/canonicalise.js'
import type { CanonicalReceipt } from '../projection/canonicalise.js'
import type { ReceiptStore } from '../receipts/store.js'
import { DEFAULT_SCOPE, isVisible } from '../scope/doc.js'
import type { ScopeDoc } from '../scope/doc.js'
import type { ScopeStore } from '../scope/store.js'
import { SELECTOR_PURPOSE } from '../selector/jev.js'
import type { AgentLike, BoostConfig, PluginContext, ToolFamily } from '../types.js'
import type { TurnClock } from './clock.js'
import { rejectIfTampered } from './execute.js'
import { callIdFor } from './pending.js'
import type { PendingEntry, PendingQueue } from './pending.js'
import { ReceiptSessionState } from './session-state.js'

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
  /** Per-turn substitution budget; absent means no cap is applied. */
  budget?: StepBudget
  /** Usage pairing for `markSubstituted` and the measured saving (T21/T23c). */
  usage?: UsageLedger
  /** The host turn/step clock; `step()` is the only source of a call id's step. */
  clock?: TurnClock
  /** Parsed plans per session, written by 23c's stream hook. */
  plans?: Map<string, Plan>
  /** The host spill backend; absent skips apply-mode projection. */
  spill?: SpillBackend
  /** Token estimator; absent skips projection accounting entirely. */
  estimateText?: (t: string) => number
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

/**
 * The `llm/stream` hook body.
 *
 * The selector guard is the first statement by rule: the plugin's own selection
 * request must never be mistaken for a substitution boundary. A boundary
 * request is a pass-through too until Task 23c synthesizes a pending turn, so
 * the two branches are deliberately identical for now.
 */
function streamHook(
  options: GenerateOptions | undefined,
  next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  if (options?.purpose === SELECTOR_PURPOSE) return next()
  return next()
}

// ---------------------------------------------------------------------------
// Defensive readers: every foreign call is wrapped
// ---------------------------------------------------------------------------

/** The host turn, or 0 when no clock is wired (receipts still carry `ts`). */
function clockTurnOf(deps: HookDeps): number {
  try {
    const turn = deps.clock?.turn()
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
function clockStepOf(deps: HookDeps): number | undefined {
  try {
    const step = deps.clock?.step()
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

/** Ask {@link invalidate} without letting a malformed anchor record escape as a throw. */
function invalidationOf(
  pending: ReceiptAnchors,
  receiptText: string,
): 'pruned-reset' | 'compaction-reset' | undefined {
  try {
    return invalidate(pending, receiptText)
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
): Promise<void> {
  if (receipts == null || typeof receipts.append !== 'function') return
  try {
    await receipts.append({
      version: 1,
      ts: new Date().toISOString(),
      sessionId: '',
      turn: 0,
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
  stepId: string,
  code: 'pruned-reset' | 'compaction-reset',
): Promise<void> {
  if (receipts == null || typeof receipts.append !== 'function') return
  try {
    await receipts.append({
      version: 1,
      ts: new Date().toISOString(),
      sessionId,
      // The mount observes no turn index; 0 is the same honest placeholder
      // `skip:no-scope` uses, and the receipt's `ts` keeps ordering evidence.
      turn: 0,
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
  pending: ReceiptAnchors,
  code: 'pruned-reset' | 'compaction-reset',
): Promise<void> {
  clearAnchors(deps, sessionId)
  await appendResetReceipt(deps.receipts, exec, sessionId, pending.stepId, code)
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

/** A tool name to projection family; the ssh host tool keeps its MCP name (T25 centralises). */
function familyOf(tool: string | undefined): ToolFamily | undefined {
  if (tool === undefined) return undefined
  if (tool === 'read' || tool === 'grep' || tool === 'glob' || tool === 'bash' || tool === 'ssh') {
    return tool
  }
  if (tool === 'mcp__ssh__execute-command') return 'ssh'
  return undefined
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
function savedTokensOf(deps: HookDeps): number {
  try {
    const last = deps.usage?.last()
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
function admittedFor(deps: HookDeps, plan: Plan): boolean {
  try {
    const threshold = deps.config?.admission?.thresholdTokens
    const thresholdTokens =
      typeof threshold === 'number' && Number.isFinite(threshold)
        ? threshold
        : DEFAULT_CONFIG.admission.thresholdTokens
    return worthSubstituting({
      savedTokens: savedTokensOf(deps),
      overheadTokens: 0,
      thresholdTokens,
      deterministicSingle: plan.steps.length === 1,
    })
  } catch {
    return false
  }
}

/** Claim one budget step; no budget wired means no cap is applied. */
function takeBudget(deps: HookDeps): boolean {
  try {
    const budget = deps.budget
    if (budget == null || typeof budget.take !== 'function') return true
    return budget.take()
  } catch {
    return false
  }
}

/** Record the substitution for the usage pairing; settlement is Task 23c's. */
function markSubstituted(deps: HookDeps, candidateId: string): void {
  try {
    deps.usage?.markSubstituted?.(candidateId)
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
 * The substitution decision and its side effects.
 *
 * The fixed order is the plan's: existence of a plan and a receipt first, then
 * `worthSubstituting`, then `budget.take()`. Nothing below spends budget on a
 * decision that will not be dispatched.
 *
 * `ask-selector` is Task 23c's seam: this hook keeps the plan untouched and
 * performs no selector call (the selector is an LLM request, and this task owns
 * no stream hook). `fallback` clears the session's pending entry and records
 * the decision code; a commit consumes the candidate and, outside shadow
 * mode, parks the substituted call for `tools/execute`.
 */
async function decideSubstitution(
  deps: HookDeps,
  ctx: DecisionContext,
): Promise<{ shadowCommitted: boolean }> {
  const plan = safePlan(deps, ctx.sessionId)
  if (plan === undefined) return { shadowCommitted: false }

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

  if (decision.kind === 'ask-selector') {
    // Seam for Task 23c: the selector call and the chosen candidate's
    // `candidates[i].args` are stream-hook work. Keep the plan so the next
    // decision sees the same candidates.
    return { shadowCommitted: false }
  }

  if (decision.kind === 'fallback') {
    clearPending(deps, ctx.sessionId)
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', decision.code, { stepId: 'root' }))
    return { shadowCommitted: false }
  }

  const candidate = plan.steps.find((step) => step.id === decision.candidateId)
  if (candidate === undefined) {
    // decide only commits its own plan's ids; this is containment, not a path.
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'no-candidate', { stepId: 'root' }))
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
        candidateId: decision.candidateId,
        admitted: admittedFor(deps, plan),
        whitelisted: SUBSTITUTION_WHITELIST.has(candidate.tool),
        stepId: 'root',
        args: decision.args,
      }),
    )
    consumePlan(deps, ctx.sessionId, decision.candidateId)
    return { shadowCommitted: true }
  }

  if (!substitutableSession(deps, ctx.sessionId, ctx.doc)) {
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'skip:no-scope', { stepId: 'root' }))
    return { shadowCommitted: false }
  }

  const step = clockStepOf(deps)
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

  if (!admittedFor(deps, plan)) {
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'not-admitted', { stepId: 'root' }))
    return { shadowCommitted: false }
  }

  if (!takeBudget(deps)) {
    await appendReceipt(deps, ledgerEntry(ctx, 'skip', 'steps-exhausted', { stepId: 'root' }))
    clearPending(deps, ctx.sessionId)
    return { shadowCommitted: false }
  }

  const callId = callIdFor(ctx.sessionId, ctx.turn, step, decision.candidateId)
  const entry: PendingEntry = {
    callId,
    candidateId: decision.candidateId,
    // The candidate's tool name identifies the call; the executable args are
    // the *decision's* bound tree, never the plan's `$public` template.
    name: candidate.tool,
    args: decision.args,
    turn: ctx.turn,
    step,
    createdAt: Date.now(),
  }
  try {
    deps.queue.set(ctx.sessionId, entry)
  } catch {
    await appendReceipt(
      deps,
      ledgerEntry(ctx, 'skip', 'substitution-unavailable', { stepId: 'root', reason: 'queue-failed' }),
    )
    return { shadowCommitted: false }
  }

  markSubstituted(deps, decision.candidateId)
  setAnchors(deps, ctx, candidate.args)
  consumePlan(deps, ctx.sessionId, decision.candidateId)
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

  const family = familyOf(ctx.exec.name)
  if (family === undefined) return decision
  const target = projectionTargetOf(decision, receipt, ctx.result)
  if (target === undefined) return decision

  const estimate = estimatorOf(deps)
  if (estimate === undefined) return decision

  try {
    if (mode === 'shadow') {
      const outcome = await projectShadow({
        text: target,
        isError: receipt.isError,
        family,
        cfg: deps.config,
        estimate,
      })
      if (outcome.kind === 'shadow') {
        await appendReceipt(
          deps,
          ledgerEntry(ctx, 'shadow', 'projection-shadow', {
            decision: 'projection',
            unit: 'raw',
            before: outcome.before,
            after: outcome.after,
            saved_projection_tokens: outcome.saved,
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
      const before = safeEstimate(estimate, target)
      const after = safeEstimate(estimate, content)
      // The authoritative names are the design's (§5.3): a projection receipt
      // without `saved_projection_tokens` is counted as zero by `boost status`.
      if (before !== undefined && after !== undefined) {
        await appendReceipt(
          deps,
          ledgerEntry(ctx, 'projection', 'projected', {
            unit: 'raw',
            before,
            after,
            saved_projection_tokens: before - after,
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
  if (sessionId === undefined || !isActiveSession(deps, sessionId)) return decision

  try {
    // Canonicalise the original receiver, not a downstream replacement: guards
    // and the selector read the receipt as it arrived.
    const receipt = canonicalise(result?.content ?? [], result?.isError === true)
    const turn = clockTurnOf(deps)

    // The receipt map is the gate's memory for this turn. `begin` folds the
    // previous turn away (anchors live in the store, receipts and in-flight
    // dispatches here), then the arriving receipt becomes `root` and, if it is
    // the call we substituted, also becomes the candidate's receipt.
    const { rolledOver } = state.begin(sessionId, turn)
    if (rolledOver) clearAnchors(deps, sessionId)
    state.recordRoot(sessionId, turn, receipt)
    fileDispatchedReceipt(state, exec, sessionId, turn, receipt)

    // Conservative local invalidation check. The tool-result path cannot see
    // the host pruner (it rewrites session surface nodes, not this waterfall)
    // or compaction, so this call site only catches a receipt whose tool output
    // literally carries the marker, plus an anchor mismatch; a hit only
    // abandons the decision, which is always safe. Task 23c owns the real
    // check on the model-request path.
    const pending = pendingAnchorsOf(deps, sessionId)
    // `!= null` rather than `!== undefined`: a foreign store can hand back a
    // null, and dereferencing it would throw out of the hook.
    if (pending != null) {
      const reset = invalidationOf(pending, receipt.text)
      if (reset !== undefined) {
        await resetInvalidatedPending(deps, exec, sessionId, pending, reset)
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
    }
    return await applyDecision(deps, decision, ctx)
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
    turn: clockTurnOf(deps),
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

  // `rejectIfTampered` compares name and parsed arguments only; the call id is
  // this hook's responsibility (T18's contract deliberately excludes it).
  if (typeof exec.callId !== 'string' || exec.callId !== entry.callId) {
    return reject(
      'dsh-boost refused a substituted call: the dispatched call id does not match the pending decision',
    )
  }
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
 * runs untouched. Otherwise the arriving call is looked up with `peek` — never
 * `take`: the entry must survive long enough for this hook to inspect it — and
 * compared with the decision. The entry is cleared on **both** paths. A stale
 * entry makes every later differing call in the session a false
 * `dispatch-rejected`, which is why the accept path clears too. On the accept
 * path the call id is remembered so the following `post-execute` can file the
 * receipt under its candidate id.
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
      state.recordDispatch(outcome.sessionId, clockTurnOf(deps), outcome.callId, outcome.candidateId)
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

/** Mount the model-request waterfall. */
function registerLlmStream(ctx: PluginContext): void {
  ctx.on('llm/stream', (options, next) => streamHook(options, next))
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
  const state = new ReceiptSessionState()
  registerProtocolSection(ctx, deps.scope)
  registerPostExecute(ctx, deps, state)
  registerLlmStream(ctx)
  registerExecute(ctx, deps, state)
}
