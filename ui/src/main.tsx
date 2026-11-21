/**
 * The plugin's browser half: registers the settings page with the host shell.
 *
 * Registration goes through the `slots` service — the host owns where a
 * settings section appears, so a plugin must never append its own container to
 * `document.body`. `slots.inject` waits for the slot to exist before
 * `slots.register` claims a seat, and the returned disposer is handed back so
 * cordis can tie it to the plugin's lifecycle.
 */
import { App } from './App'
import { TITLE } from './copy'
import styles from './styles.css?inline'

/** The slot a settings page registers into, per the shell's settings contract. */
export const SETTINGS_SLOT = 'settings.section'

/** This page's namespace: the nav key, and (from T5) the locale namespace. */
export const SETTINGS_NAMESPACE = 'boost'

/** This bundle's service dependencies, by module short name. */
export const inject = ['slots']

/** Minimal structural type: the host's own declarations are not shipped here. */
interface SlotsService {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

interface ClientContext {
  slots?: SlotsService
  effect?(callback: () => () => void, label?: string): () => void
}

/**
 * Injects the page styles, returning the disposer that removes the node.
 *
 * A `<style>` node rather than a stylesheet link: the host's module loader has
 * no notion of a co-located stylesheet, and the build emits no CSS file.
 */
function installStyles(): () => void {
  const node = document.createElement('style')
  node.setAttribute('data-boost-styles', '')
  node.textContent = styles
  document.head.append(node)
  return () => node.remove()
}

export function apply(ctx: ClientContext): void {
  ctx.effect?.(() => installStyles(), `${SETTINGS_NAMESPACE}: settings styles`)

  if (ctx.slots === undefined) {
    // Reachable only when the host mounts a partial `slots` service: `inject`
    // already makes the fiber wait for a real one. Logged rather than thrown so
    // a misbehaving host costs the page, never the plugin.
    console.warn(`[${SETTINGS_NAMESPACE}] client slots service unavailable; settings page not registered`)
    return
  }

  // Narrowed once, so the closure below carries no non-null assertion.
  const slots = ctx.slots
  slots.inject(SETTINGS_SLOT, () =>
    slots.register(
      {
        name: SETTINGS_SLOT,
        id: SETTINGS_NAMESPACE,
        order: 50,
        // A thunk, not a string: the shell re-reads it when the locale changes,
        // so the nav item follows the language without this plugin subscribing.
        label: () => TITLE,
        inject: () => ({}),
      },
      App,
    ),
  )
}
