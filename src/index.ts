/**
 * dsh-boost cordis plugin entry point.
 *
 * The plugin is a plain function plugin: cordis reads `name` and `inject` from
 * the module and calls `apply(ctx, config)`. Only the production assembly lives
 * here — configuration resolution, the two stores the hooks and the control
 * tool share, the four hook mounts, the two session events that drive the
 * clock/visibility and the session-end cleanup, and the `boost` tool, all
 * wired once per plugin instance.
 *
 * Wiring failures are contained: a host that lacks the services a mount point
 * lives on must load the plugin with a warning, not die loading it. The data
 * root is `$DSH_HOME/boost`, falling back to `~/.dsh/boost`.
 *
 * @module dsh-boost
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from './config.js'
import { AnchorStore } from './gate/invalidate.js'
import type { Plan } from './gate/plan.js'
import { clearSession, SessionRuntime } from './hooks/llm-stream.js'
import { PendingQueue } from './hooks/pending.js'
import { registerHooks } from './hooks/post-execute.js'
import type { HookDeps, SelectorRoute } from './hooks/post-execute.js'
import type { SpillBackend } from './projection/apply.js'
import { ReceiptStore } from './receipts/store.js'
import { resolveVisible, supportsStepWhen, workspaceIdOf } from './scope/resolve.js'
import type { WorkspaceRegistry } from './scope/resolve.js'
import { ScopeStore } from './scope/store.js'
import { boostTool } from './tools/boost.js'
import type { PluginContext } from './types.js'

export const name = 'dsh-boost'

export const inject = ['tools', 'llm', 'systemPrompt'] as const

/** Whether the host exposes both services the hook mounts attach to. */
function canRegister(ctx: PluginContext): boolean {
  return typeof ctx.on === 'function' && typeof ctx.systemPrompt?.section === 'function'
}

/**
 * The plugin's data root: `<DSH_HOME>/boost`, with `~/.dsh/boost` as the
 * default when the environment variable is unset or blank (design §10).
 */
function boostRoot(): string {
  const configured = process.env.DSH_HOME?.trim()
  return join(configured ? configured : join(homedir(), '.dsh'), 'boost')
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

/** The fixed density `@deepseek-ai/dsh-token-meter/estimate` prices text under. */
const CHARS_PER_TOKEN = 4

/**
 * The projection estimator.
 *
 * The host exposes no synchronous text estimator: `estimateContent` is a
 * module export of the optional `dsh-token-meter` peer and would have to be
 * imported dynamically, while this seam is synchronous. The fixed heuristic is
 * the same one the meter uses (`ceil(codePoints / 4)`); the meter's per-block
 * overhead is constant and cancels in every before/after projection receipt.
 */
function estimateText(text: string): number {
  return Math.ceil(Array.from(text).length / CHARS_PER_TOKEN)
}

/** The `agent/request` payload fields this assembly reads. */
type RequestPayload = {
  agent?: unknown
  turn?: unknown
  step?: unknown
}

/**
 * Warm the synchronous visibility cache from the request that precedes
 * `llm/stream`.
 *
 * `resolveVisible` is the async answer and also writes `scope.judgement(key)`;
 * the workspace id is kept even when the answer is "invisible", so the resolver
 * must consult the live judgement rather than treating the map as the answer.
 * A workspace disabled after a commit therefore stops resolving before the
 * next synthesized turn.
 */
async function warmVisibility(
  scope: ScopeStore,
  registry: WorkspaceRegistry | undefined,
  agent: unknown,
  sessionId: string,
  workspaces: Map<string, string>,
): Promise<void> {
  try {
    await resolveVisible(scope, agent, registry)
    const workspaceId = workspaceIdOf(
      agent as { session?: { header?: { cwd?: string } } } | undefined,
      registry,
    )
    // The map carries identity, `scope.judgement` carries visibility: cache the
    // id even when the answer is "invisible", and let the resolver combine the
    // two. A stale id therefore cannot outlive a visibility change.
    if (typeof workspaceId === 'string') workspaces.set(sessionId, workspaceId)
    else workspaces.delete(sessionId)
  } catch {
    // `resolveVisible` is total; this contains a foreign registry.
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
 * Mount the host events the assembly owns.
 *
 * `agent/request` is the event the host actually emits immediately before
 * `llm/stream` (`dsh-agent-loop.buildRequest` follows `prepareRequest`), and it
 * carries the host `turn`/`step`: the clock is copied from there, never counted
 * here. The listener awaits the visibility warm so the first `post-execute`
 * after it sees the current judgement; it then captures the resolved route for
 * the selector.
 *
 * `session/disposed` is the host's session-end signal. `clearSession` drops the
 * queue, anchors, plans, receipt state and per-session runtime together; the
 * two caches this module owns are dropped next to it.
 */
function wireSessionEvents(
  ctx: PluginContext,
  deps: HookDeps,
  scope: ScopeStore,
  registry: WorkspaceRegistry | undefined,
  sessions: SessionRuntime,
  workspaces: Map<string, string>,
  routes: Map<string, SelectorRoute>,
): void {
  ctx.on('agent/request', async (payload: unknown, next: () => unknown) => {
    const request = (payload ?? {}) as RequestPayload
    const sessionId = sessionIdOf(request.agent)
    if (sessionId !== undefined) {
      try {
        sessions.onModelRequest(
          sessionId,
          typeof request.turn === 'number' ? request.turn : Number(request.turn),
          typeof request.step === 'number' ? request.step : undefined,
        )
      } catch {
        // A clock that cannot be driven must not break the model request.
      }
      await warmVisibility(scope, registry, request.agent, sessionId, workspaces)
    }
    const config = await next()
    if (sessionId !== undefined) rememberRoute(routes, sessionId, config)
    return config
  })

  ctx.on('session/disposed', (session: unknown) => {
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined) return
    try {
      clearSession(deps, sessionId)
    } catch {
      // Session end owns no tool result; a failed clear must not throw here.
    }
    workspaces.delete(sessionId)
    routes.delete(sessionId)
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
  deps: { scope: ScopeStore; receipts: ReceiptStore },
): void {
  if (!supportsStepWhen(ctx.tools)) {
    ctx.logger?.warn?.('ERR_HOST_NO_STEP_WHEN')
    return
  }
  // Annotating with the host's ToolDefinition makes a host-side tightening a
  // build error instead of a runtime registration failure.
  const definition: ToolDefinition = boostTool(deps)
  ctx.tools.register(definition, { when: () => true })
}

export function apply(ctx: PluginContext, config: unknown): void {
  const cfg = resolveConfig(config)
  ctx.logger?.info?.(
    `dsh-boost loaded (stepsPerTurn=${cfg.stepsPerTurn}, horizonSteps=${cfg.horizonSteps})`,
  )

  if (!canRegister(ctx)) {
    ctx.logger?.warn?.('dsh-boost: host hook services unavailable; registration skipped')
    return
  }

  let hooksMounted = false
  try {
    const root = boostRoot()
    const scope = new ScopeStore(root)
    const receipts = new ReceiptStore(root)
    const anchors = new AnchorStore()
    const queue = new PendingQueue()
    const plans = new Map<string, Plan>()
    const sessions = new SessionRuntime(cfg.stepsPerTurn)
    /** Session id → workspace id, populated by the visibility warm. */
    const workspaces = new Map<string, string>()
    /** Session id → the route the selector call inherits. */
    const routes = new Map<string, SelectorRoute>()

    // Soft host services. The workspace registry is the synchronous `list()`
    // seam `workspaceIdOf` reads; the spill store is the projection backend.
    const registry = serviceOf<WorkspaceRegistry>(ctx, 'workspaceRegistry')
    const spill = serviceOf<SpillBackend>(ctx, 'spillStore')

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
      spill,
      estimateText,
      llm: ctx.llm,
      selectorRoute: (sessionId) => routes.get(sessionId),
    }
    registerHooks(ctx, deps)
    hooksMounted = true

    // The clock/visibility warm and the session-end cleanup. Wired separately
    // so a host that cannot accept these events still gets the tool below.
    try {
      wireSessionEvents(ctx, deps, scope, registry, sessions, workspaces, routes)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-boost: session wiring failed: ${messageOf(error)}`)
    }

    // After the hooks: `registerHooks` mounts the prompt section first and
    // throws on a duplicate, so a second `apply` aborts above before it can
    // register the tool twice.
    registerBoostTool(ctx, { scope, receipts })
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
