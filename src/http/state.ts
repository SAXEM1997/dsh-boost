/**
 * The plugin's read-only HTTP surface for the settings page.
 *
 * WHY A ROUTE OF OUR OWN: the host's `webServer` serves the SPA and knows
 * nothing about a plugin's state, and `ctx.settings` only describes plugins
 * that declare a `Config` schema — this one deliberately does not (spec #2:
 * a strict schema turns `resolveConfig`'s clamp-and-warn into a load-time hard
 * failure). So the page reads through one prefix this plugin owns.
 *
 * NO AUTHENTICATION IS INHERITED: `webServer.register` performs none and
 * claims no path namespace. So two gates run, in this order — the host's own
 * admission (`HandlerOptions.admit`, when the deployment has that service: a
 * DSH peer cookie or API token) and then the plugin's browser fence
 * (`isTrustedWebRequest`, see `fence.ts` for what it closes and why an absent
 * `Origin` is admitted on reads but refused on writes). Neither is sufficient
 * alone: the fence knows nothing about identity, and admission is a no-op on
 * hosts that do not require one.
 *
 * EVERY FAILURE IS A STRUCTURED BODY. The page decides what to say from a
 * stable code, never from prose, so a handler here returns codes even when the
 * underlying read threw.
 */
import { HTTP_API_PREFIX } from '../shared/api-prefix.js'
import type { Envelope, StatePayload, WorkspaceEntry, WorkspaceListing } from '../shared/api-types.js'
import { ERR_BOOST_INTERNAL, ERR_BOOST_INVALID_ARGS, ERR_BOOST_INVALID_BODY } from '../tools/boost.js'
import type { BoostStatus } from '../tools/boost.js'
import type { ScopeDoc } from '../scope/doc.js'
import { ERR_SCOPE_WRITE_FAILED } from '../scope/doc.js'
import type { BoostConfig } from '../types.js'
import { isTrustedWebRequest } from './fence.js'

export type { StatePayload, WorkspaceEntry, WorkspaceListing } from '../shared/api-types.js'

/** The route prefix this plugin owns: absolute, no trailing slash. */
export { HTTP_API_PREFIX } from '../shared/api-prefix.js'

/** Stable codes this surface adds to the plugin's vocabulary. */
export const ERR_HTTP_METHOD = 'ERR_HTTP_METHOD'
export const ERR_HTTP_NOT_FOUND = 'ERR_HTTP_NOT_FOUND'
export const ERR_HTTP_FORBIDDEN = 'ERR_HTTP_FORBIDDEN'
export const ERR_HTTP_UNAUTHORIZED = 'ERR_HTTP_UNAUTHORIZED'
export const ERR_HTTP_WORKSPACES_UNAVAILABLE = 'ERR_HTTP_WORKSPACES_UNAVAILABLE'
export const ERR_HTTP_INTERNAL = 'ERR_HTTP_INTERNAL'
export const ERR_HTTP_BODY = 'ERR_HTTP_BODY'

/** What the state handler reads. Everything is a thunk: state moves. */
export interface StateDeps {
  /**
   * `runBoost` with `{ cmd: 'status' }` — the same computation as the tool.
   *
   * Typed by command, not `unknown`: the page reads this envelope's `data` as
   * a `BoostStatus`, so the provider and the consumer are checked against one
   * shape instead of agreeing by convention.
   */
  status(): Promise<Envelope<BoostStatus>>
  /** `runBoost` with `{ cmd: 'scope-get' }`. */
  scope(): Promise<Envelope<ScopeDoc>>
  /** The host's workspace registry, resolved lazily. */
  workspaces(): WorkspaceListing
  /** The effective configuration `resolveConfig` produced at load. */
  config(): BoostConfig
  /**
   * `runBoost` with `{ cmd: 'scope-set' }` — the same CAS the tool performs.
   *
   * A write goes through the tool's own command rather than a second
   * implementation of the patch rules: two copies of "which fields may change,
   * and what a revision means" is exactly how a page and a tool end up
   * disagreeing about whether a save succeeded.
   */
  write(body: unknown, baseRevision: unknown): Promise<Envelope<ScopeDoc>>
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
      const title = (entry as { title?: unknown } | null | undefined)?.title
      if (typeof id !== 'string' || typeof path !== 'string') continue
      out.push(typeof title === 'string' && title !== '' ? { id, path, title } : { id, path })
    }
    return { available: true, entries: out }
  } catch {
    return { available: false, code: ERR_HTTP_WORKSPACES_UNAVAILABLE }
  }
}

/** Builds the payload; every branch is already a code, never a thrown error. */
export async function buildStatePayload(deps: StateDeps): Promise<StatePayload> {
  const [status, scope] = await Promise.all([deps.status(), deps.scope()])
  // The config is resolved synchronously at load and cannot fail, but it
  // travels in the same envelope as the command results so the page has one
  // shape to read rather than a per-field convention.
  return { status, scope, workspaces: deps.workspaces(), config: { ok: true, data: deps.config() } }
}

/** The two request/response shapes the handler touches, narrowed to what it uses. */
export interface HttpRequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  /** Present on writes: the request stream, as node hands it over. */
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>
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
  // The route is mounted as a prefix, so the host only ever dispatches paths
  // that already start with it.
  return path.slice(HTTP_API_PREFIX.length)
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
  /**
   * The host's own admission verdict for this request, when the deployment has
   * one.
   *
   * `webServer.register` hands the handler the whole response lifecycle and
   * applies no access check of its own, so a route that skips this is reachable
   * by anything that can reach the port. The fence below answers "is this the
   * same origin"; this answers "is the caller allowed at all" — a DSH peer
   * cookie or API token on deployments that require one.
   *
   * `undefined` means NO VERDICT — either the host has no such service, or it
   * allowed the request. Both fall through to the fence, so a caller must not
   * read `undefined` as "the check did not run". Any other value is a refusal;
   * the only two the host's contract defines are 401 and 403.
   */
  admit?: (req: HttpRequestLike) => { rejection?: number } | undefined
}

/** The largest write body accepted; a scope document is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024

/** Reads the request body as UTF-8 text, refusing anything oversized. */
async function readBody(req: HttpRequestLike): Promise<{ ok: true; text: string } | { ok: false; code: string }> {
  const iterator = req[Symbol.asyncIterator]
  if (typeof iterator !== 'function') return { ok: false, code: ERR_HTTP_BODY }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req as AsyncIterable<unknown>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk as Uint8Array)
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) return { ok: false, code: ERR_HTTP_BODY }
    chunks.push(buffer)
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
}

/**
 * Maps a `scope-set` failure onto an HTTP status.
 *
 * The body always carries the plugin's own code, so the page never has to
 * infer anything from the status: a conflict is 409 because the caller can
 * retry after a re-read, a malformed request is 400 because retrying it
 * unchanged cannot work, and everything else is a refusal of the current
 * state (409) or an internal fault (500).
 */
function writeStatusFor(code: string): number {
  if (code === ERR_HTTP_BODY) return 400
  if (code === ERR_BOOST_INVALID_BODY || code === ERR_BOOST_INVALID_ARGS) return 400
  if (code === ERR_BOOST_INTERNAL) return 500
  // A failed write is a storage fault, not a disagreement with the document:
  // re-reading cannot help, and the draft is still good.
  if (code === ERR_SCOPE_WRITE_FAILED) return 500
  // Every remaining scope code means "this write cannot be applied to the
  // document as it stands": stale revision, held lock, unreadable or
  // unrecognised file. All of them are resolved by looking at the document.
  return 409
}

/**
 * The route handler: fence, dispatch, structured failure.
 *
 * Exported so the assembly seam (spec S-1) can drive it with a fabricated
 * request instead of a socket.
 */
export function createStateHandler(deps: StateDeps, options: HandlerOptions = {}) {
  const trustedHosts = (): readonly string[] => options.trustedHosts?.() ?? []

  return async function handle(req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
    // The host's admission first: when it says no, the request never reaches
    // state, not even to read it.
    let admission: { rejection?: number } | undefined
    try {
      admission = options.admit?.(req)
    } catch {
      // A check that cannot run must not read as "allowed".
      admission = { rejection: 401 }
    }
    const rejection = admission?.rejection
    if (typeof rejection === 'number') {
      // 401 is the host's "not authenticated", 403 its "not trusted". Anything
      // else is a verdict this route has no code for; reporting it as an auth
      // failure would send the operator to the wrong place, so it answers 500.
      if (rejection === 403) {
        writeJson(res, 403, { error: ERR_HTTP_FORBIDDEN })
      } else if (rejection === 401) {
        writeJson(res, 401, { error: ERR_HTTP_UNAUTHORIZED })
      } else {
        writeJson(res, 500, { error: ERR_HTTP_INTERNAL })
      }
      return
    }

    const method = req.method ?? 'GET'
    const isWrite = method !== 'GET' && method !== 'HEAD'
    // Reads admit an absent `Origin` (a same-origin GET never carries one, and
    // neither does curl); writes demand it, because a browser always attaches
    // it to a POST and that is what makes a cross-site write detectable.
    if (!isTrustedWebRequest(req, { trustedHosts: trustedHosts(), requireOrigin: isWrite })) {
      writeJson(res, 403, { error: ERR_HTTP_FORBIDDEN })
      return
    }
    const path = subPath(req.url)

    if (isWrite) {
      // A write aimed at a read-only path is a method error, not a missing
      // route: the path exists, the verb does not belong there.
      if (path === '/state' || method !== 'POST') {
        writeJson(res, 405, { error: ERR_HTTP_METHOD })
        return
      }
      if (path !== '/scope') {
        writeJson(res, 404, { error: ERR_HTTP_NOT_FOUND })
        return
      }
      await handleWrite(deps, req, res)
      return
    }

    // `/scope` exists but only accepts POST: a GET there is a method error, not
    // a missing route. Reporting 404 made a caller think the path was gone,
    // and the body's generic "version mismatch" text pointed at the wrong
    // cause (review P3-10).
    if (path === '/scope') {
      writeJson(res, 405, { error: ERR_HTTP_METHOD })
      return
    }
    if (path !== '/state') {
      writeJson(res, 404, { error: ERR_HTTP_NOT_FOUND })
      return
    }
    try {
      writeJson(res, 200, await buildStatePayload(deps))
    } catch {
      // `buildStatePayload` converts its own failures; this catches a host
      // service that throws from a getter, which must still leave a JSON body.
      writeJson(res, 500, { error: ERR_HTTP_INTERNAL })
    }
  }
}

/** The write half: parse, delegate to the tool's own command, map the answer. */
async function handleWrite(deps: StateDeps, req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
  const body = await readBody(req)
  if (!body.ok) {
    writeJson(res, 400, { error: body.code })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.text)
  } catch {
    writeJson(res, 400, { error: ERR_HTTP_BODY })
    return
  }
  const envelope = parsed as { body?: unknown; baseRevision?: unknown } | null
  if (envelope === null || typeof envelope !== 'object') {
    writeJson(res, 400, { error: ERR_HTTP_BODY })
    return
  }
  let result: { ok: true; data: unknown } | { ok: false; code: string }
  try {
    result = await deps.write(envelope.body, envelope.baseRevision)
  } catch {
    writeJson(res, 500, { error: ERR_HTTP_INTERNAL })
    return
  }
  if (!result.ok) {
    writeJson(res, writeStatusFor(result.code), { error: result.code })
    return
  }
  writeJson(res, 200, { ok: true, data: result.data })
}
