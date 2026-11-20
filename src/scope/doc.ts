/**
 * Scope document model: where the plugin is allowed to act.
 *
 * `scope.json` is the single source of truth for the exposure surface (design
 * §5.5). This module only parses an already-read value; it never touches the
 * filesystem. Task 9's store owns reading, locking and writing.
 *
 * The input is the JSON-decoded value `JSON.parse` produces for `scope.json`,
 * not an arbitrary host object: exotic in-memory shapes (throwing getters,
 * inherited fields) are outside the contract and are not defended against.
 *
 * Parsing is fail-closed in three ordered stages. **Type delimitation runs
 * before the version checks**: a non-object, `null` or an array is a parse
 * failure even when it carries a `version` property. Then a numeric `version`
 * greater than `2` is a **future version**: it is a valid document written by a
 * newer plugin, so reads degrade but writes must never rewrite it (the field
 * set may be newer than this parser knows). Finally anything whose `version` is
 * not exactly `2` — version 1, a missing or non-numeric version — is an
 * **unknown version**; a version 1 document is the one upgradeable case, and
 * the command decides when to upgrade it.
 *
 * A matching stage rejects immediately, and no failure returns a partial
 * document: every failure comes back as a fresh deep copy of `DEFAULT_SCOPE`,
 * the strictest exposure (`selected + []`), so a malformed or newer-versioned
 * file degrades to "nobody sees it" rather than crashing the agent.
 *
 * Individual fields are guarded on the strict side too: an unknown `mode` is
 * `'selected'`, a non-array `workspaceIds` is `[]`, non-string members are
 * dropped, a non-boolean `shadow` is `true`, an unknown `projection` is
 * `'shadow'`, and a non-finite `revision` is `0`. `updatedAt` is never
 * validated beyond being a string.
 *
 * @module dsh-boost/scope/doc
 */
import type { ProjectionMode } from '../projection/apply.js'

/** Stable rejection code: the file names a version this parser does not know. */
export const ERR_SCOPE_UNKNOWN_VERSION = 'ERR_SCOPE_UNKNOWN_VERSION'

/**
 * Stable rejection code: the file's version is a number newer than this parser
 * (version 3+). Reads degrade like any other failure, but the document is
 * **read-only**: it may carry fields and workspace ids this parser would prune,
 * so writing it back would silently lose the user's configuration.
 */
export const ERR_SCOPE_FUTURE_VERSION = 'ERR_SCOPE_FUTURE_VERSION'

/** Stable rejection code: the file is not a scope document at all. */
export const ERR_SCOPE_PARSE_FAILED = 'ERR_SCOPE_PARSE_FAILED'

/** Stable rejection code: the file exists but could not be read. */
export const ERR_SCOPE_READ_FAILED = 'ERR_SCOPE_READ_FAILED'

/** Stable rejection code: the write's base revision is stale. */
export const ERR_SCOPE_REVISION_CONFLICT = 'ERR_SCOPE_REVISION_CONFLICT'

/** Stable rejection code: another writer holds the scope lock. */
export const ERR_SCOPE_LOCKED = 'ERR_SCOPE_LOCKED'

/**
 * Stable rejection code: the write was cancelled through its `AbortSignal`.
 *
 * Checked at every await boundary of the write path. A cancellation is not a
 * storage failure — the file is left exactly as it was — so the caller can
 * report it without implying the scope is damaged.
 */
export const ERR_SCOPE_ABORTED = 'ERR_SCOPE_ABORTED'

/** Every stable scope failure code (design §5.5 plus the future-version split). */
export type ScopeCode =
  | typeof ERR_SCOPE_UNKNOWN_VERSION
  | typeof ERR_SCOPE_FUTURE_VERSION
  | typeof ERR_SCOPE_PARSE_FAILED
  | typeof ERR_SCOPE_READ_FAILED
  | typeof ERR_SCOPE_REVISION_CONFLICT
  | typeof ERR_SCOPE_LOCKED
  | typeof ERR_SCOPE_ABORTED

/** The subset `parseScope` itself can return. */
type ParseCode =
  | typeof ERR_SCOPE_UNKNOWN_VERSION
  | typeof ERR_SCOPE_FUTURE_VERSION
  | typeof ERR_SCOPE_PARSE_FAILED

/** A parsed `scope.json` document, version 2 (design §5.5). */
export interface ScopeDoc {
  version: 2
  /** Incremented by the store on every successful write. */
  revision: number
  /** Last write time, when the store recorded one; never validated further. */
  updatedAt?: string
  mode: 'selected' | 'global'
  workspaceIds: string[]
  /** Shadow accounting switch (`boost shadow` with a boolean body). */
  shadow: boolean
  /** Projection shape: off, accounting only, or real replacement. */
  projection: ProjectionMode
}

/**
 * The strictest exposure and the fallback for every failure: nobody sees the
 * plugin until the user opts in.
 */
export const DEFAULT_SCOPE: ScopeDoc = {
  version: 2,
  revision: 0,
  mode: 'selected',
  workspaceIds: [],
  shadow: true,
  projection: 'shadow',
}

/**
 * Type delimitation and version classification, in the order the cases must be
 * checked.
 *
 * The first entry rejects everything that is not a plain object (including
 * `null` and arrays, whatever extra properties they carry). The second marks a
 * numeric version greater than 2 as a future version; it must run **before**
 * the catch-all third entry, which treats every remaining non-2 version
 * (version 1, missing, non-numeric) as unknown. A matching entry ends parsing
 * before the remaining fields are read.
 */
const DELIMITERS: ReadonlyArray<{
  readonly code: ParseCode
  readonly matches: (raw: unknown) => boolean
}> = [
  {
    code: ERR_SCOPE_PARSE_FAILED,
    matches: (raw) => raw === null || typeof raw !== 'object' || Array.isArray(raw),
  },
  {
    code: ERR_SCOPE_FUTURE_VERSION,
    matches: (raw) => {
      const version = (raw as { version?: unknown }).version
      return typeof version === 'number' && version > 2
    },
  },
  {
    code: ERR_SCOPE_UNKNOWN_VERSION,
    matches: (raw) => (raw as { version?: unknown }).version !== 2,
  },
]

/** A failed parse: always a fresh copy of the strictest document. */
function rejected(code: ParseCode): { doc: ScopeDoc; code: ParseCode } {
  return { doc: structuredClone(DEFAULT_SCOPE), code }
}

/** Strict side for `mode`: anything but the two literals means `selected`. */
function parseMode(raw: unknown): ScopeDoc['mode'] {
  return raw === 'selected' || raw === 'global' ? raw : 'selected'
}

/** Strict side for `workspaceIds`: a non-array is empty, non-strings dropped. */
function parseWorkspaceIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
}

/** Strict side for `revision`: anything but a finite number is the initial revision. */
function parseRevision(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

/** Strict side for `shadow`: a non-boolean keeps shadow accounting on. */
function parseShadow(raw: unknown): boolean {
  return typeof raw === 'boolean' ? raw : true
}

/** Strict side for `projection`: anything else falls back to shadow accounting. */
function parseProjection(raw: unknown): ProjectionMode {
  return raw === 'off' || raw === 'shadow' || raw === 'on' ? raw : 'shadow'
}

/**
 * Read one `scope.json` value, as produced by `JSON.parse`.
 *
 * A value whose type or version is wrong is rejected with a stable code and a
 * deep copy of `DEFAULT_SCOPE`; a version 2 object yields a complete document
 * built from its fields, with every malformed field degraded to its strict
 * value.
 */
export function parseScope(raw: unknown): {
  doc: ScopeDoc
  code?: 'ERR_SCOPE_UNKNOWN_VERSION' | 'ERR_SCOPE_FUTURE_VERSION' | 'ERR_SCOPE_PARSE_FAILED'
} {
  const rejection = DELIMITERS.find((delimiter) => delimiter.matches(raw))
  if (rejection) return rejected(rejection.code)

  const source = raw as Record<string, unknown>
  return {
    doc: {
      version: 2,
      revision: parseRevision(source.revision),
      ...(typeof source.updatedAt === 'string' ? { updatedAt: source.updatedAt } : {}),
      mode: parseMode(source.mode),
      workspaceIds: parseWorkspaceIds(source.workspaceIds),
      shadow: parseShadow(source.shadow),
      projection: parseProjection(source.projection),
    },
  }
}

/**
 * The upgrade base for a version 1 document.
 *
 * Reading a v1 file still degrades to {@link DEFAULT_SCOPE} and reports
 * {@link ERR_SCOPE_UNKNOWN_VERSION} (design §5.5 rule 3: unknown versions are
 * read-only). Only the explicit `scope-set` upgrade may rewrite it, and this
 * function answers "what did the user's v1 file actually say" for that one
 * write: `version` becomes 2 and `revision` starts at the degraded read's 0,
 * while every recognised field keeps its value (strict side for malformed
 * ones). Never use this on the read path — a v1 document is not a valid v2
 * document and must keep presenting as invisible until upgraded.
 *
 * `undefined` for anything that is not a plain object with `version === 1`,
 * including v2, future versions, missing versions and non-objects.
 */
export function parseVersionOneScope(raw: unknown): ScopeDoc | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  if ((raw as { version?: unknown }).version !== 1) return undefined
  const source = raw as Record<string, unknown>
  return {
    version: 2,
    revision: 0,
    ...(typeof source.updatedAt === 'string' ? { updatedAt: source.updatedAt } : {}),
    mode: parseMode(source.mode),
    workspaceIds: parseWorkspaceIds(source.workspaceIds),
    shadow: parseShadow(source.shadow),
    projection: parseProjection(source.projection),
  }
}

/**
 * Whether the plugin may act for an agent in `workspaceId`.
 *
 * An agent with no workspace has the global view, and the plugin never injects
 * into the global view (design §5.5), so `undefined` is always invisible.
 * `mode: 'global'` widens to any *defined* workspace id, not to `undefined`.
 */
export function isVisible(doc: ScopeDoc, workspaceId: string | undefined): boolean {
  if (workspaceId === undefined) return false
  return doc.mode === 'global' || doc.workspaceIds.includes(workspaceId)
}
