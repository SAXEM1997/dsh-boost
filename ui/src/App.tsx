/**
 * The settings page: read-only, one fetch, no state of its own.
 *
 * WHY EVERY PANEL DEGRADES EXPLICITLY: the plugin's whole value is a number an
 * operator acts on. A panel that renders `0` or an empty list when the number
 * could not be measured turns "I don't know" into "nothing happened", and the
 * operator's next decision is based on a fact that was never observed. So every
 * unmeasured field says so, and a missing workspace list disables saving rather
 * than showing none.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ADVICE_FOR_CODE,
  CONFIG_READONLY,
  DEGRADED_ADVICE,
  DEGRADED_FALLBACK,
  HINT_OVERHEAD,
  HINT_PROJECTION_NET,
  HINT_SAVED_LOWER,
  HINT_SAVED_UPPER,
  INTRO,
  LABEL_CONFIG_KEY,
  LABEL_CONFIG_VALUE,
  LABEL_DEGRADED,
  LABEL_ESTIMATE,
  LABEL_MODE,
  LABEL_OVERHEAD,
  LABEL_PROJECTION,
  LABEL_PROJECTION_GROSS,
  LABEL_PROJECTION_NET,
  LABEL_RETRIEVALS,
  LABEL_REVISION,
  LABEL_SAVED_LOWER,
  LABEL_SAVED_UPPER,
  LABEL_SHADOW,
  LABEL_WORKSPACE_IDS,
  LOADING,
  MODE_GLOBAL,
  MODE_SELECTED,
  NO_DEGRADED,
  NO_WORKSPACES_SELECTED,
  NOT_APPLICABLE,
  OFF,
  ON,
  PROJECTION_OFF,
  PROJECTION_ON,
  PROJECTION_SHADOW,
  RETRY,
  SECTION_CONFIG,
  SECTION_SCOPE,
  SECTION_STATUS,
  SECTION_WORKSPACES,
  TITLE,
  UNKNOWN,
  WORKSPACES_UNAVAILABLE,
} from './copy'
import { fetchState, type StateResult } from './api'

/** A number, `'unknown'`, or a missing field — three states, never conflated. */
function tokens(value: unknown): string {
  if (value === 'unknown' || value === undefined || value === null) return UNKNOWN
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNKNOWN
  return value.toLocaleString()
}

/** Reads a nested field without trusting any of the levels. */
function pick(source: unknown, ...path: string[]): unknown {
  let cursor: unknown = source
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

/**
 * Flattens the effective config into leaf rows.
 *
 * The page shows what `resolveConfig` decided, not what the profile asked for:
 * clamps and fallbacks happen at load, and the clamped value is the one the
 * plugin actually uses.
 */
function flatten(source: unknown, prefix = ''): [string, string][] {
  if (source === null || typeof source !== 'object') {
    return prefix === '' ? [] : [[prefix, typeof source === 'string' ? source : JSON.stringify(source) ?? '']]
  }
  if (Array.isArray(source)) return [[prefix, source.join(', ')]]
  const rows: [string, string][] = []
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    rows.push(...flatten(value, prefix === '' ? key : `${prefix}.${key}`))
  }
  return rows
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="boost-settings__row">
      <dt>{label}</dt>
      <dd>
        {value}
        {hint === undefined ? null : <span className="boost-settings__hint">{hint}</span>}
      </dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="boost-settings__section">
      <h3>{title}</h3>
      <dl>{children}</dl>
    </section>
  )
}

function Degraded({ codes }: { codes: readonly string[] }) {
  if (codes.length === 0) {
    return <p className="boost-settings__ok">{NO_DEGRADED}</p>
  }
  return (
    <ul className="boost-settings__codes">
      {codes.map(code => (
        <li key={code}>
          <code>{code}</code>
          <span>{DEGRADED_ADVICE[code] ?? DEGRADED_FALLBACK}</span>
        </li>
      ))}
    </ul>
  )
}

export function App() {
  const [result, setResult] = useState<StateResult | undefined>(undefined)
  const [pending, setPending] = useState(true)

  const load = useCallback(() => {
    const controller = new AbortController()
    setPending(true)
    void fetchState(controller.signal)
      .then(next => {
        setResult(next)
        setPending(false)
      })
      .catch(() => {
        // Abort: the component is gone or a newer read replaced this one.
        setPending(false)
      })
    return () => controller.abort()
  }, [])

  useEffect(load, [load])

  const status = result?.ok === true ? result.data.status : undefined
  const scope = result?.ok === true ? result.data.scope : undefined
  const workspaces = result?.ok === true ? result.data.workspaces : undefined
  const config = result?.ok === true ? result.data.config : undefined

  const scopeDoc = pick(scope, 'ok') === true ? pick(scope, 'data') : undefined
  const saved = pick(status, 'saved')
  const degraded = pick(status, 'degraded')
  const codes = Array.isArray(degraded) ? degraded.filter((code): code is string => typeof code === 'string') : []
  const mode = pick(scopeDoc, 'mode')
  const workspaceIds = pick(scopeDoc, 'workspaceIds')
  const projection = pick(scopeDoc, 'projection')

  return (
    <div className="boost-settings">
      <h2>{TITLE}</h2>
      <p className="boost-settings__intro">{INTRO}</p>

      {pending && result === undefined ? <p className="boost-settings__muted">{LOADING}</p> : null}

      {result !== undefined && !result.ok ? (
        <div className="boost-settings__error" role="alert">
          <code>{result.code}</code>
          <span>{ADVICE_FOR_CODE[result.code] ?? DEGRADED_FALLBACK}</span>
          <button type="button" onClick={() => load()}>
            {RETRY}
          </button>
        </div>
      ) : null}

      {result !== undefined && result.ok ? (
        <>
          <Section title={SECTION_STATUS}>
            <Row label={LABEL_SAVED_LOWER} value={tokens(pick(saved, 'substitution_avoided'))} hint={HINT_SAVED_LOWER} />
            <Row label={LABEL_SAVED_UPPER} value={tokens(pick(saved, 'substitution'))} hint={HINT_SAVED_UPPER} />
            <Row label={LABEL_PROJECTION_GROSS} value={tokens(pick(saved, 'projectionGross'))} />
            <Row label={LABEL_PROJECTION_NET} value={tokens(pick(saved, 'projectionNet'))} hint={HINT_PROJECTION_NET} />
            <Row label={LABEL_RETRIEVALS} value={tokens(pick(saved, 'retrievals'))} />
            <Row label={LABEL_OVERHEAD} value={tokens(pick(status, 'fixedOverheadTokens'))} hint={HINT_OVERHEAD} />
            <Row
              label={LABEL_ESTIMATE}
              value={pick(status, 'estimate_kind') === 'host' ? '宿主计量' : UNKNOWN}
            />
          </Section>

          <Section title={SECTION_SCOPE}>
            <Row
              label={LABEL_MODE}
              value={mode === 'global' ? MODE_GLOBAL : mode === 'selected' ? MODE_SELECTED : NOT_APPLICABLE}
            />
            <Row label={LABEL_SHADOW} value={pick(scopeDoc, 'shadow') === true ? ON : OFF} />
            <Row
              label={LABEL_PROJECTION}
              value={
                projection === 'on'
                  ? PROJECTION_ON
                  : projection === 'shadow'
                    ? PROJECTION_SHADOW
                    : projection === 'off'
                      ? PROJECTION_OFF
                      : NOT_APPLICABLE
              }
            />
            <Row
              label={LABEL_WORKSPACE_IDS}
              value={
                Array.isArray(workspaceIds) && workspaceIds.length > 0
                  ? workspaceIds.map(id => String(id)).join(', ')
                  : NO_WORKSPACES_SELECTED
              }
            />
            <Row label={LABEL_REVISION} value={tokens(pick(scopeDoc, 'revision'))} />
          </Section>

          <section className="boost-settings__section">
            <h3>{LABEL_DEGRADED}</h3>
            <Degraded codes={codes} />
          </section>

          <section className="boost-settings__section">
            <h3>{SECTION_WORKSPACES}</h3>
            {workspaces === undefined ? null : workspaces.available ? (
              workspaces.entries.length === 0 ? (
                <p className="boost-settings__muted">{NO_WORKSPACES_SELECTED}</p>
              ) : (
                <ul className="boost-settings__workspaces">
                  {workspaces.entries.map(entry => {
                    const selected = Array.isArray(workspaceIds) && workspaceIds.includes(entry.id)
                    return (
                      <li key={entry.id} className={selected ? 'is-selected' : undefined}>
                        <code>{entry.id}</code>
                        <span>{entry.path}</span>
                      </li>
                    )
                  })}
                </ul>
              )
            ) : (
              <div className="boost-settings__error" role="alert">
                <code>{workspaces.code}</code>
                <span>{WORKSPACES_UNAVAILABLE}</span>
              </div>
            )}
          </section>

          <section className="boost-settings__section">
            <h3>{SECTION_CONFIG}</h3>
            <p className="boost-settings__hint">{CONFIG_READONLY}</p>
            <table className="boost-settings__config">
              <thead>
                <tr>
                  <th scope="col">{LABEL_CONFIG_KEY}</th>
                  <th scope="col">{LABEL_CONFIG_VALUE}</th>
                </tr>
              </thead>
              <tbody>
                {flatten(config).map(([key, value]) => (
                  <tr key={key}>
                    <td>
                      <code>{key}</code>
                    </td>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </div>
  )
}
