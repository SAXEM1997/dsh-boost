/**
 * Admission arithmetic: is a substitution worth its overhead, and how many
 * steps may the current turn still take?
 *
 * Both are pure arithmetic. This module performs no I/O, reads no config and
 * keeps no time window; callers pass the resolved `BoostConfig` values in
 * (design §5.3). The only mutable state is `StepBudget`, whose lifetime is the
 * plugin's — hence `reset()` at every turn start is mandatory.
 *
 * @module dsh-boost/admission/ledger
 */

/**
 * Conservative bound on the steps left in this turn (design §5.3).
 *
 * Fewer than `historyTurns` sizes in `stepsSoFar` means there is no usable
 * mean: the horizon is returned verbatim, never an estimate from a short
 * history. Otherwise this is
 * `Math.min(horizonSteps, Math.round(mean(last historyTurns)))`.
 *
 * Degenerate inputs are defined and never NaN:
 * - `historyTurns <= 0` has no window to average, so it takes the horizon
 *   path; the literal mean branch would divide by zero. Fractions floor.
 * - a non-finite `horizonSteps` degrades to `0` (fail-closed).
 * - a non-finite mean (for example a NaN in the window) falls back to the
 *   horizon.
 *
 * `horizonSteps: 0` therefore means zero remaining steps.
 */
export function remainingSteps(input: {
  stepsSoFar: number[]
  horizonSteps: number
  historyTurns: number
}): number {
  const { stepsSoFar, horizonSteps, historyTurns } = input
  const horizon = Number.isFinite(horizonSteps) ? horizonSteps : 0
  const turns = Number.isFinite(historyTurns) ? Math.floor(historyTurns) : 0
  if (turns <= 0 || stepsSoFar.length < turns) return horizon

  const window = stepsSoFar.slice(-turns)
  const mean = window.reduce((sum, n) => sum + n, 0) / window.length
  return Number.isFinite(mean) ? Math.min(horizon, Math.round(mean)) : horizon
}

/**
 * Admission gate for one candidate (design §5.3).
 *
 * A deterministic single candidate has no selector call and no plan to pay
 * for, so it skips the threshold entirely. Everything else must clear the
 * threshold strictly: breaking even is not a win.
 */
export function worthSubstituting(input: {
  savedTokens: number
  overheadTokens: number
  thresholdTokens: number
  deterministicSingle: boolean
}): boolean {
  const { savedTokens, overheadTokens, thresholdTokens, deterministicSingle } = input
  return deterministicSingle || savedTokens - overheadTokens > thresholdTokens
}

/**
 * Per-turn substitution budget (default 8, design §5.2-6).
 *
 * The plugin owns one instance for its whole lifetime, so calling `reset()` at
 * turn start is mandatory: without it the budget would be spent once and then
 * silently disable substitution for the rest of the process.
 *
 * A non-positive `max` is an empty budget — `take()` always returns `false`
 * and `exhausted()` is already `true`. A fractional max floors, so `count()`
 * can never exceed it; a non-finite max is treated as empty.
 */
export class StepBudget {
  private readonly max: number
  private taken = 0

  constructor(max: number) {
    this.max = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0
  }

  /** Claim one step; false without incrementing once the budget is spent. */
  take(): boolean {
    if (this.taken >= this.max) return false
    this.taken += 1
    return true
  }

  /** Start a new turn: the budget is per-turn, not per-plugin-lifetime. */
  reset(): void {
    this.taken = 0
  }

  /** True when no further `take()` can succeed. */
  exhausted(): boolean {
    return this.taken >= this.max
  }

  /** Steps taken since construction or the last `reset()`. */
  count(): number {
    return this.taken
  }
}
