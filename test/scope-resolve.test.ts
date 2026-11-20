import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceIdOf, resolveVisible, resolveWorkspace } from '../src/scope/resolve.ts'
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

test('尾斜杠不做归一化：/w/a 不匹配 /w/a/', () => {
  const trailing = { list: () => [{ id: 'ws-uuid-1', path: '/w/a/' }] }
  assert.equal(workspaceIdOf({ session: { header: { cwd: '/w/a' } } }, trailing), undefined)
  assert.equal(workspaceIdOf({ session: { header: { cwd: '/w/a/' } } }, registry), undefined)
})

test('注册路径重复时取第一个匹配', () => {
  const duplicate = {
    list: () => [
      { id: 'first', path: '/w/a' },
      { id: 'second', path: '/w/a' },
    ],
  }
  assert.equal(workspaceIdOf({ session: { header: { cwd: '/w/a' } } }, duplicate), 'first')
})

test('非字符串 cwd 不参与匹配，即使注册表里是同一个非字符串 path', () => {
  const numeric = { list: () => [{ id: 'numeric', path: 42 }] as any }
  assert.equal(workspaceIdOf({ session: { header: { cwd: 42 as any } } }, numeric), undefined)
})

test('workspaceIdOf 对非数组 / 抛错的 list() 也保持全域、不抛错', () => {
  const agent = { session: { header: { cwd: '/w/a' } } }
  assert.equal(workspaceIdOf(agent, { list: () => undefined as any }), undefined)
  assert.equal(
    workspaceIdOf(agent, {
      list: () => {
        throw new Error('registry down')
      },
    }),
    undefined,
  )
  const malformed = { list: () => [null, { id: 'ok', path: '/w/a' }] as any }
  assert.equal(workspaceIdOf(agent, malformed), 'ok')
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

test('不再声明 supportsStepWhen 能力（finding 1：恒真的声明已删除）', async () => {
  // The old probe tested `typeof register === 'function'`, which every host
  // since 0.2.2-rc.1 satisfies, so the claim could never be false and the
  // ERR_HOST_NO_STEP_WHEN branch was dead. The tool registers with a
  // constant-true `when`, so no capability check is needed at all.
  const module = await import('../src/scope/resolve.ts')
  assert.equal('supportsStepWhen' in module, false)
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

test('降级读按 false 缓存，但下一次解析自愈（派发 Minor）', async () => {
  const dir = await scopeDir()
  const s = new ScopeStore(dir) // 没有 scope.json：read() 走降级分支
  const agent = { session: { header: { id: 's1', cwd: '/w/a' } } }
  assert.equal(await resolveVisible(s, agent, registry), false)
  assert.equal(s.judgement('s1', true), false)

  await s.write(d => ({ ...d, mode: 'global' }), 0)
  assert.equal(await resolveVisible(s, agent, registry), true)
  assert.equal(s.judgement('s1'), true)
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

test('fakeHost().visible 按注册的 when 判定；registered() 区分未注册与不可见', async () => {
  const host = fakeHost()
  const agent = { session: { header: { id: 's1', cwd: '/w/a' } } }
  assert.equal(host.registered('read'), false)
  assert.equal(await host.visible('read', agent), false)

  host.register(
    { name: 'read' },
    {
      when: (c: { agent: typeof agent; signal: AbortSignal }) =>
        c.agent === agent && c.signal instanceof AbortSignal,
    },
  )
  assert.equal(host.registered('read'), true)
  assert.equal(await host.visible('read', agent), true)
  assert.equal(
    await host.visible('read', { session: { header: { id: 'other', cwd: '/w/b' } } }),
    false,
  )

  host.register({ name: 'always' })
  assert.equal(await host.visible('always', agent), true)
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
  assert.equal(typeof host.on, 'function')
  assert.equal(typeof host.registered, 'function')
  assert.deepEqual(host.spillStore.saved, [])
  assert.deepEqual(host.receipts, [])
  assert.deepEqual(host.hooked(), [])
  assert.equal(host.section('missing'), undefined)
  assert.equal(host.nextCalls, 0)
  assert.equal(host.synthesized, 0)
  assert.equal(host.lastStream(), undefined)

  const chunks = host.stream('s1', {})
  assert.equal(typeof chunks[Symbol.asyncIterator], 'function')
  assert.equal(host.lastStream(), chunks)
  // 没有监听器时直通 llm.stream：终态 next 是惰性的，只有被消费才算一次模型请求。
  assert.equal(host.nextCalls, 0)
  for await (const _chunk of chunks) {
    // drain: the upstream is lazy, exactly like the real host's async generator
  }
  assert.equal(host.nextCalls, 1)
  assert.equal(host.synthesized, 0)
})

test('fakeHost 的 section 拒绝重名、返回 disposer，section() 跟踪最后一次注册', () => {
  const host = fakeHost()
  const section = {
    name: 'dsh-boost',
    order: 100,
    text: (c: any) => String(c ?? ''),
    interpolate: false,
  }
  const dispose = host.systemPrompt.section(section)
  assert.equal(host.section('dsh-boost'), section)
  assert.equal(host.section(), section)
  assert.deepEqual(host.hooked(), ['systemPrompt'])
  assert.throws(() => host.systemPrompt.section({ ...section }), /already registered/)

  const second = { name: 'second', order: 101, text: () => '' }
  const disposeSecond = host.systemPrompt.section(second)
  assert.equal(host.section(), second)
  disposeSecond()
  assert.equal(host.section(), section)
  assert.equal(host.section('second'), undefined)
  dispose()
  assert.equal(host.section(), undefined)
  assert.deepEqual(host.hooked(), [])
})

test('fakeHost 的 callHook 遵守真实瀑布：参数固定、next() 无参、返回值可变换', async () => {
  const host = fakeHost()
  const seen: string[] = []
  host.on('tools/post-execute', async (_args: any, next: any) => {
    seen.push('first')
    const downstream = await next()
    return { ...downstream, wrapped: true }
  })
  host.on('tools/post-execute', async (args: any, next: any) => {
    seen.push('second')
    // 后一个监听器拿到的是原始事件参数，不是 undefined。
    assert.deepEqual(args, { name: 'read' })
    return next()
  })

  const out = await host.callHook(
    'tools/post-execute',
    [{ name: 'read' }],
    async () => ({ kind: 'accept' }),
  )
  assert.deepEqual(out, { kind: 'accept', wrapped: true })
  assert.deepEqual(seen, ['first', 'second'])
  assert.equal(host.nextCalls, 1)
  assert.deepEqual(host.hooked(), ['tools/post-execute'])
})

test('fakeHost().stream 走 llm/stream 瀑布，不调 next 的监听器算合成回合并计数', async () => {
  const host = fakeHost()
  const canned = (async function* () {
    yield { type: 'tool-call-delta', name: 'read', argumentsDelta: '{"path":"/a"}' }
  })()
  let request: any
  host.on('llm/stream', (options: any) => {
    request = options
    return canned
  })

  const chunks: any[] = []
  for await (const chunk of host.stream('s1', { messages: [] })) chunks.push(chunk)

  // 驱动器把 sessionId 合进 options，监听器拿到的是完整请求。
  assert.deepEqual(request, { messages: [], sessionId: 's1' })
  // lastStream() 看到的是 hook 返回的合成回合，不是空流。
  assert.deepEqual(chunks, [
    { type: 'tool-call-delta', name: 'read', argumentsDelta: '{"path":"/a"}' },
  ])
  assert.equal(host.nextCalls, 0)
  assert.equal(host.synthesized, 1)
})

test('fakeHost().stream 无监听器时直通 llm.stream，next 计一次、不记合成', async () => {
  const host = fakeHost()
  const chunks: any[] = []
  for await (const chunk of host.stream('s1')) chunks.push(chunk)
  assert.deepEqual(chunks, [])
  assert.equal(host.nextCalls, 1)
  assert.equal(host.synthesized, 0)
})

test('fakeHost().stream 有监听器但调 next() 时直通，不记合成', async () => {
  const host = fakeHost()
  let seen = 0
  host.on('llm/stream', (_options: any, next: () => any) => {
    seen += 1
    return next()
  })
  const chunks: any[] = []
  for await (const chunk of host.stream('s1')) chunks.push(chunk)
  assert.equal(seen, 1)
  assert.deepEqual(chunks, [])
  assert.equal(host.nextCalls, 1)
  assert.equal(host.synthesized, 0)
})

test('fakeHost().spillStore.saveText 记录 owner/source 并返回真实字节数', async () => {
  const host = fakeHost()
  const input = {
    owner: { sessionId: 's1' },
    source: { kind: 'tool', toolName: 'read', callId: 'call-1', label: 'read /a' },
    suggestedName: 'read.txt',
    content: 'héllo',
  }
  const ref = await host.spillStore.saveText(input)
  assert.deepEqual(host.spillStore.saved, [input])
  assert.equal(ref.bytes, Buffer.byteLength('héllo', 'utf8'))
  assert.match(ref.locator, /\/spill\/read\.txt$/)
})

// ---------------------------------------------------------------------------
// I5: the cwd is only guaranteed absolute; the workspace path is canonical.
// ---------------------------------------------------------------------------

test('I5: resolveByPath canonicalises a symlinked or trailing-slash cwd', async () => {
  const dir = await scopeDir()
  const s = new ScopeStore(dir)
  await s.write(d => ({ ...d, mode: 'global' }), 0)
  const calls: string[] = []
  const canonical = {
    list: () => [{ id: 'ws-uuid-1', path: '/real/w/a' }],
    resolveByPath: async (path: string) => {
      calls.push(path)
      return path.replace(/\/+$/, '') === '/w/link' ? { id: 'ws-uuid-1' } : undefined
    },
  }
  const agent = { session: { header: { id: 's1', cwd: '/w/link/' } } }

  assert.equal(await resolveVisible(s, agent, canonical), true)
  assert.deepEqual(calls, ['/w/link/'])
  assert.equal(s.judgement('s1'), true)
})

test('I5: resolveWorkspace reports the resolved id next to visibility', async () => {
  const dir = await scopeDir()
  const s = new ScopeStore(dir)
  await s.write(d => ({ ...d, mode: 'selected', workspaceIds: ['ws-uuid-1'] }), 0)
  const canonical = {
    list: () => [{ id: 'ws-uuid-1', path: '/real/w/a' }],
    resolveByPath: async () => ({ id: 'ws-uuid-1' }),
  }
  const agent = { session: { header: { id: 's1', cwd: '/w/link' } } }

  assert.deepEqual(await resolveWorkspace(s, agent, canonical), {
    visible: true,
    workspaceId: 'ws-uuid-1',
  })
})

test('I5: a throwing resolveByPath fails closed instead of crashing or falling back', async () => {
  const dir = await scopeDir()
  const s = new ScopeStore(dir)
  await s.write(d => ({ ...d, mode: 'global' }), 0)
  const broken = {
    list: () => [{ id: 'ws-uuid-1', path: '/w/a' }],
    resolveByPath: async () => {
      throw new Error('canonicalise failed')
    },
  }
  const agent = { session: { header: { id: 's1', cwd: '/w/a' } } }

  assert.equal(await resolveVisible(s, agent, broken), false)
  assert.equal(s.judgement('s1', true), false)
})

test('I5: a registry without resolveByPath keeps the exact-match fallback', async () => {
  const dir = await scopeDir()
  const s = new ScopeStore(dir)
  await s.write(d => ({ ...d, mode: 'global' }), 0)
  const exactOnly = { list: () => [{ id: 'ws-uuid-1', path: '/w/a' }] }
  assert.equal(
    await resolveVisible(s, { session: { header: { id: 's1', cwd: '/w/a' } } }, exactOnly),
    true,
  )
})
