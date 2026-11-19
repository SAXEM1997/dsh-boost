import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeHost } from './fakes/host.ts'
import { PLACEHOLDER_TEXT, registerHooks } from '../src/hooks/post-execute.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { DEFAULT_SCOPE } from '../src/scope/doc.ts'
import { SELECTOR_PURPOSE } from '../src/selector/jev.ts'

const setup = (over: any = {}) => {
  const host = fakeHost()
  const deps = {
    config: DEFAULT_CONFIG,
    scope: over.scope ?? { read: async () => ({ doc: { ...DEFAULT_SCOPE, mode: 'global' } }) },
    receipts: { append: async (r: any) => { host.receipts.push(r) } },
  }
  registerHooks(host, deps as any)
  return { host, deps }
}

test('registerHooks 真的注册了四个挂载点（R4）', () => {
  const { host } = setup()
  assert.deepEqual(host.hooked().sort(), ['llm/stream', 'systemPrompt', 'tools/execute', 'tools/post-execute'])
  const s = host.section('dsh-boost')
  assert.equal(s.order, 100)
  assert.equal(s.interpolate, false)
})

test('llm/stream 见到 selector 标记直接放行（不合成回合）', async () => {
  const { host } = setup()
  const opts = { purpose: SELECTOR_PURPOSE, messages: [] }
  const out = await host.callHook('llm/stream', [opts], async () => 'PASSTHROUGH')
  assert.equal(out, 'PASSTHROUGH')
})

test('post-execute 对未配置族原样返回', async () => {
  const { host } = setup()
  const res = await host.callHook('tools/post-execute', [{ name: 'web_fetch', agent: undefined }, { content: [{ type: 'text', text: 'x'.repeat(5000) }] }], async () => ({ kind: 'accept' }))
  assert.equal(res.kind, 'accept')
})

test('缺 agent 时不投影，记 skip:no-scope', async () => {
  const { host } = setup()
  await host.callHook('tools/post-execute', [{ name: 'read', agent: undefined }, { content: [{ type: 'text', text: 'x'.repeat(5000) }] }], async () => ({ kind: 'accept' }))
  assert.ok(host.receipts.some((r: any) => r.code === 'skip:no-scope'))
})

test('协议段 text 必须是函数，并按 scope 里的 session id 读 judgement（R3/R7）', () => {
  const calls: string[] = []
  const { host } = setup({
    scope: {
      judgement: (key: string) => {
        calls.push(key)
        return true
      },
    },
  })
  const s = host.section('dsh-boost')
  assert.equal(typeof s.text, 'function')
  // 宿主把组装上下文构造成 { agent, scope: agent, signal }，所以 scope 就是 agent。
  const out = s.text({ scope: { session: { header: { id: 's1', cwd: '/w' } } } })
  assert.equal(out, PLACEHOLDER_TEXT)
  assert.deepEqual(calls, ['s1'])
})

test('judgement 为假或键不可解析时协议段为空，不回落到无参 judgement（R3/R7）', () => {
  const calls: string[] = []
  const { host } = setup({
    scope: {
      judgement: (key: string) => {
        calls.push(key)
        return false
      },
    },
  })
  const text = host.section('dsh-boost').text
  assert.equal(typeof text, 'function')
  assert.equal(text({ scope: { session: { header: { id: 's1', cwd: '/w' } } } }), '')
  assert.deepEqual(calls, ['s1'])

  calls.length = 0
  assert.equal(text({ scope: undefined }), '')
  assert.equal(text({}), '')
  assert.deepEqual(calls, [])
})

test('tools/execute 是直通占位，结果原样穿过（T18 换防篡改）', async () => {
  const { host } = setup()
  const out = await host.callHook(
    'tools/execute',
    [{ name: 'read', arguments: { path: '/a' } }],
    async () => 'DISPATCHED',
  )
  assert.equal(out, 'DISPATCHED')
})

test('llm/stream 对非 selector 请求也透传给 next()（R5）', async () => {
  const { host } = setup()
  let calls = 0
  const out = await host.callHook(
    'llm/stream',
    [{ messages: [], sessionId: 's1' }],
    async () => {
      calls += 1
      return 'REAL-TURN'
    },
  )
  assert.equal(out, 'REAL-TURN')
  assert.equal(calls, 1)
})

test('有 agent 时不写 skip 收据，下游 decision 原样返回', async () => {
  const { host } = setup()
  const decision = { kind: 'accept', content: [{ type: 'text', text: 'downstream' }] }
  const exec = { name: 'read', agent: { session: { header: { id: 's1', cwd: '/w' } } } }
  const res = await host.callHook(
    'tools/post-execute',
    [exec, { content: [{ type: 'text', text: 'x'.repeat(5000) }] }],
    async () => decision,
  )
  assert.equal(res, decision)
  assert.equal(host.receipts.length, 0)
})

test('scope/receipts 缺失时 registerHooks 不抛错，四个挂载点仍在（R5）', async () => {
  const host = fakeHost()
  assert.doesNotThrow(() => registerHooks(host, { config: DEFAULT_CONFIG } as any))
  assert.deepEqual(host.hooked().sort(), ['llm/stream', 'systemPrompt', 'tools/execute', 'tools/post-execute'])
  const s = host.section('dsh-boost')
  assert.equal(s.text({ scope: { session: { header: { id: 's1', cwd: '/w' } } } }), '')

  const res = await host.callHook(
    'tools/post-execute',
    [{ name: 'read', agent: undefined }, { content: [] }],
    async () => ({ kind: 'accept' }),
  )
  assert.equal(res.kind, 'accept')
})
