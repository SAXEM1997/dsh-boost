/**
 * Dispatch tamper check: the call that arrived is the call that was decided.
 *
 * When the plugin substitutes a call it decides the args, then synthesizes a
 * turn in which the model appears to have asked for them. Between the decision
 * and `tools/execute` those args pass through a round trip; if what arrives
 * differs from what was decided, the substitution has been tampered with — by a
 * prompt injection, by the model rewriting its own call, or by a bug — and the
 * call must be refused rather than executed.
 *
 * The comparison is structural and literal, and it proves equality only for the
 * same tool name and the same parsed argument tree. Anything it cannot prove
 * equal is refused; convenience is never a reason to accept.
 *
 * @module dsh-boost/hooks/execute
 */

/**
 * Deepest container nest {@link sameLiteral} descends before refusing.
 *
 * Task 11 caps plan args at 64 levels (`MAX_ARGS_DEPTH` in `src/gate/plan.ts`,
 * counted with the root at 1), so a legitimate dispatch never reaches this
 * bound. The guard exists because the function is exported and must be total: a
 * caller can hand it arbitrary depth or a cycle, and both must answer `false`
 * instead of overflowing the stack or hanging.
 */
const MAX_LITERAL_DEPTH = 64

/**
 * Whether two values are literally the same, without normalising anything.
 *
 * - Two non-objects compare with `Object.is`: `NaN` equals `NaN`, and `-0` does
 *   not equal `0`. That is the strictest reading; the point of this function is
 *   to refuse what it cannot prove.
 * - Arrays compare element by element, in order, and by length. An array never
 *   equals a non-array.
 * - Objects compare their own enumerable string keys: the key sets must match
 *   and every key's value must compare equal recursively. Key order is
 *   irrelevant, and a key whose value is `undefined` is still a key.
 *
 * Only own enumerable string keys participate, matching the host's
 * "losslessly JSON-serializable parsed arguments": a plain record, an array or
 * a scalar is the whole domain, and a non-plain object (a `Date`, a `Map`, a
 * class instance) is compared by whatever own keys it exposes — a `Date`
 * contributes none, exactly as the key rule says.
 *
 * The walk is depth-limited rather than cycle-aware: past
 * {@link MAX_LITERAL_DEPTH} it answers `false`, which also terminates on a
 * cyclic argument tree. A pair of distinct but structurally identical cycles is
 * therefore refused — the guard cannot prove them equal without a cycle-aware
 * walk, and refusing is the correct answer.
 *
 * @param a - first value, of any shape.
 * @param b - second value, of any shape.
 * @returns whether the two values are the same literal tree.
 */
export function sameLiteral(a: unknown, b: unknown): boolean {
  const sameNode = (left: unknown, right: unknown, depth: number): boolean => {
    // Refuse before descending, so the recursion is bounded at every level —
    // including one where both values happen to be identical.
    if (depth > MAX_LITERAL_DEPTH) return false
    // Identity is proof, and keeps `NaN` equal to itself: a cycle compared
    // with itself terminates here at its closing edge.
    if (Object.is(left, right)) return true
    const objectLeft = typeof left === 'object' && left !== null
    const objectRight = typeof right === 'object' && right !== null
    if (!objectLeft || !objectRight) return false

    const arrayLeft = Array.isArray(left)
    const arrayRight = Array.isArray(right)
    if (arrayLeft !== arrayRight) return false
    if (arrayLeft && arrayRight) {
      if (left.length !== right.length) return false
      for (let index = 0; index < left.length; index += 1) {
        if (!sameNode(left[index], right[index], depth + 1)) return false
      }
      return true
    }

    const keysLeft = Object.keys(left)
    const keysRight = Object.keys(right)
    if (keysLeft.length !== keysRight.length) return false
    for (const key of keysLeft) {
      if (!Object.hasOwn(right, key)) return false
      const leftValue = (left as Record<string, unknown>)[key]
      const rightValue = (right as Record<string, unknown>)[key]
      if (!sameNode(leftValue, rightValue, depth + 1)) return false
    }
    return true
  }

  return sameNode(a, b, 0)
}

/**
 * Refuse a dispatch whose arrival differs from the pending substitution.
 *
 * No `pending` entry means the plugin is not substituting this call, so it has
 * nothing to say about it and the call proceeds. Otherwise the arriving tool
 * `name` must be the decided name and the arriving parsed `arguments` must be
 * literally equal to the decided `args`; any difference is a tampered dispatch.
 *
 * A zero-argument call can arrive with `arguments: undefined` while the pending
 * entry stores `{}`; `undefined` alone is normalised to `{}` so substitution is
 * not disabled for every zero-argument tool. `null` is a real value and is
 * compared as one, so it does not match `{}`.
 *
 * This function only reports the verdict: it cannot see the queue, so it never
 * clears the pending entry. `registerHooks` clears the queue after receiving a
 * `reject` (Task 23b wires the lookup and the clearing).
 *
 * @param exec - the arriving dispatch: tool name and parsed arguments.
 * @param pending - the decided substitution, or `undefined` when none applies.
 * @returns `{reject: true, code: 'dispatch-rejected'}` on any mismatch, else
 *   `{reject: false}`.
 */
export function rejectIfTampered(
  exec: { name: string; arguments: unknown },
  pending: { name: string; args: Record<string, unknown> } | undefined,
): { reject: true; code: 'dispatch-rejected' } | { reject: false } {
  if (pending == null) return { reject: false }
  const arrived = exec.arguments === undefined ? {} : exec.arguments
  if (exec.name === pending.name && sameLiteral(arrived, pending.args)) return { reject: false }
  return { reject: true, code: 'dispatch-rejected' }
}
