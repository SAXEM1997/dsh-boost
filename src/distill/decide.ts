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
 * 7. **Adopt.** The view is `<head marker>\n<body>\n\n<host footer>`, followed
 *    by the preserved §5.4-4 signal lines when the cut middle held any. The
 *    footer is rendered by the host's own `formatSpillNotice`, exactly the shape
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
import { truncate } from '../projection/truncate.js'
import type { Truncation } from '../projection/truncate.js'
import { signalSuffix, truncationView } from '../projection/apply.js'
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
 * parking the request is that a late answer lands and a replay adopts it.
 * `not-worth-it` is excluded for the same shape of reason: it rests on how many
 * steps remain, which grows as the session does, so pinning it would freeze a
 * judgement the evidence has since overturned. The three below are decisions —
 * the answer arrived and was refused — so they are pinned as tombstones,
 * otherwise every replay of the same receipt pays for the same refusal.
 */
const PINNED_REJECTIONS: ReadonlySet<DistillRejectReason> = new Set<DistillRejectReason>([
  'empty',
  'unverifiable',
  'not-smaller',
])

/**
 * Every reason a tombstone may legitimately carry — i.e. exactly the pinnable
 * ones.
 *
 * A tombstone is a file: it can be edited by hand, truncated, or written by a
 * build that pinned something else. A value outside this set is not a refusal to
 * replay; it is a file that cannot be trusted, so the decision falls through to
 * the ordinary path and pays for a call if one is warranted. Reading it as a
 * refusal would freeze the receipt forever: the file stays on disk, every replay
 * hits the same branch, and nothing is written to say why.
 *
 * The set matches what `reject()` may pin, and `reject()` pins only
 * `empty`/`unverifiable`/`not-smaller` — `timeout` and `not-worth-it` are
 * decisions that a later replay can legitimately overturn, so they never reach
 * disk.
 */
// Deliberately the same set as `PINNED_REJECTIONS`: a tombstone only ever holds a
// reason that decision would have pinned, so validation and pinning must agree.
const REJECT_REASONS: ReadonlySet<string> = new Set<string>(PINNED_REJECTIONS)

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
  toolName?: string | undefined
  /** The model-issued call id, for the spill source. */
  callId?: string | undefined
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
  /**
   * UTF-8 bytes this decision wrote to the spill store, and then left behind.
   *
   * Present only when the write actually happened: a replay that reuses a pin
   * reports nothing, so a replayed receipt cannot inflate the counter once per
   * replay. Two paths leave an artifact with no consumer — `not-smaller`
   * (the comparison needs the real footer, which names the artifact) and any
   * failure after the write (a throwing footer, a failed product write). The
   * host backend has no delete, so the size is the only trace they leave.
   */
  spilledBytes?: number
}

/**
 * Whether every quote is a non-empty substring of `source`.
 *
 * A quote check is a forgery filter, not a proof of relevance: it proves the
 * model copied, never that it copied the right lines (issue #9's research
 * note). An empty list **fails**: an answer that cites nothing is not a forged
 * answer, but it is an unverifiable one, and the quote list is the only signal
 * that the body is anchored in the receipt rather than invented.
 */
export function verifyQuotes(quotes: readonly string[], source: string): boolean {
  // Zero quotes fails the same gate as a bad one; the JSDoc says why.
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

/**
 * The rendered truncation view, from the one renderer in `projection/apply`.
 *
 * Kept as a named local so the gates read as intent; the template itself lives
 * in one place, because three copies of it drifted twice.
 */
function truncationViewText(truncation: Truncation, footer: string): string {
  return truncationView(truncation, footer)
}

/**
 * The truncation view of the same receipt, in bytes.
 *
 * Built from the same window and the same footer renderer an applied
 * projection would use, with a probe locator and an empty retrieval hint: the
 * footer's length is what the post-gate compares against, and both renders name
 * the same spill artifact, so the locator lengths match. The hint is omitted
 * here and present in the applied footer, so this baseline is a few tokens
 * shorter than the real view — conservative, never the other way.
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
  return Buffer.byteLength(truncationViewText(truncation, footer), 'utf8')
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

/** What the payback gate concluded: `unknown` means the gate does not apply. */
type Payback = 'worth' | 'not-worth' | 'unknown'

/**
 * Price one string, or answer "I cannot price this".
 *
 * The injected estimator is a host seam: it throws when the meter is broken and
 * answers `NaN` when it cannot price a message. Both mean the same thing here —
 * the comparison has no inputs — so they collapse to `undefined` rather than
 * becoming a number that makes the gate refuse on arithmetic it never did.
 */
function priced(estimate: (text: string) => number, text: string): number | undefined {
  try {
    const value = estimate(text)
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a distillation could ever pay for its own model call.
 *
 * The most a distillation can save is `truncation view − footer` per replay —
 * an empty body plus a footer is the smallest view any answer can produce — and
 * a receipt is replayed `1 + remainingSteps` times: once for the request that
 * carries it, then once per remaining step. The call costs at least the
 * receipt as input plus the output budget. When the best case does not cover
 * the cost, no answer pays back, so the call is skipped instead of paid for.
 *
 * `unknown` is not a refusal: it means this receipt has no truncation view to
 * beat (too short for the window, over the projection's byte ceiling, or a
 * window that would not shorten it) or the estimator could not price it. The
 * ordinary path already refuses those for its own reasons, and inventing an
 * economic refusal would report a comparison that never ran.
 */
function payback(
  text: string,
  cfg: BoostConfig,
  family: ToolFamily,
  formatFooter: FormatFooter,
  estimate: (text: string) => number,
  remainingSteps: number,
  maxOutputTokens: number,
): Payback {
  const params = cfg.projection[family]
  if (params === undefined) return 'unknown'
  const truncation = truncate(text, params)
  if (truncation === null) return 'unknown'
  const footer = formatFooter({ kind: 'exact', count: truncation.omittedBytes }, {
    locator: '',
    retrievalHint: '',
  })
  const viewTokens = priced(estimate, truncationViewText(truncation, footer))
  const footerTokens = priced(estimate, footer)
  const costTokens = priced(estimate, text)
  if (viewTokens === undefined || footerTokens === undefined || costTokens === undefined) {
    return 'unknown'
  }
  const bestSaving = viewTokens - footerTokens
  // A view no smaller than its own footer leaves nothing to save; that is a
  // byte-gate matter, not an economic one.
  if (bestSaving <= 0) return 'unknown'
  const replays = 1 + Math.max(0, Math.floor(remainingSteps))
  return bestSaving * replays > costTokens + maxOutputTokens ? 'worth' : 'not-worth'
}

/**
 * Persist the answer and adopt it, or explain why not.
 *
 * Split out so the hit path and the call path share one verification: a product
 * read from disk and a product just received go through the same quote and size
 * gates before either can reach history.
 */
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
  // Bytes this decision actually wrote to the spill store, or `undefined` when
  // it reused a pin. Reported as `spilledBytes` on every outcome that leaves the
  // artifact behind — including the failures below, which happen *after* the
  // write and would otherwise leave no trace at all.
  let spilledBytes: number | undefined
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
    if (pinnedSpill !== undefined) {
      ref = pinnedSpill
    } else {
      ref = await spill.saveText({
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
      spilledBytes = Buffer.byteLength(text, 'utf8')
    }
    const bodyBytes = Buffer.byteLength(answer.text, 'utf8')
    const omittedBytes = Buffer.byteLength(text, 'utf8') - bodyBytes
    const footer = formatFooter({ kind: 'exact', count: omittedBytes }, ref)
    // Signals appended exactly as the projection path appends them: a receipt
    // whose cut middle held `[exit code: 1]` keeps it under either transform, so
    // turning projection on or off never changes what the model can see.
    const window = cfg.projection[family]
    const truncation = window === undefined ? null : truncate(text, window)
    const signals = truncation === null ? '' : signalSuffix(truncation)
    composed = `${distilledView(answer.text, text, question, footer)}${signals}`
    truncationBytes = truncationViewBytes(text, cfg, family, formatFooter, ref.locator)
  } catch {
    return {
      content: null,
      code: 'distill-failed',
      mode: 'fallback',
      evidence: { ...evidence, adopted: false },
      ...(spilledBytes === undefined ? {} : { spilledBytes }),
    }
  }

  const bodyBytes = Buffer.byteLength(answer.text, 'utf8')
  const omittedBytes = Buffer.byteLength(text, 'utf8') - bodyBytes
  // Strictly smaller than the truncation view of the same receipt, measured in
  // UTF-8 bytes: the unit the footer counts and the ledger reports.
  if (truncationBytes === null || Buffer.byteLength(composed, 'utf8') >= truncationBytes) {
    const refusal = await reject('not-smaller')
    return { ...refusal, ...(spilledBytes === undefined ? {} : { spilledBytes }) }
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
      return {
        content: null,
        code: 'distill-failed',
        mode: 'fallback',
        evidence: { ...evidence, adopted: false },
        ...(spilledBytes === undefined ? {} : { spilledBytes }),
      }
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
  let pinned = await input.store.read(key)
  if (pinned !== undefined && typeof pinned.rejected === 'string' && !REJECT_REASONS.has(pinned.rejected)) {
    // Not a refusal this build may replay: an older build's `timeout` or
    // `not-worth-it` tombstone, or a hand-edited file. Treat the artifact as
    // absent and decide afresh — returning early here would freeze the receipt
    // on every replay with nothing in the ledger to explain it, and inventing a
    // code would put `distill-rejected:<anything>` into history.
    pinned = undefined
  }
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
  // for itself. A receipt is replayed `1 + remainingSteps` times, so the
  // most a distillation can ever save is (truncation view − footer) per replay,
  // and the least it costs is the receipt as input plus the output budget. When
  // even that most-optimistic product does not cover the cost, no answer can
  // pay back and the call is skipped — the one place a distillation is a
  // guaranteed loss, which is the end of a short-turn session.
  if (input.remainingSteps !== undefined && input.estimate !== undefined) {
    const verdict = payback(
      input.text,
      input.cfg,
      input.family,
      input.formatFooter,
      input.estimate,
      input.remainingSteps,
      input.cfg.distillation.maxOutputTokens,
    )
    if (verdict === 'not-worth') {
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
