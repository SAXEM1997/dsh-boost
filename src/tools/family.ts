/**
 * Host tool name → projection family.
 *
 * The projection windows are keyed by family (`read`/`grep`/`glob`/`bash`/
 * `ssh`), but the host names MCP-backed tools with a decoration:
 * `mcp__ssh__execute-command`. A miss here is silent — `projectDecision`
 * simply returns the receipt unchanged — so this mapping is the only thing
 * that keeps projection enabled for the ssh family.
 *
 * The rule is deliberately narrow. A bare family name maps to itself; an MCP
 * name maps only when the **server** segment is itself a family. `web_fetch`,
 * `edit`, `mcp__filesystem__read_file` and every future tool have no window
 * (design §5.3), and the last one must not be mistaken for `read` just because
 * its method is named `read_file`.
 *
 * @module dsh-boost/tools/family
 */
import type { ToolFamily } from '../types.js'

/** The families configured in `BoostConfig.projection`. */
const FAMILIES: ReadonlySet<string> = new Set(['read', 'grep', 'glob', 'bash', 'ssh'])

/** The host's MCP decoration: `mcp__<server>__<tool>`. */
const MCP_PREFIX = 'mcp__'

/**
 * The projection family for a host tool name, or `undefined` when it has none.
 *
 * `undefined` is the design's "pass through unchanged" case, not an error.
 * The name is validated defensively because `exec.name` crosses the host
 * boundary and is typed loosely at the hook.
 */
export function familyOf(name: string): ToolFamily | undefined {
  if (typeof name !== 'string' || name === '') return undefined
  if (FAMILIES.has(name)) return name as ToolFamily
  if (!name.startsWith(MCP_PREFIX)) return undefined

  const rest = name.slice(MCP_PREFIX.length)
  const separator = rest.indexOf('__')
  if (separator <= 0) return undefined
  const server = rest.slice(0, separator)
  return FAMILIES.has(server) ? (server as ToolFamily) : undefined
}
