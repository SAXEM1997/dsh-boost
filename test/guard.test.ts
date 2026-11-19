import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateGuard, evaluateAll } from '../src/gate/guard.ts'

const r = (text: string, isError = false) => ({ text, isError, empty: text.length === 0, textBlocks: 1 })

test('ok 读 isError', () => {
  assert.equal(evaluateGuard({ ok: true }, r('x')), 'pass')
  assert.equal(evaluateGuard({ ok: true }, r('x', true)), 'fail')
})

test('text_contains 区分大小写', () => {
  assert.equal(evaluateGuard({ text_contains: 'Foo' }, r('a Foo b')), 'pass')
  assert.equal(evaluateGuard({ text_contains: 'foo' }, r('a Foo b')), 'fail')
})

test('text_not_contains 用于排除错误页脚', () => {
  assert.equal(evaluateGuard({ text_not_contains: '[exit code: 1]' }, r('ok')), 'pass')
  assert.equal(evaluateGuard({ text_not_contains: '[exit code: 1]' }, r('x\n[exit code: 1]')), 'fail')
})

test('json_equals 解析失败判 fail，不抛错', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: 1 } }, r('{"a":1}')), 'pass')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: 2 } }, r('{"a":1}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: 1 } }, r('not json')), 'fail')
})

test('全部通过才 ok，返回第一个失败项', () => {
  const guards = [{ ok: true }, { text_contains: 'x' }] as any
  assert.deepEqual(evaluateAll(guards, r('x')), { ok: true })
  assert.deepEqual(evaluateAll(guards, r('y')), { ok: false, failed: guards[1] })
})

/* ------------------------------------------------------------------------- *
 * 规则 4：pointer 语法与 RFC 6901 转义
 * ------------------------------------------------------------------------- */

test('空 pointer 是整段文档', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '', value: 1 } }, r('1')), 'pass')
  assert.equal(evaluateGuard({ json_equals: { pointer: '', value: 1 } }, r('{"a":1}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: '', value: 1 } }, r('null')), 'fail')
})

test('pointer 必须以 / 开头，否则 fail', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: 'a', value: 1 } }, r('{"a":1}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: '#/a', value: 1 } }, r('{"a":1}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: 'a/b', value: 1 } }, r('{"a":{"b":1}}')), 'fail')
})

test('~0 与 ~1 按 RFC 6901 解码', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a~1b', value: 1 } }, r('{"a/b":1}')), 'pass')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a~0b', value: 2 } }, r('{"a~b":2}')), 'pass')
  // ~1 先于 ~0：~01 解码为字面量 "~1"，不是 "/"
  assert.equal(evaluateGuard({ json_equals: { pointer: '/~01', value: 3 } }, r('{"~1":3}')), 'pass')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/~01', value: 3 } }, r('{"/":3}')), 'fail')
})

test('非法 ~ 序列判 fail，不按字面量取键', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a~2', value: 1 } }, r('{"a~2":1}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a~', value: 1 } }, r('{"a~":1}')), 'fail')
})

/* ------------------------------------------------------------------------- *
 * 规则 5：只解析自有属性
 * ------------------------------------------------------------------------- */

test('原型上的 __proto__ 与 constructor 不可达', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '/__proto__', value: 1 } }, r('{}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/constructor', value: 1 } }, r('{}')), 'fail')
})

/* ------------------------------------------------------------------------- *
 * 规则 6：数组下标必须是规范十进制且不越界
 * ------------------------------------------------------------------------- */

test('数组下标必须是规范十进制且不得越界', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '/0', value: 10 } }, r('[10]')), 'pass')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a/1', value: 2 } }, r('{"a":[1,2]}')), 'pass')
  for (const pointer of ['/01', '/-', '/1.0', '/ 1', '/+1', '/', '/a']) {
    assert.equal(evaluateGuard({ json_equals: { pointer, value: 10 } }, r('[10]')), 'fail', pointer)
  }
  assert.equal(evaluateGuard({ json_equals: { pointer: '/1', value: 10 } }, r('[10]')), 'fail')
})

/* ------------------------------------------------------------------------- *
 * 规则 7：类型严格比较与非容器路径
 * ------------------------------------------------------------------------- */

test('类型严格：1 与 "1"、true 与 1 互不相等', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: '1' } }, r('{"a":1}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: 1 } }, r('{"a":"1"}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: 1 } }, r('{"a":true}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: true } }, r('{"a":1}')), 'fail')
})

test('路径经过字符串、null 或布尔时 fail', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a/b', value: 1 } }, r('{"a":"x"}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a/b', value: 1 } }, r('{"a":null}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a/0', value: 1 } }, r('{"a":true}')), 'fail')
})

test('null / 数组 / 对象不可能等于标量', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: 1 } }, r('{"a":null}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: 1 } }, r('{"a":[1]}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: 1 } }, r('{"a":{"b":1}}')), 'fail')
})

test('未知 guard 形式 fail closed', () => {
  assert.equal(evaluateGuard({ neq: 1 } as any, r('x')), 'fail')
})

/* ------------------------------------------------------------------------- *
 * evaluateAll
 * ------------------------------------------------------------------------- */

test('evaluateAll 空数组通过', () => {
  assert.deepEqual(evaluateAll([], r('x')), { ok: true })
})

test('evaluateAll 返回第一个失败的 guard 对象本身', () => {
  const first = { text_contains: 'a' }
  const second = { text_contains: 'b' }
  const result = evaluateAll([first, second], r('z'))
  assert.equal(result.ok, false)
  assert.equal(result.failed, first)
  assert.notEqual(result.failed, second)
})

/* ------------------------------------------------------------------------- *
 * 审查加固：F1–F3 与补充行为
 * ------------------------------------------------------------------------- */

test('ok 只认字面量 true，非 true 或非布尔值 fail closed（F1）', () => {
  assert.equal(evaluateGuard({ ok: false } as any, r('x')), 'fail')
  assert.equal(evaluateGuard({ ok: 1 } as any, r('x')), 'fail')
  assert.equal(evaluateGuard({ ok: 'no' } as any, r('x')), 'fail')
  assert.equal(evaluateGuard({ ok: true }, r('x')), 'pass')
})

test('text_contains 空串不可恒真（F2）', () => {
  assert.equal(evaluateGuard({ text_contains: '' }, r('')), 'fail')
  assert.equal(evaluateGuard({ text_contains: '' }, r('x')), 'fail')
  assert.equal(evaluateGuard({ text_contains: '' }, r('x', true)), 'fail')
  // text_not_contains 的空串本来就恒假，保持不变
  assert.equal(evaluateGuard({ text_not_contains: '' }, r('x')), 'fail')
})

test('非对象 guard 判 fail，不抛错（F3）', () => {
  for (const guard of [null, undefined, 42, 'x', true]) {
    assert.equal(evaluateGuard(guard as any, r('x')), 'fail', String(guard))
  }
  assert.doesNotThrow(() => evaluateAll([null as any], r('x')))
  assert.deepEqual(evaluateAll([null as any], r('x')), { ok: false, failed: null })
})

test('空键对象用 / 取到；数字键在对象和数组上都按下标 0 取到', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '/', value: 1 } }, r('{"":1}')), 'pass')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/0', value: 1 } }, r('{"0":1}')), 'pass')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/0', value: 1 } }, r('[1]')), 'pass')
})

test('json_equals 不读 isError：错误回执仍按文本判定', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: 1 } }, r('{"a":1}', true)), 'pass')
})

test('整段文档是数组时不可能等于标量', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '', value: 1 } }, r('[]')), 'fail')
})

test('10 000 层嵌套文档用迭代走查，匹配指针 pass', () => {
  const depth = 10_000
  const text = '['.repeat(depth) + '1' + ']'.repeat(depth)
  const pointer = '/0'.repeat(depth)
  assert.equal(evaluateGuard({ json_equals: { pointer, value: 1 } }, r(text)), 'pass')
})

test('BOM 前缀的 JSON 判 fail（JSON.parse 拒绝，不剥 BOM）', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: 1 } }, r('\uFEFF{"a":1}')), 'fail')
})
