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
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  adviceFor,
  CONFIG_READONLY,
  CONFIG_UNAVAILABLE,
  HINT_OVERHEAD,
  HINT_PROJECTION_GROSS_REPLAY,
  HINT_PROJECTION_NET,
  HINT_SAVED_LOWER,
  HINT_SAVED_UPPER,
  INTRO,
  LABEL_CONFIG_KEY,
  LABEL_CONFIG_VALUE,
  LABEL_DEGRADED,
  LABEL_ESTIMATE,
  LABEL_OVERHEAD,
  LABEL_PROJECTION_GROSS,
  LABEL_PROJECTION_GROSS_REPLAY,
  LABEL_PROJECTION_NET,
  LABEL_RETRIEVALS,
  LABEL_SAVED_LOWER,
  LABEL_SAVED_UPPER,
  LOADING,
  NO_DEGRADED,
  NO_RECEIPTS,
  RETRY,
  SECTION_CONFIG,
  SECTION_COUNTS,
  SECTION_STATUS,
  TITLE,
  UNKNOWN,
} from './copy'
import { fetchState, type StateResult } from './api'
import { ScopeForm } from './ScopeForm'

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

function Section({ title, children, rows = true }: { title: string; children: ReactNode; rows?: boolean }) {
  return (
    <section className="boost-settings__section">
      <h3>{title}</h3>
      {rows ? <dl>{children}</dl> : children}
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
          <span>{adviceFor(code)}</span>
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
  const config = result?.ok === true ? result.data.config : undefined

  const saved = pick(status, 'saved')
  const degraded = pick(status, 'degraded')
  const codes = Array.isArray(degraded) ? degraded.filter((code): code is string => typeof code === 'string') : []
  const counts = pick(status, 'counts')
  const countRows: [string, number][] =
    counts === null || typeof counts !== 'object'
      ? []
      : Object.entries(counts as Record<string, unknown>)
          .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
          .sort((left, right) => right[1] - left[1])
  const configRows = flatten(config)

  return (
    <div className="boost-settings">
      <h2>{TITLE}</h2>
      <p className="boost-settings__intro">{INTRO}</p>

      {pending && result === undefined ? <p className="boost-settings__muted">{LOADING}</p> : null}

      {result !== undefined && !result.ok ? (
        <div className="boost-settings__error" role="alert">
          <code>{result.code}</code>
          <span>{adviceFor(result.code)}</span>
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
            <Row label={LABEL_PROJECTION_GROSS} value={tokens(pick(status, 'projection_gross_tokens'))} />
            <Row
              label={LABEL_PROJECTION_GROSS_REPLAY}
              value={tokens(pick(saved, 'projectionGross'))}
              hint={HINT_PROJECTION_GROSS_REPLAY}
            />
            <Row label={LABEL_PROJECTION_NET} value={tokens(pick(saved, 'projectionNet'))} hint={HINT_PROJECTION_NET} />
            <Row label={LABEL_RETRIEVALS} value={tokens(pick(saved, 'retrievals'))} />
            <Row label={LABEL_OVERHEAD} value={tokens(pick(status, 'fixedOverheadTokens'))} hint={HINT_OVERHEAD} />
            <Row
              label={LABEL_ESTIMATE}
              value={pick(status, 'estimate_kind') === 'host' ? '宿主计量' : UNKNOWN}
            />
          </Section>

          {result.ok === true ? (
            <ScopeForm
              payload={result.data}
              scopeCode={pick(scope, 'code') as string | undefined}
              onReload={() => load()}
            />
          ) : null}

          <Section title={LABEL_DEGRADED} rows={false}>
            <Degraded codes={codes} />
          </Section>

          <Section title={SECTION_COUNTS} rows={false}>
            {countRows.length === 0 ? (
              <p className="boost-settings__muted">{NO_RECEIPTS}</p>
            ) : (
              <ul className="boost-settings__codes">
                {countRows.map(([code, count]) => (
                  <li key={code}>
                    <code>{code}</code>
                    <span>{count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>


          <Section title={SECTION_CONFIG} rows={false}>
            <p className="boost-settings__hint">{CONFIG_READONLY}</p>
            {configRows.length === 0 ? (
              <p className="boost-settings__muted">{CONFIG_UNAVAILABLE}</p>
            ) : (
            <table className="boost-settings__config">
              <thead>
                <tr>
                  <th scope="col">{LABEL_CONFIG_KEY}</th>
                  <th scope="col">{LABEL_CONFIG_VALUE}</th>
                </tr>
              </thead>
              <tbody>
                {configRows.map(([key, value]) => (
                  <tr key={key}>
                    <td>
                      <code>{key}</code>
                    </td>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </Section>
        </>
      ) : null}
    </div>
  )
}
