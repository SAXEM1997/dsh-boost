/**
 * Workspace resolution: map a session cwd to a host workspace UUID and answer
 * "may the plugin act for this agent?" from the scope document.
 *
 * `scope.json` lists workspace **ids**, while a session header carries a
 * **cwd path**, so visibility is a registry lookup, never a path comparison.
 * The production resolver (`resolveWorkspace` / `workspaceIdFor`) is
 * asynchronous and prefers the registry's canonical `resolveByPath`, because
 * `Workspace.path` is a realpath while `Session.header.cwd` is only absolute.
 * `workspaceIdOf` remains the synchronous exact-match fallback for a registry
 * that offers only `list()`, and the section provider stays synchronous by
 * reading the cached judgement.
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
 * `/w/a` does not match a workspace at `/w/ab` (or at `/w/a/`). This is the
 * **synchronous fallback** for a registry without `resolveByPath`; the async
 * {@link workspaceIdFor} is the production path because `Workspace.path` is a
 * canonical realpath while `Session.header.cwd` is only guaranteed absolute.
 * Any missing or malformed link in the chain — no agent, no session, a
 * non-string cwd, no registry, a `list()` that is not an array, throws, or
 * contains non-object entries — yields `undefined`, which `isVisible` treats as
 * invisible. This function never throws, even when called outside
 * `resolveVisible`.
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
 * Resolve the workspace UUID, preferring the host's canonical lookup.
 *
 * `Workspace.path` is the canonical realpath (`dsh-workspace/src/types.ts`),
 * while `Session.header.cwd` is only guaranteed absolute
 * (`dsh-session/src/index.ts`), so a symlinked cwd or one with a trailing
 * slash never matches byte-for-byte. `resolveByPath` is the registry's
 * canonical resolver and is used whenever it exists; its `undefined` answer is
 * authoritative (the workspace is not registered), while a registry without it
 * falls back to the synchronous exact match. A throwing resolver is a
 * resolution failure and fails closed (`undefined` -> invisible), never a
 * crash and never a silent exact-match second guess.
 *
 * Never throws.
 */
export async function workspaceIdFor(
  agent: AgentWithCwd | undefined,
  registry: WorkspaceRegistry | undefined,
): Promise<string | undefined> {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string') return undefined
  const resolveByPath = registry?.resolveByPath
  if (typeof resolveByPath === 'function') {
    try {
      const workspace = await resolveByPath.call(registry, cwd)
      return typeof workspace?.id === 'string' ? workspace.id : undefined
    } catch {
      return undefined
    }
  }
  return workspaceIdOf(agent, registry)
}

/**
 * Visibility plus the workspace id the judgement was made against.
 *
 * `resolveVisible` is the boolean projection of this result. `apply` also needs
 * the id: the stream hook's `resolveSession` map must carry the same canonical
 * workspace id the judgement used, or a symlinked cwd would be judged visible
 * and then refused by the substitution path.
 */
export async function resolveWorkspace(
  store: ScopeStore,
  agent: unknown,
  registry: WorkspaceRegistry | undefined,
): Promise<{ visible: boolean; workspaceId?: string }> {
  try {
    const key = agentKeyOf(agent)
    let workspaceId: string | undefined
    let visible = false
    try {
      workspaceId = await workspaceIdFor(agent as AgentWithCwd | undefined, registry)
      const { doc } = await store.read()
      visible = isVisible(doc, workspaceId)
    } catch {
      visible = false
    }
    if (key !== undefined) store.remember(key, visible)
    return { visible, ...(workspaceId === undefined ? {} : { workspaceId }) }
  } catch {
    return { visible: false }
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
  return (await resolveWorkspace(store, agent, registry)).visible
}
