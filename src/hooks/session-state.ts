/**
 * Per-session bookkeeping for the post-execute decision path.
 *
 * Two maps live here, both keyed by session id and both scoped to one host turn
 * (design §5.2-7: the anchor cache expires at turn end):
 *
 * - **Receipts.** `decide` evaluates guards and `$public` templates against the
 *   receipt that just arrived (filed under `'root'`) *and* the receipts of the
 *   calls this plugin substituted earlier in the turn (filed under the plan
 *   candidate id). Without the second half a later step's
 *   `{ "$public": { "after": "A" … } }` can never bind, so the plan could only
 *   ever commit its first step.
 * - **In-flight dispatches.** `tools/execute` clears the pending entry on both
 *   paths (a stale entry would falsely reject every later call in the session),
 *   but `tools/post-execute` still needs to know which candidate the arriving
 *   call belonged to. The execute hook records `callId -> candidateId` here
 *   before clearing, and the post-execute hook consumes it once.
 *
 * A new host turn drops both maps. Turn detection is lazy: the hooks see no
 * turn-end event, so the first call of a new turn is what folds the old turn
 * away. Nothing here throws on its own, but every method is still called from
 * inside the hooks' `try` blocks, because the callers own the no-throw
 * contract with the host.
 *
 * **Lifetime.** One entry per session, scoped to the host turn. A session's
 * entry is replaced on the first call of its next turn, so the steady-state
 * retention is one turn's receipts (at most 27: `'root'` plus the plan's
 * `A`–`Z`) and any in-flight dispatches. There is no session-end signal in the
 * hooks this task owns, so a session that is never touched again keeps its last
 * turn until the process exits. `clear(sessionId)` is exposed for 23c: pass the
 * instance through `HookDeps.sessionState` and call it on whatever session-end
 * signal the host offers.
 *
 * This module is private (`HookDeps` exposes only the optional instance, not
 * the class's internals). It lives apart from `post-execute.ts` because that
 * file already carries the four mount bodies and the twelve obligations;
 * mixing a mutable session map into it would make the hook harder to audit.
 *
 * @module dsh-boost/hooks/session-state
 */
import type { CanonicalReceipt } from '../projection/canonicalise.js'

/** One session's receipts and in-flight dispatches for the current turn. */
interface SessionEntry {
  /** The host turn the entry belongs to; a different turn resets it. */
  turn: number
  /** Receipts keyed by `'root'` or a plan candidate id. */
  receipts: Map<string, CanonicalReceipt>
  /** `callId -> candidateId` for substitutions the execute hook accepted. */
  dispatches: Map<string, string>
}

/**
 * Receipt and dispatch memory for every session the plugin has seen.
 *
 * `begin` is the only reader that can fold a turn away; callers use it once per
 * hook invocation and then use the rest of the API. There is no eviction within
 * a turn: a session's candidate receipts are exactly the steps of the current
 * plan, and plan parsing caps a plan at 26 steps (`A`–`Z`).
 */
export class ReceiptSessionState {
  private readonly bySession = new Map<string, SessionEntry>()

  /**
   * Return the state for `sessionId` at `turn`, discarding a previous turn's
   * receipts and dispatches.
   *
   * `rolledOver` tells the caller that the previous turn's anchors (which live
   * in `AnchorStore`, not here) are stale too and must be dropped. A brand-new
   * session has nothing to roll over, so it reports `false`.
   */
  begin(sessionId: string, turn: number): { entry: SessionEntry; rolledOver: boolean } {
    const existing = this.bySession.get(sessionId)
    if (existing !== undefined && existing.turn === turn) {
      return { entry: existing, rolledOver: false }
    }
    const entry: SessionEntry = { turn, receipts: new Map(), dispatches: new Map() }
    this.bySession.set(sessionId, entry)
    return { entry, rolledOver: existing !== undefined }
  }

  /** File the receipt that just arrived under `'root'`, keeping candidate receipts. */
  recordRoot(sessionId: string, turn: number, receipt: CanonicalReceipt): void {
    this.begin(sessionId, turn).entry.receipts.set('root', receipt)
  }

  /** File an executed candidate's receipt under its plan candidate id. */
  recordCandidate(sessionId: string, turn: number, candidateId: string, receipt: CanonicalReceipt): void {
    this.begin(sessionId, turn).entry.receipts.set(candidateId, receipt)
  }

  /** The receipt map `decide` reads; contains `'root'` after `recordRoot`. */
  receiptsFor(sessionId: string, turn: number): ReadonlyMap<string, CanonicalReceipt> {
    return this.begin(sessionId, turn).entry.receipts
  }

  /** Remember which candidate a dispatched call id belongs to. */
  recordDispatch(sessionId: string, turn: number, callId: string, candidateId: string): void {
    this.begin(sessionId, turn).entry.dispatches.set(callId, candidateId)
  }

  /** Consume the candidate id for `callId`, or `undefined` when the call is not one of ours. */
  takeDispatch(sessionId: string, turn: number, callId: string): string | undefined {
    const { entry } = this.begin(sessionId, turn)
    const candidateId = entry.dispatches.get(callId)
    if (candidateId === undefined) return undefined
    entry.dispatches.delete(callId)
    return candidateId
  }

  /**
   * Drop everything for one session: both maps and the stored turn.
   *
   * 23c calls this on a session-end signal; the hooks themselves only replace
   * an entry lazily when the next turn's first call arrives.
   */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId)
  }
}
