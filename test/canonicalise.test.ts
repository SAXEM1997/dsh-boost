import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalise } from '../src/projection/canonicalise.ts'

test('多个 text block 按顺序拼成一个字符串', () => {
  const r = canonicalise([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], false)
  assert.equal(r.text, 'ab')
  assert.equal(r.textBlocks, 2)
})

test('非 text block 被跳过，图片不参与规范化', () => {
  const r = canonicalise([{ type: 'text', text: 'x' }, { type: 'image' }, { type: 'text', text: 'y' }], false)
  assert.equal(r.text, 'xy')
  assert.equal(r.textBlocks, 2)   // 不是 blocks.length（= 3）
})

test('空回执标记 empty', () => {
  assert.equal(canonicalise([], false).empty, true)
  assert.equal(canonicalise([], false).textBlocks, 0)
  assert.equal(canonicalise([{ type: 'text', text: '' }], false).empty, true)
  assert.equal(canonicalise([{ type: 'text', text: ' ' }], false).empty, false)
})

test('isError 透传', () => {
  const r = canonicalise([{ type: 'text', text: 'boom' }], true)
  assert.equal(r.isError, true)
  assert.equal(r.textBlocks, 1)
})

test('没有 text 字段的 text block 被当作非 text block（不计入 textBlocks）', () => {
  const r = canonicalise([{ type: 'text' }, { type: 'text', text: 'z' }], false)
  assert.equal(r.text, 'z')
  assert.equal(r.textBlocks, 1)
})

test('不 trim、不改行尾，逐字保留', () => {
  const r = canonicalise([{ type: 'text', text: ' a\r\n' }, { type: 'text', text: '\tb ' }], false)
  assert.equal(r.text, ' a\r\n\tb ')
  assert.equal(r.empty, false)
})

test('非对象 block 被跳过而不是解引用（[null]）', () => {
  const r = canonicalise([null as any, { type: 'text', text: 'x' }], false)
  assert.equal(r.text, 'x')
  assert.equal(r.textBlocks, 1)
})

test('非数组 content 视为空回执，不抛错', () => {
  for (const malformed of [null, undefined, {}, 'text'] as any[]) {
    const r = canonicalise(malformed, false)
    assert.equal(r.text, '')
    assert.equal(r.empty, true)
    assert.equal(r.textBlocks, 0)
  }
})

test('非字符串 text 不计入 textBlocks，也不被 join 强制转换（row 64）', () => {
  const r = canonicalise(
    [
      { type: 'text', text: null as any },
      { type: 'text', text: 42 as any },
      { type: 'text', text: {} as any },
      { type: 'text', text: 'kept' },
    ],
    false,
  )
  assert.equal(r.text, 'kept')
  assert.equal(r.textBlocks, 1)
  // `Array.join` would turn 42 into "42" and null into ""; neither is content
  // the host declared, so neither may reach a guard or a receipt.
  assert.equal(r.text.includes('42'), false)
})
