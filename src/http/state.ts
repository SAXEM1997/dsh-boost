/**
 * The plugin's read-only HTTP surface for the settings page.
 *
 * WHY A ROUTE OF OUR OWN: the host's `webServer` serves the SPA and knows
 * nothing about a plugin's state, and `ctx.settings` only describes plugins
 * that declare a `Config` schema — this one deliberately does not (spec #2:
 * a strict schema turns `resolveConfig`'s clamp-and-warn into a load-time hard
 * failure). So the page reads through one prefix this plugin owns.
 *
 * NO AUTHENTICATION IS INHERITED. `webServer.register` performs none and
 * claims no path namespace, so `isTrustedWebRequest` is the whole boundary;
 * see `fence.ts` for what it closes and why an absent `Origin` is admitted on
 * reads but refused on writes.
 *
 * EVERY FAILURE IS A STRUCTURED BODY. The page decides what to say from a
 * stable code, never from prose, so a handler here returns codes even when the
 * underlying read threw.
 */
import { HTTP_API_PREFIX } from '../shared/api-prefix.js'
import { isTrustedWebRequest } from './fence.js'

/** The route prefix this plugin owns: absolute, no trailing slash. */
export { HTTP_API_PREFIX } from '../shared/api-prefix.js'

/** Stable codes this surface adds to the plugin's vocabulary. */
export const ERR_HTTP_METHOD = 'ERR_HTTP_METHOD'
export const ERR_HTTP_NOT_FOUND = 'ERR_HTTP_NOT_FOUND'
export const ERR_HTTP_FORBIDDEN = 'ERR_HTTP_FORBIDDEN'
export const ERR_HTTP_WORKSPACES_UNAVAILABLE = 'ERR_HTTP_WORKSPACES_UNAVAILABLE'

/** A workspace as the page shows it: the registry's id and the path it owns. */
export interface WorkspaceEntry {
  id: string
  path: string
}

/**
 * The workspace list, or the reason there is none.
 *
 * `available: false` is NOT an empty list: the page disables saving on it and
 * says the list could not be read. Rendering an empty list instead would read
 * as "you have no workspaces", which is a different, wrong statement.
 */
export type WorkspaceListing =
  | { available: true; entries: WorkspaceEntry[] }
  | { available: false; code: string }

/** What the state handler reads. Everything is a thunk: state moves. */
export interface StateDeps {
  /** `runBoost` with `{ cmd: 'status' }` — the same computation as the tool. */
  status(): Promise<{ ok: true; data: unknown } | { ok: false; code: string }>
  /** `runBoost` with `{ cmd: 'scope-get' }`. */
  scope(): Promise<{ ok: true; data: unknown } | { ok: false; code: string }>
  /** The host's workspace registry, resolved lazily. */
  workspaces(): WorkspaceListing
  /** The effective configuration `resolveConfig` produced at load. */
  config(): unknown
}

/** The JSON body `GET /dsh-boost/api/state` returns. */
export interface StatePayload {
  status: unknown
  scope: unknown
  workspaces: WorkspaceListing
  config: unknown
}

/**
 * Reads the workspace registry into the page's listing shape.
 *
 * A registry that is absent and one whose `list()` throws are the same answer
 * to the operator — "the list could not be read" — because both disable the
 * same control and neither is an empty list.
 */
export function listWorkspaces(registry: unknown): WorkspaceListing {
  if (registry === undefined || registry === null) {
    return { available: false, code: ERR_HTTP_WORKSPACES_UNAVAILABLE }
  }
  const list = (registry as { list?: unknown }).list
  if (typeof list !== 'function') {
    return { available: false, code: ERR_HTTP_WORKSPACES_UNAVAILABLE }
  }
  try {
    const entries = (list as () => unknown)()
    if (!Array.isArray(entries)) {
      return { available: false, code: ERR_HTTP_WORKSPACES_UNAVAILABLE }
    }
    const out: WorkspaceEntry[] = []
    for (const entry of entries) {
      const id = (entry as { id?: unknown } | null | undefined)?.id
      const path = (entry as { path?: unknown } | null | undefined)?.path
      if (typeof id !== 'string' || typeof path !== 'string') continue
      out.push({ id, path })
    }
    return { available: true, entries: out }
  } catch {
    return { available: false, code: ERR_HTTP_WORKSPACES_UNAVAILABLE }
  }
}

/** Builds the payload; every branch is already a code, never a thrown error. */
export async function buildStatePayload(deps: StateDeps): Promise<StatePayload> {
  const [status, scope] = await Promise.all([deps.status(), deps.scope()])
  return { status, scope, workspaces: deps.workspaces(), config: deps.config() }
}

/** The two request/response shapes the handler touches, narrowed to what it uses. */
export interface HttpRequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
}

export interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string | number>): unknown
  end(body?: string): unknown
}

/** Writes JSON with the headers this surface always uses. */
function writeJson(res: HttpResponseLike, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // The scope document changes under the operator's feet (the `boost` tool
    // shares it), so a cached read would show a stale revision and the next
    // save would conflict for no visible reason.
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** The path below the prefix, with the query string removed. */
function subPath(url: string | undefined): string {
  const raw = typeof url === 'string' ? url : ''
  const path = raw.split('?')[0] ?? ''
  return path.startsWith(HTTP_API_PREFIX) ? path.slice(HTTP_API_PREFIX.length) : path
}

/** What the handler needs beyond its deps. */
export interface HandlerOptions {
  /**
   * The deployment's trusted hosts, read per request.
   *
   * A thunk rather than a snapshot: `webStartup` can become active after
   * `webServer` does, and a snapshot taken at mount would pin the fence to an
   * empty list — every LAN-hosted request 403 for the life of the process.
   */
  trustedHosts?: () => readonly string[]
}

/**
 * The route handler: fence, dispatch, structured failure.
 *
 * Exported so the assembly seam (spec S-1) can drive it with a fabricated
 * request instead of a socket.
 */
export function createStateHandler(deps: StateDeps, options: HandlerOptions = {}) {
  return async function handle(req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
    if (!isTrustedWebRequest(req, { trustedHosts: options.trustedHosts?.() ?? [] })) {
      writeJson(res, 403, { error: ERR_HTTP_FORBIDDEN })
      return
    }
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      writeJson(res, 405, { error: ERR_HTTP_METHOD })
      return
    }
    if (subPath(req.url) !== '/state') {
      writeJson(res, 404, { error: ERR_HTTP_NOT_FOUND })
      return
    }
    try {
      writeJson(res, 200, await buildStatePayload(deps))
    } catch {
      // `buildStatePayload` converts its own failures; this catches a host
      // service that throws from a getter, which must still leave a JSON body.
      writeJson(res, 500, { error: 'ERR_HTTP_INTERNAL' })
    }
  }
}
