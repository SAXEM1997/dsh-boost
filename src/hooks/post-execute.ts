/**
 * Host hook assembly: the four mount points the plugin owns.
 *
 * Registration is the whole of this task; every hook body is a seam a later
 * task fills in, and the registration is split one function per mount so each
 * body can be replaced without rewriting the mount:
 *
 * - `tools/post-execute` canonicalises the result, abandons the decision when
 *   the host rewrote the receipt under the stored anchors (pruner / compaction,
 *   design §5.2-7), refuses to project a receipt that already carries the host
 *   spill footer, and then leaves a slot for the substitution decision (Task
 *   23b) and one for projection (Task 23b/T25). A call with no `exec.agent` is
 *   not the plugin's to inspect: the downstream decision is returned untouched
 *   and a `skip:no-scope` receipt keeps the pass visible (design §5.5).
 * - `llm/stream` lets the plugin's own selector request through before any
 *   synthesis exists; a boundary request is likewise delegated to `next()`
 *   until Task 23c adds the pending-turn branch.
 * - `tools/execute` compares the arriving dispatch with the pending
 *   substitution and refuses a mismatch with the host's failure result. The
 *   pending lookup is a seam that returns nothing today; Task 23b supplies the
 *   queue-backed one, so with no pending entry the mount stays a pass-through.
 * - the `systemPrompt` section reads the per-agent judgement cache
 *   synchronously. Its `text` must be a function, never a static string: a
 *   static string would inject the protocol into every session unconditionally
 *   and defeat the scope document (design §5.5).
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
import { alreadySpilled, invalidate } from '../gate/invalidate.js'
import type { AnchorStore, ReceiptAnchors } from '../gate/invalidate.js'
import { PROTOCOL_NAME, PROTOCOL_ORDER, PROTOCOL_TEXT } from '../prompt/protocol.js'
import { canonicalise } from '../projection/canonicalise.js'
import type { CanonicalReceipt } from '../projection/canonicalise.js'
import type { ReceiptStore } from '../receipts/store.js'
import type { ScopeStore } from '../scope/store.js'
import { SELECTOR_PURPOSE } from '../selector/jev.js'
import type { AgentLike, BoostConfig, PluginContext } from '../types.js'
import { rejectIfTampered } from './execute.js'

/** The execution facts a `tools/post-execute` listener reads here. */
type PostExecuteExec = {
  name?: string
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
 * This task only forwards one, so only `kind` is interpreted; every other field
 * belongs to the host contract (`accept` with content/value, or `block`).
 */
type PostExecuteDecision = {
  kind: 'accept' | 'block'
  [key: string]: unknown
}

/** The dispatch fields the tamper check reads (the host passes a `ToolDispatchExecution`). */
type DispatchExec = {
  name: string
  arguments: unknown
}

/** The decided substitution a dispatch is checked against. */
type PendingEntry = {
  name: string
  args: Record<string, unknown>
}

/** The dependencies a post-execute body reads; Task 23b widens this shape. */
type PostExecuteDeps = {
  config: BoostConfig
  receipts: ReceiptStore
  /**
   * Per-session receipt anchors.
   *
   * Task 23b writes them on the decision path; this hook only reads them to
   * check for an external rewrite and clears them on a hit. Absent means "no
   * pending substitution", never "fail the call".
   */
  anchors?: AnchorStore
  /**
   * Whether a receipt already carries the host spill footer.
   *
   * Injected so the host spill policy stays an optional peer (Task 23b/T25
   * supply its dynamically imported `hasSpillNotice`) and so a test can hand
   * over a throwing predicate without the host package. Absent means "ask the
   * host package lazily"; a missing package means no notice can exist.
   */
  hasSpillNotice?: (text: string) => boolean
  /**
   * The pending-substitution seam.
   *
   * Task 23b supplies the queue-backed lookup; nothing provides it today, so
   * the `tools/execute` mount has no pending entry to defend and passes
   * through exactly as before. `undefined` means "not substituting this call",
   * never "reject it".
   */
  pendingEntry?: (exec: DispatchExec) => PendingEntry | undefined
}

/**
 * The judgement-cache key carried by the assembly context's `scope`.
 *
 * Never the whole context and never a synthesized fallback: an unresolvable
 * scope has no key, and the provider must then inject nothing rather than ask
 * for a shared global judgement.
 */
function agentKeyOf(scope: unknown): string | undefined {
  const id = (scope as AgentLike | undefined)?.session?.header?.id
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

/**
 * The `tools/execute` hook body: refuse a tampered substitution.
 *
 * With no pending entry the plugin is not substituting this call, so `next()`
 * runs untouched. Otherwise the arriving call is compared literally with the
 * decision, and a mismatch is refused *without* calling `next()` — the entire
 * point is that the tool must not run. The hook does not clear the pending
 * entry: it cannot see the queue, so `registerHooks` clears it after receiving
 * a reject (Task 23b wires the lookup and the clearing).
 *
 * The refusal is the host's `ToolExecutionFailure` branch
 * (`{ isError: true, error: { message, info }, content }`), never a private
 * envelope: the executor normalises whatever a wrapper returns, so anything
 * else would be silently ignored. This waterfall documents no dedicated
 * refusal decision (it promises only `exec.signal` replacement); returning the
 * failure is the closest legal mechanism and the executor accepts it.
 */
function executeHook(
  deps: PostExecuteDeps,
  exec: DispatchExec,
  next: () => Promise<unknown>,
): Promise<unknown> {
  const pending = deps.pendingEntry?.(exec)
  const verdict = rejectIfTampered(exec, pending)
  if (!verdict.reject) return next()
  const message =
    'dsh-boost refused a substituted call: the dispatched arguments do not match the pending decision'
  return Promise.resolve({
    isError: true,
    error: {
      message,
      info: { name: 'DispatchRejectedError', code: verdict.code },
    },
    content: [{ type: 'text', text: `Error: ${message}` }],
  })
}

/**
 * Append one `skip:no-scope` receipt.
 *
 * There is no agent, hence no session id and no turn; the empty session id and
 * turn zero are honest placeholders, and the `code` is the field status counts.
 * The write is contained: an audit-trail failure must never turn a tool result
 * into an error.
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

/**
 * The substitution-decision seam.
 *
 * Task 23b replaces this body with the evidence/plan/guard decision, which must
 * read the canonical original (not any downstream replacement). Task 17 has no
 * evidence layer yet, so it always declines and the normal decision stands.
 */
function decideSubstitution(_receipt: CanonicalReceipt): PostExecuteDecision | undefined {
  return undefined
}

/** The session a post-execute call belongs to, or `undefined` when the host supplied none. */
function sessionIdOf(exec: PostExecuteExec | undefined): string | undefined {
  const id = exec?.agent?.session?.header?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * Read the session's pending anchors without ever failing the call.
 *
 * The store is a plain map in production, but it arrives through an injected
 * dependency: a foreign implementation that throws must degrade to "no pending
 * anchors", not replace the tool result with an error.
 */
function pendingAnchorsOf(deps: PostExecuteDeps, sessionId: string): ReceiptAnchors | undefined {
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
 * body is never read (design §5.2-7): after a prune the log holds head + marker
 * + tail, so re-reading it would "confirm" an anchor the model can no longer
 * see. Clearing happens before the receipt write so a stalled store cannot
 * leave the stale anchors in place; both steps are contained so the tool result
 * survives.
 */
async function resetInvalidatedPending(
  deps: PostExecuteDeps,
  exec: PostExecuteExec | undefined,
  sessionId: string,
  pending: ReceiptAnchors,
  code: 'pruned-reset' | 'compaction-reset',
): Promise<void> {
  try {
    deps.anchors?.clear(sessionId)
  } catch {
    // A foreign store must not turn the tool result into an error.
  }
  await appendResetReceipt(deps.receipts, exec, sessionId, pending.stepId, code)
}

/**
 * The host's spill-notice predicate, resolved at most once per process.
 *
 * `@deepseek-ai/dsh-spill-policy` is an optional peer (design §5.4), so its
 * notice module is imported dynamically: a static import would make the plugin
 * fail to load on a host without the spill policy, and the degraded path would
 * be unreachable. A missing package means no receipt can carry its footer, so
 * the guard simply does not fire. The deps seam wins, which is what keeps the
 * guard testable without the host.
 */
let noticePredicate: Promise<((text: string) => boolean) | undefined> | undefined

function resolveNoticePredicate(
  deps: PostExecuteDeps,
): Promise<((text: string) => boolean) | undefined> {
  if (typeof deps.hasSpillNotice === 'function') return Promise.resolve(deps.hasSpillNotice)
  noticePredicate ??= import('@deepseek-ai/dsh-spill-policy/notice')
    .then((module) => (typeof module.hasSpillNotice === 'function' ? module.hasSpillNotice : undefined))
    .catch(() => undefined)
  return noticePredicate
}

/**
 * Whether projection must be skipped because the host already spilled this
 * receipt (design §5.4).
 *
 * A predicate that throws counts as "already spilled": when the notice cannot
 * be ruled out, a second projection could hide the original twice, so the safe
 * direction is to leave the receipt alone. This hook may not throw either way —
 * the host replaces a throwing listener's result with a tool error
 * (`dsh-tools/lib/pipeline.js:538-550`), losing the very output the plugin
 * exists to preserve.
 */
async function isAlreadySpilled(deps: PostExecuteDeps, receiptText: string): Promise<boolean> {
  try {
    const hasNotice = await resolveNoticePredicate(deps)
    return hasNotice !== undefined && alreadySpilled(receiptText, hasNotice)
  } catch {
    return true
  }
}

/**
 * The projection seam.
 *
 * Task 23b/T25 replace this body with shadow accounting or a real replacement.
 * Task 17 injects neither a spill backend nor a token estimator, so the
 * decision the waterfall produced reaches history unchanged.
 */
function projectDecision(
  _deps: PostExecuteDeps,
  _receipt: CanonicalReceipt,
  decision: PostExecuteDecision,
): PostExecuteDecision {
  return decision
}

/**
 * The `tools/post-execute` body.
 *
 * `next()` runs first, exactly like the host's own spill policy: a listener
 * either returns a decision or calls `next()` and returns its result, and
 * bypassing it would silently drop the listeners mounted after this one. The
 * fixed order that follows is `canonicalise → invalidate → substitution
 * decision → double-projection guard → projection → return the decision`
 * (design §5.2-7/§5.4-5); Task 23b puts real bodies in the decision and
 * projection stages.
 *
 * Both Task-22 guards may abandon the decision, and neither may throw: the host
 * turns a throwing `post-execute` listener into an error result and the real
 * tool output is lost.
 */
async function postExecute(
  deps: PostExecuteDeps,
  exec: PostExecuteExec | undefined,
  result: PostExecuteResult | undefined,
  next: () => Promise<PostExecuteDecision>,
): Promise<PostExecuteDecision> {
  const decision = await next()

  if (exec?.agent === undefined) {
    await appendSkipNoScope(deps.receipts, exec)
    return decision
  }

  // Canonicalise the original receiver, not a downstream replacement: guards
  // and the selector read the receipt as it arrived.
  const receipt = canonicalise(result?.content ?? [], result?.isError === true)

  // External invalidation first: a receipt the host rewrote under our anchors
  // must abandon the decision before any stage reads it (design §5.2-7).
  const sessionId = sessionIdOf(exec)
  if (sessionId !== undefined) {
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
  }

  const substituted = decideSubstitution(receipt)
  if (substituted !== undefined) return substituted

  // Second-projection guard: a receipt that already carries the host spill
  // footer must not be projected again (design §5.4).
  if (await isAlreadySpilled(deps, receipt.text)) return decision
  return projectDecision(deps, receipt, decision)
}

/** Mount the projection waterfall. */
function registerPostExecute(ctx: PluginContext, deps: PostExecuteDeps): void {
  ctx.on('tools/post-execute', (exec, result, next) => postExecute(deps, exec, result, next))
}

/** Mount the model-request waterfall. */
function registerLlmStream(ctx: PluginContext): void {
  ctx.on('llm/stream', (options, next) => streamHook(options, next))
}

/** Mount the dispatch waterfall. */
function registerExecute(ctx: PluginContext, deps: PostExecuteDeps): void {
  ctx.on('tools/execute', (exec, next) => executeHook(deps, exec, next))
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
 * `scope` and `receipts` are checked at the point of use, not here: a host
 * wiring the plugin without one of them still gets the four mount points, and
 * every degraded path is fail-closed instead of throwing during registration.
 * The same holds for the `pendingEntry` seam: without it the dispatch mount
 * simply has nothing to defend. Task 23b widens `deps` into `HookDeps`; it adds
 * optional fields only, so this signature keeps its required ones.
 */
export function registerHooks(
  ctx: PluginContext,
  deps: { config: BoostConfig; scope: ScopeStore; receipts: ReceiptStore },
): void {
  registerProtocolSection(ctx, deps.scope)
  registerPostExecute(ctx, deps)
  registerLlmStream(ctx)
  registerExecute(ctx, deps)
}
