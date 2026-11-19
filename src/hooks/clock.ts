/**
 * Turn clock: the turn index and the steps taken within the current turn.
 *
 * The plugin needs both numbers for evidence: a receipt is keyed by
 * `(session, turn)`, and the per-turn substitution cap counts tool steps. The
 * host does not hand the plugin a counter, so it is derived from the one event
 * that unmistakably starts a new turn: a model request. The first request of a
 * session makes it turn 1; before any request the clock reads turn 0.
 *
 * The class is deliberately bare — no timers, no host calls, no I/O. Callers
 * drive it (`onModelRequest` at the request boundary, `takeStep` when a tool
 * call is counted) and read it synchronously. That keeps the turn bookkeeping
 * testable without a host and prevents a clock that advances on wall time from
 * disagreeing with the turns the receipts were written under.
 *
 * @module dsh-boost/hooks/clock
 */

/** Counts model requests and tool steps within the current turn. */
export class TurnClock {
  /** Completed-turn count; the turn in progress is `turn()`. */
  private turnCount = 0

  /** Steps taken since the current turn began. */
  private steps = 0

  /**
   * Start a new turn: advance the index and zero the step count.
   *
   * Called once per model request, before the request is sent, so every step
   * the request produces belongs to the new turn.
   */
  onModelRequest(): void {
    this.turnCount += 1
    this.steps = 0
  }

  /** The current turn index; 0 before the first model request. */
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
