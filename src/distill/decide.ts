/**
 * The distillation decision: pre-gate → table → call → check → post-gate → write.
 *
 * One rectangular receipt, in order (ticket #10's seven contracts):
 *
 * 1. **Pre-gate.** Only families listed in `distillation.families`, with
 *    distillation enabled, and only receipts longer than
 *    `distillation.triggerChars ?? projection[family].triggerChars` are
 *    candidates. Everything else returns `null`, which means "project exactly
 *    as before".
 * 2. **Table.** A pinned product under `(receipt_hash, question_hash, version)`
 *    is reused **without any model call**. A hit is re-checked by the same
 *    quote and size gates as a fresh answer: the file is data, and a forged or
 *    stale one must not reach history.
 * 3. **Call.** The `DistillFn` is raced against `timeoutMs`. A throw or
 *    `undefined` is `distill-failed`; an unanswered race is
 *    `distill-rejected:timeout`. Neither ever escapes as an exception.
 * 4. **Verify.** Every quote must be a non-empty substring of the receipt;
 *    one bad quote rejects the whole answer (`distill-rejected:unverifiable`).
 * 5. **Post-gate.** The adopted body must be **strictly smaller, in UTF-8
 *    bytes**, than the truncation view of the same receipt — head line, the
 *    windows, and the host footer — or it is `distill-rejected:not-smaller`.
 *    Bytes, not code points: the footer counts bytes, and the saving the
 *    ledger claims is what the model stops paying for.
 * 6. **Persist.** The product is written before its bytes are returned, so the
 *    bytes that enter history are the bytes on disk (ADR 0001). A failed write
 *    is `distill-failed`.
 * 7. **Adopt.** The view is `<head marker>\n<body>\n\n<host footer>` with the
 *    footer rendered by the host's own `formatSpillNotice`, exactly the shape
 *    an ordinary projection has, so anchors, spill and receipts keep working.
 *
 * The original is spilled **before** the decision is finalised: the footer's
 * locator must name an artifact that exists and holds the whole receipt.
 *
 * `content: null` is the contract for "do not replace": the caller uses the
 * ordinary truncation path and counts the event with `code`.
 *
 * @module dsh-boost/distill/decide
 */
import { renderHeadLine, truncate } from '../projection/truncate.js'
import type { FormatFooter, SpillBackend } from '../projection/apply.js'
import type { BoostConfig, ToolFamily } from '../types.js'
import { keyOf, questionKeyOf, questionOf, receiptKeyOf, TIMEOUT, versionOf, withTimeout } from './pin.js'
import type { DistillKey, DistillQuestion } from './pin.js'
import type { DistillStore } from './store.js'
import type { DistillAnswer, DistillFn, DistillRequest } from './types.js'
import type { DistillRouteOf } from './llm.js'

/** The stable codes a distillation writes; `distill-rejected:*` names its reason. */
export type DistillCode = 'distill' | 'distill-failed' | `distill-rejected:${DistillRejectReason}`

/** Why an answer was not adopted. */
export type DistillRejectReason = 'empty' | 'not-smaller' | 'not-worth-it' | 'unverifiable' | 'timeout'

/**
 * The reasons a replayed decision must not pay for the model again.
 *
 * `timeout` is excluded on purpose: it carries no answer, and the whole point of
 * parking the request is that a late answer lands and a replay adopts it. The
 * three below are decisions — the answer arrived and was refused — so they are
 * pinned as tombstones, otherwise every replay of the same receipt pays for the
 * same refusal.
 */
const PINNED_REJECTIONS: ReadonlySet<DistillRejectReason> = new Set<DistillRejectReason>([
  'empty',
  'unverifiable',
  'not-smaller',
])

/** Everything one decision reads; every host service arrives pre-bound. */
export interface DecideInput {
  /** Canonical receipt text, byte for byte as it would enter history. */
  text: string
  /** The projection family; distillation only knows `bash` and `ssh`. */
  family: ToolFamily
  /** Resolved plugin configuration. */
  cfg: BoostConfig
  /** The owning session, which also names the products it wrote. */
  sessionId: string
  /** The turn the receipt belongs to; carried so a late answer can be receipted. */
  turn: number
  /** The product table. */
  store: DistillStore
  /** The model call, or `undefined` when the host has no LLM (then `distill-failed`). */
  distill: DistillFn | undefined
  /** The route: `distillation.route`, or the boundary route; `undefined` means no call. */
  route: DistillRouteOf | undefined
  /** The host footer renderer; without it the view has no footer shape, so no adoption. */
  formatFooter: FormatFooter | undefined
  /** The spill backend that keeps the original retrievable. */
  spill: SpillBackend | undefined
  /** The tool name, for the spill source; defaults to the family. */
  toolName?: string
  /** The model-issued call id, for the spill source. */
  callId?: string
  /**
   * A seam for parking the request → call association, so a timed-out call's
   * answer is still persisted when it lands (`attempt.ts`). Optional: without
   * it a timeout simply loses its answer.
   */
  park?: (options: object, settled: Promise<DistillAnswer | undefined>) => void
  /** The request constructor the parking seam is paired with (`requestOptionsOf` below). */
  requestOptions?: (request: DistillRequest) => object
  /**
   * How many more model requests this session is expected to replay the receipt
   * through, excluding this one. Optional: without it the payback gate is off,
   * because a guess about the future must not silently become a decision.
   */
  remainingSteps?: number
  /**
   * The host's token estimator. Optional for the same reason: the payback gate
   * compares a saving against a cost, and both sides have to be measured in the
   * same unit by the same instrument.
   */
  estimate?: (text: string) => number
}

/** Where a product came from, so `status` can count the paths apart. */
export interface DistillEvidence {
  /** `true` when the model was called on this invocation. */
  called: boolean
  /** Tokens reported by the call; `NaN`-safe: omitted when the adapter did not say. */
  tokens?: number
  /**
   * Code points of the receipt body sent to the model.
   *
   * The answer's tokens are completion only — the prompt is the receipt, which
   * is the larger half of the cost, and an auxiliary request is deliberately
   * never observed by the usage ledger. Recording the prompt's size is what
   * lets an operator see "did the saving get spent again" without inventing a
   * token count the host never reported.
   */
  inputChars?: number
  /** The model that produced the adopted body. */
  model?: string
  /** The adopted view is the one the caller must use. */
  adopted: boolean
  /** The rejection reason, when `adopted` is false. */
  reason?: DistillRejectReason
  /**
   * `true` when the call timed out but its answer was persisted by the time the
   * table was next read: the product is charged, not adopted.
   */
  late?: boolean
}

/** The outcome of one decision. */
export interface DistillOutcome {
  /** The content to enter history, or `null` to fall back to truncation. */
  content: string | null
  /** The stable receipt code. */
  code: DistillCode
  /** `adopted` when `content` is set, `fallback` otherwise. */
  mode: 'adopted' | 'fallback'
  /** `omittedBytes` for the receipt line: original − adopted body, in UTF-8 bytes. */
  omittedBytes?: number
  /** The adopted body's bytes, so the receipt can pair the two halves. */
  distillBytes?: number
  /** The quotes the adopted answer rested on. */
  quotes?: string[]
  /** The spill locator the footer names; present only when the original was written. */
  locator?: string
  /** The facts `status` and the receipt line report. */
  evidence: DistillEvidence
}

/**
 * Whether every quote is a non-empty substring of `source`.
 *
 * A quote check is a forgery filter, not a proof of relevance: it proves the
 * model copied, never that it copied the right lines (issue #9's research
 * note). An empty list passes — an answer that cites nothing is not a forged
 * answer, and the size and quote gates are the only gates there are.
 */
export function verifyQuotes(quotes: readonly string[], source: string): boolean {
  // An answer that cites nothing is not a forged answer — it is an unverifiable
  // one, and the quote list is the only signal that the body is anchored in the
  // receipt rather than invented. Zero quotes fails the same gate as a bad one.
  if (quotes.length === 0) return false
  for (const quote of quotes) {
    if (typeof quote !== 'string' || quote === '') return false
    if (!source.includes(quote)) return false
  }
  return true
}

/** What one call settles to: an answer, or the fact that it threw. */
type CallOutcome = { kind: 'answered'; answer: DistillAnswer | undefined } | { kind: 'threw' }

/** The effective pre-gate for one family, or `null` when the family is excluded. */
function triggerOf(cfg: BoostConfig, family: ToolFamily): number | null {
  const distillation = cfg.distillation
  if (distillation === undefined || distillation.enabled !== true) return null
  if (!Array.isArray(distillation.families) || !distillation.families.includes(family)) return null
  const configured = distillation.triggerChars
  if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) return configured
  const params = cfg.projection[family]
  return params === undefined ? null : params.triggerChars
}

/** The empty locator used for the first render, whose only job is to measure the footer. */

/**
 * The truncation view of the same receipt, in bytes.
 *
 * Built from the same window and the same footer renderer an applied
 * projection would use, with a probe locator: the footer's length is what the
 * post-gate must compare against, and the locator's length is the same on both
 * sides of the comparison because both renders name the same spill artifact.
 */
function truncationViewBytes(
  text: string,
  cfg: BoostConfig,
  family: ToolFamily,
  formatFooter: FormatFooter,
  locator: string,
): number | null {
  const params = cfg.projection[family]
  if (params === undefined) return null
  const truncation = truncate(text, params)
  if (truncation === null) return null
  const footer = formatFooter({ kind: 'exact', count: truncation.omittedBytes }, {
    locator,
    retrievalHint: '',
  })
  const view = `${renderHeadLine(truncation)}\n${truncation.head}\n${footer}\n${truncation.tail}`
  const signals = truncation.signals ?? []
  const withSignals = signals.length === 0 ? view : `${view}\n${signals.join('\n')}`
  return Buffer.byteLength(withSignals, 'utf8')
}

/**
 * The adopted view: the head marker, the body, a blank line, the host footer.
 *
 * `formatHeaderLine` decides the marker's text; `decide` always uses the
 * default `[distilled from N chars; Q]`, where `N` is the original receipt's
 * code-point count and `Q` the family's question name.
 */
function distilledView(body: string, text: string, question: DistillQuestion, footer: string): string {
  // `toLocaleString` would insert thousands separators (`8,541`), but the
  // stream hook recognises the marker with `[\d,]+` and the anchor check's
  // other counts are plain `\d+`; a bare count keeps one spelling everywhere.
  const total = Array.from(text).length
  return `[distilled from ${total} chars; ${question.name}]\n${body}\n\n${footer}`
}

/** The `DistillKey` for one receipt, question and model. */
function keyFor(text: string, question: DistillQuestion, model: string): DistillKey {
  return keyOf(receiptKeyOf(text), questionKeyOf(question), versionOf(model, question))
}

/**
 * Persist the answer and adopt it, or explain why not.
 *
 * Split out so the hit path and the call path share one verification: a product
 * read from disk and a product just received go through the same quote and size
 * gates before either can reach history.
 */
/**
 * Whether a distillation could ever pay for its own model call.
 *
 * The most a distillation can save is `truncation view − footer` per replay —
 * an empty body plus a footer is the smallest view any answer can produce — and
 * a receipt is replayed `1 + remainingSteps` times. The call costs at least the
 * receipt as input plus the output budget. When the best case does not cover
 * the cost, no answer pays back, so the call is skipped instead of paid for.
 *
 * Both sides go through the same estimator, so the comparison is unit-correct
 * even when the estimator is the crude `chars / 4` fallback. A host without an
 * estimator never reaches here (`input.estimate` is undefined).
 */
function paysBack(
  text: string,
  cfg: BoostConfig,
  family: ToolFamily,
  formatFooter: FormatFooter,
  estimate: (text: string) => number,
  remainingSteps: number,
  maxOutputTokens: number,
): boolean {
  const params = cfg.projection[family]
  if (params === undefined) return false
  const truncation = truncate(text, params)
  // No truncation view means nothing to beat: the receipt is either too short
  // or over the projection's byte ceiling, and both are refusals elsewhere.
  if (truncation === null) return false
  const footer = formatFooter({ kind: 'exact', count: truncation.omittedBytes }, {
    locator: '',
    retrievalHint: '',
  })
  const truncationTokens = estimate(
    `${renderHeadLine(truncation)}\n${truncation.head}\n${footer}\n${truncation.tail}`,
  )
  const bestSaving = truncationTokens - estimate(footer)
  if (!Number.isFinite(bestSaving) || bestSaving <= 0) return false
  const replays = 1 + Math.max(0, Math.floor(remainingSteps))
  const cost = estimate(text) + maxOutputTokens
  if (!Number.isFinite(cost)) return false
  return bestSaving * replays > cost
}

async function adopt(
  input: DecideInput,
  question: DistillQuestion,
  key: DistillKey,
  answer: { text: string; quotes: string[]; model: string },
  evidence: DistillEvidence,
  fromTable: boolean,
  pinnedSpill?: { locator: string; retrievalHint: string },
): Promise<DistillOutcome> {
  const reject = async (reason: DistillRejectReason): Promise<DistillOutcome> => {
    // A refusal is a decision too: pin it so a replay reads the tombstone
    // instead of paying for the same call. Awaited, because the very next
    // `decide` for this receipt must see it — a fire-and-forget write races the
    // replay it exists to protect. A failed write is not a failed refusal, so
    // it never changes the outcome.
    if (!fromTable && PINNED_REJECTIONS.has(reason)) {
      await input.store
        .write(input.sessionId, key, { model: evidence.model ?? 'unknown', rejected: reason })
        .catch(() => undefined)
    }
    return {
      content: null,
      code: `distill-rejected:${reason}`,
      mode: 'fallback',
      evidence: { ...evidence, adopted: false, reason },
    }
  }

  // An empty body passes every other gate — it is trivially a substring of
  // nothing, and marker + footer is far shorter than the truncation view — and
  // would replace a whole receipt with a head line. Refuse it before the spill
  // so the original is never written for a body that cannot be used.
  if (answer.text.trim() === '') return await reject('empty')

  if (!verifyQuotes(answer.quotes, input.text)) return await reject('unverifiable')

  const { formatFooter, spill, cfg, family, text, sessionId } = input
  if (formatFooter === undefined || spill === undefined) {
    return { content: null, code: 'distill-failed', mode: 'fallback', evidence: { ...evidence, adopted: false } }
  }

  let ref: Awaited<ReturnType<SpillBackend['saveText']>>
  let composed: string
  let truncationBytes: number | null
  try {
    // The original goes to the spill store before the decision is final, so
    // the footer names an artifact that exists and holds the whole receipt.
    //
    // A replay must NOT save it again: the host backend names each file with
    // `randomBytes(6)`, so a second write returns a different locator and the
    // footer — the part of the view the model reads — would differ from the
    // bytes that entered history the first time. The pinned product carries
    // the locator for exactly this reason (`DistillStore`), and a product
    // without one (written before the field existed) falls through to a fresh
    // write, which is the only case where a replay may re-spill.
    ref = pinnedSpill !== undefined ? pinnedSpill : await spill.saveText({
      owner: { sessionId },
      source: {
        kind: 'tool',
        toolName: input.toolName ?? family,
        callId: input.callId ?? input.toolName ?? family,
        label: family,
      },
      suggestedName: `${input.toolName ?? family}.txt`,
      content: text,
    })
    const bodyBytes = Buffer.byteLength(answer.text, 'utf8')
    const omittedBytes = Buffer.byteLength(text, 'utf8') - bodyBytes
    const footer = formatFooter({ kind: 'exact', count: omittedBytes }, ref)
    composed = distilledView(answer.text, text, question, footer)
    truncationBytes = truncationViewBytes(text, cfg, family, formatFooter, ref.locator)
  } catch {
    return { content: null, code: 'distill-failed', mode: 'fallback', evidence: { ...evidence, adopted: false } }
  }

  const bodyBytes = Buffer.byteLength(answer.text, 'utf8')
  const omittedBytes = Buffer.byteLength(text, 'utf8') - bodyBytes
  // Strictly smaller than the truncation view of the same receipt, measured in
  // UTF-8 bytes: the unit the footer counts and the ledger reports.
  if (truncationBytes === null || Buffer.byteLength(composed, 'utf8') >= truncationBytes) {
    return await reject('not-smaller')
  }

  // Written on the first decision, and also when a table hit had no pin to
  // reuse: a product persisted by the late-answer path (`DistillAttempts`)
  // carries no locator, so the first adoption spills for it — and unless that
  // locator is recorded here, every later adoption spills again and renders
  // different bytes for the same receipt.
  if (!fromTable || pinnedSpill === undefined) {
    try {
      await input.store.write(sessionId, key, {
        text: answer.text,
        quotes: answer.quotes,
        // The model we asked, not the one the answer claims: the key is built
        // from `route.model`, and a self-reported name that differs would pin
        // the product under a key no lookup ever computes.
        model: input.route?.model ?? answer.model,
        spill: { locator: ref.locator, retrievalHint: ref.retrievalHint },
      })
    } catch {
      return { content: null, code: 'distill-failed', mode: 'fallback', evidence: { ...evidence, adopted: false } }
    }
  }

  return {
    content: composed,
    code: 'distill',
    mode: 'adopted',
    omittedBytes,
    distillBytes: bodyBytes,
    quotes: [...answer.quotes],
    locator: ref.locator,
    evidence: { ...evidence, adopted: true },
  }
}

/**
 * Decide whether one receipt is replaced by its distillation.
 *
 * `null` means "not a distillation candidate, project as before". Otherwise
 * the outcome names the stable code; `content` is the view to use only when it
 * was adopted. Never throws.
 */
export async function decide(input: DecideInput): Promise<DistillOutcome | null> {
  const trigger = triggerOf(input.cfg, input.family)
  if (trigger === null) return null
  // `text.length` upper-bounds the code-point count, so this rejects cheaply
  // and exactly like `truncate` does.
  if (input.text.length <= trigger) return null
  const question = questionOf(input.family)
  if (question === undefined) return null
  const route = input.route
  if (route === undefined || input.distill === undefined) {
    return { content: null, code: 'distill-failed', mode: 'fallback', evidence: { called: false, adopted: false } }
  }

  const key = keyFor(input.text, question, route.model)
  const pinned = await input.store.read(key)
  if (pinned !== undefined && typeof pinned.rejected === 'string') {
    // A pinned refusal: the answer arrived and was refused, so the replay reads
    // the tombstone instead of paying for the same call.
    const reason = pinned.rejected as DistillRejectReason
    return {
      content: null,
      code: `distill-rejected:${reason}` as DistillCode,
      mode: 'fallback',
      evidence: { called: false, adopted: false, model: pinned.model, reason },
    }
  }
  if (pinned !== undefined) {
    return adopt(
      input,
      question,
      key,
      { text: pinned.text, quotes: pinned.quotes, model: pinned.model },
      { called: false, adopted: false, model: pinned.model },
      true,
      pinned.spill,
    )
  }

  const distill = input.distill
  const request: DistillRequest = {
    text: input.text,
    question,
    provider: route.provider,
    model: route.model,
    maxOutputTokens: input.cfg.distillation.maxOutputTokens,
    timeoutMs: input.cfg.distillation.timeoutMs,
    key,
    sessionId: input.sessionId,
    turn: input.turn,
  }
  // `settled` is created **before** anything else can await, so a time-bounded
  // caller (the parked branch below) already holds a promise that will fire
  // however deep the call chain is.
  let settle: (answer: DistillAnswer | undefined) => void = () => {}
  // Pre-flight the two things a usable answer needs before paying for one: a
  // footer formatter and a spill backend. Checked inside `adopt` they would
  // cost a model call per render on a host that has neither, and the answer
  // would be discarded anyway.
  if (input.formatFooter === undefined || input.spill === undefined) {
    return { content: null, code: 'distill-failed', mode: 'fallback', evidence: { called: false, adopted: false } }
  }

  // Payback gate. The byte gate below compares two renderings of one receipt;
  // it says nothing about whether the model call that produced them ever pays
  // for itself. A receipt is replayed `1 + remainingSteps` times, so the most a
  // distillation can ever save is (truncation view − footer) per replay, and
  // the least it costs is the receipt as input plus the output budget. When
  // even that most-optimistic product does not cover the cost, no answer can
  // pay back and the call is skipped — which is the only place a distillation
  // can be a guaranteed loss (typically the last step of a session).
  if (
    input.remainingSteps !== undefined &&
    input.estimate !== undefined &&
    !paysBack(input.text, input.cfg, input.family, input.formatFooter, input.estimate, input.remainingSteps, input.cfg.distillation.maxOutputTokens)
  ) {
    // Deliberately not pinned: the horizon that produced this refusal changes
    // as the session grows, and a tombstone would freeze a decision the
    // evidence has since contradicted.
    return {
      content: null,
      code: 'distill-rejected:not-worth-it' as DistillCode,
      mode: 'fallback',
      evidence: { called: false, adopted: false, reason: 'not-worth-it' },
    }
  }
  const settled = new Promise<DistillAnswer | undefined>((resolve) => {
    settle = resolve
  })
  let requestOptions: object | undefined
  let started: Promise<DistillAnswer | undefined>
  try {
    // The request object is built (and registered, through
    // `input.requestOptions`) before the stream can reach the hook; otherwise
    // the hook would pass the request through and a late answer would never
    // be observed.
    requestOptions = input.requestOptions?.(request)
    // Hand the caller's object to the distiller so exactly one `GenerateOptions`
    // reaches the host: the registry keys on identity, and a second object would
    // register an entry nothing ever parks or deletes.
    const call = requestOptions === undefined ? request : { ...request, options: requestOptions }
    started = Promise.resolve().then(() => distill.call(call))
  } catch {
    started = Promise.reject(new Error('distillation request could not be built'))
  }
  void started.then(
    (answer) => settle(answer),
    () => settle(undefined),
  )
  // The race observes the same outcome; a throw is a value here, never a
  // rejection of `decide`.
  // What the call cost in prompt bytes is known before it is made, so every
  // outcome — answered, threw, timed out — can report it. Without this a
  // throw or an unanswered timeout reports `calls: 1` and zero input, which is
  // the opposite of what the ledger is for.
  const inputChars = Array.from(input.text).length
  const call = started.then(
    (answer): CallOutcome => ({ kind: 'answered', answer }),
    (): CallOutcome => ({ kind: 'threw' }),
  )
  const raced = await withTimeout<CallOutcome>(call, input.cfg.distillation.timeoutMs)
  if (raced === TIMEOUT) {
    // The call outlived the bound but is still running. Park it so its answer
    // is persisted when it lands: a replay of this receipt then finds it in the
    // table instead of paying for the same question again.
    if (requestOptions !== undefined) {
      // Park the receipt's own settlement: when the answer lands it is written
      // under this receipt's key, so a replay finds a pinned product instead of
      // paying for the same question again.
      input.park?.(requestOptions, settled)
    }
    return {
      content: null,
      code: 'distill-rejected:timeout',
      mode: 'fallback',
      evidence: { called: true, adopted: false, reason: 'timeout', inputChars },
    }
  }
  const answer = raced.kind === 'answered' ? raced.answer : undefined
  if (
    answer === undefined ||
    answer === null ||
    typeof answer.text !== 'string' ||
    !Array.isArray(answer.quotes)
  ) {
    return { content: null, code: 'distill-failed', mode: 'fallback', evidence: { called: true, adopted: false, inputChars } }
  }
  const model = typeof answer.model === 'string' && answer.model !== '' ? answer.model : route.model
  const tokens = typeof answer.tokens === 'number' && Number.isFinite(answer.tokens) ? answer.tokens : undefined
  return adopt(
    input,
    question,
    // The key the *lookup* computes, not one built from the answer's claim: a
    // product pinned under a self-reported model name is never found again.
    keyFor(input.text, question, route.model),
    { text: answer.text, quotes: answer.quotes, model },
    {
      called: true,
      adopted: false,
      model,
      inputChars,
      ...(tokens === undefined ? {} : { tokens }),
    },
    false,
  )
}
