/**
 * The seam between the page's wording and the route's vocabulary (spec S-3).
 *
 * The page decides what to say from a stable code, so a code the route can emit
 * but the page has no sentence for renders as a raw identifier to the operator.
 * That is a support ticket, not a design — this test is what keeps the two
 * lists from drifting apart as codes are added.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { adviceFor, copyOf } from '../ui/src/copy.ts'
import { KEYS, fallbackT, type Translate } from '../ui/src/i18n.ts'
import * as state from '../src/http/state.ts'

/** Every `ERR_HTTP_*` the route can return, discovered rather than restated. */
function routeCodes(): string[] {
  return Object.entries(state)
    .filter(([name, value]) => name.startsWith('ERR_HTTP_') && typeof value === 'string')
    .map(([, value]) => value as string)
}

/** A translator that answers from the dictionary and returns the key on a miss. */
const dictionaryT: Translate = key => fallbackT(key)

test('路由能返回的每个码，页面都有一句话', () => {
  const missing = routeCodes().filter(code => adviceFor(dictionaryT, code) === dictionaryT('DEGRADED_FALLBACK'))
  assert.deepEqual(missing, [], `the page has no sentence for: ${missing.join(', ')}`)
})

test('页面自己产生的两个码也有句子', () => {
  for (const code of ['ERR_CLIENT_NETWORK', 'ERR_CLIENT_SHAPE']) {
    assert.notEqual(adviceFor(dictionaryT, code), dictionaryT('DEGRADED_FALLBACK'), `${code} has no sentence`)
  }
})

test('降级建议表只放错误码，不放散文键', () => {
  for (const key of KEYS) {
    if (!key.startsWith('DEGRADED_ADVICE.')) continue
    const code = key.slice('DEGRADED_ADVICE.'.length)
    assert.match(code, /^ERR_[A-Z0-9_]+$/, `${key} is not keyed by a stable code`)
  }
})

test('每个降级建议都不是空串', () => {
  const c = copyOf(dictionaryT)
  for (const key of KEYS) assert.ok(c[key as keyof typeof c].length > 0, `${key} is empty`)
})

test('未知码回落到通用句子，而不是裸标识符', () => {
  const sentence = adviceFor(dictionaryT, 'ERR_NOT_A_REAL_CODE')
  assert.equal(sentence, dictionaryT('DEGRADED_FALLBACK'))
})
