/**
 * The page's strings, resolved through a translator.
 *
 * No visible text lives in a component: every label is a key in `locale/*.json`
 * and `copyOf` resolves them all at once, so a component that reads `c.TITLE`
 * cannot drift from the dictionary.
 */
import zh from '../../locale/zh.json' with { type: 'json' }
import type { Translate } from './i18n.js'

/** Every key the dictionaries carry. */
/** The UI strings, without the manifest metadata the host's plugin list reads. */
export type CopyKey = Exclude<keyof typeof zh, 'meta'>

/** A fully resolved copy set: one string per key. */
export type Copy = Record<CopyKey, string>

/** Resolves every key once, so a component can read fields instead of calling `t`. */
export function copyOf(t: Translate): Copy {
  const resolved: Record<string, string> = {}
  for (const key of Object.keys(zh)) {
    if (key === 'meta') continue
    resolved[key] = t(key)
  }
  return resolved as Copy
}

/**
 * What to do about a code, from whichever table carries it.
 *
 * Two tables exist because they answer different questions — a degraded code is
 * a standing condition, a route code is a failed request — but the operator
 * reads the same sentence either way, so the lookup is one function and the
 * fallback is one string.
 */
export function adviceFor(t: Translate, code: string): string {
  const direct = t(`ADVICE_FOR_CODE.${code}`)
  if (direct !== `ADVICE_FOR_CODE.${code}`) return direct
  const degraded = t(`DEGRADED_ADVICE.${code}`)
  if (degraded !== `DEGRADED_ADVICE.${code}`) return degraded
  return t('DEGRADED_FALLBACK')
}

/** The wire values, which are not the labels the dictionary carries. */
export const MODE_VALUE_SELECTED = 'selected'
export const MODE_VALUE_GLOBAL = 'global'
