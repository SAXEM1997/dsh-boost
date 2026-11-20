/**
 * Gate-3 host-contract and lifecycle fixes, driven through the real preStep
 * order rather than the hand-rolled "request first" shape.
 *
 * The real `dsh-agent-loop` preStep is:
 *   `tools.resolve` -> `systemPrompt.assemble` (section text resolves here)
 *   -> `agent/pre-step` -> later `agent/request` -> `llm/stream`.
 * The fake host in `test/fakes/host.ts` never picked a section by itself; this
 * file drives that order explicitly so a section that is only warm after
 * `agent/request` cannot look correct.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../src/index.ts'
import { SessionRuntime } from '../src/hooks/llm-stream.ts'
import { ScopeStore } from '../src/scope/store.ts'
import { ReceiptStore } from '../src/receipts/store.ts'
import { fakeHost } from './fakes/host.ts'
import type { AgentLike } from '../src/types.ts'

const makeAgent = (id = 's1', cwd = '/w/a'): AgentLike => ({
  session: { header: { id, cwd } },
})

type Applied = {
  host: any
  root: string
  home: string
  services: Map<string, unknown>
  warnings: string[]
  infos: string[]
}

/** Apply the plugin against a fake host whose soft services are a mutable map. */
async function applyHost(options: { config?: unknown; services?: Map<string, unknown> } = {}): Promise<Applied> {
  const home = await mkdtemp(join(tmpdir(), 'boost-g3-'))
  const root = join(home, 'boost')
  const services = options.services ?? new Map<string, unknown>()
  const warnings: string[] = []
  const infos: string[] = []
  const host = fakeHost({
    get: (name: string) => services.get(name),
    logger: { info: (message: string) => infos.push(message), warn: (message: string) => warnings.push(message) },
  })
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    plugin.apply(host as never, options.config ?? {})
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
  return { host, root, home, services, warnings, infos }
}

/** Resolve the section the way `SystemPrompt.assemble` does: text first, then the waterfall. */
async function assemblePrompt(host: any, agent: AgentLike): Promise<any> {
  const section = host.section()
  const assembly = {
    sections:
      section === undefined
        ? []
        : [
            {
              name: section.name,
              text: typeof section.text === 'function' ? section.text({ scope: agent }) : section.text,
            },
          ],
    contexts: [],
    variables: {},
  }
  return host.callHook('system-prompt/assemble', [assembly, { agent, scope: agent }], () => assembly)
}

/** Drive the host's real preStep prefix: tools.resolve, then assemble, then agent/pre-step. */
async function preStep(host: any, agent: AgentLike, turn: number, step: number): Promise<any> {
  const signal = new AbortController().signal
  for (const registration of host.tools.definitions) {
    if (typeof registration.when === 'function') await registration.when({ agent, signal })
  }
  const assembly = await assemblePrompt(host, agent)
  await host.callHook(
    'agent/pre-step',
    [{ agent, messages: [], turn, step, signal }],
    () => ({ kind: 'enter', messages: [] }),
  )
  return assembly
}

/** Fire the deprecated request waterfall the way the host does after preStep. */
async function modelRequest(host: any, agent: AgentLike, turn: number, step: number): Promise<void> {
  await host.callHook(
    'agent/request',
    [{ agent, turn, step, signal: new AbortController().signal }],
    () => ({}),
  )
}

function sectionText(assembly: any): string {
  const section = assembly?.sections?.find((entry: any) => entry?.name === 'dsh-boost')
  return typeof section?.text === 'string' ? section.text : ''
}

async function status(host: any): Promise<any> {
  const registration = host.tools.definitions.find((entry: any) => entry.def?.name === 'boost')
  assert.ok(registration, 'boost tool must be registered')
  const value = await registration.def.execute({ cmd: 'status' }, {})
  assert.equal(value.ok, true, JSON.stringify(value))
  return value.data
}

async function receiptCodes(root: string, sessionId?: string): Promise<string[]> {
  const codes: string[] = []
  for await (const receipt of new ReceiptStore(root).scan(sessionId)) codes.push(receipt.code)
  return codes
}

const GLOBAL_REGISTRY = {
  list: () => [{ id: 'ws-1', path: '/real/w/a' }],
  resolveByPath: async (path: string) => (path.replace(/\/+$/, '') === '/real/w/a' ? { id: 'ws-1' } : undefined),
}

// ---------------------------------------------------------------------------
// C4: soft services resolve lazily, and status exposes the degraded registry.
// ---------------------------------------------------------------------------

test('C4: a workspace registry that appears after apply is retried, not cached as absent', async () => {
  const app = await applyHost()
  await new ScopeStore(app.root).write(doc => ({ ...doc, mode: 'global' }), 0)
  const agent = makeAgent('s1', '/real/w/a')

  // First assembly: the service is not provided yet, so the honest answer is empty.
  const first = await preStep(app.host, agent, 1, 1)
  assert.equal(sectionText(first), '')

  app.services.set('workspaceRegistry', GLOBAL_REGISTRY)
  const second = await preStep(app.host, agent, 1, 2)
  assert.match(sectionText(second), /<CHISEL_PLAN>/, 'a late registry must warm on the next use')
})

test('C4: boost status exposes hasWorkspaceRegistry and recovers when the service appears', async () => {
  const app = await applyHost()
  const before = await status(app.host)
  assert.equal(before.hasWorkspaceRegistry, false)
  assert.ok(before.degraded.includes('ERR_HOST_NO_WORKSPACE_REGISTRY'))

  app.services.set('workspaceRegistry', GLOBAL_REGISTRY)
  const after = await status(app.host)
  assert.equal(after.hasWorkspaceRegistry, true)
  assert.equal(after.degraded.includes('ERR_HOST_NO_WORKSPACE_REGISTRY'), false)
})

test('C4: hasSpill is a live host fact, not a load-time snapshot', async () => {
  const services = new Map<string, unknown>()
  const app = await applyHost({ services })
  await new ScopeStore(app.root).write(doc => ({ ...doc, mode: 'global', projection: 'on' }), 0)

  const before = await status(app.host)
  assert.ok(before.degraded.includes('ERR_HOST_NO_SPILL'))

  services.set('spillStore', {
    async saveText() {
      return { locator: '/spill/x', bytes: 1, retrievalHint: 'read it' }
    },
  })
  const after = await status(app.host)
  assert.equal(after.degraded.includes('ERR_HOST_NO_SPILL'), false)
})

test('C4: tokenMeter is retried and status flips estimate_kind to host', async () => {
  const app = await applyHost()
  const before = await status(app.host)
  assert.ok(before.degraded.includes('ERR_HOST_NO_TOKENMETER'))
  assert.equal(before.estimate_kind, 'unknown')

  app.services.set('tokenMeter', { estimateMessage: () => 7 })
  const after = await status(app.host)
  assert.equal(after.estimate_kind, 'host')
  assert.equal(after.degraded.includes('ERR_HOST_NO_TOKENMETER'), false)
})

// ---------------------------------------------------------------------------
// I1: the protocol section must exist on request 1 and never flip later.
// ---------------------------------------------------------------------------

test('I1: request 1 already carries the protocol and request 2 reproduces it byte-for-byte', async () => {
  const app = await applyHost()
  await new ScopeStore(app.root).write(doc => ({ ...doc, mode: 'global' }), 0)
  app.services.set('workspaceRegistry', GLOBAL_REGISTRY)
  const agent = makeAgent('s1', '/real/w/a')

  const first = await preStep(app.host, agent, 1, 1)
  const firstText = sectionText(first)
  assert.match(firstText, /<CHISEL_PLAN>/, 'the gate must be taught before it can decide step 1')

  await modelRequest(app.host, agent, 1, 1)
  const second = await preStep(app.host, agent, 1, 2)
  assert.equal(sectionText(second), firstText, 'a mid-session prompt flip invalidates the cached prefix')
})

// ---------------------------------------------------------------------------
// I5: the integration site must carry the canonical workspace id into the map.
// ---------------------------------------------------------------------------

test('I5: a symlinked cwd is visible to the decision path, not skip:no-scope', async () => {
  const app = await applyHost()
  await new ScopeStore(app.root).write(doc => ({ ...doc, mode: 'global' }), 0)
  app.services.set('workspaceRegistry', GLOBAL_REGISTRY)
  const agent = makeAgent('s1', '/real/w/a/')

  await preStep(app.host, agent, 1, 1)
  await app.host.callHook(
    'tools/post-execute',
    [
      { name: 'read', callId: 'c1', agent, arguments: { file_path: '/real/w/a/f' } },
      { content: [{ type: 'text', text: 'small' }] },
    ],
    () => ({ kind: 'accept', content: [{ type: 'text', text: 'small' }] }),
  )

  assert.deepEqual(await receiptCodes(app.root, 's1'), [])
})

// ---------------------------------------------------------------------------
// I6: the clock lives on the non-deprecated pre-step seam; event loss is loud.
// ---------------------------------------------------------------------------

test('I6: agent/pre-step drives the clock when agent/request is absent', async () => {
  const app = await applyHost() // no registry: fail-closed, but the clock still runs
  const agent = makeAgent()

  await preStep(app.host, agent, 3, 2)
  await app.host.callHook(
    'tools/post-execute',
    [{ name: 'read', callId: 'c1', agent, arguments: {} }, { content: [{ type: 'text', text: 'x' }] }],
    () => ({ kind: 'accept' }),
  )

  const receipts: any[] = []
  for await (const receipt of new ReceiptStore(app.root).scan('s1')) receipts.push(receipt)
  const skip = receipts.find(receipt => receipt.code === 'skip:no-scope')
  assert.equal(skip?.turn, 3, 'the receipt turn must come from the pre-step clock')
})

test('I6: a missing agent/request is detected and logged once with a stable code', async () => {
  const app = await applyHost()
  const agent = makeAgent()
  await preStep(app.host, agent, 1, 1)

  app.host.stream('s1')
  const first = app.warnings.filter(message => message.includes('ERR_HOST_NO_AGENT_REQUEST'))
  assert.equal(first.length, 1, JSON.stringify(app.warnings))

  // Once the event is observed, the detector must not keep warning.
  await modelRequest(app.host, agent, 1, 2)
  app.host.stream('s1')
  assert.equal(app.warnings.filter(message => message.includes('ERR_HOST_NO_AGENT_REQUEST')).length, 1)
})

// ---------------------------------------------------------------------------
// I-4: the promised turn-end durability must have a real caller.
// ---------------------------------------------------------------------------

/** Fail one receipt append so the store buffers it in memory. */
async function bufferOneReceipt(app: Applied): Promise<void> {
  await mkdir(app.root, { recursive: true })
  await writeFile(join(app.root, 'receipts'), 'not a directory')
  await app.host.callHook(
    'tools/post-execute',
    [{ name: 'read' }, { content: [{ type: 'text', text: 'x' }] }],
    () => ({ kind: 'accept' }),
  )
  await unlink(join(app.root, 'receipts'))
}

test('I-4: turn/end flushes the buffered receipt', async () => {
  const app = await applyHost()
  await bufferOneReceipt(app)
  await app.host.callHook(
    'session/event',
    [{ header: { id: 's1' } }, { type: 'turn/end', data: { turn: 1 } }],
    () => {},
  )
  assert.equal(await new ReceiptStore(app.root).count(''), 1, 'turn/end did not flush')
})

test('I-4: the host session/flush checkpoint flushes the buffered receipt', async () => {
  const app = await applyHost()
  await bufferOneReceipt(app)
  await app.host.callHook('session/flush', [{ header: { id: 's1' } }], () => {})
  assert.equal(await new ReceiptStore(app.root).count(''), 1, 'session/flush did not flush')
})

test('I-4: session disposal flushes before evicting state', async () => {
  const app = await applyHost()
  await bufferOneReceipt(app)
  await app.host.callHook('session/disposed', [{ header: { id: 's1' } }], () => {})
  assert.equal(await new ReceiptStore(app.root).count(''), 1, 'session/disposed did not flush')
})

test('I-4: a non-turn session event does not flush (the seam is turn-end specific)', async () => {
  const app = await applyHost()
  await mkdir(app.root, { recursive: true })
  await writeFile(join(app.root, 'receipts'), 'not a directory')
  await app.host.callHook(
    'tools/post-execute',
    [{ name: 'read' }, { content: [{ type: 'text', text: 'x' }] }],
    () => ({ kind: 'accept' }),
  )
  await unlink(join(app.root, 'receipts'))

  await app.host.callHook('session/event', [{ header: { id: 's1' } }, { type: 'turn/start', data: { turn: 2 } }], () => {})
  assert.equal(await new ReceiptStore(app.root).count(''), 0)
})

// ---------------------------------------------------------------------------
// I-7: a hook that lands after disposal must record nothing.
// ---------------------------------------------------------------------------

test('I-7: session disposal evicts the judgement cache through the store seam', async () => {
  const calls: string[] = []
  const original = ScopeStore.prototype.forget
  ScopeStore.prototype.forget = function forget(key: string) {
    calls.push(key)
    return original.call(this, key)
  }
  try {
    const app = await applyHost()
    await app.host.callHook('session/disposed', [{ header: { id: 's1' } }], () => {})
  } finally {
    ScopeStore.prototype.forget = original
  }
  assert.deepEqual(calls, ['s1'])
})

test('I-7: a late hook does not recreate the disposed session runtime', async () => {
  const original = SessionRuntime.prototype.clockFor
  const calls: string[] = []
  SessionRuntime.prototype.clockFor = function clockFor(sessionId: string) {
    calls.push(sessionId)
    return original.call(this, sessionId)
  }
  try {
    const app = await applyHost()
    const agent = makeAgent()
    await app.host.callHook('session/disposed', [{ header: { id: 's1' } }], () => {})

    // The late hook is fail-closed on visibility checked before any clock read,
    // so clockTurnOf still asks the runtime for the disposed id.
    calls.length = 0
    await app.host.callHook(
      'tools/post-execute',
      [{ name: 'read', callId: 'late', agent, arguments: {} }, { content: [{ type: 'text', text: 'late' }] }],
      () => ({ kind: 'accept' }),
    )
    assert.deepEqual(calls, [], 'the disposed runtime must not be recreated')
  } finally {
    SessionRuntime.prototype.clockFor = original
  }
})

test('I-7: a post-execute landing after session disposal records no receipt', async () => {
  const app = await applyHost()
  await new ScopeStore(app.root).write(doc => ({ ...doc, mode: 'global' }), 0)
  app.services.set('workspaceRegistry', GLOBAL_REGISTRY)
  const agent = makeAgent()

  await preStep(app.host, agent, 1, 1)
  await app.host.callHook('session/disposed', [{ header: { id: 's1' } }], () => {})

  // The late hook sees a cleared judgement (fail-closed) and tries to record a
  // skip receipt; the disposed gate must drop it instead of recreating state.
  await app.host.callHook(
    'tools/post-execute',
    [{ name: 'read', callId: 'late', agent, arguments: {} }, { content: [{ type: 'text', text: 'late' }] }],
    () => ({ kind: 'accept' }),
  )
  assert.equal(await new ReceiptStore(app.root).count('s1'), 0)
})

// ---------------------------------------------------------------------------
// I-9: historyTurns becomes a production input through the status horizon.
// ---------------------------------------------------------------------------

test('I-9: five measured turns change projection_horizon_steps from 20 to the mean', async () => {
  const app = await applyHost()
  const agent = makeAgent()
  for (let turn = 1; turn <= 5; turn += 1) {
    for (let step = 1; step <= 3; step += 1) await preStep(app.host, agent, turn, step)
  }
  await preStep(app.host, agent, 6, 1)

  const data = await status(app.host)
  assert.equal(data.projection_horizon_steps, 3)
})

test('minor: apply logs the resolved configuration once', async () => {
  const app = await applyHost({ config: { stepsPerTurn: 4 } })
  const lines = app.infos.filter(message => message.includes('effective config'))
  assert.equal(lines.length, 1, JSON.stringify(app.infos))
  assert.match(lines[0], /"stepsPerTurn":4/)
})
