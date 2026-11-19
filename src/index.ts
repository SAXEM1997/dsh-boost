/**
 * dsh-boost cordis plugin entry point.
 *
 * The plugin is a plain function plugin: cordis reads `name` and `inject` from
 * the module and calls `apply(ctx, config)`. Only the production assembly lives
 * here — configuration resolution, the two stores the hooks and the control
 * tool share, the four mount points, and the `boost` tool, all wired once per
 * plugin instance.
 *
 * Wiring failures are contained: a host that lacks the services a mount point
 * lives on must load the plugin with a warning, not die loading it. The data
 * root is `$DSH_HOME/boost`, falling back to `~/.dsh/boost`.
 *
 * @module dsh-boost
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from './config.js'
import { AnchorStore } from './gate/invalidate.js'
import { registerHooks } from './hooks/post-execute.js'
import { ReceiptStore } from './receipts/store.js'
import { supportsStepWhen } from './scope/resolve.js'
import { ScopeStore } from './scope/store.js'
import { boostTool } from './tools/boost.js'
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

/**
 * Register the `boost` tool family.
 *
 * After T19 the family is just this one tool; T23b's substitution path depends
 * on the same `tools.resolve` probe. The tool itself is scope-exempt
 * (`when: () => true`) because it is the only way a user can enable a workspace
 * that is not enabled yet — gating it on the scope document would make
 * `selected + []` impossible to leave. The protocol section is not exempt; T17
 * already handles it.
 *
 * Without step-level `when` a conditional registration would silently become
 * unconditional, so the whole family is skipped and the stable code is logged.
 */
function registerBoostTool(
  ctx: PluginContext,
  deps: { scope: ScopeStore; receipts: ReceiptStore },
): void {
  if (!supportsStepWhen(ctx.tools)) {
    ctx.logger?.warn?.('ERR_HOST_NO_STEP_WHEN')
    return
  }
  // Annotating with the host's ToolDefinition makes a host-side tightening a
  // build error instead of a runtime registration failure.
  const definition: ToolDefinition = boostTool(deps)
  ctx.tools.register(definition, { when: () => true })
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

  let hooksMounted = false
  try {
    const root = boostRoot()
    const scope = new ScopeStore(root)
    const receipts = new ReceiptStore(root)
    // `anchors` and `resolveSession` are required by the hook contract. The
    // session-table lookup belongs to Task 23c's production assembly; until it
    // lands, an unresolved session is fail-closed (no substitution), never an
    // error, and projection keeps working from the judgement cache.
    registerHooks(ctx, {
      config: cfg,
      scope,
      receipts,
      anchors: new AnchorStore(),
      resolveSession: () => undefined,
    })
    hooksMounted = true
    // After the hooks: `registerHooks` mounts the prompt section first and
    // throws on a duplicate, so a second `apply` aborts above before it can
    // register the tool twice.
    registerBoostTool(ctx, { scope, receipts })
  } catch (error) {
    // A second apply fails on the duplicate prompt section first (registerHooks
    // mounts it first), which means the plugin is already wired — not that
    // wiring failed. Returning here leaves the existing mounts untouched.
    if (alreadyMounted(error)) return
    // The tool is the user's only control surface, so its failure must not be
    // reported as a hook failure (that would hide the degradation behind a
    // misleading message).
    if (hooksMounted) {
      ctx.logger?.warn?.(
        `dsh-boost: boost tool registration failed (ERR_BOOST_TOOL_REGISTER_FAILED): ${messageOf(error)}`,
      )
      return
    }
    ctx.logger?.warn?.(`dsh-boost: hook registration skipped: ${messageOf(error)}`)
  }
}
