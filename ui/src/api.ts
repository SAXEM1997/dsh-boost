/**
 * The page's only read path.
 *
 * Every failure arrives as a stable code, never as prose, because the page
 * decides what to say — and whether to keep a draft — from the code alone.
 */
import { HTTP_API_PREFIX } from '../../src/shared/api-prefix'

/** A workspace as the route reports it. */
export interface WorkspaceEntry {
  id: string
  path: string
}

/** The workspace list, or the reason there is none. */
export type WorkspaceListing =
  | { available: true; entries: WorkspaceEntry[] }
  | { available: false; code: string }

/** The route's success body, narrowed to what this page reads. */
export interface StatePayload {
  status: unknown
  scope: unknown
  workspaces: WorkspaceListing
  config: unknown
}

/** Success carries the payload; failure carries a code and nothing else. */
export type StateResult = { ok: true; data: StatePayload } | { ok: false; code: string }

/** Codes this module can produce on its own, before any server answer. */
export const ERR_CLIENT_NETWORK = 'ERR_CLIENT_NETWORK'
export const ERR_CLIENT_SHAPE = 'ERR_CLIENT_SHAPE'

function isWorkspaceListing(value: unknown): value is WorkspaceListing {
  if (value === null || typeof value !== 'object') return false
  const listing = value as { available?: unknown }
  if (listing.available === false) return typeof (value as { code?: unknown }).code === 'string'
  return listing.available === true && Array.isArray((value as { entries?: unknown }).entries)
}

/**
 * Reads the plugin's state.
 *
 * `credentials: 'same-origin'` is explicit: the route is fenced by `Host` and
 * `Origin`, so a request that arrived without the page's own origin would be
 * indistinguishable from a cross-site one.
 */
export async function fetchState(signal?: AbortSignal): Promise<StateResult> {
  let response: Response
  try {
    response = await fetch(`${HTTP_API_PREFIX}/state`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return { ok: false, code: ERR_CLIENT_NETWORK }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, code: ERR_CLIENT_NETWORK }
  }
  if (!response.ok) {
    const code = (body as { error?: unknown } | null)?.error
    return { ok: false, code: typeof code === 'string' ? code : ERR_CLIENT_NETWORK }
  }
  const payload = body as Partial<StatePayload> | null
  if (payload === null || typeof payload !== 'object' || !isWorkspaceListing(payload.workspaces)) {
    // A body this page cannot read is not an empty state: saying "no
    // workspaces" here would be a different, false statement.
    return { ok: false, code: ERR_CLIENT_SHAPE }
  }
  return {
    ok: true,
    data: {
      status: payload.status,
      scope: payload.scope,
      workspaces: payload.workspaces,
      config: payload.config,
    },
  }
}
