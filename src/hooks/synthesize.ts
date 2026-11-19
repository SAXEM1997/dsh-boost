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
 * The reasoning block is not decoration. DeepSeek's thinking mode requires the
 * assistant `tool_use` message to carry a sibling `thinking` block on the next
 * request; a synthesized turn with only a `tool-call` block makes that request
 * fail with a 400 (`content[].thinking … must be passed back`, appendix §7).
 * The host's `ReasoningBlock` has exactly `type` and `text` — there is no
 * signature field to fill in — so the block is emitted unsigned and the next
 * request carries it as the required sibling.
 *
 * No `usage` chunk is emitted: nothing was measured, and a fabricated usage
 * would corrupt the token ledger. The chunk shape follows
 * `StreamChunk`/`ContentBlock` in `@deepseek-ai/dsh-llm/types` field by field;
 * in particular `tool-call.arguments` is the raw JSON string and must be
 * byte-identical to the `argumentsDelta` that streamed it.
 *
 * The generator is pure over `e`: it reads no clock, no queue, and no I/O, so
 * the same entry always produces the same chunks. `createdAt` is deliberately
 * not consulted.
 *
 * @module dsh-boost/hooks/synthesize
 */
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { PendingEntry } from './pending.js'

/** Stable failure code when a pending entry's arguments cannot be JSON-encoded. */
const UNSERIALISABLE_ARGS_CODE = 'BOOST_ARGS_UNSERIALISABLE'

/**
 * The reasoning sibling's text.
 *
 * A short deterministic sentence is enough: the block's existence and position
 * are what the next request needs, not its content. It names the tool and the
 * candidate so a session log shows why the turn appeared, and it never reads
 * `createdAt` or any other clock value.
 */
function reasoningText(e: PendingEntry): string {
  return `Deterministic substitution for ${e.name} (candidate ${e.candidateId}).`
}

/**
 * Assemble the `tool-call` block from the already-serialised argument string.
 *
 * `arguments` must be the very string that `argumentsDelta` streamed — passing
 * it in rather than serialising again also guarantees the delta and the block
 * cannot disagree if a getter is non-deterministic. The id is branded through
 * the host's own constructor, so the block's `id` has the `ToolCallId` type
 * the host declares.
 */
function toolCallBlock(e: PendingEntry, argsJson: string): ToolCallBlock {
  return {
    type: 'tool-call',
    id: ToolCallId(e.callId),
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
 * **Invalid call id.** A `PendingEntry` with an empty `callId` violates this
 * module's contract and cannot be repaired here: inventing one would make the
 * execute-side tamper check compare a different id and reject every dispatch
 * silently. The generator throws `RangeError` before its first yield, so no
 * partial turn reaches the host.
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
  if (typeof e.callId !== 'string' || e.callId.length === 0) {
    throw new RangeError('PendingEntry.callId must be a non-empty string')
  }

  const reasoning = reasoningText(e)
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