import test from 'node:test'
import assert from 'node:assert/strict'
import { bindArgs, extractField, isTemplate } from '../src/gate/binding.ts'

const r = (text: string) => ({ text, isError: false, empty: text.length === 0, textBlocks: 1 })

/* ------------------------------------------------------------------------- *
 * 任务书中的八个基线用例
 * ------------------------------------------------------------------------- */

test('identifier 只认带引号的值；无引号判歧义（R29）', () => {
  assert.equal(extractField('garbage\nname: "abc"\n', 'name'), 'abc')
  assert.equal(extractField('name="abc"', 'name'), 'abc')
  assert.equal(extractField('name=abc', 'name'), undefined)
  const out = bindArgs({ p: { $public: { after: 'A', field: 'name' } } }, new Map([['A', r('name=abc')]]))
  assert.deepEqual(out, { ok: false, reason: 'ambiguous' })
})

test('$scalar 整段匹配，含空格即失败', () => {
  assert.equal(extractField('  abc-1  ', '$scalar'), 'abc-1')
  assert.equal(extractField('a b', '$scalar'), undefined)
})

test('$single 取单元素数组', () => {
  assert.equal(extractField("['v']", '$single'), 'v')
  assert.equal(extractField("['a','b']", '$single'), undefined)
})

test('重复匹配判歧义', () => {
  assert.equal(extractField('name: "a"\nname: "b"', 'name'), undefined)
})

test('root 模板绑定到本步回执', () => {
  const out = bindArgs({ path: { $public: { after: 'root', field: '$scalar' } } }, new Map([['root', r('/tmp/x')]]))
  assert.deepEqual(out, { ok: true, args: { path: '/tmp/x' } })
})

test('引用不存在的图节点判 unresolvable（Review Focus #3）', () => {
  const out = bindArgs({ path: { $public: { after: 'C', field: '$scalar' } } }, new Map([['A', r('x')], ['B', r('y')]]))
  assert.deepEqual(out, { ok: false, reason: 'unresolvable' })
})

test('引用出错回执判 missing-receipt', () => {
  const m = new Map([['A', { text: 'x', isError: true, empty: false, textBlocks: 1 }]])
  const out = bindArgs({ p: { $public: { after: 'A', field: '$scalar' } } }, m)
  assert.deepEqual(out, { ok: false, reason: 'missing-receipt' })
})

test('回执不是单个 text block 时判 not-single-text（R40）', () => {
  const m = new Map([['A', { text: 'x', isError: false, empty: false, textBlocks: 2 }]])
  const out = bindArgs({ p: { $public: { after: 'A', field: '$scalar' } } }, m)
  assert.deepEqual(out, { ok: false, reason: 'not-single-text' })
})

/* ------------------------------------------------------------------------- *
 * field 是模型可控输入：转义、空串与保留值之外的 $ 前缀
 * ------------------------------------------------------------------------- */

test('field 含正则元字符时按字面匹配', () => {
  assert.equal(extractField('a.*: "v"', 'a.*'), 'v')
  assert.equal(extractField('a.*="v"', 'a.*'), 'v')
  assert.equal(extractField('aZZ: "v"', 'a.*'), undefined)
  assert.equal(extractField('a.*: "v"\na.*: "w"', 'a.*'), undefined)
})

test('空 field 与未知 $ 前缀 field 判歧义（返回 undefined）', () => {
  assert.equal(extractField('name: "v"', ''), undefined)
  assert.equal(extractField(': "v"', ''), undefined)
  assert.equal(extractField('$eval: "v"', '$eval'), undefined)
  assert.equal(extractField('$scalarish', '$scalarish'), undefined)
  assert.equal(extractField('$singleish: "v"', '$singleish'), undefined)
  const out = bindArgs({ p: { $public: { after: 'A', field: '$eval' } } }, new Map([['A', r('x')]]))
  assert.deepEqual(out, { ok: false, reason: 'ambiguous' })
})

test('field 是另一个字段的前缀时不匹配', () => {
  assert.equal(extractField('name: "a"', 'nam'), undefined)
})

test('CRLF 行尾的标识符照常匹配', () => {
  assert.equal(extractField('garbage\r\nname: "abc"\r\n', 'name'), 'abc')
  assert.equal(extractField('a: "1"\r\na: "1"\r\n', 'a'), undefined)
})

test('裸 CR 也是行分隔：两处赋值判歧义，单处仍可绑定', () => {
  assert.equal(extractField('name: "safe"\rname: "evil"', 'name'), undefined)
  assert.equal(extractField('a\rname: "x"', 'name'), 'x')
  assert.deepEqual(
    bindArgs(
      { p: { $public: { after: 'A', field: 'name' } } },
      new Map([['A', r('name: "safe"\rname: "evil"')]]),
    ),
    { ok: false, reason: 'ambiguous' },
  )
})

test('$scalar 不 trim 中间内容：引号、换行、空格都失败', () => {
  assert.equal(extractField('"abc"', '$scalar'), undefined)
  assert.equal(extractField('a\nb', '$scalar'), undefined)
  assert.equal(extractField('a\tb', '$scalar'), undefined)
  assert.equal(extractField('   ', '$scalar'), undefined)
})

test('$single 要求整段恰为单元素单引号数组', () => {
  assert.equal(extractField("  ['v']  ", '$single'), 'v')
  assert.equal(extractField("['v'] trailing", '$single'), undefined)
  assert.equal(extractField('["v"]', '$single'), undefined)
  assert.equal(extractField("['']", '$single'), undefined)
})

test('$single 的值不能跨行（与另外两种形式一致）', () => {
  assert.equal(extractField("['a\nb']", '$single'), undefined)
  assert.equal(extractField("['a\rb']", '$single'), undefined)
  assert.equal(extractField("['a\u0085b']", '$single'), undefined)
  assert.equal(extractField("['a\u2028b']", '$single'), undefined)
  assert.equal(extractField("['a b']", '$single'), 'a b')
})

test('$single 内部的反斜杠按字面保留，整段锚定不会截断', () => {
  assert.equal(extractField("['C:\\']", '$single'), 'C:\\')
  assert.equal(extractField("['a\\']", '$single'), 'a\\')
  assert.equal(extractField("['a\\\\']", '$single'), 'a\\\\')
})

test('标识符右侧必须是双引号、值不能为空也不能跨行', () => {
  assert.equal(extractField("name: ''", 'name'), undefined)
  assert.equal(extractField('name: ""', 'name'), undefined)
  assert.equal(extractField('name: "a\nb"', 'name'), undefined)
  assert.equal(extractField('  name = "v"  ', 'name'), 'v')
})

test('结束引号被转义时不返回截断前缀，Windows 路径仍绑定', () => {
  assert.equal(extractField('name: "a\\"b"', 'name'), undefined)
  assert.equal(extractField('name: "\\"a"', 'name'), undefined)
  assert.equal(extractField('name: "a\\\\"', 'name'), 'a\\\\')
  assert.equal(extractField('name: "C:\\x"', 'name'), 'C:\\x')
  assert.deepEqual(
    bindArgs(
      { p: { $public: { after: 'A', field: 'name' } } },
      new Map([['A', r('name: "a\\"b"')]]),
    ),
    { ok: false, reason: 'ambiguous' },
  )
})

test('U+2028 / U+2029 / NEL 也是行分隔：重复赋值判歧义', () => {
  assert.equal(extractField('name: "a"\u2028name: "b"', 'name'), undefined)
  assert.equal(extractField('name: "a"\u2029name: "b"', 'name'), undefined)
  assert.equal(extractField('name: "a"\u0085name: "b"', 'name'), undefined)
  assert.equal(extractField('a\u2028name: "x"', 'name'), 'x')
  assert.equal(extractField('a\u0085name: "x"', 'name'), 'x')
})

test('空白密集回执线性扫描：结果正确且快速返回', () => {
  const blanks = '\n'.repeat(131_072)
  assert.equal(extractField(blanks, 'name'), undefined)
  assert.equal(extractField(`${blanks}name: "x"`, 'name'), 'x')
  assert.equal(extractField(`name: "a"${blanks}name: "b"`, 'name'), undefined)
})

/* ------------------------------------------------------------------------- *
 * 模板形状：严格识别，畸形 $public 容器一律不可解析
 * ------------------------------------------------------------------------- */

test('isTemplate 只认形状完全正确的模板', () => {
  assert.equal(isTemplate({ $public: { after: 'A', field: 'name' } }), true)
  assert.equal(isTemplate({ $public: { after: 'root', field: '$scalar' } }), true)
  assert.equal(isTemplate({ $public: 42 }), false)
  assert.equal(isTemplate({ $public: { after: 'A' } }), false)
  assert.equal(isTemplate({ $public: { field: 'name' } }), false)
  assert.equal(isTemplate({ $public: { after: 1, field: 'name' } }), false)
  assert.equal(isTemplate({ $public: { after: 'A', field: 1 } }), false)
  assert.equal(isTemplate({ $public: { after: 'A', field: 'name', extra: 1 } }), false)
  assert.equal(isTemplate({ $public: { after: 'A', field: 'name' }, extra: 1 }), false)
  assert.equal(isTemplate({ $public: { after: 'A', field: 'name' }, $other: 1 }), false)
  assert.equal(isTemplate([]), false)
  assert.equal(isTemplate(null), false)
  assert.equal(isTemplate('$public'), false)
  assert.equal(isTemplate(undefined), false)
})

test('$public 值不是对象时按字面量透传是禁止的', () => {
  assert.deepEqual(bindArgs({ p: { $public: 42 } }, new Map()), { ok: false, reason: 'unresolvable' })
})

test('模板旁边多一个兄弟键判 unresolvable，不把 $public 交给宿主', () => {
  const args = { p: { $public: { after: 'A', field: '$scalar' }, extra: 'x' } }
  assert.deepEqual(bindArgs(args, new Map([['A', r('v')]])), { ok: false, reason: 'unresolvable' })
})

test('模板内部多一个键判 unresolvable（严格形状，拒绝静默丢键）', () => {
  const args = { p: { $public: { after: 'A', field: '$scalar', default: 'guessed' } } }
  assert.deepEqual(bindArgs(args, new Map([['A', r('v')]])), { ok: false, reason: 'unresolvable' })
})

test('根级模板判 unresolvable（参数对象不是标量）', () => {
  const args = { $public: { after: 'A', field: '$scalar' } }
  assert.deepEqual(bindArgs(args, new Map([['A', r('v')]])), { ok: false, reason: 'unresolvable' })
})

test('根级畸形 $public 容器同样判 unresolvable', () => {
  const args = { $public: { after: 'A', field: '$scalar' }, extra: 1 }
  assert.deepEqual(bindArgs(args, new Map([['A', r('v')]])), { ok: false, reason: 'unresolvable' })
})

test('$public 子树里再套 $public 子树判 unresolvable', () => {
  const args = { p: { $public: { $public: { after: 'A', field: '$scalar' } } } }
  assert.deepEqual(bindArgs(args, new Map([['A', r('v')]])), { ok: false, reason: 'unresolvable' })
})

test('field 为 $public 时判歧义，不会二次展开', () => {
  const args = { p: { $public: { after: 'A', field: '$public' } } }
  assert.deepEqual(bindArgs(args, new Map([['A', r('$public: "v"')]])), { ok: false, reason: 'ambiguous' })
})

/* ------------------------------------------------------------------------- *
 * 递归替换：数组、深度 3、非模板值原样保留
 * ------------------------------------------------------------------------- */

test('数组元素里的模板被替换，结果仍是参数对象', () => {
  const out = bindArgs(
    { paths: [{ $public: { after: 'A', field: '$single' } }] },
    new Map([['A', r("['p']")]]),
  )
  assert.deepEqual(out, { ok: true, args: { paths: ['p'] } })
})

test('深度 3 的嵌套模板逐个替换', () => {
  const args = {
    outer: { mid: [{ deep: { $public: { after: 'A', field: 'name' } } }] },
    other: { $public: { after: 'root', field: '$scalar' } },
  }
  const out = bindArgs(args, new Map([
    ['A', r('name: "deep-value"')],
    ['root', r('  /tmp/root  ')],
  ]))
  assert.deepEqual(out, {
    ok: true,
    args: { outer: { mid: [{ deep: 'deep-value' }] }, other: '/tmp/root' },
  })
})

test('非模板值原样保留，入参不被修改', () => {
  const args = {
    n: 1,
    b: true,
    nil: null,
    s: 'name: "not-a-template"',
    list: [1, 'two', null, { k: 'v' }],
    obj: { k: 'v' },
  }
  const snapshot = structuredClone(args)
  const out = bindArgs(args, new Map())
  assert.deepEqual(out, { ok: true, args: snapshot })
  assert.notEqual(out.ok ? out.args : undefined, args)
  assert.deepEqual(args, snapshot)
})

/* ------------------------------------------------------------------------- *
 * 失败原因的判定顺序与自相矛盾回执
 * ------------------------------------------------------------------------- */

test('判定顺序：unresolvable 先于 missing-receipt，missing-receipt 先于 not-single-text', () => {
  assert.deepEqual(
    bindArgs(
      { p: { $public: { after: 'Z', field: '$scalar' } } },
      new Map([['A', { text: 'x', isError: true, empty: false, textBlocks: 2 }]]),
    ),
    { ok: false, reason: 'unresolvable' },
  )
  assert.deepEqual(
    bindArgs(
      { p: { $public: { after: 'A', field: '$scalar' } } },
      new Map([['A', { text: 'x', isError: true, empty: false, textBlocks: 2 }]]),
    ),
    { ok: false, reason: 'missing-receipt' },
  )
  assert.deepEqual(
    bindArgs(
      { p: { $public: { after: 'A', field: '$scalar' } } },
      new Map([['A', { text: '', isError: false, empty: true, textBlocks: 2 }]]),
    ),
    { ok: false, reason: 'missing-receipt' },
  )
})

test('text 为空但 empty 为假的自相矛盾回执判 missing-receipt', () => {
  const m = new Map([['A', { text: '', isError: false, empty: false, textBlocks: 1 }]])
  const out = bindArgs({ p: { $public: { after: 'A', field: '$scalar' } } }, m)
  assert.deepEqual(out, { ok: false, reason: 'missing-receipt' })
})

test('一个树里只要有一处失败，整份参数都不产出', () => {
  const args = {
    good: { $public: { after: 'A', field: '$scalar' } },
    bad: [{ $public: { after: 'B', field: '$scalar' } }],
  }
  assert.deepEqual(
    bindArgs(args, new Map([['A', r('v')], ['B', r('a b')]])),
    { ok: false, reason: 'ambiguous' },
  )
})

test('$single 拒绝空捕获，与标识符的空值规则一致（row 65）', () => {
  assert.equal(extractField("['']", '$single'), undefined)
  assert.equal(extractField("[' ']", '$single'), ' ')
  // A bare empty identifier is already rejected; the whole-text form must not
  // be the one place an empty argument can reach a tool.
  assert.equal(extractField('name: ""', 'name'), undefined)
})
