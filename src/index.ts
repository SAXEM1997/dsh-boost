/**
 * dsh-boost cordis plugin entry point.
 *
 * The plugin is a plain function plugin: cordis reads `name` and `inject` from
 * the module and calls `apply(ctx, config)`. Only the production assembly lives
 * here — configuration resolution, the two stores the hooks and the control
 * tool share, the hook mounts, the lifecycle events that warm visibility,
 * drive the clock, flush receipts at turn end and clean up on session
 * disposal, and the `boost` tool, all wired once per plugin instance.
 *
 * Wiring failures are contained: a host that lacks the services a mount point
 * lives on must load the plugin with a warning, not die loading it. The data
 * root is `<dshHome>/boost` (`config.dshHome` when the row supplies it, else
 * `$DSH_HOME`), falling back to `~/.dsh/boost`.
 *
 * ## Why the mount disposers are dropped
 *
 * `ctx.on`, `ctx.systemPrompt.section` and `ctx.tools.register` all return a
 * disposer. Every one is deliberately discarded. A cordis plugin entry is
 * mounted in its own context, and disposing that entry tears down everything
 * registered through it; a retained disposer would add nothing except the
 * chance that a stale closure removes a mount owned by a later instance. The
 * assumption is exactly that per-entry ownership — if this plugin is ever
 * mounted into a context it does not own (a shared host context), the
 * disposers, or an explicit teardown, become required (review row 76).
 *
 * @module dsh-boost
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { measureBoostFixedOverhead } from './tools/boost.js'
import { RuntimeStepHorizon, StepBudget } from './admission/ledger.js'
import { RetrievalLedger } from './admission/retrieval.js'
import { UsageLedger } from './admission/usage.js'
import { resolveConfig } from './config.js'
import { AnchorStore } from './gate/invalidate.js'
import type { Plan } from './gate/plan.js'
import { resolveBoostRoot } from './host/root.js'
import { clearSession, SessionRuntime } from './hooks/llm-stream.js'
import { TurnClock } from './hooks/clock.js'
import { PendingQueue } from './hooks/pending.js'
import { registerHooks } from './hooks/post-execute.js'
import type { HookDeps, SelectorRoute } from './hooks/post-execute.js'
import type { SpillBackend } from './projection/apply.js'
import { ProjectionCounters } from './projection/counters.js'
import { PROTOCOL_NAME, PROTOCOL_TEXT } from './prompt/protocol.js'
import { ReceiptStore } from './receipts/store.js'
import { SELECTOR_PURPOSE } from './selector/jev.js'
import { resolveWorkspace, supportsStepWhen } from './scope/resolve.js'
import type { WorkspaceRegistry } from './scope/resolve.js'
import { ScopeStore } from './scope/store.js'
import { boostTool } from './tools/boost.js'
import type { BoostDeps, BoostHostFacts } from './tools/boost.js'
import type { PluginContext } from './types.js'

export const name = 'dsh-boost'

export const inject = ['tools', 'llm', 'systemPrompt'] as const

/** Whether the host exposes both services the hook mounts attach to. */
function canRegister(ctx: PluginContext): boolean {
  return typeof ctx.on === 'function' && typeof ctx.systemPrompt?.section === 'function'
}

/** One-line detail for a contained wiring failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Duplicate applies observed in this process.
 *
 * The host exposes no stable duplicate-mount code for a prompt section, so the
 * plugin cannot match a code. Any throw from the first mount (the section) is
 * treated as "this plugin is already wired": the counter makes repeated applies
 * visible in the log without changing the mounts. Matching the error text was
 * rejected because a wording change would classify a duplicate as a generic
 * wiring failure (review row 46).
 */
let duplicateMountAttempts = 0

/**
 * Read a soft host service through `ctx.get`.
 *
 * `workspaceRegistry`, `spillStore` and `tokenMeter` are optional peers: a
 * static injection would make the plugin fail to load on a host that does not
 * provide them, so they are fetched, never declared in `inject`. A host whose
 * `get` throws is the same as one without the service (the plugin-load test
 * pins that the data root is never resolved this way).
 */
function serviceOf<T>(ctx: PluginContext, name: string): T | undefined {
  try {
    if (typeof ctx.get !== 'function') return undefined
    return ctx.get<T>(name) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * A memoising, retrying service getter.
 *
 * `ctx.get(name, strict=true)` answers `undefined` until the provider fiber is
 * ACTIVE, and cordis starts sibling plugin entries concurrently, so a service
 * read once in `apply` may simply not exist yet. A success is memoised; an
 * absence is never cached, because the provider may become active one tick
 * later. Every call site reads the getter, so the plugin recovers on the next
 * request instead of staying inert for the process lifetime.
 */
function lazyService<T>(ctx: PluginContext, name: string): () => T | undefined {
  let resolved: T | undefined
  return () => {
    if (resolved !== undefined) return resolved
    resolved = serviceOf<T>(ctx, name)
    return resolved
  }
}

/**
 * The session id behind an agent or a `Session`.
 *
 * An agent exposes `session.header.id`; the `session/disposed` payload is the
 * `Session` itself and exposes `header.id` (and `id`). Anything else is
 * `undefined`, which makes every caller fail closed.
 */
function sessionIdOf(value: unknown): string | undefined {
  const carrier = value as
    | {
        session?: { header?: { id?: unknown } }
        header?: { id?: unknown }
        id?: unknown
      }
    | undefined
  const agentId = carrier?.session?.header?.id
  if (typeof agentId === 'string') return agentId
  const headerId = carrier?.header?.id
  if (typeof headerId === 'string') return headerId
  return typeof carrier?.id === 'string' ? carrier.id : undefined
}

/**
 * The host token meter's synchronous message estimator, resolved lazily.
 *
 * `ctx.tokenMeter` is a cordis service with a synchronous `estimateMessage`
 * method, so `ctx.get('tokenMeter')` is a real synchronous seam. Like every
 * soft service it may become active after this plugin's `apply`, so the
 * estimator is probed on first use and re-probed while absent; a success is
 * memoised. Presence is not capability: a service that throws or returns a
 * non-finite number is a broken meter, not a meter, and substitution is
 * refused exactly as when no service exists (review R5). A broken meter is not
 * memoised either, so a provider that finishes wiring its meter later can
 * still recover.
 *
 * The receipt label is `host` so the number is never mistaken for a provider
 * measurement; the only other label would be a fabricated `chars/4` fallback,
 * which this assembly deliberately does not implement.
 *
 * Memoisation covers the *binding*, not the answer. `kind()` probes the
 * memoised estimator on every call, because a meter that answered once is not
 * a meter forever: after it starts returning `NaN`, projection receipts already
 * record `estimate:'unknown'` for that assembly, and a cached `host` label
 * would contradict them in the same `boost status` output.
 */
const METER_PROBE = 'dsh-boost meter probe'

function meterSeamOf(ctx: PluginContext): {
  estimate(): ((text: string) => number) | undefined
  kind(): 'host' | 'unknown'
} {
  let estimator: ((text: string) => number) | undefined
  /** One probe through a raw host estimator; a throw or non-number is failure. */
  const probe = (estimate: (message: unknown) => number): boolean => {
    try {
      const value = estimate({
        role: 'user',
        content: [{ type: 'text', text: METER_PROBE }],
      })
      return typeof value === 'number' && Number.isFinite(value)
    } catch {
      return false
    }
  }
  const resolve = (): ((text: string) => number) | undefined => {
    if (estimator !== undefined) return estimator
    const meter = serviceOf<{ estimateMessage?: (message: unknown) => number }>(ctx, 'tokenMeter')
    if (meter === undefined || typeof meter.estimateMessage !== 'function') return undefined
    const estimate = meter.estimateMessage.bind(meter)
    if (!probe(estimate)) return undefined
    estimator = (text: string): number => {
      try {
        const value = estimate({ role: 'user', content: [{ type: 'text', text }] })
        return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
      } catch {
        return Number.NaN
      }
    }
    return estimator
  }
  return {
    estimate: resolve,
    kind: () => {
      const estimate = resolve()
      if (estimate === undefined) return 'unknown'
      // Probe through the memoised wrapper, so the label prices the same
      // pipeline every receipt uses. `resolve()` alone cannot answer: it
      // returns a cached binding even after the meter stopped answering.
      return Number.isFinite(estimate(METER_PROBE)) ? 'host' : 'unknown'
    },
  }
}

/** How many disposed session ids the runtime facade remembers (FIFO). */
const MAX_DISPOSED_RUNTIME_SESSIONS = 256

/**
 * `SessionRuntime` that refuses to recreate state for a disposed session.
 *
 * `clearSession` drops a session's runtime entry, but a `post-execute` that was
 * already in flight (a selector call can take 20 s) lands after disposal and
 * calls `clockFor`/`budgetFor`/`usageFor` again; the base class would create a
 * fresh entry nothing ever clears. The facade returns throwaway primitives for
 * disposed ids instead: the late hook records nothing, and the map cannot grow
 * after session end. The id set is FIFO-bounded so a long process cannot grow
 * it without limit.
 */
class DisposalAwareSessionRuntime extends SessionRuntime {
  private readonly disposed = new Set<string>()
  private readonly disposedOrder: string[] = []

  /** Mark a session disposed and drop whatever the base class still holds. */
  markDisposed(sessionId: string): void {
    this.clear(sessionId)
    if (this.disposed.has(sessionId)) return
    this.disposed.add(sessionId)
    this.disposedOrder.push(sessionId)
    while (this.disposedOrder.length > MAX_DISPOSED_RUNTIME_SESSIONS) {
      const oldest = this.disposedOrder.shift()
      if (oldest !== undefined) this.disposed.delete(oldest)
    }
  }

  override clockFor(sessionId: string): TurnClock {
    return this.disposed.has(sessionId) ? new TurnClock() : super.clockFor(sessionId)
  }

  override budgetFor(sessionId: string): StepBudget {
    return this.disposed.has(sessionId) ? new StepBudget(0) : super.budgetFor(sessionId)
  }

  override usageFor(sessionId: string): UsageLedger {
    return this.disposed.has(sessionId) ? new UsageLedger() : super.usageFor(sessionId)
  }

  override onModelRequest(sessionId: string, turn: number, step?: number): void {
    if (!this.disposed.has(sessionId)) super.onModelRequest(sessionId, turn, step)
  }
}

/** The `agent/request` payload fields this assembly reads. */
type RequestPayload = {
  agent?: unknown
  turn?: unknown
  step?: unknown
  /** Captured step route on `agent/pre-step` (also the selector's inheritance source). */
  modelSelection?: unknown
}

/**
 * Warm the synchronous visibility cache and remember the canonical workspace.
 *
 * `resolveWorkspace` is the async answer and also writes `scope.judgement(key)`;
 * it prefers the registry's `resolveByPath`, so a symlinked or trailing-slash
 * cwd resolves to the same id the judgement used. The workspace id is kept even
 * when the answer is "invisible", so the resolver must consult the live
 * judgement rather than treating the map as the answer. A workspace disabled
 * after a commit therefore stops resolving before the next synthesized turn.
 */
async function warmVisibility(
  scope: ScopeStore,
  registry: () => WorkspaceRegistry | undefined,
  agent: unknown,
  sessionId: string,
  workspaces: Map<string, string>,
): Promise<boolean> {
  try {
    const result = await resolveWorkspace(scope, agent, registry())
    // The map carries identity, `scope.judgement` carries visibility: cache the
    // id even when the answer is "invisible", and let the resolver combine the
    // two. A stale id therefore cannot outlive a visibility change.
    if (typeof result.workspaceId === 'string') workspaces.set(sessionId, result.workspaceId)
    else workspaces.delete(sessionId)
    return result.visible
  } catch {
    // `resolveWorkspace` is total; this contains a foreign registry.
    return false
  }
}

/** Remember the effective route the selector call must inherit. */
function rememberRoute(
  routes: Map<string, SelectorRoute>,
  sessionId: string,
  config: unknown,
): void {
  const resolved = config as
    | { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    | undefined
  if (resolved == null) return
  if (typeof resolved.provider !== 'string' || typeof resolved.model !== 'string') return
  const route: SelectorRoute = { provider: resolved.provider, model: resolved.model }
  if (typeof resolved.reasoningEffort === 'string') route.reasoningEffort = resolved.reasoningEffort
  routes.set(sessionId, route)
}

/**
 * Replace the protocol section's already-resolved text with the fresh answer.
 *
 * This runs *after* the assemble waterfall, so it rewrites text a section
 * provider already produced. That is deliberate and does not contradict D4
 * ("persistent, stable content"): every agent has its own prompt prefix and
 * its own context window, so changing this section cannot invalidate another
 * agent's cached prefix. Within one agent the answer changes only when its
 * resolved visibility changes (a workspace edit/`scope-set`), which is exactly
 * the point at which the prefix must change; every other assembly reproduces
 * the same bytes. The alternative — a section whose text is fixed at
 * registration — would either leak one agent's visibility to every other or
 * require a second provider to read a cache this listener has not warmed yet.
 */
function patchProtocolSection(assembly: unknown, visible: boolean): unknown {
  const value = assembly as { sections?: unknown } | undefined
  if (value === undefined || value === null || !Array.isArray(value.sections)) return assembly
  const sections = value.sections.map((section) => {
    const entry = section as { name?: unknown } | null
    return entry?.name === PROTOCOL_NAME
      ? { ...(entry as Record<string, unknown>), text: visible ? PROTOCOL_TEXT : '' }
      : section
  })
  return { ...(value as Record<string, unknown>), sections }
}

/** The marker every protocol text carries; a system prompt without it lost the section. */
const PROTOCOL_PROBE = '<CHISEL_PLAN>'

/**
 * The system-role text of one model request, or `undefined` when the request
 * carries no system prompt at all.
 *
 * Loop-built requests put the rendered prompt in the leading system-role
 * message (``GenerateOptions.messages``); one-shot callers use `system`. A
 * request with neither is a diagnostic that cannot tell us whether the section
 * landed, so it is not evidence of a complete-section swallow.
 */
function systemTextOf(options: unknown): string | undefined {
  const source = options as { messages?: unknown; system?: unknown } | null | undefined
  if (typeof source?.system === 'string' && source.system.length > 0) return source.system
  const messages = source?.messages
  if (!Array.isArray(messages)) return undefined
  let seen = false
  let text = ''
  for (const message of messages) {
    const entry = message as { role?: unknown; content?: unknown } | null
    if (entry?.role !== 'system') continue
    seen = true
    if (typeof entry.content === 'string') {
      text += entry.content
      continue
    }
    if (!Array.isArray(entry.content)) continue
    for (const block of entry.content) {
      const part = block as { type?: unknown; text?: unknown } | null
      if (part?.type === 'text' && typeof part.text === 'string') text += part.text
    }
  }
  return seen ? text : undefined
}

/**
 * Mount the host events the assembly owns.
 *
 * ## Why `system-prompt/assemble` owns the warm
 *
 * The host's preStep is `tools.resolve` -> `systemPrompt.assemble` ->
 * `agent/pre-step`; section text resolves inside `assemble`, and
 * `agent/request` fires only later in `step()`. A warm driven from
 * `agent/request` therefore misses request 1 (the gate can never act on step
 * 1) and then flips the system prompt on request 2, invalidating the whole
 * cached prefix (design D4). This listener runs inside the awaited assemble
 * waterfall, after sections resolve, with `context.scope` being the agent: it
 * warms the judgement and then rewrites our section's text from that fresh
 * answer. Request 1 is correct and request 2 reproduces the same bytes.
 *
 * The tool-level `when` was the alternative early seam; it is worse here
 * because it never runs when `tools.resolve` is unavailable or the boost tool
 * is filtered out, and it cannot await `resolveByPath` without making a
 * synchronous visibility predicate asynchronous. The assemble listener also
 * costs nothing on tool-listing paths.
 *
 * `agent/pre-step` is the non-deprecated clock seam (`agent/request` is
 * marked `@deprecated`); it fires once per proposed step with the host
 * `turn`/`step`. `agent/request` is kept for the selector route, which only
 * its resolved config carries, and as a clock/visibility fallback. A model
 * request that reaches `llm/stream` without any observed `agent/request` is
 * reported once with `ERR_HOST_NO_AGENT_REQUEST` instead of silently losing
 * the route.
 *
 * `session/event` (`turn/end`), `session/flush` and `session/disposed` call
 * `ReceiptStore.flush()` so the turn-end durability the design promises is
 * real. `session/disposed` also drops every per-session map the assembly owns
 * and tells the stores to evict their state.
 */
function wireSessionEvents(
  ctx: PluginContext,
  deps: HookDeps,
  scope: ScopeStore,
  registry: () => WorkspaceRegistry | undefined,
  sessions: DisposalAwareSessionRuntime,
  horizon: RuntimeStepHorizon,
  workspaces: Map<string, string>,
  routes: Map<string, SelectorRoute>,
  counters: ProjectionCounters,
): void {
  /** Session ids seen at `agent/pre-step`; a `llm/stream` without a request is drift. */
  const preStepSeen = new Set<string>()
  /** Session ids observed on `agent/request`. */
  const requestSeen = new Set<string>()
  let warnedMissingRequest = false
  /** Warn once per process about a prompt that swallowed the protocol section. */
  let warnedCompleteSection = false

  ctx.on('system-prompt/assemble', async (_assembly: unknown, context: unknown, next: () => unknown) => {
    const resolved = await next()
    try {
      // `dsh-agent` augments `AssembleContext` with the real `Agent`; `scope`
      // is an opaque `ScopeKey` and is never read as an Agent (review row 11).
      // A diagnostic assembly has no agent: the documented no-scope view, so
      // the section is suppressed and counted rather than keyed on a guess.
      const carrier = (context ?? {}) as { agent?: unknown }
      const agent = carrier.agent
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) {
        // The provider has nothing to key the judgement on and returns '';
        // clear the section explicitly so a stale provider answer cannot leak
        // into an assembly with no agent. Count the decision, not the
        // section's presence — design §5.5:378 asks for every assembly to be
        // judged.
        counters.protocolSuppressed()
        return patchProtocolSection(resolved, false)
      }
      const visible = await warmVisibility(scope, registry, agent, sessionId, workspaces)
      // Same rule for an invisible workspace: the section is suppressed for
      // this assembly, so the operator gets a live signal in `boost status`.
      // A visible one never increments, so the count stays a failure count.
      if (!visible) counters.protocolSuppressed()
      return patchProtocolSection(resolved, visible)
    } catch {
      return resolved
    }
  })

  ctx.on('agent/pre-step', async (payload: unknown, next: () => unknown) => {
    const request = (payload ?? {}) as RequestPayload
    const sessionId = sessionIdOf(request.agent)
    if (sessionId !== undefined) {
      preStepSeen.add(sessionId)
      try {
        sessions.onModelRequest(
          sessionId,
          typeof request.turn === 'number' ? request.turn : Number(request.turn),
          typeof request.step === 'number' ? request.step : undefined,
        )
      } catch {
        // A clock that cannot be driven must not break the step.
      }
      try {
        horizon.observe(
          sessionId,
          typeof request.turn === 'number' ? request.turn : Number(request.turn),
          typeof request.step === 'number' ? request.step : Number(request.step),
        )
      } catch {
        // History is an estimate; a bad observation is not a step failure.
      }
      // `agent/pre-step` already carries the captured step selection. It is
      // the non-deprecated source for the selector route; `agent/request`'s
      // resolved config remains a fallback for hosts that only populate it
      // there (review row 37). A later request overwrites with the same route.
      rememberRoute(routes, sessionId, request.modelSelection)
    }
    return next()
  })

  ctx.on('agent/request', async (payload: unknown, next: () => unknown) => {
    const request = (payload ?? {}) as RequestPayload
    const sessionId = sessionIdOf(request.agent)
    if (sessionId !== undefined) {
      requestSeen.add(sessionId)
      try {
        sessions.onModelRequest(
          sessionId,
          typeof request.turn === 'number' ? request.turn : Number(request.turn),
          typeof request.step === 'number' ? request.step : undefined,
        )
      } catch {
        // A clock that cannot be driven must not break the model request.
      }
      try {
        horizon.observe(
          sessionId,
          typeof request.turn === 'number' ? request.turn : Number(request.turn),
          typeof request.step === 'number' ? request.step : Number(request.step),
        )
      } catch {
        // Same as the pre-step observation: history is an estimate.
      }
      await warmVisibility(scope, registry, request.agent, sessionId, workspaces)
    }
    const config = await next()
    if (sessionId !== undefined) rememberRoute(routes, sessionId, config)
    return config
  })

  // The deprecated event's disappearance would otherwise disable the selector
  // route silently. A session that reached `llm/stream` after a pre-step but
  // never saw `agent/request` is proof enough; the model request itself is
  // passed through untouched.
  ctx.on('llm/stream', (options: unknown, next: () => unknown) => {
    try {
      const request = (options ?? {}) as { sessionId?: unknown; purpose?: unknown }
      const sessionId = request.sessionId
      if (
        !warnedMissingRequest &&
        typeof sessionId === 'string' &&
        preStepSeen.has(sessionId) &&
        !requestSeen.has(sessionId)
      ) {
        warnedMissingRequest = true
        ctx.logger?.warn?.(
          'ERR_HOST_NO_AGENT_REQUEST: agent/request was not observed before llm/stream; the selector route cannot be captured (the event is deprecated and may have been removed)',
        )
      }

      // A `complete: true` prompt section replaces every other section after
      // the assembly waterfall, so the protocol text `system-prompt/assemble`
      // patched in is gone from the request the model actually receives. The
      // host exposes no code or flag for that restoration; the outgoing system
      // prompt is the first place it is observable. Detect it, count it, and
      // fail closed: without the protocol there is nothing to teach the plan
      // grammar, so substitution (and the projection that shares the same
      // visibility gate) must not act for this request (review row 12).
      if (
        typeof sessionId === 'string' &&
        request.purpose !== SELECTOR_PURPOSE &&
        scope.judgement(sessionId)
      ) {
        const systemText = systemTextOf(options)
        if (systemText !== undefined && !systemText.includes(PROTOCOL_PROBE)) {
          counters.protocolSuppressed()
          counters.protocolMissing()
          scope.remember(sessionId, false)
          if (!warnedCompleteSection) {
            warnedCompleteSection = true
            ctx.logger?.warn?.(
              'ERR_HOST_COMPLETE_SECTION: the final system prompt does not carry the dsh-boost protocol section (a complete prompt section replaced the assembly); substitution is disabled for affected requests',
            )
          }
        }
      }
    } catch {
      // Detection must never break the model request.
    }
    return next()
  })

  // `session/event` carries a plain `type` string, so `turn/end` is matched by
  // value, not by a stable code. That match is a convenience: it flushes early
  // on the common path, but it is not the durability boundary. The host does
  // not await this listener, so a process exit immediately after `turn/end`
  // can drop the flush; the awaited `session/flush` below is what the
  // persistence contract rests on, and `session/disposed` flushes again after
  // the last hook for the id. Receipts are evidence, so an early flush that
  // does not happen costs latency, never correctness.
  ctx.on('session/event', (_session: unknown, event: unknown) => {
    const type = (event as { type?: unknown } | undefined)?.type
    if (type === 'turn/end') {
      // Fire-and-forget on the real host; `flush()` never rejects.
      return deps.receipts.flush()
    }
    return undefined
  })

  ctx.on('session/flush', () => deps.receipts.flush())

  ctx.on('session/disposed', async (session: unknown) => {
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined) return
    try {
      clearSession(deps, sessionId)
    } catch {
      // Session end owns no tool result; a failed clear must not throw here.
    }
    sessions.markDisposed(sessionId)
    workspaces.delete(sessionId)
    routes.delete(sessionId)
    requestSeen.delete(sessionId)
    preStepSeen.delete(sessionId)
    horizon.clear(sessionId)
    scope.forget(sessionId)
    // Flush this session's buffered lines before evicting its state, then make
    // every later hook for the id a no-op.
    try {
      await deps.receipts.flush()
    } catch {
      // Flush is total; a foreign store must not break session end.
    }
    deps.receipts.disposeSession(sessionId)
  })
}

/**
 * Register the `boost` tool family.
 *
 * After T19 the family is just this one tool; T23b's substitution path depends
 * on the same `tools.resolve` probe. The tool itself is scope-exempt
 * (`when: () => true`) because it is the only way a user can enable a workspace
 * that is not enabled yet — gating it on the scope document would make
 * `selected + []` impossible to leave. The protocol section is not exempt; T17
 * already handles it.
 *
 * Without step-level `when` a conditional registration would silently become
 * unconditional, so the whole family is skipped and the stable code is logged.
 */
function registerBoostTool(ctx: PluginContext, deps: BoostDeps): void {
  if (!supportsStepWhen(ctx.tools)) {
    ctx.logger?.warn?.('ERR_HOST_NO_STEP_WHEN')
    return
  }
  // Annotating with the host's ToolDefinition makes a host-side tightening a
  // build error instead of a runtime registration failure. The tool is
  // scope-exempt by design (`when: () => true`), so it needs no registry: the
  // registry is only the visibility warm's input, wired above.
  const definition: ToolDefinition = boostTool(deps)

  ctx.tools.register(definition, { when: () => true })
}

export function apply(ctx: PluginContext, config: unknown): void {
  const repairs: string[] = []
  const cfg = resolveConfig(config, message => {
    repairs.push(message)
    ctx.logger?.warn?.(message)
  })
  // One line with the effective values (not only the keys this module happens
  // to use): an operator can see every clamp and fallback instead of guessing.
  ctx.logger?.info?.(
    `dsh-boost loaded (stepsPerTurn=${cfg.stepsPerTurn}, horizonSteps=${cfg.horizonSteps}); effective config=${JSON.stringify(cfg)}`,
  )
  if (repairs.length > 0) {
    ctx.logger?.info?.(`dsh-boost: ${repairs.length} configuration value(s) repaired`)
  }

  if (!canRegister(ctx)) {
    ctx.logger?.warn?.('dsh-boost: host hook services unavailable; registration skipped')
    return
  }

  let hooksMounted = false
  try {
    // One root rule for both stores (design §10); `resolveBoostRoot` is the
    // only implementation, so `apply` and the hook stores cannot diverge.
    const root = resolveBoostRoot(config)
    const scope = new ScopeStore(root, { warn: (message: string) => ctx.logger?.warn?.(message) })
    const receipts = new ReceiptStore(root)
    const anchors = new AnchorStore()
    const queue = new PendingQueue()
    const plans = new Map<string, Plan>()
    const sessions = new DisposalAwareSessionRuntime(cfg.stepsPerTurn)
    const horizon = new RuntimeStepHorizon(cfg.horizonSteps, cfg.historyTurns)
    const retrievals = new RetrievalLedger()
    /** Session id → workspace id, populated by the visibility warm. */
    const workspaces = new Map<string, string>()
    /** Session id → the route the selector call inherits. */
    const routes = new Map<string, SelectorRoute>()

    // Soft host services. Cordis activates sibling providers concurrently, so
    // these getters retry until the provider fiber is ACTIVE; an absence is
    // never memoised. The workspace registry is the `resolveByPath`/`list()`
    // seam; the spill store is the projection backend; the token meter prices
    // projections and admission.
    const registry = lazyService<WorkspaceRegistry>(ctx, 'workspaceRegistry')
    const spill = lazyService<SpillBackend>(ctx, 'spillStore')
    const meter = meterSeamOf(ctx)
    const projectionCounters = new ProjectionCounters()

    // Host capabilities `status` renders as stable codes. Getters keep them
    // facts about the host *now*: a service that appears after `apply` must not
    // leave a permanent `ERR_HOST_NO_*`. The fixed-cost probe starts here
    // (startup time) and is awaited only by `status` — it is deliberately not
    // on any request path.
    const hostFacts: BoostHostFacts = {
      get hasTokenMeter() {
        return meter.kind() === 'host'
      },
      get hasSpill() {
        return spill() !== undefined
      },
      supportsStepWhen: supportsStepWhen(ctx.tools),
      get hasWorkspaceRegistry() {
        return registry() !== undefined
      },
    }
    const fixedOverhead = measureBoostFixedOverhead()

    // The hook reads this synchronously, so it only ever returns the warmed
    // answer. The map alone is not the answer: a workspace disabled between
    // commit and synthesis leaves the id behind but flips `judgement` to false.
    const resolveSession = (sessionId: string): string | undefined => {
      try {
        if (!scope.judgement(sessionId)) return undefined
        return workspaces.get(sessionId)
      } catch {
        return undefined
      }
    }

    // `deps` MUST stay the same object `registerHooks` receives: it publishes
    // the created `ReceiptSessionState` onto `deps.sessionState`, and
    // `clearSession(deps, id)` can only reach it through that reference.
    const deps: HookDeps = {
      config: cfg,
      scope,
      receipts,
      anchors,
      resolveSession,
      queue,
      plans,
      sessions,
      // Getters, not snapshots: the hook reads them per decision, so a service
      // that becomes active after `apply` is picked up on the next call.
      get spill() {
        return spill()
      },
      retrievals,
      get estimateText() {
        return meter.estimate()
      },
      get estimateKind() {
        return meter.kind()
      },
      projectionCounters,
      llm: ctx.llm,
      selectorRoute: (sessionId) => routes.get(sessionId),
    }
    // The section mount is the first thing `registerHooks` touches and the
    // host's duplicate error carries no code: any throw here means a previous
    // apply already owns the mounts. Count it and leave them untouched instead
    // of risking a second hook registration.
    try {
      registerHooks(ctx, deps)
      hooksMounted = true
    } catch (error) {
      duplicateMountAttempts += 1
      ctx.logger?.warn?.(
        `dsh-boost: ERR_BOOST_ALREADY_MOUNTED: duplicate apply #${duplicateMountAttempts} found an existing mount; registration skipped (${messageOf(error)})`,
      )
      return
    }

    // The clock/visibility warm and the session-end cleanup. Wired separately
    // so a host that cannot accept these events still gets the tool below.
    try {
      wireSessionEvents(ctx, deps, scope, registry, sessions, horizon, workspaces, routes, projectionCounters)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-boost: session wiring failed: ${messageOf(error)}`)
    }

    // After the hooks: `registerHooks` mounts the prompt section first and
    // throws on a duplicate, so a second `apply` aborts above before it can
    // register the tool twice.
    registerBoostTool(
      ctx,
      {
        scope,
        receipts,
        host: hostFacts,
        fixedOverhead: () => fixedOverhead,
        get estimateKind() {
          return meter.kind()
        },
        // Design §5.3's runtime horizon: min(config horizon, mean of the last
        // `historyTurns` completed turns) over live sessions. `runBoost` spreads
        // the deps when it is called, so this getter is read at status time.
        get horizonSteps() {
          return horizon.remaining()
        },
        locatorEvictions: () => retrievals.evictions(),
        receiptReadErrors: () => receipts.readErrors(),
        unknownFamilies: () => projectionCounters.unknownFamilies(),
        unknownTools: () => projectionCounters.unknownToolCounts(),
        protocolSuppressed: () => projectionCounters.protocolSuppressions(),
        completeSectionSuppressions: () => projectionCounters.protocolMissings(),
      },
    )
  } catch (error) {
    // The tool is the user's only control surface, so its failure must not be
    // reported as a hook failure (that would hide the degradation behind a
    // misleading message).
    if (hooksMounted) {
      ctx.logger?.warn?.(
        `dsh-boost: boost tool registration failed (ERR_BOOST_TOOL_REGISTER_FAILED): ${messageOf(error)}`,
      )
      return
    }
    ctx.logger?.warn?.(`dsh-boost: hook registration skipped: ${messageOf(error)}`)
  }
}
