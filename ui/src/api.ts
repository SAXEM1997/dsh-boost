/**
 * The page's only read path.
 *
 * Every failure arrives as a stable code, never as prose, because the page
 * decides what to say — and whether to keep a draft — from the code alone.
 */
import { HTTP_API_PREFIX } from '../../src/shared/api-prefix'
import type { StatePayload, WorkspaceListing } from '../../src/shared/api-types.js'

export type { StatePayload, WorkspaceEntry, WorkspaceListing } from '../../src/shared/api-types.js'

/** Success carries the payload; failure carries a code and nothing else. */
export type StateResult = { ok: true; data: StatePayload } | { ok: false; code: string }

/** What a save returns: the document it wrote, or the code that stopped it. */
export type SaveResult = { ok: true; data: unknown } | { ok: false; code: string }

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

/**
 * Writes the four scope fields through the same CAS the `boost` tool uses.
 *
 * `baseRevision` is the revision the draft was seeded from, not the newest one:
 * that is what makes a concurrent write visible as a conflict instead of
 * silently discarding whichever change landed second.
 */
export async function saveScope(patch: unknown, baseRevision: number): Promise<SaveResult> {
  let response: Response
  try {
    response = await fetch(`${HTTP_API_PREFIX}/scope`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ body: patch, baseRevision }),
    })
  } catch {
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
  return { ok: true, data: (body as { data?: unknown } | null)?.data }
}
