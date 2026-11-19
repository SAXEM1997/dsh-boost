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
 * from a request count. It also copies the host's **step index** within the
 * turn (`step()`): a derived tool-call id must be unique per step, and the
 * plugin-side `stepsThisTurn()` count is not the host's step. The class is
 * deliberately bare — no timers, no host calls, no I/O — so it is testable
 * without a host and cannot advance on wall time.
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
   * The host's step index within the current turn; 0 before the first event.
   *
   * This is the host's number, never a plugin-side count. It exists because a
   * derived tool-call id must be unique per step: two substitutions of one
   * candidate inside one turn must not share an id, or the host persists two
   * assistant `tool_use` blocks with one id and Anthropic-style providers
   * reject the request. `stepsThisTurn()` is the plugin's own substitution
   * counter and must never be used for this (design §5.3, T23a/T23b).
   */
  private hostStep = 0

  /**
   * Record one model request for `hostTurn`, optionally at `hostStep`.
   *
   * A new turn resets the step count and the host step index; another request
   * in the same turn leaves the count alone. The host numbers are
   * authoritative — they are copied, never derived from a request count here.
   *
   * Non-finite turns are ignored: `NaN !== NaN`, so accepting one would set the
   * turn to `NaN` and reset the step count on every later request, which is
   * exactly the per-request reset this clock exists to prevent. Backwards turns
   * are ignored too, so a reused instance cannot make `turn()` decrease. The
   * optional `hostStep` is ignored unless finite and greater than the current
   * one: the host's step index advances within a turn, and letting it move
   * backwards would let one step's call id be reused by the next.
   *
   * Called with the turn alone (the pre-`step()` signature), the step index
   * stays at whatever the host last reported — it is never incremented here,
   * because a plugin-side count is exactly what must not become a step number.
   */
  onModelRequest(hostTurn: number, hostStep?: number): void {
    const nextStep = typeof hostStep === 'number' && Number.isFinite(hostStep) ? hostStep : undefined
    if (!Number.isFinite(hostTurn) || hostTurn <= this.turnCount) {
      if (nextStep !== undefined && nextStep > this.hostStep) this.hostStep = nextStep
      return
    }
    this.turnCount = hostTurn
    this.steps = 0
    this.hostStep = nextStep !== undefined && nextStep >= 0 ? nextStep : 0
  }

  /** The current host turn; 0 before the first model request. */
  turn(): number {
    return this.turnCount
  }

  /** The host step index within the current turn; 0 before the first event. */
  step(): number {
    return this.hostStep
  }

  /**
   * Count one tool step in the current turn.
   *
   * @deprecated A plugin-side counter, not the host step. Never feed it to
   * `stepId`/`callId`: `callIdFor` takes `step()` (obligation 1). Retained for
   * Task 20's tests and older callers.
   */
  takeStep(): void {
    this.steps += 1
  }

  /**
   * Steps taken since the current turn began (or since construction).
   *
   * @deprecated The same substitution counter; it is not `step()` and must not
   * be used as the host step.
   */
  stepsThisTurn(): number {
    return this.steps
  }
}
