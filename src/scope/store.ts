/**
 * Persistent scope store: one small JSON document that says where the plugin is
 * active, plus the per-agent judgement cache the synchronous prompt provider
 * reads.
 *
 * `scope.json` is read on every tool call and written only by the `boost`
 * control tool. Reads never throw: a missing file is the clean default
 * (revision 0, no code — a fresh install has simply configured nothing yet),
 * while an unreadable, corrupt or newer-versioned file means "nobody sees the
 * plugin" (`DEFAULT_SCOPE`) plus a stable code for the receipt/status channel.
 * A failed read never touches the file. Writes are compare-and-swap: the caller
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
 * agent (design §5.5). `remember` is the only writer; `forget` is called from
 * the plugin's `session/disposed` handler so a long-lived process does not keep
 * one entry per session forever.
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
  ERR_SCOPE_ABORTED,
  ERR_SCOPE_FUTURE_VERSION,
  ERR_SCOPE_LOCKED,
  ERR_SCOPE_PARSE_FAILED,
  ERR_SCOPE_READ_FAILED,
  ERR_SCOPE_WRITE_FAILED,
  ERR_SCOPE_REVISION_CONFLICT,
  ERR_SCOPE_UNKNOWN_VERSION,
  parseScope,
  parseVersionOneScope,
} from './doc.js'
import type { ScopeCode, ScopeDoc } from './doc.js'

const SCOPE_FILE = 'scope.json'
const LOCK_FILE = 'scope.lock'
/** A lock older than this is a reclaim candidate when its pid is dead (or unrecorded). */
const LOCK_STALE_MS = 60_000
/**
 * After this much time a lock is taken over even when its recorded pid is alive.
 *
 * `startedAt` (not `mtime`) is the age source when present. The write section
 * inside the lock is synchronous and tiny, so a ten-minute hold means a crashed
 * writer whose pid the OS reused; without this bound such a lock wedges every
 * `boost scope` write until it is deleted by hand. Ten times the dead-pid
 * timeout keeps a genuinely slow writer safe.
 */
const LOCK_TAKEOVER_MS = 10 * LOCK_STALE_MS
/** Largest value `process.kill` accepts as a pid (signed 32-bit). */
const MAX_PID = 2_147_483_647
/** Stable code logged when a live-pid lock is reclaimed on age alone. */
export const ERR_SCOPE_LOCK_TAKEOVER = 'ERR_SCOPE_LOCK_TAKEOVER'
/** Per-process identity in the lock file: distinguishes a reused pid from this boot. */
const BOOT_NONCE = randomUUID()

/**
 * One disk read.
 *
 * A missing file is its own arm, not a failure: it still carries the strict
 * default to serve, but no code and no degraded flag, because "nothing has
 * been configured yet" is the clean state a fresh install starts in. Both read
 * paths and the write path use `missing` to tell a first write from an I/O
 * error; only genuine failures carry a stable `code` and `cause`.
 */
type DiskRead =
  | { ok: true; doc: ScopeDoc; mtimeMs: number; text: string }
  | { ok: false; missing: true; doc: ScopeDoc }
  | {
      ok: false
      missing: false
      doc: ScopeDoc
      code: ScopeCode
      cause?: unknown
      /** The v1 field values an explicit upgrade must carry (see `parseVersionOneScope`). */
      upgrade?: ScopeDoc
    }

/** A write-path failure: the stable code is on `.code` and in the message. */
function scopeError(code: ScopeCode, detail: string): Error & { code: ScopeCode } {
  return Object.assign(new Error(`${code}: ${detail}`), { code })
}

/** The stable cancellation error; the file has not been touched yet. */
function abortedError(): Error & { code: ScopeCode } {
  return scopeError(ERR_SCOPE_ABORTED, 'the scope write was cancelled')
}

/** Stop before the next side effect when the caller has cancelled. */
function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortedError()
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

/**
 * Classify a failed disk read.
 *
 * `ENOENT` is the clean default: the document does not exist yet, so nobody
 * has been configured in and there is nothing to report. Every other failure
 * (permissions, I/O, a directory where a file is expected) is a genuine
 * degraded read and keeps `ERR_SCOPE_READ_FAILED`.
 */
function readFailed(error: unknown): DiskRead {
  if (errorCode(error) === 'ENOENT') {
    return { ok: false, missing: true, doc: cloneDoc(DEFAULT_SCOPE) }
  }
  return {
    ok: false,
    missing: false,
    doc: cloneDoc(DEFAULT_SCOPE),
    code: ERR_SCOPE_READ_FAILED,
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
    // A v1 document is read-only-degraded, but the explicit upgrade rewrites
    // its recognised fields rather than resetting them to DEFAULT_SCOPE
    // (review row 38). `parseVersionOneScope` is deliberately not applied to
    // the read path.
    const upgrade = parseVersionOneScope(raw)
    return {
      ok: false,
      doc: parsed.doc,
      code: parsed.code,
      missing: false,
      ...(upgrade === undefined ? {} : { upgrade }),
    }
  }
  return { ok: true, doc: parsed.doc, mtimeMs, text }
}

/** Test seam and operator hook for the lock's time-based takeover. */
export interface ScopeStoreOptions {
  /** Age after which a live-pid lock is ignored (defaults to ten dead-pid timeouts). */
  lockTakeoverMs?: number
  /** Age after which a dead-pid lock is reclaimable (defaults to 60 s). */
  lockStaleMs?: number
  /** Clock, injectable so tests do not sleep. */
  now?: () => number
  /** Sink for the takeover warning; defaults to a process warning. */
  warn?: (message: string) => void
}

export class ScopeStore {
  private readonly file: string
  private readonly lockFile: string
  private readonly lockStaleMs: number
  private readonly lockTakeoverMs: number
  private readonly now: () => number
  private readonly warn: (message: string) => void
  // `| undefined` rather than `?`: the field is always declared, and these
  // are cleared by assignment (`= undefined`) in several paths.
  private cached: { mtimeMs: number; text: string; doc: ScopeDoc } | undefined
  private lockOwner: string | undefined
  private readonly judgements = new Map<string, boolean>()

  constructor(private readonly dir: string, options: ScopeStoreOptions = {}) {
    this.file = join(dir, SCOPE_FILE)
    this.lockFile = join(dir, LOCK_FILE)
    this.lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS
    this.lockTakeoverMs = options.lockTakeoverMs ?? LOCK_TAKEOVER_MS
    this.now = options.now ?? Date.now
    this.warn = options.warn ?? ((message: string) => process.emitWarning(message))
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
      // A missing file is the clean default (revision 0, no degraded code);
      // a genuine failure keeps its stable code.
      if (result.missing) return { doc: cloneDoc(result.doc) }
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
   * so it succeeds only when the caller passes 0. A version 1 file is based on
   * the fields it actually carries, which is how `boost scope set` explicitly
   * upgrades it. Every other present-but-unusable document is refused before
   * the mutation: a **future** version (a numeric version greater than 2) with
   * `ERR_SCOPE_FUTURE_VERSION`, a non-document with
   * `ERR_SCOPE_PARSE_FAILED`, a missing or non-numeric version with
   * `ERR_SCOPE_UNKNOWN_VERSION`, and an unreadable file with
   * `ERR_SCOPE_READ_FAILED`. Each refusal leaves the file byte-identical.
   */
  async write(
    mutate: (doc: ScopeDoc) => ScopeDoc,
    baseRevision: number,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<ScopeDoc> {
    const signal = options.signal
    checkAbort(signal)
    await this.ensureDirectory()
    checkAbort(signal)
    await this.acquireLock(signal)
    try {
      checkAbort(signal)
      const current = this.readDiskSync()
      checkAbort(signal)
      let base: ScopeDoc
      if (current.ok) {
        base = current.doc
      } else if (current.missing) {
        // A first write starts from the strict default at revision 0.
        base = current.doc
      } else {
        if (current.code === ERR_SCOPE_FUTURE_VERSION) {
          throw scopeError(
            ERR_SCOPE_FUTURE_VERSION,
            `refusing to rewrite ${this.file}: it declares a newer scope version`,
          )
        }
        if (current.code === ERR_SCOPE_READ_FAILED) {
          const detail = current.cause === undefined ? 'unknown read error' : messageOf(current.cause)
          throw scopeError(ERR_SCOPE_READ_FAILED, `cannot read ${this.file}: ${detail}`)
        }
        // Both remaining codes mean the bytes are present but unusable. Key on
        // the code, not on this branch: only a v1 document (whose `upgrade`
        // `decode` supplied) has recognised fields worth preserving, and only
        // its documented `scope-set` upgrade may rewrite the file. A parse
        // failure has no fields at all, and a missing or non-numeric version is
        // equally unrepresentable; basing a write on DEFAULT_SCOPE for either
        // would silently replace the user's document, which `docs/RELEASE.md`
        // promises not to do ("写拒绝" / "写不盲改").
        if (current.code === ERR_SCOPE_PARSE_FAILED) {
          throw scopeError(
            ERR_SCOPE_PARSE_FAILED,
            `refusing to rewrite ${this.file}: it is not a scope document`,
          )
        }
        if (current.upgrade === undefined) {
          throw scopeError(
            ERR_SCOPE_UNKNOWN_VERSION,
            `refusing to rewrite ${this.file}: it declares an unknown scope version`,
          )
        }
        // A v1 file was read as DEFAULT_SCOPE at revision 0, but its recognised
        // fields are the user's configuration: base the upgrade on those so a
        // partial `scope-set` cannot silently drop `global`/`workspaceIds`.
        base = current.upgrade
      }
      if (base.revision !== baseRevision) {
        throw scopeError(
          ERR_SCOPE_REVISION_CONFLICT,
          `base revision ${baseRevision} does not match ${base.revision}`,
        )
      }

      const doc: ScopeDoc = {
        ...mutate(base),
        revision: baseRevision + 1,
        updatedAt: new Date().toISOString(),
      }
      checkAbort(signal)
      let written: { mtimeMs: number; text: string }
      try {
        written = this.writeAtomic(doc)
      } catch (error) {
        // A write failure is not a read failure: the caller still knows its
        // baseline, and telling it to re-read would discard a draft that is
        // perfectly good. Rule 8 requires a stable code on every error.
        throw scopeError(ERR_SCOPE_WRITE_FAILED, `cannot write ${this.file}: ${messageOf(error)}`)
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

  /**
   * Drop one session's cached judgement on session disposal.
   *
   * The judgement map is per session and otherwise lives as long as the plugin;
   * without this a process that served many sessions would retain one boolean
   * (and its string key) per session forever.
   */
  forget(key: string): void {
    this.judgements.delete(key)
  }

  /** Synchronous per-agent lookup: a miss is `fallback`, and fail-closed is `false`. */
  judgement(key: string, fallback?: boolean): boolean {
    return this.judgements.get(key) ?? fallback ?? false
  }

  /**
   * The cached judgement, or `undefined` when this key was never judged.
   *
   * `judgement()` collapses "not judged yet" into `false` — right for a
   * decision that must fail closed, wrong for a caller that has to tell the
   * two apart. The tool-visibility predicate is that caller: a cold cache must
   * leave the tool **shown**, or the first steps of every session would hide
   * the control plane.
   */
  peekJudgement(key: string): boolean | undefined {
    return this.judgements.get(key)
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
      // Creating the directory is part of the write path: a failure here is a
      // write failure, and telling the caller to re-read would be wrong.
      throw scopeError(ERR_SCOPE_WRITE_FAILED, `cannot create ${this.dir}: ${messageOf(error)}`)
    }
  }

  /**
   * Take the write lock, reclaiming a stale lock at most once.
   *
   * Two independent staleness rules:
   *
   * 1. dead-owner reclaim — older than `lockStaleMs` **and** the recorded pid is
   *    dead (or unrecorded/unparseable/out of pid range);
   * 2. bounded takeover — the lock's `startedAt` (falling back to mtime) is
   *    older than `lockTakeoverMs`, **even when its pid is alive**. A pid is
   *    reused after a crash, so rule 1 alone can leave `scope.lock` held for the
   *    whole process lifetime in a container. The hold window is one small
   *    synchronous write, so a lock this old is a crashed writer.
   *
   * The takeover re-reads the lock immediately before unlinking and refuses if
   * its bytes or mtime changed, which narrows the cross-process race. Two
   * writers can still judge the same lock stale; `releaseLock` only removes a
   * lock whose content it wrote, and the CAS revision check still refuses to
   * merge divergent writes, so the residual race cannot corrupt the document.
   *
   * When that first read finds **no** lock there is nothing to compare against,
   * so the reclaim is refused with `ERR_SCOPE_LOCKED`. `createLock` already saw
   * the file exist; a lock created between that failure and the read is
   * indistinguishable from one a live writer still owns, and unlinking it
   * would lose that writer's update. Refusing is safe (the caller retries) and
   * the alternative is the one case the changed-lock guard cannot cover.
   */
  private async acquireLock(signal?: AbortSignal): Promise<void> {
    checkAbort(signal)
    if (await this.createLock()) {
      // `createLock` is the one await that can leave a lock behind; an abort
      // observed after it returns must release it, not strand it.
      if (signal?.aborted === true) {
        this.releaseLock()
        throw abortedError()
      }
      return
    }
    checkAbort(signal)
    const first = this.readLock()
    const decision = this.classifyLock(first)
    if (decision === 'held') {
      throw scopeError(ERR_SCOPE_LOCKED, `${this.lockFile} is held by another writer`)
    }
    if (decision === 'missing') {
      throw scopeError(
        ERR_SCOPE_LOCKED,
        `${this.lockFile} existed for createLock but vanished before it could be inspected; another writer may hold it now`,
      )
    }
    if (decision === 'takeover') {
      this.warn(
        `${ERR_SCOPE_LOCK_TAKEOVER}: taking over ${this.lockFile} from pid ${
          first?.pid ?? 'unknown'
        } after ${Math.round(this.ageOf(first) / 1000)}s; the recording process may have crashed and its pid been reused`,
      )
    }

    // Re-read before the unlink: a writer that replaced the lock between the
    // decision and here must not be evicted on a stale observation.
    const again = this.readLock()
    if (again !== undefined && first !== undefined) {
      if (again.text !== first.text || again.mtimeMs !== first.mtimeMs) {
        throw scopeError(ERR_SCOPE_LOCKED, `${this.lockFile} changed while being reclaimed`)
      }
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
    if (signal?.aborted === true) {
      this.releaseLock()
      throw abortedError()
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

    const content = JSON.stringify({
      pid: process.pid,
      startedAt: this.now(),
      nonce: BOOT_NONCE,
    })
    let failure: unknown
    try {
      await handle.writeFile(content)
    } catch (error) {
      failure = error
    } finally {
      await handle.close().catch(() => {})
    }
    if (failure !== undefined) {
      // A lock without owner data would block for the stale timeout; remove
      // what we created.
      await unlink(this.lockFile).catch(() => {})
      throw scopeError(ERR_SCOPE_LOCKED, `cannot write ${this.lockFile}: ${messageOf(failure)}`)
    }
    this.lockOwner = content
    return true
  }

  /**
   * One read of the lock: bytes, mtime and the owner fields they record.
   *
   * `undefined` means absent (the `EEXIST` raced a release): the caller may
   * retry the create. An unreadable-but-present lock is returned with the mtime
   * and no owner fields, so it becomes reclaimable only after the dead-pid
   * timeout — never immediately, because an unreadable live lock must not be
   * evicted on a guess.
   */
  private readLock(): { text: string; mtimeMs: number; pid?: number; startedAt?: number } | undefined {
    let mtimeMs: number
    try {
      mtimeMs = statSync(this.lockFile).mtimeMs
    } catch {
      return undefined
    }
    let text: string
    try {
      text = readFileSync(this.lockFile, 'utf8')
    } catch {
      return { text: '', mtimeMs }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { text, mtimeMs }
    }
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    const pid = record.pid
    const startedAt = record.startedAt
    return {
      text,
      mtimeMs,
      ...(typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid <= MAX_PID ? { pid } : {}),
      ...(typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0 && startedAt <= this.now()
        ? { startedAt }
        : {}),
    }
  }

  /** Age from `startedAt` when it is usable, otherwise from the file's mtime. */
  private ageOf(lock: { mtimeMs: number; startedAt?: number } | undefined): number {
    if (lock === undefined) return 0
    return Math.max(0, this.now() - (lock.startedAt ?? lock.mtimeMs))
  }

  /** Whether the lock is reclaimable, and whether that decision needs a warning. */
  private classifyLock(
    lock: { mtimeMs: number; pid?: number; startedAt?: number } | undefined,
  ): 'held' | 'dead' | 'takeover' | 'missing' {
    if (lock === undefined) return 'missing'
    const age = this.ageOf(lock)
    if (age <= this.lockStaleMs) return 'held'
    if (age >= this.lockTakeoverMs) return 'takeover'
    return lock.pid === undefined || !isProcessAlive(lock.pid) ? 'dead' : 'held'
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
