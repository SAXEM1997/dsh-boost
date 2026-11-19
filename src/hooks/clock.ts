/**
 * Turn clock: the host turn index and the steps taken within that turn.
 *
 * A DSH turn is not one model request. `dsh-agent-loop` loops `step` and each
 * iteration calls `agent/request`, so a single turn contains many requests.
 * The clock therefore takes the host's turn number on every request and resets
 * the step count only when that number changes: the first request of a turn
 * starts the count, later requests in the same turn keep it. Counting requests
 * instead would make `stepsThisTurn()` never exceed 1 and silently disable the
 * per-turn substitution cap.
 *
 * The plugin still needs the turn index for evidence (a receipt is keyed by
 * `(session, turn)`) and the per-turn step count for the cap. The host supplies
 * the turn number with each request; the clock copies it, never deriving one
 * from a request count. The class is deliberately bare — no timers, no host
 * calls, no I/O — so it is testable without a host and cannot advance on wall
 * time.
 *
 * One instance covers one session: two concurrent sessions sharing an instance
 * would mix their turn numbers and step counts. Per-session keying belongs to
 * the caller (T23c wires it); this class does not guess a key. The turn index
 * is also clamped monotonic, so a reused instance can never move `turn()`
 * backwards.
 *
 * @module dsh-boost/hooks/clock
 */

/** Counts model requests within the host turn and tool steps per turn. */
export class TurnClock {
  /** Current host turn; 0 before the first request. */
  private turnCount = 0

  /** Steps taken since the current turn began. */
  private steps = 0

  /**
   * Record one model request for `hostTurn`.
   *
   * A new turn resets the step count; another request in the same turn leaves
   * it alone. The host number is authoritative — it is copied, never derived
   * from a request count here.
   *
   * Non-finite numbers are ignored: `NaN !== NaN`, so accepting one would set
   * the turn to `NaN` and reset the step count on every later request, which
   * is exactly the per-request reset this clock exists to prevent. Backwards
   * turns are ignored too, so a reused instance cannot make `turn()` decrease.
   */
  onModelRequest(hostTurn: number): void {
    if (!Number.isFinite(hostTurn) || hostTurn <= this.turnCount) return
    this.turnCount = hostTurn
    this.steps = 0
  }

  /** The current host turn; 0 before the first model request. */
  turn(): number {
    return this.turnCount
  }

  /** Count one tool step in the current turn. */
  takeStep(): void {
    this.steps += 1
  }

  /** Steps taken since the current turn began (or since construction). */
  stepsThisTurn(): number {
    return this.steps
  }
}
