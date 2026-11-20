import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../src/index.ts'
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
