/**
 * Fixed overhead: what the plugin costs on **every** request.
 *
 * The protocol section and the `boost` tool schema are injected regardless of
 * whether the plugin ever saves a token, so the design budgets them at ≤800
 * tokens per request and requires the measured value in `boost status`
 * (design §6.1). The measurement uses the host's own fixed-density estimator
 * (`estimateSystemMessage` / `estimateToolsTokens` from
 * `@deepseek-ai/dsh-token-meter/estimate`), a dynamic optional peer: a missing
 * package must degrade to `'unknown'`, never to a fabricated zero, because the
 * audit reader cannot tell a real zero from an absent measurement
 * (design §9: do not fabricate).
 *
 * Both components stay visible. The protocol section alone is not the number
 * the design names: the `boost` tool schema is another ~393 tokens, and a
 * status figure that silently omits it understates the cost it is named after.
 * `fixedOverheadTokens` is therefore the total, with
 * `fixedOverhead.protocolTokens` / `fixedOverhead.toolSchemaTokens` alongside.
 *
 * This is a **startup/status-time** measurement, never a per-request one:
 * `apply` starts the memoised probe once, `boost status` awaits it, and no hot
 * path imports this module. The dynamic import is Node-module-cached and the
 * estimate is O(text + schema length).
 *
 * @module dsh-boost/admission/fixed-cost
 */
import { loadOptional } from '../host/loader.js'
import { PROTOCOL_TEXT } from '../prompt/protocol.js'

/** The export shapes this module reads from the optional peer. */
interface EstimateModule {
  estimateSystemMessage?: (message: unknown) => number
  estimateToolsTokens?: (header: unknown) => number
}

/** The import seam, injectable so a test can simulate an absent/broken peer. */
type ModuleLoader = <T>(specifier: string) => Promise<T | undefined>

/** One measured fixed-overhead breakdown, in tokens. */
export interface FixedOverheadMeasurement {
  /** The protocol section alone (`estimateSystemMessage`). */
  protocolTokens: number
  /** The `boost` tool schema alone (`estimateToolsTokens`). */
  toolSchemaTokens: number
  /** The per-request total the design budgets at ≤800. */
  totalTokens: number
}

/** One non-negative finite estimate, or `undefined` when it cannot be trusted. */
function usable(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Measure the full fixed overhead: the protocol section **and** the tool schema.
 *
 * Both components are priced by the same host estimator module. Any failure
 * (missing package/export, a throw, a non-finite part) makes the whole result
 * `'unknown'`; a partial total would be a fabricated number. The tool schema is
 * wrapped in the canonical-envelope shape `estimateToolsTokens` reads
 * (`{ tools: [...] }`), never stringified by hand, so the measurement stays the
 * host's rather than a second heuristic.
 */
export async function measureFixedOverhead(
  toolSchema: unknown,
  text: string = PROTOCOL_TEXT,
  load: ModuleLoader = loadOptional,
): Promise<FixedOverheadMeasurement | 'unknown'> {
  try {
    const module = await load<EstimateModule>('@deepseek-ai/dsh-token-meter/estimate')
    if (
      module === undefined ||
      typeof module.estimateSystemMessage !== 'function' ||
      typeof module.estimateToolsTokens !== 'function'
    ) {
      return 'unknown'
    }

    const protocolTokens = usable(
      module.estimateSystemMessage({ role: 'system', content: [{ type: 'text', text }] }),
    )
    const toolSchemaTokens = usable(module.estimateToolsTokens({ tools: [toolSchema] }))
    if (protocolTokens === undefined || toolSchemaTokens === undefined) return 'unknown'

    return { protocolTokens, toolSchemaTokens, totalTokens: protocolTokens + toolSchemaTokens }
  } catch {
    return 'unknown'
  }
}
