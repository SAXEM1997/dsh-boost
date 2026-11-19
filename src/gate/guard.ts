/**
 * Guard evaluation: the zero-token admission check on a receipt.
 *
 * A guard is a predicate over the canonical receipt a call produced. It is the
 * only verification the fast path gets, so the rule is fail-closed: every
 * ambiguity — a pointer that is not RFC 6901, a segment that cannot name an
 * array element, a path that runs into a scalar, a value of the wrong type —
 * is `fail`, never `pass`, and no path throws.
 *
 * `ok` is the trivial form and reads only `isError`, never the text.
 * `text_contains` / `text_not_contains` are byte-faithful, case-sensitive
 * `String#includes` checks on the canonical text: no trim, no normalisation,
 * no regex.
 *
 * `json_equals` parses the whole text as JSON and walks the pointer by hand.
 * A pointer is `''` (the whole document) or starts with `/`; anything else is
 * malformed. Resolution follows only own properties (`Object.hasOwn`), so
 * `/__proto__` and `/constructor` cannot read an inherited value. An array
 * accepts only canonical decimal indices (`0`, `12` — not `01`, `1.0`, `-`,
 * ` 1` or `+1`) that are inside its length, and a segment applied to a
 * non-container fails. Escapes are RFC 6901: `~1` is `/` and `~0` is `~`
 * (`~01` is therefore the literal `~1`), and any other `~` sequence is
 * malformed even when the raw segment is a real key.
 *
 * Comparison is `===`, deliberately not `==`: `1` is not `'1'`, and `true` is
 * not `1`. JSON cannot produce `NaN`, and `null`, arrays and objects can never
 * equal a `string | number | boolean`, so a resolved value of one of those
 * kinds fails. A JSON parse error is a `fail` value, not an exception.
 *
 * `GuardResult` includes `'unknown'` because the task interface names it, but
 * no v1 guard form is undecidable: this module returns only `'pass'` or
 * `'fail'`. There is no fifth form (`exit_code` / `stderr_empty` are forbidden
 * by design §5.2), so a guard matching none of the four forms fails closed.
 *
 * Within the gate's contract, guards come from `parsePlan` (exactly one form
 * key per guard) and receipts from `canonicalise`; this module does not
 * re-validate either. A receipt is never projected here — guards read the
 * canonical original.
 *
 * @module dsh-boost/gate/guard
 */

import type { CanonicalReceipt } from '../projection/canonicalise.js'
import type { Guard } from './plan.js'

/**
 * Outcome of one guard. `'unknown'` is part of the agreed interface but is
 * never produced: every guard form v1 accepts is decidable.
 */
export type GuardResult = 'pass' | 'fail' | 'unknown'

/** The one place a predicate becomes a verdict. */
function verdict(holds: boolean): GuardResult {
  return holds ? 'pass' : 'fail'
}

/** `ok` reads `isError` and nothing else; a passing guard says nothing about text. */
function evaluateOk(_g: { ok: true }, r: CanonicalReceipt): GuardResult {
  return verdict(!r.isError)
}

/** Case-sensitive substring presence, on the canonical text exactly as received. */
function evaluateContains(g: { text_contains: string }, r: CanonicalReceipt): GuardResult {
  return verdict(r.text.includes(g.text_contains))
}

/** Case-sensitive substring absence; used to exclude error footers and stacks. */
function evaluateNotContains(g: { text_not_contains: string }, r: CanonicalReceipt): GuardResult {
  return verdict(!r.text.includes(g.text_not_contains))
}

/** A canonical array index: unsigned, no leading zero, no decimal, no padding. */
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/

/**
 * Decode one RFC 6901 reference token. `~0` is `~` and `~1` is `/`; scanning
 * left to right makes `~01` the literal `~1` (the replacement order the RFC
 * prescribes). A `~` followed by anything else, including the end of the
 * segment, is malformed and yields `undefined`.
 */
function decodeSegment(segment: string): string | undefined {
  let decoded = ''
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]
    if (char !== '~') {
      decoded += char
      continue
    }
    const escaped = segment[i + 1]
    if (escaped === '0') decoded += '~'
    else if (escaped === '1') decoded += '/'
    else return undefined
    i += 1
  }
  return decoded
}

/** A pointer walk either yields a value or misses; JSON cannot produce `undefined`. */
type Resolved = { found: true; value: unknown } | { found: false }

/**
 * Resolve one already-decoded segment. Objects accept any own key; arrays
 * accept only a canonical decimal index inside their length. Both use
 * `Object.hasOwn`, so an inherited property never resolves, and both refuse to
 * descend into a primitive (`null`, string, number, boolean).
 */
function resolveSegment(target: unknown, segment: string): Resolved {
  if (Array.isArray(target)) {
    if (!ARRAY_INDEX.test(segment)) return { found: false }
    const index = Number(segment)
    if (index >= target.length) return { found: false }
    if (!Object.hasOwn(target, segment)) return { found: false }
    return { found: true, value: target[index] }
  }
  if (typeof target !== 'object' || target === null) return { found: false }
  if (!Object.hasOwn(target, segment)) return { found: false }
  return { found: true, value: (target as Record<string, unknown>)[segment] }
}

/**
 * Resolve an RFC 6901 pointer against an already-parsed JSON document.
 *
 * `''` is the whole document; any other pointer must start with `/`. The empty
 * pointer is handled before splitting, so the whole-document case never enters
 * the array-index rule (`''.split('/').slice(1)` would be `[]` anyway, but the
 * early return states the intent). Missing keys, malformed escapes,
 * non-canonical or out-of-range array indices, and hops through scalars all
 * return `found: false` — this function never throws.
 */
function resolvePointer(document: unknown, pointer: string): Resolved {
  if (pointer === '') return { found: true, value: document }
  if (!pointer.startsWith('/')) return { found: false }
  let current = document
  for (const raw of pointer.split('/').slice(1)) {
    const segment = decodeSegment(raw)
    if (segment === undefined) return { found: false }
    const next = resolveSegment(current, segment)
    if (!next.found) return { found: false }
    current = next.value
  }
  return { found: true, value: current }
}

/**
 * Parse the canonical text, resolve the pointer, and compare with `===`.
 * A parse error, a malformed pointer, a missing path, or a non-scalar target is
 * `fail`; there is no coercion between JSON types.
 */
function evaluateJsonEquals(
  g: { json_equals: { pointer: string; value: string | number | boolean } },
  r: CanonicalReceipt,
): GuardResult {
  let document: unknown
  try {
    document = JSON.parse(r.text)
  } catch {
    return 'fail'
  }
  const resolved = resolvePointer(document, g.json_equals.pointer)
  return verdict(resolved.found && resolved.value === g.json_equals.value)
}

/**
 * Evaluate one guard. Dispatch is by presence of the form key, so a guard
 * matching none of the four forms falls through to `fail` instead of passing.
 */
export function evaluateGuard(g: Guard, r: CanonicalReceipt): GuardResult {
  if ('ok' in g) return evaluateOk(g, r)
  if ('text_contains' in g) return evaluateContains(g, r)
  if ('text_not_contains' in g) return evaluateNotContains(g, r)
  if ('json_equals' in g) return evaluateJsonEquals(g, r)
  return 'fail'
}

/**
 * Evaluate guards left to right and stop at the first failure. An empty list
 * passes vacuously. `failed` is the exact guard object passed in, so a caller
 * can identify which guard rejected the receipt.
 */
export function evaluateAll(guards: Guard[], r: CanonicalReceipt): { ok: boolean; failed?: Guard } {
  for (const guard of guards) {
    if (evaluateGuard(guard, r) !== 'pass') return { ok: false, failed: guard }
  }
  return { ok: true }
}
