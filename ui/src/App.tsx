/**
 * The settings page: read-only, one fetch, no state of its own.
 *
 * WHY EVERY PANEL DEGRADES EXPLICITLY: the plugin's whole value is a number an
 * operator acts on. A panel that renders `0` or an empty list when the number
 * could not be measured turns "I don't know" into "nothing happened", and the
 * operator's next decision is based on a fact that was never observed. So every
 * unmeasured field says so, and a missing workspace list disables saving rather
 * than showing none. The same rule covers a whole section whose source failed:
 * it says why, with the code, instead of showing a default that reads as a
 * measurement.
 */
import { copyOf, adviceFor, type Copy } from './copy'
import { configOf, distillStateOf, envelopeOf, groupCounts, type CountGroup } from './draft'
import { useT } from './i18n'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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

/** `a.b.c` → `['a', 'b.c']`; a top-level scalar keeps its own name as group. */
function splitKey(key: string): [string, string] {
  const at = key.indexOf('.')
  return at === -1 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)]
}

/** The leaf rows grouped by their top-level key, in first-seen order. */
function grouped(rows: readonly [string, string][]): [string, [string, string][]][] {
  const out: [string, [string, string][]][] = []
  for (const [key, value] of rows) {
    const [group, leaf] = splitKey(key)
    const last = out.at(-1)
    if (last !== undefined && last[0] === group) last[1].push([leaf, value])
    else out.push([group, [[leaf, value]]])
  }
  return out
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="boost-settings__row">
      <dt>{label}</dt>
      <dd>
        <span className="boost-settings__value">{value}</span>
        {hint === undefined ? null : <span className="boost-settings__hint">{hint}</span>}
      </dd>
    </div>
  )
}

/**
 * One bordered card. Every panel on this page is a card, so the eye can tell
 * where a group of numbers ends without reading the headings.
 */
function Card({
  title,
  meta,
  children,
}: {
  title: string
  meta?: string | undefined
  children: ReactNode
}) {
  return (
    <section className="boost-settings__card">
      <div className="boost-settings__card-head">
        <h3>{title}</h3>
        {meta === undefined ? null : <span className="boost-settings__meta">{meta}</span>}
      </div>
      <div className="boost-settings__card-body">{children}</div>
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

/** The group's display name; `other` is the bucket for codes with no prefix. */
function groupLabel(c: Copy, key: CountGroup['key']): string {
  switch (key) {
    case 'substitute':
      return c.LABEL_COUNTS_GROUP_SUBSTITUTE
    case 'projection':
      return c.LABEL_COUNTS_GROUP_PROJECTION
    case 'distill':
      return c.LABEL_COUNTS_GROUP_DISTILL
    case 'skip':
      return c.LABEL_COUNTS_GROUP_SKIP
    default:
      return c.LABEL_COUNTS_GROUP_OTHER
  }
}

export function App() {
  const [result, setResult] = useState<StateResult | undefined>(undefined)
  const [pending, setPending] = useState(true)

  const t = useT()
  const c = copyOf(t)

  // A manual reload must cancel the read it supersedes: otherwise two
  // responses can land out of order and the older one wins, which reads as
  // "the change I just saved did not take".
  const inFlight = useRef<AbortController | undefined>(undefined)

  const load = useCallback(() => {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setPending(true)
    void fetchState(controller.signal)
      .then(next => {
        if (controller.signal.aborted) return
        setResult(next)
        setPending(false)
      })
      .catch(() => {
        // Abort: the component is gone or a newer read replaced this one.
        if (controller.signal.aborted) return
        setPending(false)
      })
    return () => controller.abort()
  }, [])

  useEffect(load, [load])

  // Both are `runBoost` envelopes: the payload is read from `data`, and the
  // failure branch keeps its `code` readable for the panels below.
  const scope = result?.ok === true ? result.data.scope : undefined
  const configRead = configOf(result?.ok === true ? result.data.config : undefined)
  const config = configRead.config
  // A config that failed to read is a fact about this page, not a blank: the
  // sections that read from it say so with the code instead of rendering
  // defaults that would read as measurements.
  const configCode = configRead.code

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
  const countGroups = groupCounts(counts as Record<string, number>)
  const configGroups = grouped(flatten(config))
  const distill = config?.distillation
  const distillStatus = status?.distill
  // `distillState` answers the operator's question (unknown / absent / present);
  // `distillKnown` is the same fact phrased for the type system so the rows
  // below can read `distill` without a guard each.
  const distillState = distillStateOf(config)
  const distillKnown = distill !== undefined
  const distillOn = distill?.enabled === true

  return (
    <div className="boost-settings">
      <header className="boost-settings__header">
        <h2>{c.TITLE}</h2>
        <p className="boost-settings__intro">{c.INTRO}</p>
      </header>

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
          <Card title={c.LABEL_DEGRADED}>
            <Degraded codes={codes} unavailable={statusCode} />
          </Card>

          <Card title={c.SECTION_STATUS}>
            <dl>
              <Row label={c.LABEL_SAVED_LOWER} value={tokens(c, saved?.substitution_avoided)} hint={c.HINT_SAVED_LOWER} />
              <Row label={c.LABEL_SAVED_UPPER} value={tokens(c, saved?.substitution)} hint={c.HINT_SAVED_UPPER} />
              <Row label={c.LABEL_PROJECTION_GROSS} value={tokens(c, status?.projection_gross_tokens)} />
              <Row
                label={c.LABEL_PROJECTION_GROSS_REPLAY}
                value={tokens(c, saved?.projectionGross)}
                hint={c.HINT_PROJECTION_GROSS_REPLAY}
              />
              <Row label={c.LABEL_PROJECTION_NET} value={tokens(c, saved?.projectionNet)} hint={c.HINT_PROJECTION_NET} />
              {saved?.retrievalContent === undefined ? null : (
                <Row label={c.LABEL_SAVED_RETRIEVAL_CONTENT} value={tokens(c, saved.retrievalContent)} />
              )}
              {saved?.retrievalCalls === undefined ? null : (
                <Row label={c.LABEL_SAVED_RETRIEVAL_CALLS} value={tokens(c, saved.retrievalCalls)} />
              )}
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
            </dl>
            {status !== undefined && status.projection_horizon_reestimated > 0 ? (
              <p className="boost-settings__muted">
                {c.LABEL_HORIZON_REESTIMATED}: <code>{String(status.projection_horizon_reestimated)}</code>
              </p>
            ) : null}
          </Card>

          <ScopeForm
            payload={result.data}
            scopeCode={scope === undefined || scope.ok ? undefined : scope.code}
            hasSpill={status?.hasSpill}
            onReload={() => load()}
          />

          <Card title={c.SECTION_COUNTS}>
            {countGroups.length === 0 ? (
              <p className="boost-settings__muted">
                {statusCode === undefined ? c.NO_RECEIPTS : c.STATUS_UNAVAILABLE}
              </p>
            ) : (
              <>
                <p className="boost-settings__hint">{c.HINT_COUNTS_GROUPED}</p>
                {countGroups.map((group) => (
                  <details key={group.key} className="boost-settings__count-group" open={group.key !== 'other'}>
                    <summary>
                      <span>{groupLabel(c, group.key)}</span>
                      <span className="boost-settings__count-total">{group.total.toLocaleString()}</span>
                    </summary>
                    <ul className="boost-settings__counts">
                      {group.rows.map((row) => (
                        <li key={row.code}>
                          <code>{row.code}</code>
                          <span>{row.count.toLocaleString()}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </>
            )}
          </Card>

          <Card title={c.SECTION_DISTILL} meta={distillKnown ? (distillOn ? c.DISTILL_ON : c.DISTILL_OFF) : undefined}>
            {distillKnown ? null : (
              <p className="boost-settings__muted">
                {distillState === 'unknown' ? (
                  <>
                    {c.CONFIG_UNAVAILABLE_CODE} <code>{configCode ?? c.UNKNOWN}</code>
                  </>
                ) : (
                  // The config parsed; only this section is missing. Saying
                  // "could not read the config" here would be a false alarm
                  // about a host that answered fine.
                  c.DISTILL_NOT_IN_CONFIG
                )}
              </p>
            )}
            {distillKnown ? (
              <>
                <dl>
                  <Row label={c.LABEL_DISTILL_ENABLED} value={distillOn ? c.DISTILL_ON : c.DISTILL_OFF} />
                  <Row
                    label={c.LABEL_DISTILL_FAMILIES}
                    value={
                      Array.isArray(distill.families)
                        ? distill.families.length === 0
                          ? c.EMPTY_LIST
                          : distill.families.join(', ')
                        : c.UNKNOWN
                    }
                  />
                  <Row
                    label={c.LABEL_DISTILL_TRIGGER}
                    value={
                      typeof distill.triggerChars === 'number' && Number.isFinite(distill.triggerChars)
                        ? distill.triggerChars.toLocaleString()
                        : c.DISTILL_TRIGGER_FAMILY
                    }
                  />
                  <Row label={c.LABEL_DISTILL_MAX_OUTPUT} value={tokens(c, distill.maxOutputTokens)} />
                  <Row label={c.LABEL_DISTILL_TIMEOUT} value={tokens(c, distill.timeoutMs)} />
                  <Row
                    label={c.LABEL_DISTILL_ROUTE}
                    value={
                      distill.route === null || distill.route === undefined
                        ? c.DISTILL_ROUTE_BOUNDARY
                        : `${String((distill.route as { provider?: unknown }).provider ?? '')} / ${String((distill.route as { model?: unknown }).model ?? '')}`
                    }
                  />
                </dl>
                {distillOn ? (
                  <>
                    <h4 className="boost-settings__subhead">{c.LABEL_DISTILL_RUNTIME}</h4>
                    <dl>
                      <Row label={c.LABEL_DISTILL_CALLS} value={tokens(c, distillStatus?.calls)} />
                      <Row label={c.LABEL_DISTILL_TOKENS} value={tokens(c, distillStatus?.tokens)} />
                      <Row label={c.LABEL_DISTILL_INPUT_CHARS} value={tokens(c, distillStatus?.input_chars)} />
                      <Row label={c.LABEL_DISTILL_ADOPTED} value={tokens(c, distillStatus?.adopted)} />
                      <Row label={c.LABEL_DISTILL_REJECTED} value={tokens(c, distillStatus?.rejected)} />
                      <Row label={c.LABEL_DISTILL_FALLBACK} value={tokens(c, distillStatus?.fallback)} />
                      <Row label={c.LABEL_DISTILL_SAVED} value={tokens(c, distillStatus?.saved_tokens)} />
                      <Row label={c.LABEL_DISTILL_SPILLED} value={tokens(c, distillStatus?.spilled_bytes)} />
                    </dl>
                    <div className="boost-settings__notice" role="note">
                      <p>{c.HINT_DISTILL_CALLS}</p>
                      <p>{c.HINT_DISTILL_PINNED}</p>
                      <p>{c.HINT_DISTILL_ROLLBACK}</p>
                    </div>
                  </>
                ) : (
                  <p className="boost-settings__muted">{c.HINT_DISTILL_OFF}</p>
                )}
              </>
            ) : null}
          </Card>

          <Card title={c.SECTION_CONFIG}>
            <p className="boost-settings__hint">{c.CONFIG_READONLY}</p>
            {configGroups.length === 0 ? (
              <p className="boost-settings__muted">
                {c.CONFIG_UNAVAILABLE_CODE} <code>{configCode ?? c.UNKNOWN}</code>
              </p>
            ) : (
              configGroups.map(([group, rows]) => (
                <div key={group} className="boost-settings__config-group">
                  <h4 className="boost-settings__subhead">{group}</h4>
                  <dl>
                    {rows.map(([leaf, value]) => (
                      <Row key={`${group}.${leaf}`} label={leaf === '' ? group : leaf} value={value} />
                    ))}
                  </dl>
                </div>
              ))
            )}
          </Card>
        </>
      ) : null}
    </div>
  )
}
