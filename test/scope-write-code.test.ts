/**
 * A failed write must reach the caller as `ERR_SCOPE_WRITE_FAILED`.
 *
 * Two separate things used to swallow it: the store raised the read code for a
 * directory it could not create, and `runBoost` passed through only the scope
 * codes it listed, so anything else became `ERR_BOOST_INTERNAL`. The page's
 * advice hangs off the code — "re-read" throws away a good draft, and the write
 * failure page is the one place that must not say it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runBoost } from '../src/tools/boost.ts'
import { ERR_SCOPE_WRITE_FAILED } from '../src/scope/doc.ts'

/** The shape the store raises: an `Error` carrying a stable `code`. */
function storeThatCannotWrite(): never {
  const error = new Error('cannot write /home/boost/scope.json: ENOSPC') as Error & { code: string }
  error.code = ERR_SCOPE_WRITE_FAILED
  throw error
}

test('写不进去时代码原样返回，不被压成 ERR_BOOST_INTERNAL', async () => {
  const result = await runBoost({
    scope: { write: async () => storeThatCannotWrite() } as never,
    receipts: {} as never,
    host: undefined,
    fixedOverhead: async () => 'unknown',
    args: { cmd: 'scope-set', body: { mode: 'global' }, baseRevision: 0 },
  })
  assert.equal(result.ok, false)
  assert.equal((result as { code?: string }).code, ERR_SCOPE_WRITE_FAILED)
})
