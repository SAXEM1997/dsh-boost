/**
 * Host hook assembly: the four mount points the plugin owns.
 *
 * Registration is the whole of this task; every hook body is a seam a later
 * task fills in, and the registration is split one function per mount so each
 * body can be replaced without rewriting the mount:
 *
 * - `tools/post-execute` canonicalises the result, then leaves a slot for the
 *   substitution decision (Task 23b) and one for projection (Task 23b/T25). A
 *   call with no `exec.agent` is not the plugin's to inspect: the downstream
 *   decision is returned untouched and a `skip:no-scope` receipt keeps the
 *   pass visible (design §5.5).
 * - `llm/stream` lets the plugin's own selector request through before any
 *   synthesis exists; a boundary request is likewise delegated to `next()`
 *   until Task 23c adds the pending-turn branch.
 * - `tools/execute` is a pass-through placeholder (Task 18 installs the
 *   tamper check).
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
import { canonicalise } from '../projection/canonicalise.js'
import type { CanonicalReceipt } from '../projection/canonicalise.js'
import type { ReceiptStore } from '../receipts/store.js'
import type { ScopeStore } from '../scope/store.js'
import { SELECTOR_PURPOSE } from '../selector/jev.js'
import type { AgentLike, BoostConfig, PluginContext } from '../types.js'

/** Section name the protocol text is registered under (design §5.3). */
const PROTOCOL_SECTION_NAME = 'dsh-boost'

/** Section order: the protocol sits with the other tool-contract sections. */
const PROTOCOL_SECTION_ORDER = 100

/**
 * Task 17 placeholder body for the protocol section.
 *
 * Task 20 replaces this with `PROTOCOL_TEXT`. It is exported so a wiring test
 * can name the value the provider must return without restating the literal.
 */
export const PLACEHOLDER_TEXT = ''

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

/** The dependencies a post-execute body reads; Task 23b widens this shape. */
type PostExecuteDeps = {
  config: BoostConfig
  receipts: ReceiptStore
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
  return scope.judgement(key) ? PLACEHOLDER_TEXT : ''
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
 * The `tools/execute` hook body.
 *
 * A pass-through placeholder: Task 18 replaces it with the pending-entry
 * tamper check. The mount point exists now so its registration is asserted.
 */
function executeHook(_exec: unknown, next: () => Promise<unknown>): Promise<unknown> {
  return next()
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
 * fixed order that follows is `canonicalise → substitution decision →
 * projection → return the decision` (design §5.4-5); Task 23b puts real bodies
 * in the two middle stages.
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
  const substituted = decideSubstitution(receipt)
  if (substituted !== undefined) return substituted
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
function registerExecute(ctx: PluginContext): void {
  ctx.on('tools/execute', (exec, next) => executeHook(exec, next))
}

/** Mount the protocol section, whose provider stays synchronous and per-agent. */
function registerProtocolSection(ctx: PluginContext, scope: ScopeStore | undefined): void {
  ctx.systemPrompt.section({
    name: PROTOCOL_SECTION_NAME,
    order: PROTOCOL_SECTION_ORDER,
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
 * Task 23b widens `deps` into `HookDeps`; it adds optional fields only, so this
 * signature keeps its required ones.
 */
export function registerHooks(
  ctx: PluginContext,
  deps: { config: BoostConfig; scope: ScopeStore; receipts: ReceiptStore },
): void {
  registerProtocolSection(ctx, deps.scope)
  registerPostExecute(ctx, deps)
  registerLlmStream(ctx)
  registerExecute(ctx)
}
