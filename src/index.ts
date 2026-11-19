/**
 * dsh-boost cordis plugin entry point.
 *
 * The plugin is a plain function plugin: cordis reads `name` and `inject` from
 * the module and calls `apply(ctx, config)`. Only plugin metadata lives here;
 * behaviour modules are registered from `apply` as later tasks land.
 *
 * @module dsh-boost
 */
import type { PluginContext } from './types.js'

export const name = 'dsh-boost'

export const inject = ['tools', 'llm', 'systemPrompt'] as const

export function apply(ctx: PluginContext, config: unknown): void {
  ctx.logger?.info?.('dsh-boost loaded')
}
