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
import * as copy from '../ui/src/copy.ts'
import * as state from '../src/http/state.ts'

/** Every `ERR_HTTP_*` the route can return, discovered rather than restated. */
function routeCodes(): string[] {
  return Object.entries(state)
    .filter(([name, value]) => name.startsWith('ERR_HTTP_') && typeof value === 'string')
    .map(([, value]) => value as string)
}

test('路由能返回的每个码，页面都有一句话', () => {
  const missing = routeCodes().filter(code => copy.ADVICE_FOR_CODE[code] === undefined)
  assert.deepEqual(missing, [], `the page has no sentence for: ${missing.join(', ')}`)
})

test('页面自己产生的两个码也有句子', () => {
  for (const code of ['ERR_CLIENT_NETWORK', 'ERR_CLIENT_SHAPE']) {
    assert.ok(copy.ADVICE_FOR_CODE[code] !== undefined, `${code} has no sentence`)
  }
})

test('降级建议表只放错误码，不放散文键', () => {
  for (const key of Object.keys(copy.DEGRADED_ADVICE)) {
    assert.match(key, /^ERR_[A-Z0-9_]+$/, `${key} is not shaped like a stable code`)
  }
})

test('每个降级建议都不是空串', () => {
  for (const [key, value] of Object.entries(copy.DEGRADED_ADVICE)) {
    assert.ok(value.trim().length > 0, `${key} has an empty sentence`)
  }
})
