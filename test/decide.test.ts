import test from 'node:test'
import assert from 'node:assert/strict'
import { decide } from '../src/gate/decide.ts'

const rc = (t: string) => ({ text: t, isError: false, empty: false, textBlocks: 1 })
const plan = (cands: any[]) => ({ goal: 'g', steps: cands })
const WL = new Set(['read', 'grep', 'glob'])

test('唯一合格候选直接提交', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ text_contains: 'x' }] },
                { id: 'B', tool: 'read', args: { path: '/b' }, guards: [{ text_contains: 'nope' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]),
  })
  assert.equal(d.kind, 'commit')
  if (d.kind === 'commit') assert.deepEqual(d.args, { path: '/a' })
})

test('多候选且全合格 → ask-selector', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ text_contains: 'x' }] },
                { id: 'B', tool: 'read', args: { path: '/b' }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]),
  })
  assert.equal(d.kind, 'ask-selector')
})

test('非白名单工具即使守卫合格也淘汰（R1）', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'bash', args: { command: 'ls' }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]),
  })
  assert.deepEqual(d, { kind: 'fallback', code: 'tool-not-whitelisted' })
})

test('全部平凡守卫回退 guard-trivial（R13）', () => {
  const d = decide({ plan: plan([{ id: 'A', tool: 'read', args: {}, guards: [{ ok: true }] }]), stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]) })
  assert.deepEqual(d, { kind: 'fallback', code: 'guard-trivial' })
})

test('非平凡候选全部失败回退 no-candidate（R13）', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: { $public: { after: 'root', field: 'name' } } }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]),
  })
  assert.deepEqual(d, { kind: 'fallback', code: 'no-candidate' })
})

test('候选引用图上不存在的节点 C → fallback（R43）', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: { $public: { after: 'C', field: '$scalar' } } }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')], ['A', rc('y')], ['B', rc('z')]]),
  })
  assert.deepEqual(d, { kind: 'fallback', code: 'no-candidate' })
})

/* ------------------------------------------------------------------------- *
 * 规则 1–5 与控制器裁决的补充钉死
 * ------------------------------------------------------------------------- */

test('commit 携带绑定后的参数', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: { $public: { after: 'root', field: '$scalar' } } }, guards: [{ text_contains: '/a' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('/a')]]),
  })
  assert.deepEqual(d, { kind: 'commit', candidateId: 'A', args: { path: '/a' } })
})

test('白名单过滤先于平凡过滤：非白名单平凡候选记 tool-not-whitelisted', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'bash', args: {}, guards: [{ ok: true }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]),
  })
  assert.deepEqual(d, { kind: 'fallback', code: 'tool-not-whitelisted' })
})

test('混入非白名单候选不改变白名单幸存者的判定', () => {
  const bash = { id: 'A', tool: 'bash', args: { command: 'ls' }, guards: [{ text_contains: 'x' }] }
  const trivial = decide({
    plan: plan([bash, { id: 'B', tool: 'read', args: { path: '/b' }, guards: [{ ok: true }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]),
  })
  assert.deepEqual(trivial, { kind: 'fallback', code: 'guard-trivial' })

  const commit = decide({
    plan: plan([bash, { id: 'B', tool: 'read', args: { path: '/b' }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]),
  })
  assert.deepEqual(commit, { kind: 'commit', candidateId: 'B', args: { path: '/b' } })
})

test('空计划回退 guard-trivial', () => {
  const d = decide({ plan: plan([]), stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]) })
  assert.deepEqual(d, { kind: 'fallback', code: 'guard-trivial' })
})

test('影子期跳过白名单，bash 候选可被提交', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'bash', args: { command: 'ls' }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]), shadow: true,
  })
  assert.deepEqual(d, { kind: 'commit', candidateId: 'A', args: { command: 'ls' } })
})

test('影子期仍过滤平凡守卫（bash 平凡候选 → guard-trivial）', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'bash', args: { command: 'ls' }, guards: [{ ok: true }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]), shadow: true,
  })
  assert.deepEqual(d, { kind: 'fallback', code: 'guard-trivial' })
})

test('$public 歧义候选被淘汰，不中断其它合格候选', () => {
  const d = decide({
    plan: plan([
      // 绑定歧义且守卫也会失败：绑定先淘汰，两者都只是「少一个候选」，无独立回退码。
      { id: 'A', tool: 'read', args: { path: { $public: { after: 'root', field: 'name' } } }, guards: [{ text_contains: 'nope' }] },
      { id: 'B', tool: 'read', args: { path: '/b' }, guards: [{ text_contains: 'x' }] },
    ]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]),
  })
  assert.deepEqual(d, { kind: 'commit', candidateId: 'B', args: { path: '/b' } })
})

test('一个候选守卫失败、另一个合格 → commit 合格者', () => {
  const d = decide({
    plan: plan([
      { id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ text_contains: 'nope' }] },
      { id: 'B', tool: 'grep', args: { pattern: 'p' }, guards: [{ text_contains: 'x' }] },
    ]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]),
  })
  assert.deepEqual(d, { kind: 'commit', candidateId: 'B', args: { pattern: 'p' } })
})

test('两个同内容不同 id 的候选都合格 → ask-selector 含两者且是新数组', () => {
  const args = { path: '/same' }
  const p = plan([
    { id: 'A', tool: 'read', args, guards: [{ text_contains: 'x' }] },
    { id: 'B', tool: 'read', args, guards: [{ text_contains: 'x' }] },
  ])
  const d = decide({ plan: p, stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]) })
  assert.equal(d.kind, 'ask-selector')
  if (d.kind === 'ask-selector') {
    assert.deepEqual(d.candidates.map((c) => c.id), ['A', 'B'])
    assert.notEqual(d.candidates, p.steps)
  }
})

test('ask-selector 携带已绑定参数，plan 原件保持模板不变', () => {
  const template = (field: string) => ({ $public: { after: 'root', field } })
  const a = { id: 'A', tool: 'read', args: { path: template('path') }, guards: [{ text_contains: 'path:' }] }
  const b = { id: 'B', tool: 'read', args: { path: template('name') }, guards: [{ text_contains: 'name:' }] }
  const p = plan([a, b])
  const d = decide({
    plan: p, stepId: 'root', whitelist: WL,
    receipts: new Map([['root', rc('path: "/from-root"\nname: "/other"')]]),
  })
  assert.equal(d.kind, 'ask-selector')
  if (d.kind === 'ask-selector') {
    // 每个候选带着绑定后的参数，且是新的对象（原件不被改写）。
    assert.deepEqual(d.candidates.map((c) => c.args), [{ path: '/from-root' }, { path: '/other' }])
    assert.notEqual(d.candidates[0], a)
    assert.notEqual(d.candidates[1], b)
    // guards 及其中的 guard 对象也不能与 plan 共享：调用方改 guard 不能改到计划。
    assert.notEqual(d.candidates[0].guards, a.guards)
    assert.notEqual(d.candidates[0].guards[0], a.guards[0])
    d.candidates[0].guards[0] = { ok: true }
    assert.deepEqual(a.guards, [{ text_contains: 'path:' }])
  }
  assert.deepEqual(a.args, { path: template('path') })
  assert.deepEqual(b.args, { path: template('name') })
})

test('错误回执只让 ok 守卫失败：text_contains 仍按原文判定', () => {
  const errored = { text: 'x', isError: true, empty: false, textBlocks: 1 }
  const textOnly = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', errored]]),
  })
  assert.deepEqual(textOnly, { kind: 'commit', candidateId: 'A', args: { path: '/a' } })

  const layered = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ ok: true }, { text_contains: 'x' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', errored]]),
  })
  assert.deepEqual(layered, { kind: 'fallback', code: 'no-candidate' })
})

test('守卫只读 stepId 对应回执，不读其它节点', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ text_contains: 'nope' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')], ['A', rc('nope')]]),
  })
  assert.deepEqual(d, { kind: 'fallback', code: 'no-candidate' })
})

test('stepId 回执缺失时无候选（不猜）', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map(),
  })
  assert.deepEqual(d, { kind: 'fallback', code: 'no-candidate' })
})

test('decide 不修改 plan 参数', () => {
  const p = plan([{ id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ text_contains: 'x' }] }])
  const snapshot = structuredClone(p)
  decide({ plan: p, stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]) })
  assert.deepEqual(p, snapshot)
})
