/**
 * Task 25: the tool-family mapping.
 *
 * The projection whitelist is keyed by family (`read`/`grep`/`glob`/`bash`/
 * `ssh`), but the host decorates MCP tools (`mcp__ssh__execute-command`). A
 * miss silently disables projection for that tool with no error, so the unit
 * mapping is backed by a production projection through the real `apply`: if
 * `post-execute` kept a private copy (or dropped the MCP branch), the decorated
 * ssh receipt would come back unchanged.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import { familyOf } from '../src/tools/family.ts'
import { fakeHost } from './fakes/host.ts'

const SESSION = 's1'
const WORKSPACE = 'w1'
const CWD = '/w'
const agent = { session: { header: { id: SESSION, cwd: CWD } } }
const LOCATOR = '/spill/ssh-1.txt'
type Any = any

function streamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

test('familyOf maps bare host names and the decorated MCP ssh name', () => {
  assert.equal(familyOf('read'), 'read')
  assert.equal(familyOf('grep'), 'grep')
  assert.equal(familyOf('glob'), 'glob')
  assert.equal(familyOf('bash'), 'bash')
  assert.equal(familyOf('ssh'), 'ssh')
  assert.equal(familyOf('mcp__ssh__execute-command'), 'ssh')
  assert.equal(familyOf('web_fetch'), undefined)
  assert.equal(familyOf('mcp__filesystem__read_file'), undefined)
  assert.equal(familyOf('mcp__ssh'), undefined)
  assert.equal(familyOf(''), undefined)
})

test('real apply projects a decorated ssh receipt through the ssh family', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-boost-family-'))
  const root = join(dir, 'boost')
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'scope.json'),
    `${JSON.stringify({
      version: 2,
      revision: 1,
      mode: 'global',
      workspaceIds: [],
      shadow: false,
      projection: 'on',
    })}\n`,
  )

  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const spill = {
    saved: [] as Any[],
    async saveText(input: Any) {
      spill.saved.push(input)
      return { locator: LOCATOR, retrievalHint: 'read it with offset/limit' }
    },
  }
  const host = fakeHost({
    get(name: string) {
      if (name === 'workspaceRegistry') return { list: () => [{ id: WORKSPACE, path: CWD }] }
      if (name === 'spillStore') return spill
      return undefined
    },
    llm: {
      stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        return streamOf([])
      },
    },
  })
  plugin.apply(host, {})
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  })

  await host.callHook(
    'agent/request',
    [{ agent, turn: 1, step: 0, signal: new AbortController().signal }],
    async () => ({ provider: 'p', model: 'm' }),
  )

  const original = `${'line of text\n'.repeat(2000)}END`
  const decision = await host.callHook(
    'tools/post-execute',
    [
      { name: 'mcp__ssh__execute-command', callId: 'ssh-1', agent, arguments: { command: 'cat big.log' } },
      { content: [{ type: 'text', text: original }] },
    ],
    async () => ({ kind: 'accept' }),
  )

  assert.equal(spill.saved.length, 1, 'the ssh family must be configured, not skipped')
  assert.equal(spill.saved[0].source.toolName, 'mcp__ssh__execute-command')
  assert.ok(Array.isArray(decision.content), 'the decorated ssh receipt must be projected')
  assert.ok(decision.content[0].text.length < original.length)
})
