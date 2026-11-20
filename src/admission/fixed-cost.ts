/**
 * Fixed overhead: what the plugin costs on **every** request.
 *
 * The protocol section and the `boost` tool schema are injected regardless of
 * whether the plugin ever saves a token, so the design budgets them at ≤800
 * tokens per request and requires the measured value in `boost status`
 * (design §6.1). The measurement uses the host's own fixed-density estimator
 * (`estimateSystemMessage` from `@deepseek-ai/dsh-token-meter/estimate`), a
 * dynamic optional peer: a missing package must degrade to `'unknown'`, never
 * to a fabricated zero, because the audit reader cannot tell a real zero from
 * an absent measurement (design §9: do not fabricate).
 *
 * This is a **startup/status-time** measurement, never a per-request one:
 * `apply` starts the memoised promise once, `boost status` awaits it, and no
 * hot path imports this module. The dynamic import is Node-module-cached and
 * the estimate is O(text length) over the ~1.9 KB protocol section.
 *
 * @module dsh-boost/admission/fixed-cost
 */
import { loadOptional } from '../host/loader.js'
import { PROTOCOL_TEXT } from '../prompt/protocol.js'

/** The export shape this module reads from the optional peer. */
interface EstimateModule {
  estimateSystemMessage?: (message: unknown) => number
}

/** The import seam, injectable so a test can simulate an absent/broken peer. */
type ModuleLoader = <T>(specifier: string) => Promise<T | undefined>

/**
 * Measure one rendered system-prompt text in tokens.
 *
 * `text` is wrapped as a single-text system message because that is exactly how
 * adapters serialise the prompt; the estimator's role framing is part of the
 * real per-request cost. `'unknown'` covers every failure: no package, no
 * export, a throwing estimator, or a non-finite result. The second parameter is
 * a test seam; production leaves it at `loadOptional`.
 */
export async function measureFixedCost(
  text: string,
  load: ModuleLoader = loadOptional,
): Promise<number | 'unknown'> {
  try {
    const module = await load<EstimateModule>('@deepseek-ai/dsh-token-meter/estimate')
    if (module === undefined || typeof module.estimateSystemMessage !== 'function') return 'unknown'
    const tokens = module.estimateSystemMessage({
      role: 'system',
      content: [{ type: 'text', text }],
    })
    return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** The one protocol-section measurement, shared by startup and `status`. */
let protocolCost: Promise<number | 'unknown'> | undefined

/**
 * The memoised measurement of {@link PROTOCOL_TEXT}.
 *
 * `apply` calls this once at plugin startup; `boost status` awaits the same
 * promise, so a status call never re-measures and the figure cannot drift
 * between calls in one process.
 */
export function protocolFixedCost(): Promise<number | 'unknown'> {
  protocolCost ??= measureFixedCost(PROTOCOL_TEXT)
  return protocolCost
}
