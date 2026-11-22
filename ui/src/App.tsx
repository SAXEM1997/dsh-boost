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
import { copyOf, adviceFor, type Copy } from './copy'
import { payloadOf } from './draft'
import { useT } from './i18n'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { fetchState, type StateResult } from './api'
import { ScopeForm } from './ScopeForm'

/** A number, `'unknown'`, or a missing field — three states, never conflated. */
function tokens(c: Copy, value: unknown): string {
  if (value === 'unknown' || value === undefined || value === null) return c.UNKNOWN
  if (typeof value !== 'number' || !Number.isFinite(value)) return c.UNKNOWN
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

function Degraded({ codes, unavailable }: { codes: readonly string[]; unavailable?: string }) {
  const t = useT()
  const c = copyOf(t)
  // "Nothing is degraded" is only true when status answered. A failed envelope
  // gets its own line so the page never claims health it did not observe.
  if (unavailable !== undefined) {
    return (
      <p className="boost-settings__warn">
        {c.STATUS_UNAVAILABLE} <code>{unavailable === '' ? c.UNKNOWN : unavailable}</code>
      </p>
    )
  }
  if (codes.length === 0) {
    return <p className="boost-settings__ok">{c.NO_DEGRADED}</p>
  }
  return (
    <ul className="boost-settings__codes">
      {codes.map(code => (
        <li key={code}>
          <code>{code}</code>
          <span>{adviceFor(t, code)}</span>
        </li>
      ))}
    </ul>
  )
}

export function App() {
  const [result, setResult] = useState<StateResult | undefined>(undefined)
  const [pending, setPending] = useState(true)

  const t = useT()
  const c = copyOf(t)

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

  // Both are `runBoost` envelopes: `payloadOf` unwraps the success case and
  // leaves the failure case alone so its `code` stays readable.
  const status = payloadOf(result?.ok === true ? result.data.status : undefined)
  const scope = result?.ok === true ? result.data.scope : undefined
  const config = payloadOf(result?.ok === true ? result.data.config : undefined)

  // A failed status envelope must not read as health: without this the panels
  // below would say "no degraded items" and "no receipts yet" — a confident
  // wrong answer, which is worse than showing nothing.
  const statusCode =
    status !== null && typeof status === 'object' && (status as { ok?: unknown }).ok === false
      ? String((status as { code?: unknown }).code ?? '')
      : undefined

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
      <h2>{c.TITLE}</h2>
      <p className="boost-settings__intro">{c.INTRO}</p>

      {pending && result === undefined ? <p className="boost-settings__muted">{c.LOADING}</p> : null}

      {result !== undefined && !result.ok ? (
        <div className="boost-settings__error" role="alert">
          <code>{result.code}</code>
          <span>{adviceFor(t, result.code)}</span>
          <button type="button" onClick={() => load()}>
            {c.RETRY}
          </button>
        </div>
      ) : null}

      {result !== undefined && result.ok ? (
        <>
          <Section title={c.SECTION_STATUS}>
            <Row label={c.LABEL_SAVED_LOWER} value={tokens(c, pick(saved, 'substitution_avoided'))} hint={c.HINT_SAVED_LOWER} />
            <Row label={c.LABEL_SAVED_UPPER} value={tokens(c, pick(saved, 'substitution'))} hint={c.HINT_SAVED_UPPER} />
            <Row label={c.LABEL_PROJECTION_GROSS} value={tokens(c, pick(status, 'projection_gross_tokens'))} />
            <Row
              label={c.LABEL_PROJECTION_GROSS_REPLAY}
              value={tokens(c, pick(saved, 'projectionGross'))}
              hint={c.HINT_PROJECTION_GROSS_REPLAY}
            />
            <Row label={c.LABEL_PROJECTION_NET} value={tokens(c, pick(saved, 'projectionNet'))} hint={c.HINT_PROJECTION_NET} />
            <Row label={c.LABEL_RETRIEVALS} value={tokens(c, pick(saved, 'retrievals'))} />
            <Row label={c.LABEL_OVERHEAD} value={tokens(c, pick(status, 'fixedOverheadTokens'))} hint={c.HINT_OVERHEAD} />
            <Row
              label={c.LABEL_ESTIMATE}
              value={pick(status, 'estimate_kind') === 'host' ? c.ESTIMATE_HOST : c.UNKNOWN}
            />
          </Section>

          {result.ok === true ? (
            <ScopeForm
              payload={result.data}
              scopeCode={pick(scope, 'code') as string | undefined}
              onReload={() => load()}
            />
          ) : null}

          <Section title={c.LABEL_DEGRADED} rows={false}>
            <Degraded codes={codes} unavailable={statusCode} />
          </Section>

          <Section title={c.SECTION_COUNTS} rows={false}>
            {countRows.length === 0 ? (
              <p className="boost-settings__muted">
                {statusCode === undefined ? c.NO_RECEIPTS : c.STATUS_UNAVAILABLE}
              </p>
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


          <Section title={c.SECTION_CONFIG} rows={false}>
            <p className="boost-settings__hint">{c.CONFIG_READONLY}</p>
            {configRows.length === 0 ? (
              <p className="boost-settings__muted">{c.CONFIG_UNAVAILABLE}</p>
            ) : (
            <table className="boost-settings__config">
              <thead>
                <tr>
                  <th scope="col">{c.LABEL_CONFIG_KEY}</th>
                  <th scope="col">{c.LABEL_CONFIG_VALUE}</th>
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
