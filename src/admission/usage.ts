/**
 * Usage pairing: turn two consecutive model requests into the measured saving
 * of one substitution (design §5.3).
 *
 * When the plugin substitutes a call, the model is not asked for that step, so
 * the next real request replays a shorter history. The saving is therefore
 * measured as the size of that next request — `input + cacheRead`, because the
 * host reports `inputTokens` excluding cache reads — never estimated. A missing
 * next request is `'unknown'`; an interpolated number would be indistinguishable
 * from a measurement once written to a receipt.
 *
 * The ledger keeps two request slots plus a mark: `latest`, the first request
 * after the mark, and the mark itself — which holds the request that preceded
 * it and the candidate id. No whole-history table (YAGNI). Pure arithmetic: no
 * timers, no I/O, no host calls.
 *
 * @module dsh-boost/admission/usage
 */

/** One model request's raw counts, mapped from the `llm/stream` usage chunk. */
export interface Usage {
  input: number
  cacheRead: number
  output: number
}

/**
 * A sample is usable only when all three counts are finite and non-negative
 * and their input total does not overflow. A negative or non-finite count is a
 * protocol violation, and any arithmetic on it would invent `NaN` or
 * `Infinity` — a bogus number no receipt reader could tell from a measurement.
 * An unusable after-mark sample makes the whole settlement unusable; an
 * unusable pre-mark sample only loses the delta.
 */
function usable(u: Usage): boolean {
  return (
    [u.input, u.cacheRead, u.output].every((n) => Number.isFinite(n) && n >= 0) &&
    Number.isFinite(u.input + u.cacheRead)
  )
}

/**
 * Cache hit rate of one request, `cacheRead / (input + cacheRead)`. `null`
 * when the rate cannot be told: no sample, an unusable sample, or a
 * non-positive denominator. Both sides of the delta go through this one
 * helper so they cannot drift.
 */
function hitRate(u: Usage | undefined): number | null {
  if (u === undefined || !usable(u)) return null
  const denominator = u.input + u.cacheRead
  if (denominator <= 0) return null
  const rate = u.cacheRead / denominator
  return Number.isFinite(rate) ? rate : null
}

/**
 * Pairs two consecutive model requests around one substitution.
 *
 * The pairing target is the FIRST request after the mark, never the latest:
 * when a caller forgets to settle, a later unrelated request must not be
 * attributed to the substitution. `settle()` consumes the mark and clears the
 * pairing slots; `last()` is a pure reader and survives it.
 */
export class UsageLedger {
  private latest: Usage | undefined
  private hasMark = false
  private beforeMark: Usage | undefined
  private afterMark: Usage | undefined
  private candidateId: string | undefined

  /**
   * Record one real request. The first request after a mark claims the pairing
   * slot and keeps it; later requests only advance `last()`.
   */
  request(u: Usage): void {
    this.latest = u
    if (this.hasMark && this.afterMark === undefined) this.afterMark = u
  }

  /** Most recent request, or `undefined` before the first one. Never consumes. */
  last(): Usage | undefined {
    return this.latest
  }

  /**
   * Record that a substitution just happened.
   *
   * `candidateId` is kept only so the caller can pair `settle()` with the right
   * substitution receipt (`pendingCandidateId()`); it never changes the
   * arithmetic. A new mark discards any unconsumed pairing and starts over from
   * the current latest request.
   */
  markSubstituted(candidateId: string): void {
    this.hasMark = true
    this.beforeMark = this.latest
    this.afterMark = undefined
    this.candidateId = candidateId
  }

  /** Id of the pending mark, or `undefined` before a mark and after `settle()`. */
  pendingCandidateId(): string | undefined {
    return this.candidateId
  }

  /**
   * Consume the mark and report the substitution's measured cost.
   *
   * `saved_input_tokens` is the first after-mark request's `input + cacheRead`;
   * `output_tokens` is that request's `output`, a third count that is never
   * folded into input. Both are `'unknown'` when no usable request arrived after
   * the mark — never a copy of the previous request's numbers. `cache_hit_delta`
   * is the after-mark hit rate minus the pre-mark hit rate, `null` when either
   * side cannot be told (a `null` delta means "cannot tell", not zero).
   *
   * A second `settle()` has nothing left to consume and reports the same
   * `'unknown'` / `null`.
   */
  settle(): {
    saved_input_tokens: number | 'unknown'
    cache_hit_delta: number | null
    output_tokens: number | 'unknown'
  } {
    const after = this.hasMark ? this.afterMark : undefined
    const before = this.hasMark ? this.beforeMark : undefined
    this.hasMark = false
    this.beforeMark = undefined
    this.afterMark = undefined
    this.candidateId = undefined

    if (after === undefined || !usable(after)) {
      return { saved_input_tokens: 'unknown', cache_hit_delta: null, output_tokens: 'unknown' }
    }

    const afterRate = hitRate(after)
    const beforeRate = hitRate(before)
    const delta = afterRate !== null && beforeRate !== null ? afterRate - beforeRate : null

    return {
      saved_input_tokens: after.input + after.cacheRead,
      cache_hit_delta: delta !== null && Number.isFinite(delta) ? delta : null,
      output_tokens: after.output,
    }
  }
}