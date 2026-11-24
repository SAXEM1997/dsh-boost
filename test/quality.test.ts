import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { zstdCompressSync } from 'node:zlib'

const run = promisify(execFile)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

async function runScript(script: string, args: string[]): Promise<any> {
  const { stdout } = await run(process.execPath, [join(repoRoot, 'scripts', script), ...args], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

const fresh = () => mkdtemp(join(tmpdir(), 'boost-quality-'))

/** Write one v4 session log; `calls` are `[name, argsObject]` pairs in order. */
async function writeSession(
  root: string,
  id: string,
  calls: [string, Record<string, unknown>][],
): Promise<void> {
  const events: unknown[] = [
    { type: 'session', version: 4, id, createdAt: 1_700_000_000_000 },
    { type: 'user/message', time: 900, data: { content: [{ type: 'text', text: `run ${id}` }] } },
  ]
  calls.forEach(([name, args], index) => {
    events.push({
      type: 'tool/call',
      time: 1000 + index,
      data: { turn: 1, step: index + 1, callId: `c${index}`, name, arguments: JSON.stringify(args) },
    })
  })
  const body = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))
}

// ---------------------------------------------------------------------------
// quality-tasks.mjs
// ---------------------------------------------------------------------------

test('quality-tasks 只认验证命令，并标出它是否是会话的最后一个调用', async () => {
  const dir = await fresh()
  const sessions = join(dir, 'sessions')
  // Ends on a verification command: replayable as a whole task.
  await writeSession(sessions, 'final-verdict', [
    ['read', { path: 'a.ts' }],
    ['bash', { command: 'npm test' }],
  ])
  // Runs one, then keeps working: the verdict is not the terminal state.
  await writeSession(sessions, 'mid-verdict', [
    ['bash', { command: 'npm run typecheck 2>&1 | tail -5' }],
    ['bash', { command: 'git status --porcelain' }],
  ])
  // No verification command at all.
  await writeSession(sessions, 'no-verdict', [['read', { path: 'b.ts' }]])

  const out = await runScript('quality-tasks.mjs', ['--sessions', sessions])
  assert.equal(out.sessions, 3)
  assert.deepEqual(
    out.tasks.map((task: any) => [task.sessionId, task.command, task.isFinal, task.task, task.taskTruncated]),
    [
      ['final-verdict', 'npm test', true, 'run final-verdict', false],
      ['mid-verdict', 'npm run typecheck 2>&1 | tail -5', false, 'run mid-verdict', false],
    ],
  )
})

test('quality-tasks 的 isFinal 看全部调用，不只是带 command 的那些', async () => {
  const dir = await fresh()
  const sessions = join(dir, 'sessions')
  // A verdict followed by a `read` carries no command, but it still means the
  // session did not stop on the verdict — the task is not replayable as a whole.
  await writeSession(sessions, 'verdict-then-read', [
    ['bash', { command: 'npm test' }],
    ['read', { path: 'a.ts' }],
  ])
  const out = await runScript('quality-tasks.mjs', ['--sessions', sessions])
  assert.equal(out.tasks.length, 1)
  assert.equal(out.tasks[0].isFinal, false, JSON.stringify(out.tasks[0]))
  assert.equal(out.tasks[0].totalCalls, 2)
})

test('quality-tasks 没有用户消息时给 task: null，而不是丢掉这个键', async () => {
  const dir = await fresh()
  const sessions = join(dir, 'sessions')
  const events = [
    { type: 'session', version: 4, id: 'no-user', createdAt: 1_700_000_000_000 },
    { type: 'tool/call', time: 1000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' } },
  ]
  const body = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  await mkdir(join(sessions, 'no-user'), { recursive: true })
  await writeFile(join(sessions, 'no-user', 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))

  const out = await runScript('quality-tasks.mjs', ['--sessions', sessions])
  assert.equal(out.tasks[0].task, null)
  assert.equal(out.tasks[0].taskTruncated, false)
  assert.ok(Object.hasOwn(out.tasks[0], 'task'), 'the key must be present so a reader can tell “none” from “forgot”')
})

test('quality-tasks 在目录里没有候选时输出空列表而不是抛错', async () => {
  const dir = await fresh()
  const sessions = join(dir, 'sessions')
  await writeSession(sessions, 'nothing', [['read', { path: 'c.ts' }]])
  const out = await runScript('quality-tasks.mjs', ['--sessions', sessions])
  assert.deepEqual(out.tasks, [])
})

test('quality-tasks 对不存在的目录以非零退出并说明原因', async () => {
  await assert.rejects(
    run(process.execPath, [join(repoRoot, 'scripts', 'quality-tasks.mjs'), '--sessions', '/nonexistent/x'], {
      cwd: repoRoot,
    }),
    (error: any) => error.code === 2 && /cannot read --sessions/.test(error.stderr),
  )
})

// ---------------------------------------------------------------------------
// quality-compare.mjs
// ---------------------------------------------------------------------------

async function writeRuns(dir: string, name: string, rows: unknown[]): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, `${JSON.stringify(rows)}\n`)
  return path
}

test('quality-compare 报一致率、列出不一致的样本，并在样本不足时拒绝下结论', async () => {
  const dir = await fresh()
  const baseline = await writeRuns(dir, 'a.json', [
    { id: 't1', ok: true, tokens: 100 },
    { id: 't2', ok: true, tokens: 200 },
    { id: 't3', ok: false, tokens: 300 },
  ])
  const treatment = await writeRuns(dir, 'b.json', [
    { id: 't1', ok: true, tokens: 80 },
    { id: 't2', ok: false, tokens: 150 },
    { id: 't4', ok: true, tokens: 400 },
  ])
  const out = await runScript('quality-compare.mjs', ['--baseline', baseline, '--treatment', treatment])

  // t1 and t3 pair up? t3 has no treatment run, so only t1/t2 are compared.
  assert.equal(out.compared, 2)
  assert.equal(out.agree, 1)
  assert.equal(out.disagree, 1)
  assert.equal(out.agreementRate, 0.5)
  // Two paired runs carry tokens: t1 (80 - 100) and t2 (150 - 200).
  assert.equal(out.tokenPairs, 2)
  assert.equal(out.tokenDelta, -70)
  assert.deepEqual(out.mismatches, [{ id: 't2', baseline: true, treatment: false }])
  assert.deepEqual(out.missing, { baselineOnly: ['t3'], treatmentOnly: ['t4'] })
  assert.equal(out.minPairs, 12)
  assert.equal(out.conclusion, 'insufficient-pairs')
})

test('quality-compare 在样本足够且无差异时给出 no-difference-observed', async () => {
  const dir = await fresh()
  const rows = Array.from({ length: 12 }, (_, index) => ({ id: `t${index}`, ok: true }))
  const baseline = await writeRuns(dir, 'a.json', rows)
  const treatment = await writeRuns(dir, 'b.json', rows)
  const out = await runScript('quality-compare.mjs', ['--baseline', baseline, '--treatment', treatment])
  assert.equal(out.compared, 12)
  assert.equal(out.agreementRate, 1)
  // No tokens reported anywhere: `null`, never 0 — an unmeasured delta is not
  // "no change".
  assert.equal(out.tokenDelta, null)
  assert.equal(out.conclusion, 'no-difference-observed')
})

test('quality-compare 拒绝非正整数的 --min-pairs（0 会让一对就下结论）', async () => {
  const dir = await fresh()
  const baseline = await writeRuns(dir, 'a.json', [{ id: 't1', ok: true }])
  const treatment = await writeRuns(dir, 'b.json', [{ id: 't1', ok: true }])
  await assert.rejects(
    run(process.execPath, [
      join(repoRoot, 'scripts', 'quality-compare.mjs'),
      '--baseline', baseline,
      '--treatment', treatment,
      '--min-pairs', '0',
    ], { cwd: repoRoot }),
    (error: any) => error.code === 2 && /positive integer/.test(error.stderr),
  )
})

test('quality-compare 接受带 runs 键的对象，并对缺 id / 非布尔 ok 报错', async () => {
  const dir = await fresh()
  const baseline = join(dir, 'a.json')
  await writeFile(baseline, `${JSON.stringify({ runs: [{ id: 't1', ok: true }] })}\n`)
  const treatment = await writeRuns(dir, 'b.json', [{ id: 't1', ok: true }])
  const out = await runScript('quality-compare.mjs', ['--baseline', baseline, '--treatment', treatment])
  assert.equal(out.compared, 1)

  const bad = await writeRuns(dir, 'bad.json', [{ id: '', ok: true }])
  await assert.rejects(
    run(process.execPath, [join(repoRoot, 'scripts', 'quality-compare.mjs'), '--baseline', bad, '--treatment', treatment], {
      cwd: repoRoot,
    }),
    (error: any) => error.code === 2 && /non-empty id/.test(error.stderr),
  )
})
