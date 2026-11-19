/**
 * dsh-boost cordis plugin entry point.
 *
 * The plugin is a plain function plugin: cordis reads `name` and `inject` from
 * the module and calls `apply(ctx, config)`. Only the production assembly lives
 * here — configuration resolution, the two stores the hooks share, and the
 * four mount points, all wired once per plugin instance.
 *
 * Wiring failures are contained: a host that lacks the services a mount point
 * lives on must load the plugin with a warning, not die loading it. The data
 * root is `$DSH_HOME/boost`, falling back to `~/.dsh/boost`.
 *
 * @module dsh-boost
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from './config.js'
import { registerHooks } from './hooks/post-execute.js'
import { ReceiptStore } from './receipts/store.js'
import { ScopeStore } from './scope/store.js'
import type { PluginContext } from './types.js'

export const name = 'dsh-boost'

export const inject = ['tools', 'llm', 'systemPrompt'] as const

/** Whether the host exposes both services the four mount points attach to. */
function canRegister(ctx: PluginContext): boolean {
  return typeof ctx.on === 'function' && typeof ctx.systemPrompt?.section === 'function'
}

/**
 * The plugin's data root: `<DSH_HOME>/boost`, with `~/.dsh/boost` as the
 * default when the environment variable is unset or blank (design §10).
 */
function boostRoot(): string {
  const configured = process.env.DSH_HOME?.trim()
  return join(configured ? configured : join(homedir(), '.dsh'), 'boost')
}

/** One-line detail for a contained wiring failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The host exposes no code for a duplicate section name; its message is the
 * only discriminator (`prompt section "dsh-boost" is already registered …`).
 */
const ALREADY_REGISTERED = /already registered/

/** Whether a registration failure means this plugin's mounts already exist. */
function alreadyMounted(error: unknown): boolean {
  return ALREADY_REGISTERED.test(messageOf(error))
}

export function apply(ctx: PluginContext, config: unknown): void {
  const cfg = resolveConfig(config)
  ctx.logger?.info?.(
    `dsh-boost loaded (stepsPerTurn=${cfg.stepsPerTurn}, horizonSteps=${cfg.horizonSteps})`,
  )

  if (!canRegister(ctx)) {
    ctx.logger?.warn?.('dsh-boost: host hook services unavailable; registration skipped')
    return
  }

  try {
    const root = boostRoot()
    registerHooks(ctx, {
      config: cfg,
      scope: new ScopeStore(root),
      receipts: new ReceiptStore(root),
    })
  } catch (error) {
    // A second apply fails on the duplicate prompt section first (registerHooks
    // mounts it first), which means the plugin is already wired — not that
    // wiring failed. Returning here leaves the existing mounts untouched.
    if (alreadyMounted(error)) return
    ctx.logger?.warn?.(`dsh-boost: hook registration skipped: ${messageOf(error)}`)
  }
}
