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
  removeWorkspaceId,
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
  // A conflict is cured by re-reading: the document moved, the draft did not.
  'ERR_SCOPE_REVISION_CONFLICT',
  // A read failure may be transient (a torn shard, a permissions blip).
  'ERR_SCOPE_READ_FAILED',
])
// Deliberately absent: LOCKED (waiting fixes it), UNKNOWN_VERSION /
// FUTURE_VERSION (an upgrade or a downgrade fixes it) and PARSE_FAILED (the
// file has to be repaired). Offering a re-read there would both fail to fix
// the cause and throw the draft away, which is the one thing the form
// promises never to do on failure.

interface ScopeFormProps {
  /**
   * Whether the host resolved a spill backend, read from the same status the
   * panels use. `undefined` means status could not be read, so the notice
   * states the requirement without claiming it is met.
   */
  hasSpill?: boolean
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

export function ScopeForm({ payload, scopeCode, hasSpill, onReload }: ScopeFormProps): ReactNode {
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
  // The diagnostic reads the draft: a stale id that has been staged for
  // removal must leave this list, or the control would have no visible effect.
  const stale = staleWorkspaceIds(draft, workspaces)
  const entries = workspaces?.available === true ? workspaces.entries : []

  const update = useCallback((patch: Partial<ScopeDraft>) => {
    setDraft(current => (current === undefined ? current : { ...current, ...patch }))
  }, [])

  const toggleWorkspace = useCallback((entry: WorkspaceEntry) => {
    setDraft(current => (current === undefined ? current : toggleTicked(current, entry)))
  }, [])

  const removeStale = useCallback((id: string) => {
    setDraft(current => (current === undefined ? current : removeWorkspaceId(current, id)))
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
      <section className="boost-settings__card">
        <div className="boost-settings__card-head">
          <h3>{c.SECTION_SCOPE}</h3>
        </div>
        <div className="boost-settings__card-body">
        <p className="boost-settings__muted" data-code={scopeCode ?? ''}>
          {scopeCode === undefined ? c.UNAVAILABLE_REGISTRY : adviceFor(t, scopeCode)}
          {/* The code is the only part a maintainer can act on, so it is shown,
              not hidden in a data attribute. */}
          {scopeCode === undefined ? null : (
            <>
              {' '}
              <code>{scopeCode}</code>
            </>
          )}
        </p>
        <BlockedBy reasons={reasons} />
        </div>
      </section>
    )
  }

  return (
    <section className="boost-settings__card">
      <div className="boost-settings__card-head">
        <h3>{c.SECTION_SCOPE}</h3>
      </div>
      <div className="boost-settings__card-body">

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
        <legend>
          {c.LABEL_WORKSPACES}
          {entries.length === 0 ? null : (
            <span className="boost-settings__meta">
              {t('LABEL_WORKSPACE_COUNT')
                .replace('{selected}', String(draft.workspaceIds.length))
                .replace('{total}', String(entries.length))}
            </span>
          )}
        </legend>
        {workspaces?.available === false ? (
          <p className="boost-settings__muted" data-code={workspaces.code}>
            {adviceFor(t, workspaces.code)} <code>{workspaces.code}</code>
          </p>
        ) : entries.length === 0 ? (
          <p className="boost-settings__muted">{c.HINT_NO_WORKSPACES_TO_PICK}</p>
        ) : (
          <ul className="boost-settings__workspaces">
            {entries.map(entry => (
              <li key={entry.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={isTicked(draft, entry)}
                    onChange={() => toggleWorkspace(entry)}
                  />
                  <span className="boost-settings__workspace-name">
                    {entry.title ?? entry.path}
                    {entry.title === undefined ? null : (
                      <code className="boost-settings__workspace-path">{entry.path}</code>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
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
            <li>
              {hasSpill === true
                ? c.HINT_PROJECTION_ON_SPILL_OK
                : hasSpill === false
                  ? c.HINT_PROJECTION_ON_SPILL
                  : c.HINT_PROJECTION_ON_SPILL_UNKNOWN}
            </li>
          </ul>
          <p>{c.HINT_PROJECTION_ON_ROLLBACK}</p>
        </div>
      ) : null}

      {draft.shadow ? (
        <p className="boost-settings__muted">{c.HINT_SHADOW_MEANS}</p>
      ) : (
        <div className="boost-settings__notice" role="note" data-notice="substitute-on">
          <strong>{c.LABEL_SUBSTITUTE_ON_PRECONDITIONS}</strong>
          <ul>
            <li>{c.HINT_SUBSTITUTE_ON_THINKING}</li>
          </ul>
          <p>{c.HINT_SUBSTITUTE_ON_ROLLBACK}</p>
        </div>
      )}

      {stale.length > 0 ? (
        <div className="boost-settings__diagnostic" data-diagnostic="stale">
          <h4>{c.LABEL_STALE_IDS}</h4>
          <ul>
            {stale.map(id => (
              <li key={id}>
                <code>{id}</code>
                {/* A native button is keyboard-reachable by default; the
                    data-* hooks give the control a stable identity. */}
                <button
                  type="button"
                  data-action="remove-stale-workspace"
                  data-workspace-id={id}
                  onClick={() => removeStale(id)}
                >
                  {c.ACTION_REMOVE_STALE}
                </button>
              </li>
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
      </div>
    </section>
  )
}
