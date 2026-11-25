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
import { createStateHandler, type StateDeps } from './state.js'

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
 * `dsh-client-connection` exposes `admit(request)` (and `requestRejection`,
 * which is the same call reduced to the rejection): it applies the host's own
 * Host/Origin fence and then requires an authenticated peer — a browser cookie
 * or an API token. `webServer.register` does not run it for us, so a route that
 * omits this is reachable by anything that can reach the port.
 *
 * Absent, or throwing, stays conservative: no service means the plugin's own
 * fence is the whole check (older hosts, headless deployments), and a service
 * that throws is treated as a refusal rather than as permission.
 */
function resolveAdmission(ctx: HttpContextLike): ((req: never) => { rejection?: number } | undefined) | undefined {
  let connection: { admit?: (req: unknown) => unknown } | undefined
  try {
    connection = ctx.get?.('connection') as typeof connection
  } catch {
    return undefined
  }
  const admit = connection?.admit
  if (typeof admit !== 'function') return undefined
  return (req) => {
    try {
      const admission = admit.call(connection, req) as { rejection?: unknown } | undefined
      const rejection = admission?.rejection
      return typeof rejection === 'number' ? { rejection } : undefined
    } catch {
      return { rejection: 401 }
    }
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
        ...(() => {
          const admit = resolveAdmission(ctx)
          return admit === undefined ? {} : { admit: admit as never }
        })(),
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
