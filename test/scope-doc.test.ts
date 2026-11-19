import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseScope,
  isVisible,
  DEFAULT_SCOPE,
  ERR_SCOPE_UNKNOWN_VERSION,
  ERR_SCOPE_PARSE_FAILED,
  ERR_SCOPE_READ_FAILED,
  ERR_SCOPE_REVISION_CONFLICT,
  ERR_SCOPE_LOCKED,
} from '../src/scope/doc.ts'

test('默认谁都不给', () => {
  assert.deepEqual(DEFAULT_SCOPE.workspaceIds, [])
  assert.equal(isVisible(DEFAULT_SCOPE, 'ws-1'), false)
  assert.equal(isVisible(DEFAULT_SCOPE, undefined), false)
})

test('version 1 只读降级，不抛错（Review Focus #4）', () => {
  const r = parseScope({ version: 1, mode: 'global' })
  assert.equal(r.code, 'ERR_SCOPE_UNKNOWN_VERSION')
  assert.deepEqual(r.doc, DEFAULT_SCOPE)
})

test('非对象 / 数组 / null 判 parse-failed；对象但 version≠2 判 unknown-version（R12）', () => {
  for (const raw of ['not an object', null, [], 42]) {
    assert.equal(parseScope(raw).code, 'ERR_SCOPE_PARSE_FAILED')
  }
  assert.equal(parseScope({ version: 2.1 }).code, 'ERR_SCOPE_UNKNOWN_VERSION')
  assert.equal(parseScope({ mode: 'global' }).code, 'ERR_SCOPE_UNKNOWN_VERSION')
})

test('selected + [ws] 只对该工作区可见', () => {
  const d = { ...DEFAULT_SCOPE, workspaceIds: ['ws-1'] }
  assert.equal(isVisible(d, 'ws-1'), true)
  assert.equal(isVisible(d, 'ws-2'), false)
})

test('global 对任何有 workspace 的 agent 可见，但 undefined 仍不可见', () => {
  const d = { ...DEFAULT_SCOPE, mode: 'global' as const }
  assert.equal(isVisible(d, 'ws-1'), true)
  assert.equal(isVisible(d, undefined), false)
})

test('DEFAULT_SCOPE 逐字符合设计稿 §5.5：selected + []，shadow 与投影默认开启记账', () => {
  assert.deepEqual(DEFAULT_SCOPE, {
    version: 2,
    revision: 0,
    mode: 'selected',
    workspaceIds: [],
    shadow: true,
    projection: 'shadow',
  })
})

test('五个稳定拒绝码常量等于自身字面量（T9 直接引用）', () => {
  assert.equal(ERR_SCOPE_UNKNOWN_VERSION, 'ERR_SCOPE_UNKNOWN_VERSION')
  assert.equal(ERR_SCOPE_PARSE_FAILED, 'ERR_SCOPE_PARSE_FAILED')
  assert.equal(ERR_SCOPE_READ_FAILED, 'ERR_SCOPE_READ_FAILED')
  assert.equal(ERR_SCOPE_REVISION_CONFLICT, 'ERR_SCOPE_REVISION_CONFLICT')
  assert.equal(ERR_SCOPE_LOCKED, 'ERR_SCOPE_LOCKED')
})

test('类型定界先于版本：带 version 的数组仍是 parse-failed，无 version 的对象是 unknown-version', () => {
  const arrayLike = Object.assign([], { version: 2 })
  assert.equal(parseScope(arrayLike).code, 'ERR_SCOPE_PARSE_FAILED')
  assert.equal(parseScope([{ version: 2 }]).code, 'ERR_SCOPE_PARSE_FAILED')
  assert.equal(parseScope(new Date()).code, 'ERR_SCOPE_UNKNOWN_VERSION')
})

test('v2 缺省字段全部按最严一侧补齐', () => {
  const r = parseScope({ version: 2 })
  assert.equal(r.code, undefined)
  assert.deepEqual(r.doc, DEFAULT_SCOPE)
})

test('每次失败都返回 DEFAULT_SCOPE 的独立深拷贝，改写结果不污染常量', () => {
  const first = parseScope(null).doc
  first.mode = 'global'
  first.workspaceIds.push('ws-poisoned')
  first.revision = 99

  const second = parseScope(null).doc
  assert.deepEqual(second, DEFAULT_SCOPE)
  assert.deepEqual(DEFAULT_SCOPE.workspaceIds, [])
  assert.equal(DEFAULT_SCOPE.mode, 'selected')
  assert.equal(DEFAULT_SCOPE.revision, 0)
  assert.notEqual(first, second)
  assert.notEqual(first.workspaceIds, second.workspaceIds)
})

test('成功结果也是独立副本：改写结果不影响下一次解析', () => {
  const first = parseScope({ version: 2, workspaceIds: ['ws-1'] }).doc
  first.workspaceIds.push('ws-2')
  first.mode = 'global'

  const second = parseScope({ version: 2, workspaceIds: ['ws-1'] }).doc
  assert.deepEqual(second.workspaceIds, ['ws-1'])
  assert.equal(second.mode, 'selected')
})

test('非法 mode 一律降级到 selected，合法两个值原样保留', () => {
  for (const mode of ['nope', 'GLOBAL', '', 42, null, undefined, {}, ['global']]) {
    const r = parseScope({ version: 2, mode })
    assert.equal(r.code, undefined)
    assert.equal(r.doc.mode, 'selected')
  }
  assert.equal(parseScope({ version: 2, mode: 'selected' }).doc.mode, 'selected')
  assert.equal(parseScope({ version: 2, mode: 'global' }).doc.mode, 'global')
})

test('workspaceIds 非数组按 []、非字符串成员丢弃，字符串顺序原样保留', () => {
  for (const workspaceIds of ['ws-1', 42, null, {}, { 0: 'ws-1', length: 1 }]) {
    assert.deepEqual(parseScope({ version: 2, workspaceIds }).doc.workspaceIds, [])
  }
  assert.deepEqual(
    parseScope({ version: 2, workspaceIds: ['ws-1', 2, null, 'ws-2', undefined, {}, true] }).doc
      .workspaceIds,
    ['ws-1', 'ws-2'],
  )
})

test('self-review：global + 非数组 workspaceIds 仍放宽到任何已定义 workspace', () => {
  const r = parseScope({ version: 2, mode: 'global', workspaceIds: 'x' })
  assert.equal(r.code, undefined)
  assert.equal(r.doc.mode, 'global')
  assert.deepEqual(r.doc.workspaceIds, [])
  assert.equal(isVisible(r.doc, 'ws-1'), true)
  assert.equal(isVisible(r.doc, undefined), false)
})

test('revision / shadow / projection 严格守卫，合法值原样保留', () => {
  const good = parseScope({
    version: 2,
    revision: 7,
    shadow: false,
    projection: 'on',
    updatedAt: '2026-11-19T00:00:00Z',
  })
  assert.equal(good.code, undefined)
  assert.deepEqual(good.doc, {
    version: 2,
    revision: 7,
    updatedAt: '2026-11-19T00:00:00Z',
    mode: 'selected',
    workspaceIds: [],
    shadow: false,
    projection: 'on',
  })

  for (const projection of ['off', 'shadow', 'on'] as const) {
    assert.equal(parseScope({ version: 2, projection }).doc.projection, projection)
  }
  for (const revision of [0, 7]) {
    assert.equal(parseScope({ version: 2, revision }).doc.revision, revision)
  }
  assert.equal(parseScope({ version: 2, shadow: true }).doc.shadow, true)

  const bad = parseScope({ version: 2, revision: '7', shadow: 'false', projection: 'ON' })
  assert.equal(bad.code, undefined)
  assert.equal(bad.doc.revision, 0)
  assert.equal(bad.doc.shadow, true)
  assert.equal(bad.doc.projection, 'shadow')
})

test('非有限 revision 降级为 0：NaN 与 ±Infinity，含 JSON 的 1e999', () => {
  for (const revision of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(parseScope({ version: 2, revision }).doc.revision, 0)
  }

  const decoded: unknown = JSON.parse('{"version":2,"revision":1e999}')
  assert.deepEqual(decoded, { version: 2, revision: Number.POSITIVE_INFINITY })
  assert.equal(parseScope(decoded).doc.revision, 0)
})

test('updatedAt 只做字符串检查：字符串保留，其他类型丢弃', () => {
  const kept = parseScope({ version: 2, updatedAt: '2026-11-19T00:00:00Z' }).doc
  assert.equal(kept.updatedAt, '2026-11-19T00:00:00Z')
  for (const updatedAt of [42, null, {}, ['x'], true]) {
    assert.equal(Object.hasOwn(parseScope({ version: 2, updatedAt }).doc, 'updatedAt'), false)
  }
})
