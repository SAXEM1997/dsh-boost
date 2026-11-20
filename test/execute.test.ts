import test from 'node:test'
import assert from 'node:assert/strict'
import { sameLiteral, rejectIfTampered } from '../src/hooks/execute.ts'
import { AnchorStore } from '../src/gate/invalidate.ts'
import { PendingQueue } from '../src/hooks/pending.ts'
import { registerHooks } from '../src/hooks/post-execute.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { fakeHost } from './fakes/host.ts'

// --- the brief's three tests, verbatim -------------------------------------

test('字面量逐字比对，键序无关', () => {
  assert.equal(sameLiteral({ a: 1, b: 'x' }, { b: 'x', a: 1 }), true)
  assert.equal(sameLiteral({ a: 1 }, { a: 2 }), false)
  assert.equal(sameLiteral({ a: 1, b: 2 }, { a: 1 }), false)
})

test('实参被改动则拒绝派发', () => {
  const pending = { candidateId: 'A', name: 'read', args: { path: '/a' } } as any
  assert.deepEqual(rejectIfTampered({ name: 'read', arguments: { path: '/b' } }, pending), { reject: true, code: 'dispatch-rejected' })
  assert.deepEqual(rejectIfTampered({ name: 'read', arguments: { path: '/a' } }, pending), { reject: false })
})

test('无 pending 时不干预', () => {
  assert.deepEqual(rejectIfTampered({ name: 'read', arguments: {} }, undefined), { reject: false })
})

// --- rule 1: structural, literal comparison --------------------------------

test('嵌套对象与数组按结构与顺序比对', () => {
  assert.equal(sameLiteral({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true)
  assert.equal(sameLiteral({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }), false)
  assert.equal(sameLiteral({ a: [1, 2] }, { a: [2, 1] }), false)
  assert.equal(sameLiteral({ a: [1, 2] }, { a: [1, 2, 3] }), false)
  assert.equal(sameLiteral({ a: [1] }, { a: { '0': 1 } }), false)
  assert.equal(sameLiteral([], {}), false)
  assert.equal(sameLiteral(undefined, {}), false)
  assert.equal(sameLiteral(undefined, null), false)
})

test('任一侧多出键都不相等', () => {
  assert.equal(sameLiteral({ a: 1 }, { a: 1, b: 2 }), false)
  assert.equal(sameLiteral({ a: 1, b: 2 }, { a: 1 }), false)
  // same key count, different key set
  assert.equal(sameLiteral({ a: 1 }, { b: 1 }), false)
  // an own key counts even when its value is undefined
  assert.equal(sameLiteral({ a: 1 }, { a: 1, b: undefined }), false)
})

test('标量按 Object.is：NaN 相等，-0 与 0 不等', () => {
  assert.equal(sameLiteral(NaN, NaN), true)
  assert.equal(sameLiteral({ x: NaN }, { x: NaN }), true)
  assert.equal(sameLiteral(0, -0), false)
  assert.equal(sameLiteral({ x: 0 }, { x: -0 }), false)
  assert.equal(sameLiteral(-0, -0), true)
})

// --- rule 2: total over arbitrary input ------------------------------------

test('循环引用不挂起，按无法证明相等处理', () => {
  const a: any = { name: 'a' }
  const b: any = { name: 'a' }
  a.self = a
  b.self = b
  assert.equal(sameLiteral(a, b), false)
  // Same reference is proof, so the walk stops immediately instead of
  // exhausting the depth budget.
  assert.equal(sameLiteral(a, a), true)
})

test('超过深度上限一律不相等', () => {
  const nest = (depth: number): any => {
    let value: any = 'leaf'
    for (let i = 0; i < depth; i += 1) value = { next: value }
    return value
  }
  assert.equal(sameLiteral(nest(8), nest(8)), true)
  assert.equal(sameLiteral(nest(64), nest(64)), true)
  assert.equal(sameLiteral(nest(65), nest(65)), false)
  assert.equal(sameLiteral(nest(500), nest(500)), false)
})

// --- rule 3/4: name + argument comparison, undefined-only normalisation ----

test('工具名不一致即使实参相同也拒绝', () => {
  const pending = { name: 'read', args: { path: '/a' } }
  assert.deepEqual(rejectIfTampered({ name: 'grep', arguments: { path: '/a' } }, pending), {
    reject: true,
    code: 'dispatch-rejected',
  })
})

test('arguments 缺省按 {} 归一，null 是真实值不归一', () => {
  const zero = { name: 'glob', args: {} }
  assert.deepEqual(rejectIfTampered({ name: 'glob', arguments: undefined }, zero), { reject: false })
  assert.deepEqual(rejectIfTampered({ name: 'glob', arguments: null }, zero), {
    reject: true,
    code: 'dispatch-rejected',
  })
  // An argument-taking pending entry is not satisfied by an absent arguments
  // object: normalisation only ever produces `{}`.
  const one = { name: 'read', args: { path: '/a' } }
  assert.deepEqual(rejectIfTampered({ name: 'read', arguments: undefined }, one), {
    reject: true,
    code: 'dispatch-rejected',
  })
})

// --- rule 5: the verdict never touches the pending entry -------------------

test('判定不清 pending：拒绝后条目原样保留', () => {
  const pending = { candidateId: 'A', name: 'read', args: { path: '/a' } }
  const before = structuredClone(pending)
  assert.deepEqual(rejectIfTampered({ name: 'read', arguments: { path: '/b' } }, pending), {
    reject: true,
    code: 'dispatch-rejected',
  })
  assert.deepEqual(pending, before)
})

// --- rule 6: the post-execute tools/execute wiring -------------------------

const AGENT = { session: { header: { id: 's1', cwd: '/w' } } }

/** Mount registerHooks over a real PendingQueue holding at most one entry. */
function mount(pending?: { name: string; args: Record<string, unknown> }): any {
  const host = fakeHost()
  const queue = new PendingQueue()
  if (pending !== undefined) {
    queue.set('s1', {
      callId: 'call-1',
      candidateId: 'A',
      name: pending.name,
      args: pending.args,
      turn: 1,
      step: 0,
      createdAt: 0,
    })
  }
  registerHooks(host, {
    config: DEFAULT_CONFIG,
    anchors: new AnchorStore(),
    resolveSession: () => 'w1',
    queue,
  } as any)
  return host
}

test('tools/execute 在队列为空时仍然直通', async () => {
  const host = mount()
  const out = await host.callHook(
    'tools/execute',
    [{ name: 'read', callId: 'call-1', arguments: { path: '/a' }, agent: AGENT }],
    async () => 'DISPATCHED',
  )
  assert.equal(out, 'DISPATCHED')
  assert.equal(host.nextCalls, 1)
})

test('tools/execute 在等值 pending 时放行到派发', async () => {
  const host = mount({ name: 'read', args: { path: '/a' } })
  const out = await host.callHook(
    'tools/execute',
    [{ name: 'read', callId: 'call-1', arguments: { path: '/a' }, agent: AGENT }],
    async () => 'DISPATCHED',
  )
  assert.equal(out, 'DISPATCHED')
  assert.equal(host.nextCalls, 1)
})

test('tools/execute 在实参不符时返回宿主 failure 且不派发', async () => {
  const host = mount({ name: 'read', args: { path: '/a' } })
  let dispatched = 0
  const out: any = await host.callHook(
    'tools/execute',
    [{ name: 'read', callId: 'call-1', arguments: { path: '/b' }, agent: AGENT }],
    async () => {
      dispatched += 1
      return 'DISPATCHED'
    },
  )
  // The host's `ToolExecutionResult` failure branch, not a private `{reject}`
  // envelope: the executor would silently ignore the latter.
  assert.equal(out.isError, true)
  assert.equal(out.error.info.code, 'dispatch-rejected')
  assert.equal(out.error.info.name, 'DispatchRejectedError')
  assert.equal(typeof out.error.message, 'string')
  assert.deepEqual(out.content, [{ type: 'text', text: `Error: ${out.error.message}` }])
  assert.equal(dispatched, 0)
  assert.equal(host.nextCalls, 0)
})
