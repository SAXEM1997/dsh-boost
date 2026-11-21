/**
 * The browser-trust fence for the plugin's own HTTP surface.
 *
 * WHY THIS EXISTS: `webServer.register` does no authentication and claims no
 * path namespace. Any page the operator's browser loads from any origin can
 * POST to this server, and the host's SPA is not the only client that can. The
 * read route returns the full scope document, so "only the settings page talks
 * to it" has to be enforced here or nowhere.
 *
 * Two confused-deputy paths are closed:
 *
 *  - **DNS rebinding** — an attacker-controlled name resolving to this server,
 *    so the browser's own request looks same-origin. `Host` is the one header
 *    rebinding cannot forge, so it is judged first and unconditionally.
 *  - **Cross-site requests** — a malicious page firing a request at this
 *    server. An attached `Origin` that disagrees with `Host` is rejected, and
 *    `sec-fetch-site: cross-site` rejects before that comparison is reached.
 *
 * AN ABSENT `Origin` IS NOT AN ATTACK. Over plain HTTP a browser attaches
 * neither `Origin` nor Fetch Metadata to a same-origin GET — the settings
 * page's own reads carry no `Origin` at all. Requiring one would 403 the page
 * that owns this surface while stopping nothing (a cross-site read is `no-cors`
 * and cannot read the body; a `cors` read sends `Origin` and is rejected).
 * Writes are the opposite case: a browser DOES send `Origin` on POST, so a
 * write route requires it (`requireOrigin`).
 */

/** A parsed `Host` header or `trustedHosts` entry. */
export interface Authority {
  /** WHATWG hostname; an IPv6 literal keeps its brackets. */
  hostname: string
  /** Hostname and port, as `URL.host` serialises them. */
  host: string
  /** Whether the value carried no explicit port. */
  bare: boolean
}

/** What the fence needs from a request: header access, nothing else. */
export interface HeaderCarrier {
  headers: Record<string, string | string[] | undefined>
}

/** The fence's inputs. */
export interface FenceOptions {
  /** Authorities the deployment declared (`webStartup.trustedHosts`). */
  trustedHosts?: readonly string[]
  /**
   * Whether an absent `Origin` is refused.
   *
   * False for reads (the page's own GETs carry none); true for writes (a
   * browser always sends one on POST, so its absence means a non-browser
   * client, which this surface does not serve).
   */
  requireOrigin?: boolean
}

/** The first value of a header, ignoring the array form Node allows. */
function header(headers: HeaderCarrier['headers'], name: string): string | undefined {
  const value = headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const first = value[0]
    return typeof first === 'string' ? first : undefined
  }
  return undefined
}

/**
 * Canonical authority of a `Host` header or a `trustedHosts` entry.
 *
 * Returns `undefined` for anything a URL cannot express, which is how a
 * malformed `Host` becomes a rejection rather than a comparison that happens
 * to pass.
 */
export function parseAuthority(value: unknown): Authority | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const url = new URL(`http://${value}`)
    if (url.hostname === '') return undefined
    return { hostname: url.hostname, host: url.host, bare: url.port === '' }
  } catch {
    return undefined
  }
}

/**
 * Whether a hostname names the local machine.
 *
 * The input is the WHATWG serialisation, which KEEPS the brackets on an IPv6
 * literal: `new URL('http://[::1]:23023').hostname` is `'[::1]'`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (bare === '::1') return true
  // 127.0.0.0/8. A deployment may bind 127.0.0.53 and a browser may name it.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

/**
 * Whether the request authority is a deployment-declared trusted host.
 *
 * A port-less entry matches the hostname on any port — the shape the CLI
 * derives for IP-literal LAN serving, where the bound port may be OS-assigned.
 * An entry with an explicit port matches that exact authority.
 */
export function isTrustedAuthority(authority: Authority, trustedHosts: readonly string[]): boolean {
  for (const entry of trustedHosts) {
    const parsed = parseAuthority(entry)
    if (parsed === undefined) continue
    if (parsed.bare ? parsed.hostname === authority.hostname : parsed.host === authority.host) {
      return true
    }
  }
  return false
}

/**
 * The fence. Returns `true` only when the request may be served.
 *
 * Branches run in this order, and the order is the design: `Host` first
 * because rebinding forges everything else, then Fetch Metadata, then
 * `Origin` — so a request that fails an earlier branch never reaches a later
 * comparison that a malformed value could accidentally satisfy.
 */
export function isTrustedWebRequest(request: HeaderCarrier, options: FenceOptions = {}): boolean {
  const host = header(request.headers, 'host')
  const authority = parseAuthority(host)
  if (authority === undefined) return false
  if (!isLoopbackHostname(authority.hostname) && !isTrustedAuthority(authority, options.trustedHosts ?? [])) {
    return false
  }
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return options.requireOrigin !== true
  try {
    return new URL(origin).host === authority.host
  } catch {
    return false
  }
}
