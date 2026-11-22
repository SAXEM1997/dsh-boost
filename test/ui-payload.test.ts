/**
 * The seam between the route's payload and the page's field reads.
 *
 * `/state` hands back `runBoost`'s envelopes verbatim, so `status` arrives as
 * `{ ok, data }`. Reading `saved` off the envelope instead of its `data` finds
 * nothing, renders every row as "unmeasured" and every degradation list as
 * empty — a page that looks healthy because it cannot see anything. The
 * component cannot be rendered here (no jsdom, by design), so this pins the two
 * halves that meet: the payload the route builds, and the unwrap the page uses.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStatePayload } from '../src/http/state.ts'
import { payloadOf } from '../ui/src/draft.ts'

/** A `status` result shaped the way `runBoost` returns it. */
const STATUS = {
  ok: true as const,
  data: {
    saved: { substitution: 12, projectionGross: 40, projectionNet: 7 },
    degraded: ['ERR_HOST_NO_SPILL'],
    counts: { projection: 3 },
    fixedOverheadTokens: 778,
    estimate_kind: 'host',
  },
}

test('页面从 status 的信封里读到真实字段', async () => {
  const payload = await buildStatePayload({
    status: async () => STATUS,
    scope: async () => ({ ok: true, data: { version: 2, revision: 0, mode: 'selected', workspaceIds: [], shadow: true, projection: 'shadow' } }),
    workspaces: () => ({ available: true, entries: [] }),
    config: () => ({ projection: { read: { triggerChars: 3000 } } }),
    write: async () => ({ ok: true, data: {} }),
  })

  const status = payloadOf(payload.status) as Record<string, unknown>
  assert.deepEqual(status['degraded'], ['ERR_HOST_NO_SPILL'], 'degraded is a list on the unwrapped data')
  assert.equal(status['fixedOverheadTokens'], 778)
  assert.equal(status['estimate_kind'], 'host')
  assert.deepEqual(status['saved'], STATUS.data.saved)
  assert.deepEqual(status['counts'], STATUS.data.counts)
})

test('status 失败时保留信封，码仍然可读', () => {
  const failed = { ok: false as const, code: 'ERR_BOOST_INTERNAL' }
  const unwrapped = payloadOf(failed) as Record<string, unknown>
  assert.equal(unwrapped['code'], 'ERR_BOOST_INTERNAL')
  assert.equal(unwrapped['ok'], false)
})

test('不是对象的载荷原样返回', () => {
  assert.equal(payloadOf(undefined), undefined)
  assert.equal(payloadOf('x'), 'x')
})
