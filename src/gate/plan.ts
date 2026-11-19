/**
 * Plan parsing: model-written text becomes typed candidates.
 *
 * The model may write one `<CHISEL_PLAN>` block listing candidate tool calls.
 * This module is the only place that text becomes data; guard evaluation,
 * binding and the selector all trust what it returns, so parsing is strict:
 * a document either yields a fully validated plan or exactly one error code
 * (`no-plan`, `bad-json`, `bad-shape`). Nothing is ever thrown and no partial
 * plan escapes.
 *
 * Only the first block counts. A second block is ignored even when the first
 * is malformed, and an opening tag without its closing tag is not a block at
 * all (`no-plan`).
 *
 * "Only literals" is enforced against what JSON can carry: `JSON.parse` cannot
 * produce a function, so the rule reduces to "`args` may contain no
 * `$`-prefixed key other than `$public`". That restriction covers the whole
 * `args` tree, including inside a `$public` subtree; the sanctioned template
 * (`{ after, field }`, with `$scalar`/`$single` as *values*) has no nested
 * `$`-prefixed key, so the two rules never conflict. The `$public` subtree is
 * otherwise preserved verbatim: its `after`/`field` semantics are validated by
 * binding (task 12), not here.
 *
 * @module dsh-boost/gate/plan
 */

/** A deterministic receipt predicate. `ok` alone is trivial (design §5.2). */
export type Guard =
  | { ok: true }
  | { text_contains: string }
  | { text_not_contains: string }
  | { json_equals: { pointer: string; value: string | number | boolean } }

/** One tool call the model proposed. */
export interface Candidate {
  id: string
  tool: string
  args: Record<string, unknown>
  guards: Guard[]
}

/** A parsed plan: documentation plus the candidate steps. */
export interface Plan {
  goal: string
  steps: Candidate[]
}

/** Why a document did not yield a plan. */
type PlanError = 'no-plan' | 'bad-json' | 'bad-shape'

/** First block only; `[\s\S]` because `.` would stop at a newline. */
const PLAN_BLOCK = /<CHISEL_PLAN>([\s\S]*?)<\/CHISEL_PLAN>/

/** Every failure leaves through here: one return shape, never a throw. */
function fail(code: PlanError): { error: PlanError } {
  return { error: code }
}

/** JSON object, not `null` and not an array. */
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The scalar `json_equals` may compare against. */
function scalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** `json_equals` keeps `value` exactly as JSON parsed it (a number stays a number). */
function decodeJsonEquals(raw: unknown): Guard | undefined {
  if (!object(raw)) return undefined
  const { pointer, value } = raw
  if (typeof pointer !== 'string' || !scalar(value)) return undefined
  return { json_equals: { pointer, value } }
}

/** One accepted guard form, plus the decoder for its value. */
interface GuardForm {
  readonly key: string
  readonly decode: (value: unknown) => Guard | undefined
}

/** Ordered table of the four forms; a guard must match exactly one of them. */
const GUARD_FORMS: readonly GuardForm[] = [
  { key: 'ok', decode: (value) => (value === true ? { ok: true } : undefined) },
  {
    key: 'text_contains',
    decode: (value) => (typeof value === 'string' ? { text_contains: value } : undefined),
  },
  {
    key: 'text_not_contains',
    decode: (value) => (typeof value === 'string' ? { text_not_contains: value } : undefined),
  },
  { key: 'json_equals', decode: decodeJsonEquals },
]

/**
 * Decode one guard, or `undefined` when it matches none of the four forms.
 *
 * Exactly one form key must be present: two at once are ambiguous, and a
 * present-but-malformed form key is not an "extra key" that may be dropped.
 * Any other keys are ignored, and only the matched form survives.
 */
function matchGuard(raw: unknown): Guard | undefined {
  if (!object(raw)) return undefined
  const forms = GUARD_FORMS.filter((form) => Object.hasOwn(raw, form.key))
  if (forms.length !== 1) return undefined
  const form = forms[0]
  return form.decode(raw[form.key])
}

/**
 * Whether `args` uses a `$` directive outside the one allowed template.
 *
 * The walk is iterative because `JSON.parse` accepts nesting far deeper than a
 * recursive walk could survive, and `parsePlan` must not throw on any input it
 * accepted as JSON. `$public` is allowed at any depth; its contents are not
 * otherwise validated here (binding owns that), but the `$`-key restriction
 * still applies throughout the tree.
 */
function hasForbiddenDirective(args: Record<string, unknown>): boolean {
  const stack: unknown[] = [args]
  while (stack.length > 0) {
    const value = stack.pop()
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item)
      continue
    }
    if (!object(value)) continue
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('$') && key !== '$public') return true
      stack.push(child)
    }
  }
  return false
}

/** Decode one step, or `undefined` when any required field is missing or malformed. */
function parseCandidate(raw: unknown): Candidate | undefined {
  if (!object(raw)) return undefined
  const { id, tool, args, guards } = raw
  if (typeof id !== 'string' || typeof tool !== 'string') return undefined
  if (!object(args) || hasForbiddenDirective(args)) return undefined
  if (!Array.isArray(guards)) return undefined
  const decoded: Guard[] = []
  for (const rawGuard of guards) {
    const guard = matchGuard(rawGuard)
    if (guard === undefined) return undefined
    decoded.push(guard)
  }
  return { id, tool, args, guards: decoded }
}

/**
 * Parse the first `<CHISEL_PLAN>` block out of one model response.
 *
 * Returns `{ plan }` only when the whole block is understood: a non-empty
 * `steps` array whose ids are unique strings, each with a tool, a literal
 * `args` object and decodable guards. Everything else collapses to one error
 * code, so callers can never act on half a plan. `goal` is documentation: a
 * missing or non-string value becomes `''`, never an error.
 */
export function parsePlan(text: string): { plan: Plan } | { error: PlanError } {
  const block = PLAN_BLOCK.exec(text)
  if (block === null) return fail('no-plan')

  let root: unknown
  try {
    root = JSON.parse(block[1])
  } catch {
    return fail('bad-json')
  }
  if (!object(root)) return fail('bad-shape')

  if (!Array.isArray(root.steps) || root.steps.length === 0) return fail('bad-shape')

  const steps: Candidate[] = []
  const seen = new Set<string>()
  for (const rawStep of root.steps) {
    const step = parseCandidate(rawStep)
    if (step === undefined) return fail('bad-shape')
    // Candidate ids key derived tool-call ids downstream; a duplicate would
    // attribute one call's receipt to the other.
    if (seen.has(step.id)) return fail('bad-shape')
    seen.add(step.id)
    steps.push(step)
  }

  return { plan: { goal: typeof root.goal === 'string' ? root.goal : '', steps } }
}

/**
 * Whether a candidate has nothing to check.
 *
 * True when every guard is `{ ok: true }`, including the empty array: nothing
 * to check means nothing to check. Any non-`ok` guard makes the candidate
 * non-trivial, which is what substitution requires (design §5.2, `guard-trivial`).
 */
export function isTrivial(c: Candidate): boolean {
  return c.guards.every((guard) => 'ok' in guard && guard.ok === true)
}
