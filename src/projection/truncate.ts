/**
 * Receipt truncation: whether to cut, the two windows, and the head line.
 *
 * Lengths are counted in Unicode code points, never UTF-16 code units (design
 * §5.4): a CJK or emoji receipt must be cut at the same visual length as an
 * ASCII one, and slicing the code-point array is the only way never to split a
 * surrogate pair. `text.length` appears only as a cheap pre-filter — it is an
 * upper bound on the code-point count, so `text.length <= triggerChars` proves
 * that no cut is due.
 *
 * `truncate` returns `null` when a cut is not worth it: when the receipt does
 * not exceed the trigger, when its UTF-8 size exceeds the projection cap, or
 * when the rendered replacement would not be shorter than the original. Every
 * non-null result therefore satisfies `after.length < before.length`, which
 * the shadow-mode accounting relies on.
 *
 * @module dsh-boost/projection/truncate
 */
import type { ProjectionParams } from '../types.js'

/** Receipts above this many UTF-8 bytes are never projected (design §5.4). */
const MAX_PROJECTED_BYTES = 256 * 1024

/** The two windows plus the facts later stages report and account for. */
export interface Truncation {
  /** The original receipt text, byte for byte. */
  before: string
  /** The rendered replacement: head line, then head, then tail. */
  after: string
  /** First `headChars` code points of `before`. */
  head: string
  /** Last `tailChars` code points of `before`. */
  tail: string
  /** UTF-8 bytes of `before` that neither window carries. */
  omittedBytes: number
  /** `before` code points minus the two window sizes. */
  omittedCodePoints: number
  /**
   * Marker lines from the cut-away middle that must survive (design §5.4-4):
   * an exit code or error flag the reader would otherwise lose. Empty for the
   * overwhelming majority of receipts.
   */
  signals: string[]
}

/** Render the head line of a truncation, with `en-US` thousands separators. */
export function renderHeadLine(truncation: Truncation): string {
  return headLine(
    Array.from(truncation.before).length,
    Array.from(truncation.head).length,
    Array.from(truncation.tail).length,
  )
}

/** The one place the head line's literal format lives. */
function headLine(outputChars: number, firstChars: number, lastChars: number): string {
  return `[output ${outputChars.toLocaleString('en-US')} chars; showing first ${firstChars.toLocaleString('en-US')} and last ${lastChars.toLocaleString('en-US')}]`
}

/** The marker lines the design's §5.4-4 says must survive any projection. */
const PRESERVED_SIGNAL = /^(?:\[exit code: -?\d+\]|exit_code\s*[:=]\s*-?\d+|is_error\s*[:=]\s*(?:true|false))$/i

/**
 * Marker lines from the omitted middle, capped so a pathological receipt cannot
 * make the projection longer than what it replaced.
 */
function preservedSignals(middle: readonly string[]): string[] {
  if (middle.length === 0) return []
  const out: string[] = []
  for (const line of middle.join('').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || !PRESERVED_SIGNAL.test(trimmed)) continue
    if (out.includes(trimmed)) continue
    out.push(trimmed)
    if (out.length === 8) break
  }
  return out
}

/** Cut `text` down to its head and tail windows, or `null` when that is not worth it. */
export function truncate(text: string, params: ProjectionParams): Truncation | null {
  // UTF-16 length upper-bounds the code-point count: when it does not exceed
  // the trigger, neither can the real count.
  if (text.length <= params.triggerChars) return null

  // Large receipts are not projected at all. The design's 256 KiB is a byte
  // budget, so measure UTF-8 bytes rather than UTF-16 units — otherwise CJK
  // and emoji receipts would overflow the budget by 2–4×.
  const beforeBytes = Buffer.byteLength(text, 'utf8')
  if (beforeBytes > MAX_PROJECTED_BYTES) return null

  const codePoints = Array.from(text)
  if (codePoints.length <= params.triggerChars) return null

  // Slicing the code-point array cannot split a surrogate pair; string
  // indexing could.
  const head = codePoints.slice(0, params.headChars).join('')
  // `slice(-0)` is `slice(0)`, i.e. the whole text: a configured zero tail must
  // be no tail, not a duplicate of the receipt (review row 69).
  const tail = params.tailChars === 0 ? '' : codePoints.slice(-params.tailChars).join('')
  const omittedCodePoints = codePoints.length - params.headChars - params.tailChars
  const omittedBytes = beforeBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8')

  // Signals a reader must never lose, even when they sit in the middle that the
  // two windows cut away: an error flag, an exit code, the `[exit code: N]`
  // suffix the tool executor appends (design §5.4-4). They are re-emitted after
  // the tail so the projection stays append-only from the reader's view.
  const preserved = preservedSignals(codePoints.slice(params.headChars, codePoints.length - params.tailChars))

  // The replacement this layer can render: the head line plus the two windows.
  // The apply stage inserts the spill footer between the windows; that footer is
  // not known here, so this is a lower bound on the final projected length.
  const header = headLine(codePoints.length, Array.from(head).length, Array.from(tail).length)
  const signals = preserved.length === 0 ? '' : `\n${preserved.join('\n')}`
  const after = `${header}\n${head}\n${tail}${signals}`
  // A cut that would not shrink the receipt (misconfigured windows, or windows
  // that together swallow the whole text) is not worth taking; fall back to the
  // original rather than throwing on unvalidated config.
  if (after.length >= text.length) return null

  return { before: text, after, head, tail, omittedBytes, omittedCodePoints, signals: preserved }
}
