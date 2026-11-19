/**
 * Append-only receipt store.
 *
 * Every decision the plugin makes is one JSON line under
 * `<root>/receipts/<sessionId>.jsonl`: the shadow week is analysed offline from
 * these files, and the plugin is audited from them after the fact. The store is
 * therefore append-only (reads may only cut an incomplete tail), crash-safe (a
 * line that was never finished is not a receipt), bounded (current + `.1`, hard
 * limits), and fail-closed (three consecutive write failures stop substitution
 * rather than running without an audit trail).
 *
 * ## Write path
 *
 * A receipt is serialised and appended in one `appendFile` call, rotated before
 * the write when the current shard reached `maxBytes`/`maxLines`, and fsynced
 * only every `fsyncEveryLines` lines (or on `flush()` — the caller flushes at
 * turn end). A write failure never rejects: the line is buffered in memory in
 * order, `failures()` counts the *consecutive* failures, and a later successful
 * append replays the buffer and resets the count.
 *
 * ## Read path
 *
 * `.1` is read before the current shard, so `scan` yields oldest receipts
 * first. A trailing line without `\n` is discarded and the file is truncated
 * back to the last newline; a corrupt line in the middle is skipped. Rotated
 * shards are read through the same path, so a half line left by a crash before
 * rotation is handled identically.
 *
 * The store imports only `node:` builtins and knows no host services: the
 * caller resolves the root (the plugin passes `$DSH_HOME/boost`).
 *
 * @module dsh-boost/receipts/store
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, open, readdir, readFile, rename, stat, truncate } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Why a receipt exists. `substitute-settled` is its own line because the store is append-only. */
export type ReceiptKind =
  | 'substitute'
  | 'substitute-settled'
  | 'shadow'
  | 'projection'
  | 'skip'
  | 'reset'

/** Fields every receipt carries, before the store fills the derived ones. */
type ReceiptCore = {
  ts: string
  sessionId: string
  turn: number
  stepId?: string
  kind: ReceiptKind
  code: string
  tool?: string
  [k: string]: unknown
}

/**
 * One line of the audit log.
 *
 * Invariant (plan line 581): a receipt with `kind === 'projection'` always
 * carries `unit: 'raw'` as a literal — T19/T26 filter on it, so a projection
 * receipt without it would be invisible to the counters. The plan keeps
 * `Receipt` an interface, which cannot pair `kind` with `unit`, so `buildReceipt`
 * enforces the invariant by construction: it overwrites `unit` with `'raw'` on
 * every projection receipt, ignoring any caller-supplied value, because the
 * literal is the invariant rather than a parameter. A projection receipt is
 * never rejected for shape; it must remain auditable.
 */
export interface Receipt extends ReceiptCore {
  version: 1
  receipt_hash: string
  preview: string
}

/** What callers hand to `append`; the store fills `version`, `receipt_hash` and `preview`. */
type ReceiptInput = ReceiptCore & {
  version?: 1
  preview?: string
}

/** Tuning knobs; the defaults are the design's (§5.3). */
interface ReceiptStoreOptions {
  fsyncEveryLines?: number
  maxBytes?: number
  maxLines?: number
}

/** Per-shard counters used to decide rotation without re-reading the file. */
interface ShardState {
  lines: number
  bytes: number
}

/** One serialised line waiting for the disk. */
interface PendingLine {
  sessionId: string
  line: string
}

const RECEIPTS_DIR = 'receipts'
const CURRENT_SUFFIX = '.jsonl'
const ROTATED_SUFFIX = '.1.jsonl'
/** `preview` is the first 256 code points, never the full receipt text (design §5.4). */
const PREVIEW_CODE_POINTS = 256
const DEFAULT_FSYNC_EVERY_LINES = 100
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_LINES = 20_000
/** Fail-closed threshold: after this many *consecutive* write failures, stop substituting. */
const STOPPED_AFTER_FAILURES = 3
const NEWLINE = 0x0a

/**
 * `sha256(stable JSON)` of the fields that identify a call, first 16 hex chars.
 *
 * `args` is part of the payload on purpose: without it, two different calls of
 * the same tool in one turn would collide. A missing `args` hashes like `{}`,
 * and object keys are sorted recursively so insertion order cannot change the
 * hash.
 */
export function receiptHash(r: {
  sessionId: string
  turn: number
  stepId?: string
  tool?: string
  args?: unknown
}): string {
  const payload = {
    sessionId: r.sessionId,
    turn: r.turn,
    stepId: r.stepId,
    tool: r.tool,
    args: r.args ?? {},
  }
  return createHash('sha256').update(stableJson(payload)).digest('hex').slice(0, 16)
}

/** JSON with object keys sorted recursively; `undefined` members are dropped as `JSON.stringify` would. */
function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) sorted[key] = sortKeys(child)
    }
    return sorted
  }
  return value
}

/** First 256 code points; never slice UTF-16 units, which would split a surrogate pair. */
function previewOf(text: string | undefined): string {
  return Array.from(text ?? '').slice(0, PREVIEW_CODE_POINTS).join('')
}

/**
 * Fill the derived fields. `receipt_hash` is always computed here — a
 * caller-supplied value would let the stored hash stop covering the receipt's
 * identifying fields, which is the one property the hash exists to guarantee.
 * A projection receipt's `unit` is likewise forced: the literal is the
 * invariant T19/T26 filter on, not a caller parameter.
 */
function buildReceipt(r: ReceiptInput): Receipt {
  const receipt: Receipt = {
    ...r,
    version: r.version ?? 1,
    receipt_hash: receiptHash(r),
    preview: previewOf(r.preview),
  }
  if (receipt.kind === 'projection') receipt.unit = 'raw'
  return receipt
}

/** One receipt as one newline-terminated JSON line. */
function serialiseReceipt(r: ReceiptInput): string {
  return `${JSON.stringify(buildReceipt(r))}\n`
}

/**
 * Reject a session id that could escape `<root>/receipts/`.
 *
 * The store rejects rather than sanitises: a malformed id is a host bug, and
 * mapping it to a different name would silently merge two sessions' receipts.
 */
function assertSessionId(sessionId: string): void {
  if (sessionId === '' || sessionId === '.' || sessionId.includes('..') || /[\\/]/.test(sessionId)) {
    throw new TypeError(`invalid sessionId: ${JSON.stringify(sessionId)}`)
  }
}

/** `stat(dir).isDirectory()`-equivalent check without recursing into Node's `mkdir` spin. */
async function ensureDirectory(dir: string): Promise<void> {
  try {
    await mkdir(dir)
    return
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EEXIST') {
      // `mkdir` reports EEXIST for a regular file too; only a directory is usable.
      if ((await stat(dir)).isDirectory()) return
      throw error
    }
    if (code !== 'ENOENT') throw error
  }
  // Node's own recursive `mkdir` can spin forever on filesystems that answer
  // ENOENT for a child even though the parent exists (e.g. `/proc`, the
  // fail-closed fixture's root). Walking up one segment at a time fails fast.
  const parent = dirname(dir)
  if (parent === dir) throw new Error(`cannot create directory: ${dir}`)
  await ensureDirectory(parent)
  try {
    await mkdir(dir)
  } catch (error) {
    if (errorCode(error) !== 'EEXIST' || !(await stat(dir)).isDirectory()) throw error
  }
}

/**
 * The complete-line prefix of `data`.
 *
 * A trailing line without `\n` was never finished, so it is not a receipt:
 * `size` is the byte offset just past the last newline (zero when the first
 * line is unfinished). The tail is truncated from `path`; a failed repair is
 * ignored for reads (`repairFailure: 'ignore'`) but propagates for writes, so
 * an append never lands after a crashed half line.
 */
async function completePrefix(
  path: string,
  data: Buffer,
  repairFailure: 'throw' | 'ignore' = 'throw',
): Promise<{ valid: Buffer; size: number }> {
  let size = data.length
  const lastNewline = data.lastIndexOf(NEWLINE)
  if (size > 0 && lastNewline !== size - 1) {
    size = lastNewline + 1
    try {
      await truncate(path, size)
    } catch (error) {
      if (repairFailure === 'throw') throw error
    }
  }
  return { valid: data.subarray(0, size), size }
}

/** Read a shard, discarding (and truncating) an unfinished tail line. */
async function readShard(path: string): Promise<Receipt[]> {
  let data: Buffer
  try {
    data = await readFile(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }

  const { valid } = await completePrefix(path, data, 'ignore')
  const receipts: Receipt[] = []
  for (const line of valid.toString('utf8').split('\n')) {
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // Corrupt middle line: skip it, do not fail the whole scan.
    }
    if (isReceipt(parsed)) receipts.push(parsed)
  }
  return receipts
}

function isReceipt(value: unknown): value is Receipt {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined
}

function countNewlines(data: Buffer): number {
  let lines = 0
  for (const byte of data) {
    if (byte === NEWLINE) lines += 1
  }
  return lines
}

/**
 * Append-only, crash-safe, bounded store of receipts per session.
 *
 * See the module docs for the write and read paths. Concurrent method calls on
 * one instance are safe: writes are serialised through an internal promise
 * chain. The store is single-writer per root by design — rotation counters are
 * per instance, so two instances (or processes) writing one root can exceed the
 * shard caps and lose receipts. The plugin owns exactly one store per root.
 */
export class ReceiptStore {
  private readonly root: string
  private readonly fsyncEveryLines: number
  private readonly maxBytes: number
  private readonly maxLines: number

  /** *Consecutive* write failures; reset by any successful append. */
  private failureCount = 0
  private linesSinceSync = 0
  private readonly pending: PendingLine[] = []
  private readonly states = new Map<string, ShardState>()
  private readonly dirty = new Set<string>()
  private dirReady = false
  /** Writes run one at a time so rotation and buffer replay cannot interleave. */
  private chain: Promise<void> = Promise.resolve()

  constructor(root: string, opts: ReceiptStoreOptions = {}) {
    this.root = root
    this.fsyncEveryLines = opts.fsyncEveryLines ?? DEFAULT_FSYNC_EVERY_LINES
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  }

  /**
   * Append one receipt. Write failures never reject: they are counted and
   * buffered. An invalid session id is a caller error, not a write failure, and
   * rejects with `TypeError`.
   */
  async append(receipt: ReceiptInput): Promise<void> {
    assertSessionId(receipt.sessionId)
    const run = this.chain.then(() => this.appendNow(receipt))
    const safe = run.then(
      () => undefined,
      () => undefined,
    )
    this.chain = safe
    await safe
  }

  /** Force the buffered lines and the current shards to disk (called at turn end). */
  flush(): Promise<void> {
    // Queued like an append: a flush racing an append must not replay the same
    // buffered line twice.
    const run = this.chain.then(() => this.flushNow())
    const safe = run.then(
      () => undefined,
      () => undefined,
    )
    this.chain = safe
    return safe
  }

  /** Number of receipts readable for `sessionId` (`.1` plus current). */
  async count(sessionId: string): Promise<number> {
    let count = 0
    for await (const _ of this.scan(sessionId)) count += 1
    return count
  }

  /**
   * Yield readable receipts, oldest first: `.1` before the current shard.
   *
   * With no `sessionId`, every shard under `receipts/` is visited (session ids
   * sorted for determinism). Unparseable middle lines are skipped; the
   * unfinished trailing line is truncated and skipped.
   */
  async *scan(sessionId?: string): AsyncIterable<Receipt> {
    if (sessionId !== undefined) assertSessionId(sessionId)
    await this.chain
    const sessionIds = sessionId === undefined ? await this.listSessionIds() : [sessionId]
    for (const id of sessionIds) {
      for (const rotated of [true, false]) {
        for (const receipt of await readShard(this.shardPath(id, rotated))) {
          yield receipt
        }
      }
    }
  }

  /** Consecutive write failures; a successful append resets it to zero. */
  failures(): number {
    return this.failureCount
  }

  /** Fail-closed gate: true after {@link STOPPED_AFTER_FAILURES} consecutive write failures. */
  stopped(): boolean {
    return this.failureCount >= STOPPED_AFTER_FAILURES
  }

  private async appendNow(receipt: ReceiptInput): Promise<void> {
    let entry: PendingLine
    try {
      entry = { sessionId: receipt.sessionId, line: serialiseReceipt(receipt) }
    } catch {
      this.failureCount += 1
      return
    }

    try {
      await this.drainPending()
      await this.writeLine(entry)
    } catch {
      // Invalidating the cached counters makes the next attempt re-read the
      // shard, which also cuts a partial line this failed write may have left.
      // Re-checking the directory lets the store recover if it disappeared.
      this.states.delete(entry.sessionId)
      this.dirReady = false
      this.pending.push(entry)
      this.failureCount += 1
      return
    }

    this.failureCount = 0
    try {
      await this.syncIfDue()
    } catch {
      // The line is written, so it is not buffered again — but a failed fsync
      // still means the write path is unhealthy.
      this.failureCount += 1
    }
  }

  /** The serialised body of {@link flush}; a failure is counted, never thrown. */
  private async flushNow(): Promise<void> {
    try {
      await this.drainPending()
      await this.syncDirty()
    } catch {
      this.failureCount += 1
    }
  }

  /** Replay buffered lines in order; the head stays queued until its write succeeds. */
  private async drainPending(): Promise<void> {
    while (this.pending.length > 0) {
      await this.writeLine(this.pending[0])
      this.pending.shift()
    }
  }

  private async writeLine(entry: PendingLine): Promise<void> {
    await this.ensureDir()
    const state = await this.stateFor(entry.sessionId)
    await this.rotateIfFull(entry.sessionId, state)
    await appendFile(this.shardPath(entry.sessionId, false), entry.line, 'utf8')
    state.lines += 1
    state.bytes += Buffer.byteLength(entry.line, 'utf8')
    this.linesSinceSync += 1
    this.dirty.add(entry.sessionId)
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return
    await ensureDirectory(join(this.root, RECEIPTS_DIR))
    this.dirReady = true
  }

  /** Cached line/byte counters, loaded (and repaired) from disk on first use. */
  private async stateFor(sessionId: string): Promise<ShardState> {
    const cached = this.states.get(sessionId)
    if (cached !== undefined) return cached

    const path = this.shardPath(sessionId, false)
    let data: Buffer
    try {
      data = await readFile(path)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      data = Buffer.alloc(0)
    }

    // A crash left a partial line; appending after it would make the next
    // receipt unreadable too. `completePrefix` cuts it before counting and
    // writing, and propagates a failed repair so this append fails instead.
    const { valid, size } = await completePrefix(path, data)
    const state: ShardState = { lines: countNewlines(valid), bytes: size }
    this.states.set(sessionId, state)
    return state
  }

  private async rotateIfFull(sessionId: string, state: ShardState): Promise<void> {
    if (state.lines < this.maxLines && state.bytes < this.maxBytes) return

    if (this.dirty.has(sessionId)) {
      await this.syncSession(sessionId)
      this.dirty.delete(sessionId)
    }
    try {
      // Renaming over an existing `.1` is the whole retention policy: only the
      // current shard and its predecessor are ever kept.
      await rename(this.shardPath(sessionId, false), this.shardPath(sessionId, true))
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error // already gone: nothing to rotate
    }
    state.lines = 0
    state.bytes = 0
  }

  private async syncIfDue(): Promise<void> {
    if (this.linesSinceSync < this.fsyncEveryLines) return
    await this.syncDirty()
  }

  private async syncDirty(): Promise<void> {
    for (const sessionId of this.dirty) await this.syncSession(sessionId)
    this.dirty.clear()
    this.linesSinceSync = 0
  }

  private async syncSession(sessionId: string): Promise<void> {
    const handle = await open(this.shardPath(sessionId, false), 'a')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private shardPath(sessionId: string, rotated: boolean): string {
    const name = rotated ? `${sessionId}.1.jsonl` : `${sessionId}.jsonl`
    return join(this.root, RECEIPTS_DIR, name)
  }

  private async listSessionIds(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(join(this.root, RECEIPTS_DIR))
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
    const ids = new Set<string>()
    for (const name of names) {
      if (name.endsWith(ROTATED_SUFFIX)) ids.add(name.slice(0, -ROTATED_SUFFIX.length))
      else if (name.endsWith(CURRENT_SUFFIX)) ids.add(name.slice(0, -CURRENT_SUFFIX.length))
    }
    ids.delete('')
    return [...ids].sort()
  }
}
