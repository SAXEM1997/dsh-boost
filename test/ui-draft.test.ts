/**
 * The form's rules, at the seam the page uses them through (spec S-3).
 *
 * These are the statements the ticket makes about the form — three independent
 * disable sources, two kinds of workspace diagnostic, two different empty
 * states — so each one is pinned here rather than inferred from JSX.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  disableReasons,
  distillStateOf,
  draftOf,
  groupCounts,
  isDirty,
  isTicked,
  patchOf,
  removeWorkspaceId,
  seedOf,
  staleWorkspaceIds,
  toggleTicked,
} from '../ui/src/draft.ts'
import type { BoostConfig } from '../src/types.ts'

const doc = (over: Record<string, unknown> = {}) => ({
  ok: true as const,
  data: {
    version: 2,
    revision: 3,
    mode: 'selected',
    workspaceIds: ['ws-1'],
    shadow: true,
    projection: 'shadow',
    ...over,
  },
})

const listing = (...ids: string[]) => ({
  available: true as const,
  entries: ids.map(id => ({ id, path: `/w/${id}` })),
})

test('seedOf 读得出四字段与 revision', () => {
  const seed = seedOf(doc())
  assert.ok(seed !== undefined)
  assert.equal(seed.revision, 3)
  assert.deepEqual(seed.workspaceIds, ['ws-1'])
})

test('seedOf 对读不出来的文档返回 undefined，不编默认值', () => {
  assert.equal(seedOf({ ok: false, code: 'ERR_SCOPE_PARSE_FAILED' }), undefined)
  assert.equal(seedOf(doc({ revision: 'three' })), undefined)
  assert.equal(seedOf(doc({ mode: 'everything' })), undefined)
  assert.equal(seedOf(doc({ workspaceIds: [1] })), undefined)
})

test('isDirty 认得四个字段各自的改动', () => {
  const seed = seedOf(doc())
  assert.ok(seed !== undefined)
  const base = draftOf(seed)
  assert.equal(isDirty(base, seed), false)
  for (const change of [
    { mode: 'global' as const },
    { shadow: false },
    { projection: 'on' as const },
    { workspaceIds: [] },
  ]) {
    assert.equal(isDirty({ ...base, ...change }, seed), true, JSON.stringify(change))
  }
})

test('三个禁用来源各自独立，且可以同时出现', () => {
  const versionOnly = disableReasons(
    { ok: false, code: 'ERR_SCOPE_UNKNOWN_VERSION' },
    listing('ws-1'),
  )
  // A version failure is its own reason, not also "unreadable": the two are
  // disjoint, so the operator is told to upgrade rather than to check perms.
  assert.deepEqual(versionOnly.map(reason => reason.id), ['version-unsupported'])
  assert.equal(versionOnly[0]?.code, 'ERR_SCOPE_UNKNOWN_VERSION')

  const readOnly = disableReasons({ ok: false, code: 'ERR_SCOPE_READ_FAILED' }, listing('ws-1'))
  assert.deepEqual(readOnly.map(reason => reason.id), ['not-writable'])
  assert.equal(readOnly[0]?.code, 'ERR_SCOPE_READ_FAILED')

  const workspacesOnly = disableReasons(doc(), { available: false, code: 'ERR_HTTP_WORKSPACES_UNAVAILABLE' })
  assert.deepEqual(workspacesOnly.map(reason => reason.id), ['workspaces-unavailable'])

  const both = disableReasons(
    { ok: false, code: 'ERR_SCOPE_UNKNOWN_VERSION' },
    { available: false, code: 'ERR_HTTP_WORKSPACES_UNAVAILABLE' },
  )
  assert.deepEqual(both.map(reason => reason.id), ['version-unsupported', 'workspaces-unavailable'])
})

test('健康的文档与可读的注册表：一个理由都没有', () => {
  assert.deepEqual(disableReasons(doc(), listing('ws-1')), [])
})

test('staleWorkspaceIds 只看草稿，不重复报告已移除的 id', () => {
  const seed = seedOf(doc({ workspaceIds: ['ws-1', 'ws-gone'] }))
  assert.ok(seed !== undefined)
  assert.deepEqual(staleWorkspaceIds(draftOf(seed), listing('ws-1')), ['ws-gone'])
})

test('移除 stale id：草稿丢掉它，下一次保存就带上缩短后的列表', () => {
  const seed = seedOf(doc({ workspaceIds: ['ws-1', 'ws-gone'] }))
  assert.ok(seed !== undefined)
  const workspaces = listing('ws-1')
  const draft = draftOf(seed)
  assert.equal(isDirty(draft, seed), false)

  const removed = removeWorkspaceId(draft, 'ws-gone')
  assert.deepEqual(removed.workspaceIds, ['ws-1'])
  assert.deepEqual(staleWorkspaceIds(removed, workspaces), [], 'the diagnostic follows the draft')
  assert.equal(isDirty(removed, seed), true, 'the removal is a change the save button must see')
  assert.deepEqual(patchOf(removed).workspaceIds, ['ws-1'])
})

test('勾选、取消勾选与移除组合起来，诊断不漂移', () => {
  // The state is produced through the form's own operations, not by
  // hand-building a draft the UI cannot reach.
  const seed = seedOf(doc({ workspaceIds: ['ws-1', 'ws-gone'] }))
  assert.ok(seed !== undefined)
  const workspaces = listing('ws-1', 'ws-2')
  const entry = { id: 'ws-2', path: '/w/ws-2' }
  let draft = draftOf(seed)

  draft = toggleTicked(draft, entry)
  assert.deepEqual(staleWorkspaceIds(draft, workspaces), ['ws-gone'])
  draft = toggleTicked(draft, entry)
  assert.deepEqual(staleWorkspaceIds(draft, workspaces), ['ws-gone'])
  draft = removeWorkspaceId(draft, 'ws-gone')
  assert.deepEqual(staleWorkspaceIds(draft, workspaces), [])
  assert.deepEqual(draft.workspaceIds, ['ws-1'])
})

test('移除一个草稿里没有的 id 是幂等的', () => {
  const seed = seedOf(doc())
  assert.ok(seed !== undefined)
  const draft = draftOf(seed)
  assert.deepEqual(removeWorkspaceId(draft, 'ws-never').workspaceIds, draft.workspaceIds)
})

test('注册表不可用时诊断为空，不假装"没有不匹配"', () => {
  const seed = seedOf(doc({ workspaceIds: ['ws-gone'] }))
  assert.ok(seed !== undefined)
  const unavailable = { available: false as const, code: 'ERR_HTTP_WORKSPACES_UNAVAILABLE' }
  assert.deepEqual(staleWorkspaceIds(draftOf(seed), unavailable), [])
})

test('patchOf 只带四个可写字段', () => {
  const seed = seedOf(doc())
  assert.ok(seed !== undefined)
  const patch = patchOf(draftOf(seed))
  assert.deepEqual(Object.keys(patch).sort(), ['mode', 'projection', 'shadow', 'workspaceIds'])
})

test('勾选按工作区 id，不按路径', () => {
  const entry = { id: 'ws-1', path: '/w/ws-1' }
  const seed = { ...seedOf({ ok: true, data: { version: 2, revision: 3, mode: 'selected', workspaceIds: [], shadow: true, projection: 'shadow' } })! }
  const draft = draftOf(seed)

  // Both fields are strings, so a comparison against the wrong one type-checks.
  assert.equal(isTicked(draft, entry), false)
  const ticked = toggleTicked(draft, entry)
  assert.deepEqual(ticked.workspaceIds, ['ws-1'], 'the id is written, not the path')
  assert.equal(isTicked(ticked, entry), true)

  const unticked = toggleTicked(ticked, entry)
  assert.deepEqual(unticked.workspaceIds, [])
})

// The distill card has three operator facts to tell apart, and the page must
// never collapse the two it cannot answer into "off". This pins the boundary:
// no config = unknown, config without the section = absent (older build), only
// the third can answer whether distillation is on.
test('distillStateOf 区分「不知道」与「这个构建没有该段」', () => {
  assert.equal(distillStateOf(undefined), 'unknown')
  assert.equal(distillStateOf({} as BoostConfig), 'absent')
  assert.equal(distillStateOf({ distillation: null } as unknown as BoostConfig), 'absent')
  assert.equal(distillStateOf({ distillation: 'no' } as unknown as BoostConfig), 'absent')
  assert.equal(distillStateOf({ distillation: { enabled: false } } as unknown as BoostConfig), 'present')
  assert.equal(distillStateOf({ distillation: { enabled: true } } as unknown as BoostConfig), 'present')
})

test('groupCounts 按前缀分组，组内降序，组间顺序固定', () => {
  const groups = groupCounts({
    'skip:no-scope': 9620,
    'projection-skipped:no-spill': 3,
    'substitute-settled': 12,
    'substitute': 4,
    // The two codes that mean the thing happened, and carry no separator.
    'substituted': 5,
    'projected': 3,
    'distill-rejected:not-smaller': 1,
    'guard-trivial': 7,
    'not a number': Number.NaN,
  } as Record<string, number>)

  assert.deepEqual(
    groups.map((group) => group.key),
    ['substitute', 'projection', 'distill', 'skip', 'other'],
  )
  const substitute = groups.find((group) => group.key === 'substitute')
  assert.equal(substitute?.total, 21, 'the group total is the sum of its rows, aliases included')
  const projection = groups.find((group) => group.key === 'projection')
  assert.equal(projection?.total, 6, 'projected is a projection, not an "other"')
  assert.deepEqual(
    substitute?.rows.map((row) => row.code),
    ['substitute-settled', 'substituted', 'substitute'],
    'rows are ordered by count, descending',
  )
  assert.equal(groups.find((group) => group.key === 'skip')?.total, 9620)
  assert.equal(groups.find((group) => group.key === 'other')?.rows[0]?.code, 'guard-trivial')
  assert.equal(
    groups.reduce((sum, group) => sum + group.total, 0),
    9655,
    'a NaN count is dropped, everything else is counted exactly once',
  )
})

test('groupCounts 对空载荷与未知前缀都给出稳定的形状', () => {
  assert.deepEqual(groupCounts({}), [])
  const unknown = groupCounts({ 'weird:prefix': 2 })
  assert.deepEqual(unknown, [
    { key: 'other', total: 2, share: 1, rows: [{ code: 'weird:prefix', count: 2, share: 1 }] },
  ])
})
