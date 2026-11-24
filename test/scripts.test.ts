import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { zstdCompressSync } from 'node:zlib'
import { ReceiptStore } from '../src/receipts/store.ts'

const run = promisify(execFile)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Run a delivered script with plain `node` — never tsx — and parse its JSON. */
async function runScript(script: string, args: string[]): Promise<any> {
  const { stdout } = await run(process.execPath, [join(repoRoot, 'scripts', script), ...args], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

const fresh = () => mkdtemp(join(tmpdir(), 'boost-scripts-'))

// ---------------------------------------------------------------------------
// shadow-report.mjs
// ---------------------------------------------------------------------------

test('shadow-report 对存在但为空的收据目录输出四项零值，不抛错', async () => {
  const dir = join(await fresh(), 'receipts')
  await mkdir(dir, { recursive: true })
  const out = await runScript('shadow-report.mjs', ['--dir', dir])
  assert.deepEqual(out, {
    saveableRatio: 0,
    byFamily: {},
    candidateRecall: 0,
    retrievalUpperBound: 0,
  })
})

test('shadow-report 拒绝把不存在的目录报成零结果，除非显式 --allow-empty', async () => {
  const dir = join(await fresh(), 'receipts')
  // A typo in the path must not look like a genuine zero-result shadow week.
  await assert.rejects(
    () => runScript('shadow-report.mjs', ['--dir', dir]),
    /missing directory|--allow-empty/,
  )
  const out = await runScript('shadow-report.mjs', ['--dir', dir, '--allow-empty'])
  assert.deepEqual(out, {
    saveableRatio: 0,
    byFamily: {},
    candidateRecall: 0,
    retrievalUpperBound: 0,
  })
})

test('shadow-report 从真实 ReceiptStore 写出的收据复算四项标签', async () => {
  const root = await fresh()
  const store = new ReceiptStore(root)
  const base = { ts: '2026-11-19T00:00:00.000Z', sessionId: 's1', turn: 1, stepId: 'A' }

  // Three bash decisions, two committed (not whitelisted): the v1 policy can
  // only really save on read/grep/glob, so these commits are not "saveable".
  await store.append({ ...base, kind: 'shadow', code: 'ok', tool: 'bash', decision: 'commit', candidateId: 'A', whitelisted: false, args: {} })
  await store.append({ ...base, kind: 'shadow', code: 'ok', tool: 'bash', decision: 'commit', candidateId: 'B', whitelisted: false, args: {} })
  await store.append({ ...base, kind: 'skip', code: 'guard-trivial', tool: 'bash' })

  // Two read decisions, one committed and whitelisted, one offered candidate
  // that failed binding/guarding (`no-candidate`). The commit's *executed*
  // tool is bash; `candidateTool` names the family the gate decided in, which
  // is what `byFamily` must key on.
  await store.append({ ...base, kind: 'shadow', code: 'ok', tool: 'bash', candidateTool: 'read', decision: 'commit', candidateId: 'C', whitelisted: true, args: {} })
  await store.append({ ...base, kind: 'skip', code: 'no-candidate', tool: 'read' })

  // A retrieval against two applied projections.
  await store.append({ ...base, kind: 'projection', code: 'projected', tool: 'bash', before: 1000, after: 200, saved_projection_tokens: 800, estimate: 'host' })
  await store.append({ ...base, kind: 'projection', code: 'projected', tool: 'read', before: 500, after: 100, saved_projection_tokens: 400, estimate: 'host' })
  await store.append({ ...base, kind: 'projection', code: 'projection-retrieval', tool: 'read', retrieved: true, retrieval_tokens: 50 })

  // Out of scope and reset receipts are not substitution decisions.
  await store.append({ ...base, kind: 'skip', code: 'skip:no-scope', tool: 'bash' })
  await store.append({ ...base, kind: 'reset', code: 'pruned-reset', tool: 'bash' })

  const out = await runScript('shadow-report.mjs', ['--dir', join(root, 'receipts')])
  assert.deepEqual(Object.keys(out).sort(), [
    'byFamily',
    'candidateRecall',
    'retrievalUpperBound',
    'saveableRatio',
  ])
  // 1 whitelisted commit / 5 substitution decisions.
  assert.equal(out.saveableRatio, 1 / 5)
  // Per family: commits / decisions (shadow records potential for every family).
  assert.deepEqual(out.byFamily, {
    bash: { decisions: 3, commits: 2, hitRate: 2 / 3 },
    read: { decisions: 2, commits: 1, hitRate: 1 / 2 },
  })
  // Candidate recall: commits / (commits + offered-but-failed), i.e. the
  // denominator is the candidates the plan offered, not the committed set.
  assert.equal(out.candidateRecall, 3 / 4)
  // Retrieval calls / applied projection receipts.
  assert.equal(out.retrievalUpperBound, 1 / 2)
})

// ---------------------------------------------------------------------------
// session-stats.mjs
// ---------------------------------------------------------------------------

test('session-stats 对固定 snapshot 复算出 §2.1 的 headline 计数', async () => {
  const out = await runScript('session-stats.mjs', [
    '--snapshot',
    join(repoRoot, 'scripts', 'session-snapshot.json'),
  ])
  assert.equal(out.sessionCount, 300)
  assert.equal(out.steps, 54141)
  assert.equal(out.toolCalls, 62624)
  assert.equal(out.requests, 54088)
  assert.equal(out.meanTokensPerRequest, 195531)
  assert.equal(out.meanTokensPerStep, 195340)
  assert.equal(out.cacheHitShare, 0.9701)
  assert.equal(out.callsPerStep.one, 0.798)
  assert.equal(out.callsPerStep.two, 0.158)
  assert.equal(out.receiptChars.p50, 623)
  assert.equal(out.receiptChars.p90, 4572)
  assert.equal(out.receiptChars.p99, 18087)
  assert.equal(out.whitelist.calls, 3562)
  assert.equal(out.whitelist.fullSteps, 2165)
  assert.equal(out.whitelist.singleCallSteps, 1702)
  assert.equal(out.valueTransfer.positions, 45082)
  assert.equal(out.valueTransfer.full, 842)
  assert.equal(out.valueTransfer.partial, 2407)
  assert.equal(out.valueTransfer.rate, 0.0721)
})

test('session-stats --sessions 从真实 session 文件重生 snapshot，--snapshot 可复算同一批计数', async () => {
  const dir = await fresh()
  const sessions = join(dir, 'sessions')

  // Two synthetic sessions in the host's v4 layout. Counts are chosen by hand
  // so every aggregate below can be asserted exactly.
  const usage = (input: number, cache: number, output: number) => ({
    inputTokens: input,
    cacheReadTokens: cache,
    outputTokens: output,
    totalTokens: input + cache + output,
  })
  const sessionA = [
    { type: 'session', version: 4, id: 'session-a', createdAt: Date.parse('2026-11-18T00:00:00Z') },
    { type: 'turn/start', time: 1000, data: { turn: 1 } },
    { type: 'step/start', time: 1100, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: 1200, data: { turn: 1, step: 1, usage: usage(100, 50, 10) } },
    { type: 'tool/call', time: 1300, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"echo hi"}' } },
    { type: 'tool/result', time: 1400, data: { turn: 1, step: 1, toolCallId: 'c1', message: { content: [{ type: 'text', text: 'hello world' }] } } },
    { type: 'step/start', time: 2100, data: { turn: 1, step: 2 } },
    { type: 'assistant/message', time: 2200, data: { turn: 1, step: 2, usage: usage(0, 50, 5) } },
    { type: 'tool/call', time: 2300, data: { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{"path":"hello world"}' } },
    { type: 'tool/result', time: 2400, data: { turn: 1, step: 2, toolCallId: 'c2', message: { content: [{ type: 'text', text: 'done' }] } } },
    { type: 'turn/end', time: 2500, data: { turn: 1 } },
    { type: 'turn/start', time: 3000, data: { turn: 2 } },
    { type: 'step/start', time: 3100, data: { turn: 2, step: 1 } },
    { type: 'assistant/message', time: 3200, data: { turn: 2, step: 1, usage: usage(10, 100, 20) } },
    { type: 'tool/call', time: 3300, data: { turn: 2, step: 1, callId: 'c3', name: 'grep', arguments: '{"pattern":"nomatch"}' } },
    { type: 'tool/result', time: 3400, data: { turn: 2, step: 1, toolCallId: 'c3', message: { content: [{ type: 'text', text: 'x' }] } } },
    { type: 'turn/end', time: 3500, data: { turn: 2 } },
  ]
  const sessionB = [
    { type: 'session', version: 4, id: 'session-b', createdAt: Date.parse('2026-11-18T01:00:00Z') },
    { type: 'turn/start', time: 1000, data: { turn: 1 } },
    { type: 'step/start', time: 1100, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: 1200, data: { turn: 1, step: 1, usage: usage(0, 10, 2) } },
    { type: 'tool/call', time: 1300, data: { turn: 1, step: 1, callId: 'd1', name: 'bash', arguments: '{"command":"true"}' } },
    { type: 'tool/result', time: 1400, data: { turn: 1, step: 1, toolCallId: 'd1', message: { content: [{ type: 'text', text: 'root@host:/tmp# ' }] } } },
    { type: 'step/start', time: 2100, data: { turn: 1, step: 2 } },
    { type: 'assistant/message', time: 2200, data: { turn: 1, step: 2, usage: usage(1, 20, 3) } },
    { type: 'tool/call', time: 2300, data: { turn: 1, step: 2, callId: 'd2', name: 'glob', arguments: '{"pattern":"root@host:/tmp# *.md"}' } },
    { type: 'tool/result', time: 2400, data: { turn: 1, step: 2, toolCallId: 'd2', message: { content: [{ type: 'text', text: '' }] } } },
    { type: 'turn/end', time: 2500, data: { turn: 1 } },
  ]

  await (await import('node:fs/promises')).mkdir(sessions, { recursive: true })
  for (const [id, events] of [['session-a', sessionA], ['session-b', sessionB]] as const) {
    const body = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
    await (await import('node:fs/promises')).mkdir(join(sessions, id), { recursive: true })
    await writeFile(join(sessions, id, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))
  }

  const snapshot = await runScript('session-stats.mjs', ['--sessions', sessions])
  assert.equal(snapshot.sessions.length, 2)
  assert.equal(snapshot.sessions.reduce((sum: number, s: any) => sum + s.steps, 0), 5)
  assert.equal(snapshot.sessions.reduce((sum: number, s: any) => sum + s.toolCalls, 0), 5)

  const snapshotPath = join(dir, 'snapshot.json')
  await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`)
  const recomputed = await runScript('session-stats.mjs', ['--snapshot', snapshotPath])

  assert.equal(recomputed.steps, 5)
  assert.equal(recomputed.toolCalls, 5)
  assert.equal(recomputed.requests, 5)
  assert.equal(recomputed.sessionCount, 2)
  // Tokens: A = 160 + 55 + 130, B = 12 + 24.
  assert.equal(recomputed.totalTokens, 381)
  assert.equal(recomputed.meanTokensPerRequest, Math.round(381 / 5))
  assert.equal(recomputed.meanTokensPerStep, Math.round(381 / 5))
  assert.equal(recomputed.cacheHitShare, 0.6745)
  // Steps: A/1 has bash, A/2 read, A/3 grep, B/1 bash, B/2 glob.
  assert.equal(recomputed.whitelist.calls, 3)
  assert.equal(recomputed.whitelist.fullSteps, 3)
  assert.equal(recomputed.whitelist.singleCallSteps, 3)
  // Two next steps carry an argument: A/2's read path is the whole previous
  // receipt (`hello world`) -> full; B/2's glob pattern `**/*.ts` does not
  // appear in the previous receipt at all -> neither full nor partial, so
  // `partial` stays 0. A's turn-2 grep is the first step of its turn, so it has
  // no previous step to compare against and is not a position.
  // M1's two ceilings, on the same fixture.
  //
  // A/2's `read` takes its whole path from A/1's receipt and it is the only
  // call in that step -> one deterministic continuation (55 tokens). B/2's
  // `glob` pattern is not in B/1's receipt, so it is not one.
  assert.equal(recomputed.continuation.steps, 1)
  assert.equal(recomputed.continuation.tokens, 55)
  // No call repeats the previous step's (tool, canonical args): 0 duplicates.
  assert.equal(recomputed.duplicates.calls, 5)
  assert.equal(recomputed.duplicates.sameStep, 0)
  assert.equal(recomputed.duplicates.acrossStep, 0)

  assert.equal(recomputed.valueTransfer.positions, 2)
  assert.equal(recomputed.valueTransfer.full, 1)
  assert.equal(recomputed.valueTransfer.partial, 0)
  // Receipt sizes are 11, 4, 1, 13, 0.
  assert.equal(recomputed.receiptChars.p50, 4)
  assert.equal(recomputed.receiptChars.over2000Share, 0)
})

test('session-stats --sessions 对空语料拒绝写快照，--allow-empty 才放行', async () => {
  const dir = await fresh()
  const sessions = join(dir, 'sessions')
  await (await import('node:fs/promises')).mkdir(sessions, { recursive: true })

  await assert.rejects(
    () => runScript('session-stats.mjs', ['--sessions', sessions, '--out', join(dir, 'snapshot.json')]),
    (error: any) => {
      assert.equal(error.code, 1)
      assert.match(String(error.stderr), /refusing to write an empty snapshot/)
      return true
    },
  )

  const allowed = await runScript('session-stats.mjs', ['--sessions', sessions, '--allow-empty'])
  assert.equal(allowed.sessions.length, 0)
  assert.equal(allowed.selection.skipped, 0)
})

test('M1 口径：整体绑定才算一次「确定性续跑」，重复按 (tool, 规范化参数) 判', async () => {
  const dir = await fresh()
  const sessions = join(dir, 'sessions')
  const usage = (input: number, cache: number, output: number) => ({
    inputTokens: input,
    cacheReadTokens: cache,
    outputTokens: output,
    totalTokens: input + cache + output,
  })
  // One session that separates the two definitions:
  //   step 1  bash        -> receipt "alpha"
  //   step 2  read alpha  -> bound to step 1        => continuation
  //   step 3  read alpha  -> NOT bound (step 2 said "beta"), and it repeats
  //                          step 2's (tool, args)   => cross-step duplicate
  //   step 4  grep alpha twice -> bound to step 3's "alpha" => continuation,
  //                          and the second call repeats the first
  //                                                  => same-step duplicate
  const events = [
    { type: 'session', version: 4, id: 'session-m1', createdAt: Date.parse('2026-11-18T00:00:00Z') },
    { type: 'turn/start', time: 1000, data: { turn: 1 } },
    { type: 'step/start', time: 1100, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: 1200, data: { turn: 1, step: 1, usage: usage(0, 100, 10) } },
    { type: 'tool/call', time: 1300, data: { turn: 1, step: 1, callId: 'a1', name: 'bash', arguments: '{"command":"cat x"}' } },
    { type: 'tool/result', time: 1400, data: { turn: 1, step: 1, toolCallId: 'a1', message: { content: [{ type: 'text', text: 'alpha' }] } } },
    { type: 'step/start', time: 2100, data: { turn: 1, step: 2 } },
    { type: 'assistant/message', time: 2200, data: { turn: 1, step: 2, usage: usage(0, 200, 20) } },
    { type: 'tool/call', time: 2300, data: { turn: 1, step: 2, callId: 'a2', name: 'read', arguments: '{"path":"alpha"}' } },
    { type: 'tool/result', time: 2400, data: { turn: 1, step: 2, toolCallId: 'a2', message: { content: [{ type: 'text', text: 'beta' }] } } },
    { type: 'step/start', time: 3100, data: { turn: 1, step: 3 } },
    { type: 'assistant/message', time: 3200, data: { turn: 1, step: 3, usage: usage(0, 300, 30) } },
    { type: 'tool/call', time: 3300, data: { turn: 1, step: 3, callId: 'a3', name: 'read', arguments: '{"path":"alpha"}' } },
    { type: 'tool/result', time: 3400, data: { turn: 1, step: 3, toolCallId: 'a3', message: { content: [{ type: 'text', text: 'alpha' }] } } },
    { type: 'step/start', time: 4100, data: { turn: 1, step: 4 } },
    { type: 'assistant/message', time: 4200, data: { turn: 1, step: 4, usage: usage(0, 400, 40) } },
    { type: 'tool/call', time: 4300, data: { turn: 1, step: 4, callId: 'a4', name: 'grep', arguments: '{"pattern":"alpha"}' } },
    { type: 'tool/call', time: 4350, data: { turn: 1, step: 4, callId: 'a5', name: 'grep', arguments: '{"pattern":"alpha"}' } },
    { type: 'tool/result', time: 4400, data: { turn: 1, step: 4, toolCallId: 'a4', message: { content: [{ type: 'text', text: 'alpha' }] } } },
    { type: 'tool/result', time: 4450, data: { turn: 1, step: 4, toolCallId: 'a5', message: { content: [{ type: 'text', text: 'alpha' }] } } },
    // step 5 is half bound: one call takes its argument from step 4, the other
    // takes none. This is the step that tells `every` from `some`.
    { type: 'step/start', time: 5100, data: { turn: 1, step: 5 } },
    { type: 'assistant/message', time: 5200, data: { turn: 1, step: 5, usage: usage(0, 500, 50) } },
    { type: 'tool/call', time: 5300, data: { turn: 1, step: 5, callId: 'a6', name: 'read', arguments: '{"path":"alpha"}' } },
    { type: 'tool/call', time: 5350, data: { turn: 1, step: 5, callId: 'a7', name: 'read', arguments: '{"path":"not-in-any-receipt-at-all"}' } },
    { type: 'tool/result', time: 5400, data: { turn: 1, step: 5, toolCallId: 'a6', message: { content: [{ type: 'text', text: 'six' }] } } },
    { type: 'tool/result', time: 5450, data: { turn: 1, step: 5, toolCallId: 'a7', message: { content: [{ type: 'text', text: 'seven' }] } } },
    { type: 'turn/end', time: 5500, data: { turn: 1 } },
  ]
  const body = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  await (await import('node:fs/promises')).mkdir(join(sessions, 'session-m1'), { recursive: true })
  await writeFile(join(sessions, 'session-m1', 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))

  const snapshot = await runScript('session-stats.mjs', ['--sessions', sessions])
  const stats = snapshot.sessions[0]

  // step 2 (220) and step 4 (440) are whole-step bound. Step 3 is not bound at
  // all, and step 5 is half bound — one unbound call is enough to need the
  // model, which is what separates `every` from `some`.
  assert.equal(stats.continuation.steps, 2, JSON.stringify(stats.continuation))
  assert.equal(stats.continuation.tokens, 220 + 440, JSON.stringify(stats.continuation))
  // 7 calls: one cross-step repeat (step 3 repeats step 2), one same-step
  // repeat (step 4's second grep).
  assert.equal(stats.duplicates.calls, 7, JSON.stringify(stats.duplicates))
  assert.equal(stats.duplicates.acrossStep, 1, JSON.stringify(stats.duplicates))
  assert.equal(stats.duplicates.sameStep, 1, JSON.stringify(stats.duplicates))
})
