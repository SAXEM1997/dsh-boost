/**
 * Per-session bookkeeping for the post-execute decision path.
 *
 * The receipt/dispatch maps below are the class's own state. The module also
 * owns the small plumbing both hook modules share — queue/anchor/plan access,
 * receipt appends, the clock-turn read and receipt previews — so the two
 * former copies cannot drift (in particular, their `clockTurnOf` fallbacks
 * disagreed on `0` vs `undefined`).
 *
 * Both maps are keyed by session id and scoped to one host turn
 * (design §5.2-7: the anchor cache expires at turn end):
 *
 * - **Receipts.** `decide` evaluates guards and `$public` templates against the
 *   receipt that just arrived (filed under `'root'`) *and* the receipts of the
 *   calls this plugin substituted earlier in the turn (filed under the plan
 *   candidate id). Without the second half a later step's
 *   `{ "$public": { "after": "A" … } }` can never bind, so the plan could only
 *   ever commit its first step.
 * - **In-flight dispatches.** `tools/execute` clears the pending entry once the
 *   arriving call's id matches it (on accept or reject); a call with a different
 *   id passes through untouched. `tools/post-execute` still needs to know which
 *   candidate the arriving call belonged to. The execute hook records `callId -> candidateId` here
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
 * `A`–`Z`) and any in-flight dispatches. `session/disposed` is wired in
 * `src/index.ts`, which calls `clearSession(deps, sessionId)`; that drops this
 * state along with the queue, anchors, plan and per-session runtime, so a
 * disposed session leaves nothing behind.
 *
 * The class's internals stay private (`HookDeps` exposes only the optional
 * instance), and only the plumbing helpers are exported. It lives apart from
 * `post-execute.ts` because that file already carries the four mount bodies and
 * the eleven obligations; mixing a mutable session map into it would make the
 * hook harder to audit.
 *
 * @module dsh-boost/hooks/session-state
 */
import type { ReceiptAnchors } from '../gate/invalidate.js'
import type { ReceiptStore } from '../receipts/store.js'
import type { CanonicalReceipt } from '../projection/canonicalise.js'
import type { TurnClock } from './clock.js'
// `sessionClock` is the single owner of the shared-instance loan rule. Importing
// it here keeps `clockTurnOf` from growing a second, disagreeing copy of that
// rule; the cycle is type/function-only (neither module calls the other at
// evaluation time).
import { sessionClock } from './llm-stream.js'
import type { PendingEntry, PendingQueue } from './pending.js'

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
   * `src/index.ts` calls this from its `session/disposed` listener through
   * `clearSession`; the hooks themselves only replace an entry lazily when the
   * next turn's first call arrives.
   */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId)
  }
}

// ---------------------------------------------------------------------------
// Shared session plumbing
// ---------------------------------------------------------------------------
//
// `post-execute.ts` and `llm-stream.ts` both read the queue, anchors, plans and
// receipt store. These helpers live here so the two copies that used to exist
// cannot drift: in particular the old `clockTurnOf` returned `0` in one file and
// `undefined` in the other, which stamped different `turn` values on receipts
// for the same state. `receipts` and `anchors` are typed structurally so the
// module stays usable from a test double as well as from `HookDeps`.

/** The store's append input, shared by both hook modules. */
export type ReceiptInput = Parameters<ReceiptStore['append']>[0]

/** The dependencies these helpers read; `HookDeps` is structurally assignable. */
export interface SessionPlumbing {
  /** Shared fallback clock when no per-session runtime is wired. */
  clock?: TurnClock
  /** Per-session runtime; its clock is authoritative when present. */
  sessions?: { clockFor(sessionId: string): TurnClock }
  /** At most one pending substitution per session. */
  queue?: PendingQueue
  /** Per-session receipt anchors. */
  anchors?: {
    get(sessionId: string): ReceiptAnchors | undefined
    clear(sessionId: string): void
  }
  /** Append-only receipt store. */
  receipts?: ReceiptStore
  /** Parsed plans, keyed by session. */
  plans?: { delete(sessionId: string): boolean }
}

/**
 * The session's host turn, or `undefined` when no clock can answer a real turn.
 *
 * The clock is resolved through `sessionClock`, never by reading `deps.clock`
 * directly: that function owns the shared-instance loan rule. When no
 * per-session runtime is wired, one shared clock may only be read by the
 * session it was lent to; a second session gets `undefined` instead of another
 * session's turn (review row 20). A clock that throws, a missing clock and a
 * non-finite or non-positive turn all mean "no host turn": `TurnClock` reports
 * 0 before the first `agent/request`, and real host turns start at 1. Callers
 * that need a number for a receipt field write `?? 0`; callers that decide
 * turn validity keep the `undefined` distinction.
 */
export function clockTurnOf(
  deps: SessionPlumbing,
  sessionId: string,
): number | undefined {
  let clock: TurnClock | undefined
  try {
    // `SessionPlumbing` is the structural subset `sessionClock` reads; the
    // cast only widens it to the full `HookDeps` the hook modules pass.
    clock = sessionClock(deps as unknown as Parameters<typeof sessionClock>[0], sessionId)
  } catch {
    clock = undefined
  }
  try {
    const turn = clock?.turn()
    return typeof turn === 'number' && Number.isFinite(turn) && turn > 0 ? turn : undefined
  } catch {
    return undefined
  }
}

/** The pending entry for a session, never removing it and never throwing. */
export function peekPending(
  deps: SessionPlumbing,
  sessionId: string,
): PendingEntry | undefined {
  try {
    const queue = deps.queue
    if (queue == null || typeof queue.peek !== 'function') return undefined
    return queue.peek(sessionId)
  } catch {
    return undefined
  }
}

/** Drop the session's pending entry; a foreign queue must not break the call. */
export function clearPending(deps: SessionPlumbing, sessionId: string): void {
  try {
    const queue = deps.queue
    if (queue == null || typeof queue.clear !== 'function') return
    queue.clear(sessionId)
  } catch {
    // Containment only: a stale entry costs a false reject later, not this call.
  }
}

/** Drop the session's anchors; a foreign store must not break the call. */
export function clearAnchors(deps: SessionPlumbing, sessionId: string): void {
  try {
    deps.anchors?.clear(sessionId)
  } catch {
    // Containment only: the store is evidence, not a precondition.
  }
}

/** Drop the session's parsed plan; a foreign map must not break the call. */
export function clearPlan(deps: SessionPlumbing, sessionId: string): void {
  try {
    deps.plans?.delete(sessionId)
  } catch {
    // A foreign map can only cost a later decision.
  }
}

/** Append one receipt; a receipt is evidence, never a precondition. */
export async function appendReceipt(
  deps: SessionPlumbing,
  receipt: ReceiptInput,
): Promise<void> {
  const store = deps.receipts
  if (store == null || typeof store.append !== 'function') return
  try {
    await store.append(receipt)
  } catch {
    // A receipt is evidence, not a precondition: never break the call for it.
  }
}

/** The design's preview bound: 256 code points, never split a surrogate pair. */
const PREVIEW_CODE_POINTS = 256

/** The first 256 code points of a canonical receipt, or of a synthesized call. */
export function previewOf(text: string | undefined): string {
  return Array.from(text ?? '').slice(0, PREVIEW_CODE_POINTS).join('')
}

/**
 * The evidence line for a receipt that predates its tool result.
 *
 * A substitute or a refused dispatch has no canonical tool result yet, so its
 * preview names the call that is being made (or was refused): the operator's
 * question is "why did this call run?", and the name plus bound args is the
 * answer available at that point.
 */
export function callPreview(name: string, args: unknown): string {
  let encoded = ''
  try {
    encoded = JSON.stringify(args) ?? ''
  } catch {
    // A non-serialisable tree still leaves the tool name as evidence.
  }
  return previewOf(`${name} ${encoded}`.trim())
}
