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
import { DICTIONARIES, LOCALE_NAMESPACE, fallbackT, setTranslator, type Translate } from './i18n'
import styles from './styles.css?inline'

/** The slot a settings page registers into, per the shell's settings contract. */
export const SETTINGS_SLOT = 'settings.section'

/** This page's namespace: the nav key, and the locale namespace. */
export const SETTINGS_NAMESPACE = 'boost'

/**
 * This bundle's service dependencies, by module short name.
 *
 * `locale` is optional in practice: cordis' `inject` is an AND gate, so listing
 * it would keep the page off a host without a locale service. The page is
 * readable without one, so the service is read from the context and its absence
 * costs only the language switch.
 */
export const inject = ['slots']

/** Minimal structural type: the host's own declarations are not shipped here. */
interface SlotsService {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/**
 * The slice of the host's locale service this bundle uses.
 *
 * Structural, like `SlotsService`: the host's declarations are not shipped, and
 * a missing method must degrade rather than crash the page.
 */
interface LocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): Translate
  subscribe?(listener: () => void): () => void
}

interface ClientContext {
  slots?: SlotsService
  locale?: LocaleService
  /** The optional service read; `ctx.x` throws for services outside `inject`. */
  get?: (name: string) => unknown
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

/**
 * Wires the translator, preferring the host's.
 *
 * `register` throws when the host's locale service exists but has no locale
 * face behind it, so the fallback is a caught error rather than a null check:
 * the only way to know is to try.
 */
function installTranslator(ctx: ClientContext): Translate {
  // `ctx.locale` would THROW on a host that does not provide the service —
  // cordis proxies unknown services into a hard error, not `undefined`. `get`
  // is the optional read, and it is the difference between a fallback page and
  // no page at all.
  const locale = ctx.get?.('locale') as LocaleService | undefined
  if (locale === undefined) {
    console.warn(`[${SETTINGS_NAMESPACE}] host has no locale service; the page stays readable but will not follow the host language`)
  }
  if (locale !== undefined) {
    try {
      ctx.effect?.(() => locale.register(LOCALE_NAMESPACE, DICTIONARIES), `${SETTINGS_NAMESPACE}: dictionaries`)
      const bound = locale.bind(LOCALE_NAMESPACE)
      setTranslator(bound)
      // The bound function reads the live snapshot, so a subscription only has
      // to bump the page's render version.
      ctx.effect?.(
        () => locale.subscribe?.(() => setTranslator(locale.bind(LOCALE_NAMESPACE))) ?? (() => {}),
        `${SETTINGS_NAMESPACE}: locale subscription`,
      )
      return bound
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(
        `[${SETTINGS_NAMESPACE}] host locale service rejected the dictionaries (${message}); ` +
          'registering the section without a locale namespace and using the built-in translator',
      )
    }
  }
  // No `locale` option goes on the slot registration in this branch, which is
  // the "re-register without a locale" the spec asks for.
  setTranslator(fallbackT)
  return fallbackT
}

export function apply(ctx: ClientContext): void {
  ctx.effect?.(() => installStyles(), `${SETTINGS_NAMESPACE}: settings styles`)

  const t = installTranslator(ctx)

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
        label: () => t('TITLE'),
        inject: () => ({}),
      },
      App,
    ),
  )
}
