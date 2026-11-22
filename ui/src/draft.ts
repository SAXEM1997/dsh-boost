/**
 * The form's pure half: seeding, dirtiness, and the reasons saving is off.
 *
 * Kept out of the component because these are the rules a reviewer will want to
 * check against the spec, and a rule buried in JSX cannot be checked without a
 * DOM. Nothing here touches React or the network.
 */
import type { StatePayload, WorkspaceListing } from '../../src/shared/api-types.js'

/** The four fields the page may write. */
export interface ScopeDraft {
  mode: 'selected' | 'global'
  workspaceIds: string[]
  shadow: boolean
  projection: 'off' | 'shadow' | 'on'
}

/** The document as `scope-get` returned it, narrowed to what the form needs. */
export interface ScopeDocument extends ScopeDraft {
  version: number
  revision: number
}

/** A document this page is willing to write over. */
export type ScopeSeed = ScopeDocument

const isMode = (value: unknown): value is ScopeDraft['mode'] => value === 'selected' || value === 'global'
const isProjection = (value: unknown): value is ScopeDraft['projection'] =>
  value === 'off' || value === 'shadow' || value === 'on'

/**
 * Reads the `scope-get` envelope into a seed, or `undefined`.
 *
 * `undefined` is the honest answer for "the page has no document to write
 * over": a defaulted draft here would let the operator save a document the
 * plugin refused to read, overwriting whatever made it unreadable.
 */
export function seedOf(scope: unknown): ScopeSeed | undefined {
  if (scope === null || typeof scope !== 'object') return undefined
  const envelope = scope as { ok?: unknown; data?: unknown }
  if (envelope.ok !== true || envelope.data === null || typeof envelope.data !== 'object') return undefined
  const doc = envelope.data as Record<string, unknown>
  const revision = doc.revision
  const version = doc.version
  const shadow = doc.shadow
  const workspaceIds = doc.workspaceIds
  if (typeof revision !== 'number' || !Number.isFinite(revision)) return undefined
  if (typeof version !== 'number' || !Number.isFinite(version)) return undefined
  if (typeof shadow !== 'boolean') return undefined
  if (!Array.isArray(workspaceIds) || !workspaceIds.every(id => typeof id === 'string')) return undefined
  if (!isMode(doc.mode) || !isProjection(doc.projection)) return undefined
  return {
    version,
    revision,
    mode: doc.mode,
    workspaceIds: [...workspaceIds],
    shadow,
    projection: doc.projection,
  }
}

/** The draft a seed implies: the document's own values, in the form's shape. */
export function draftOf(seed: ScopeSeed): ScopeDraft {
  return {
    mode: seed.mode,
    workspaceIds: [...seed.workspaceIds],
    shadow: seed.shadow,
    projection: seed.projection,
  }
}

/** Whether the draft differs from the document it was seeded from. */
export function isDirty(draft: ScopeDraft, seed: ScopeSeed): boolean {
  if (draft.mode !== seed.mode) return true
  if (draft.shadow !== seed.shadow) return true
  if (draft.projection !== seed.projection) return true
  if (draft.workspaceIds.length !== seed.workspaceIds.length) return true
  return draft.workspaceIds.some(id => !seed.workspaceIds.includes(id))
}

/** Codes that mean "this document's version is not one this page writes". */
const VERSION_CODES = new Set([
  'ERR_SCOPE_UNKNOWN_VERSION',
  'ERR_SCOPE_FUTURE_VERSION',
  'ERR_SCOPE_PARSE_FAILED',
])

/** One reason saving is unavailable, with the code it came from. */
export interface DisableReason {
  /** Stable identity for the reason, not for the code behind it. */
  id: 'version-unsupported' | 'workspaces-unavailable' | 'not-writable'
  code: string
}

/**
 * The reasons saving is off — each computed from a different input.
 *
 * Three sources, deliberately not derived from one another: a document whose
 * version this page cannot write, a registry whose list could not be read, and
 * a scope read that produced no document at all are three different situations
 * with three different remedies, and two of them can be true at once.
 */
export function disableReasons(scope: unknown, workspaces: WorkspaceListing | undefined): DisableReason[] {
  const reasons: DisableReason[] = []
  const envelope = (scope ?? {}) as { ok?: unknown; code?: unknown }
  const code = typeof envelope.code === 'string' ? envelope.code : ''
  if (VERSION_CODES.has(code)) reasons.push({ id: 'version-unsupported', code })
  if (workspaces !== undefined && workspaces.available === false) {
    reasons.push({ id: 'workspaces-unavailable', code: workspaces.code })
  }
  if (envelope.ok !== true) {
    reasons.push({ id: 'not-writable', code: code === '' ? 'ERR_SCOPE_UNREADABLE' : code })
  }
  return reasons
}

/** Ids the saved document names that the registry does not have. */
export function staleWorkspaceIds(seed: ScopeSeed | undefined, workspaces: WorkspaceListing | undefined): string[] {
  if (seed === undefined || workspaces === undefined || workspaces.available !== true) return []
  const known = new Set(workspaces.entries.map(entry => entry.id))
  return seed.workspaceIds.filter(id => !known.has(id))
}

/**
 * Ids ticked in the draft that the registry does not have.
 *
 * Separate from {@link staleWorkspaceIds}: those are inert ids already saved,
 * these are ids the operator is about to save and whose path cannot be shown.
 */
export function pathUnmatched(draft: ScopeDraft, workspaces: WorkspaceListing | undefined): string[] {
  if (workspaces === undefined || workspaces.available !== true) return []
  const known = new Set(workspaces.entries.map(entry => entry.id))
  return draft.workspaceIds.filter(id => !known.has(id))
}

/** The body a save sends: the four writable fields and nothing else. */
export function patchOf(draft: ScopeDraft): ScopeDraft {
  return {
    mode: draft.mode,
    workspaceIds: [...draft.workspaceIds],
    shadow: draft.shadow,
    projection: draft.projection,
  }
}

/** Whether a payload carries a registry the page could read. */
export function registryOf(payload: StatePayload | undefined): WorkspaceListing | undefined {
  return payload?.workspaces
}
