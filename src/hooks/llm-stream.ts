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
 *    plugin's selector (`boost-selector`), receipt distillation
 *    (`boost-distill`, ticket #10 — a timed-out distillation is persisted from
 *    this branch through `attempts`, without touching observation or
 *    settlement), `dsh-compaction-basic`
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
 * 5. Anchors readable and intact. A decision whose anchors were never written
 *    (the commit's `set` failed), whose store holds no record, or whose store
 *    throws cannot be verified at all; all three fail closed through the reset
 *    path (row 28). With a record present, detection runs against
 *    `options.messages` (obligation 6). A pruned carrier yields
 *    `pruned-reset`, a receipt that is no longer present yields
 *    `compaction-reset`; either clears queue + anchors and passes through. A
 *    body that only shares the anchor's head and tail is **not** a carrier: it
 *    must also carry the pruner marker or our projection's head line, or a
 *    middle edit would pass for the original text.
 * 6. Turn validity. The queue is cleared on the **new turn's first
 *    `post-execute`**, which happens after the new turn's first `llm/stream`.
 *    An entry whose `turn` differs from the session clock's turn belongs to a
 *    previous turn: synthesizing it would answer the new turn with an old
 *    decision, and its `callId` would even match at dispatch and be accepted.
 *    Compare, clear and pass through (obligation 4). This runs after the anchor
 *    read: an entry that is dead by identity but also lost its evidence still
 *    reports the reset, while one with intact anchors is dropped silently.
 * 7. Step still payable. `post-execute` already took the entry's step, but the
 *    same decision can be replayed (a retried request, a re-enqueue at one
 *    step). The per-turn synthesis tally and the budget's paid-step count are
 *    re-checked immediately before synthesizing; an entry whose step can no
 *    longer be honoured is dropped through the abandon path (settling its mark
 *    as discarded) instead of emitting a duplicate `callId`.
 * 8. Synthesize: `markSubstituted` -> `{kind:'substitute'}` receipt ->
 *    `peek` (never `take`, obligation 3) -> `yield* synthesizeTurn(entry)`.
 *    The upstream iterator is resolved synchronously at the waterfall point on
 *    every path, but the synthesis branch does not consume it. The entry must
 *    survive to `tools/execute`, which is the consumer that enforces the
 *    tamper check.
 *
 * The hook never calls `budget.take()`: Task 23b already took the step at
 * `tools/post-execute`, and a second take would charge 2 of 8 per substitution
 * (obligation 2). It only reads `count()` to verify that a paid step backs the
 * synthesis.
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
 * and is deliberately **two** clock listeners, not one:
 *
 * ```ts
 * const sessions = new SessionRuntime(cfg.stepsPerTurn)
 * registerHooks(ctx, { ...deps, sessions })
 *
 * // agent/pre-step: the non-deprecated clock seam. It fires once per proposed
 * // step AFTER prompt assembly (the host assembles at
 * // `@deepseek-ai/dsh-agent-loop/lib/index.js:692`, then dispatches pre-step
 * // at `:695`), and copies the host turn/step.
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
 * that drops the deprecated event still advances turns. Both record the route:
 * `agent/pre-step` from the captured `modelSelection` (the primary source since
 * row 37), and `agent/request` from the resolved config as the fallback for
 * hosts that only populate it there. The visibility warm is owned by the
 * `system-prompt/assemble` listener (also in `wireSessionEvents`), which the
 * host runs **before** `agent/pre-step`; `agent/request`'s call is only a
 * fallback. This hook sees a warm judgement only because of that assemble
 * listener — a cold-cache read here would reintroduce the D4 prompt
 * invalidation, so do not move the warm back onto the pre-step seam.
 *
 * `onModelRequest` copies the host turn/step (never a plugin count) and resets
 * that session's budget only when its turn changes. `notePlanTurn` is the
 * matching rollover for the plan store: the first real request of a new turn
 * drops the previous turn's plan before a new one can be parsed, so a stale
 * plan cannot drive a substitution in the new turn. `clearSession(deps, id)`
 * is the session-end cleanup: queue, anchors, plans, receipt state, the usage
 * mark, the runtime entry and any shared-instance loan it holds, all dropped
 * together (obligation 10). No map is ever handed out.
 *
 * ## Settlement (obligation 11)
 *
 * The first real request after a synthesized turn carries a `usage` chunk. The
 * pass-through branch maps it to `UsageLedger.request()` and, if a mark is
 * pending, calls `settle()` and appends `{kind:'substitute-settled'}` with the
 * measured counts (`'unknown'` stays `'unknown'`; it is never interpolated).
 * When a marked entry is abandoned (turn rollover, reset, stopped receipts,
 * lost visibility, an unpayable or already-synthesized step, a vanished queue
 * entry) the mark is settled and discarded **without** a settlement receipt: no
 * substitution ran, so no saving exists to report (obligation 5).
 *
 * ## Anchor detection and our own projection
 *
 * The host pruner rewrites an oversized receipt in place to
 * `head + PRUNE_MARKER + tail`, and apply-mode projection composes
 * `head line + head + spill footer + tail`. Both preserve the receipt's head
 * and tail, so "the anchor text is not present verbatim" alone would classify
 * our own projection as compaction and disable substitution whenever projection
 * is on. Two *outer* shapers also rewrite a receipt: `dsh-spill-policy` for
 * non-`read` tools and `dsh-tool-fs-search` for `glob`/`grep`. The spill policy
 * keeps a head and a tail and appends its footer after the tail; fs-search
 * keeps the head of an over-cap page and appends its footer after it. Either
 * way a rewrite can end in a notice instead of in the anchor's last code
 * points.
 *
 * `carriesAnchor` therefore accepts the exact text, or a body holding the
 * anchor's head *and* tail probes **plus** rewrite evidence: the prune marker
 * (which then decides `pruned-reset`), the projection head line, whose
 * `output N chars; showing first H and last T` counts must name this anchor's
 * length and windows, or a spill-style footer from an outer shaper, with the
 * anchor's head at the very start and its tail at the very end of the rewritten
 * body (or before that trailing footer). A shaper that drops the tail — an
 * over-cap fs-search page — is not a carrier: the model no longer holds the
 * anchor's end, so the decision is refused. A full receipt with the same probes
 * but a different middle — a file edited and re-read — carries none of that
 * evidence, so it is a lost anchor (`compaction-reset`) rather than a
 * substitution against content the model no longer holds.
 *
 * Probes are measured in code points (a UTF-16 slice can split a surrogate
 * pair) and clamped to the smallest configured projection window, because
 * `resolveConfig` accepts `headChars`/`tailChars` below the probe length and a
 * window shorter than the probe would make our own projection look like
 * compaction.
 *
 * Everything here is contained: a foreign store, queue, ledger, clock or
 * resolver can degrade the decision, never throw out of the model request.
 * `resolveStreamPlan` is synchronous and writes no receipt; its only state is
 * the per-turn synthesis tally, and every receipt/queue effect (writes, clears,
 * settlement) happens inside a generator after the decision.
 *
 * @module dsh-boost/hooks/llm-stream
 */
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { StepBudget } from '../admission/ledger.js'
import { DISTILL_PURPOSE } from '../distill/llm.js'
import { UsageLedger } from '../admission/usage.js'
import { DEFAULT_CONFIG } from '../config.js'
import { looksPruned, PRUNE_MARKER } from '../gate/invalidate.js'
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
  /**
   * The session whose usage ledger last recorded a real request.
   *
   * `boost status` reports one ledger, and a cache rate is only meaningful
   * within one session. The latest-request pointer is what makes "most recent
   * request" well defined across sessions without merging their request
   * sequences (which would count the first request of one session as a prefix
   * drop against another session's last request).
   */
  private latestUsageSession: string | undefined

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
   * Note that this session's ledger just recorded a real request.
   *
   * Called after {@link UsageLedger.request} succeeds, never on a read: status
   * must point at the session that produced the latest measurement, not at
   * whichever session happened to be touched last by a decision path.
   */
  noteUsage(sessionId: string): void {
    if (this.bySession.has(sessionId)) this.latestUsageSession = sessionId
  }

  /**
   * The ledger of the session that recorded the latest real request.
   *
   * `undefined` before the first request and after that session is disposed.
   * Never creates an entry: a status read must not keep a session alive.
   */
  latestUsage(): UsageLedger | undefined {
    const sessionId = this.latestUsageSession
    if (sessionId === undefined) return undefined
    return this.bySession.get(sessionId)?.usage
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
    if (this.latestUsageSession === sessionId) this.latestUsageSession = undefined
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
 * Which session has been lent each shared fallback instance.
 *
 * `apply` always passes `sessions`, so this exists for embedders and tests that
 * hand in one `clock`/`budget`/`usage` instead. Those three carry per-session
 * state — a turn's step counter, a pending usage mark — so lending one to a
 * second session attributes B's tokens to A's candidate. That surfaces as a
 * saving that never happened, which is the one error this plugin must not
 * produce. Ownership is keyed by the **instance**, not by the deps object: two
 * assemblies that share the same three objects (the pattern the fallback exists
 * for) must agree on the one session they serve, or each claims its own loan
 * and both borrow. The first session to arrive keeps the loan; every other
 * session gets `undefined`, which each caller already reads as "no
 * substitution" (fail closed), and the warning is emitted once per deps object
 * rather than per call. `clearSession` drops the loans its session holds, so a
 * disposed owner does not lock the instance for the rest of the process.
 */
const fallbackLoans = new WeakMap<object, { sessionId: string }>()

/** Deps objects already warned about a refused loan (once each, not per call). */
const fallbackWarned = new WeakSet<object>()

/** Whether the shared fallback instance may serve this session. */
function mayBorrowShared(instance: object, deps: HookDeps, sessionId: string): boolean {
  const held = fallbackLoans.get(instance)
  if (held === undefined) {
    fallbackLoans.set(instance, { sessionId })
    return true
  }
  if (held.sessionId === sessionId) return true
  if (!fallbackWarned.has(deps)) {
    fallbackWarned.add(deps)
    try {
      deps.logger?.warn(
        `dsh-boost: no per-session runtime is wired, and session ${sessionId} is not the one already using the shared clock/budget/usage; substitution stays off for it rather than mixing two sessions' measurements`,
      )
    } catch {
      // A logger that throws must not turn a measurement guard into a failure.
    }
  }
  return false
}

/** Release the shared-instance loans the disposing session holds. */
function releaseSharedLoans(deps: HookDeps, sessionId: string): void {
  for (const instance of [deps.clock, deps.budget, deps.usage]) {
    if (instance === undefined) continue
    if (fallbackLoans.get(instance)?.sessionId === sessionId) fallbackLoans.delete(instance)
  }
}

/**
 * The session's clock: the per-session runtime when wired, the shared instance
 * otherwise — but only for the one session that instance belongs to.
 *
 * Exported because `tools/post-execute` must resolve the *same* clock for the
 * turn/step it stamps into a `callId`; two copies of this precedence rule could
 * drift and let the decision and the stream hook disagree about one session.
 */
export function sessionClock(deps: HookDeps, sessionId: string): TurnClock | undefined {
  try {
    const owned = deps.sessions?.clockFor(sessionId)
    if (owned !== undefined) return owned
  } catch {
    // Fall through to the shared instance, subject to the ownership rule.
  }
  return deps.clock !== undefined && mayBorrowShared(deps.clock, deps, sessionId)
    ? deps.clock
    : undefined
}

/** The session's turn budget; the same precedence as {@link sessionClock}. */
export function sessionBudget(deps: HookDeps, sessionId: string): StepBudget | undefined {
  try {
    const owned = deps.sessions?.budgetFor(sessionId)
    if (owned !== undefined) return owned
  } catch {
    // Fall through to the shared instance, subject to the ownership rule.
  }
  return deps.budget !== undefined && mayBorrowShared(deps.budget, deps, sessionId)
    ? deps.budget
    : undefined
}

/**
 * Whether a substitution budget is wired at all.
 *
 * `undefined` from {@link sessionBudget} has two meanings and callers must not
 * conflate them (row 21): with neither `deps.budget` nor a per-session runtime,
 * the embedder never asked for a cap, so the substitution is unconstrained; a
 * wired budget that this session may not borrow is the opposite — the shared
 * instance belongs to another session and the step cannot be paid. Treating the
 * refusal as "no cap" let an unbudgeted substitution through without ever
 * incrementing the live budget.
 */
export function budgetWired(deps: HookDeps): boolean {
  return deps.budget !== undefined || deps.sessions !== undefined
}

/** The session's usage ledger; the same precedence as {@link sessionClock}. */
export function sessionUsage(deps: HookDeps, sessionId: string): UsageLedger | undefined {
  try {
    const owned = deps.sessions?.usageFor(sessionId)
    if (owned !== undefined) return owned
  } catch {
    // Fall through to the shared instance, subject to the ownership rule.
  }
  return deps.usage !== undefined && mayBorrowShared(deps.usage, deps, sessionId)
    ? deps.usage
    : undefined
}

/** What the session's anchor store answered. */
type AnchorRead =
  | { kind: 'record'; anchors: ReceiptAnchors }
  /** The store answered, but holds no record for a session with a live decision. */
  | { kind: 'cold' }
  /** The store is absent or its read threw: nothing can be verified. */
  | { kind: 'unreadable' }

/**
 * The session's anchors, distinguishing a record from a cold store.
 *
 * A substitution is only legitimate against the receipt the model still holds,
 * so every missing answer is a lost anchor (row 28). `post-execute` writes
 * anchors with every commit, so a live queue entry with no record means that
 * write failed; synthesizing then would skip the only verification the design
 * has. A throwing read is equally unverifiable. Both fail closed through the
 * ordinary reset path instead of substituting on unseen evidence.
 */
function anchorsOf(deps: HookDeps, sessionId: string): AnchorRead {
  const store = deps.anchors
  if (store == null || typeof store.get !== 'function') return { kind: 'unreadable' }
  try {
    const anchors = store.get(sessionId)
    return anchors == null ? { kind: 'cold' } : { kind: 'record', anchors }
  } catch {
    return { kind: 'unreadable' }
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
 * The head line our own projection writes: `[output N chars; showing first H
 * and last T]`. The counts use `toLocaleString('en-US')`, hence the commas.
 */
const PROJECTION_HEADER = /^\[output ([\d,]+) chars; showing first ([\d,]+) and last ([\d,]+)\]$/

/**
 * The head line a distilled replacement writes: `[distilled from N chars; Q]`,
 * where `N` is the anchor's length in code points and `Q` the family's short
 * question name. A distilled view has no windows to compare (it is not a
 * cut), so the count is its whole identity evidence.
 */
const DISTILLED_HEADER = /^\[distilled from ([\d,]+) chars; [A-Za-z0-9_-]+\]$/

/** One `en-US`-formatted count from a projection head line. */
function headerCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw.replaceAll(',', ''))
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * Whether `body` is our own projection of `anchor`.
 *
 * A projected receipt is `head line + head + spill footer + tail`. The head
 * line names the anchor's total code points and both window sizes, and the two
 * windows are the anchor's own first/last code points. A full receipt that
 * merely shares the anchor's head and tail cannot produce that line, so this
 * closes the probe collision without reading the middle (which the projection
 * removed) and without a new stored field. Old anchors that cannot be verified
 * this way simply do not match, which fails closed.
 */
function ownProjectionCarries(body: string, anchor: string): boolean {
  const newline = body.indexOf('\n')
  if (newline === -1) return false
  const match = PROJECTION_HEADER.exec(body.slice(0, newline))
  // The distillation marker (ticket #10) is the head line of a receipt replaced
  // by its distilled body. It names the anchor's total length — the identity
  // evidence — but no windows, so the content check below does not apply.
  if (match === null) {
    const distilled = DISTILLED_HEADER.exec(body.slice(0, newline))
    const output = distilled === null ? undefined : headerCount(distilled[1])
    return output !== undefined && output === Array.from(anchor).length
  }
  const output = headerCount(match[1])
  const headLen = headerCount(match[2])
  const tailLen = headerCount(match[3])
  if (output === undefined || headLen === undefined || tailLen === undefined) return false
  if (headLen <= 0 && tailLen <= 0) return false
  const points = Array.from(anchor)
  if (output !== points.length) return false
  if (headLen + tailLen >= points.length) return false
  const head = headLen > 0 ? points.slice(0, headLen).join('') : ''
  const tail = tailLen > 0 ? points.slice(-tailLen).join('') : ''
  if (!body.startsWith(`${match[0]}\n${head}`)) return false
  if (tailLen === 0) return true
  // Our own replacement may append rescued marker lines after the tail (design
  // §5.4-4), so the body does not have to *end* with the tail — it has to
  // contain it at the position the header implies, followed by nothing but
  // those markers. A rewritten middle still fails, because the tail must sit
  // where the two windows put it.
  const tailAt = body.indexOf(`\n${tail}`)
  if (tailAt === -1) return false
  const rest = body.slice(tailAt + 1 + tail.length)
  if (rest === '') return true
  return rest.startsWith('\n') && PRESERVED_SIGNAL_LINE.test(rest)
}

/**
 * The host footer shape a distilled replacement must carry.
 *
 * Anchored at the end of the text it is applied to: the notice names a byte
 * count and a locator, exactly the `(Omitted N bytes. … stored at: …)` shape
 * `dsh-spill-policy` renders.
 */
const DISTILLED_FOOTER = /\n\n\([^)]*\d[\d,]*\s*bytes[^)]* stored at: [^)]+\)$/

/**
 * Whether `body` is our own **distilled** replacement of `anchor`.
 *
 * A distilled view is `[distilled from N chars; Q]` + the distilled body + the
 * host footer, and keeps no windows of the anchor. Its identity evidence is the
 * marker naming the anchor's exact length **plus** a footer — the marker alone
 * would turn any body into a carrier, which is the failure mode
 * `prunedCarries` exists to avoid. The two parts can arrive together (the
 * caller passed the whole body) or split (the caller stripped the trailing
 * footer and passed the head): both are checked here.
 *
 * The body text itself cannot be verified from a rendered history; that is
 * what the quote check did when the product was accepted.
 */
function distilledCarries(body: string, anchor: string, footerStripped = false): boolean {
  const newline = body.indexOf('\n')
  if (newline === -1) return false
  const match = DISTILLED_HEADER.exec(body.slice(0, newline))
  const output = match === null ? undefined : headerCount(match[1])
  if (output === undefined || output !== Array.from(anchor).length) return false
  return footerStripped || DISTILLED_FOOTER.test(body)
}

/** One rescued marker line, or several of them, each on its own line. */
const PRESERVED_SIGNAL_LINE = /^\n(?:\[exit code: -?\d+\]|exit_code\s*[:=]\s*-?\d+|is_error\s*[:=]\s*(?:true|false))(?:\n(?:\[exit code: -?\d+\]|exit_code\s*[:=]\s*-?\d+|is_error\s*[:=]\s*(?:true|false)))*$/i

/**
 * Whether `body` is the anchor rewritten **by the host pruner**, and nothing
 * else.
 *
 * `looksPruned` alone is not identity: any body that embeds the anchor's pruned
 * text — a `read` of a session log, the case `invalidate` documents as
 * occurring — carries the marker too, so a receipt that was compacted away
 * could be declared "still carried" and a decision would survive on evidence
 * the model no longer holds.
 *
 * The pruner replaces the middle with a single marker and keeps a head and a
 * tail, so a genuine carrier is `head + marker + tail` with nothing before the
 * head and nothing after the tail. Requiring the carrier to *start* with the
 * anchor's first `head` code points and *end* with its last `tail` ones — the
 * same windows `ownProjectionCarries` derives for our own rewrite — rejects the
 * wrapper: its head is the wrapper's opening line, not the anchor's.
 */
function prunedCarries(body: string, anchor: string): boolean {
  const marker = body.indexOf(PRUNE_MARKER)
  if (marker === -1) return false
  // Exactly one marker: two would mean this is not one pruned receipt.
  if (body.indexOf(PRUNE_MARKER, marker + PRUNE_MARKER.length) !== -1) return false
  const head = body.slice(0, marker)
  const tail = body.slice(marker + PRUNE_MARKER.length)
  if (head.length === 0 || tail.length === 0) return false
  const points = Array.from(anchor)
  const headPoints = Array.from(head)
  const tailPoints = Array.from(tail)
  if (headPoints.length + tailPoints.length >= points.length) return false
  return (
    points.slice(0, headPoints.length).join('') === head &&
    points.slice(-tailPoints.length).join('') === tail
  )
}

/**
 * The locator phrase every host spill notice carries.
 *
 * Both outer shapers end a rewrite with a parenthesised notice naming where the
 * complete result lives: `dsh-spill-policy` renders `(Omitted N bytes. Full
 * formatted result stored at: …)` and `dsh-tool-fs-search` renders `(Showing N
 * of M paths. Full sorted result stored at: …)`. The counts and the sentence
 * around them differ by shaper and result kind; the locator phrase is the part
 * both always include.
 */
const SPILL_LOCATION = ' stored at: '

/**
 * Where a trailing host-shape spill footer starts, or `-1` when the body does
 * not end in one.
 *
 * The footer is a final parenthesised block introduced by a blank line, and the
 * locator phrase separates it from an ordinary parenthetical. This is a shape
 * check, not authentication: the identity evidence remains the anchor's own
 * head and tail, which the caller requires at the two ends of the rewritten
 * body.
 */
function trailingSpillFooterStart(body: string): number {
  if (!body.endsWith(')')) return -1
  const start = body.lastIndexOf('\n\n(')
  if (start === -1) return -1
  const notice = body.slice(start + 2)
  if (!notice.includes(SPILL_LOCATION)) return -1
  // The notice must also name how much was dropped. A footer carrying only a
  // locator is not evidence that a shaper rewrote this receipt, and without a
  // count the only remaining identity check would be "shares the first and last
  // window" — the edited-then-re-read collision `prunedCarries` rejects.
  return OMITTED_BYTES.test(notice) ? start : -1
}

/** An omitted-byte notice: the only in-body evidence a shaper rewrote the middle. */
const OMITTED_BYTES = /\([^)]*\d[\d,]*\s*(?:bytes|characters)[^)]*\)/i

/**
 * Whether `core` is `anchor` rewritten by a foreign shaper.
 *
 * The anchor's head must sit at the very start and its tail at the very end of
 * the rewritten body, and a spill footer must be the rewrite's evidence: either
 * the trailing notice the caller stripped (`strippedFooter`), or one sitting
 * between the two windows. A full receipt that merely shares the two probes —
 * the edited-then-re-read collision `prunedCarries` exists to reject — has no
 * footer, and a wrapper that embeds the anchor does not start with its head, so
 * neither qualifies. The length guard rejects a body that is only the two
 * windows with nothing rewritten between them.
 */
function foreignShaperCarries(
  core: string,
  anchor: string,
  head: string,
  tail: string,
  strippedFooter: boolean,
): boolean {
  if (core === anchor) return false
  if (head.length > 0 && !core.startsWith(head)) return false
  if (tail.length > 0 && !core.endsWith(tail)) return false
  if (core.length <= head.length + tail.length) return false
  if (strippedFooter) return true
  const middle = core.slice(head.length, core.length - tail.length)
  const footerStart = middle.indexOf('\n\n(')
  if (footerStart === -1) return false
  const footerEnd = middle.indexOf(')', footerStart)
  return footerEnd !== -1 && middle.slice(footerStart, footerEnd + 1).includes(SPILL_LOCATION)
}

/**
 * Whether `body` still carries `anchor`, verbatim or as a verified in-place
 * rewrite.
 *
 * The host pruner replaces the middle of an oversized receipt with
 * `PRUNE_MARKER` while preserving a head and a tail; apply-mode projection
 * composes head line + head + spill footer + tail. Both keep the anchor's
 * beginning and end, so a body holding both probes *and* the rewrite's own
 * evidence is the same receipt rewritten in place.
 *
 * An outer shaper (`dsh-spill-policy` for non-`read`, `dsh-tool-fs-search` for
 * `glob`/`grep`) also keeps the head and tail but appends its footer after the
 * tail, so the model-visible body ends with the notice. That case is checked
 * twice: the trailing notice is stripped and our own projection is verified on
 * the remaining body, then the remaining body is accepted as a foreign rewrite
 * only when it still starts with the anchor's head and ends with its tail.
 *
 * Sharing the two probes alone is not identity: a file edited in the middle and
 * re-read produces a full receipt with the same 32-character head and tail but
 * a different body.
 *
 * Residual, accepted: for a foreign shaper's rewrite the middle cannot be
 * verified from the model-visible body — we keep neither the anchor's byte
 * length nor a digest of it, and the shaper's own window (120 code points) need
 * not equal our probe window. What is checked is the shape (head at index 0,
 * tail at the end, a spill notice naming both a location and an omitted-byte
 * count) and that the body is longer than the two windows. A re-spilled receipt
 * that happens to share both probes would be accepted; rejecting every foreign
 * rewrite instead would discard every spilled receipt, which is the common
 * case. Fail closed only where the shape does not hold. Accepting it would substitute against content the model no
 * longer holds, so a probe match must be accompanied by the pruner marker, our
 * projection's head line, or a spill footer. Anything else is a lost anchor
 * (fail closed).
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
  // A distilled replacement (ticket #10) keeps neither window, so it is
  // recognised before the probe rejects it. Its identity evidence is the
  // marker naming the anchor's exact length plus a host footer, checked in
  // `distilledCarries`; it never passes for an arbitrary body without them.
  const footerStart = trailingSpillFooterStart(body)
  if (
    distilledCarries(body, anchor) ||
    (footerStart !== -1 && distilledCarries(body.slice(0, footerStart), anchor, true))
  ) {
    return true
  }
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
  if (prunedCarries(body, anchor) || ownProjectionCarries(body, anchor)) return true

  // An outer shaper's footer follows the rewrite, so the model-visible body
  // ends with the notice rather than with the anchor's tail. Verify the same
  // body with that notice removed; without one, the in-middle footer shape is
  // checked instead.
  const core = footerStart === -1 ? body : body.slice(0, footerStart)
  if (footerStart !== -1 && ownProjectionCarries(core, anchor)) return true
  return foreignShaperCarries(core, anchor, head, tail, footerStart !== -1)
}

/**
 * Why the decision's anchored receipts are no longer trustworthy, if they are.
 *
 * Marker precedence matches `invalidate`: any carried body that contains the
 * pruner literal means `pruned-reset`, because the pruner is the common case
 * and it leaves the receipt in place. Only when no anchor was pruned does a
 * missing carrier mean `compaction-reset` (the history was replaced by a
 * summary).
 *
 * A missing record, a record with no entries and a record whose shape cannot be
 * read are all unverifiable and therefore `compaction-reset` (row 28): the
 * commit that parked the decision writes anchors, so their absence is a failed
 * write, not a reason to substitute with zero verification. An empty anchor
 * string is a real value the check skips; `invalidate` treats an empty anchor
 * as a real value, and the stream hook has no receipt body to compare it with.
 */
function anchorResetOf(
  anchors: ReceiptAnchors | undefined,
  messages: unknown,
  probe: { head: number; tail: number },
): ResetCode | undefined {
  if (anchors == null) return 'compaction-reset'
  let record: unknown
  try {
    record = anchors.anchors
  } catch {
    return 'compaction-reset'
  }
  if (typeof record !== 'object' || record === null) return 'compaction-reset'

  const values = Object.values(record as Record<string, unknown>)
  if (values.length === 0) return 'compaction-reset'
  const texts = values.filter((text): text is string => typeof text === 'string' && text.length > 0)
  if (texts.length === 0) {
    // An empty anchor is a real value the check skips (it cannot be located in
    // any message). Any other unverifiable shape — an object from an older or
    // foreign anchor store — must fail closed instead: treating it as "no
    // anchors" would substitute on evidence this code cannot read.
    return values.every((value) => value === '') ? undefined : 'compaction-reset'
  }

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

/** The anchored step id a reset receipt names, never throwing on a foreign shape. */
function anchorStepIdOf(anchors: ReceiptAnchors): string {
  try {
    return typeof anchors.stepId === 'string' ? anchors.stepId : 'root'
  } catch {
    return 'root'
  }
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
 * How many synthesized turns this session has already emitted in one turn.
 *
 * `post-execute` takes exactly one step per queue entry, so the budget's
 * `count()` is the number of steps paid for in the turn; this tally is how many
 * of them have been spent on synthesis. A second synthesis of one entry would
 * spend a step the budget never granted. The call ids are kept too: the
 * deterministic `callIdFor` makes a re-enqueued decision at the same
 * turn/step/candidate reuse one id, and the host would persist two `tool_use`
 * blocks with it.
 */
interface SynthesisTally {
  /** Host turn this tally belongs to. */
  turn: number
  /** Synthesized turns emitted in `turn`. */
  count: number
  /** Call ids already synthesized in `turn`. */
  callIds: Set<string>
}

/**
 * Per-session synthesis history, keyed by `HookDeps` first so two plugin
 * instances in one process cannot read each other's session. It holds one turn
 * per session and dies with the assembly; `clearSession` drops the session.
 */
const SYNTHESIS_TALLY = new WeakMap<HookDeps, Map<string, SynthesisTally>>()

/** The session's synthesis tally, if this turn has one. */
function synthesisTallyOf(deps: HookDeps, sessionId: string): SynthesisTally | undefined {
  try {
    return SYNTHESIS_TALLY.get(deps)?.get(sessionId)
  } catch {
    return undefined
  }
}

/** Count one synthesized turn, starting a new tally when the turn changed. */
function recordSynthesis(deps: HookDeps, sessionId: string, turn: number, callId: string): void {
  try {
    let bySession = SYNTHESIS_TALLY.get(deps)
    if (bySession === undefined) {
      bySession = new Map()
      SYNTHESIS_TALLY.set(deps, bySession)
    }
    let tally = bySession.get(sessionId)
    if (tally === undefined || tally.turn !== turn) {
      tally = { turn, count: 0, callIds: new Set() }
      bySession.set(sessionId, tally)
    }
    tally.count += 1
    tally.callIds.add(callId)
  } catch {
    // A tally miss costs a duplicate guard, never this request.
  }
}

/** Drop one session's synthesis history at session end. */
function forgetSynthesis(deps: HookDeps, sessionId: string): void {
  try {
    SYNTHESIS_TALLY.get(deps)?.delete(sessionId)
  } catch {
    // Same: the tally is a guard, not a precondition.
  }
}

/**
 * Whether the entry's step can no longer be honoured.
 *
 * Two independent facts make a still-live entry unhonourable: its deterministic
 * call id was already synthesized in this turn (a retry or a re-enqueue at one
 * step), or the turn's paid steps are already used up by earlier syntheses.
 * A budget that reports no spend at all is a fixture/legacy shape rather than
 * proof of a step; the call-id half still applies there.
 */
function synthesisBlocked(
  deps: HookDeps,
  sessionId: string,
  entry: PendingEntry,
  turn: number,
): boolean {
  const tally = synthesisTallyOf(deps, sessionId)
  const current = tally !== undefined && sameTurn(tally.turn, turn) ? tally : undefined
  if (current !== undefined && current.callIds.has(entry.callId)) return true
  const budget = sessionBudget(deps, sessionId)
  // Row 21: a wired budget that was not lent to this session is unpayable, not
  // "no cap". Only a completely unwired budget leaves the step unconstrained.
  if (budget === undefined) return budgetWired(deps)
  let spent: number
  try {
    spent = budget.count()
  } catch {
    return false
  }
  if (!Number.isFinite(spent) || spent <= 0) return false
  return (current?.count ?? 0) >= spent
}

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

  // A blank call id cannot be dispatched and must not be "repaired" here: the
  // execute-side tamper check would compare a different id and reject silently.
  if (typeof entry.callId !== 'string' || entry.callId.trim().length === 0) {
    return {
      kind: 'pass',
      sessionId,
      abandon: { entry, clearQueue: true, clearAnchors: false },
    }
  }

  const turn = clockTurnOf(deps, sessionId)
  // The reset receipt pairs with the entry's own turn when the clock cannot
  // name a real one; a turn-0 commit still wrote (or failed to write) anchors.
  const resetTurn = turn ?? turnNumberOf(entry.turn)

  // Row 28: anchor evidence is checked before turn validity. A decision whose
  // anchors were never written (the commit's `set` failed), a store that holds
  // no record for a live entry, and a throwing read are all unverifiable;
  // dropping them as an ordinary stale entry would hide the lost evidence.
  // Intact anchors on a stale turn still take the silent abandon below: there
  // the decision is dead by identity, not because its evidence vanished.
  const anchorRead = anchorsOf(deps, sessionId)
  if (anchorRead.kind !== 'record') {
    return resetPlan(sessionId, entry, 'compaction-reset', 'root', resetTurn)
  }
  const reset = anchorResetOf(anchorRead.anchors, options?.messages, anchorProbe(deps))
  if (reset !== undefined) {
    return resetPlan(
      sessionId,
      entry,
      reset,
      anchorStepIdOf(anchorRead.anchors),
      resetTurn,
    )
  }

  if (turn === undefined || !sameTurn(entry.turn, turn)) {
    return {
      kind: 'pass',
      sessionId,
      abandon: { entry, clearQueue: true, clearAnchors: false },
    }
  }

  // Re-check the step immediately before synthesizing. The turn/step checks
  // above validate identity, not spend: a retried or re-enqueued request in the
  // same turn would otherwise emit a second substitute receipt with the same
  // call id, bypassing the per-turn budget the decision already consumed. The
  // entry is dropped through the ordinary abandon path so its usage mark is
  // settled as discarded rather than left to a later real request.
  if (synthesisBlocked(deps, sessionId, entry, turn)) {
    return {
      kind: 'pass',
      sessionId,
      abandon: { entry, clearQueue: true, clearAnchors: true },
    }
  }

  return { kind: 'synthesize', sessionId, entry }
}

/**
 * Abandon a decision whose anchored evidence cannot be verified.
 *
 * The reset receipt explains the lost anchor; the queue and anchors go with it,
 * and the usage mark is settled as discarded by `applyAbandon`.
 */
function resetPlan(
  sessionId: string,
  entry: PendingEntry,
  code: ResetCode,
  stepId: string,
  turn: number,
): StreamPlan {
  return {
    kind: 'pass',
    sessionId,
    abandon: {
      entry,
      clearQueue: true,
      clearAnchors: true,
      reset: { code, stepId, turn },
    },
  }
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
 * The facts of a synthesized turn that its later settlement needs.
 *
 * The settled receipt is written at the first real request after the
 * synthesized turn, when the queue entry is already gone. The evidence (plan,
 * guards) must survive until then, and so must the turn: the settled line pairs
 * with the synthesis turn, not with whichever request happened to settle it
 * (row 26).
 */
interface SynthesisFact {
  /** Host turn the synthesized turn answered. */
  turn: number
  /** Plan/guards evidence for the settled receipt, when the entry carried it. */
  evidence?: SubstitutionEvidence
}

/**
 * Plan/guards evidence parked between synthesis and settlement.
 *
 * Keyed by `HookDeps` first so two plugin instances in one process cannot read
 * each other's session, and a `WeakMap` lets the whole map die with the
 * assembly.
 */
const PENDING_EVIDENCE = new WeakMap<HookDeps, Map<string, SynthesisFact>>()

/** Park the fact for the session's next settlement, replacing any earlier. */
function rememberEvidence(deps: HookDeps, sessionId: string, fact: SynthesisFact): void {
  let bySession = PENDING_EVIDENCE.get(deps)
  if (bySession === undefined) {
    bySession = new Map()
    PENDING_EVIDENCE.set(deps, bySession)
  }
  bySession.set(sessionId, fact)
}

/** Take (and forget) the fact one settlement consumes. */
function takeEvidence(deps: HookDeps, sessionId: string): SynthesisFact | undefined {
  const bySession = PENDING_EVIDENCE.get(deps)
  const fact = bySession?.get(sessionId)
  bySession?.delete(sessionId)
  return fact
}

/** Drop a fact that no settlement will ever consume. */
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
    if (typeof pending !== 'string' || pending.length === 0) {
      // A parked fact without a mark can never be settled; drop it rather than
      // let a later, unrelated mark pick up this turn's evidence.
      forgetEvidence(deps, sessionId)
      return
    }
    candidateId = pending
    settled = ledger.settle()
  } catch {
    forgetEvidence(deps, sessionId)
    return
  }

  const fact = takeEvidence(deps, sessionId)
  await appendReceipt(deps, {
    version: 1,
    ts: new Date().toISOString(),
    sessionId,
    // Row 26: the synthesized turn is the substitution's turn; the request that
    // happens to settle it may already be the next one.
    turn: fact?.turn ?? clockTurnOf(deps, sessionId) ?? 0,
    stepId: 'root',
    kind: 'substitute-settled',
    code: 'substitute-settled',
    candidateId,
    // G2 applies to the settled line too: the goal and guards are the same
    // evidence the synth-time line carried, parked when that line was written.
    ...(fact?.evidence ?? {}),
    saved_input_tokens: settled.saved_input_tokens,
    // Row 7: the settled line carries both estimates — the upper input figure
    // and the lower whole-request figure from the plan's own request.
    avoided_total_tokens: settled.avoided_total_tokens,
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
    // Only a recorded sample moves status's "most recent request" pointer.
    deps.sessions?.noteUsage(sessionId)
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
 * accumulated for `parsePlan`. Settlement also runs in `finally`: an upstream
 * that throws before the `usage` chunk (a provider 500 mid-stream) or a
 * consumer that cancels the stream still ends the request, and a mark left
 * pending there would pair with the next, unrelated request and report that
 * request's tokens as a saving. An errored stream has no usable sample, so
 * `settle()` reports `'unknown'`. The plan store is still reached only on
 * normal completion, so a partial response never becomes a plan.
 */
async function* observeBranch(
  deps: HookDeps,
  sessionId: string | undefined,
  upstream: AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  let text = ''
  try {
    for await (const chunk of upstream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk?.type === 'usage' && sessionId !== undefined) {
        recordUsage(deps, sessionId, chunk.usage)
        await settlePendingMark(deps, sessionId)
      }
      yield chunk
    }
  } finally {
    // The host emits `usage` before `finish`, so this is normally a no-op; a
    // route that omits the chunk still ends the request, and the mark must be
    // consumed there rather than attributed to a later request (`'unknown'`,
    // which status does not count).
    if (sessionId !== undefined) await settlePendingMark(deps, sessionId)
  }
  rememberPlan(deps, sessionId, text)
}

/**
 * The synthesized turn.
 *
 * The plugin answers instead of the model, so `upstream` is only a fallback:
 * the hook body resolved it synchronously at the waterfall point, before this
 * generator runs, and it stays untouched when the entry is still live. The
 * entry is re-read with `peek` (never `take`) so it survives to
 * `tools/execute`; if it vanished between the synchronous decision and the
 * first generator step, the mark is discarded and the real model answers,
 * because a substitution that cannot be dispatched must not be faked.
 *
 * `upstream` is absent only when the host's `next()` itself threw while the
 * hook body was resolving it; a host that cannot produce an upstream has no
 * fallback to offer, so the vanished entry ends with an empty stream rather
 * than a synthesized call no dispatch can check.
 */
async function* synthesizeBranch(
  deps: HookDeps,
  sessionId: string,
  entry: PendingEntry,
  upstream: AsyncIterable<StreamChunk> | undefined,
): AsyncGenerator<StreamChunk> {
  const current = peekPending(deps, sessionId)
  if (current === undefined || current.callId !== entry.callId) {
    settleDiscarded(deps, sessionId)
    if (upstream !== undefined) yield* observeBranch(deps, sessionId, upstream)
    return
  }

  markSubstitutedFor(deps, sessionId, current.candidateId)
  // Park the plan evidence and the synthesis turn for the settled line, which
  // runs at the next real request after this entry has left the queue.
  const evidence = (current as AuditedPendingEntry).evidence
  const turn = turnNumberOf(current.turn)
  rememberEvidence(deps, sessionId, {
    turn,
    ...(evidence === undefined ? {} : { evidence }),
  })
  // Row 27: mirror the synthesis fact now, not when `tools/execute` accepts the
  // dispatch. A call denied by `tools/pre-execute` never reaches that hook, and
  // a rollover must still report the model round this turn skipped. The mirror
  // only feeds the settle path; it never claims a measured saving.
  deps.noteSynthesis?.(sessionId, turn, current.candidateId, evidence)
  await appendSubstituteReceipt(deps, sessionId, current)
  yield* synthesizeTurn(current)
}

// ---------------------------------------------------------------------------
// The exported hook and session-end cleanup
// ---------------------------------------------------------------------------

/**
 * Answer a pass decision: abandon what the decision owned, then observe the
 * real stream.
 *
 * `upstream` is resolved by the hook body at the waterfall point; the generator
 * only delays effects and consumption.
 */
function observedPass(
  deps: HookDeps,
  plan: Extract<StreamPlan, { kind: 'pass' }>,
  upstream: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    if (plan.sessionId !== undefined) {
      // Order matters only for evidence: the discard drops the parked
      // plan/guards, and `applyAbandon` then clears the rest. Both settle
      // calls are idempotent.
      if (plan.discardMark === true) settleDiscarded(deps, plan.sessionId)
      if (plan.abandon !== undefined) await applyAbandon(deps, plan.sessionId, plan.abandon)
    }
    yield* observeBranch(deps, plan.sessionId, upstream)
  })()
}

/**
 * Drain a registered distillation stream; its value is unused here.
 *
 * The product is written by the attempts registry from `decide`'s own promise,
 * so this only has to keep the stream flowing — including one whose caller
 * already timed out, which would otherwise leave the provider request half-read
 * and the late answer never observed.
 */
function drainForLateDistill(upstream: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    for await (const chunk of upstream) {
      // Nothing here may change the request's semantics: no usage observation,
      // no settlement, no plan rollover.
      void chunk
    }
  })()
}

/**
 * Build the `llm/stream` listener.
 *
 * Returns a **synchronous** function returning an `AsyncIterable`; see the
 * module header for why an `async` function here breaks every request. Any
 * `purpose`-tagged call (selector, compaction, session-title) returns `next()`
 * untouched: never observed, never substituted. Every real request is decided
 * synchronously by {@link resolveStreamPlan} and then answered by a generator.
 *
 * The upstream iterator is resolved **at the waterfall point on every path**,
 * before any generator body runs. The host's terminal is a lazy async iterable
 * (starting it is what calls the model), so resolving it on the synthesis path
 * costs nothing; it is only consumed if the pending entry vanished and the real
 * model has to answer. Resolving it lazily inside the generator would resume a
 * waterfall the host may already have moved past.
 */
export function streamHook(
  deps: HookDeps,
): (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk> {
  return (options, next) => {
    // Any purpose-tagged request is auxiliary (appendix §1): the selector, the
    // compaction summarizer, the session-title model. They share the session
    // id but are not conversation steps, so they pass through raw: no
    // substitution, no usage observation, no settlement, no plan rollover.
    if (options?.purpose !== undefined) {
      const upstream = next()
      // A timed-out distillation (ticket #10) is parked in `deps.distillAttempts`.
      // Its answer arrived after the caller stopped waiting; draining this
      // stream is what observes it, and the registry persists it so the next
      // render of the same receipt finds a pinned product instead of paying
      // again. Nothing else here changes: no usage, no settlement, no plan.
      // `next()` was still called exactly once, so a host whose terminal throws
      // on this request keeps throwing it.
      // Only a call whose caller has already timed out is drained: at that
      // point nobody is reading the stream, so consuming it here is what
      // observes the answer. A registered-but-live call must pass through —
      // `owns` is true from registration onward, and draining it would hand
      // the distiller an empty iterable (every distillation a paid no-op).
      if (options.purpose === DISTILL_PURPOSE && deps.distillAttempts?.parked(options) === true) {
        return drainForLateDistill(upstream)
      }
      return upstream
    }

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
      // A bug in our own decision logic must not take the model request down,
      // but it must still take the ordinary pass path: the decision-time mark
      // has to be discarded here or this real request would settle a
      // substitution that never ran. Clearing the queue is the same fail-closed
      // answer — no decision was made.
      try {
        plan = passPlan(deps, sessionId, { clearQueue: true, clearAnchors: false }, true)
      } catch {
        plan = { kind: 'pass', sessionId, discardMark: true }
      }
    }

    // Resolve the upstream iterator before any branch. The real host's terminal
    // is an async generator, so this starts no model call; it only fixes which
    // request the fallbacks observe. A host whose `next()` throws was already
    // failing on the pass path, so that throw is preserved there; the synthesis
    // path proceeds without a fallback instead.
    // Count a synthesis decision before the generator runs: an unconsumed
    // stream or a vanished entry must still not let the same step be
    // synthesized twice. This runs before `next()` too, so a host whose
    // terminal throws cannot reopen the same step.
    if (plan.kind === 'synthesize') {
      const turn = clockTurnOf(deps, plan.sessionId) ?? turnNumberOf(plan.entry.turn)
      recordSynthesis(deps, plan.sessionId, turn, plan.entry.callId)
    }

    let upstream: AsyncIterable<StreamChunk> | undefined
    try {
      upstream = next()
    } catch (error) {
      if (plan.kind !== 'synthesize') throw error
      return synthesizeBranch(deps, plan.sessionId, plan.entry, undefined)
    }

    if (plan.kind === 'synthesize') {
      return synthesizeBranch(deps, plan.sessionId, plan.entry, upstream)
    }

    return observedPass(deps, plan, upstream)
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
 * session it belongs to, and the shared-instance loans this session holds are
 * released so a disposed owner does not refuse every later session forever.
 */
export function clearSession(deps: HookDeps, sessionId: string): void {
  settleDiscarded(deps, sessionId)
  clearPending(deps, sessionId)
  clearAnchors(deps, sessionId)
  clearPlan(deps, sessionId)
  forgetSynthesis(deps, sessionId)
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
  releaseSharedLoans(deps, sessionId)
  // The rollover path mirrors an accepted dispatch so a late tool result can
  // still settle a substitution that ran. A disposed session has no late
  // result coming, so the mirror would otherwise sit in the per-deps map for
  // the plugin's lifetime — one entry per disposed session.
  try {
    deps.clearAcceptedDispatch?.(sessionId)
  } catch {
    // A disposal hook that throws must not abort the rest of the teardown.
  }
}
