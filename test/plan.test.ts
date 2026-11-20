import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePlan, isTrivial } from '../src/gate/plan.ts'

const wrap = (json: string) => `前言\n<CHISEL_PLAN>${json}</CHISEL_PLAN>\n后记`

/** Full document for a plan with the given `steps` plus optional top-level keys. */
const body = (steps: unknown, extra: Record<string, unknown> = {}) =>
  wrap(JSON.stringify({ goal: 'g', steps, ...extra }))

/** A valid candidate; every test overrides exactly the field under test. */
const candidate = (over: Record<string, unknown> = {}) => ({
  id: 'A',
  tool: 'read',
  args: { path: '/a' },
  guards: [{ text_contains: 'x' }],
  ...over,
})

/** Parse a document that must succeed; failure is reported with the raw result. */
function planOf(steps: unknown, extra: Record<string, unknown> = {}) {
  const result = parsePlan(body(steps, extra))
  if (!('plan' in result)) assert.fail(`expected a plan, got ${JSON.stringify(result)}`)
  return result.plan
}

/** The first element of a list the test has established is non-empty. */
function head<T>(items: readonly T[]): T {
  const value = items[0]
  assert.ok(value !== undefined, 'expected a non-empty list')
  return value
}

test('解析出计划与候选', () => {
  const r = parsePlan(wrap(JSON.stringify({ goal: 'g', steps: [{ id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ text_contains: 'x' }] }] })))
  assert.ok('plan' in r)
  if ('plan' in r) assert.equal(head(r.plan.steps).id, 'A')
})

test('没有计划块返回 no-plan', () => {
  assert.deepEqual(parsePlan('nothing here'), { error: 'no-plan' })
})

test('坏 JSON 返回 bad-json', () => {
  assert.deepEqual(parsePlan(wrap('{oops')), { error: 'bad-json' })
})

test('只有 ok:true 判平凡（guard-trivial）', () => {
  assert.equal(isTrivial({ id: 'A', tool: 'read', args: {}, guards: [{ ok: true }] }), true)
  assert.equal(isTrivial({ id: 'A', tool: 'read', args: {}, guards: [{ ok: true }, { text_contains: 'x' }] }), false)
})

/* ------------------------------------------------------------------------- *
 * 规则 1：只取第一个计划块；没有闭合标签就是没有计划
 * ------------------------------------------------------------------------- */

test('多个计划块只取第一个', () => {
  const first = JSON.stringify({ goal: 'first', steps: [candidate({ id: 'A' })] })
  const second = JSON.stringify({ goal: 'second', steps: [candidate({ id: 'B' })] })
  const r = parsePlan(`<CHISEL_PLAN>${first}</CHISEL_PLAN>\n<CHISEL_PLAN>${second}</CHISEL_PLAN>`)
  assert.ok('plan' in r)
  if ('plan' in r) {
    assert.equal(r.plan.goal, 'first')
    assert.deepEqual(r.plan.steps.map((step) => step.id), ['A'])
  }
})

test('第一块坏 JSON 时不再尝试第二块', () => {
  const second = JSON.stringify({ goal: 'g', steps: [candidate()] })
  assert.deepEqual(parsePlan(`<CHISEL_PLAN>{oops</CHISEL_PLAN><CHISEL_PLAN>${second}</CHISEL_PLAN>`), {
    error: 'bad-json',
  })
})

test('没有闭合标签返回 no-plan', () => {
  assert.deepEqual(parsePlan('<CHISEL_PLAN>{"goal":"g","steps":[]}'), { error: 'no-plan' })
  assert.deepEqual(parsePlan('</CHISEL_PLAN>'), { error: 'no-plan' })
})

test('大量未闭合的起始标签返回 no-plan，不逐个回溯', () => {
  assert.deepEqual(parsePlan('<CHISEL_PLAN>'.repeat(50_000)), { error: 'no-plan' })
})

test('闭合标签出现在 JSON 字符串里时按截断处理，返回 bad-json', () => {
  const json = JSON.stringify({ goal: 'g', steps: [candidate({ args: { path: '</CHISEL_PLAN>' } })] })
  assert.deepEqual(parsePlan(wrap(json)), { error: 'bad-json' })
})

/* ------------------------------------------------------------------------- *
 * 规则 3：结构错误一律 bad-shape
 * ------------------------------------------------------------------------- */

test('steps 缺失、非数组或为空都返回 bad-shape', () => {
  const cases: unknown[] = [undefined, null, {}, 'x', 1, []]
  for (const steps of cases) {
    const raw = steps === undefined ? wrap(JSON.stringify({ goal: 'g' })) : body(steps)
    assert.deepEqual(parsePlan(raw), { error: 'bad-shape' }, `steps=${String(steps)}`)
  }
})

test('候选不是对象返回 bad-shape', () => {
  for (const step of [null, 'A', [], 42]) {
    assert.deepEqual(parsePlan(body([step])), { error: 'bad-shape' }, `step=${JSON.stringify(step)}`)
  }
})

test('候选缺必填字段或类型不符返回 bad-shape', () => {
  const bad = [
    candidate({ id: undefined }),
    candidate({ id: null }),
    candidate({ id: 1 }),
    candidate({ tool: undefined }),
    candidate({ tool: null }),
    candidate({ tool: 1 }),
    candidate({ args: undefined }),
    candidate({ args: null }),
    candidate({ args: [] }),
    candidate({ args: 'x' }),
    candidate({ guards: undefined }),
    candidate({ guards: null }),
    candidate({ guards: {} }),
  ]
  for (const step of bad) {
    assert.deepEqual(parsePlan(body([step])), { error: 'bad-shape' }, JSON.stringify(step))
  }
})

test('重复 id 返回 bad-shape', () => {
  const steps = [candidate({ id: 'A' }), candidate({ id: 'A', tool: 'grep', args: { pattern: 'x' } })]
  assert.deepEqual(parsePlan(body(steps)), { error: 'bad-shape' })
})

test('id 必须是单个大写字母 A–Z', () => {
  const bad = ['', 'a', 'AA', 'A1', '1', 'Z ', ' A', 'A\n', '😀', 'A'.repeat(30)]
  for (const id of bad) {
    assert.deepEqual(parsePlan(body([candidate({ id })])), { error: 'bad-shape' }, JSON.stringify(id))
  }
  for (const id of ['A', 'M', 'Z']) {
    assert.equal(head(planOf([candidate({ id })]).steps).id, id)
  }
})

test('26 个字母候选可以共存，多于 26 个必然重复或非法', () => {
  const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']
  assert.equal(planOf(letters.map((id) => candidate({ id }))).steps.length, 26)
  assert.deepEqual(parsePlan(body([...letters, 'A'].map((id) => candidate({ id })))), { error: 'bad-shape' })
})

test('tool 必须非空（trim 后），值本身不重写', () => {
  for (const tool of ['', '   ', '\t\n']) {
    assert.deepEqual(parsePlan(body([candidate({ tool })])), { error: 'bad-shape' }, JSON.stringify(tool))
  }
  assert.equal(head(planOf([candidate({ tool: ' read ' })]).steps).tool, ' read ')
})

/* ------------------------------------------------------------------------- *
 * 规则 5：args 里只允许字面量，唯一例外是 $public 模板
 * ------------------------------------------------------------------------- */

test('args 里的非 $public 的 $ 前缀键返回 bad-shape', () => {
  const bad = [
    { $eval: 'x' },
    { $call: 'A' },
    { $ref: 'A' },
    { path: { $eval: 'x' } },
    { list: [{ $ref: 'A' }] },
  ]
  for (const args of bad) {
    assert.deepEqual(parsePlan(body([candidate({ args })])), { error: 'bad-shape' }, JSON.stringify(args))
  }
})

test('$public 子树原样保留，$scalar 是值不是键', () => {
  const args = {
    path: { $public: { after: 'root', field: '$scalar' } },
    extra: { nested: [{ $public: { after: 'A', field: '$single' } }] },
  }
  assert.deepEqual(head(planOf([candidate({ args })]).steps).args, args)
})

test('根级 $public 在此放行，由绑定阶段拒绝', () => {
  const args = { $public: { after: 'A', field: 'name' } }
  assert.deepEqual(head(planOf([candidate({ args })]).steps).args, args)
})

test('$public 子树里也不能出现别的 $ 前缀键', () => {
  const args = { path: { $public: { after: 'A', field: 'name', $eval: 'x' } } }
  assert.deepEqual(parsePlan(body([candidate({ args })])), { error: 'bad-shape' })
})

test('原型相关键名在任何深度都返回 bad-shape', () => {
  const bad: unknown[] = [
    JSON.parse('{"__proto__":{"polluted":1}}'),
    JSON.parse('{"a":[{"__proto__":1}]}'),
    { constructor: { prototype: { x: 1 } } },
    { a: { prototype: 1 } },
    { list: [{ constructor: 1 }] },
  ]
  for (const args of bad) {
    assert.deepEqual(parsePlan(body([candidate({ args })])), { error: 'bad-shape' }, JSON.stringify(args))
  }
  // 作为值出现是合法的：只有键名受限
  assert.equal(head(planOf([candidate({ args: { pattern: 'constructor' } })]).steps).args.pattern, 'constructor')
})

test('args 深度上限 64，超过返回 bad-shape', () => {
  const nested = (levels: number): Record<string, unknown> => {
    let node: Record<string, unknown> = { leaf: true }
    for (let i = 1; i < levels; i += 1) node = { nested: node }
    return node
  }
  const atCap = parsePlan(body([candidate({ args: nested(64) })]))
  assert.ok('plan' in atCap)
  assert.deepEqual(parsePlan(body([candidate({ args: nested(65) })])), { error: 'bad-shape' })

  let deepArray: unknown = true
  for (let i = 0; i < 2_000; i += 1) deepArray = [deepArray]
  assert.deepEqual(parsePlan(body([candidate({ args: { list: deepArray } })])), { error: 'bad-shape' })
})

/* ------------------------------------------------------------------------- *
 * 规则 3 / 裁决 2：guard 必须恰好匹配四种形式之一，多余键丢弃
 * ------------------------------------------------------------------------- */

test('guard 同时匹配两种形式返回 bad-shape', () => {
  const bad = [
    { ok: true, text_contains: 'x' },
    { text_contains: 'x', text_not_contains: 'y' },
    { text_contains: 'x', json_equals: { pointer: '/a', value: 1 } },
    { text_not_contains: 'x', json_equals: { pointer: '/a', value: 'y' } },
  ]
  for (const guard of bad) {
    assert.deepEqual(parsePlan(body([candidate({ guards: [guard] })])), { error: 'bad-shape' }, JSON.stringify(guard))
  }
})

test('guard 不是对象或匹配不到形式返回 bad-shape', () => {
  const bad: unknown[] = [
    null,
    'x',
    42,
    [],
    {},
    { exit_code: 0 },
    { ok: false },
    { ok: 'true' },
    { text_contains: 1 },
    { text_not_contains: null },
  ]
  for (const guard of bad) {
    assert.deepEqual(parsePlan(body([candidate({ guards: [guard] })])), { error: 'bad-shape' }, JSON.stringify(guard))
  }
})

test('json_equals 载荷不合法返回 bad-shape', () => {
  const bad: unknown[] = [
    null,
    'x',
    [],
    {},
    { pointer: '/a' },
    { value: 1 },
    { pointer: 1, value: 1 },
    { pointer: '/a', value: null },
    { pointer: '/a', value: { a: 1 } },
    { pointer: '/a', value: [1] },
  ]
  for (const json_equals of bad) {
    assert.deepEqual(
      parsePlan(body([candidate({ guards: [{ json_equals }] })])),
      { error: 'bad-shape' },
      JSON.stringify(json_equals),
    )
  }
})

test('空字符串 guard 操作数返回 bad-shape（恒真守卫不能绕过 guard-trivial）', () => {
  for (const guard of [{ text_contains: '' }, { text_not_contains: '' }]) {
    assert.deepEqual(parsePlan(body([candidate({ guards: [guard] })])), { error: 'bad-shape' }, JSON.stringify(guard))
  }
})

test('guard 多余键被丢弃', () => {
  const guards = [
    { ok: true, note: 'y' },
    { text_contains: 'x', note: 'y' },
    { json_equals: { pointer: '/a', value: 1, note: 'y' } },
  ]
  assert.deepEqual(head(planOf([candidate({ guards })]).steps).guards, [
    { ok: true },
    { text_contains: 'x' },
    { json_equals: { pointer: '/a', value: 1 } },
  ])
})

test('json_equals 的数值原样保留', () => {
  const guards = [{ json_equals: { pointer: '/a', value: 1 } }]
  const parsed = head(head(planOf([candidate({ guards })]).steps).guards)
  assert.deepEqual(parsed, guards[0])
  assert.ok('json_equals' in parsed)
  if ('json_equals' in parsed) assert.equal(typeof parsed.json_equals.value, 'number')
})

/* ------------------------------------------------------------------------- *
 * 规则 6：isTrivial
 * ------------------------------------------------------------------------- */

test('空 guard 数组判平凡', () => {
  assert.equal(isTrivial({ id: 'A', tool: 'read', args: {}, guards: [] }), true)
})

test('多个 ok:true 仍判平凡', () => {
  assert.equal(isTrivial({ id: 'A', tool: 'read', args: {}, guards: [{ ok: true }, { ok: true }] }), true)
})

test('单个非平凡 guard 判非平凡', () => {
  assert.equal(isTrivial({ id: 'A', tool: 'read', args: {}, guards: [{ text_contains: 'x' }] }), false)
  assert.equal(isTrivial({ id: 'A', tool: 'read', args: {}, guards: [{ ok: true }, { text_not_contains: 'y' }] }), false)
})

/* ------------------------------------------------------------------------- *
 * 规则 7：goal 是文档，不是控制流
 * ------------------------------------------------------------------------- */

test('goal 缺失或非字符串回落空串', () => {
  for (const goal of [undefined, null, 1, {}, []]) {
    const r = parsePlan(wrap(JSON.stringify({ goal, steps: [candidate()] })))
    assert.ok('plan' in r)
    if ('plan' in r) assert.equal(r.plan.goal, '')
  }
  assert.equal(planOf([candidate()], { goal: 'g' }).goal, 'g')
})

/* ------------------------------------------------------------------------- *
 * 裁决 1：未知键忽略；只保留约定字段
 * ------------------------------------------------------------------------- */

test('未知顶层键与候选键被忽略，结果只含约定字段', () => {
  const step = candidate({ note: 'ignored', extra: true })
  const plan = planOf([step], { note: 'ignored', version: 2, extra: { a: 1 } })
  assert.deepEqual(Object.keys(plan), ['goal', 'steps'])
  assert.deepEqual(Object.keys(head(plan.steps)), ['id', 'tool', 'args', 'guards'])
})

test('垃圾输入不抛错，只返回错误码', () => {
  const inputs = [
    '',
    'nothing',
    '<CHISEL_PLAN>',
    '<CHISEL_PLAN></CHISEL_PLAN>',
    `<CHISEL_PLAN>${'x'.repeat(10_000)}</CHISEL_PLAN>`,
    '<CHISEL_PLAN>{"goal":</CHISEL_PLAN>',
    '\uD800',
    '<CHISEL_PLAN>\u0000</CHISEL_PLAN>',
  ]
  for (const input of inputs) {
    assert.doesNotThrow(() => parsePlan(input), JSON.stringify(input))
  }
})
