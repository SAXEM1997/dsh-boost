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
 * root is `$DSH_HOME/boost`, falling back to `~/.dsh/boost`.
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
 * The host exposes no code for a duplicate section name; its message is the
 * only discriminator (`prompt section "dsh-boost" is already registered …`).
 */
const ALREADY_REGISTERED = /already registered/

/** Whether a registration failure means this plugin's mounts already exist. */
function alreadyMounted(error: unknown): boolean {
  return ALREADY_REGISTERED.test(messageOf(error))
}

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
 */
function meterSeamOf(ctx: PluginContext): {
  estimate(): ((text: string) => number) | undefined
  kind(): 'host' | 'unknown'
} {
  let estimator: ((text: string) => number) | undefined
  const resolve = (): ((text: string) => number) | undefined => {
    if (estimator !== undefined) return estimator
    const meter = serviceOf<{ estimateMessage?: (message: unknown) => number }>(ctx, 'tokenMeter')
    if (meter === undefined || typeof meter.estimateMessage !== 'function') return undefined
    const estimate = meter.estimateMessage.bind(meter)
    try {
      const probe = estimate({
        role: 'user',
        content: [{ type: 'text', text: 'dsh-boost meter probe' }],
      })
      if (typeof probe !== 'number' || !Number.isFinite(probe)) return undefined
    } catch {
      return undefined
    }
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
    kind: () => (resolve() === undefined ? 'unknown' : 'host'),
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

/** Replace the protocol section's already-resolved text with the fresh answer. */
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
): void {
  /** Session ids seen at `agent/pre-step`; a `llm/stream` without a request is drift. */
  const preStepSeen = new Set<string>()
  /** Session ids observed on `agent/request`. */
  const requestSeen = new Set<string>()
  let warnedMissingRequest = false

  ctx.on('system-prompt/assemble', async (assembly: unknown, context: unknown, next: () => unknown) => {
    const resolved = await next()
    try {
      const carrier = (context ?? {}) as { agent?: unknown; scope?: unknown }
      const agent = carrier.agent ?? carrier.scope
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) return resolved
      const visible = await warmVisibility(scope, registry, agent, sessionId, workspaces)
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
      const sessionId = (options as { sessionId?: unknown } | undefined)?.sessionId
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
    } catch {
      // Detection must never break the model request.
    }
    return next()
  })

  ctx.on('session/event', (session: unknown, event: unknown) => {
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
function registerBoostTool(
  ctx: PluginContext,
  deps: BoostDeps,
  registry: () => WorkspaceRegistry | undefined,
): void {
  if (!supportsStepWhen(ctx.tools)) {
    ctx.logger?.warn?.('ERR_HOST_NO_STEP_WHEN')
    return
  }
  // Annotating with the host's ToolDefinition makes a host-side tightening a
  // build error instead of a runtime registration failure.
  const definition: ToolDefinition = boostTool(deps)
  const execute = definition.execute as (args: unknown, exec: unknown) => Promise<unknown>

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
    const root = resolveBoostRoot()
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
    registerHooks(ctx, deps)
    hooksMounted = true

    // The clock/visibility warm and the session-end cleanup. Wired separately
    // so a host that cannot accept these events still gets the tool below.
    try {
      wireSessionEvents(ctx, deps, scope, registry, sessions, horizon, workspaces, routes)
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
        unknownFamilies: () => projectionCounters.unknownFamilies(),
        unknownTools: () => projectionCounters.unknownToolCounts(),
      },
      registry,
    )
  } catch (error) {
    // A second apply fails on the duplicate prompt section first (registerHooks
    // mounts it first), which means the plugin is already wired — not that
    // wiring failed. Returning here leaves the existing mounts untouched.
    if (alreadyMounted(error)) return
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
