/**
 * The distillation seam: one question, one bounded model call, one answer.
 *
 * The types here are deliberately small. `DistillFn` is the only thing that
 * talks to a model, and it has one method, so a test (or a host without an LLM)
 * can replace it with a counting fake and every decision in `decide` is a pure
 * function of what it returns.
 *
 * This module is **types only**: it declares no value, so its emitted
 * declaration is self-contained (no host import, no import of a sibling that
 * is not shipped) and the package names it explicitly in `files`, next to the
 * public `index`/`types` declarations. `import type` is erased, so no consumer
 * ever loads the runtime module.
 *
 * @module dsh-boost/distill/types
 */
import type { DistillKey, DistillQuestion } from './pin.js'

/** Everything one distillation request carries. */
export interface DistillRequest {
  /** The receipt to answer the question about, byte for byte. */
  text: string
  /** The family's fixed question. */
  question: DistillQuestion
  /** The model's provider route (resolved by the caller from config or the boundary route). */
  provider: string
  /** The model id; also part of the product's version. */
  model: string
  /** Output cap, already clamped by `resolveConfig`. */
  maxOutputTokens: number
  /** Wall-clock bound, already clamped by `resolveConfig`. */
  timeoutMs: number
  /** The product's pinned address, which the call is computed against. */
  key: DistillKey
  /** The session the request belongs to; recorded for audit. */
  sessionId: string
  /**
   * The exact `GenerateOptions` object to send, when the caller built one.
   *
   * One object per call is the whole point: the parking registry keys on the
   * object identity the `llm/stream` hook sees, so building a second one inside
   * the distiller would register two entries per call — one parked, one leaked.
   */
  options?: object
}

/** The model's answer: a distilled body and the verbatim fragments it rests on. */
export interface DistillAnswer {
  /** The distilled body that will replace the truncation view if adopted. */
  text: string
  /** Fragments of the original receipt; every one must be a non-empty substring. */
  quotes: string[]
  /** The model that answered; defaults to the request's model. */
  model?: string
  /** Completion tokens the call reported, when the adapter exposes them. */
  tokens?: number
}

/**
 * One bounded model call.
 *
 * `call` resolves to the answer, or to `undefined` when it produced nothing
 * usable (unparseable JSON, empty text). It may reject: `decide` maps a
 * rejection to `distill-failed` and a call that outlives `timeoutMs` to
 * `distill-rejected:timeout`. It never throws out of `decide`.
 */
export interface DistillFn {
  call(request: DistillRequest): Promise<DistillAnswer | undefined>
}
