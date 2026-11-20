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
  assert.deepEqual([...plugin.inject], ['tools', 'llm', 'systemPrompt'])
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

test('没有 tools.register 时整族不注册并告警 ERR_HOST_NO_STEP_WHEN', () => {
  const warnings: string[] = []
  let registrations = 0
  const host = fakeHost()
  host.logger = { info: () => {}, warn: (msg: string) => warnings.push(msg) }
  host.tools = {
    register: undefined,
    resolve: () => [],
  }

  assert.doesNotThrow(() => plugin.apply(host as unknown as PluginContext, {}))
  assert.equal(registrations, 0)
  assert.ok(warnings.includes('ERR_HOST_NO_STEP_WHEN'), JSON.stringify(warnings))
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

test('重复 apply 按已挂载处理：错误措辞变化也不重复注册（row 46）', () => {
  const host = fakeHost()
  plugin.apply(host as unknown as PluginContext, {})
  const sectionBefore = host.section('dsh-boost')
  const postExecuteBefore = host.hookCount('tools/post-execute')

  const warnings: string[] = []
  host.logger = { info: () => {}, warn: (msg: string) => warnings.push(msg) }
  // The host exposes no duplicate code; a reworded message must not turn the
  // second apply into a fresh mount or into a generic wiring failure.
  host.systemPrompt.section = () => {
    throw new Error('E_DUPLICATE_MOUNT: prompt slot taken')
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
