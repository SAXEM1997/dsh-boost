/**
 * Configuration defaults and resolution.
 *
 * The host's patch replaces the plugin `config` wholesale (design §11), so a
 * missing key never means "keep the previous value": `resolveConfig` merges the
 * host object over `DEFAULT_CONFIG` one key at a time. A key whose value is
 * malformed falls back to its own default rather than raising — a bad overlay
 * degrades to design defaults, it does not break plugin loading.
 *
 * ## Validation
 *
 * A finite number is not automatically a usable value. Negative or fractional
 * projection windows, budgets and counts are rejected or clamped here rather
 * than flowing into the decision path: a negative `triggerChars` would make
 * every receipt a candidate and a negative `selector.maxTokens` would reach the
 * selector LLM. Every repair is reported through the optional callback so the
 * operator sees the effective value instead of a silent fallback, and
 * `projection.*.headChars + tailChars` must stay below `triggerChars` (design
 * §5.3: a window at or above the trigger cannot cut anything).
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

/** Receives one human-readable line per repaired configuration key. */
export type ConfigRepair = (message: string) => void

/** A config section is any non-null object; everything else is absent. */
function section(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/**
 * Take `value` when it is an integer >= `min`, otherwise `fallback`.
 *
 * A finite fractional value floors and is reported; a negative, non-finite,
 * unsafe or non-numeric value is rejected and the key's own default is used.
 */
function integerAtLeast(
  value: unknown,
  fallback: number,
  min: number,
  label: string,
  repair: ConfigRepair,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    if (value !== undefined) {
      repair(`dsh-boost: ignoring config ${label}=${String(value)}; using ${fallback}`)
    }
    return fallback
  }
  const clamped = Math.floor(value)
  if (!Number.isSafeInteger(clamped) || clamped < min) {
    repair(`dsh-boost: ignoring config ${label}=${String(value)}; using ${fallback}`)
    return fallback
  }
  if (clamped !== value) {
    repair(`dsh-boost: clamping config ${label}=${String(value)} to ${clamped}`)
  }
  return clamped
}

/** Resolve one family's window key by key, then enforce the window invariant. */
function pickProjection(
  raw: unknown,
  fallback: ProjectionParams,
  family: ToolFamily,
  repair: ConfigRepair,
): ProjectionParams {
  const source = section(raw)
  const picked: ProjectionParams = {
    triggerChars: integerAtLeast(
      source?.triggerChars,
      fallback.triggerChars,
      0,
      `projection.${family}.triggerChars`,
      repair,
    ),
    headChars: integerAtLeast(
      source?.headChars,
      fallback.headChars,
      0,
      `projection.${family}.headChars`,
      repair,
    ),
    tailChars: integerAtLeast(
      source?.tailChars,
      fallback.tailChars,
      0,
      `projection.${family}.tailChars`,
      repair,
    ),
  }
  const window = picked.headChars + picked.tailChars
  // Design §5.3: the window must be strictly smaller than the trigger, or the
  // guaranteed saving disappears (and `triggerChars: 0` would project every
  // receipt before the net check rejects it).
  if (!Number.isSafeInteger(window) || window >= picked.triggerChars) {
    repair(
      `dsh-boost: config projection.${family} window ${picked.headChars}+${picked.tailChars} is not below triggerChars ${picked.triggerChars}; using the design default window`,
    )
    return { ...fallback }
  }
  return picked
}

/**
 * Turn whatever the host hands `apply` into a complete `BoostConfig`.
 *
 * Always returns a fresh deep copy, so callers cannot mutate `DEFAULT_CONFIG`.
 * Non-object input resolves to the defaults. `onRepair` receives one line per
 * key that was rejected, clamped or repaired; it is never called for a valid
 * value.
 */
export function resolveConfig(raw: unknown, onRepair: ConfigRepair = () => {}): BoostConfig {
  const cfg = structuredClone(DEFAULT_CONFIG)
  const root = section(raw)
  if (!root) return cfg

  const projection = section(root.projection)
  for (const family of FAMILIES) {
    cfg.projection[family] = pickProjection(
      projection?.[family],
      cfg.projection[family],
      family,
      onRepair,
    )
  }

  const admission = section(root.admission)
  cfg.admission.thresholdTokens = integerAtLeast(
    admission?.thresholdTokens,
    cfg.admission.thresholdTokens,
    0,
    'admission.thresholdTokens',
    onRepair,
  )

  const selector = section(root.selector)
  cfg.selector.maxTokens = integerAtLeast(
    selector?.maxTokens,
    cfg.selector.maxTokens,
    1,
    'selector.maxTokens',
    onRepair,
  )

  cfg.stepsPerTurn = integerAtLeast(root.stepsPerTurn, cfg.stepsPerTurn, 0, 'stepsPerTurn', onRepair)
  cfg.horizonSteps = integerAtLeast(root.horizonSteps, cfg.horizonSteps, 0, 'horizonSteps', onRepair)
  cfg.historyTurns = integerAtLeast(
    root.historyTurns,
    cfg.historyTurns,
    1,
    'historyTurns',
    onRepair,
  )

  return cfg
}
