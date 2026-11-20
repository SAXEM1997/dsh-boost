/**
 * The `llm/stream` hook body: the point where the plugin answers a model
 * request itself instead of calling the provider.
 *
 * ## The synchronous contract
 *
 * The host treats `llm/stream` as a **synchronous waterfall**: `next()` returns
 * an `AsyncIterable<StreamChunk>` and the host does `for await` over whatever
 * the listener returns. An `async` listener would hand the host a
 * `Promise<AsyncIterable>`, every request would fail with a `TypeError`, and the
 * plugin would break the product rather than degrade it (appendix §7). The
 * exported function therefore returns a **generator object synchronously**;
 * every `await` lives inside the generator.
 *
 * ## Rule order (fixed, checks before any side effect)
 *
 * 1. `purpose` set -> raw `next()`. The appendix sets `purpose` **only** for
 *    auxiliary calls, and the host issues several on the same session id: the
 *    plugin's selector (`boost-selector`), `dsh-compaction-basic`
 *    (`compaction`) and the session-title model (`session-title`). None is a
 *    conversation step, so all pass through untouched: never substituted,
 *    never observed into `usage.request()`, never settling a mark. Observing
 *    one would pair a substitution with the summarizer's usage and corrupt
 *    `saved_input_tokens` (obligation 7); synthesizing into one would break
 *    compaction and write a substitute receipt for a call that never ran.
 * 2. `receipts.stopped()` -> pass through, fail-closed. A store that cannot
 *    record evidence cannot justify a substitution.
 * 3. Visibility. `resolveSession(sessionId)` returning `undefined` means the
 *    session is not substitutable: pass through and clear that session's queue
 *    (the decision cannot be honoured any more).
 * 4. No pending entry -> pass through. This is the ordinary turn.
 * 5. Turn validity. The queue is cleared on the **new turn's first
 *    `post-execute`**, which happens after the new turn's first `llm/stream`.
 *    An entry whose `turn` differs from the session clock's turn belongs to a
 *    previous turn: synthesizing it would answer the new turn with an old
 *    decision, and its `callId` would even match at dispatch and be accepted.
 *    Compare, clear and pass through (obligation 4).
 * 6. Anchors intact. `ReceiptAnchors` has no turn field, so `entry.turn` being
 *    current is what makes the anchors current; only then is detection run
 *    against `options.messages` (obligation 6). A pruned carrier yields
 *    `pruned-reset`, a receipt that is no longer present yields
 *    `compaction-reset`; either clears queue + anchors and passes through.
 * 7. Synthesize: `markSubstituted` -> `{kind:'substitute'}` receipt ->
 *    `peek` (never `take`, obligation 3) -> `yield* synthesizeTurn(entry)`,
 *    **without calling `next()`**. The entry must survive to `tools/execute`,
 *    which is the consumer that enforces the tamper check.
 *
 * The hook never calls `budget.take()`: Task 23b already took the step at
 * `tools/post-execute`, and a second take would charge 2 of 8 per substitution
 * (obligation 2).
 *
 * ## Per-session state (obligation 1)
 *
 * `HookDeps` also carries single `clock`/`budget`/`usage` instances, and a
 * shared instance is cross-session contamination: another session's
 * `agent/request` sets this session's `callId` turn/step, a shared
 * `StepBudget(1)` starves one session, and a shared usage ledger pairs one
 * session's substitution with another session's request. `SessionRuntime`
 * (exported here) keys all three by `sessionId`; `HookDeps.sessions` accepts it,
 * and when present it is authoritative for both this hook and Task 23b's
 * helpers. The shipped wiring lives in `wireSessionEvents` (`src/index.ts`)
 * and is deliberately **two** listeners, not one:
 *
 * ```ts
 * const sessions = new SessionRuntime(cfg.stepsPerTurn)
 * registerHooks(ctx, { ...deps, sessions })
 *
 * // agent/pre-step: the non-deprecated clock seam. It fires once per proposed
 * // step, before prompt assembly, and copies the host turn/step.
 * ctx.on('agent/pre-step', (payload, next) => {
 *   sessions.onModelRequest(sessionId, payload.turn, payload.step)
 *   horizon.observe(sessionId, payload.turn, payload.step)
 *   return next()
 * })
 *
 * // agent/request: deprecated, kept for what the request waterfall alone
 * // yields: the resolved provider/model the selector inherits (after next()),
 * // the async visibility warm, and a clock fallback.
 * ctx.on('agent/request', async (payload, next) => {
 *   sessions.onModelRequest(sessionId, payload.turn, payload.step)
 *   await warmVisibility(scope, registry, payload.agent, sessionId, workspaces)
 *   const config = await next()
 *   rememberRoute(routes, sessionId, config)
 *   return config
 * })
 *
 * ctx.on('session/disposed', (session) => clearSession(deps, sessionId))
 * ```
 *
 * The split is intentional: `agent/pre-step` is the seam the host documents for
 * turn/step, while the selector's effective route is only available from the
 * request waterfall's resolved config. Both listeners copy the clock so a host
 * that drops the deprecated event still advances turns; only `agent/request`
 * warms the scope judgement and records the route today.
 *
 * `onModelRequest` copies the host turn/step (never a plugin count) and resets
 * that session's budget only when its turn changes. `notePlanTurn` is the
 * matching rollover for the plan store: the first real request of a new turn
 * drops the previous turn's plan before a new one can be parsed, so a stale
 * plan cannot drive a substitution in the new turn. `clearSession(deps, id)`
 * is the session-end cleanup: queue, anchors, plans, receipt state, the usage
 * mark and the runtime entry, all dropped together (obligation 10). No map is
 * ever handed out.
 *
 * ## Settlement (obligation 11)
 *
 * The first real request after a synthesized turn carries a `usage` chunk. The
 * pass-through branch maps it to `UsageLedger.request()` and, if a mark is
 * pending, calls `settle()` and appends `{kind:'substitute-settled'}` with the
 * measured counts (`'unknown'` stays `'unknown'`; it is never interpolated).
 * When a marked entry is abandoned (turn rollover, reset, stopped receipts,
 * lost visibility, a vanished queue entry) the mark is settled and discarded
 * **without** a settlement receipt: no substitution ran, so no saving exists to
 * report (obligation 5).
 *
 * ## Anchor detection and our own projection
 *
 * The host pruner rewrites an oversized receipt in place to
 * `head + PRUNE_MARKER + tail`, and apply-mode projection composes
 * `head + spill footer + tail`. Both preserve the receipt's head and tail, so
 * "the anchor text is not present verbatim" alone would classify our own
 * projection as compaction and disable substitution whenever projection is on.
 * `carriesAnchor` therefore accepts either the exact text or a body holding the
 * anchor's head *and* tail probes; the prune marker then decides
 * `pruned-reset`, and only a body that carries neither is `compaction-reset`.
 * Probes are measured in code points (a UTF-16 slice can split a surrogate
 * pair) and clamped to the smallest configured projection window, because
 * `resolveConfig` accepts `headChars`/`tailChars` below the probe length and a
 * window shorter than the probe would make our own projection look like
 * compaction.
 *
 * Everything here is contained: a foreign store, queue, ledger, clock or
 * resolver can degrade the decision, never throw out of the model request.
 * `resolveStreamPlan` is pure and synchronous; every effect (receipt writes,
 * clears, settlement) happens inside a generator after the decision.
 *
 * @module dsh-boost/hooks/llm-stream
 */
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { StepBudget } from '../admission/ledger.js'
import { UsageLedger } from '../admission/usage.js'
import { DEFAULT_CONFIG } from '../config.js'
import { looksPruned } from '../gate/invalidate.js'
import type { ReceiptAnchors } from '../gate/invalidate.js'
import { parsePlan } from '../gate/plan.js'
import { TurnClock } from './clock.js'
import { synthesizeTurn } from './synthesize.js'
import type { PendingEntry } from './pending.js'
import type { AuditedPendingEntry, HookDeps, SubstitutionEvidence } from './post-execute.js'
import {
  appendReceipt,
  callPreview,
  clearAnchors,
  clearPlan,
  clearPending,
  clockTurnOf,
  peekPending,
} from './session-state.js'

/** Which external rewrite invalidated a decision. */
type ResetCode = 'pruned-reset' | 'compaction-reset'

/** Default head/tail probe length for a receipt rewritten in place. */
const ANCHOR_PROBE_CHARS = 32

// ---------------------------------------------------------------------------
// Per-session runtime (obligation 1)
// ---------------------------------------------------------------------------

/** The three per-session pieces that must never be shared across sessions. */
interface SessionEntry {
  /** Host turn/step for this session. */
  clock: TurnClock
  /** This session's per-turn substitution budget. */
  budget: StepBudget
  /** This session's request pairing. */
  usage: UsageLedger
  /** The host turn whose plan store this session has been reconciled with. */
  planTurn?: number
}

/**
 * Per-session clock, budget and usage ledger.
 *
 * The host numbers turns and steps per session; a single instance therefore
 * lets one session's `agent/request` stamp another session's derived `callId`,
 * lets one session's `StepBudget(1)` starve the next, and pairs one session's
 * substitution with another session's request. The runtime keys all three by
 * `sessionId` and is the only place a per-session primitive is created.
 *
 * The map is private: callers get the objects, never the map, and
 * {@link SessionRuntime.clear} is the only way an entry leaves. `onModelRequest`
 * is driven by Task 23c-2 from the host's `agent/request` payload; this module
 * cannot see that event itself. A new turn resets that session's budget (the
 * budget is per-turn, not per-lifetime); a non-finite or backwards turn is
 * ignored by `TurnClock` and therefore resets nothing.
 */
export class SessionRuntime {
  private readonly bySession = new Map<string, SessionEntry>()
  private readonly stepsPerTurn: number

  constructor(stepsPerTurn: number = DEFAULT_CONFIG.stepsPerTurn) {
    // `StepBudget` already treats a non-positive max as empty; only a
    // non-finite value (which no resolved config can produce) falls back.
    this.stepsPerTurn = Number.isFinite(stepsPerTurn)
      ? stepsPerTurn
      : DEFAULT_CONFIG.stepsPerTurn
  }

  /** The session's clock, created on first use. */
  clockFor(sessionId: string): TurnClock {
    return this.entry(sessionId).clock
  }

  /** The session's turn budget, created on first use. */
  budgetFor(sessionId: string): StepBudget {
    return this.entry(sessionId).budget
  }

  /** The session's usage ledger, created on first use. */
  usageFor(sessionId: string): UsageLedger {
    return this.entry(sessionId).usage
  }

  /**
   * Record one host request for a session.
   *
   * `turn`/`step` are the host's numbers, copied through `TurnClock` (which
   * ignores non-finite and backwards turns). A turn change is the only thing
   * that resets the budget: a second request in one turn must keep the spend.
   */
  onModelRequest(sessionId: string, turn: number, step?: number): void {
    const entry = this.entry(sessionId)
    const before = entry.clock.turn()
    entry.clock.onModelRequest(turn, step)
    if (entry.clock.turn() !== before) entry.budget.reset()
  }

  /**
   * Reconcile this session's plan store with `turn`; `true` on a turn change.
   *
   * The plan lives in `HookDeps.plans` and is keyed by session only, so
   * without this note a turn that emits no new plan keeps the previous turn's
   * one, and its remaining steps can still drive a substitution. The stream
   * hook calls this once per **real** request (never for an auxiliary
   * `purpose`, which is not a conversation step) and clears the plan map when
   * it returns true, before that request's response could write a new plan.
   * The first call reports true so a seeded map cannot outlive its first
   * request; `clearSession` drops the note with the rest of the entry.
   */
  notePlanTurn(sessionId: string, turn: number): boolean {
    const entry = this.entry(sessionId)
    if (entry.planTurn === turn) return false
    entry.planTurn = turn
    return true
  }

  /** Drop everything this runtime holds for one session. */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  /** Number of sessions with state (not the number ever seen). */
  size(): number {
    return this.bySession.size
  }

  private entry(sessionId: string): SessionEntry {
    const existing = this.bySession.get(sessionId)
    if (existing !== undefined) return existing
    const entry: SessionEntry = {
      clock: new TurnClock(),
      budget: new StepBudget(this.stepsPerTurn),
      usage: new UsageLedger(),
    }
    this.bySession.set(sessionId, entry)
    return entry
  }
}

// ---------------------------------------------------------------------------
// Defensive readers: every foreign call is wrapped
// ---------------------------------------------------------------------------

/** The request's session id, or `undefined` when the host supplied none. */
function sessionIdOf(options: GenerateOptions | undefined): string | undefined {
  const id = options?.sessionId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * The session's clock: the per-session runtime when wired, the shared instance
 * otherwise.
 *
 * Exported because `tools/post-execute` must resolve the *same* clock for the
 * turn/step it stamps into a `callId`; two copies of this precedence rule could
 * drift and let the decision and the stream hook disagree about one session.
 */
export function sessionClock(deps: HookDeps, sessionId: string): TurnClock | undefined {
  try {
    return deps.sessions?.clockFor(sessionId) ?? deps.clock
  } catch {
    return deps.clock
  }
}

/** The session's turn budget; the same precedence as {@link sessionClock}. */
export function sessionBudget(deps: HookDeps, sessionId: string): StepBudget | undefined {
  try {
    return deps.sessions?.budgetFor(sessionId) ?? deps.budget
  } catch {
    return deps.budget
  }
}

/** The session's usage ledger; the same precedence as {@link sessionClock}. */
export function sessionUsage(deps: HookDeps, sessionId: string): UsageLedger | undefined {
  try {
    return deps.sessions?.usageFor(sessionId) ?? deps.usage
  } catch {
    return deps.usage
  }
}

/** The session's anchors without ever failing the request. */
function anchorsOf(deps: HookDeps, sessionId: string): ReceiptAnchors | undefined {
  try {
    return deps.anchors?.get(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Whether the receipt store has stopped writing, fail-closed.
 *
 * A missing `stopped` (a partial store in a test or an older host) is "not
 * stopped", so the ordinary path is unchanged. A store that *throws* cannot
 * record evidence, which is exactly what stopped means.
 */
export function receiptsStopped(deps: HookDeps): boolean {
  try {
    const store = deps.receipts
    if (store == null || typeof store.stopped !== 'function') return false
    return store.stopped() === true
  } catch {
    return true
  }
}

/**
 * Whether the session resolves to a workspace.
 *
 * The stream hook's rule only needs the resolver: a session that does not
 * resolve has no substitute-able workspace, so the decision cannot be honoured.
 * The live scope-document check lives in `tools/post-execute`, which owns the
 * async document read; `resolveSession` is synchronous by contract.
 */
function visibleSession(deps: HookDeps, sessionId: string): boolean {
  try {
    const resolve = deps.resolveSession
    if (typeof resolve !== 'function') return false
    return typeof resolve(sessionId) === 'string'
  } catch {
    return false
  }
}

/** The host turn and the entry's turn are the same, number or stringified number. */
function sameTurn(entryTurn: number | string, clockTurn: number): boolean {
  return String(entryTurn) === String(clockTurn)
}

/** A receipt's `turn` field is a number; entry turns may already be strings. */
function turnNumberOf(turn: number | string): number {
  if (typeof turn === 'number' && Number.isFinite(turn)) return turn
  const parsed = Number(turn)
  return Number.isFinite(parsed) ? parsed : 0
}

// ---------------------------------------------------------------------------
// Anchor detection against the outgoing messages (obligation 6)
// ---------------------------------------------------------------------------

/**
 * Every text-block body the model will see in this request.
 *
 * `RequestMessage.content` is an array of blocks; only `text` blocks carry
 * receipt bodies. Blocks are kept separate so a mixed message cannot make two
 * unrelated texts look like one receipt. A malformed message is skipped, never
 * a throw: `options.messages` is host-shaped data.
 */
function messageTexts(messages: unknown): string[] {
  if (!Array.isArray(messages)) return []
  const bodies: string[] = []
  for (const message of messages) {
    const content = (message as { content?: unknown } | null | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const { type, text } = block as { type?: unknown; text?: unknown }
      if (type === 'text' && typeof text === 'string') bodies.push(text)
    }
  }
  return bodies
}

/**
 * The head/tail probe windows, clamped to the projection's own windows.
 *
 * Our projection keeps `headChars`/`tailChars` code points of the receipt, so
 * a probe longer than a configured window can never match a projected body and
 * would report `compaction-reset`. `resolveConfig` accepts any finite value
 * (including 0), so the window is the smallest one any family configures,
 * capped at {@link ANCHOR_PROBE_CHARS}; a 0 window drops that side of the
 * probe and leaves only the other. With the design defaults this is 32/32.
 */
function anchorProbe(deps: HookDeps): { head: number; tail: number } {
  let head = ANCHOR_PROBE_CHARS
  let tail = ANCHOR_PROBE_CHARS
  try {
    const projection: unknown = deps.config?.projection
    if (typeof projection !== 'object' || projection === null) return { head, tail }
    for (const raw of Object.values(projection)) {
      const params = raw as { headChars?: unknown; tailChars?: unknown } | null
      if (typeof params?.headChars === 'number' && Number.isFinite(params.headChars)) {
        head = Math.min(head, Math.max(0, params.headChars))
      }
      if (typeof params?.tailChars === 'number' && Number.isFinite(params.tailChars)) {
        tail = Math.min(tail, Math.max(0, params.tailChars))
      }
    }
  } catch {
    return { head: ANCHOR_PROBE_CHARS, tail: ANCHOR_PROBE_CHARS }
  }
  return { head, tail }
}

/**
 * Whether `body` still carries `anchor`, verbatim or as an in-place rewrite.
 *
 * The host pruner replaces the middle of an oversized receipt with
 * `PRUNE_MARKER` while preserving a head and a tail; apply-mode projection
 * composes head + spill footer + tail. Both keep the anchor's beginning and
 * end, so a body holding both probes is the same receipt, rewritten by us or
 * by the host (and the marker then says which).
 *
 * Probes are sliced by **code point**, exactly like `truncate`: a UTF-16 slice
 * can end on half a surrogate pair, and a lone surrogate is not a substring a
 * correctly projected body has to contain. Short anchors whose two windows
 * would cover the whole text get no probe treatment: at that size the exact
 * text either is present or the receipt is gone.
 */
function carriesAnchor(
  body: string,
  anchor: string,
  probe: { head: number; tail: number },
): boolean {
  if (body.includes(anchor)) return true
  const points = Array.from(anchor)
  const headLen = Math.min(probe.head, points.length)
  const tailLen = Math.min(probe.tail, points.length)
  if (headLen === 0 && tailLen === 0) return false
  if (points.length <= headLen + tailLen) return false
  const head = headLen > 0 ? points.slice(0, headLen).join('') : ''
  const tail = tailLen > 0 ? points.slice(-tailLen).join('') : ''
  const start = headLen > 0 ? body.indexOf(head) : 0
  if (headLen > 0 && start === -1) return false
  if (tailLen > 0 && body.indexOf(tail, start + headLen) === -1) return false
  return true
}

/**
 * Why the decision's anchored receipts are no longer trustworthy, if they are.
 *
 * Marker precedence matches `invalidate`: any carried body that contains the
 * pruner literal means `pruned-reset`, because the pruner is the common case
 * and it leaves the receipt in place. Only when no anchor was pruned does a
 * missing carrier mean `compaction-reset` (the history was replaced by a
 * summary). No anchors at all is vacuously intact: `post-execute` always writes
 * them with a commit, but a missing evidence store must not block substitution
 * forever.
 *
 * An empty anchor cannot be located in any message and is skipped; `invalidate`
 * treats an empty anchor as a real value, but the stream hook has no receipt
 * body to compare it with, and refusing every substitution on one empty tool
 * result would be worse than the uncertainty.
 */
function anchorResetOf(
  anchors: ReceiptAnchors | undefined,
  messages: unknown,
  probe: { head: number; tail: number },
): ResetCode | undefined {
  if (anchors == null) return undefined
  const record: unknown = anchors.anchors
  if (typeof record !== 'object' || record === null) return undefined

  const texts = Object.values(record as Record<string, unknown>).filter(
    (text): text is string => typeof text === 'string' && text.length > 0,
  )
  if (texts.length === 0) return undefined

  const bodies = messageTexts(messages)
  let compacted = false
  for (const anchor of texts) {
    if (looksPruned(anchor)) return 'pruned-reset'
    const carriers = bodies.filter((body) => carriesAnchor(body, anchor, probe))
    if (carriers.length === 0) {
      compacted = true
      continue
    }
    if (carriers.some((body) => looksPruned(body))) return 'pruned-reset'
  }
  return compacted ? 'compaction-reset' : undefined
}

// ---------------------------------------------------------------------------
// The synchronous decision
// ---------------------------------------------------------------------------

/** A decision to refuse the pending entry before it is synthesized. */
interface AbandonPlan {
  /** The entry this request refuses to synthesize. */
  entry: PendingEntry
  /** Drop the session's queue entry (turn rollover, reset, invisible scope). */
  clearQueue: boolean
  /** Drop the session's anchors (only a reset invalidates the evidence). */
  clearAnchors: boolean
  /** Reset receipt to write, when the anchored evidence was invalidated. */
  reset?: { code: ResetCode; stepId: string; turn: number }
}

/** What one request is going to do, decided synchronously. */
type StreamPlan =
  | {
      kind: 'pass'
      sessionId: string | undefined
      abandon?: AbandonPlan
      /**
       * Discard the session's decision-time usage mark even when no queue entry
       * is left to abandon. A stopped store passes every request through, so
       * the decision will never be synthesized and its mark must not settle a
       * later real request as if it had run.
       */
      discardMark?: boolean
    }
  | { kind: 'synthesize'; sessionId: string; entry: PendingEntry }

/**
 * The rule order as pure, synchronous decision logic.
 *
 * Nothing here writes a receipt or takes a step: every check completes before
 * the first effect. `post-execute` already took the budget at the decision
 * point (obligation 2), so this function never touches the budget.
 */
function resolveStreamPlan(
  deps: HookDeps,
  options: GenerateOptions | undefined,
): StreamPlan {
  const sessionId = sessionIdOf(options)

  // The selector guard is the first rule and lives in `streamHook`, which
  // returns `next()` before this function runs: a selector request must not
  // even be observed, so it cannot become a plan.

  if (receiptsStopped(deps)) {
    // Fail-closed: the decision cannot be recorded, so it will never be
    // synthesized. Empty the queue and settle the decision-time mark even when
    // the queue entry is already gone (the dispatch side may have consumed it);
    // otherwise the mark would settle a later real request as a substitution.
    return passPlan(deps, sessionId, { clearQueue: true, clearAnchors: false }, true)
  }

  if (sessionId === undefined) return { kind: 'pass', sessionId }

  if (!visibleSession(deps, sessionId)) {
    return passPlan(deps, sessionId, { clearQueue: true, clearAnchors: false })
  }

  const entry = peekPending(deps, sessionId)
  if (entry === undefined) return { kind: 'pass', sessionId }

  const turn = clockTurnOf(deps, sessionId)
  if (turn === undefined || !sameTurn(entry.turn, turn)) {
    return {
      kind: 'pass',
      sessionId,
      abandon: { entry, clearQueue: true, clearAnchors: false },
    }
  }

  // A blank call id cannot be dispatched and must not be "repaired" here: the
  // execute-side tamper check would compare a different id and reject silently.
  if (typeof entry.callId !== 'string' || entry.callId.trim().length === 0) {
    return {
      kind: 'pass',
      sessionId,
      abandon: { entry, clearQueue: true, clearAnchors: false },
    }
  }

  const anchors = anchorsOf(deps, sessionId)
  const reset = anchorResetOf(anchors, options?.messages, anchorProbe(deps))
  if (reset !== undefined) {
    return {
      kind: 'pass',
      sessionId,
      abandon: {
        entry,
        clearQueue: true,
        clearAnchors: true,
        reset: {
          code: reset,
          stepId: typeof anchors?.stepId === 'string' ? anchors.stepId : 'root',
          turn: turn,
        },
      },
    }
  }

  return { kind: 'synthesize', sessionId, entry }
}

/**
 * A pass plan that abandons the session's pending entry, when one exists.
 *
 * `discardMark` makes the plan settle the usage mark even when no entry is
 * left; the stopped-store branch needs that because the dispatch side may
 * already have consumed the entry.
 */
function passPlan(
  deps: HookDeps,
  sessionId: string | undefined,
  abandons: { clearQueue: boolean; clearAnchors: boolean },
  discardMark = false,
): StreamPlan {
  if (sessionId === undefined) return { kind: 'pass', sessionId }
  const entry = peekPending(deps, sessionId)
  if (entry === undefined) return { kind: 'pass', sessionId, ...(discardMark ? { discardMark } : {}) }
  return {
    kind: 'pass',
    sessionId,
    abandon: { entry, ...abandons },
    ...(discardMark ? { discardMark } : {}),
  }
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * Consume the session's usage mark without reporting a saving.
 *
 * `markSubstituted` has no unmark: a mark left behind by an abandoned entry
 * would make the next real request settle a substitution that never ran
 * (obligation 5). `settle()` here is the discard, not a measurement. The parked
 * plan evidence goes with the mark: nothing will ever write its receipt.
 */
export function settleDiscarded(deps: HookDeps, sessionId: string): void {
  try {
    sessionUsage(deps, sessionId)?.settle()
  } catch {
    // A foreign ledger can only cost a measurement.
  }
  forgetEvidence(deps, sessionId)
}

/**
 * Plan/guards evidence parked between synthesis and settlement.
 *
 * The settled receipt is written at the first real request after the
 * synthesized turn, when the queue entry is already gone; the synth-time
 * receipt has it from the entry, this park hands it to the settle. Keyed by
 * `HookDeps` first so two plugin instances in one process cannot read each
 * other's session, and a `WeakMap` lets the whole map die with the assembly.
 */
const PENDING_EVIDENCE = new WeakMap<HookDeps, Map<string, SubstitutionEvidence>>()

/** Park the evidence for the session's next settlement, replacing any earlier. */
function rememberEvidence(deps: HookDeps, sessionId: string, evidence: SubstitutionEvidence): void {
  let bySession = PENDING_EVIDENCE.get(deps)
  if (bySession === undefined) {
    bySession = new Map()
    PENDING_EVIDENCE.set(deps, bySession)
  }
  bySession.set(sessionId, evidence)
}

/** Take (and forget) the evidence one settlement consumes. */
function takeEvidence(deps: HookDeps, sessionId: string): SubstitutionEvidence | undefined {
  const bySession = PENDING_EVIDENCE.get(deps)
  const evidence = bySession?.get(sessionId)
  bySession?.delete(sessionId)
  return evidence
}

/** Drop evidence that no settlement will ever consume. */
function forgetEvidence(deps: HookDeps, sessionId: string): void {
  PENDING_EVIDENCE.get(deps)?.delete(sessionId)
}

/** Record the synthesis mark for the session's pairing. */
function markSubstitutedFor(deps: HookDeps, sessionId: string, candidateId: string): void {
  try {
    sessionUsage(deps, sessionId)?.markSubstituted(candidateId)
  } catch {
    // A ledger miss costs a measurement, never this turn.
  }
}

/** The synth-time receipt: the event, before any measurement exists. */
async function appendSubstituteReceipt(
  deps: HookDeps,
  sessionId: string,
  entry: PendingEntry,
): Promise<void> {
  const evidence = (entry as AuditedPendingEntry).evidence
  await appendReceipt(deps, {
    version: 1,
    ts: new Date().toISOString(),
    sessionId,
    turn: turnNumberOf(entry.turn),
    stepId: 'root',
    kind: 'substitute',
    code: 'substituted',
    tool: entry.name,
    callId: entry.callId,
    candidateId: entry.candidateId,
    // G2: the plan the decision came from and the guards that qualified the
    // candidate, capped by `substitutionEvidence` before they reach the line.
    ...(evidence === undefined ? {} : evidence),
    // The synthesized call has no tool result yet; its name and bound args are
    // the evidence for why this turn asked for it.
    args: entry.args,
    preview: callPreview(entry.name, entry.args),
    // Measured only after the next real request; `'unknown'` never counts.
    saved_input_tokens: 'unknown',
    cache_hit_delta: null,
    output_tokens: 'unknown',
  })
}

/** Settle a pending mark at the first after-mark request and report it. */
async function settlePendingMark(deps: HookDeps, sessionId: string): Promise<void> {
  const ledger = sessionUsage(deps, sessionId)
  if (ledger === undefined) return

  let candidateId: string | undefined
  let settled: ReturnType<UsageLedger['settle']>
  try {
    const pending = ledger.pendingCandidateId()
    if (typeof pending !== 'string' || pending.length === 0) return
    candidateId = pending
    settled = ledger.settle()
  } catch {
    return
  }

  await appendReceipt(deps, {
    version: 1,
    ts: new Date().toISOString(),
    sessionId,
    turn: clockTurnOf(deps, sessionId) ?? 0,
    stepId: 'root',
    kind: 'substitute-settled',
    code: 'substitute-settled',
    candidateId,
    // G2 applies to the settled line too: the goal and guards are the same
    // evidence the synth-time line carried, parked when that line was written.
    ...(takeEvidence(deps, sessionId) ?? {}),
    saved_input_tokens: settled.saved_input_tokens,
    cache_hit_delta: settled.cache_hit_delta,
    output_tokens: settled.output_tokens,
  })
}

/** Map one `usage` chunk onto the ledger's count names (appendix §7). */
function recordUsage(deps: HookDeps, sessionId: string, usage: TokenUsage | undefined): void {
  if (usage === undefined || usage === null) return
  const ledger = sessionUsage(deps, sessionId)
  if (ledger === undefined) return
  try {
    ledger.request({
      input: usage.inputTokens,
      cacheRead: usage.cacheReadTokens ?? 0,
      output: usage.outputTokens,
    })
  } catch {
    // A foreign ledger can only cost a measurement.
  }
}

/**
 * Store the plan a real response carried, or drop the old one when it carried
 * none.
 *
 * The protocol tells the model to omit the block when unsure, so a response
 * that does not contain a valid plan is also the model withdrawing the previous
 * one. Keeping the old plan would let it fire against a much later receipt the
 * model never wrote it for. A malformed block is likewise not a plan.
 */
function rememberPlan(deps: HookDeps, sessionId: string | undefined, text: string): void {
  if (sessionId === undefined) return
  try {
    const plans = deps.plans
    if (plans == null || typeof plans.set !== 'function') return
    const parsed = text.length === 0 ? { error: 'no-plan' as const } : parsePlan(text)
    if ('plan' in parsed) plans.set(sessionId, parsed.plan)
    else plans.delete(sessionId)
  } catch {
    // A plan that cannot be stored only costs a later decision.
  }
}

/**
 * Abandon the pending entry: settle the mark, drop what the decision owned and
 * write the reset receipt that explains it.
 */
async function applyAbandon(
  deps: HookDeps,
  sessionId: string,
  abandon: AbandonPlan,
): Promise<void> {
  settleDiscarded(deps, sessionId)
  if (abandon.clearQueue) clearPending(deps, sessionId)
  if (abandon.clearAnchors) clearAnchors(deps, sessionId)
  // A plan that produced this abandoned decision must not survive to drive a
  // later receipt, for either reset kind (and for the non-reset abandons too).
  clearPlan(deps, sessionId)
  if (abandon.reset === undefined) return
  await appendReceipt(deps, {
    version: 1,
    ts: new Date().toISOString(),
    sessionId,
    turn: abandon.reset.turn,
    stepId: abandon.reset.stepId,
    kind: 'reset',
    code: abandon.reset.code,
    tool: abandon.entry.name,
    callId: abandon.entry.callId,
    candidateId: abandon.entry.candidateId,
  })
}

/**
 * The ordinary turn: observe the real stream.
 *
 * `next()` has already been called by the hook body, so the upstream iterable
 * exists before the generator starts. Usage is mapped and a pending mark is
 * settled at the `usage` chunk (which the host emits before `finish`); text is
 * accumulated for `parsePlan`. A consumer that cancels the stream never reaches
 * the plan store, because the code after the loop only runs on normal
 * completion.
 */
async function* observeBranch(
  deps: HookDeps,
  sessionId: string | undefined,
  upstream: AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  let text = ''
  for await (const chunk of upstream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk?.type === 'usage' && sessionId !== undefined) {
      recordUsage(deps, sessionId, chunk.usage)
      await settlePendingMark(deps, sessionId)
    }
    yield chunk
  }
  // The host emits `usage` before `finish`, so this is normally a no-op; a
  // route that omits the chunk still ends the request, and the mark must be
  // consumed there rather than attributed to a later request (`'unknown'`,
  // which status does not count).
  if (sessionId !== undefined) await settlePendingMark(deps, sessionId)
  rememberPlan(deps, sessionId, text)
}

/**
 * The synthesized turn.
 *
 * No `next()`: the plugin answers instead of the model. The entry is re-read
 * with `peek` (never `take`) so it survives to `tools/execute`; if it vanished
 * between the synchronous decision and the first generator step, the mark is
 * discarded and the real model answers, because a substitution that cannot be
 * dispatched must not be faked.
 */
async function* synthesizeBranch(
  deps: HookDeps,
  sessionId: string,
  entry: PendingEntry,
  next: () => AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  const current = peekPending(deps, sessionId)
  if (current === undefined || current.callId !== entry.callId) {
    settleDiscarded(deps, sessionId)
    yield* observeBranch(deps, sessionId, next())
    return
  }

  markSubstitutedFor(deps, sessionId, current.candidateId)
  // Park the plan evidence for the settled line, which runs at the next real
  // request after this entry has left the queue.
  const evidence = (current as AuditedPendingEntry).evidence
  if (evidence !== undefined) rememberEvidence(deps, sessionId, evidence)
  await appendSubstituteReceipt(deps, sessionId, current)
  yield* synthesizeTurn(current)
}

// ---------------------------------------------------------------------------
// The exported hook and session-end cleanup
// ---------------------------------------------------------------------------

/**
 * Build the `llm/stream` listener.
 *
 * Returns a **synchronous** function returning an `AsyncIterable`; see the
 * module header for why an `async` function here breaks every request. Any
 * `purpose`-tagged call (selector, compaction, session-title) returns `next()`
 * untouched: never observed, never substituted. Every real request is decided
 * synchronously by {@link resolveStreamPlan} and then answered by a generator.
 */
export function streamHook(
  deps: HookDeps,
): (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk> {
  return (options, next) => {
    // Any purpose-tagged request is auxiliary (appendix §1): the selector, the
    // compaction summarizer, the session-title model. They share the session
    // id but are not conversation steps, so they pass through raw: no
    // substitution, no usage observation, no settlement, no plan rollover.
    if (options?.purpose !== undefined) return next()

    const sessionId = sessionIdOf(options)
    if (sessionId !== undefined) {
      const turn = clockTurnOf(deps, sessionId)
      if (turn !== undefined) {
        let rolledOver = false
        try {
          rolledOver = deps.sessions?.notePlanTurn(sessionId, turn) === true
        } catch {
          rolledOver = false
        }
        if (rolledOver) clearPlan(deps, sessionId)
      }
    }

    let plan: StreamPlan
    try {
      plan = resolveStreamPlan(deps, options)
    } catch {
      // A bug in our own decision logic must not take the model request down.
      return next()
    }

    if (plan.kind === 'synthesize') {
      return synthesizeBranch(deps, plan.sessionId, plan.entry, next)
    }

    // Call `next()` synchronously, exactly like the pass-through stub: the
    // returned generator only delays consumption, not the waterfall step.
    const upstream = next()
    const observed = async function* (): AsyncGenerator<StreamChunk> {
      if (plan.sessionId !== undefined) {
        // Order matters only for evidence: the discard drops the parked
        // plan/guards, and `applyAbandon` then clears the rest. Both settle
        // calls are idempotent.
        if (plan.discardMark === true) settleDiscarded(deps, plan.sessionId)
        if (plan.abandon !== undefined) await applyAbandon(deps, plan.sessionId, plan.abandon)
      }
      yield* observeBranch(deps, plan.sessionId, upstream)
    }
    return observed()
  }
}

/**
 * Drop every per-session trace the plugin keeps for `sessionId`.
 *
 * This is the session-end cleanup `src/index.ts` calls from its
 * `session/disposed` listener: the receipt/dispatch store ships its own
 * `clear`, but it does not own the queue, the anchors, the plan map or the
 * per-session runtime, so the caller would otherwise have to know four separate
 * clears. A pending usage mark is settled first so a mark cannot outlive the
 * session it belongs to.
 */
export function clearSession(deps: HookDeps, sessionId: string): void {
  settleDiscarded(deps, sessionId)
  clearPending(deps, sessionId)
  clearAnchors(deps, sessionId)
  clearPlan(deps, sessionId)
  try {
    // Projection locators are session-scoped evidence: a disposed session must
    // not leave its spill paths behind for the next session id to inherit.
    deps.retrievals?.clear(sessionId)
  } catch {
    // Same: each clear is independent.
  }
  try {
    deps.sessionState?.clear(sessionId)
  } catch {
    // Same: each clear is independent.
  }
  try {
    deps.sessions?.clear(sessionId)
  } catch {
    // Same.
  }
}
