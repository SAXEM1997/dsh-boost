/**
 * Workspace resolution: map a session cwd to a host workspace UUID and answer
 * "may the plugin act for this agent?" from the scope document.
 *
 * `scope.json` lists workspace **ids**, while a session header carries a
 * **cwd path**, so visibility is a registry lookup, never a path comparison.
 * `workspaceIdOf` is synchronous because the `systemPrompt` assembly path is
 * synchronous; the host's asynchronous `resolveByPath` is deliberately not
 * used here (it exists for a later pre-warm path only).
 *
 * Everything is fail-closed. No agent, no session, no cwd, no registry, no
 * matching entry, a throwing `list()`, or a malformed list all mean "no
 * workspace id", and `isVisible` treats that as invisible. `workspaceIdOf` is
 * total on purpose: it is the synchronous accessor a later pre-warm path will
 * call directly, so a broken registry degrades to `undefined` here instead of
 * relying on `resolveVisible`'s catch.
 *
 * ## Why `resolveVisible` writes the cache
 *
 * `resolveVisible` is the asynchronous `when` path. Besides returning the
 * judgement it stores it with `store.remember(key, visible)`, keyed by
 * `agent.session.header.id`. The `systemPrompt` section provider is
 * synchronous and can only read `store.judgement(key)`; without this write the
 * protocol section would never appear, with no error anywhere. An agent with
 * no session id has no key to store under, so its judgement is returned but
 * nothing is cached. A resolution failure is remembered as `false`, which is
 * the same fail-closed answer the provider's fallback would give.
 *
 * @module dsh-boost/scope/resolve
 */
import { isVisible } from './doc.js'
import type { ScopeStore } from './store.js'

/**
 * The host's workspace registry.
 *
 * The host exposes only the synchronous `list()` and the asynchronous
 * `resolveByPath()`; there is no `byPath`. `workspaceIdOf` uses `list()`
 * exclusively so it can stay synchronous. `resolveByPath` is optional here
 * because a test double need not provide the pre-warm path.
 */
export interface WorkspaceRegistry {
  list(): readonly { id: string; path: string }[]
  resolveByPath?(path: string): Promise<{ id: string } | undefined>
}

/**
 * The agent shape this module reads.
 *
 * Looser than `AgentLike`: the brief's tests pass agents without an `id` (and
 * `resolveVisible` passes `unknown`), so the header is optional here.
 */
type AgentWithCwd = { session?: { header?: { cwd?: string } } }

/** The session id, when the agent has one; that is the judgement-cache key. */
function agentKeyOf(agent: unknown): string | undefined {
  const id = (agent as { session?: { header?: { id?: unknown } } } | undefined)?.session?.header?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * Resolve the host workspace UUID for an agent's cwd.
 *
 * The cwd is matched against `registry.list()` by exact `path` equality, so
 * `/w/a` does not match a workspace at `/w/ab` (or at `/w/a/`). Any missing or
 * malformed link in the chain — no agent, no session, a non-string cwd, no
 * registry, a `list()` that is not an array, throws, or contains non-object
 * entries — yields `undefined`, which `isVisible` treats as invisible. This
 * function never throws, even when called outside `resolveVisible`.
 */
export function workspaceIdOf(
  agent: AgentWithCwd | undefined,
  registry: WorkspaceRegistry | undefined,
): string | undefined {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string') return undefined
  try {
    const workspaces = registry?.list()
    if (!Array.isArray(workspaces)) return undefined
    return workspaces.find(workspace => workspace?.path === cwd)?.id
  } catch {
    return undefined
  }
}

/**
 * Whether the plugin may act for `agent`, caching the judgement for the
 * synchronous prompt provider.
 *
 * Never throws: a degraded read, a throwing registry, or a malformed `list()`
 * all resolve to `false`. When the agent has a session id the result (including
 * a failure's `false`) is written with `store.remember` before returning, so a
 * subsequent synchronous `judgement(key)` sees the same answer.
 *
 * A degraded store read (missing, unreadable, corrupt or newer-versioned
 * `scope.json`) is a *definitive* `false` for this resolution, not an unknown:
 * it is cached like any other judgement. It is not sticky — the next
 * `resolveVisible` call re-reads the store and overwrites the same key, so a
 * repaired scope document self-heals the cache on the following resolution.
 */
export async function resolveVisible(
  store: ScopeStore,
  agent: unknown,
  registry: WorkspaceRegistry | undefined,
): Promise<boolean> {
  try {
    const key = agentKeyOf(agent)
    let visible = false
    try {
      const { doc } = await store.read()
      const workspaceId = workspaceIdOf(agent as AgentWithCwd | undefined, registry)
      visible = isVisible(doc, workspaceId)
    } catch {
      visible = false
    }
    if (key !== undefined) store.remember(key, visible)
    return visible
  } catch {
    return false
  }
}

/**
 * Whether the host offers step-level `when` predicates on tool registration.
 *
 * The probe itself never throws: `undefined`, `null` and non-objects all
 * simply have no callable `resolve`.
 */
export function supportsStepWhen(tools: { resolve?: unknown } | undefined | null): boolean {
  return typeof tools?.resolve === 'function'
}
