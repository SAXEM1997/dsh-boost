/**
 * The in-flight distillation calls, so a timeout can still be persisted.
 *
 * `decide` bounds each model call with `timeoutMs`. When the timer wins, the
 * call keeps running (a stream cannot be torn down tick by tick), and its
 * answer lands a moment later. Dropping that answer would mean paying for the
 * same question again on the next render — the opposite of what the pinned
 * table is for. So `decide` parks its promise here, and the `llm/stream` hook,
 * which sees **every** stream in the process, notices the parked one settling
 * and writes the product under its own key.
 *
 * The association is by **request identity**: the hook leaves the request
 * untouched unless the `GenerateOptions` object is one this registry
 * registered, and only the distillation request constructor registers.
 * Registration happens before the request is sent (so a timeout that fires
 * while the stream is still unread still gets drained), and parking happens
 * when the timeout fires.
 * Nothing else can make a stream look like a distillation, and no receipt,
 * usage sample or substitution mark is touched because the request carries
 * `purpose: 'boost-distill'` and the hook's purpose branch returns before any
 * of that.
 *
 * The registry is bounded: at most {@link MAX_PARKED} parked calls, oldest
 * evicted first. An evicted call's answer is lost (the replay pays again), but
 * memory never grows with a misbehaving provider.
 *
 * @module dsh-boost/distill/attempt
 */
import { keyOf, questionKeyOf, receiptKeyOf, versionOf } from './pin.js'
import type { DistillQuestion } from './pin.js'
import type { DistillStore } from './store.js'
import type { DistillAnswer } from './types.js'

/** How many timed-out calls stay parked for a late answer. */
const MAX_PARKED = 64

/** One call that outlived its timeout. */
interface CallIdentity {
  /** The request's model, and so the model of the product it will write. */
  model: string
  /** The receipt text, keyed into the product's address. */
  text: string
  /** The family's question. */
  question: DistillQuestion
  /** The owning session; the write is attributed to it. */
  sessionId: string
  /** The turn the call was spent for; `0` when the caller had none. */
  turn?: number
}

/**
 * What a late answer cost, handed to the receipt writer.
 *
 * A timed-out call already wrote its own receipt, so its cost cannot be added
 * there. It is recorded as its own line instead: `calls` stays `0` (this line
 * made no call) and only the token totals move, which is exactly the gap the
 * RELEASE note used to admit.
 */
export interface LateProduct {
  sessionId: string
  turn: number
  model: string
  tokens?: number
  inputChars?: number
}


/**
 * Parked calls for one plugin instance.
 *
 * One registry per assembly (like `HookDeps`-keyed maps elsewhere), so two
 * plugin instances in one process cannot write each other's products.
 */
export class DistillAttempts {
  private readonly entries = new Map<object, CallIdentity & { settled?: Promise<DistillAnswer | undefined> }>()
  private readonly store: DistillStore
  private readonly onLate: ((product: LateProduct) => void) | undefined

  constructor(store: DistillStore, onLate?: (product: LateProduct) => void) {
    this.store = store
    this.onLate = onLate
  }

  /**
   * Record a request before it is sent.
   *
   * Called synchronously by the request constructor, so the `llm/stream` hook
   * recognises the request the moment it arrives and drains it; the answer is
   * read from the call's own settlement, not rebuilt here.
   */
  register(options: object, call: CallIdentity): void {
    this.entries.set(options, call)
    if (this.entries.size > MAX_PARKED) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  /** Attach the settlement of a call whose timeout has fired; its answer is persisted when it lands. */
  park(options: object, settled: Promise<DistillAnswer | undefined>): void {
    const identity = this.entries.get(options)
    if (identity === undefined) return
    const entry = { ...identity, settled }
    this.entries.set(options, entry)
    // Best effort: a lost product costs one extra call later, and a failed
    // store write must never surface as an unhandled rejection.
    void settled.then((answer) => {
      if (this.entries.get(options) !== entry) return
      this.entries.delete(options)
      if (answer === undefined) return
      return this.persist(entry, answer).then(
        () => undefined,
        () => undefined,
      )
    })
  }

  /** Whether this exact request object is one of this registry's distillation calls. */
  owns(options: object | undefined): boolean {
    return options !== undefined && this.entries.has(options)
  }

  /**
   * Whether this request is one whose caller has **already given up**.
   *
   * `owns` is true from the moment the call is registered, which is before the
   * model is even asked. Only a parked entry — one whose timeout has fired —
   * has no consumer left, so only then may the hook drain the stream instead of
   * passing it through. Draining a registered-but-live call would hand the
   * caller an empty iterable and turn every distillation into a paid no-op.
   */
  parked(options: object | undefined): boolean {
    if (options === undefined) return false
    const entry = this.entries.get(options) as { settled?: unknown } | undefined
    return entry !== undefined && entry.settled !== undefined
  }

  /** Forget everything (session teardown or plugin disposal). */
  clear(): void {
    this.entries.clear()
  }

  private async persist(call: CallIdentity, answer: DistillAnswer): Promise<void> {
    const key = keyOf(
      receiptKeyOf(call.text),
      questionKeyOf(call.question),
      versionOf(call.model, call.question),
    )
    await this.store.write(call.sessionId, key, {
      text: answer.text,
      quotes: answer.quotes,
      model: call.model,
    })
    // Only after the product is on disk: a receipt that claims a cost the table
    // cannot back is worse than a missing line.
    try {
      this.onLate?.({
        sessionId: call.sessionId,
        turn: call.turn ?? 0,
        model: call.model,
        ...(answer.tokens === undefined ? {} : { tokens: answer.tokens }),
        inputChars: Array.from(call.text).length,
      })
    } catch {
      // Evidence, never a precondition.
    }
  }
}
