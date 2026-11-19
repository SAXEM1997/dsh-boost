/**
 * The plan-protocol system prompt section.
 *
 * This module owns the literal text that teaches the model to write a
 * `<CHISEL_PLAN>` block: the block shape, the candidate-id rule, the `args`
 * restrictions, the `$public` template, the four guard forms and the
 * tools that substitution covers. Nothing here parses or validates a
 * plan — `src/gate/plan.ts`, `src/gate/binding.ts` and `src/gate/guard.ts`
 * are the authority, and the text is written to agree with them exactly. A
 * shape the parser rejects would make every malformed plan a silent
 * fallback, so the wording is part of the gate contract, not prose.
 *
 * The section is registered with `interpolate: false`; the text is still
 * kept free of `{{` so a later relaxation of that flag cannot rewrite it.
 * It is injected into every in-scope request's system prompt, so length is a
 * permanent cost: the budget is under 1200 characters, and every sentence
 * has to change what the model writes.
 *
 * The text deliberately teaches no `after: "root"` template. The parser
 * accepts the value, but nothing in the plugin produces a `root` receipt, so
 * a plan that uses it is `missing-receipt` and falls back; teaching a dead
 * path would only spend the model's tokens.
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
 * Four concerns, in the order the model needs them: the block format, the
 * literal `args` rules, the guard vocabulary (including the rule that a
 * `text_contains` operand must be copied verbatim from its expected receipt,
 * never invented), and the `$public` template with its unique-line rule. The
 * first sentence states the only consequence the model needs: every failure
 * means the step runs normally, so a plan is an optimisation and can be
 * omitted.
 */
export const PROTOCOL_TEXT = `Plan protocol (optional): any failure runs the step normally; omit when unsure.
One JSON plan block.
<CHISEL_PLAN>
{"goal":"...","steps":[{"id":"A","tool":"read","args":{"path":"/a"},"guards":[{"text_contains":"export function"}]}]}
</CHISEL_PLAN>
id: one capital A-Z, unique, max 26 steps.
args: object, not $public itself, depth <= 64, no $-key except $public, no __proto__/constructor/prototype anywhere.
guards: >=1 non-ok guard, one form each, else no substitution:
{"ok":true} no error
{"text_contains":"s"}/{"text_not_contains":"s"} case-sensitive substring; s non-empty, verbatim from its expected receipt (like "export function", not "no errors" or "")
{"json_equals":{"pointer":"/a/b","value":"v"}} RFC 6901 pointer in receipt JSON; value string/number/boolean, exact
Only read, grep, glob are substituted; others run normally.
$public reuses an earlier step's value: {"$public":{"after":"A","field":"name"}} exactly.
field: identifier, "$scalar" (trimmed receipt is one bare token) or "$single" (whole receipt is ['value']); identifier X binds only at exactly one line-start X: "value" or X="value" (double-quoted, non-empty), else ignored.`
