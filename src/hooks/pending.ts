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
 * `sha256(JSON.stringify([sessionId, String(turn), String(step), candidateId]))`.
 * The JSON array is deliberate: a `'/'` join lets one component impersonate a
 * separator (`('s', '1/2', 0, 'c')` and `('s', '1', 0, '2/c')` would hash the
 * same), and a flat tuple cannot carry `step` without that same ambiguity.
 * Step is part of the identity because the host persists every assistant
 * `tool_use` block with its id: the same candidate committed at two steps of
 * one turn must not reuse one id, or the provider rejects the duplicated id.
 * The id is pure and stable across processes, so a receipt written in one
 * process names the same call in the next.
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
 * `args` is the already-validated argument tree the tool must receive. `turn`
 * and `step` accept number or string because the host carries numeric indexes
 * while receipts often use strings; the JSON array in `callIdFor` normalises
 * both forms of the same value to one identity.
 *
 * Treat an entry as immutable once it is queued. The queue hands out the stored
 * object by reference, and mutating `args` after the decision would make the
 * admission receipt describe arguments different from the ones dispatched.
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
  /** Host step within `turn` (number or already-stringified form); part of the call id. */
  step: number | string
}

/**
 * At most one pending substitution per session.
 *
 * `set` overwrites, because a second decision in the same session supersedes
 * the first: the earlier call can no longer arrive (its turn is over), and
 * keeping it would make the tamper check compare against a stale id. `take`
 * removes and returns; `peek` only reads. Clearing an absent session is a
 * no-op, so callers do not need to know whether a decision was parked.
 *
 * **Reference semantics.** `set` stores the caller's object and `peek`/`take`
 * return that same object, never a copy. Own it once queued: T23b builds the
 * entry from the admitted candidate and must not mutate `args` afterwards, or
 * the admission receipt will describe a call different from the one that runs.
 *
 * **Lifetime.** Entries leave only through `take` or `clear`; there is no
 * expiry timer and no session hook here. A session that aborts between
 * `tools/post-execute` and the next `llm/stream` therefore parks its entry for
 * the process lifetime, so the owning hook must `clear` at session end. Failing
 * to clear costs memory and nothing else: the execute hook only intervenes when
 * the arriving call's `callId` equals the entry's, and a call with any other id
 * passes through untouched, so a stale entry can neither reject an ordinary call
 * nor be matched by one. The parked `args` are still a leak.
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
 * The deterministic id for one candidate at one step of one turn in one session.
 *
 * Exactly the first 16 hex characters of
 * `sha256(JSON.stringify([sessionId, String(turn), String(step), candidateId]))`.
 * Sixteen hex characters is 64 bits, far beyond any collision a session can
 * produce, while keeping the id short enough to read in a receipt.
 *
 * **Encoding.** The four identity components are hashed as a JSON array, not
 * joined with `'/'`. With a join, `('s', '1/2', 0, 'c')` and
 * `('s', '1', 0, '2/c')` would hash identically: a `/` inside a component
 * impersonates the separator.
 * JSON quotes each string and delimits the elements, so no component can spill
 * into another. `turn` and `step` are stringified first, so the host's numeric
 * index and a receipt's string form of the same value name one id — the
 * original `number | string` normalisation is preserved.
 *
 * The array also carries `step`, which the old tuple omitted: the same
 * candidate committed twice in one turn must receive different ids, or the host
 * persists two assistant `tool_use` blocks with one id and Anthropic-style
 * providers reject the request.
 *
 * Stable across processes because the input is fully spelled out and the hash
 * is SHA-256; idempotent for the same inputs; different for a different
 * session, turn, step, or candidate.
 */
export function callIdFor(
  sessionId: string,
  turn: string | number,
  step: string | number,
  candidateId: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([sessionId, String(turn), String(step), candidateId]))
    .digest('hex')
    .slice(0, 16)
}
