/**
 * The plan-protocol system prompt section.
 *
 * This module owns the literal text that teaches the model to write a
 * `<CHISEL_PLAN>` block: the block shape, the candidate-id rule, the `args`
 * restrictions, the `$public` template, the four guard forms, the tools
 * substitution covers, and the receipt the guards actually read. Nothing here
 * parses or validates a plan — `src/gate/plan.ts`, `src/gate/binding.ts` and
 * `src/gate/guard.ts` are the authority, and the text is written to agree with
 * them exactly. A shape the parser rejects, or a mental model that points a
 * guard at the wrong receipt, is a silent fallback; the wording is part of the
 * gate contract, not prose.
 *
 * The referent is the most load-bearing sentence: `decide` evaluates every
 * candidate's guards against `receipts.get(stepId)`, the receipt that just
 * arrived, not against the candidate's own not-yet-existing result. With no
 * such receipt nothing is viable, and several candidates whose guards pass on
 * that one receipt are alternatives for the selector, not a queue.
 *
 * `after: "root"` is taught because T23b keys the just-arrived receipt as
 * `root`; an earlier executed candidate's receipt is keyed by its id. `$scalar`
 * works on a one-path glob receipt, and an identifier works on a raw
 * bash/ssh receipt (a line-start `X: "value"`), not on read/grep receipts,
 * which number their lines. `$single` is accepted by binding but has no
 * producer among the read/grep/glob receipts, so it is deliberately not
 * taught: every token here is paid on every request.
 *
 * The section is registered with `interpolate: false`; the text is still kept
 * free of `{{` so a later relaxation of that flag cannot rewrite it. The budget
 * is 1250 characters; the test pins it because this text is a permanent cost.
 *
 * @module dsh-boost/prompt/protocol
 */

/** Section name the protocol is registered under (design §5.3). */
export const PROTOCOL_NAME = 'dsh-boost'

/** Section order: alongside the other tool-contract sections. */
export const PROTOCOL_ORDER = 100

/**
 * The protocol section's body, injected verbatim.
 *
 * Order is what the model needs first: where the block goes and which one
 * counts, what the guards read, the example, the literal `args` rules, the
 * guard vocabulary, the substituted tools, and finally `$public` with its
 * two binding sources and the skip consequence.
 */
export const PROTOCOL_TEXT = `Plan one block in visible text, not reasoning; first only, even if malformed. Guards read the incoming receipt, not a step's result; passing steps are alternatives, one chosen; no receipt, no substitution; failure skips the step; omit when unsure.
<CHISEL_PLAN>
{"goal":"g","steps":[{"id":"A","tool":"read","args":{"file_path":"/a"},"guards":[{"text_contains":"TODO"}]}]}
</CHISEL_PLAN>
id: one capital A-Z, unique, max 26.
args: object, depth<=64, no __proto__/constructor/prototype or $-key except $public.
guards: >=1 beyond {"ok":true}; several guards per step, one form each.
{"ok":true} no error; {"text_contains":"s"}/{"text_not_contains":"s"}: case-sensitive substring, s non-empty, verbatim from that receipt (never "no errors" or ""); {"json_equals":{"pointer":"/a/b","value":"v"}}: only if the whole receipt is JSON, value string|number|bool.
Substituted: read/grep/glob; others normal.
$public: {"$public":{"after":"root","field":"$scalar"}} exactly. after: "root" (incoming) or an earlier step id. field: "$scalar" (whole receipt is one token, e.g. a glob path) or identifier X (exactly one line-start X: "value"/X="value", double-quoted, non-empty; bash/ssh receipts only, those steps still run, not numbered read/grep). Else skip step.`
