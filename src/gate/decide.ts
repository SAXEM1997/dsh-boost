/**
 * Substitution decision orchestration: one parsed plan in, one decision out.
 *
 * This is the point where the gate stops describing alternatives and says what
 * to do next: commit to exactly one candidate, ask the selector to choose among
 * several, or fall back to the ordinary model turn with a code saying why. It
 * is a pure function over the plan, the receipts collected so far and the
 * whitelist — no model call, no I/O, no mutation of its inputs.
 *
 * The rule that matters most: it never guesses. Zero viable candidates is a
 * fallback with a reason, never a best-effort pick, and a candidate that fails
 * binding or a guard is dropped without a reason of its own — the plan-level
 * fallback code is the only thing the caller needs.
 *
 * Order is fixed and load-bearing:
 *
 * 1. **Whitelist first.** A candidate whose tool is not whitelisted is never
 *    committed and never reaches the selector (design §5.2-5). When the plan
 *    had candidates and none survives, the answer is `tool-not-whitelisted`.
 *    An empty plan is not a whitelist failure: it falls through and lands in
 *    `guard-trivial`, because "nothing to verify" is what that code means.
 * 2. **Trivial candidates next.** A candidate whose guards are only `ok: true`
 *    has nothing to verify, so it is not substitution potential either. If
 *    every survivor is trivial (including the empty plan, vacuously), the
 *    answer is `guard-trivial`.
 * 3. **Bind, then guard, each remaining candidate in plan order.** Binding
 *    failure drops the candidate (it does not abort the plan); only a bound
 *    candidate has its guards evaluated. Guards read the receipt for
 *    `stepId` — the step that just arrived — and an absent receipt drops every
 *    candidate rather than guessing one. A `$public` template naming a node
 *    that does not exist is `unresolvable` inside binding, not a separate
 *    existence check here: `receipts` only ever holds steps that already ran.
 * 4. **Count.** None → `no-candidate`; one → `commit` with the *bound* args;
 *    several → `ask-selector` carrying the surviving candidates in plan order.
 *
 * Shadow mode (`shadow: true`) skips the whitelist. The shadow week records
 * substitution *potential* for every tool family (design §5.2-5: 影子期替换
 * 不设白名单，全量记账), and a whitelist-limited shadow would only ever measure
 * the read/grep/glob three. Trivial candidates are still dropped in shadow: a
 * trivial guard means there was nothing to verify, so it is not potential.
 *
 * The returned `ask-selector.candidates` is a new array (whose elements are the
 * original candidate objects); `commit.args` is the freshly bound tree from
 * `bindArgs`, so the host never receives a `$public` template.
 *
 * @module dsh-boost/gate/decide
 */

import type { CanonicalReceipt } from '../projection/canonicalise.js'
import { bindArgs } from './binding.js'
import { evaluateAll } from './guard.js'
import { isTrivial, type Candidate, type Plan } from './plan.js'

/** What the gate decided to do with the plan. */
export type Decision =
  | { kind: 'commit'; candidateId: string; args: Record<string, unknown> }
  | { kind: 'ask-selector'; candidates: Candidate[] }
  | { kind: 'fallback'; code: string }

/** A filter narrows the candidate list, or ends the pipeline with a decision. */
type Filter = (candidates: Candidate[]) => Candidate[] | Decision

/** One candidate that passed binding and its guards, with the args to run it. */
interface Viable {
  candidate: Candidate
  args: Record<string, unknown>
}

/** The one fallback constructor, so every early exit has the same shape. */
function fallback(code: string): Decision {
  return { kind: 'fallback', code }
}

/**
 * Whitelist filter (rule 1).
 *
 * Fails the pipeline only when there was something to filter: an empty plan
 * must reach the trivial filter, where it is `guard-trivial`, not a whitelist
 * rejection.
 */
function whitelisted(whitelist: ReadonlySet<string>): Filter {
  return (candidates) => {
    const kept = candidates.filter((candidate) => whitelist.has(candidate.tool))
    if (kept.length === 0 && candidates.length > 0) return fallback('tool-not-whitelisted')
    return kept
  }
}

/**
 * Trivial-candidate filter (rule 3).
 *
 * `isTrivial` is true for the empty guard list too, so this filter also turns
 * an empty plan into `guard-trivial`.
 */
const nonTrivial: Filter = (candidates) => {
  const kept = candidates.filter((candidate) => !isTrivial(candidate))
  return kept.length === 0 ? fallback('guard-trivial') : kept
}

/** Run filters left to right; the first decision ends the pipeline. */
function narrow(candidates: Candidate[], filters: readonly Filter[]): Candidate[] | Decision {
  let kept = candidates
  for (const filter of filters) {
    const next = filter(kept)
    if (!Array.isArray(next)) return next
    kept = next
  }
  return kept
}

/**
 * Bind and verify each candidate (rule 4).
 *
 * Binding runs first: a candidate that cannot be bound is dropped before its
 * guards are ever evaluated, and the failure reason is intentionally discarded
 * — every dropped candidate is just one fewer choice, not a distinct fallback
 * for the whole plan. Guards are receipt-local to `stepId`; when that receipt
 * is absent nothing can be verified, so nothing survives.
 */
function bindAndVerify(
  candidates: Candidate[],
  stepId: string,
  receipts: ReadonlyMap<string, CanonicalReceipt>,
): Viable[] {
  const receipt = receipts.get(stepId)
  if (receipt === undefined) return []
  const survivors: Viable[] = []
  for (const candidate of candidates) {
    const bound = bindArgs(candidate.args, receipts)
    if (!bound.ok) continue
    if (!evaluateAll(candidate.guards, receipt).ok) continue
    survivors.push({ candidate, args: bound.args })
  }
  return survivors
}

/** Turn the survivor list into the decision (rule 5). */
function resolve(survivors: Viable[]): Decision {
  const [only] = survivors
  if (only === undefined) return fallback('no-candidate')
  if (survivors.length > 1) {
    return { kind: 'ask-selector', candidates: survivors.map((entry) => entry.candidate) }
  }
  return { kind: 'commit', candidateId: only.candidate.id, args: only.args }
}

/**
 * Decide what to do with one parsed plan.
 *
 * `shadow` skips the whitelist filter (design §5.2-5) so the shadow week can
 * record substitution potential for every tool family; everything else is the
 * same path. The function is synchronous and side-effect free.
 */
export function decide(input: {
  plan: Plan
  stepId: string
  receipts: ReadonlyMap<string, CanonicalReceipt>
  whitelist: ReadonlySet<string>
  shadow?: boolean
}): Decision {
  const filters: readonly Filter[] = input.shadow
    ? [nonTrivial]
    : [whitelisted(input.whitelist), nonTrivial]
  const narrowed = narrow(input.plan.steps, filters)
  if (!Array.isArray(narrowed)) return narrowed
  return resolve(bindAndVerify(narrowed, input.stepId, input.receipts))
}
