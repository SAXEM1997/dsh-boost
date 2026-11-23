/**
 * The pinned identity of a distillation product.
 *
 * A product is addressed by `(receipt_hash, question_hash, distiller_version)`
 * (ADR 0001). All three parts are pure functions of their inputs, because the
 * file name is the cache key: a key that moved between two identical receipts
 * would recompute — and re-bill — a product that already exists, while a key
 * that failed to move when the prompt changed would hand a model the output of
 * a different question.
 *
 * - `receipt_hash` hashes the receipt's **bytes**, not its call id. The same
 *   output delivered under two call ids (a re-run, a replay) is the same
 *   evidence and reuses the same product; a re-run that produced different
 *   bytes is a different receipt and is distilled again.
 * - `question_hash` hashes the family's fixed question. The question is a
 *   constant per family, so the hash is stable for the life of the release.
 * - `version` is `DISTILLER_VERSION` plus a hash of the model id and the
 *   question text. Bumping the constant changes the address of every product
 *   **computed from then on**; products already on disk stay readable under the
 *   old address, which is exactly the ADR's "upgrade is a cache event, old
 *   receipts keep their old product" rule.
 *
 * Nothing here reads a clock or a random source.
 *
 * @module dsh-boost/distill/pin
 */
import { createHash } from 'node:crypto'
import type { ToolFamily } from '../types.js'

/**
 * The distiller's protocol version.
 *
 * Bump this when the system prompt, the answer shape or the acceptance rules
 * change, so new receipts are distilled under the new rules while old products
 * remain addressable.
 */
export const DISTILLER_VERSION = 'v1'

/** One family's fixed question: the prompt text and the short name the head marker shows. */
export interface DistillQuestion {
  /** The question asked about the receipt; hashed into `question_hash`. */
  readonly text: string
  /** The short label shown in `[distilled from N chars; Q]`; never contains whitespace. */
  readonly name: string
}

/** The families that may be distilled, and the one question each asks. */
const QUESTIONS: Readonly<Record<'bash' | 'ssh', DistillQuestion>> = Object.freeze({
  bash: Object.freeze({
    text: 'Which step failed, and what is the exact error output? Quote the failing command and the error text verbatim.',
    name: 'bash',
  }),
  ssh: Object.freeze({
    text: 'Which remote command failed, and what is the exact error output from the remote host? Quote the failing command and the error text verbatim.',
    name: 'ssh',
  }),
})

/** The question for a family, or `undefined` when that family is never distilled. */
export function questionOf(family: ToolFamily): DistillQuestion | undefined {
  if (family === 'bash' || family === 'ssh') return QUESTIONS[family]
  return undefined
}

/** First 16 hex characters of a sha256, the same width `receiptHash` uses. */
function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)
}

/**
 * The receipt half of the key: a hash of the receipt's own bytes.
 *
 * UTF-8 is explicit so the digest cannot depend on a platform locale; the
 * separator keeps `('ab', 'c')` from colliding with `('a', 'bc')` if this ever
 * hashes more than one part.
 */
export function receiptKeyOf(text: string): string {
  return shortHash(`receipt\u0000${text}`)
}

/** The question half of the key: a hash of the question text. */
export function questionKeyOf(question: DistillQuestion): string {
  return shortHash(`question\u0000${question.text}`)
}

/**
 * The product's version: the protocol constant, the model, and the question.
 *
 * The model is part of it because two models answer the same question
 * differently; the question is part of it because it pins the prompt within
 * one protocol version. The result is a readable prefix plus a short hash, so
 * an operator can tell which model produced a file from its name alone.
 */
export function versionOf(model: string, question: DistillQuestion): string {
  return `${DISTILLER_VERSION}-${shortHash(`version\u0000${model}\u0000${question.text}`)}`
}

/** Sentinel a `withTimeout` answers when the timer wins the race. */
export const TIMEOUT = Symbol('distill-timeout')

/**
 * Race `work` against one timer and clear the timer on every settlement.
 *
 * Shared by `decide` (the model call) and the `llm/stream` hook (reading that
 * call's answer back, so it is persisted even after the caller gave up): both
 * need the same "bounded wait, the loser keeps running" shape. The abandoned
 * promise is never observed here; callers attach their own handlers, so it
 * cannot become an unhandled rejection.
 *
 * A non-finite bound means "the caller could not bound this": the timer is
 * capped to Node's largest delay rather than overflowing to 1 ms.
 */
export async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), Math.min(timeoutMs, 2_147_483_647))
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** One product's address: the key triple and the file stem it becomes. */
export interface DistillKey {
  /** The receipt's hash; identifies the evidence, not the call. */
  receiptHash: string
  /** The question's hash. */
  questionHash: string
  /** `versionOf(model, question)`. */
  version: string
  /** `<receiptHash>-<questionHash>-<version>`, without the `.json` suffix. */
  file: string
}

/** Build the address of one product. Every part is hex or `[A-Za-z0-9-]`, so the stem is a safe path segment. */
export function keyOf(receiptHash: string, questionHash: string, version: string): DistillKey {
  return { receiptHash, questionHash, version, file: `${receiptHash}-${questionHash}-${version}` }
}
