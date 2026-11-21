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
import { createStateHandler, HTTP_API_PREFIX, type StateDeps } from './state.js'

/** The one service this plugin needs from the host's web composition. */
interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: unknown }): () => void
}

/** The slice of the plugin context this module uses. */
export interface HttpContextLike {
  inject?: (names: string[], callback: (context: { webServer?: WebServerLike }) => void) => unknown
  get?: (name: string) => unknown
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
  warn: (message: string) => void = message => console.warn(message),
): () => void {
  if (typeof ctx.inject !== 'function') {
    warn('[boost] webServer unavailable (no dynamic injection); settings page has no data route')
    return () => {}
  }
  let dispose: (() => void) | undefined
  try {
    ctx.inject(['webServer'], (context) => {
      const webServer = context.webServer
      if (webServer === undefined) {
        warn('[boost] webServer unavailable; settings page has no data route')
        return
      }
      const handler = createStateHandler(deps, { trustedHosts: () => resolveTrustedHosts(ctx) })
      dispose = webServer.register({ kind: 'prefix', path: HTTP_API_PREFIX, handler })
    })
  } catch (error) {
    // The mount must never cost the plugin: a composition without a web server
    // is the normal headless case, not a fault.
    const message = error instanceof Error ? error.message : String(error)
    warn(`[boost] settings page has no data route: ${message}`)
  }
  return () => {
    dispose?.()
    dispose = undefined
  }
}
