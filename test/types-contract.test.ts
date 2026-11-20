/**
 * Finding 5/6/7: the plugin's own host projection must describe the host.
 *
 * These are compile-time assertions with a runtime no-op so a wrong signature
 * fails `npm run typecheck` (the tests themselves do not typecheck), not only
 * a future caller.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  AgentLike,
  PluginContext,
  ResolvedToolSet,
  ToolActivationContext,
} from '../src/types.ts'
import { workspaceIdOf } from '../src/scope/resolve.ts'

test('AgentLike allows a session header without cwd (host SessionHeader.cwd is optional)', () => {
  // `SessionHeader.cwd` is optional in the host; the resolver already fails
  // closed on a missing cwd, so the type must not deny the case.
  const agent: AgentLike = { session: { header: { id: 's1' } } }
  assert.equal(workspaceIdOf(agent, { list: () => [] }), undefined)
})

test('tools.resolve is the host async ResolvedToolSet contract', () => {
  const ctx = {
    tools: {
      resolve: () => Promise.resolve({ dispose() {}, view: () => new Map() }),
    },
  } as unknown as PluginContext
  const call: (context: ToolActivationContext) => Promise<ResolvedToolSet> = ctx.tools.resolve
  assert.equal(typeof call, 'function')
})

test('llm is a soft service, so PluginContext.llm is optional', () => {
  const absent: PluginContext['llm'] = undefined
  assert.equal(absent, undefined)
})
