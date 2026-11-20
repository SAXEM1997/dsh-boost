/**
 * Projection retrieval accounting: the denominator of `projection_net_tokens`.
 *
 * The projection ledger's gross saving is what the plugin removed from the
 * history; the net saving must subtract what the model spent reading the
 * spilled original back. `projection_retrievals` counts those reads (design
 * §5.3), and its producer is the `read`/`grep` call that names one of this
 * session's spill locators. A retrieval that is not counted would make every
 * projection look free, which is why this is a ledger and not a statistic.
 *
 * The matcher is pure — `(params, locators) → boolean` — so the hook can call
 * it against the locators recorded when a receipt was actually spilled. The
 * per-session ledger is deliberately small and bounded: it keeps the most
 * recent {@link MAX_LOCATORS_PER_SESSION} locators, because a long session
 * projects far more artifacts than its model ever reads back and the ledger is
 * an audit aid, not a cache of the spill store.
 *
 * @module dsh-boost/admission/retrieval
 */

/** Deepest argument nesting a retrieval check will walk. */
const MAX_DEPTH = 32
/** Hard bound on visited argument nodes, so hostile params cannot stall a hook. */
const MAX_NODES = 4096
/** Bound on remembered locators per session (oldest evicted first). */
const MAX_LOCATORS_PER_SESSION = 512

/** A shared immutable empty set, so a missed session allocates nothing. */
const EMPTY_LOCATORS: ReadonlySet<string> = new Set()

/**
 * The first string leaf of `params` that equals one of `locators`.
 *
 * Exact equality is intentional: a locator is a complete spill path, and the
 * host's `read`/`grep` tools take the path as one argument. Substring matching
 * would count a read of `/spill/read-1.txt.bak` as a retrieval of the original.
 * The walk is iterative, depth-capped and node-capped because `params` is
 * model-written.
 */
function matchedLocator(params: unknown, locators: ReadonlySet<string>): string | undefined {
  if (locators.size === 0) return undefined

  const stack: Array<{ value: unknown; depth: number }> = [{ value: params, depth: 0 }]
  let visited = 0
  while (stack.length > 0 && visited < MAX_NODES) {
    const frame = stack.pop()
    if (frame === undefined) break
    visited += 1
    const value = frame.value

    if (typeof value === 'string') {
      if (locators.has(value)) return value
      continue
    }
    if (value === null || typeof value !== 'object') continue
    if (frame.depth >= MAX_DEPTH) continue

    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: frame.depth + 1 })
      continue
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      stack.push({ value: child, depth: frame.depth + 1 })
    }
  }
  return undefined
}

/**
 * Whether a tool call's arguments name one of the given spill locators.
 *
 * Total by construction: malformed, cyclic or hostile arguments return `false`
 * rather than throwing, because this runs inside the host's `post-execute`
 * waterfall where a throw would replace the tool result with an error.
 */
export function recordRetrieval(params: unknown, locators: ReadonlySet<string>): boolean {
  try {
    return matchedLocator(params, locators) !== undefined
  } catch {
    return false
  }
}

/**
 * The spill locators a session's projected receipts left behind.
 *
 * One instance belongs to the plugin instance; `apply` passes it through
 * `HookDeps` and `clearSession` drops a session's set on `session/disposed`, so
 * a disposed session cannot leak locators into the next one.
 */
export class RetrievalLedger {
  private readonly bySession = new Map<string, Set<string>>()
  /** Locators dropped by the cap, across every session; exposed by status. */
  private evictedCount = 0

  /** Remember one applied projection's locator; `true` when it was new. */
  record(sessionId: string, locator: string): boolean {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    if (typeof locator !== 'string' || locator === '') return false
    let locators = this.bySession.get(sessionId)
    if (locators === undefined) {
      locators = new Set()
      this.bySession.set(sessionId, locators)
    }
    if (locators.has(locator)) return false
    if (locators.size >= MAX_LOCATORS_PER_SESSION) {
      const oldest = locators.values().next().value
      if (oldest !== undefined) {
        locators.delete(oldest)
        this.evictedCount += 1
      }
    }
    locators.add(locator)
    return true
  }

  /** The locators currently remembered for `sessionId` (empty when unknown). */
  locatorsOf(sessionId: string): ReadonlySet<string> {
    return this.bySession.get(sessionId) ?? EMPTY_LOCATORS
  }

  /**
   * The matched locator for this call, or `undefined` when it is not a retrieval.
   *
   * Goes through the exported {@link recordRetrieval} predicate first, so the
   * production hook and the documented obligation share one decision; the
   * second walk only runs on a hit and is what puts the locator on the receipt.
   */
  locate(sessionId: string, params: unknown): string | undefined {
    try {
      const locators = this.locatorsOf(sessionId)
      if (!recordRetrieval(params, locators)) return undefined
      return matchedLocator(params, locators)
    } catch {
      return undefined
    }
  }

  /** Whether this call retrieves a spilled artifact. */
  hit(sessionId: string, params: unknown): boolean {
    return this.locate(sessionId, params) !== undefined
  }

  /** Drop one session's locators (session end). */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  /** Number of sessions currently holding locators. */
  size(): number {
    return this.bySession.size
  }

  /**
   * Locators the cap has dropped since process start.
   *
   * A silent eviction would make later re-reads uncounted and flatter the net
   * account; status reports this so an operator can see the ledger is lossy
   * rather than assume every retrieval was seen.
   */
  evictions(): number {
    return this.evictedCount
  }
}
