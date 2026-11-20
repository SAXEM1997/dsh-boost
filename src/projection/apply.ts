/**
 * Projection execution: the shadow accounting and the real replacement.
 *
 * `projectShadow` is the half of projection that never changes what the model
 * sees: it decides whether a receipt *would* be cut, composes the replacement
 * string `projectApply` would produce, and prices both sides in tokens through
 * the caller's `estimate`. It writes nothing and reads no host service, so the
 * caller alone decides which mode to invoke (design §5.4).
 *
 * `projectApply` is the half that replaces, and it only replaces what is still
 * recoverable: the canonical receipt is persisted through the injected spill
 * backend first, then head line, head, spill footer and tail are composed. All
 * guards run before the write, a failed write or footer is a skip rather than
 * an exception, and a footer that would grow the receipt sends the original
 * back unchanged — a projection that grows a receipt defeats the plugin's
 * premise.
 *
 * The projected size is composed here, not read off `Truncation.after`:
 * `after` is the head line plus the two windows *without* the omission note, so
 * it is only a lower bound on the final replacement. Shadow mode prices
 * `renderHeadLine + head + omission note + tail`; the note's locator part is
 * unknown before the spill write, so only the standardized omission clause is
 * included.
 *
 * Skip reasons are stable codes, never prose: `error-receipt` (an error receipt
 * is evidence and is never projected), `family-not-configured` (the family has
 * no window), `not-worth-it` (`truncate`'s guard said no, or the footer left no
 * net gain), `empty` (shadow's empty receipt), and on the apply half
 * `no-spill`, `no-owner`, `projection-skipped:no-footer`, `spill-failed`, and
 * `footer-failed`.
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
  /**
   * Tokens in the original receipt.
   *
   * Present only when `kind === 'shadow'` and the estimator priced both
   * sides; absent (with `estimate: 'unknown'` on the receipt) when it did not.
   */
  before?: number
  /** Tokens in the replacement shadow mode would have produced. */
  after?: number
  /** `before - after`. */
  saved?: number
  /**
   * UTF-8 bytes the replacement omits; present only when `kind === 'applied'`.
   *
   * Apply mode has no token estimator: the caller (T23b) prices both texts
   * itself, and these two fields are the projection's own accounting.
   */
  omittedBytes?: number
  /** Unicode code points the replacement omits; applied outcomes only. */
  omittedCodePoints?: number
  /**
   * The persisted artifact's locator; applied outcomes only.
   *
   * It is the path the footer tells the model to read, and the retrieval ledger
   * matches later `read`/`grep` arguments against it (Task 25).
   */
  locator?: string
}

/** A persisted spill artifact's model-facing handle. */
export interface SpillHandle {
  /** Opaque locator the model can `read` or `grep`; never parsed here. */
  locator: string
  /** How to retrieve the artifact, as guidance for the model. */
  retrievalHint: string
}

/**
 * The host spill store, narrowed to the one method projection needs.
 *
 * `callId` and `label` are required because the host's `SaveTextSpill` requires
 * them; `projectApply` fills them in before calling. `saveText` rejects on a
 * real storage failure, and that rejection is handled as a skip.
 */
export interface SpillBackend {
  saveText(input: {
    owner: { sessionId: string }
    source: { kind: 'tool'; toolName: string; callId: string; label: string }
    suggestedName: string
    content: string
  }): Promise<SpillHandle>
}

/**
 * Render the footer that names what was omitted and where the original lives.
 *
 * Injected by the caller, which dynamically imports the host's
 * `formatSpillNotice`; this module must never statically import
 * `@deepseek-ai/dsh-spill-policy` — it is an optional peer, and a static import
 * would make the degradation path unreachable (design §5.4).
 */
export type FormatFooter = (omitted: { kind: 'exact'; count: number }, ref: SpillHandle) => string

/** Everything one apply decision reads; every host service arrives pre-bound. */
export interface ProjectApplyInput {
  /** Canonical receipt text, byte for byte as it would enter history. */
  text: string
  /** Whether the host marked the receipt as an error. */
  isError: boolean
  /** Projection family, which selects the window from `cfg`. */
  family: ToolFamily
  /** Resolved plugin configuration. */
  cfg: BoostConfig
  /** Owning session; without one the spill has no owner and projection stops. */
  sessionId: string | undefined
  /** Tool name, recorded on the spill source and used for its file name. */
  toolName: string
  /** Model-issued call id; defaults to `toolName`. */
  callId?: string
  /** Human label for the artifact; defaults to `family`. */
  label?: string
  /** Spill backend, absent when the host has none (projection then stops). */
  spill: SpillBackend | undefined
  /** Footer renderer, absent when the host spill policy package is not installed. */
  formatFooter: FormatFooter | undefined
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
): Pick<ProjectionOutcome, 'before' | 'after' | 'saved'> | undefined {
  const before = estimate(original)
  const after = estimate(replacement)
  // A non-finite estimate is an unknown, never a number to serialise: JSON
  // would turn NaN into `null`, which looks like a measured zero in the
  // shadow account. The caller writes `estimate: 'unknown'` instead.
  if (!Number.isFinite(before) || !Number.isFinite(after)) return undefined
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
  if (!params) return { kind: 'skipped', reason: 'family-not-configured' }

  const truncation = truncate(text, params)
  if (truncation === null) return { kind: 'skipped', reason: 'not-worth-it' }

  const measured = measure(text, projectedText(truncation), estimate)
  return measured === undefined ? { kind: 'shadow' } : { kind: 'shadow', ...measured }
}

/** The prechecks that passed, with the host pieces narrowed to their present values. */
interface Ready {
  truncation: Truncation
  owner: { sessionId: string }
  spill: SpillBackend
  formatFooter: FormatFooter
}

/**
 * Decide whether the receipt may be replaced, in the plan's fixed order.
 *
 * Every guard returns the intact receipt and a stable code: an error receipt
 * first (it is evidence, design §5.4 contract 4); then a family with no window;
 * then `truncate`'s decision — calling it once is the same decision
 * `shouldTruncate` exposes, without cutting twice; then the host pieces that
 * would make the footer a lie: no backend, no owner, no footer renderer. None
 * of these writes anything.
 */
function precheck(input: ProjectApplyInput): { skip: ProjectionOutcome } | Ready {
  const { text, isError, family, cfg, sessionId, spill, formatFooter } = input

  if (isError) return { skip: { kind: 'skipped', reason: 'error-receipt' } }

  const params: ProjectionParams | undefined = cfg.projection[family]
  if (!params) return { skip: { kind: 'skipped', reason: 'family-not-configured' } }

  const truncation = truncate(text, params)
  if (truncation === null) return { skip: { kind: 'skipped' } }

  if (!spill) return { skip: { kind: 'skipped', reason: 'no-spill' } }
  if (!sessionId) return { skip: { kind: 'skipped', reason: 'no-owner' } }
  if (!formatFooter) return { skip: { kind: 'skipped', reason: 'projection-skipped:no-footer' } }

  return { truncation, owner: { sessionId }, spill, formatFooter }
}

/**
 * Replace an oversized receipt with its head, tail, and a way back to the rest.
 *
 * The canonical original is spilled *before* anything is replaced — never the
 * projection, which would make the footer point at an artifact that does not
 * contain what it promises. The footer sits on its own line between the two
 * windows, and the composed replacement is re-checked against the original:
 * at the trigger boundary a long locator can make the "projection" longer than
 * the receipt it replaces, and a projection that grows a receipt is worse than
 * none.
 *
 * A spill or footer failure is swallowed and reported as `spill-failed` /
 * `footer-failed`; the caller's `post-execute` hook must never see an exception
 * from here. The footer must be guarded too: the host turns a throwing
 * `post-execute` listener into an `isError` result, which would lose the very
 * output this module exists to preserve.
 */
export async function projectApply(
  input: ProjectApplyInput,
): Promise<{ content: string; outcome: ProjectionOutcome }> {
  const ready = precheck(input)
  if ('skip' in ready) return { content: input.text, outcome: ready.skip }

  const { text, family, toolName, callId, label } = input
  const { truncation, owner, spill, formatFooter } = ready

  // One guard covers both host calls: `saveText` and the footer renderer. The
  // marker tells the two failures apart, because status counts distinguish
  // them — and neither may reach the caller as an exception.
  let phase: 'spill' | 'footer' = 'spill'
  try {
    const ref = await spill.saveText({
      owner,
      source: { kind: 'tool', toolName, callId: callId ?? toolName, label: label ?? family },
      suggestedName: `${toolName}.txt`,
      content: text,
    })
    phase = 'footer'

    const footer = formatFooter({ kind: 'exact', count: truncation.omittedBytes }, ref)
    const assembled = `${renderHeadLine(truncation)}\n${truncation.head}\n${footer}\n${truncation.tail}`

    // The footer is only known after the write, so this check can only run now.
    // The backend exposes no delete: a spill that reaches this point stays in
    // the store, unreferenced, while the model gets the original content back.
    if (assembled.length >= text.length) {
      return { content: text, outcome: { kind: 'skipped', reason: 'not-worth-it' } }
    }

    return {
      content: assembled,
      outcome: {
        kind: 'applied',
        omittedBytes: truncation.omittedBytes,
        omittedCodePoints: truncation.omittedCodePoints,
        locator: ref.locator,
      },
    }
  } catch {
    return {
      content: text,
      outcome: { kind: 'skipped', reason: phase === 'spill' ? 'spill-failed' : 'footer-failed' },
    }
  }
}
