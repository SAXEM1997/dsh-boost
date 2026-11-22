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
  draftOf,
  isDirty,
  isTicked,
  patchOf,
  unmatchedDraftIds,
  seedOf,
  staleWorkspaceIds,
  toggleTicked,
  type ScopeDraft,
} from '../ui/src/draft.ts'

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

test('staleWorkspaceIds 只看已保存的文档', () => {
  const seed = seedOf(doc({ workspaceIds: ['ws-1', 'ws-gone'] }))
  assert.deepEqual(staleWorkspaceIds(seed, listing('ws-1')), ['ws-gone'])
})

test('unmatchedDraftIds 只看草稿，两者不互换', () => {
  const seed = seedOf(doc({ workspaceIds: ['ws-1', 'ws-gone'] }))
  assert.ok(seed !== undefined)
  const draft: ScopeDraft = { ...draftOf(seed), workspaceIds: ['ws-1', 'ws-new'] }
  // The saved-but-unknown id stays in the first list even after it is unticked.
  assert.deepEqual(staleWorkspaceIds(seed, listing('ws-1')), ['ws-gone'])
  assert.deepEqual(unmatchedDraftIds(draft, listing('ws-1')), ['ws-new'])
})

test('注册表不可用时两个诊断都空，不假装"没有不匹配"', () => {
  const seed = seedOf(doc({ workspaceIds: ['ws-gone'] }))
  assert.ok(seed !== undefined)
  const unavailable = { available: false as const, code: 'ERR_HTTP_WORKSPACES_UNAVAILABLE' }
  assert.deepEqual(staleWorkspaceIds(seed, unavailable), [])
  assert.deepEqual(unmatchedDraftIds(draftOf(seed), unavailable), [])
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
