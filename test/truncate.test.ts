import test from 'node:test'
import assert from 'node:assert/strict'
import { truncate, shouldTruncate, renderHeadLine } from '../src/projection/truncate.ts'
import type { ProjectionParams } from '../src/types.ts'

const READ = { triggerChars: 3000, headChars: 2000, tailChars: 500 }

test('低于触发阈值不裁', () => {
  assert.equal(shouldTruncate('x'.repeat(2999), READ), false)
  assert.equal(truncate('x'.repeat(2999), READ), null)
})

test('阈值按 code point 比较，不按 UTF-16 长度（边界）', () => {
  // 1600 个 emoji：code point 1600 < 3000，UTF-16 units 3200 > 3000
  assert.equal(shouldTruncate('😀'.repeat(1600), READ), false)
  // 若按 text.length 比较会误裁，且头 2000 + 尾 500 会把 1600 个全吃进去，
  // 产出比原文更长的回执与负数的 omitted 计数
  assert.equal(truncate('😀'.repeat(1600), READ), null)
})

test('空回执不裁（Review Focus #1）', () => {
  assert.equal(shouldTruncate('', READ), false)
  assert.equal(truncate('', READ), null)
})

test('触发后头尾按参数切分', () => {
  const t = truncate('a'.repeat(1000) + 'M'.repeat(5000) + 'z'.repeat(1000), READ)!
  assert.equal(t.head.length, 2000)
  assert.equal(t.tail.length, 500)
  assert.ok(t.after.length < t.before.length)
})

test('中文与 emoji 不切开代理对（Review Focus #2）', () => {
  const text = '😀'.repeat(4000) // 每个 emoji 是 1 code point / 2 UTF-16 units
  const t = truncate(text, READ)!
  assert.equal(Array.from(t.head).length, 2000)
  assert.equal(Array.from(t.tail).length, 500)
  assert.equal(t.omittedCodePoints, 4000 - 2500)
  // 字节数 ≠ 字符数
  assert.equal(t.omittedBytes, 1500 * 4)
})

test('页脚头行逐字格式', () => {
  const t = truncate('a'.repeat(18432), READ)!
  assert.equal(renderHeadLine(t), '[output 18,432 chars; showing first 2,000 and last 500]')
})

test('不变量：触发阈值 ≥ 窗口 + 页脚 + 1', () => {
  const footerBytes = 110
  for (const p of [READ, { triggerChars: 700, headChars: 400, tailChars: 100 }]) {
    assert.ok(p.triggerChars >= p.headChars + p.tailChars + footerBytes + 1)
  }
})

// ---- additional coverage for the binding controller rules -------------------

test('emoji 窗口逐字完整：head/tail 都是整数个 emoji（规则 6）', () => {
  const t = truncate('😀'.repeat(4000), READ)!
  assert.equal(t.head, '😀'.repeat(2000))
  assert.equal(t.tail, '😀'.repeat(500))
  assert.equal(t.head.length, 4000) // 2000 个代理对
  assert.equal(t.tail.length, 1000) // 500 个代理对
})

test('code point 触发边界：恰好等于阈值不裁，超过 1 才裁（规则 1）', () => {
  const P = { triggerChars: 2600, headChars: 2000, tailChars: 500 }
  const at = '😀'.repeat(2600) // code point 2600，UTF-16 units 5200
  assert.equal(shouldTruncate(at, P), false)
  assert.equal(truncate(at, P), null)

  const over = '😀'.repeat(2601)
  const t = truncate(over, P)!
  assert.equal(t.omittedCodePoints, 101)
  assert.equal(t.omittedBytes, 101 * 4)
  assert.ok(t.after.length < t.before.length)
})

test('窗口吞不下时返回 null，不抛错（规则 8）', () => {
  const P = { triggerChars: 100, headChars: 2000, tailChars: 500 }
  const text = 'a'.repeat(300)
  assert.equal(shouldTruncate(text, P), false)
  assert.equal(truncate(text, P), null)
})

test('超过阈值但渲染后不比原文短，同样返回 null（规则 4）', () => {
  const P = { triggerChars: 2500, headChars: 2000, tailChars: 500 }
  // 2501 > 2500 触发，但窗口只剩 1 个 code point 可省，加头行后反而更长
  assert.equal(truncate('a'.repeat(2501), P), null)
  // 2600 时同样的窗口能净省，必须裁
  const t = truncate('a'.repeat(2600), P)!
  assert.ok(t.after.length < t.before.length)
  assert.ok(t.omittedCodePoints > 0)
})

test('不变量：非 null 结果一定缩短，omitted 计数为正且字节账闭合（规则 2、4）', () => {
  const cases: Array<[string, ProjectionParams]> = [
    ['a'.repeat(4000), READ],
    ['😀'.repeat(4000), READ],
    ['中'.repeat(4000), READ],
    ['ab😀中'.repeat(1000), READ],
    ['x'.repeat(7000), { triggerChars: 700, headChars: 400, tailChars: 100 }],
  ]
  for (const [text, params] of cases) {
    const t = truncate(text, params)!
    assert.equal(t.before, text)
    assert.ok(t.after.length < t.before.length)
    assert.ok(t.omittedBytes > 0)
    assert.ok(t.omittedCodePoints > 0)
    assert.equal(
      Buffer.byteLength(text, 'utf8'),
      Buffer.byteLength(t.head, 'utf8') + Buffer.byteLength(t.tail, 'utf8') + t.omittedBytes,
    )
  }
})

test('256 KiB 上限按 UTF-8 字节，不按 UTF-16 长度（规则 5）', () => {
  const cap = 256 * 1024
  // 字节数恰好等于上限：仍可裁（严格大于才跳过）
  const exact = 'a'.repeat(cap)
  assert.equal(Buffer.byteLength(exact, 'utf8'), cap)
  assert.ok(truncate(exact, READ))

  // 超过一个字节：整条不投影
  const over = 'a'.repeat(cap + 1)
  assert.equal(shouldTruncate(over, READ), false)
  assert.equal(truncate(over, READ), null)

  // 90,000 个 CJK：text.length（90,000）< 256 KiB，但 UTF-8 是 270,000 字节 > 上限
  const cjk = '中'.repeat(90_000)
  assert.ok(cjk.length < cap)
  assert.ok(Buffer.byteLength(cjk, 'utf8') > cap)
  assert.equal(shouldTruncate(cjk, READ), false)
  assert.equal(truncate(cjk, READ), null)
})

test('页脚头行对首尾窗口也加千位分隔符（规则 7）', () => {
  const t = truncate('x'.repeat(10_000), { triggerChars: 3000, headChars: 2500, tailChars: 1500 })!
  assert.equal(renderHeadLine(t), '[output 10,000 chars; showing first 2,500 and last 1,500]')
})

test('shouldTruncate 与 truncate 的判定处处一致（规则 4、5）', () => {
  const cases: Array<[string, ProjectionParams]> = [
    ['', READ],
    ['x'.repeat(2999), READ],
    ['x'.repeat(3000), READ],
    ['x'.repeat(3001), READ],
    ['😀'.repeat(1600), READ],
    ['😀'.repeat(3001), READ],
    ['a'.repeat(2501), { triggerChars: 2500, headChars: 2000, tailChars: 500 }],
    ['a'.repeat(300), { triggerChars: 100, headChars: 2000, tailChars: 500 }],
    ['中'.repeat(90_000), READ],
  ]
  for (const [text, params] of cases) {
    assert.equal(
      shouldTruncate(text, params),
      truncate(text, params) !== null,
      `text.length=${text.length} trigger=${params.triggerChars}`,
    )
  }
})
