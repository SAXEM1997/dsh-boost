/**
 * The pinned product store: one JSON file per `(receipt, question, version)`.
 *
 * Layout matches the receipts' root (`<dshHome>/boost/distilled/`), so the two
 * state trees are archived and backed up together. A product's file name is its
 * whole address; the body carries the answer, the quotes it cites, the model
 * that produced it and when.
 *
 * ## Contract
 *
 * - `read` never throws: a missing file, a corrupt body and a body of the wrong
 *   shape are all a **miss**. A miss means "compute it", which is always safe —
 *   the worst outcome is one more model call, never a wrong answer.
 * - `write` throws when it cannot persist. The caller turns that into
 *   `distill-failed` and falls back to truncation: the bytes that enter history
 *   must be the bytes on disk (ADR 0001), so a product that could not be pinned
 *   must not be shown.
 * - The write is atomic (temp file + rename), so a concurrent reader sees the
 *   old product or the new one, and no reader ever sees a half-written file
 *   from a crash.
 * - `clearSession` removes the products this process wrote for a session and
 *   touches nothing else: a session end is the receipts' lifecycle, and a file
 *   this process did not write (a foreign or hand-made one) is not ours to
 *   delete.
 *
 * The store knows no host services; the caller resolves the root.
 *
 * @module dsh-boost/distill/store
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DistillKey } from './pin.js'

/** The directory under the boost root that holds the products. */
const DISTILLED_DIR = 'distilled'

/** One persisted product. */
export interface DistillProduct {
  /** The distilled body, without the head marker and the footer. */
  text: string
  /** Verbatim fragments of the original receipt the answer relies on. */
  quotes: string[]
  /** The model that answered. */
  model: string
  /** ISO timestamp of the first computation. */
  createdAt: string
}

/** Whether a parsed file is a well-formed product. */
function isProduct(value: unknown): value is DistillProduct {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.text === 'string' &&
    Array.isArray(record.quotes) &&
    record.quotes.every((quote) => typeof quote === 'string') &&
    typeof record.model === 'string' &&
    typeof record.createdAt === 'string'
  )
}

/** Pinned products under one boost root. */
export class DistillStore {
  private readonly root: string
  /**
   * Session → the product file stems this process wrote for it.
   *
   * Only an in-process write is recorded, so `clearSession` can never delete a
   * file another process (or an operator) put there. An entry is dropped when
   * `clearSession` runs; a session that is never disposed leaks one stem per
   * product, bounded by the products that session produced.
   */
  private readonly written = new Map<string, Set<string>>()

  constructor(root: string) {
    this.root = root
  }

  /** The product directory for this root. */
  dir(): string {
    return join(this.root, DISTILLED_DIR)
  }

  /** One product's path; the stem comes from `keyOf`. */
  pathOf(key: Pick<DistillKey, 'file'>): string {
    return join(this.dir(), `${key.file}.json`)
  }

  /** The pinned product, or `undefined` on any miss. Never throws. */
  async read(key: Pick<DistillKey, 'file'>): Promise<DistillProduct | undefined> {
    let raw: string
    try {
      raw = await readFile(this.pathOf(key), 'utf8')
    } catch {
      return undefined
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      return isProduct(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Persist a product atomically; rejects when it cannot be written.
   *
   * The body is serialised before the first filesystem call, so a body that
   * cannot be serialised (it cannot, structurally) fails here too; and the
   * rename means a reader never observes the temp file's name.
   */
  async write(
    sessionId: string,
    key: Pick<DistillKey, 'file'>,
    product: Pick<DistillProduct, 'text' | 'quotes' | 'model'>,
  ): Promise<void> {
    const body: DistillProduct = {
      text: product.text,
      quotes: [...product.quotes],
      model: product.model,
      createdAt: new Date().toISOString(),
    }
    const json = JSON.stringify(body)
    const dir = this.dir()
    await mkdir(dir, { recursive: true })
    const target = this.pathOf(key)
    // The temp name carries the pid so two processes writing the same key do
    // not share one scratch file; the rename is atomic either way.
    const temp = `${target}.${process.pid}.tmp`
    try {
      await writeFile(temp, json, 'utf8')
      await rename(temp, target)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
    let stems = this.written.get(sessionId)
    if (stems === undefined) {
      stems = new Set()
      this.written.set(sessionId, stems)
    }
    stems.add(key.file)
  }

  /**
   * Delete the products this session wrote; returns how many files went away.
   *
   * Idempotent and total: a file already gone (or a directory removed under
   * us) is counted as nothing, never as an error.
   */
  async clearSession(sessionId: string): Promise<number> {
    const stems = this.written.get(sessionId)
    if (stems === undefined) return 0
    this.written.delete(sessionId)
    let removed = 0
    for (const stem of stems) {
      try {
        await unlink(join(this.dir(), `${stem}.json`))
        removed += 1
      } catch {
        // Already gone: nothing to remove.
      }
    }
    return removed
  }
}
