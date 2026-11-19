/**
 * Projection execution: shadow accounting, and the outcome every mode reports.
 *
 * `projectShadow` is the half of projection that never changes what the model
 * sees: it decides whether a receipt *would* be cut, composes the replacement
 * string `projectApply` would produce, and prices both sides in tokens through
 * the caller's `estimate`. It writes nothing and reads no host service, so the
 * caller alone decides which mode to invoke (design §5.4).
 *
 * The projected size is composed here, not read off `Truncation.after`:
 * `after` is the head line plus the two windows *without* the omission note, so
 * it is only a lower bound on the final replacement. Shadow mode prices
 * `renderHeadLine + head + omission note + tail`; the note's locator part is
 * unknown before the spill write, so only the standardized omission clause is
 * included.
 *
 * Skip reasons are stable codes, never prose: `error-receipt` (an error receipt
 * is evidence and is never projected), `empty`, `no-params` (the family has no
 * window), and `not-worth-it` (`truncate`'s own guard said no).
 *
 * @module dsh-boost/projection/apply
 */
import type { BoostConfig, ProjectionParams, ToolFamily } from '../types.js'
import { renderHeadLine, truncate } from './truncate.js'
import type { Truncation } from './truncate.js'

/** Which projection behaviour the caller is running. */
export type ProjectionMode = 'off' | 'shadow' | 'on'

/** What projection did, or would have done, to one receipt. */
export interface ProjectionOutcome {
  kind: 'skipped' | 'shadow' | 'applied'
  /** Stable skip code; present only when `kind === 'skipped'`. */
  reason?: string
  /** Tokens in the original receipt; present only when `kind === 'shadow'`. */
  before?: number
  /** Tokens in the replacement shadow mode would have produced. */
  after?: number
  /** `before - after`. */
  saved?: number
}

/** The omission clause of the spill footer; the locator is unknown here. */
function omissionNote(omittedBytes: number): string {
  return `(Omitted ${omittedBytes} bytes.)`
}

/**
 * The replacement shadow mode prices: head line, head, omission note, tail.
 *
 * `projectApply` replaces the note with the persisted spill footer; because the
 * locator text is not known before that write, this is a lower bound.
 */
function projectedText(truncation: Truncation): string {
  return `${renderHeadLine(truncation)}\n${truncation.head}\n${omissionNote(truncation.omittedBytes)}\n${truncation.tail}`
}

/** Price the original and the replacement together, so the pair always agrees. */
function measure(
  original: string,
  replacement: string,
  estimate: (s: string) => number,
): Pick<ProjectionOutcome, 'before' | 'after' | 'saved'> {
  const before = estimate(original)
  const after = estimate(replacement)
  return { before, after, saved: before - after }
}

/**
 * Report what projection would save, without touching the receipt.
 *
 * Guards run in a fixed order: an error receipt is skipped before anything
 * else, so even an empty or oversized error keeps its evidence (design §5.4
 * contract 4); then empty text; then a family with no configured window; then
 * `truncate`'s own decision (trigger, 256 KiB cap, net-gain guard).
 */
export async function projectShadow(input: {
  /** Canonical receipt text, byte for byte as it would enter history. */
  text: string
  /** Whether the host marked the receipt as an error. */
  isError: boolean
  /** Projection family, which selects the window from `cfg`. */
  family: ToolFamily
  /** Resolved plugin configuration. */
  cfg: BoostConfig
  /** Token estimator injected by the caller (never imported from the host). */
  estimate: (s: string) => number
}): Promise<ProjectionOutcome> {
  const { text, isError, family, cfg, estimate } = input

  if (isError) return { kind: 'skipped', reason: 'error-receipt' }
  if (text === '') return { kind: 'skipped', reason: 'empty' }

  const params: ProjectionParams | undefined = cfg.projection[family]
  if (!params) return { kind: 'skipped', reason: 'no-params' }

  const truncation = truncate(text, params)
  if (truncation === null) return { kind: 'skipped', reason: 'not-worth-it' }

  return { kind: 'shadow', ...measure(text, projectedText(truncation), estimate) }
}
