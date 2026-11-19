/**
 * `$public` argument binding: the anti-forgery core of the gate.
 *
 * A plan is written by the model with literal arguments, except for values that
 * only exist after an earlier step has run. Those are written as a template
 * `{ "$public": { "after": "A", "field": "name" } }`, and this module fills the
 * template in from the named receipt. The point is mechanical projection: a
 * value that the model reads and then re-types can be steered by whatever the
 * value contains, so the value is copied from the receipt text instead of being
 * reproduced by the model.
 *
 * Uniqueness is the whole safety rule. A field is usable only when it appears
 * exactly once, as a quoted string, on its own line (`name: "v"` / `name="v"`);
 * zero matches, two matches, or an unquoted right-hand side are all
 * `ambiguous`, and ambiguity means the slow path — never a guess. `$scalar`
 * and `$single` are whole-text forms, so they are unique by construction.
 *
 * Failures are values, never throws, and the order is fixed: a missing graph
 * node is `unresolvable`, an errored or empty receipt is `missing-receipt`, a
 * receipt that is not exactly one text block is `not-single-text`, and a
 * non-unique projection is `ambiguous`.
 *
 * Two containers fail closed. The root `args` object can never be a template
 * (`unresolvable`): a template replaces one value with a scalar, and an
 * argument object is not a scalar. Any other object that carries a `$public`
 * key but is not a well-formed template — extra keys alongside it, a
 * non-object value, extra keys inside it — is also `unresolvable`, so a
 * malformed template never reaches the host as a literal `$public` argument.
 * `field` is model-controlled, so it is regex-escaped, must be non-empty, and
 * may only start with `$` when it is exactly `$scalar` or `$single`.
 *
 * `textBlocks` (not `blocks.length`) decides `not-single-text`, because only
 * text blocks contribute to `text`. `empty` is defined by `canonicalise` as
 * `text.length === 0`; a receipt that contradicts that invariant (empty text
 * with `empty: false`) is treated as `missing-receipt` rather than projected,
 * since there is no text to project from and the contradiction is a producer
 * bug, not something to guess around.
 *
 * `args` comes from `JSON.parse`, so it is acyclic and already depth-capped by
 * plan parsing. Binding returns a fresh tree and never mutates its input.
 *
 * @module dsh-boost/gate/binding
 */

import type { CanonicalReceipt } from '../projection/canonicalise.js'

/** The one well-formed template: a single `$public` key with two string fields. */
export type PublicTemplate = { $public: { after: 'root' | string; field: string } }

/** Why a value could not be projected; every one is a fallback to the model. */
type BindFailure = 'ambiguous' | 'unresolvable' | 'missing-receipt' | 'not-single-text'

/** A successful binding or the single reason it was abandoned. */
type BindResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: BindFailure }

/** Either a bound value or the reason the whole tree is abandoned. */
type Bound = { value: unknown } | { reason: BindFailure }

/** JSON object, not `null` and not an array. */
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Escape a model-controlled string for literal use in a `RegExp`.
 *
 * `field` is data, not syntax: `a.*` must match the four characters `a.*` and
 * not act as a pattern.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `$scalar`: the whole trimmed text is one bare scalar token. */
const SCALAR = /^[A-Za-z0-9_+@.:/-]+$/

/** `$single`: the whole trimmed text is a one-element single-quoted array. */
const SINGLE = /^\['([^']*)'\]$/

/**
 * The identifier form: `field: "value"` or `field="value"` on its own line.
 *
 * A line boundary is LF, CR or CRLF. Anchoring on `\n` alone would let a bare
 * `\r` separate a second assignment that the uniqueness count never sees; the
 * leading `\s*` consumes the paired character of a CRLF, so each occurrence is
 * still found exactly once.
 */
function identifierPattern(field: string): RegExp {
  return new RegExp('(?:^|[\\r\\n])\\s*' + escapeRegExp(field) + '\\s*[:=]\\s*"([^"\\n]+)"', 'g')
}

/** Whole-text bare scalar; no spaces, quotes or newlines survive the match. */
function scalarField(text: string): string | undefined {
  const value = text.trim()
  return SCALAR.test(value) ? value : undefined
}

/** Whole-text single-element string array. */
function singleField(text: string): string | undefined {
  const match = SINGLE.exec(text.trim())
  return match === null ? undefined : match[1]
}

/**
 * One `field: "value"` line, exactly once.
 *
 * The right-hand side must be double-quoted, so `name=abc` yields no match and
 * therefore abstains. Zero and two-plus matches both abstain: uniqueness is
 * the entire defence against a crafted receipt that carries a second, fake
 * value on another line.
 */
function identifierField(text: string, field: string): string | undefined {
  const matches = [...text.matchAll(identifierPattern(field))]
  return matches.length === 1 ? matches[0][1] : undefined
}

/**
 * Project one field out of a receipt's canonical text.
 *
 * `undefined` always means "cannot use this"; callers turn it into `ambiguous`.
 * Empty fields and unknown `$`-prefixed fields are rejected before touching the
 * text, and identifier fields are matched literally.
 */
export function extractField(text: string, field: string): string | undefined {
  if (typeof text !== 'string' || typeof field !== 'string' || field.length === 0) return undefined
  if (field.startsWith('$')) {
    if (field === '$scalar') return scalarField(text)
    if (field === '$single') return singleField(text)
    return undefined
  }
  return identifierField(text, field)
}

/**
 * Whether `value` is the sanctioned template shape, and nothing else.
 *
 * A plain object with exactly one own key, `$public`, whose value is an object
 * with exactly the two string keys `after` and `field`. Extra keys on either
 * level are rejected rather than silently dropped: this module only understands
 * `after`/`field`, and a template with a third directive is not something the
 * host may receive.
 */
export function isTemplate(value: unknown): value is PublicTemplate {
  if (!object(value)) return false
  const outerKeys = Object.keys(value)
  if (outerKeys.length !== 1 || outerKeys[0] !== '$public') return false
  const inner = value.$public
  if (!object(inner)) return false
  const innerKeys = Object.keys(inner)
  if (innerKeys.length !== 2 || !innerKeys.includes('after') || !innerKeys.includes('field')) return false
  return typeof inner.after === 'string' && typeof inner.field === 'string'
}

/**
 * Project one template's value from the receipts named by `after`.
 *
 * Check order is part of the contract: an absent graph node is `unresolvable`;
 * then an errored/empty receipt is `missing-receipt`; then a receipt that is
 * not exactly one text block is `not-single-text`; only then can projection
 * fail as `ambiguous`.
 */
function resolveTemplate(
  template: PublicTemplate,
  receipts: ReadonlyMap<string, CanonicalReceipt>,
): Bound {
  const { after, field } = template.$public
  const receipt = receipts.get(after)
  if (receipt === undefined) return { reason: 'unresolvable' }
  if (receipt.isError || receipt.empty || receipt.text.length === 0) return { reason: 'missing-receipt' }
  if (receipt.textBlocks !== 1) return { reason: 'not-single-text' }
  const value = extractField(receipt.text, field)
  if (value === undefined) return { reason: 'ambiguous' }
  return { value }
}

/**
 * Bind one value: a template becomes a scalar, containers are rebuilt
 * recursively, everything else is copied through unchanged.
 *
 * `Object.fromEntries` (rather than assignment) keeps an own `__proto__` key a
 * data property, so rebuilding a hostile tree cannot pollute a prototype.
 */
function bindValue(value: unknown, receipts: ReadonlyMap<string, CanonicalReceipt>): Bound {
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const item of value) {
      const bound = bindValue(item, receipts)
      if ('reason' in bound) return bound
      items.push(bound.value)
    }
    return { value: items }
  }

  if (object(value)) {
    if (Object.hasOwn(value, '$public')) {
      if (!isTemplate(value)) return { reason: 'unresolvable' }
      return resolveTemplate(value, receipts)
    }
    const entries: Array<[string, unknown]> = []
    for (const [key, child] of Object.entries(value)) {
      const bound = bindValue(child, receipts)
      if ('reason' in bound) return bound
      entries.push([key, bound.value])
    }
    return { value: Object.fromEntries(entries) }
  }

  return { value }
}

/**
 * Bind every `$public` template in `args` against the receipts of earlier
 * steps.
 *
 * The root object is checked separately and can never be a template: it is an
 * argument object, while a template produces a scalar. The same check rejects a
 * root that merely carries a `$public` key alongside other keys.
 *
 * Returns a fresh `args` tree on success, or one reason the whole plan must
 * fall back to the model. There is no partial result and no mutation.
 */
export function bindArgs(
  args: Record<string, unknown>,
  receipts: ReadonlyMap<string, CanonicalReceipt>,
): BindResult {
  if (Object.hasOwn(args, '$public')) return { ok: false, reason: 'unresolvable' }
  const bound = bindValue(args, receipts)
  if ('reason' in bound) return { ok: false, reason: bound.reason }
  return { ok: true, args: bound.value as Record<string, unknown> }
}