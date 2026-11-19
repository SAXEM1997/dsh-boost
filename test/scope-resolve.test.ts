import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceIdOf, resolveVisible, supportsStepWhen } from '../src/scope/resolve.ts'
import { ScopeStore } from '../src/scope/store.ts'
import { fakeHost } from './fakes/host.ts'

const registry = { list: () => [{ id: 'ws-uuid-1', path: '/w/a' }] }

const scopeDir = () => mkdtemp(join(tmpdir(), 'scope-'))

test('cwd 经 registry 映射到 workspace UUID，不是路径本身（R10）', () => {
  assert.equal(workspaceIdOf({ session: { header: { cwd: '/w/a' } } }, registry), 'ws-uuid-1')
  assert.equal(workspaceIdOf({ session: { header: { cwd: '/w/b' } } }, registry), undefined)
  assert.equal(workspaceIdOf(undefined, registry), undefined)
  assert.equal(workspaceIdOf({ session: { header: { cwd: '/w/a' } } }, undefined), undefined)
})

test('cwd 与注册 path 必须完全相等：/w/a 不匹配 /w/ab', () => {
  assert.equal(workspaceIdOf({ session: { header: { cwd: '/w/ab' } } }, registry), undefined)
})

test('缺 session / 缺 cwd 时没有 workspace id', () => {
  assert.equal(workspaceIdOf({}, registry), undefined)
  assert.equal(workspaceIdOf({ session: {} }, registry), undefined)
  assert.equal(workspaceIdOf({ session: { header: {} } }, registry), undefined)
})

test('无 agent 一律不可见', async () => {
  const dir = await scopeDir()
  assert.equal(await resolveVisible(new ScopeStore(dir), undefined, registry), false)
})

test('global 模式下能解析出 UUID 即可见', async () => {
  const dir = await scopeDir()
  const s = new ScopeStore(dir)
  await s.write(d => ({ ...d, mode: 'global' }), 0)
  assert.equal(await resolveVisible(s, { session: { header: { cwd: '/w/a' } } }, registry), true)
})

test('宿主没有 tools.resolve 时判不支持步骤级 when', () => {
  assert.equal(supportsStepWhen({}), false)
  assert.equal(supportsStepWhen({ resolve: () => [] }), true)
})

test('supportsStepWhen 对 undefined / null / 非对象不抛错', () => {
  assert.equal(supportsStepWhen(undefined), false)
  assert.equal(supportsStepWhen(null), false)
  assert.equal(supportsStepWhen(42 as any), false)
  assert.equal(supportsStepWhen({ resolve: null }), false)
})

test('resolveVisible 返回前把结果写进 judgement 缓存（派发 R2）', async () => {
  const dir = await scopeDir()
  const s = new ScopeStore(dir)
  const agent = { session: { header: { id: 's1', cwd: '/w/a' } } }

  await s.write(d => ({ ...d, mode: 'global' }), 0)
  assert.equal(await resolveVisible(s, agent, registry), true)
  assert.equal(s.judgement('s1'), true)

  await s.write(d => ({ ...d, mode: 'selected', workspaceIds: [] }), 1)
  assert.equal(await resolveVisible(s, agent, registry), false)
  assert.equal(s.judgement('s1'), false)
})

test('不可见的结果也写入缓存，而不是留下旧值（派发 R2）', async () => {
  const dir = await scopeDir()
  const s = new ScopeStore(dir)
  const agent = { session: { header: { id: 's1', cwd: '/w/a' } } }
  assert.equal(await resolveVisible(s, agent, registry), false)
  // fallback=true 会被缓存的 false 覆盖，证明 remember 真的写入了。
  assert.equal(s.judgement('s1', true), false)
})

test('无 session.header.id 时解析可见性但不写缓存（派发 R3）', async () => {
  const dir = await scopeDir()
  const s = new ScopeStore(dir)
  await s.write(d => ({ ...d, mode: 'global' }), 0)
  let remembered = 0
  const write = s.remember.bind(s)
  s.remember = (key, visible) => {
    remembered++
    write(key, visible)
  }

  assert.equal(await resolveVisible(s, { session: { header: { cwd: '/w/a' } } }, registry), true)
  assert.equal(remembered, 0)
})

test('registry.list() 抛错时返回 false 且不抛（派发 R4）', async () => {
  const dir = await scopeDir()
  const s = new ScopeStore(dir)
  await s.write(d => ({ ...d, mode: 'global' }), 0)
  const throwing = {
    list: () => {
      throw new Error('registry down')
    },
  }
  assert.equal(
    await resolveVisible(s, { session: { header: { id: 's1', cwd: '/w/a' } } }, throwing),
    false,
  )
})

test('registry.list() 形状不对时返回 false 且不抛（派发 R4）', async () => {
  const dir = await scopeDir()
  const s = new ScopeStore(dir)
  await s.write(d => ({ ...d, mode: 'global' }), 0)
  const bad = { list: () => undefined as any }
  assert.equal(await resolveVisible(s, { session: { header: { id: 's1', cwd: '/w/a' } } }, bad), false)
})

// --- fakeHost ---

test('fakeHost 记录 register 的 def 与 when，resolve() 返回已注册定义（派发 R7）', () => {
  const host = fakeHost()
  const def = { name: 'read' }
  const when = () => true
  host.register(def, { when })
  assert.deepEqual(host.definitions, [{ def, when }])
  assert.deepEqual(host.resolve(), [def])
})

test('fakeHost().visible 按注册的 when 判定，未注册时不可见', async () => {
  const host = fakeHost()
  const agent = { session: { header: { id: 's1', cwd: '/w/a' } } }
  assert.equal(await host.visible('read', agent), false)
  host.register({ name: 'read' }, { when: (c: { agent: typeof agent }) => c.agent === agent })
  assert.equal(await host.visible('read', agent), true)
})

test('fakeHost 暴露后续任务依赖的成员，未用到的保持最小诚实实现', async () => {
  const host = fakeHost()
  assert.equal(typeof host.register, 'function')
  assert.equal(typeof host.resolve, 'function')
  assert.ok(Array.isArray(host.definitions))
  assert.equal(typeof host.llm.stream, 'function')
  assert.equal(typeof host.systemPrompt.section, 'function')
  assert.ok('tokenMeter' in host)
  assert.equal(typeof host.spillStore.saveText, 'function')
  assert.equal(typeof host.callHook, 'function')
  assert.deepEqual(host.receipts, [])
  assert.deepEqual(host.hooked(), [])
  assert.equal(host.section('missing'), undefined)
  assert.equal(host.nextCalls, 0)
  assert.equal(host.synthesized, 0)
  assert.equal(host.lastStream(), undefined)

  const chunks = host.stream('s1', {})
  assert.equal(typeof chunks[Symbol.asyncIterator], 'function')
  assert.equal(host.lastStream(), chunks)
})

test('fakeHost 的 section/hooked 记录 systemPrompt 挂载点', () => {
  const host = fakeHost()
  const section = {
    name: 'dsh-boost',
    order: 100,
    text: (c: any) => String(c ?? ''),
    interpolate: false,
  }
  host.systemPrompt.section(section)
  assert.equal(host.section('dsh-boost'), section)
  assert.equal(host.section(), section)
  assert.deepEqual(host.hooked(), ['systemPrompt'])
})

test('fakeHost 的 callHook 按注册顺序串接瀑布，最后落到 next', async () => {
  const host = fakeHost()
  const seen: string[] = []
  host.on('tools/post-execute', async (args: any, next: any) => {
    seen.push('first')
    return next(args)
  })
  host.on('tools/post-execute', async (args: any, next: any) => {
    seen.push('second')
    return next(args)
  })

  const out = await host.callHook('tools/post-execute', [{ name: 'read' }], async () => 'NEXT')
  assert.equal(out, 'NEXT')
  assert.deepEqual(seen, ['first', 'second'])
  assert.deepEqual(host.hooked(), ['tools/post-execute'])
})
