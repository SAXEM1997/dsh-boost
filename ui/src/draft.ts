/**
 * The form's pure half: seeding, dirtiness, and the reasons saving is off.
 *
 * Kept out of the component because these are the rules a reviewer will want to
 * check against the spec, and a rule buried in JSX cannot be checked without a
 * DOM. Nothing here touches React or the network.
 */
import type { Envelope, WorkspaceEntry, WorkspaceListing } from '../../src/shared/api-types.js'
import type { BoostStatus } from '../../src/tools/boost.js'

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

/** The three projection modes, in the order the control offers them. */
export const PROJECTIONS: readonly ScopeDraft['projection'][] = ['off', 'shadow', 'on']

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
export function seedOf(scope: unknown): ScopeDocument | undefined {
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
export function draftOf(seed: ScopeDocument): ScopeDraft {
  return patchOf(seed)
}

/** Whether the draft differs from the document it was seeded from. */
export function isDirty(draft: ScopeDraft, seed: ScopeDocument): boolean {
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
  const unreadable = envelope.ok !== true
  // Disjoint on purpose. A version failure is a document this page must not
  // touch; a read failure that is not a version failure is a document it could
  // not obtain. Both block saving, for different reasons with different
  // remedies, and either can coincide with a broken registry.
  if (unreadable && VERSION_CODES.has(code)) {
    reasons.push({ id: 'version-unsupported', code })
  } else if (unreadable) {
    reasons.push({ id: 'not-writable', code: code === '' ? 'ERR_SCOPE_READ_FAILED' : code })
  }
  if (workspaces !== undefined && workspaces.available === false) {
    reasons.push({ id: 'workspaces-unavailable', code: workspaces.code })
  }
  return reasons
}

/**
 * Ids the draft would save that the registry does not have.
 *
 * Reads the draft, not the seed: the removal control stages a drop in the
 * draft, and a diagnostic that kept listing the removed id would describe the
 * document on disk while the form edits the next one. `ScopeDocument` extends
 * `ScopeDraft`, so a seed is still accepted where only the saved ids matter.
 */
export function staleWorkspaceIds(
  draft: ScopeDraft | undefined,
  workspaces: WorkspaceListing | undefined,
): string[] {
  if (draft === undefined || workspaces === undefined || workspaces.available !== true) return []
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

/**
 * Whether the draft has this workspace ticked.
 *
 * Compares the entry's ID, never its path: `workspaceIds` is matched against a
 * workspace id by the plugin's own visibility check, so writing a path there
 * would produce a document that never activates anything — silently, because
 * both are strings. The whole reason this lives here rather than inline in the
 * component is that no test can reach a JSX comparison.
 */
export function isTicked(draft: ScopeDraft, entry: WorkspaceEntry): boolean {
  return draft.workspaceIds.includes(entry.id)
}

/** The draft with this workspace ticked or unticked, by id. */
export function toggleTicked(draft: ScopeDraft, entry: WorkspaceEntry): ScopeDraft {
  const has = draft.workspaceIds.includes(entry.id)
  return {
    ...draft,
    workspaceIds: has
      ? draft.workspaceIds.filter(id => id !== entry.id)
      : [...draft.workspaceIds, entry.id],
  }
}

/**
 * The draft with `id` dropped, so the next save removes it.
 *
 * This is the control a stale id never had: it is not in the registry, so it
 * has no checkbox, and without this the saved id could never leave the
 * document. Filtering makes a repeated removal a no-op.
 */
export function removeWorkspaceId(draft: ScopeDraft, id: string): ScopeDraft {
  return {
    ...draft,
    workspaceIds: draft.workspaceIds.filter(current => current !== id),
  }
}

/** What the page can say about the status read. */
export type StatusRead =
  | { ok: true; data: BoostStatus }
  | { ok: false; code?: string }

/**
 * Reads the status envelope, keeping "no answer at all" distinct.
 *
 * The payload is typed now, so the unwrap is a property read rather than a
 * string path. `undefined` still means "status did not answer" — the fetch
 * failed, or the route omitted the block — and both arms must stop the page
 * from claiming health it did not observe. The failure arm's code is optional
 * only for that absent case; a real `runBoost` failure always names one.
 */
export function envelopeOf(value: Envelope<BoostStatus> | undefined): StatusRead {
  if (value === undefined) return { ok: false }
  return value.ok ? { ok: true, data: value.data } : { ok: false, code: value.code }
}
