/**
 * Projection skip observability.
 *
 * A tool with no configured family returns its receipt unchanged, which is the
 * correct policy for `web_fetch`/`edit` and a silent mapping failure for a
 * decorated tool such as a new `mcp__ssh__*`. Both used to look identical from
 * `boost status` ("nothing projected"), so the operator could not tell "not
 * worth it" from "your tool is invisible to the mapper".
 *
 * The counter is deliberately cheap and bounded: two integers plus at most
 * {@link MAX_TRACKED_TOOLS} names. It counts calls that reached the projection
 * stage with a text receipt and no family; it is not a per-tool ledger. The
 * prompt-suppression count is the same shape, for the same reason: assembly
 * runs on every request, so only a number may be kept.
 *
 * @module dsh-boost/projection/counters
 */

/** Bound on distinct unmapped tool names retained for status. */
const MAX_TRACKED_TOOLS = 32

/** Process-wide projection counters, owned by `apply` and read by `status`. */
export class ProjectionCounters {
  private unknownFamilyCount = 0
  private readonly unknownTools = new Map<string, number>()
  private suppressedAssemblies = 0
  private missingProtocols = 0

  /**
   * Count one **decorated** call (`mcp__*`) whose family is not configured.
   *
   * Only decorated names are counted. An undecorated non-family tool (`edit`,
   * `web_fetch`, `todo_write`, or this plugin's own `boost`) is a by-design
   * pass, not a mapper gap, and counting it would bury the gap that matters in
   * noise the operator cannot separate out.
   *
   * `name` is optional because `exec.name` can be absent; the count still
   * increments, and only a present name is retained for the tool list.
   */
  unknownFamily(name: string | undefined): void {
    this.unknownFamilyCount += 1
    if (typeof name !== 'string' || name === '') return
    const seen = this.unknownTools.get(name) ?? 0
    if (seen === 0 && this.unknownTools.size >= MAX_TRACKED_TOOLS) return
    this.unknownTools.set(name, seen + 1)
  }

  /** Calls skipped because no projection family matched. */
  unknownFamilies(): number {
    return this.unknownFamilyCount
  }

  /** The retained unmapped tool names and their call counts (a copy). */
  unknownToolCounts(): Record<string, number> {
    return Object.fromEntries(this.unknownTools)
  }

  /**
   * Count one prompt assembly whose protocol section was suppressed.
   *
   * `systemPrompt` assembly runs on every request, so design §5.5:378 requires
   * a count and forbids a per-assembly receipt. Without the count, `status`
   * cannot distinguish the shipped `selected + []` (correctly inert) from an
   * assembly whose section failed to inject — the exact "inert looks identical
   * to broken" failure the operator has no other signal for.
   */
  protocolSuppressed(): void {
    this.suppressedAssemblies += 1
  }

  /** Prompt assemblies suppressed since load; read live by `boost status`. */
  protocolSuppressions(): number {
    return this.suppressedAssemblies
  }

  /**
   * Count one model request whose final system prompt lost the protocol
   * section to a `complete: true` section.
   *
   * Distinct from {@link protocolSuppressed}: that counter includes correctly
   * invisible workspaces, while this one means the plugin judged the workspace
   * visible and still could not teach the model the plan grammar. It is the
   * operator's only signal that the prompt belongs to another plugin (review
   * row 12), and it drives the stable `ERR_HOST_COMPLETE_SECTION` code.
   */
  protocolMissing(): void {
    this.missingProtocols += 1
  }

  /** Model requests that lost the protocol section since load. */
  protocolMissings(): number {
    return this.missingProtocols
  }
}
