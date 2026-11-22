/**
 * The page's language plumbing.
 *
 * Two translators, one shape. When the host exposes a `locale` service the page
 * registers its dictionaries there and reads through `locale.bind(ns)`, so it
 * follows the host's language and the user's switch. When it does not, a local
 * translator reads the same dictionaries and answers in `zh` — the page stays
 * usable, it just stops following.
 *
 * The host's translator returns the KEY when a lookup misses, and this module's
 * fallback does the same, so "the value equals the key" is a reliable
 * missing-string signal everywhere.
 */
import { useSyncExternalStore } from 'react'
import en from '../../locale/en.json' with { type: 'json' }
import zh from '../../locale/zh.json' with { type: 'json' }

/** The namespace this plugin registers its dictionaries under. */
export const LOCALE_NAMESPACE = 'dsh-boost'

/** What a translator is: a key in, a string out. */
export type Translate = (key: string) => string

/** A language's UI strings. */
export type Dictionary = Record<string, string>

/** The UI strings of a language, without the manifest metadata. */
function stringsOf(source: Record<string, unknown>): Dictionary {
  const strings: Dictionary = {}
  for (const [key, value] of Object.entries(source)) {
    if (key !== 'meta' && typeof value === 'string') strings[key] = value
  }
  return strings
}

/** Both dictionaries, key-for-key identical. */
export const DICTIONARIES: Readonly<Record<string, Dictionary>> = {
  zh: stringsOf(zh),
  en: stringsOf(en),
}

/** The language the fallback translator answers in. */
export const FALLBACK_LANGUAGE = 'zh'

/** Every key this page can ask for. */
export const KEYS: readonly string[] = Object.keys(zh).filter(key => key !== 'meta')

/**
 * The translator used when the host offers no locale service.
 *
 * Deliberately dumb: no interpolation, no plurals, no fallback chain beyond
 * `zh`. It exists so the page is readable without the host, not so it can stand
 * in for one.
 */
export const fallbackT: Translate = key => DICTIONARIES[FALLBACK_LANGUAGE]?.[key] ?? key

let current: Translate = fallbackT
let version = 0
const listeners = new Set<() => void>()

/** Swaps the live translator and re-renders everything that reads it. */
export function setTranslator(next: Translate): void {
  current = next
  version += 1
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A crashing subscriber must not stop the others from re-rendering.
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The live translator, re-rendering its caller whenever the language changes.
 *
 * The returned function is stable; what changes is `version`, which is what
 * `useSyncExternalStore` compares. Returning a fresh closure per render would
 * re-subscribe on every keystroke.
 */
export function useT(): Translate {
  useSyncExternalStore(subscribe, () => version, () => version)
  return current
}
