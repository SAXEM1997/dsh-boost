import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../src/index.ts'
import { resolveBoostRoot } from '../src/host/root.ts'
import { ReceiptStore } from '../src/receipts/store.ts'
import { ScopeStore } from '../src/scope/store.ts'
import { fakeHost } from './fakes/host.ts'
import type { PluginContext } from '../src/types.ts'

test('插件导出 cordis 需要的元数据', () => {
  assert.equal(plugin.name, 'dsh-boost')
  // `llm` is deliberately absent: projection and admission need no LLM, and a
  // hard injection would leave the whole plugin pending on a composition
  // without the model runtime. The selector resolves it lazily and fails
  // closed with `selector-unavailable` (finding 6).
  assert.deepEqual([...plugin.inject], ['tools', 'systemPrompt'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply 接受 ctx 与 config 两个参数', () => {
  assert.equal(plugin.apply.length, 2)
})

test('patch 行的 id/name 与 plugin.name、包名三者一致（R50）', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const yml = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const rowId = yml.match(/^\s*-\s*id:\s*['"]?([^'"\s]+?)['"]?\s*$/m)?.[1]
  const rowName = yml.match(/^\s*name:\s*['"]?([^'"\s]+?)['"]?\s*$/m)?.[1]
  assert.equal(plugin.name, 'dsh-boost')
  assert.equal(pkg.name, plugin.name)
  assert.equal(rowId, plugin.name)
  assert.equal(rowName, plugin.name)
})

test('apply 用假 ctx 调用不抛错，并记录解析后的步数预算（T1 补测）', () => {
  const messages: string[] = []
  const ctx = {
    logger: {
      info: (msg: string) => messages.push(msg),
      warn: () => {},
    },
  } as unknown as PluginContext

  assert.doesNotThrow(() => plugin.apply(ctx, { stepsPerTurn: 4 }))
  assert.ok(
    messages.some((msg) => msg.includes('stepsPerTurn=4')),
    `missing resolved step budget in logs: ${JSON.stringify(messages)}`,
  )
})

test('apply 从 $DSH_HOME 装配挂载点与会话事件（R4 + G3）', () => {
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = join(tmpdir(), 'dsh-boost-apply')
  try {
    const host = fakeHost({
      get: () => {
        throw new Error('ctx.get must not be used to resolve the data root')
      },
    })

    assert.doesNotThrow(() => plugin.apply(host as unknown as PluginContext, {}))
    assert.deepEqual(host.hooked().sort(), [
      'agent/pre-step',
      'agent/request',
      'llm/stream',
      'session/disposed',
      'session/event',
      'session/flush',
      'system-prompt/assemble',
      'systemPrompt',
      'tools/execute',
      'tools/post-execute',
    ])
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('apply 重复调用不重复挂载（重复 section 视为已装配）', () => {
  const host = fakeHost()
  plugin.apply(host as unknown as PluginContext, {})
  plugin.apply(host as unknown as PluginContext, {})
  assert.equal(host.hookCount('tools/post-execute'), 1)
  // Two llm/stream listeners: the frozen stream hook plus the deprecated-event
  // drift detector, which only watches and passes through.
  assert.equal(host.hookCount('llm/stream'), 2)
  assert.equal(host.hookCount('tools/execute'), 1)
  assert.equal(host.section('dsh-boost')?.name, 'dsh-boost')
  assert.equal(host.tools.definitions.length, 1)
})

test('apply 在 tools.resolve 存在时注册 boost 工具，when 豁免 scope', async () => {
  const host = fakeHost()
  plugin.apply(host as unknown as PluginContext, {})
  assert.equal(host.tools.definitions.length, 1)
  const def = host.tools.definitions[0].def
  assert.equal(def.name, 'boost')
  assert.equal(typeof def.output.render, 'function')
  assert.equal(typeof def.execute, 'function')

  // The boost tool is the enable entry point: even an agent whose workspace is
  // not in the scope document must still see it.
  assert.equal(
    await host.visible('boost', { session: { header: { id: 's1', cwd: '/not-in-scope' } } }),
    true,
  )
})

test('没有 tools.register 时告警的是工具注册失败，不是已删除的 STEP_WHEN 声明', () => {
  const warnings: string[] = []
  const host = fakeHost()
  host.logger = { info: () => {}, warn: (msg: string) => warnings.push(msg) }
  host.tools = {
    register: undefined,
    resolve: () => [],
  }

  assert.doesNotThrow(() => plugin.apply(host as unknown as PluginContext, {}))
  assert.equal(host.tools.definitions?.length ?? 0, 0)
  assert.ok(
    warnings.some(msg => msg.includes('ERR_BOOST_TOOL_REGISTER_FAILED')),
    JSON.stringify(warnings),
  )
  assert.equal(warnings.includes('ERR_HOST_NO_STEP_WHEN'), false, JSON.stringify(warnings))
})

test('有 tools.register、没有 tools.resolve 时 boost 工具仍注册（row 44）', () => {
  const warnings: string[] = []
  const host = fakeHost()
  host.logger = { info: () => {}, warn: (msg: string) => warnings.push(msg) }
  host.tools.resolve = undefined

  plugin.apply(host as unknown as PluginContext, {})
  assert.equal(host.tools.definitions.length, 1)
  assert.equal(host.tools.definitions[0].def.name, 'boost')
  assert.equal(warnings.includes('ERR_HOST_NO_STEP_WHEN'), false, JSON.stringify(warnings))
})

test('apply 从 config.dshHome 装配数据根（row 75）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-home-'))
  const envDir = await mkdtemp(join(tmpdir(), 'dsh-boost-env-'))
  t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(envDir, { recursive: true, force: true })]))
  await mkdir(join(dir, 'boost'), { recursive: true })
  await writeFile(
    join(dir, 'boost', 'scope.json'),
    JSON.stringify({ version: 2, revision: 7, mode: 'selected', workspaceIds: [], shadow: true, projection: 'shadow' }),
  )

  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = envDir
  t.after(() => {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  })

  const host = fakeHost()
  plugin.apply(host as unknown as PluginContext, { dshHome: dir })
  const registration = host.tools.definitions.find((entry: any) => entry.def?.name === 'boost')
  assert.ok(registration)
  const result = await registration.def.execute({ cmd: 'status' }, {})
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.data.scope.revision, 7)
})

test('真正的重复 section 才按已挂载处理，且不重复注册（row 46 / finding 8）', () => {
  const host = fakeHost()
  plugin.apply(host as unknown as PluginContext, {})
  const sectionBefore = host.section('dsh-boost')
  const postExecuteBefore = host.hookCount('tools/post-execute')

  const warnings: string[] = []
  host.logger = { info: () => {}, warn: (msg: string) => warnings.push(msg) }
  // The host exposes no duplicate code, so the plain Error's message is the
  // only evidence: it names our section and says it is already registered.
  host.systemPrompt.section = () => {
    throw new Error(
      'prompt section "dsh-boost" is already registered (for a per-agent override, register through that agent\'s `agent.ctx` instead)',
    )
  }

  assert.doesNotThrow(() => plugin.apply(host as unknown as PluginContext, {}))
  assert.equal(host.section('dsh-boost'), sectionBefore)
  assert.equal(host.hookCount('tools/post-execute'), postExecuteBefore)
  assert.equal(host.tools.definitions.length, 1)
  assert.ok(
    warnings.some(msg => msg.includes('ERR_BOOST_ALREADY_MOUNTED')),
    JSON.stringify(warnings),
  )
})

test('非重复的 section 注册错误：独立码 + 原始错误，boost 工具仍然挂载（finding 8）', () => {
  const warnings: string[] = []
  const host = fakeHost()
  host.logger = { info: () => {}, warn: (msg: string) => warnings.push(msg) }
  host.systemPrompt.section = () => {
    throw new Error('EACCES: the prompt registry is read-only')
  }

  assert.doesNotThrow(() => plugin.apply(host as unknown as PluginContext, {}))
  assert.ok(
    warnings.some(msg => msg.includes('ERR_BOOST_SECTION_REGISTER_FAILED')),
    JSON.stringify(warnings),
  )
  assert.ok(
    warnings.some(msg => msg.includes('EACCES: the prompt registry is read-only')),
    'the raw error must be logged, not swallowed',
  )
  assert.equal(
    warnings.some(msg => msg.includes('ERR_BOOST_ALREADY_MOUNTED')),
    false,
    'a non-duplicate must not be misdiagnosed as a duplicate mount',
  )
  // The control tool is the user's only way out: it must still register.
  assert.equal(host.tools.definitions.length, 1)
  assert.equal(host.tools.definitions[0].def.name, 'boost')
})

test('tools.register 抛错时独立告警带稳定码，不冒充 hook 注册失败', () => {
  const warnings: string[] = []
  const host = fakeHost()
  host.logger = { info: () => {}, warn: (msg: string) => warnings.push(msg) }
  host.tools.register = () => {
    throw new Error('duplicate tool name')
  }

  assert.doesNotThrow(() => plugin.apply(host as unknown as PluginContext, {}))
  assert.ok(
    warnings.some(msg => msg.includes('ERR_BOOST_TOOL_REGISTER_FAILED')),
    JSON.stringify(warnings),
  )
  assert.equal(
    warnings.some(msg => msg.includes('hook registration skipped')),
    false,
    JSON.stringify(warnings),
  )
})

// ---------------------------------------------------------------------------
// Finding 3: the verified host line is declared and checked at runtime.
// ---------------------------------------------------------------------------

test('engines.dsh pins the verified host line, not an unverified range', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.engines.dsh, '0.2.2-rc.4')
})

test('apply 记录解析到的宿主版本，匹配时只记 info', () => {
  const infos: string[] = []
  const warnings: string[] = []
  const host = fakeHost({
    get: (name: string) =>
      name === 'pluginPackages'
        ? { packageOf: () => ({ name: '@deepseek-ai/dsh-app-boot', version: '0.2.2-rc.4' }) }
        : undefined,
    logger: { info: (msg: string) => infos.push(msg), warn: (msg: string) => warnings.push(msg) },
  })

  plugin.apply(host as unknown as PluginContext, {})
  assert.ok(
    infos.some(msg => msg.includes('0.2.2-rc.4')),
    JSON.stringify(infos),
  )
  assert.equal(
    warnings.some(msg => msg.includes('ERR_HOST_VERSION_MISMATCH')),
    false,
    JSON.stringify(warnings),
  )
})

test('apply 在未验证的宿主版本上告警 ERR_HOST_VERSION_MISMATCH，但不失败', () => {
  const infos: string[] = []
  const warnings: string[] = []
  const host = fakeHost({
    get: (name: string) =>
      name === 'pluginPackages'
        ? { packageOf: () => ({ name: '@deepseek-ai/dsh-app-boot', version: '0.2.2-rc.5' }) }
        : undefined,
    logger: { info: (msg: string) => infos.push(msg), warn: (msg: string) => warnings.push(msg) },
  })

  assert.doesNotThrow(() => plugin.apply(host as unknown as PluginContext, {}))
  assert.ok(
    warnings.some(
      msg => msg.includes('ERR_HOST_VERSION_MISMATCH') && msg.includes('0.2.2-rc.5'),
    ),
    JSON.stringify(warnings),
  )
  // A warning, not a hard failure: the mounts still exist.
  assert.equal(host.hookCount('tools/post-execute'), 1)
  assert.equal(host.tools.definitions.length, 1)
})

// ---------------------------------------------------------------------------
// Round 3: auxiliary streams, partial mounts, home expansion, spill health.
// ---------------------------------------------------------------------------

/** A registry that resolves the test agent's cwd to one workspace. */
const TEST_REGISTRY = {
  list: () => [{ id: 'ws-1', path: '/real/w/a' }],
  resolveByPath: async (path: string) =>
    path.replace(/\/+$/, '') === '/real/w/a' ? { id: 'ws-1' } : undefined,
}

/** Apply the plugin against a fake host with a mutable soft-service map. */
async function appliedHost(
  t: TestContext,
  options: {
    services?: Map<string, unknown>
    beforeApply?: (host: any) => void
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-boost-load-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const services = options.services ?? new Map<string, unknown>()
  const warnings: string[] = []
  const infos: string[] = []
  const host = fakeHost({
    get: (name: string) => services.get(name),
    logger: {
      info: (message: string) => infos.push(message),
      warn: (message: string) => warnings.push(message),
    },
  })
  options.beforeApply?.(host)
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    plugin.apply(host as unknown as PluginContext, {})
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
  return { host, home, root: join(home, 'boost'), services, warnings, infos }
}

/** Run the registered `boost status` and return its data. */
async function statusOf(host: any): Promise<any> {
  const registration = host.tools.definitions.find((entry: any) => entry.def?.name === 'boost')
  assert.ok(registration, 'boost tool must be registered')
  const result = await registration.def.execute({ cmd: 'status' }, {})
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.data
}

/** Codes of every receipt in one session's shard. */
async function receiptCodes(root: string, sessionId: string): Promise<string[]> {
  const codes: string[] = []
  for await (const receipt of new ReceiptStore(root).scan(sessionId)) codes.push(receipt.code)
  return codes
}

/** The agent shape the hooks read. */
type TestAgent = { session: { header: { id: string; cwd: string } } }

/** Warm the visibility cache the way the host does: assemble before the step. */
async function assembleWarm(host: any, agent: TestAgent): Promise<void> {
  const assembly = { sections: [], contexts: [], variables: {} }
  await host.callHook('system-prompt/assemble', [assembly, { agent, scope: agent }], () => assembly)
}

test('row 1: purpose 标记的辅助流不是 complete-section 证据', async (t) => {
  const services = new Map<string, unknown>([['workspaceRegistry', TEST_REGISTRY]])
  const app = await appliedHost(t, { services })
  await new ScopeStore(app.root).write(doc => ({ ...doc, mode: 'global' }), 0)
  const agent: TestAgent = { session: { header: { id: 's1', cwd: '/real/w/a' } } }
  await assembleWarm(app.host, agent)

  // The session-title provider sends its own system prompt, which never carries
  // <CHISEL_PLAN>; treating it as a swallow would poison the process counters
  // and disable the session's visibility for the rest of the step.
  app.host.stream('s1', {
    purpose: 'session-title',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'write a title' }] }],
  })

  let status = await statusOf(app.host)
  assert.equal(status.protocol_suppressed, 0)
  assert.equal(status.degraded.includes('ERR_HOST_COMPLETE_SECTION'), false)
  assert.equal(
    app.warnings.some(message => message.includes('ERR_HOST_COMPLETE_SECTION')),
    false,
    JSON.stringify(app.warnings),
  )
  assert.equal(status.degraded.includes('ERR_BOOST_PARTIAL_MOUNT'), false)

  // The probe still runs for a real request. Detecting this one also proves the
  // auxiliary request did not flip the session's visibility off: a flipped
  // judgement would have skipped the probe entirely.
  app.host.stream('s1', {
    messages: [{ role: 'system', content: [{ type: 'text', text: 'persona only' }] }],
  })
  status = await statusOf(app.host)
  assert.equal(status.protocol_suppressed, 1)
  assert.ok(status.degraded.includes('ERR_HOST_COMPLETE_SECTION'), JSON.stringify(status.degraded))
  assert.ok(app.warnings.some(message => message.includes('ERR_HOST_COMPLETE_SECTION')))
})

test('row 2: 非重复 section 失败后其余三个挂载仍挂上，并报 ERR_BOOST_PARTIAL_MOUNT', async (t) => {
  const app = await appliedHost(t, {
    beforeApply: (host) => {
      host.systemPrompt.section = () => {
        throw new Error('EACCES: the prompt registry is read-only')
      }
    },
  })

  // `registerHooks` aborts at the section mount; the three event mounts must
  // not silently disappear with it.
  assert.equal(app.host.hookCount('tools/post-execute'), 1)
  assert.equal(app.host.hookCount('llm/stream'), 2, 'synthesizer + drift detector')
  assert.equal(app.host.hookCount('tools/execute'), 1)
  assert.ok(app.warnings.some(message => message.includes('ERR_BOOST_SECTION_REGISTER_FAILED')))
  assert.ok(app.warnings.some(message => message.includes('ERR_BOOST_PARTIAL_MOUNT')))

  const status = await statusOf(app.host)
  assert.ok(
    status.degraded.includes('ERR_BOOST_PARTIAL_MOUNT'),
    JSON.stringify(status.degraded),
  )
})

test('row 2: 一个事件挂载失败不拖累其余挂载，status 报 ERR_BOOST_PARTIAL_MOUNT', async (t) => {
  const app = await appliedHost(t, {
    beforeApply: (host) => {
      const on = host.on.bind(host)
      host.on = (name: string, handler: (...args: any[]) => unknown, options?: unknown) => {
        if (name === 'tools/post-execute') throw new Error('cordis: context is not active')
        return on(name, handler, options as never)
      }
    },
  })

  assert.equal(app.host.hookCount('tools/post-execute'), 0)
  assert.equal(app.host.hookCount('llm/stream'), 2)
  assert.equal(app.host.hookCount('tools/execute'), 1)
  assert.ok(app.warnings.some(message => message.includes('ERR_BOOST_PARTIAL_MOUNT')))

  const status = await statusOf(app.host)
  assert.ok(
    status.degraded.includes('ERR_BOOST_PARTIAL_MOUNT'),
    JSON.stringify(status.degraded),
  )
})

test('row 30: resolveBoostRoot 像宿主一样展开 ~（覆写与 env 都展开）', () => {
  const saved = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.equal(resolveBoostRoot({ dshHome: '~' }), join(homedir(), 'boost'))
    assert.equal(resolveBoostRoot({ dshHome: '~/x' }), join(homedir(), 'x', 'boost'))
    process.env.DSH_HOME = '~/env-x'
    assert.equal(resolveBoostRoot(), join(homedir(), 'env-x', 'boost'))
    assert.equal(resolveBoostRoot({ dshHome: '/abs/x' }), join('/abs/x', 'boost'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('row 31: 坏掉的 spill store 首次失败后会重新解析服务', async (t) => {
  const broken = {
    async saveText(): Promise<never> {
      throw new Error('EIO: the spill store is read-only')
    },
  }
  const healthy = {
    async saveText() {
      return { locator: '/spill/read.txt', bytes: 1, retrievalHint: 'read it' }
    },
  }
  const services = new Map<string, unknown>([
    ['workspaceRegistry', TEST_REGISTRY],
    ['tokenMeter', { estimateMessage: () => 7 }],
    ['spillStore', broken],
  ])
  const app = await appliedHost(t, { services })
  await new ScopeStore(app.root).write(
    doc => ({ ...doc, mode: 'global', projection: 'on', shadow: false }),
    0,
  )
  const agent: TestAgent = { session: { header: { id: 's1', cwd: '/real/w/a' } } }
  await assembleWarm(app.host, agent)

  const big = 'x'.repeat(5000)
  const exec = (callId: string) => ({
    name: 'read',
    callId,
    agent,
    arguments: { file_path: '/real/w/a/f' },
  })
  const result = { content: [{ type: 'text', text: big }] }

  await app.host.callHook('tools/post-execute', [exec('c1'), result], () => ({ kind: 'accept' }))
  let codes = await receiptCodes(app.root, 's1')
  assert.ok(codes.includes('projection-skipped:spill-failed'), JSON.stringify(codes))

  // Replace the provider before anything else reads it again; a memo that
  // trusted the first successful `ctx.get` forever would keep using the dead
  // backend and skip every later projection.
  services.set('spillStore', healthy)
  await app.host.callHook('tools/post-execute', [exec('c2'), result], () => ({ kind: 'accept' }))
  codes = await receiptCodes(app.root, 's1')
  assert.ok(codes.includes('projected'), JSON.stringify(codes))

  // The present-but-broken store must be visible even though `hasSpill` is
  // true: the failed write left `projection-skipped:spill-failed` behind.
  const status = await statusOf(app.host)
  assert.equal(status.counts.projected, 1)
  assert.ok(status.degraded.includes('ERR_HOST_NO_SPILL'), JSON.stringify(status.degraded))
})

test('row 34: build 元数据不触发 ERR_HOST_VERSION_MISMATCH', () => {
  const warnings: string[] = []
  const infos: string[] = []
  const host = fakeHost({
    get: (name: string) =>
      name === 'pluginPackages'
        ? {
            packageOf: () => ({
              name: '@deepseek-ai/dsh-app-boot',
              version: '0.2.2-rc.4+build.5',
            }),
          }
        : undefined,
    logger: {
      info: (message: string) => infos.push(message),
      warn: (message: string) => warnings.push(message),
    },
  })

  assert.doesNotThrow(() => plugin.apply(host as unknown as PluginContext, {}))
  assert.equal(
    warnings.some(message => message.includes('ERR_HOST_VERSION_MISMATCH')),
    false,
    JSON.stringify(warnings),
  )
  assert.ok(infos.some(message => message.includes('0.2.2-rc.4+build.5')), JSON.stringify(infos))
})

// ---------------------------------------------------------------------------
// Finding 7: the published entrypoint graph must not import host types.
// ---------------------------------------------------------------------------

test('公开 types 模块只含结构化宿主类型，模块增强留在发布图之外（finding 7）', async () => {
  const source = await readFile(new URL('../src/types.ts', import.meta.url), 'utf8')
  assert.equal(
    source.includes("from '@deepseek-ai/"),
    false,
    'src/types.ts is reachable from dist/index.d.ts; it must not import a host package',
  )
  assert.equal(
    source.includes('declare module'),
    false,
    'a module augmentation in src/types.ts leaks into the published declaration graph',
  )
  // The selector still needs the purpose key; it lives in an ambient input
  // file that tsc consumes but never emits.
  const augment = await readFile(new URL('../src/host-augment.d.ts', import.meta.url), 'utf8')
  assert.match(augment, /declare module '@deepseek-ai\/dsh-llm\/types'/)
})
