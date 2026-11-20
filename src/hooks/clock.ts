/**
 * Turn clock: the host turn index and the host step index within that turn.
 *
 * A DSH turn is not one model request. `dsh-agent-loop` loops `step` and each
 * iteration calls `agent/request`, so a single turn contains many requests.
 * The clock therefore copies the host's turn number on every request and resets
 * its per-turn state only when that number changes: the first request of a turn
 * starts the turn, later requests in the same turn leave it alone. The host
 * supplies both numbers with each request; the clock never derives either from
 * a request count.
 *
 * The turn index is evidence (a receipt is keyed by `(session, turn)`) and the
 * host's **step index** (`step()`) is what a derived tool-call id is built
 * from: two substitutions of one candidate inside a turn must not share an id.
 * The per-turn substitution cap is not this class: it is `StepBudget`
 * (`admission/ledger.ts`), keyed per session by `SessionRuntime`. The
 * plugin-side counter below (`takeStep()`/`stepsThisTurn()`) is retained only
 * because the clock tests still pin the turn-rollover rule and the fact that
 * the counter cannot reach a call id (`test/protocol.test.ts`, obligation 1 in
 * `test/hooks-post.test.ts`); no production path calls it, and it must never
 * feed `stepId` or `callId`. Deleting it belongs to the change that also
 * deletes that coverage.
 *
 * The class is deliberately bare — no timers, no host calls, no I/O — so it is
 * testable without a host and cannot advance on wall time.
 *
 * One instance covers one session: two concurrent sessions sharing an instance
 * would mix their turn numbers. Per-session keying belongs to the caller
 * (`SessionRuntime` does it); this class does not guess a key. The turn index
 * is also clamped monotonic, so a reused instance can never move `turn()`
 * backwards.
 *
 * @module dsh-boost/hooks/clock
 */

/** Copies the host turn/step and keeps the retired plugin-side step count. */
export class TurnClock {
  /** Current host turn; 0 before the first request. */
  private turnCount = 0

  /**
   * Deprecated plugin-side step count.
   *
   * Not the host step and not the per-turn cap: `StepBudget` owns the cap and
   * `hostStep` owns step identity. Kept only for the turn-rollover coverage in
   * `test/protocol.test.ts`.
   */
  private steps = 0

  /**
   * The host's step index within the current turn; 0 before the first event.
   *
   * This is the host's number, never a plugin-side count. It exists because a
   * derived tool-call id must be unique per step: two substitutions of one
   * candidate inside one turn must not share an id, or the host persists two
   * assistant `tool_use` blocks with one id and Anthropic-style providers
   * reject the request. `stepsThisTurn()` is the retired plugin counter and
   * must never be used for this (design §5.3, T23a/T23b).
   */
  private hostStep = 0

  /**
   * Record one model request for `hostTurn`, optionally at `hostStep`.
   *
   * A new turn resets the host step index; another request in the same turn
   * leaves it alone. The host numbers are authoritative — they are copied,
   * never derived from a request count here.
   *
   * Non-finite turns are ignored: `NaN !== NaN`, so accepting one would set the
   * turn to `NaN` and reset state on every later request. Backwards turns are
   * ignored too, so a reused instance cannot make `turn()` decrease. The
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
   * @deprecated No production caller: the per-turn cap moved to `StepBudget`.
   * Never feed it to `stepId`/`callId`; `callIdFor` takes `step()`. Retained
   * only because the clock tests pin turn-rollover through it.
   */
  takeStep(): void {
    this.steps += 1
  }

  /**
   * The deprecated plugin-side count of steps in the current turn.
   *
   * @deprecated Not `step()` and not the substitution cap. The step budget is
   * `StepBudget` in `admission/ledger.ts`; this value has no production
   * consumer.
   */
  stepsThisTurn(): number {
    return this.steps
  }
}
