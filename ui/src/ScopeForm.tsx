/**
 * The only writable part of the page.
 *
 * Four fields, one save button, and three independent reasons the button can be
 * disabled. The draft lives here and survives a failed save untouched: the
 * ticket's rule is that an error must never move the user's typing, and the
 * only way to honour it is to keep the draft out of the fetch lifecycle.
 *
 * A conflict is not an error to retry blindly: the page shows the code and a
 * separate "re-read" button, because re-seeding from a newer document discards
 * whatever the user has not saved yet, and only they can decide that.
 */
import { copyOf, adviceFor, PROJECTION_LABEL, MODE_VALUE_SELECTED, MODE_VALUE_GLOBAL } from './copy'
import { useT } from './i18n'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { saveScope } from './api'
import {
  PROJECTIONS,
  disableReasons,
  draftOf,
  isDirty,
  isTicked,
  patchOf,
  unmatchedDraftIds,
  seedOf,
  staleWorkspaceIds,
  toggleTicked,
  type ScopeDraft,
  type ScopeDocument,
} from './draft'
import type { StatePayload, WorkspaceEntry, WorkspaceListing } from './api'
import type { DisableReason } from './draft'

/**
 * Failures a re-read can actually fix.
 *
 * Offered only here: a network or body error is not cured by re-seeding, and
 * the button discards the draft, so it must not appear next to a failure the
 * user can simply retry.
 */
const REREAD_CODES = new Set([
  'ERR_SCOPE_REVISION_CONFLICT',
  'ERR_SCOPE_LOCKED',
  'ERR_SCOPE_READ_FAILED',
  'ERR_SCOPE_UNKNOWN_VERSION',
  'ERR_SCOPE_FUTURE_VERSION',
  'ERR_SCOPE_PARSE_FAILED',
])

interface ScopeFormProps {
  payload: StatePayload
  scopeCode: string | undefined
  onReload: () => void
}

/** Renders one reason a save is blocked. Every one of them is independent. */
function BlockedBy({ reasons }: { reasons: DisableReason[] }): ReactNode {
  const t = useT()
  if (reasons.length === 0) return null
  return (
    <ul className="boost-settings__blockers">
      {reasons.map(reason => (
        <li key={reason.id} data-reason={reason.id}>
          <code>{reason.code}</code> {adviceFor(t, reason.code)}
        </li>
      ))}
    </ul>
  )
}

export function ScopeForm({ payload, scopeCode, onReload }: ScopeFormProps): ReactNode {
  const t = useT()
  const c = copyOf(t)
  const workspaces: WorkspaceListing | undefined = payload.workspaces
  const [seed, setSeed] = useState<ScopeDocument | undefined>(() => seedOf(payload.scope))
  const [draft, setDraft] = useState<ScopeDraft | undefined>(() => {
    const initial = seedOf(payload.scope)
    return initial === undefined ? undefined : draftOf(initial)
  })
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  // A new payload is a new seed. This runs on mount and after an explicit
  // re-read or a successful save — never as a reaction to a failure, which is
  // what keeps a failed save from discarding the draft.
  useEffect(() => {
    const next = seedOf(payload.scope)
    setSeed(next)
    setDraft(next === undefined ? undefined : draftOf(next))
    setFailure(undefined)
  }, [payload])

  const reasons = useMemo(() => disableReasons(payload.scope, workspaces), [payload.scope, workspaces])
  const dirty = draft !== undefined && seed !== undefined && isDirty(draft, seed)
  const stale = staleWorkspaceIds(seed, workspaces)
  const unmatched = draft === undefined ? [] : unmatchedDraftIds(draft, workspaces)
  const entries = workspaces?.available === true ? workspaces.entries : []

  const update = useCallback((patch: Partial<ScopeDraft>) => {
    setDraft(current => (current === undefined ? current : { ...current, ...patch }))
  }, [])

  const toggleWorkspace = useCallback((entry: WorkspaceEntry) => {
    setDraft(current => (current === undefined ? current : toggleTicked(current, entry)))
  }, [])

  const save = useCallback(async () => {
    if (draft === undefined || seed === undefined) return
    setSaving(true)
    setFailure(undefined)
    const result = await saveScope(patchOf(draft), seed.revision)
    setSaving(false)
    if (result.ok) {
      // A successful save changes the revision, so the seed must be re-read:
      // the next save has to present the revision it just created.
      onReload()
      return
    }
    // The draft is deliberately untouched here.
    setFailure(result.code)
  }, [draft, seed, onReload])

  if (draft === undefined || seed === undefined) {
    return (
      <section className="boost-settings__section">
        <h3>{c.SECTION_SCOPE}</h3>
        <p className="boost-settings__muted" data-code={scopeCode ?? ''}>
          {scopeCode === undefined ? c.UNAVAILABLE_REGISTRY : adviceFor(t, scopeCode)}
        </p>
        <BlockedBy reasons={reasons} />
      </section>
    )
  }

  return (
    <section className="boost-settings__section">
      <h3>{c.SECTION_SCOPE}</h3>

      <fieldset className="boost-settings__field">
        <legend>{c.LABEL_MODE}</legend>
        <label>
          <input
            type="radio"
            name="boost-mode"
            checked={draft.mode === MODE_VALUE_SELECTED}
            onChange={() => update({ mode: MODE_VALUE_SELECTED })}
          />
          {c.LABEL_MODE_SELECTED}
        </label>
        <label>
          <input
            type="radio"
            name="boost-mode"
            checked={draft.mode === MODE_VALUE_GLOBAL}
            onChange={() => update({ mode: MODE_VALUE_GLOBAL })}
          />
          {c.LABEL_MODE_GLOBAL}
        </label>
        {draft.mode === MODE_VALUE_GLOBAL ? (
          <p className="boost-settings__muted">{c.EMPTY_GLOBAL}</p>
        ) : draft.workspaceIds.length === 0 ? (
          <p className="boost-settings__muted">{c.EMPTY_SELECTED}</p>
        ) : null}
      </fieldset>

      <fieldset className="boost-settings__field" disabled={draft.mode === MODE_VALUE_GLOBAL}>
        <legend>{c.LABEL_WORKSPACES}</legend>
        {workspaces?.available === false ? (
          <p className="boost-settings__muted" data-code={workspaces.code}>
            {adviceFor(t, workspaces.code)}
          </p>
        ) : entries.length === 0 ? (
          <p className="boost-settings__muted">{c.HINT_NO_WORKSPACES_TO_PICK}</p>
        ) : (
          entries.map(entry => (
            <label key={entry.id} className="boost-settings__workspace">
              <input
                type="checkbox"
                checked={isTicked(draft, entry)}
                onChange={() => toggleWorkspace(entry)}
              />
              <span>{entry.path}</span>
            </label>
          ))
        )}
      </fieldset>

      <fieldset className="boost-settings__field">
        <legend>{c.LABEL_SHADOW}</legend>
        <label>
          <input
            type="checkbox"
            checked={draft.shadow}
            onChange={() => update({ shadow: !draft.shadow })}
          />
          {c.LABEL_SHADOW}
        </label>
      </fieldset>

      <fieldset className="boost-settings__field">
        <legend>{c.LABEL_PROJECTION}</legend>
        {PROJECTIONS.map(option => (
          <label key={option}>
            <input
              type="radio"
              name="boost-projection"
              checked={draft.projection === option}
              onChange={() => update({ projection: option })}
            />
            {c[PROJECTION_LABEL[option] ?? 'PROJECTION_OFF']}
          </label>
        ))}
      </fieldset>

      {draft.projection === 'on' ? (
        <div className="boost-settings__notice" role="note" data-notice="projection-on">
          <strong>{c.LABEL_PROJECTION_ON_PRECONDITIONS}</strong>
          <ul>
            <li>{c.HINT_PROJECTION_ON_SPILL}</li>
            <li>{c.HINT_PROJECTION_ON_THINKING}</li>
          </ul>
          <p>{c.HINT_PROJECTION_ON_ROLLBACK}</p>
        </div>
      ) : null}
      {draft.projection === 'shadow' ? (
        <p className="boost-settings__muted">{c.HINT_SHADOW_MEANS}</p>
      ) : null}

      {stale.length > 0 ? (
        <div className="boost-settings__diagnostic" data-diagnostic="stale">
          <h4>{c.LABEL_STALE_IDS}</h4>
          <ul>
            {stale.map(id => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {unmatched.length > 0 ? (
        <div className="boost-settings__diagnostic" data-diagnostic="unmatched">
          <h4>{c.LABEL_UNMATCHED_IDS}</h4>
          <ul>
            {unmatched.map(id => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <BlockedBy reasons={reasons} />

      {failure !== undefined ? (
        <div className="boost-settings__failure" role="alert" data-code={failure}>
          <p>
            {c.LABEL_SAVE_FAILED} <code>{failure}</code>
          </p>
          <p className="boost-settings__muted">{adviceFor(t, failure)}</p>
          {REREAD_CODES.has(failure) ? (
            <button type="button" onClick={() => onReload()}>
              {c.ACTION_REREAD}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="boost-settings__actions">
        <button
          type="button"
          disabled={reasons.length > 0 || !dirty || saving}
          onClick={() => void save()}
        >
          {c.ACTION_SAVE}
        </button>
        <span className="boost-settings__muted" data-dirty={dirty ? 'true' : 'false'}>
          {dirty ? c.HINT_DIRTY : c.SAVED}
        </span>
        {dirty ? <span className="boost-settings__badge">{c.LABEL_DIRTY}</span> : null}
      </div>
    </section>
  )
}
