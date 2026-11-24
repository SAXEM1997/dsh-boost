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
 * - Products are **not** deleted when a session ends. A product is the pinned
 *   bytes that entered history; ADR 0001 promises a replay only reads the
 *   table, and a session end is not the boundary of a replay (a resumed or
 *   forked session replays the same receipts). Deleting there made the promise
 *   depend on process lifetime and charged the operator a second call with no
 *   signal. The store bounds itself instead: `write` prunes the oldest files
 *   once the directory passes `maxFiles`, or once the byte cap looks reachable
 *   from the file count and the size just written.
 * - There is no per-session delete. A product is not evidence for a session,
 *   it is evidence for a receipt, and the receipt outlives the session.
 *
 * The store knows no host services; the caller resolves the root.
 *
 * @module dsh-boost/distill/store
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DistillKey } from './pin.js'

/** The directory under the boost root that holds the products. */
const DISTILLED_DIR = 'distilled'

/**
 * Retention bounds.
 *
 * A product is roughly 0.5–2 KB, so 5,000 files is single-digit megabytes — the
 * same order as one day of receipts. The cap exists to keep a long-lived
 * install from growing without bound, not to keep the directory small.
 */
export interface Limits {
  maxFiles: number
  maxBytes: number
}

export const MAX_FILES = 5000
export const MAX_BYTES = 16 * 1024 * 1024

/**
 * What one product is assumed to weigh, for the cheap byte check.
 *
 * A product is the distilled body plus a handful of verbatim quotes, so it is
 * bounded by the output budget in practice. Used only to decide whether the
 * expensive per-file `stat` pass is worth running; the pass itself measures the
 * real bytes.
 */
const ASSUMED_PRODUCT_BYTES = 4096

/**
 * Whether a temp file's owning process is gone.
 *
 * Temp files are named `<target>.<pid>.tmp`, so liveness — not age — decides who
 * may reclaim one. A live writer's temp file is deleted at our peril: its
 * `rename` would then fail with ENOENT and a distillation would be lost to a
 * race it never entered. A pid that cannot be signalled is either dead or
 * recycled; both mean nobody will ever rename that file, so it is ours to drop.
 */
function ownerGone(name: string): boolean {
  const match = /\.(\d+)\.tmp$/.exec(name)
  if (match === null) return false
  const pid = Number(match[1])
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as { code?: string }).code === 'ESRCH'
  }
}

/** One persisted product. */
export interface DistillProduct {
  /** The distilled body, without the head marker and the footer. */
  text: string
  /** Verbatim fragments of the original receipt the answer relies on. */
  quotes: string[]
  /** The model that answered. */
  model: string
  /**
   * The spill handle the first render named in its footer.
   *
   * Pinned so a replay composes the *same* bytes: the host backend names each
   * file with `randomBytes(6)`, and the footer text is
   * `(Omitted N bytes. … stored at: <locator>. <retrievalHint>)` — so a second
   * `saveText` changes both halves of what the model reads. Absent on products
   * written before this field existed; a miss re-spills and adopts the new
   * handle.
   */
  spill?: { locator: string; retrievalHint: string }
  /**
   * A pinned refusal, with no body.
   *
   * A rejection is a decision as much as an adoption is, so it is written here
   * and read back by a replay — otherwise the same receipt pays for the same
   * refused answer on every replay. `timeout` is never pinned: it has no answer
   * to pin, and a late one must be able to land.
   */
  rejected?: string
}

/** Whether a parsed file is a well-formed product. */
function isProduct(value: unknown): value is DistillProduct {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.text === 'string' &&
    (record.rejected === undefined || typeof record.rejected === 'string') &&
    Array.isArray(record.quotes) &&
    record.quotes.every((quote) => typeof quote === 'string') &&
    typeof record.model === 'string' &&
    (record.spill === undefined ||
      (typeof record.spill === 'object' &&
        record.spill !== null &&
        typeof (record.spill as Record<string, unknown>).locator === 'string' &&
        typeof (record.spill as Record<string, unknown>).retrievalHint === 'string'))
  )
}

/** Pinned products under one boost root. */
export class DistillStore {
  private readonly root: string
  private readonly limits: Limits

  constructor(root: string, limits: Partial<Limits> = {}) {
    this.root = root
    this.limits = {
      maxFiles: limits.maxFiles ?? MAX_FILES,
      maxBytes: limits.maxBytes ?? MAX_BYTES,
    }
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
   * Write one product atomically, then keep the directory inside its caps.
   *
   * The body is serialised before the first filesystem call, so a body that
   * cannot be serialised (it cannot, structurally) fails here too, and the
   * rename means a reader never observes the temp file's name. Rejects when the
   * product cannot be written; a failed prune never rejects.
   *
   * `_sessionId` is retained so every caller keeps the same signature; products
   * are keyed by receipt, question and distiller version only, because they
   * outlive the session that produced them (ADR 0001).
   */
  async write(
    _sessionId: string,
    key: Pick<DistillKey, 'file'>,
    product: Partial<Omit<DistillProduct, 'model'>> & Pick<DistillProduct, 'model'>,
  ): Promise<void> {
    const body: DistillProduct = {
      text: product.text ?? '',
      quotes: [...(product.quotes ?? [])],
      model: product.model,
      ...(product.rejected === undefined ? {} : { rejected: product.rejected }),
      ...(product.spill === undefined
        ? {}
        : { spill: { locator: product.spill.locator, retrievalHint: product.spill.retrievalHint } }),
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
    // Retention runs after the write, never instead of it: the caller is about
    // to render these bytes, so the product just written must survive even when
    // it alone exceeds the byte cap. A pruning failure is not a write failure —
    // the product is already on disk and correct.
    await this.prune(target, Buffer.byteLength(json, 'utf8')).catch(() => undefined)
  }

  /**
   * Drop the oldest products until the directory is inside both caps.
   *
   * `keep` is the file just written: it is the one the caller is about to
   * render, so it is never a candidate even when it is the whole overage.
   * Ordering is by `mtimeMs`, which the atomic rename refreshes on every write;
   * ties fall back to `readdir` order, which decides only *which* of two equally
   * old products goes, never the bytes any product holds.
   *
   * The cheap checks run first. `readdir` costs one call for the whole
   * directory and `stat` costs one per file, so a directory that cannot be over
   * a cap pays for nothing. The byte cap is estimated from
   * {@link ASSUMED_PRODUCT_BYTES}: a product is a body plus a handful of quotes,
   * so the directory cannot be over the byte cap until it holds
   * `maxBytes / ASSUMED_PRODUCT_BYTES` files. A write whose product is itself
   * larger than the assumption forces the measured pass, so a directory full of
   * large products cannot drift far past the byte cap; a small write in between
   * two large ones does not reclaim on its own, which is why the forced pass
   * keys on the product being written rather than on the directory total.
   */
  private async prune(keep: string, written: number): Promise<void> {
    const dir = this.dir()
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    const files = names.filter((name) => name.endsWith('.json'))
    // A killed process leaves `<name>.json.<pid>.tmp` behind: never counted by
    // the caps, so nothing would ever reclaim it. Only a temp whose owner is
    // gone is reclaimed — see {@link ownerGone}.
    for (const name of names) {
      if (!name.endsWith('.tmp')) continue
      if (!ownerGone(name)) continue
      await unlink(join(dir, name)).catch(() => {})
    }
    // A product larger than the assumption is itself evidence that the count
    // estimate is too optimistic, so it forces the measured pass.
    const maybeOverBytes =
      files.length * ASSUMED_PRODUCT_BYTES > this.limits.maxBytes || written > ASSUMED_PRODUCT_BYTES
    if (files.length <= this.limits.maxFiles && !maybeOverBytes) return
    const stats: { name: string; mtimeMs: number; size: number }[] = []
    let count = 0
    let bytes = 0
    for (const name of files) {
      const path = join(dir, name)
      try {
        const info = await stat(path)
        count += 1
        bytes += info.size
        if (path !== keep) stats.push({ name, mtimeMs: info.mtimeMs, size: info.size })
      } catch {
        // Vanished between readdir and stat: nothing to count, nothing to prune.
      }
    }
    if (count <= this.limits.maxFiles && bytes <= this.limits.maxBytes) return
    stats.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const entry of stats) {
      if (count <= this.limits.maxFiles && bytes <= this.limits.maxBytes) return
      try {
        await unlink(join(dir, entry.name))
        count -= 1
        bytes -= entry.size
      } catch {
        // Stop rather than carry on with a total that no longer matches the
        // directory: continuing would delete every remaining product while the
        // caps still read as over.
        return
      }
    }
  }
}
