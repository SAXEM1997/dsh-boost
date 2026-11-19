/**
 * Receipt canonicalisation.
 *
 * The host hands a tool result's content to the plugin as an array of content
 * blocks; every later stage (binding, guards, projection, hashing) reasons
 * about one string. This module is the only place that array becomes that
 * string.
 *
 * Only `type === 'text'` blocks contribute, in input order, byte-faithfully:
 * no trim, no line-ending normalisation, no reordering, no separator. Text
 * blocks without a `text` value contribute nothing and are not counted in
 * `textBlocks`; other block kinds (image, file, …) are skipped entirely.
 *
 * The block array is untrusted at this boundary even though the host declares
 * `ContentBlock[]`: the host validates lossless JSON, not block shape, so a
 * third-party tool's renderer can hand over `null` or a non-object. Such a
 * block is skipped, never dereferenced, and a content value that is not an
 * array is an empty receipt. Throwing here would make the host replace the
 * tool's real output with a tool error — the exact evidence loss this module
 * exists to prevent.
 *
 * `empty` means "no text content" — it is true for an empty array and for
 * text blocks whose concatenation is the empty string, and it is independent
 * of `isError`.
 *
 * @module dsh-boost/projection/canonicalise
 */

/** The single string later stages consume, plus the facts they branch on. */
export interface CanonicalReceipt {
  /** Text blocks concatenated in order, byte-for-byte as received. */
  text: string
  /** Whether the host marked the tool result as an error. */
  isError: boolean
  /** `text.length === 0`; means "no text content", not "no blocks". */
  empty: boolean
  /** Number of text blocks that contributed to `text`, not `blocks.length`. */
  textBlocks: number
}

/** Project a tool result's content blocks onto one canonical string. */
export function canonicalise(
  blocks: ReadonlyArray<{ type: string; text?: string }>,
  isError: boolean,
): CanonicalReceipt {
  // A malformed renderer can hand over a non-array; that is an empty receipt,
  // not a crash on the way into history.
  const list: ReadonlyArray<unknown> = Array.isArray(blocks) ? blocks : []
  const textBlocks = list.filter(
    (block): block is { type: 'text'; text: string } =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      (block as { text?: unknown }).text !== undefined,
  )
  const text = textBlocks.map((block) => block.text).join('')
  return { text, isError, empty: text.length === 0, textBlocks: textBlocks.length }
}