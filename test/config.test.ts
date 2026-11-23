import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, DEFAULT_CONFIG } from '../src/config.ts'

test('空配置等于默认值', () => {
  assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG)
  assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG)
})

test('逐键回落：只覆盖 read 的窗口，其余保持默认', () => {
  const c = resolveConfig({ projection: { read: { triggerChars: 5000 } } })
  assert.equal(c.projection.read.triggerChars, 5000)
  assert.equal(c.projection.read.headChars, 2000)
  assert.equal(c.projection.bash.triggerChars, 4000)
  assert.equal(c.stepsPerTurn, 8)
})

test('默认值逐字符合设计稿 §5.3', () => {
  assert.deepEqual(DEFAULT_CONFIG.projection.read, { triggerChars: 3000, headChars: 2000, tailChars: 500 })
  assert.deepEqual(DEFAULT_CONFIG.projection.grep, { triggerChars: 700, headChars: 400, tailChars: 100 })
  assert.deepEqual(DEFAULT_CONFIG.projection.glob, { triggerChars: 700, headChars: 400, tailChars: 100 })
  assert.deepEqual(DEFAULT_CONFIG.projection.bash, { triggerChars: 4000, headChars: 2000, tailChars: 500 })
  assert.deepEqual(DEFAULT_CONFIG.projection.ssh, { triggerChars: 2000, headChars: 1200, tailChars: 300 })
  assert.equal(DEFAULT_CONFIG.admission.thresholdTokens, 1024)
  assert.equal(DEFAULT_CONFIG.selector.maxTokens, 512)
  assert.equal(DEFAULT_CONFIG.horizonSteps, 20)
  assert.equal(DEFAULT_CONFIG.historyTurns, 5)
})

test('非对象输入回落默认值', () => {
  assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG)
  assert.deepEqual(resolveConfig('nope'), DEFAULT_CONFIG)
  assert.deepEqual(resolveConfig([]), DEFAULT_CONFIG)
})

test('畸形值与未知键逐键回落，不抛错', () => {
  const c = resolveConfig({
    projection: { read: { triggerChars: '5000', headChars: null } },
    admission: 'nope',
    selector: { maxTokens: 256, unknown: true },
    stepsPerTurn: Number.NaN,
    unknownTopLevel: { projection: { bash: { triggerChars: 1 } } },
  })
  assert.deepEqual(c.projection.read, { triggerChars: 3000, headChars: 2000, tailChars: 500 })
  assert.deepEqual(c.admission, { thresholdTokens: 1024 })
  assert.equal(c.selector.maxTokens, 256)
  assert.equal(c.stepsPerTurn, 8)
  assert.deepEqual(Object.keys(c), [
    'projection',
    'admission',
    'selector',
    'distillation',
    'stepsPerTurn',
    'horizonSteps',
    'historyTurns',
  ])
})

test('返回深拷贝：改写结果不污染 DEFAULT_CONFIG', () => {
  const c = resolveConfig(undefined)
  c.projection.read.triggerChars = 1
  c.admission.thresholdTokens = 2
  c.selector.maxTokens = 3
  assert.equal(DEFAULT_CONFIG.projection.read.triggerChars, 3000)
  assert.equal(DEFAULT_CONFIG.admission.thresholdTokens, 1024)
  assert.equal(DEFAULT_CONFIG.selector.maxTokens, 512)
})

// ---------------------------------------------------------------------------
// Minor: every key used to accept negative/fractional values silently.
// ---------------------------------------------------------------------------

test('负值被拒绝并逐键回退默认值，修复会被报告', () => {
  const repairs: string[] = []
  const c = resolveConfig(
    {
      projection: { read: { triggerChars: -1, headChars: Number.NaN, tailChars: -2 } },
      admission: { thresholdTokens: -5 },
      selector: { maxTokens: -1 },
      stepsPerTurn: -2,
      horizonSteps: -3,
      historyTurns: -4,
    },
    message => repairs.push(message),
  )
  assert.deepEqual(c.projection.read, DEFAULT_CONFIG.projection.read)
  assert.deepEqual(c.admission, DEFAULT_CONFIG.admission)
  assert.deepEqual(c.selector, DEFAULT_CONFIG.selector)
  assert.equal(c.stepsPerTurn, DEFAULT_CONFIG.stepsPerTurn)
  assert.equal(c.horizonSteps, DEFAULT_CONFIG.horizonSteps)
  assert.equal(c.historyTurns, DEFAULT_CONFIG.historyTurns)
  assert.ok(repairs.length >= 8, `expected a repair per rejected key: ${JSON.stringify(repairs)}`)
})

test('小数值向下取整而不是被静默保留', () => {
  const repairs: string[] = []
  const c = resolveConfig(
    {
      projection: { read: { triggerChars: 3000.9, headChars: 2000.8, tailChars: 500.7 } },
      stepsPerTurn: 4.9,
      historyTurns: 2.5,
      selector: { maxTokens: 512.9 },
    },
    message => repairs.push(message),
  )
  assert.deepEqual(c.projection.read, { triggerChars: 3000, headChars: 2000, tailChars: 500 })
  assert.equal(c.stepsPerTurn, 4)
  assert.equal(c.historyTurns, 2)
  assert.equal(c.selector.maxTokens, 512)
  assert.equal(repairs.length, 6)
})

test('跨键不变量：head + tail 必须小于 trigger，否则整族回退默认值', () => {
  const repairs: string[] = []
  const c = resolveConfig(
    { projection: { read: { triggerChars: 1000, headChars: 2000, tailChars: 500 } } },
    message => repairs.push(message),
  )
  assert.deepEqual(c.projection.read, DEFAULT_CONFIG.projection.read)
  assert.equal(repairs.length, 1)
  const repair = repairs[0]
  assert.ok(repair !== undefined)
  assert.match(repair, /triggerChars/)

  const tight = resolveConfig({ projection: { read: { triggerChars: 2901, headChars: 2500, tailChars: 400 } } })
  assert.deepEqual(tight.projection.read, { triggerChars: 2901, headChars: 2500, tailChars: 400 })
})

test('0 是合法阈值/预算，但 selector 的 0 输出上限无效', () => {
  const c = resolveConfig({
    admission: { thresholdTokens: 0 },
    selector: { maxTokens: 0 },
    stepsPerTurn: 0,
    horizonSteps: 0,
  })
  assert.equal(c.admission.thresholdTokens, 0)
  assert.equal(c.stepsPerTurn, 0)
  assert.equal(c.horizonSteps, 0)
  assert.equal(c.selector.maxTokens, DEFAULT_CONFIG.selector.maxTokens)
})

// ---------------------------------------------------------------------------
// Totality (review row 68): a hostile config object is still a config object.
// ---------------------------------------------------------------------------

test('getter 抛错不冒出 resolveConfig：整个解析回落到完整默认值', () => {
  const hostileRoot = Object.defineProperty({}, 'projection', {
    enumerable: true,
    get() {
      throw new Error('root getter bomb')
    },
  })
  assert.deepEqual(resolveConfig(hostileRoot), DEFAULT_CONFIG)

  const hostileNested = {
    projection: Object.defineProperty({}, 'read', {
      enumerable: true,
      get() {
        throw new Error('nested getter bomb')
      },
    }),
    stepsPerTurn: 4,
  }
  // A value that could not be read is not a value: the whole resolution is
  // untrustworthy, so the design defaults win rather than a partial document.
  assert.deepEqual(resolveConfig(hostileNested), DEFAULT_CONFIG)
})

test('onRepair 抛错也不冒出 resolveConfig', () => {
  assert.deepEqual(
    resolveConfig({ stepsPerTurn: -1 }, () => {
      throw new Error('repair sink bomb')
    }),
    DEFAULT_CONFIG,
  )
})

// ---------------------------------------------------------------------------
// Ticket #10: the distillation section
// ---------------------------------------------------------------------------

test('distillation 默认值逐字符合票面：关、bash+ssh、null 触发与路由、256/3000', () => {
  assert.deepEqual(DEFAULT_CONFIG.distillation, {
    enabled: false,
    families: ['bash', 'ssh'],
    triggerChars: null,
    maxOutputTokens: 256,
    timeoutMs: 3000,
    route: null,
  })
  // Off by default: a host that never configures it behaves exactly like 0.2.7.
  assert.equal(resolveConfig({}).distillation.enabled, false)
})

test('distillation 逐键合并，并按族顺序、去重、过滤未知族', () => {
  const c = resolveConfig({
    distillation: { enabled: true, families: ['ssh', 'read', 'bash', 'ssh', 'nope'] },
  })
  assert.equal(c.distillation.enabled, true)
  assert.deepEqual(c.distillation.families, ['ssh', 'read', 'bash'])
  assert.equal(c.distillation.maxOutputTokens, 256)
})

test('distillation 数值 clamp：maxOutputTokens 1..4096、timeoutMs 100..30000，并上报修复', () => {
  const repairs: string[] = []
  const c = resolveConfig(
    { distillation: { maxOutputTokens: 0, timeoutMs: 5 } },
    (message) => repairs.push(message),
  )
  assert.equal(c.distillation.maxOutputTokens, 1)
  assert.equal(c.distillation.timeoutMs, 100)
  assert.ok(repairs.some((m) => m.includes('distillation.maxOutputTokens')))
  assert.ok(repairs.some((m) => m.includes('distillation.timeoutMs')))

  const high = resolveConfig({ distillation: { maxOutputTokens: 99_999, timeoutMs: 1e9 } })
  assert.equal(high.distillation.maxOutputTokens, 4096)
  assert.equal(high.distillation.timeoutMs, 30_000)

  const fractional = resolveConfig({ distillation: { maxOutputTokens: 100.7 } })
  assert.equal(fractional.distillation.maxOutputTokens, 100)
})

test('distillation 畸形值逐键回落：enabled 非布尔、families 非数组、route 缺字段、trigger 负数', () => {
  const repairs: string[] = []
  const c = resolveConfig(
    {
      distillation: {
        enabled: 'yes',
        families: 'bash',
        triggerChars: -5,
        route: { provider: 'p' },
        maxOutputTokens: Number.NaN,
      },
    },
    (message) => repairs.push(message),
  )
  assert.equal(c.distillation.enabled, false)
  assert.deepEqual(c.distillation.families, ['bash', 'ssh'])
  assert.equal(c.distillation.triggerChars, null)
  assert.equal(c.distillation.route, null)
  assert.equal(c.distillation.maxOutputTokens, 256)
  assert.ok(repairs.length >= 4, repairs.join('\n'))
})

test('distillation.route 只保留 provider/model 两个字符串', () => {
  const c = resolveConfig({ distillation: { route: { provider: 'deepseek', model: 'deepseek-flash', extra: 1 } } })
  assert.deepEqual(c.distillation.route, { provider: 'deepseek', model: 'deepseek-flash' })
})

test('distillation 返回深拷贝，不污染默认值', () => {
  const c = resolveConfig(undefined)
  c.distillation.families.push('read')
  c.distillation.enabled = true
  assert.deepEqual(DEFAULT_CONFIG.distillation.families, ['bash', 'ssh'])
  assert.equal(DEFAULT_CONFIG.distillation.enabled, false)
})
