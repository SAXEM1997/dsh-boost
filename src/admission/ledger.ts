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
 * - `historyTurns` is floored once, and that same N gates both the short-
 *   history check and the window, so `2.5` with two entries averages them.
 *   A floored `historyTurns <= 0` has no window to average, so it takes the
 *   horizon path; the literal mean branch would divide by zero.
 * - a non-finite `horizonSteps` (`NaN` or `Infinity`) degrades to `0`
 *   (fail-closed).
 * - a non-finite mean (a `NaN` or `Infinity` in the window) falls back to the
 *   horizon.
 *
 * The return is a raw estimate, not a sanitised count: a finite `horizonSteps`
 * is passed through unclamped, so a fractional (`20.5`) or negative (`-1`)
 * horizon — and a negative mean — reach the caller as-is. Callers must not
 * assume a non-negative integer; `0` means zero remaining steps.
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
 * can never exceed it. A non-finite max — including `Infinity`, whose literal
 * reading would be "unlimited" — is also an empty budget: fail-closed, and
 * unreachable through `resolveConfig`, which keeps only finite numbers.
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
