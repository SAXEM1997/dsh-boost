/**
 * Mounts the plugin's HTTP surface onto the host's web server.
 *
 * The mount is a CHILD FIBER, not a load-time probe: `webServer` is provided by
 * the web composition and may become active after this plugin does, so
 * `ctx.inject(['webServer'], …)` runs the callback when (and if) the service
 * exists and unloads the routes when it goes away. A load-time `ctx.get` would
 * see `undefined` in a headless deployment and never mount, which is correct,
 * but it would also never mount in a web deployment whose siblings start in a
 * different order — the silent-disable trap this repo has hit before.
 *
 * `ctx.inject` is an AND gate over its list, so `webServer` is the only key:
 * every other service this surface reads (`webStartup` for the trusted hosts)
 * goes through the un-gated `ctx.get`, because a strict proxy throws on any
 * name outside the injection list.
 */
import { HTTP_API_PREFIX } from '../shared/api-prefix.js'
import { ERR_BOOST_HTTP_MOUNT_FAILED } from '../tools/boost.js'
import { createStateHandler, type HttpRequestLike, type StateDeps } from './state.js'

/** The one service this plugin needs from the host's web composition. */
interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: unknown }): () => void
}

/** The slice of the plugin context this module uses. */
export interface HttpContextLike {
  inject?: (names: string[], callback: (context: { webServer?: WebServerLike }) => void) => unknown
  get?: (name: string) => unknown
}

/**
 * The host's admission verdict, when this generation of the host has one.
 *
 * `dsh-client-connection` exposes `admit(request)`: it applies the host's own
 * Host/Origin fence and then requires an authenticated peer — a browser cookie
 * or an API token. `webServer.register` does not run it for us, so a route that
 * omits this is reachable by anything that can reach the port.
 *
 * The lookup is per REQUEST, not once at mount, for the same reason
 * `trustedHosts` is a thunk: `connection` is provided by a sibling fiber that
 * may activate after `webServer` does (it awaits `BrowserAuth.create` first),
 * and a service captured at mount would either be `undefined` forever — the
 * route silently unguarded — or a disposed instance that answers 401 to
 * everything after a reload. Two silent failures, both worse than a lookup.
 *
 * Absent stays permissive (older hosts, headless deployments, where our own
 * fence is the whole check); a lookup or a verdict that THROWS refuses, because
 * a check that cannot run must not read as permission.
 */
function admissionOf(
  ctx: HttpContextLike,
  req: HttpRequestLike,
): { rejection?: number } | undefined {
  let connection: { admit?: unknown } | undefined
  try {
    connection = ctx.get?.('connection') as typeof connection
  } catch {
    return { rejection: 401 }
  }
  const admit = connection?.admit
  if (typeof admit !== 'function') return undefined
  try {
    const admission = (admit as (request: unknown) => { rejection?: unknown } | undefined).call(connection, req)
    const rejection = admission?.rejection
    if (rejection === undefined) return undefined
    // A numeric verdict is passed through for the handler to map (401 / 403 /
    // anything else). A malformed one — a string, a renamed field, a Promise —
    // is a refusal rather than permission: the one unrecoverable direction.
    return typeof rejection === 'number' ? { rejection } : { rejection: 401 }
  } catch {
    return { rejection: 401 }
  }
}

/** Where the deployment declared its trusted hosts, across host generations. */
function resolveTrustedHosts(ctx: HttpContextLike): readonly string[] {
  for (const service of ['webStartup', 'webRuntime']) {
    try {
      const value = (ctx.get?.(service) as { trustedHosts?: unknown } | undefined)?.trustedHosts
      if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
    } catch {
      // A service that throws on read is not a reason to skip the fence: an
      // empty list falls back to loopback-only, which is stricter, not looser.
    }
  }
  return []
}

/**
 * Registers the route and returns its disposer.
 *
 * A host without dynamic injection gets a warning and no surface — the plugin's
 * other behaviour is untouched, which is the whole point of the mount being
 * optional.
 */
export function registerHttpApi(
  ctx: HttpContextLike,
  deps: StateDeps,
  warn: (message: string) => void,
): () => void {
  if (typeof ctx.inject !== 'function') {
    warn(
      `${ERR_BOOST_HTTP_MOUNT_FAILED}: no dynamic injection (\`ctx.inject\` is missing); ` +
        'settings page has no data route',
    )
    return () => {}
  }
  let dispose: (() => void) | undefined
  try {
    ctx.inject(['webServer'], (context) => {
      const webServer = context.webServer
      if (webServer === undefined) {
        warn(`${ERR_BOOST_HTTP_MOUNT_FAILED}: webServer resolved to undefined; settings page has no data route`)
        return
      }
      const handler = createStateHandler(deps, {
        trustedHosts: () => resolveTrustedHosts(ctx),
        admit: (req) => admissionOf(ctx, req),
      })
      dispose = webServer.register({ kind: 'prefix', path: HTTP_API_PREFIX, handler })
    })
  } catch (error) {
    // The mount must never cost the plugin: a composition without a web server
    // is the normal headless case, not a fault.
    const message = error instanceof Error ? error.message : String(error)
    warn(`${ERR_BOOST_HTTP_MOUNT_FAILED}: ${message}`)
  }
  return () => {
    dispose?.()
    dispose = undefined
  }
}
