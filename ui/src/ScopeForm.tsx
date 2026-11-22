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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { saveScope } from './api'
import {
  disableReasons,
  draftOf,
  isDirty,
  patchOf,
  pathUnmatched,
  seedOf,
  staleWorkspaceIds,
  type ScopeDraft,
  type ScopeSeed,
} from './draft'
import type { StatePayload, WorkspaceListing } from './api'
import type { DisableReason } from './draft'
import {
  ACTION_REREAD,
  ACTION_SAVE,
  EMPTY_GLOBAL,
  EMPTY_SELECTED,
  HINT_DIRTY,
  HINT_NO_WORKSPACES_TO_PICK,
  LABEL_DIRTY,
  LABEL_MODE,
  LABEL_MODE_GLOBAL,
  LABEL_MODE_SELECTED,
  LABEL_PROJECTION,
  LABEL_SAVE_FAILED,
  LABEL_SHADOW,
  LABEL_STALE_IDS,
  LABEL_UNMATCHED_IDS,
  LABEL_WORKSPACES,
  MODE_VALUE_GLOBAL,
  MODE_VALUE_SELECTED,
  PROJECTIONS,
  SAVED,
  SECTION_SCOPE,
  UNAVAILABLE_REGISTRY,
  adviceFor,
} from './copy'

/** The three values `projection` may take, in the order the control offers them. */
type Projection = ScopeDraft['projection']

interface ScopeFormProps {
  payload: StatePayload
  scopeCode: string | undefined
  onSaved: (data: unknown) => void
}

/** Renders one reason a save is blocked. Every one of them is independent. */
function BlockedBy({ reasons }: { reasons: DisableReason[] }): ReactNode {
  if (reasons.length === 0) return null
  return (
    <ul className="boost-settings__blockers">
      {reasons.map(reason => (
        <li key={reason.id} data-reason={reason.id}>
          <code>{reason.code}</code> {adviceFor(reason.code)}
        </li>
      ))}
    </ul>
  )
}

export function ScopeForm({ payload, scopeCode, onSaved }: ScopeFormProps): ReactNode {
  const workspaces: WorkspaceListing | undefined = payload.workspaces
  const [seed, setSeed] = useState<ScopeSeed | undefined>(() => seedOf(payload.scope))
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
  const unmatched = draft === undefined ? [] : pathUnmatched(draft, workspaces)
  const entries = workspaces?.available === true ? workspaces.entries : []

  const update = useCallback((patch: Partial<ScopeDraft>) => {
    setDraft(current => (current === undefined ? current : { ...current, ...patch }))
  }, [])

  const toggleWorkspace = useCallback((id: string) => {
    setDraft(current => {
      if (current === undefined) return current
      const has = current.workspaceIds.includes(id)
      return {
        ...current,
        workspaceIds: has
          ? current.workspaceIds.filter(entry => entry !== id)
          : [...current.workspaceIds, id],
      }
    })
  }, [])

  const save = useCallback(async () => {
    if (draft === undefined || seed === undefined) return
    setSaving(true)
    setFailure(undefined)
    const result = await saveScope(patchOf(draft), seed.revision)
    setSaving(false)
    if (result.ok) {
      onSaved(result.data)
      return
    }
    // The draft is deliberately untouched here.
    setFailure(result.code)
  }, [draft, seed, onSaved])

  if (draft === undefined || seed === undefined) {
    return (
      <section className="boost-settings__section">
        <h3>{SECTION_SCOPE}</h3>
        <p className="boost-settings__muted" data-code={scopeCode ?? ''}>
          {scopeCode === undefined ? UNAVAILABLE_REGISTRY : adviceFor(scopeCode)}
        </p>
      </section>
    )
  }

  return (
    <section className="boost-settings__section">
      <h3>{SECTION_SCOPE}</h3>

      <fieldset className="boost-settings__field">
        <legend>{LABEL_MODE}</legend>
        <label>
          <input
            type="radio"
            name="boost-mode"
            checked={draft.mode === MODE_VALUE_SELECTED}
            onChange={() => update({ mode: MODE_VALUE_SELECTED })}
          />
          {LABEL_MODE_SELECTED}
        </label>
        <label>
          <input
            type="radio"
            name="boost-mode"
            checked={draft.mode === MODE_VALUE_GLOBAL}
            onChange={() => update({ mode: MODE_VALUE_GLOBAL })}
          />
          {LABEL_MODE_GLOBAL}
        </label>
        {draft.mode === MODE_VALUE_GLOBAL ? (
          <p className="boost-settings__muted">{EMPTY_GLOBAL}</p>
        ) : draft.workspaceIds.length === 0 ? (
          <p className="boost-settings__muted">{EMPTY_SELECTED}</p>
        ) : null}
      </fieldset>

      <fieldset className="boost-settings__field" disabled={draft.mode === MODE_VALUE_GLOBAL}>
        <legend>{LABEL_WORKSPACES}</legend>
        {workspaces?.available === false ? (
          <p className="boost-settings__muted" data-code={workspaces.code}>
            {adviceFor(workspaces.code)}
          </p>
        ) : entries.length === 0 ? (
          <p className="boost-settings__muted">{HINT_NO_WORKSPACES_TO_PICK}</p>
        ) : (
          entries.map(entry => (
            <label key={entry.id} className="boost-settings__workspace">
              <input
                type="checkbox"
                checked={draft.workspaceIds.includes(entry.path)}
                onChange={() => toggleWorkspace(entry.path)}
              />
              <span>{entry.path}</span>
            </label>
          ))
        )}
      </fieldset>

      <fieldset className="boost-settings__field">
        <legend>{LABEL_SHADOW}</legend>
        <label>
          <input
            type="checkbox"
            checked={draft.shadow}
            onChange={() => update({ shadow: !draft.shadow })}
          />
          {LABEL_SHADOW}
        </label>
      </fieldset>

      <fieldset className="boost-settings__field">
        <legend>{LABEL_PROJECTION}</legend>
        {PROJECTIONS.map(option => (
          <label key={option}>
            <input
              type="radio"
              name="boost-projection"
              checked={draft.projection === option}
              onChange={() => update({ projection: option as Projection })}
            />
            {option}
          </label>
        ))}
      </fieldset>

      {stale.length > 0 ? (
        <div className="boost-settings__diagnostic" data-diagnostic="stale">
          <h4>{LABEL_STALE_IDS}</h4>
          <ul>
            {stale.map(id => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {unmatched.length > 0 ? (
        <div className="boost-settings__diagnostic" data-diagnostic="unmatched">
          <h4>{LABEL_UNMATCHED_IDS}</h4>
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
            {LABEL_SAVE_FAILED} <code>{failure}</code>
          </p>
          <p className="boost-settings__muted">{adviceFor(failure)}</p>
          <button type="button" onClick={() => onSaved(undefined)}>
            {ACTION_REREAD}
          </button>
        </div>
      ) : null}

      <div className="boost-settings__actions">
        <button
          type="button"
          disabled={reasons.length > 0 || !dirty || saving}
          onClick={() => void save()}
        >
          {ACTION_SAVE}
        </button>
        <span className="boost-settings__muted" data-dirty={dirty ? 'true' : 'false'}>
          {dirty ? HINT_DIRTY : SAVED}
        </span>
        {dirty ? <span className="boost-settings__badge">{LABEL_DIRTY}</span> : null}
      </div>
    </section>
  )
}
