/**
 * The plan-protocol system prompt section.
 *
 * This module owns the literal text that teaches the model to write a
 * `<CHISEL_PLAN>` block: the block shape, the candidate-id rule, the `args`
 * restrictions, the `$public` template, the guard vocabulary and the tools
 * substitution covers. Nothing here parses or validates a plan —
 * `src/gate/plan.ts`, `src/gate/binding.ts`, `src/gate/guard.ts` and
 * `src/gate/decide.ts` are the authority, and the text agrees with them.
 *
 * The referent is the most load-bearing claim: `decide` evaluates every
 * candidate's guards against `receipts.get(stepId)` — the receipt that just
 * arrived — not against the candidate's own not-yet-existing result. With no
 * such receipt nothing is viable, and several candidates whose guards pass on
 * that one receipt are alternatives for the selector, not a queue. The text
 * states this before the example because a guard aimed at the candidate's own
 * output fails every time.
 *
 * `after:"root"` is taught because T23b keys the just-arrived receipt as
 * `root`; an earlier executed candidate's receipt is keyed by its id. `$scalar`
 * needs the whole receipt to be one token (a one-path glob); an identifier
 * needs un-numbered output (a line-start `X: "value"`), which read/grep do not
 * provide; a multi-line value must be typed literally. `$single` is accepted
 * by binding but has no producer among the read/grep/glob receipts, so it is
 * deliberately not taught.
 *
 * The section is registered with `interpolate: false`; the text is still kept
 * free of `{{` so a later relaxation of that flag cannot rewrite it. The budget
 * is 1500 characters; the test pins it because this text is a permanent cost.
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
 * counts, what the guards read, the example and the sentence that repeats its
 * operand, the literal `args` rules, the guard vocabulary, the substituted
 * tools, and finally `$public` with its two binding sources and its limits.
 */
export const PROTOCOL_TEXT = `Plan one <CHISEL_PLAN> block in visible text, not reasoning;only the first counts. It describes your next call, so guards test the receipt that just arrived, not that call's own result. No receipt, no substitution. Several steps passing on one receipt are alternatives;one is chosen. Omit when unsure;any failure runs the call normally.
<CHISEL_PLAN>
{"goal":"g","steps":[{"id":"A","tool":"read","args":{"file_path":"/repo/b.ts"},"guards":[{"text_contains":"2 matches"}]}]}
</CHISEL_PLAN>
The guard reads the incoming receipt, which says "2 matches".
id:one capital A-Z, unique,max 26 steps.
args:object,not $public itself,depth<=64,no prototype keys,no $-key except $public.
guards:>=1 other than {"ok":true};each guard object has exactly one form key.
{"ok":true}:no error. {"text_contains":"s"}:s expected present. {"text_not_contains":"s"}:s expected absent, such as an error footer. Both case-sensitive,s non-empty,never guessed. {"json_equals":{"pointer":"/a/b","value":"v"}}:the whole receipt must be JSON.
Substituted:read, grep, glob;others run normally.
$public copies a value instead of retyping it:{"$public":{"after":"root","field":"$scalar"}}. after:"root"=the incoming receipt,or a step that already ran. field:"$scalar"=the whole receipt is one token (a one-path glob);or X=exactly one line-start X:"value" or X="value" (double-quoted, non-empty), which needs un-numbered output,so not read or grep. A multi-line value cannot be projected;type it literally. Else that step is skipped.`
