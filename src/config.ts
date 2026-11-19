/**
 * Configuration defaults and resolution.
 *
 * The host's patch replaces the plugin `config` wholesale (design §11), so a
 * missing key never means "keep the previous value": `resolveConfig` merges the
 * host object over `DEFAULT_CONFIG` one key at a time. A key whose value is
 * malformed falls back to its own default rather than raising — a bad overlay
 * degrades to design defaults, it does not break plugin loading.
 *
 * Unknown keys are ignored: hosts may hand a superset of `BoostConfig`.
 *
 * @module dsh-boost/config
 */
import type { BoostConfig, ProjectionParams, ToolFamily } from './types.js'

/** Families with projection windows, in the order defaults are declared. */
const FAMILIES: readonly ToolFamily[] = ['read', 'grep', 'glob', 'bash', 'ssh']

/** Design defaults; must stay verbatim in sync with `cordis.patch.yml` (§5.3). */
export const DEFAULT_CONFIG: BoostConfig = {
  projection: {
    read: { triggerChars: 3000, headChars: 2000, tailChars: 500 },
    grep: { triggerChars: 700, headChars: 400, tailChars: 100 },
    glob: { triggerChars: 700, headChars: 400, tailChars: 100 },
    bash: { triggerChars: 4000, headChars: 2000, tailChars: 500 },
    ssh: { triggerChars: 2000, headChars: 1200, tailChars: 300 },
  },
  admission: { thresholdTokens: 1024 },
  selector: { maxTokens: 512 },
  stepsPerTurn: 8,
  horizonSteps: 20,
  historyTurns: 5,
}

/** A config section is any non-null object; everything else is absent. */
function section(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** Take `value` when it is a usable number, otherwise the per-key default. */
function pick(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Resolve one family's window key by key against its default window. */
function pickProjection(raw: unknown, fallback: ProjectionParams): ProjectionParams {
  const family = section(raw)
  return {
    triggerChars: pick(family?.triggerChars, fallback.triggerChars),
    headChars: pick(family?.headChars, fallback.headChars),
    tailChars: pick(family?.tailChars, fallback.tailChars),
  }
}

/**
 * Turn whatever the host hands `apply` into a complete `BoostConfig`.
 *
 * Always returns a fresh deep copy, so callers cannot mutate `DEFAULT_CONFIG`.
 * Non-object input resolves to the defaults.
 */
export function resolveConfig(raw: unknown): BoostConfig {
  const cfg = structuredClone(DEFAULT_CONFIG)
  const root = section(raw)
  if (!root) return cfg

  const projection = section(root.projection)
  for (const family of FAMILIES) {
    cfg.projection[family] = pickProjection(projection?.[family], cfg.projection[family])
  }

  const admission = section(root.admission)
  cfg.admission.thresholdTokens = pick(admission?.thresholdTokens, cfg.admission.thresholdTokens)

  const selector = section(root.selector)
  cfg.selector.maxTokens = pick(selector?.maxTokens, cfg.selector.maxTokens)

  cfg.stepsPerTurn = pick(root.stepsPerTurn, cfg.stepsPerTurn)
  cfg.horizonSteps = pick(root.horizonSteps, cfg.horizonSteps)
  cfg.historyTurns = pick(root.historyTurns, cfg.historyTurns)

  return cfg
}