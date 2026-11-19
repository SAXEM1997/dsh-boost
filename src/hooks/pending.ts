/**
 * The pending substitution queue and the deterministic call id.
 *
 * When the plugin decides to answer a model request itself, the decision is
 * made in `tools/post-execute` and the synthesized turn is streamed by the
 * `llm/stream` listener later. The two are separated by one host round trip, so
 * the decision must be parked somewhere between them: that is this queue.
 *
 * The queue holds **one entry per session**, keyed by `sessionId` — never by
 * `callId`. The host dispatches the synthesized tool call only after the stream
 * ends, so the execute-side tamper check looks the entry up by session and then
 * compares `entry.callId` with `exec.callId` itself. Keying by `callId` here
 * would make that lookup return `undefined` for every call and silently disable
 * the guard (appendix §7).
 *
 * `callIdFor` is the only producer of a call id: sixteen hex characters of
 * `sha256(sessionId + '/' + turn + '/' + candidateId)`. It is pure and stable
 * across processes, so a receipt written in one process names the same call in
 * the next — and two candidates in one turn can never share an id.
 *
 * Everything here is a plain `Map` and a hash: no persistence, timers, host
 * calls, or I/O.
 *
 * @module dsh-boost/hooks/pending
 */
import { createHash } from 'node:crypto'

/**
 * One decided substitution waiting for the model turn that will carry it.
 *
 * `args` is the already-validated argument tree the tool must receive;
 * `createdAt` is evidence for a receipt and is never read by this module or by
 * {@link synthesizeTurn}. `turn` accepts both forms because the host carries a
 * numeric turn index while receipts and `callIdFor` keys are often strings;
 * concatenation in `callIdFor` normalises both to the same text.
 */
export interface PendingEntry {
  /** Id shared by the synthesized tool call and the arriving dispatch. */
  callId: string
  /** Plan candidate this call was substituted for. */
  candidateId: string
  /** Tool name to invoke. */
  name: string
  /** Validated argument object; serialised once by the synthesized turn. */
  args: Record<string, unknown>
  /** Host turn the decision belongs to (number or already-stringified form). */
  turn: number | string
  /** Wall-clock millis at decision time, for receipts only. */
  createdAt: number
}

/**
 * At most one pending substitution per session.
 *
 * `set` overwrites, because a second decision in the same session supersedes
 * the first: the earlier call can no longer arrive (its turn is over), and
 * keeping it would make the tamper check compare against a stale id. `take`
 * removes and returns; `peek` only reads. Clearing an absent session is a
 * no-op, so callers do not need to know whether a decision was parked.
 */
export class PendingQueue {
  private readonly bySession = new Map<string, PendingEntry>()

  /** Park `e` as the pending substitution for `sessionId`, replacing any earlier entry. */
  set(sessionId: string, e: PendingEntry): void {
    this.bySession.set(sessionId, e)
  }

  /** Remove and return the pending entry for `sessionId`, if any. */
  take(sessionId: string): PendingEntry | undefined {
    const pending = this.bySession.get(sessionId)
    if (pending === undefined) return undefined
    this.bySession.delete(sessionId)
    return pending
  }

  /** The pending entry for `sessionId`, without removing it. */
  peek(sessionId: string): PendingEntry | undefined {
    return this.bySession.get(sessionId)
  }

  /** Drop the pending entry for `sessionId`; an absent session is a no-op. */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  /** Number of sessions with a pending entry (not the number of calls ever set). */
  size(): number {
    return this.bySession.size
  }
}

/**
 * The deterministic id for one candidate in one session and turn.
 *
 * Exactly the first 16 hex characters of
 * `sha256(sessionId + '/' + turn + '/' + candidateId)`. Sixteen hex characters
 * is 64 bits, far beyond any collision a session can produce, while keeping the
 * id short enough to read in a receipt.
 *
 * Stable across processes because the input is fully spelled out and the hash
 * is SHA-256; idempotent for the same inputs; different for a different turn,
 * candidate, or session. `turn` is concatenated with `+`, so `3` and `'3'`
 * name the same id — the host and the receipt then agree whichever form they
 * hold.
 */
export function callIdFor(sessionId: string, turn: string | number, candidateId: string): string {
  return createHash('sha256').update(sessionId + '/' + turn + '/' + candidateId).digest('hex').slice(0, 16)
}
