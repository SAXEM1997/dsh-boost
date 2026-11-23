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
import { envelopeOf } from './draft'
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

  // Both are `runBoost` envelopes: the payload is read from `data`, and the
  // failure branch keeps its `code` readable for the panels below.
  const scope = result?.ok === true ? result.data.scope : undefined
  const configRead = result?.ok === true ? result.data.config : undefined
  const config = configRead?.ok === true ? configRead.data : undefined

  // A failed status read must not read as health: without this the panels below
  // would say "no degraded items" and "no receipts yet" — a confident wrong
  // answer, which is worse than showing nothing. The question goes to the
  // envelope, never to the payload: a payload carries no `ok`, so asking it
  // there answers "no" forever and the whole page becomes unreadable.
  const statusRead = envelopeOf(result?.ok === true ? result.data.status : undefined)
  const status = statusRead.ok ? statusRead.data : undefined
  // `undefined` means "status answered"; a string means it did not, and an
  // empty one means it failed without naming a code.
  const statusCode = statusRead.ok ? undefined : (statusRead.code ?? '')

  const saved = status?.saved
  // The type says `degraded` is a string list, but the wire is untrusted: a
  // host that sends an object here would reach `codes.map` and take the whole
  // page down with a TypeError. Guard the shape, not just the absence.
  const codes = Array.isArray(status?.degraded)
    ? status.degraded.filter((code): code is string => typeof code === 'string')
    : []
  const counts = status?.counts ?? {}
  const countRows: [string, number][] = Object.entries(counts)
    .filter(([, count]) => typeof count === 'number' && Number.isFinite(count))
    .sort(([, left], [, right]) => right - left)
  const configRows = flatten(config)
  const distill = config?.distillation
  const distillStatus = status?.distill

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
            <Row label={c.LABEL_SAVED_LOWER} value={tokens(c, saved?.substitution_avoided)} hint={c.HINT_SAVED_LOWER} />
            <Row label={c.LABEL_SAVED_UPPER} value={tokens(c, saved?.substitution)} hint={c.HINT_SAVED_UPPER} />
            <Row label={c.LABEL_PROJECTION_GROSS} value={tokens(c, status?.projection_gross_tokens)} />
            <Row
              label={c.LABEL_PROJECTION_GROSS_REPLAY}
              value={tokens(c, saved?.projectionGross)}
              hint={c.HINT_PROJECTION_GROSS_REPLAY}
            />
            <Row label={c.LABEL_PROJECTION_NET} value={tokens(c, saved?.projectionNet)} hint={c.HINT_PROJECTION_NET} />
            <Row label={c.LABEL_RETRIEVALS} value={tokens(c, saved?.retrievals)} />
            <Row label={c.LABEL_OVERHEAD} value={tokens(c, status?.fixedOverheadTokens)} hint={c.HINT_OVERHEAD} />
            <Row
              label={c.LABEL_ESTIMATE}
              value={status?.estimate_kind === 'host' ? c.ESTIMATE_HOST : c.UNKNOWN}
            />
            <Row
              label={c.LABEL_CACHE_HIT_RATIO}
              value={
                typeof status?.cache_hit_ratio === 'number'
                  ? `${(status.cache_hit_ratio * 100).toFixed(2)}%`
                  : c.UNKNOWN
              }
              hint={c.HINT_CACHE_HIT_RATIO}
            />
            <Row
              label={c.LABEL_PREFIX_DROPS}
              value={
                status?.prefix_drops === undefined
                  ? c.UNKNOWN
                  : `${status.prefix_drops.count} / ${status.prefix_drops.tokens.toLocaleString()}`
              }
              hint={c.HINT_PREFIX_DROPS}
            />
          </Section>

          <Section title={c.SECTION_DISTILL}>
            <Row
              label={c.LABEL_DISTILL_ENABLED}
              value={distill?.enabled === true ? c.DISTILL_ON : c.DISTILL_OFF}
            />
            <Row
              label={c.LABEL_DISTILL_FAMILIES}
              value={Array.isArray(distill?.families) ? distill.families.join(', ') : c.UNKNOWN}
            />
            <Row
              label={c.LABEL_DISTILL_TRIGGER}
              value={
                typeof distill?.triggerChars === 'number' && Number.isFinite(distill.triggerChars)
                  ? distill.triggerChars.toLocaleString()
                  : c.DISTILL_TRIGGER_FAMILY
              }
            />
            <Row label={c.LABEL_DISTILL_MAX_OUTPUT} value={tokens(c, distill?.maxOutputTokens)} />
            <Row label={c.LABEL_DISTILL_TIMEOUT} value={tokens(c, distill?.timeoutMs)} />
            <Row
              label={c.LABEL_DISTILL_ROUTE}
              value={
                distill?.route === null || distill?.route === undefined
                  ? c.DISTILL_ROUTE_BOUNDARY
                  : `${String((distill.route as { provider?: unknown }).provider ?? '')} / ${String((distill.route as { model?: unknown }).model ?? '')}`
              }
            />
            <Row label={c.LABEL_DISTILL_CALLS} value={tokens(c, distillStatus?.calls)} />
            <Row label={c.LABEL_DISTILL_TOKENS} value={tokens(c, distillStatus?.tokens)} />
            <Row label={c.LABEL_DISTILL_ADOPTED} value={tokens(c, distillStatus?.adopted)} />
            <Row label={c.LABEL_DISTILL_REJECTED} value={tokens(c, distillStatus?.rejected)} />
            <Row label={c.LABEL_DISTILL_FALLBACK} value={tokens(c, distillStatus?.fallback)} />
            <Row label={c.LABEL_DISTILL_INPUT_CHARS} value={tokens(c, distillStatus?.input_chars)} />
          </Section>

          {distill?.enabled === true ? (
            <div className="boost-settings__note" role="note">
              <p>{c.HINT_DISTILL_CALLS}</p>
              <p>{c.HINT_DISTILL_PINNED}</p>
              <p>{c.HINT_DISTILL_ROLLBACK}</p>
            </div>
          ) : null}

          {result.ok === true ? (
            <ScopeForm
              payload={result.data}
              scopeCode={scope === undefined || scope.ok ? undefined : scope.code}
              hasSpill={status?.hasSpill}
              onReload={() => load()}
            />
          ) : null}

          <Section title={c.LABEL_DEGRADED} rows={false}>
            <Degraded codes={codes} unavailable={statusCode} />
          </Section>

          {status !== undefined && status.projection_horizon_reestimated > 0 ? (
            <Section title={c.SECTION_STATUS} rows={false}>
              <p className="boost-settings__muted">
                {c.LABEL_HORIZON_REESTIMATED}: <code>{String(status.projection_horizon_reestimated)}</code>
              </p>
            </Section>
          ) : null}

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
