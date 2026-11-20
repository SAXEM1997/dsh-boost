/**
 * Projection skip observability.
 *
 * A tool with no configured family returns its receipt unchanged, which is the
 * correct policy for `web_fetch`/`edit` and a silent mapping failure for a
 * decorated tool such as a new `mcp__ssh__*`. Both used to look identical from
 * `boost status` ("nothing projected"), so the operator could not tell "not
 * worth it" from "your tool is invisible to the mapper".
 *
 * The counter is deliberately cheap and bounded: one integer plus at most
 * {@link MAX_TRACKED_TOOLS} names. It counts calls that reached the projection
 * stage with a text receipt and no family; it is not a per-tool ledger.
 *
 * @module dsh-boost/projection/counters
 */

/** Bound on distinct unmapped tool names retained for status. */
const MAX_TRACKED_TOOLS = 32

/** Process-wide projection counters, owned by `apply` and read by `status`. */
export class ProjectionCounters {
  private unknownFamilyCount = 0
  private readonly unknownTools = new Map<string, number>()

  /**
   * Count one call whose family is not configured.
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
}
