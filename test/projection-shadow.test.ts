import test from 'node:test'
import assert from 'node:assert/strict'
import { projectShadow } from '../src/projection/apply.ts'
import { renderHeadLine, truncate } from '../src/projection/truncate.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'

const estimate = (s: string) => Math.ceil(s.length / 4)

test('影子模式不改动文本，只报前后 token', async () => {
  const text = 'x'.repeat(20000)
  const o = await projectShadow({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, estimate })
  assert.equal(o.kind, 'shadow')
  assert.equal(o.before, 5000)
  assert.ok(o.after! < o.before!)
  assert.equal(o.saved, o.before! - o.after!)
})

test('after 按“头行 + head + 省略说明 + tail”估计，不是 t.after（规则 1）', async () => {
  const text = 'x'.repeat(20000)
  const seen: string[] = []
  const spy = (s: string) => {
    seen.push(s)
    return estimate(s)
  }
  const o = await projectShadow({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, estimate: spy })

  const t = truncate(text, DEFAULT_CONFIG.projection.read)!
  assert.equal(seen.length, 2)
  assert.equal(seen[0], text, 'before 估计原全文')

  // 关键断言：估算对象是拼上省略说明后的替换串，不是 T4 的 t.after。
  const projected = seen[1]
  assert.notEqual(projected, t.after)
  assert.ok(projected.length > t.after.length)
  assert.ok(projected.includes(renderHeadLine(t)))
  assert.ok(projected.includes(t.head))
  assert.ok(projected.includes(t.tail))
  assert.match(projected, /\(Omitted 17500 bytes\.\)/)

  assert.equal(o.after, estimate(projected))
  assert.equal(o.saved, o.before! - o.after!)
})

test('未配置的工具族跳过（family-not-configured），不抛错', async () => {
  const o = await projectShadow({
    text: 'x'.repeat(9999),
    isError: false,
    family: 'web_fetch' as never,
    cfg: DEFAULT_CONFIG,
    estimate,
  })
  assert.deepEqual(o, { kind: 'skipped', reason: 'family-not-configured' })
})

test('错误回执永远跳过（error-receipt），超大正文也不例外', async () => {
  const o = await projectShadow({
    text: 'x'.repeat(20000),
    isError: true,
    family: 'read',
    cfg: DEFAULT_CONFIG,
    estimate,
  })
  assert.deepEqual(o, { kind: 'skipped', reason: 'error-receipt' })

  const huge = await projectShadow({
    text: 'x'.repeat(300 * 1024),
    isError: true,
    family: 'read',
    cfg: DEFAULT_CONFIG,
    estimate,
  })
  assert.deepEqual(huge, { kind: 'skipped', reason: 'error-receipt' })
})

test('空回执记 empty；空的错误回执仍记 error-receipt（顺序）', async () => {
  const empty = await projectShadow({ text: '', isError: false, family: 'read', cfg: DEFAULT_CONFIG, estimate })
  assert.deepEqual(empty, { kind: 'skipped', reason: 'empty' })

  const emptyError = await projectShadow({ text: '', isError: true, family: 'read', cfg: DEFAULT_CONFIG, estimate })
  assert.deepEqual(emptyError, { kind: 'skipped', reason: 'error-receipt' })
})

test('truncate 返回 null 时记 not-worth-it（低于阈值 / 超 256KiB 上限）', async () => {
  const short = await projectShadow({ text: 'x'.repeat(100), isError: false, family: 'read', cfg: DEFAULT_CONFIG, estimate })
  assert.deepEqual(short, { kind: 'skipped', reason: 'not-worth-it' })

  const overCap = await projectShadow({
    text: 'x'.repeat(300 * 1024),
    isError: false,
    family: 'read',
    cfg: DEFAULT_CONFIG,
    estimate,
  })
  assert.deepEqual(overCap, { kind: 'skipped', reason: 'not-worth-it' })
})

test('skipped 结果不带计量字段，也不调用 estimate', async () => {
  let calls = 0
  const spy = () => {
    calls++
    return 0
  }
  const o = await projectShadow({ text: 'x'.repeat(100), isError: false, family: 'read', cfg: DEFAULT_CONFIG, estimate: spy })
  assert.deepEqual(o, { kind: 'skipped', reason: 'not-worth-it' })
  assert.equal(calls, 0)
})

test('shadow 结果只有 kind/before/after/saved，绝不带 content', async () => {
  const o = await projectShadow({ text: 'x'.repeat(20000), isError: false, family: 'read', cfg: DEFAULT_CONFIG, estimate })
  assert.deepEqual(Object.keys(o).sort(), ['after', 'before', 'kind', 'saved'])
})