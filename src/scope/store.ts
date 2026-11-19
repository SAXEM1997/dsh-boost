/**
 * Persistent scope store: one small JSON document that says where the plugin is
 * active, plus the per-agent judgement cache the synchronous prompt provider
 * reads.
 *
 * `scope.json` is read on every tool call and written only by the `boost`
 * control tool. Reads therefore degrade instead of throwing — a missing,
 * unreadable, corrupt or newer-versioned file means "nobody sees the plugin"
 * (`DEFAULT_SCOPE`) and a stable code for the receipt/status channel — and a
 * failed read never touches the file. Writes are compare-and-swap: the caller
 * passes the revision it last saw, the store locks, verifies that revision,
 * mutates, bumps it, and renames a temporary file over `scope.json`. The rename
 * makes a crash leave either the old or the new document, never a half-written
 * one. The revision check makes a lost update require the narrow stale-lock
 * reclaim race documented at `acquireLock`; it cannot silently corrupt or merge
 * a document.
 *
 * ## Sync/async boundary
 *
 * The read path is async (`stat` + `readFile`), because it is called on the
 * hot step path of a live agent and must not block the event loop. The write
 * path is async only while acquiring the lock: everything inside the lock —
 * the disk read, the mutation, the atomic write — is synchronous, so no other
 * writer can interleave between the revision check and the write.
 *
 * ## Cache
 *
 * The cache stores the last validated parse next to the exact bytes and mtime
 * it was parsed from. A read reuses that parse only when both the mtime and the
 * exact bytes match. Byte identity implies the parsed `revision` is unchanged
 * (the invariant design §5.5 asks for), and it is strictly safer than an
 * mtime+revision key: an external edit that preserves both would otherwise be
 * served from the old parse. The cache therefore avoids re-parsing the same
 * bytes, not the read itself — the revision check requires reading
 * `scope.json`. Cache hits keep the cached document object internally and
 * every returned document is a deep copy, so a caller mutating a result cannot
 * poison the cache.
 *
 * The judgement cache is intentionally per agent key (the session id). A
 * single global value would leak one workspace's visibility into every other
 * agent (design §5.5). `remember` is the only writer; there is no eviction.
 *
 * @module dsh-boost/scope/store
 */
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_SCOPE,
  ERR_SCOPE_LOCKED,
  ERR_SCOPE_PARSE_FAILED,
  ERR_SCOPE_READ_FAILED,
  ERR_SCOPE_REVISION_CONFLICT,
  parseScope,
} from './doc.js'
import type { ScopeCode, ScopeDoc } from './doc.js'

const SCOPE_FILE = 'scope.json'
const LOCK_FILE = 'scope.lock'
/** A lock older than this is a reclaim candidate — but only if its pid is dead. */
const LOCK_STALE_MS = 60_000
/** Largest value `process.kill` accepts as a pid (signed 32-bit). */
const MAX_PID = 2_147_483_647

/**
 * One disk read. `ok: false` still carries a document to serve (the strict
 * default), the stable code to report, and whether the file simply did not
 * exist — only `write` uses `missing`, to tell a first write from an I/O error.
 * `cause` keeps the underlying error for the write path's diagnostic.
 */
type DiskRead =
  | { ok: true; doc: ScopeDoc; mtimeMs: number; text: string }
  | { ok: false; doc: ScopeDoc; code: ScopeCode; missing: boolean; cause?: unknown }

/** A write-path failure: the stable code is on `.code` and in the message. */
function scopeError(code: ScopeCode, detail: string): Error & { code: ScopeCode } {
  return Object.assign(new Error(`${code}: ${detail}`), { code })
}

/** The errno string of a Node filesystem error, if it has one. */
function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined
}

/** A human-readable detail for a wrapped error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Liveness probe for lock reclamation.
 *
 * `EPERM` means the process exists but belongs to another user, so it counts as
 * alive; only `ESRCH` proves the recorded writer is gone. Any other outcome is
 * treated as alive too: reclamation must never evict a writer on a guess.
 * `readLockPid` bounds the pid to the range `process.kill` accepts, so the
 * impossible-pid `ERR_INVALID_ARG_TYPE` path is never reached.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

/** A deep copy: cached and returned documents never share mutable state. */
function cloneDoc(doc: ScopeDoc): ScopeDoc {
  return structuredClone(doc)
}

/** A failed disk read degrades to the strict default; a missing file is a failure. */
function readFailed(error: unknown): DiskRead {
  return {
    ok: false,
    doc: cloneDoc(DEFAULT_SCOPE),
    code: ERR_SCOPE_READ_FAILED,
    missing: errorCode(error) === 'ENOENT',
    cause: error,
  }
}

/** Decode one already-read `scope.json`; JSON errors are parse failures too. */
function decode(text: string, mtimeMs: number): DiskRead {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      doc: cloneDoc(DEFAULT_SCOPE),
      code: ERR_SCOPE_PARSE_FAILED,
      missing: false,
      cause: error,
    }
  }
  const parsed = parseScope(raw)
  if (parsed.code !== undefined) {
    return { ok: false, doc: parsed.doc, code: parsed.code, missing: false }
  }
  return { ok: true, doc: parsed.doc, mtimeMs, text }
}

export class ScopeStore {
  private readonly file: string
  private readonly lockFile: string
  private cached?: { mtimeMs: number; text: string; doc: ScopeDoc }
  private lockOwner?: string
  private readonly judgements = new Map<string, boolean>()

  constructor(private readonly dir: string) {
    this.file = join(dir, SCOPE_FILE)
    this.lockFile = join(dir, LOCK_FILE)
  }

  /**
   * Read the current document. Never throws and never writes: every stat,
   * read, JSON or shape failure comes back as a fresh `DEFAULT_SCOPE` plus
   * `degraded: 'scope-degraded'` and the stable code.
   */
  async read(): Promise<{ doc: ScopeDoc; degraded?: 'scope-degraded'; code?: ScopeCode }> {
    const result = await this.readDisk()
    if (!result.ok) {
      // Ruling 1: a degraded document is never a cache entry. The next call
      // must retry the disk instead of serving the strict default forever.
      this.cached = undefined
      return { doc: cloneDoc(result.doc), degraded: 'scope-degraded', code: result.code }
    }

    // On a cache hit `result.doc` is the cached object (identical bytes);
    // either way the caller gets a copy, so a mutation cannot poison it.
    this.cached = { mtimeMs: result.mtimeMs, text: result.text, doc: result.doc }
    return { doc: cloneDoc(result.doc) }
  }

  /**
   * Compare-and-swap write. Returns the new document (revision `baseRevision + 1`,
   * `updatedAt` now) and leaves it cached.
   *
   * A missing file is a first write: the base is `DEFAULT_SCOPE` at revision 0,
   * so it succeeds only when the caller passes 0. A corrupt or unknown-version
   * file is also based on the strict default, which is how `boost scope set`
   * explicitly upgrades a version 1 document. An existing file that cannot be
   * read at all is `ERR_SCOPE_READ_FAILED` — never overwritten blindly.
   */
  async write(mutate: (doc: ScopeDoc) => ScopeDoc, baseRevision: number): Promise<ScopeDoc> {
    await this.ensureDirectory()
    await this.acquireLock()
    try {
      const current = this.readDiskSync()
      if (!current.ok && current.code === ERR_SCOPE_READ_FAILED && !current.missing) {
        const detail = current.cause === undefined ? 'unknown read error' : messageOf(current.cause)
        throw scopeError(ERR_SCOPE_READ_FAILED, `cannot read ${this.file}: ${detail}`)
      }
      if (current.doc.revision !== baseRevision) {
        throw scopeError(
          ERR_SCOPE_REVISION_CONFLICT,
          `base revision ${baseRevision} does not match ${current.doc.revision}`,
        )
      }

      const doc: ScopeDoc = {
        ...mutate(current.doc),
        revision: baseRevision + 1,
        updatedAt: new Date().toISOString(),
      }
      let written: { mtimeMs: number; text: string }
      try {
        written = this.writeAtomic(doc)
      } catch (error) {
        // Serialization and disk failures are storage failures too; rule 8
        // requires a stable code on every error the write path raises.
        throw scopeError(ERR_SCOPE_READ_FAILED, `cannot write ${this.file}: ${messageOf(error)}`)
      }
      // Clone before caching: `doc` may still share arrays with an object the
      // caller (or `mutate`) holds, and the cache must never alias those.
      this.cached = { mtimeMs: written.mtimeMs, text: written.text, doc: cloneDoc(doc) }
      return cloneDoc(doc)
    } finally {
      this.releaseLock()
    }
  }

  /** Cache one agent's visibility judgement; the only writer of this cache. */
  remember(key: string, visible: boolean): void {
    this.judgements.set(key, visible)
  }

  /** Synchronous per-agent lookup: a miss is `fallback`, and fail-closed is `false`. */
  judgement(key: string, fallback?: boolean): boolean {
    return this.judgements.get(key) ?? fallback ?? false
  }

  /** Async read path: stat + read + decode, all failures degraded. */
  private async readDisk(): Promise<DiskRead> {
    try {
      const stats = await stat(this.file)
      const text = await readFile(this.file, 'utf8')
      return this.decodeFromCache(text, stats.mtimeMs)
    } catch (error) {
      return readFailed(error)
    }
  }

  /**
   * Reuse the previous parse only when the exact bytes and mtime were already
   * parsed. Byte identity is a stronger key than mtime+revision: an external
   * edit that keeps both cannot be served from the old parse.
   */
  private decodeFromCache(text: string, mtimeMs: number): DiskRead {
    const cached = this.cached
    if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.text === text) {
      return { ok: true, doc: cached.doc, mtimeMs, text }
    }
    return decode(text, mtimeMs)
  }

  /** Sync read path, used only inside the write lock (see the module comment). */
  private readDiskSync(): DiskRead {
    try {
      const stats = statSync(this.file)
      const text = readFileSync(this.file, 'utf8')
      return decode(text, stats.mtimeMs)
    } catch (error) {
      return readFailed(error)
    }
  }

  /** The write path must be able to create `<root>/boost` on a fresh install. */
  private async ensureDirectory(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
    } catch (error) {
      throw scopeError(ERR_SCOPE_READ_FAILED, `cannot create ${this.dir}: ${messageOf(error)}`)
    }
  }

  /**
   * Take the write lock, reclaiming a stale lock at most once.
   *
   * A lock is stale only when it is older than 60 s **and** its recorded pid is
   * dead (or unrecorded/unparseable/out of pid range); a live writer is never
   * evicted by timeout alone. The staleness decision and the unlink are
   * synchronous here, so they share one tick. A residual cross-process race
   * remains: two writers can both judge the same lock stale, and one can unlink
   * the other's fresh lock. `releaseLock` therefore only removes a lock whose
   * content it wrote, and the CAS revision check still refuses to merge
   * divergent writes; a lost update in that window is possible, corruption is
   * not.
   */
  private async acquireLock(): Promise<void> {
    if (await this.createLock()) return
    if (!this.lockIsStale()) {
      throw scopeError(ERR_SCOPE_LOCKED, `${this.lockFile} is held by another writer`)
    }
    try {
      unlinkSync(this.lockFile)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw scopeError(ERR_SCOPE_LOCKED, `cannot reclaim ${this.lockFile}: ${messageOf(error)}`)
      }
    }
    if (!(await this.createLock())) {
      throw scopeError(ERR_SCOPE_LOCKED, `${this.lockFile} is held by another writer`)
    }
  }

  /** `open(lock, 'wx')`; false means another writer holds it. */
  private async createLock(): Promise<boolean> {
    let handle: FileHandle
    try {
      handle = await open(this.lockFile, 'wx')
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false
      throw scopeError(ERR_SCOPE_LOCKED, `cannot create ${this.lockFile}: ${messageOf(error)}`)
    }

    const content = JSON.stringify({ pid: process.pid, startedAt: Date.now() })
    let failure: unknown
    try {
      await handle.writeFile(content)
    } catch (error) {
      failure = error
    } finally {
      await handle.close().catch(() => {})
    }
    if (failure !== undefined) {
      // A lock without owner data would block for 60 s; remove what we created.
      await unlink(this.lockFile).catch(() => {})
      throw scopeError(ERR_SCOPE_LOCKED, `cannot write ${this.lockFile}: ${messageOf(failure)}`)
    }
    this.lockOwner = content
    return true
  }

  /** Both halves of the reclamation condition: old enough, and owner dead. */
  private lockIsStale(): boolean {
    let mtimeMs: number
    try {
      mtimeMs = statSync(this.lockFile).mtimeMs
    } catch (error) {
      // It vanished between EEXIST and stat; let the retry race for it.
      return errorCode(error) === 'ENOENT'
    }
    if (Date.now() - mtimeMs <= LOCK_STALE_MS) return false
    const pid = this.readLockPid()
    return pid === undefined || !isProcessAlive(pid)
  }

  /**
   * The pid recorded in the lock file, or undefined when it is absent,
   * unparseable or outside the range `process.kill` accepts. An impossible pid
   * is effectively pid-less: it makes the lock reclaimable after 60 s instead
   * of wedging every future write. A negative pid is also rejected here —
   * `process.kill` would interpret it as a process group.
   */
  private readLockPid(): number | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.lockFile, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return undefined
      const pid = (parsed as { pid?: unknown }).pid
      return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid <= MAX_PID
        ? pid
        : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Remove the lock only if it still contains exactly what this acquisition
   * wrote. An unconditional unlink would delete a replacement lock another
   * writer created after a stale-reclaim race. Every error is swallowed:
   * cleanup must never mask the causal error (rule 8), and a lock left behind
   * is reclaimable after 60 s while a masked conflict is not diagnosable.
   */
  private releaseLock(): void {
    const owner = this.lockOwner
    this.lockOwner = undefined
    if (owner === undefined) return
    try {
      if (readFileSync(this.lockFile, 'utf8') === owner) unlinkSync(this.lockFile)
    } catch {
      // See the method comment: cleanup never rethrows.
    }
  }

  /**
   * Serialize `doc` into a temporary file, fsync it, and rename it over
   * `scope.json`. Returns the stored file's mtime and the exact text written
   * (for the cache). A failed write removes the temporary file; the caller's
   * `finally` removes the lock.
   */
  private writeAtomic(doc: ScopeDoc): { mtimeMs: number; text: string } {
    const tempFile = join(this.dir, `.${SCOPE_FILE}.${process.pid}.${randomUUID()}.tmp`)
    const text = `${JSON.stringify(doc)}\n`
    let fd: number | undefined
    try {
      fd = openSync(tempFile, 'w')
      writeFileSync(fd, text)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      // Stat before the rename: if this fails nothing has touched `scope.json`,
      // and the mtime of the inode is what `read()` will observe afterwards.
      const mtimeMs = statSync(tempFile).mtimeMs
      renameSync(tempFile, this.file)
      return { mtimeMs, text }
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // Already closed or never opened; the unlink below is what matters.
        }
      }
      try {
        unlinkSync(tempFile)
      } catch {
        // Best effort: the temporary file may not exist if openSync failed.
      }
      throw error
    }
  }
}
