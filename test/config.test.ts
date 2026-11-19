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
