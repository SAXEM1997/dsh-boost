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
  const textBlocks = blocks.filter(
    (block): block is { type: 'text'; text: string } => block.type === 'text' && block.text !== undefined,
  )
  const text = textBlocks.map((block) => block.text).join('')
  return { text, isError, empty: text.length === 0, textBlocks: textBlocks.length }
}