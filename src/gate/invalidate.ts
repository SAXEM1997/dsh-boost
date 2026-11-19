/**
 * External invalidation sources and the double-projection guard.
 *
 * A substitution is decided from a receipt that arrived earlier. Between that
 * arrival and the decision the host may rewrite the receipt's *visible* body
 * without touching the plugin's state, in two ways (design §5.2-7):
 *
 * - the tool-result pruner replaces an oversized result's middle in place with
 *   a fixed marker. It **preserves** the anchors, so an anchor still matches a
 *   receipt whose body no longer does — the most common external rewrite.
 * - compaction replaces older history with a summary. The plugin's anchor for
 *   that history is gone, so the stored text and the receipt no longer agree.
 *
 * Either way the anchor is stale: projecting from it would emit a value out of
 * text the model can no longer see, and a guard evaluated against the old text
 * would claim a check the model never gets. Both must abandon the decision and
 * fall back to the main model (design §5.2-3).
 *
 * The second guard is independent and simpler: a receipt that already carries
 * the host spill footer has been retained once already, so projecting it again
 * would hide the original twice and point the model at a second-hand footer.
 * The notice predicate is injected rather than imported — the host's spill
 * policy is an optional peer and its recognition rule belongs to the caller.
 *
 * Everything here is pure: a string comparison, a predicate call, and a plain
 * session-keyed map with no persistence, timers, or I/O. The hook that consumes
 * these functions must never throw (the host turns a throwing listener into a
 * tool error and loses the real output, `dsh-tools/lib/pipeline.js:538-550`),
 * so the hook wraps the calls; these functions themselves only ever return a
 * value for a well-formed argument.
 *
 * @module dsh-boost/gate/invalidate
 */

/**
 * The host pruner's exact replacement marker.
 *
 * Verified against the installed package rather than copied from the plan:
 * `@deepseek-ai/dsh-compaction-tool-result-pruner@0.2.2-rc.4`, source
 * `src/config.ts:7` (`export const PRUNE_MARKER = '\n\n[... tool result middle
 * pruned ...]\n\n'`), compiled as `lib/index.js:8`. It matches the plan's
 * literal exactly. Do not "clean up" the surrounding blank lines: they are part
 * of the injected span and of this comparison.
 */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/**
 * What the decision path remembers about one substitution step.
 *
 * `anchors` maps a receipt id to the canonical original text as it arrived;
 * `stepId` names the step the anchors belong to. This is an anchor record, not
 * a dispatch queue: the pending-substitution queue stores its own entry, and
 * the same post-execute decision writes both.
 */
export interface ReceiptAnchors {
  stepId: string
  anchors: Record<string, string>
}

/**
 * Per-session receipt anchors.
 *
 * A plain `Map` behind three methods: no persistence, no timers, no I/O. It is
 * written by the decision path and read by the invalidation check, both in
 * `post-execute`; Task 23b fills it.
 */
export class AnchorStore {
  private readonly bySession = new Map<string, ReceiptAnchors>()

  /** Remember `a` as the pending anchors for `sessionId`, replacing any earlier record. */
  set(sessionId: string, a: ReceiptAnchors): void {
    this.bySession.set(sessionId, a)
  }

  /** The pending anchors for `sessionId`, or `undefined` when there is none. */
  get(sessionId: string): ReceiptAnchors | undefined {
    return this.bySession.get(sessionId)
  }

  /** Drop the pending anchors for `sessionId`; clearing an absent key is a no-op. */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId)
  }
}

/**
 * Whether the host pruner rewrote this text.
 *
 * Exactly `text.includes(PRUNE_MARKER)` — no prefix matching, no regex, no
 * trimming. If the host ever changes the marker's wording this returns `false`
 * and detection fails in the safe direction: at worst the plugin prunes one
 * more time than needed, and a stale anchor is never let through — a receipt
 * whose text no longer equals its stored anchor still triggers
 * `compaction-reset`. A near miss in ordinary output is likewise not a prune,
 * so text that merely looks like the marker is left alone.
 */
export function looksPruned(text: string): boolean {
  return text.includes(PRUNE_MARKER)
}

/**
 * Whether the receipt already carries the host spill footer.
 *
 * The answer is the injected predicate's: the caller owns the recognition rule
 * (Task 23b/T25 supply the host's `hasSpillNotice` through a dynamic import),
 * and this module must not import `@deepseek-ai/dsh-spill-policy` — it is an
 * optional peer, and a static import would make the degraded path unreachable.
 * Injecting it also keeps the guard testable without a host.
 */
export function alreadySpilled(text: string, hasNotice: (t: string) => boolean): boolean {
  return hasNotice(text)
}

/**
 * Why a stored receipt anchor can no longer be trusted, if it cannot.
 *
 * Fixed order, because the two external sources are not mutually exclusive:
 *
 * 1. no pending anchors -> `undefined` (nothing to invalidate);
 * 2. the text carries the prune marker -> `'pruned-reset'` **regardless of
 *    whether the anchors still match**, since the pruner preserves anchors and
 *    that is the common path;
 * 3. otherwise the anchor for `pending.stepId` is looked up: present and not
 *    equal to the receipt text -> `'compaction-reset'`;
 * 4. anchor missing or equal -> `undefined`.
 *
 * Only the receipt's canonical text is compared. The history's current body is
 * never read (design §5.2-7): after a prune the log holds head + marker + tail,
 * so re-reading it would either confirm the stale anchor or make the check
 * depend on a rewrite this module exists to detect.
 */
export function invalidate(
  pending: ReceiptAnchors | undefined,
  receiptText: string,
): 'pruned-reset' | 'compaction-reset' | undefined {
  if (pending === undefined) return undefined
  if (looksPruned(receiptText)) return 'pruned-reset'
  const anchor = pending.anchors[pending.stepId]
  if (anchor !== undefined && anchor !== receiptText) return 'compaction-reset'
  return undefined
}
