/**
 * The synthesized model turn: a fake assistant reply that asks for the tool
 * call the plugin already decided on.
 *
 * The host's agent loop consumes chunks and then dispatches the tool call it
 * saw. The chunk sequence is therefore a protocol, not a presentation choice:
 *
 * 1. a `reasoning` block, then
 * 2. a `tool-call` block, then
 * 3. a terminal `finish` with reason `tool-calls`.
 *
 * The reasoning block is emitted first so the assistant turn carries the
 * sibling a reasoning-preserving adapter needs. DeepSeek's thinking mode
 * requires the assistant `tool_use` message to carry a sibling `thinking` block
 * (`content[].thinking … must be passed back`, appendix §7), and a synthesized
 * turn with only a `tool-call` block cannot satisfy that on such a route.
 *
 * It does **not** reach the wire on this host build's current
 * `openai-completions` route. A settled assistant message with no `replayState`
 * is routed to `foreignAssistant` and stamped `api:'dsh-foreign'`
 * (`dsh-llm-pi-ai/lib/index.js:180,250-252`), and pi-ai's `transformMessages`
 * drops every thinking block of a non-same-model message
 * (`transform-messages.js:87-96`). Emitting the block is still the right shape
 * and costs nothing — a route that preserves reasoning needs it — but whether a
 * route that enforces the sibling rule is satisfied end to end is a Task 24
 * question, not a claim this module makes.
 *
 * The host's `ReasoningBlock` has exactly `type` and `text` — there is no
 * signature field to fill in — so the block is emitted unsigned.
 *
 * No `usage` chunk is emitted: nothing was measured, and a fabricated usage
 * would corrupt the token ledger. The chunk shape follows
 * `StreamChunk`/`ContentBlock` in `@deepseek-ai/dsh-llm/types` field by field;
 * in particular `tool-call.arguments` is the raw JSON string and must be
 * byte-identical to the `argumentsDelta` that streamed it.
 *
 * The generator is pure over `e`: it reads no clock, no queue, and no I/O, so
 * the same entry always produces the same chunks.
 *
 * @module dsh-boost/hooks/synthesize
 */
import type { StreamChunk, ToolCallBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PendingEntry } from './pending.js'

/** Stable failure code when a pending entry's arguments cannot be JSON-encoded. */
const UNSERIALISABLE_ARGS_CODE = 'BOOST_ARGS_UNSERIALISABLE'

/**
 * The reasoning sibling's text.
 *
 * A fixed sentence, not a per-candidate one: the block's existence and
 * position are what the sibling rule needs, not its content. It is deliberately
 * constant because the block is replayed on every later request and rendered in
 * the transcript, so naming the tool and candidate here would cost tokens on
 * every turn to repeat what the adjacent `tool-call` block already says. It
 * never reads a clock value.
 */
function reasoningText(): string {
  return 'Deterministic substitution.'
}

/**
 * Assemble the `tool-call` block from the already-serialised argument string.
 *
 * `arguments` must be the very string that `argumentsDelta` streamed — passing
 * it in rather than serialising again also guarantees the delta and the block
 * cannot disagree if a getter is non-deterministic. `ToolCallId` is a
 * compile-time brand over `string` (`string & { readonly [BRAND]: 'ToolCallId' }`
 * in `@deepseek-ai/dsh-llm/brand`), so the id is cast locally rather than
 * produced by the host's constructor: importing the constructor as a value
 * would make the root export a load-time dependency of every user.
 */
function toolCallBlock(e: PendingEntry, argsJson: string): ToolCallBlock {
  return {
    type: 'tool-call',
    id: e.callId as ToolCallId,
    name: e.name,
    arguments: argsJson,
  }
}

/**
 * Stream the turn that asks for `e`'s tool call.
 *
 * Yields, in order and with these indexes:
 *
 * ```text
 * block-start {index:0, blockType:'reasoning'}
 * reasoning-delta {index:0, text}
 * block-end {index:0, block:{type:'reasoning', text}}
 * block-start {index:1, blockType:'tool-call'}
 * tool-call-delta {index:1, id, name, argumentsDelta}
 * block-end {index:1, block:{type:'tool-call', id, name, arguments}}
 * finish {reason:{kind:'tool-calls'}}
 * ```
 *
 * **Invalid call id.** A `PendingEntry` with a blank `callId` (empty or
 * whitespace-only) violates this module's contract and cannot be repaired here:
 * inventing one would make the execute-side tamper check compare a different id
 * and reject every dispatch silently. The generator throws `RangeError` before
 * its first yield, so no partial turn reaches the host.
 *
 * **Unserialisable arguments.** `args` is plan-validated JSON in production,
 * but this function is exported and must be total. When `JSON.stringify`
 * throws (a `BigInt`, a cycle) or returns `undefined`, the turn emits the
 * reasoning block and then a terminal `finish` with `kind:'error'` — it never
 * emits a `tool-call` block, because substituting an empty or partial argument
 * object would dispatch a call nobody decided. The error is a protocol chunk,
 * not a thrown exception: appendix §1.1 defines errors as `finish.reason`, and
 * a partially-consumed stream must not blow up the host loop.
 */
export async function* synthesizeTurn(e: PendingEntry): AsyncIterable<StreamChunk> {
  if (typeof e.callId !== 'string' || e.callId.trim().length === 0) {
    throw new RangeError('PendingEntry.callId must be a non-blank string')
  }

  const reasoning = reasoningText()
  yield { type: 'block-start', index: 0, blockType: 'reasoning' }
  yield { type: 'reasoning-delta', index: 0, text: reasoning }
  yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }

  let argsJson: string
  try {
    const serialised: string | undefined = JSON.stringify(e.args)
    if (serialised === undefined) throw new TypeError('JSON.stringify returned undefined')
    argsJson = serialised
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: UNSERIALISABLE_ARGS_CODE,
          message: `cannot serialise arguments for ${e.name}: ${detail}`,
        },
      },
    }
    return
  }

  const block = toolCallBlock(e, argsJson)
  yield { type: 'block-start', index: 1, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 1, id: block.id, name: block.name, argumentsDelta: block.arguments }
  yield { type: 'block-end', index: 1, block }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}