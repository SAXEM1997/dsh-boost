import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { runBoost, boostTool } from '../src/tools/boost.ts'
import type { BoostStatus } from '../src/tools/boost.ts'
import { UsageLedger } from '../src/admission/usage.ts'
import { ScopeStore } from '../src/scope/store.ts'
import { ReceiptStore } from '../src/receipts/store.ts'

const deps = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boost-'))
  const receipts = new ReceiptStore(dir)
  return {
    scope: new ScopeStore(dir),
    receipts,
    receiptReadErrors: () => receipts.readErrors(),
    receiptsTruncated: () => receipts.scanTruncated(),
  }
}

/** Same as `deps()`, but keeps the root so a test can plant files the stores read. */
const dirDeps = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boost-'))
  const receipts = new ReceiptStore(dir)
  return {
    dir,
    scope: new ScopeStore(dir),
    receipts,
    receiptReadErrors: () => receipts.readErrors(),
    receiptsTruncated: () => receipts.scanTruncated(),
  }
}

/** Await a status call and narrow the success branch for the assertions below. */
const getStatus = async (d: { scope: ScopeStore; receipts: ReceiptStore }): Promise<BoostStatus> => {
  const r = await runBoost({ args: { cmd: 'status' }, ...d })
  if (!r.ok) throw new Error(`status failed: ${r.code}`)
  return r.data as BoostStatus
}

test('status 输出 shadow 与 projection（否则无法核实）', async () => {
  const d = await deps()
  const r = await runBoost({ args: { cmd: 'status' }, ...d })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal((r.data as any).shadow, true)
    assert.equal((r.data as any).projection, 'shadow')
  }
})

test('receipts_stopped 是活的：收据停写后 status 报 true', async () => {
  const d = await deps()
  const before = await getStatus(d)
  assert.equal(before.receipts_stopped, false)

  // A store that has given up cannot record evidence; the operator must see the
  // numbers are frozen rather than read them as current (design §5.2-3).
  const stopped = new Proxy(d.receipts, {
    get: (target, key, receiver) => (key === 'stopped' ? () => true : Reflect.get(target, key, receiver)),
  })
  const after = await runBoost({ args: { cmd: 'status' }, scope: d.scope, receipts: stopped })
  assert.equal(after.ok, true)
  if (!after.ok) return
  assert.equal((after.data as BoostStatus).receipts_stopped, true)
})

test('estimateKind 不认 chars/4：只有实测或 unknown，不编造数字', async () => {
  const d = await deps()
  const r = await runBoost({
    args: { cmd: 'status' },
    ...d,
    estimateKind: 'chars/4' as never,
  } as never)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal((r.data as BoostStatus).estimate_kind, 'unknown')
})

test('scope-set 带 baseRevision，冲突返回稳定码', async () => {
  const d = await deps()
  await runBoost({ args: { cmd: 'scope-set', body: { mode: 'global' }, baseRevision: 0 }, ...d })
  const r = await runBoost({ args: { cmd: 'scope-set', body: { mode: 'global' }, baseRevision: 0 }, ...d })
  assert.deepEqual(r, { ok: false, code: 'ERR_SCOPE_REVISION_CONFLICT' })
})

test('未知子命令返回稳定码', async () => {
  const d = await deps()
  const r = await runBoost({ args: { cmd: 'nope' as any }, ...d })
  assert.equal(r.ok, false)
})

test('工具定义带宿主必填的 output.render（R32）', async () => {
  const d = await deps()
  const def = boostTool(d)
  assert.equal(def.name, 'boost')
  assert.equal(typeof def.output.render, 'function')
  const [block] = def.output.render({ cmd: 'status' }, { ok: true, data: { shadow: true } })
  assert.ok(block !== undefined)
  assert.equal(block.type, 'text')
  assert.match(block.text, /shadow/)
})

// --- rule 1: the four subcommands and the unknown-command code -------------

test('未知子命令码精确为 ERR_BOOST_UNKNOWN_CMD，缺失 cmd 同样处理', async () => {
  const d = await deps()
  assert.deepEqual(await runBoost({ args: { cmd: 'nope' as any }, ...d }), {
    ok: false,
    code: 'ERR_BOOST_UNKNOWN_CMD',
  })
  assert.deepEqual(await runBoost({ args: {} as any, ...d }), {
    ok: false,
    code: 'ERR_BOOST_UNKNOWN_CMD',
  })
})

test('scope-set 写入 v2 文档并由 store 推进 revision', async () => {
  const d = await deps()
  const r = await runBoost({
    args: { cmd: 'scope-set', body: { mode: 'global', workspaceIds: ['ws-1'] }, baseRevision: 0 },
    ...d,
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const doc = r.data as any
  assert.equal(doc.version, 2)
  assert.equal(doc.revision, 1)
  assert.equal(doc.mode, 'global')
  assert.deepEqual(doc.workspaceIds, ['ws-1'])
  assert.equal(doc.shadow, true)
  assert.equal(doc.projection, 'shadow')
  assert.equal(typeof doc.updatedAt, 'string')
})

test('scope-get 返回 store 读到的完整文档，降级读透出 store 的码', async () => {
  const d = await deps()
  await runBoost({ args: { cmd: 'scope-set', body: { mode: 'global' }, baseRevision: 0 }, ...d })
  const ok = await runBoost({ args: { cmd: 'scope-get' }, ...d })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    const doc = ok.data as any
    assert.equal(doc.version, 2)
    assert.equal(doc.revision, 1)
    assert.equal(doc.mode, 'global')
  }

  const broken = await dirDeps()
  await writeFile(join(broken.dir, 'scope.json'), JSON.stringify({ version: 1, mode: 'global' }))
  assert.deepEqual(await runBoost({ args: { cmd: 'scope-get' }, ...broken }), {
    ok: false,
    code: 'ERR_SCOPE_UNKNOWN_VERSION',
  })
})

// --- rule 2: CAS, reserved fields, no v1-shaped write ----------------------

test('scope-set 拒绝 version / revision 字段且不写盘', async () => {
  for (const body of [
    { version: 1 },
    { version: 2 },
    { revision: 7 },
    { mode: 'global', revision: 1 },
  ]) {
    const d = await dirDeps()
    assert.deepEqual(
      await runBoost({ args: { cmd: 'scope-set', body, baseRevision: 0 }, ...d }),
      { ok: false, code: 'ERR_BOOST_INVALID_BODY' },
      JSON.stringify(body),
    )
    const read = await d.scope.read()
    assert.equal(read.doc.revision, 0, JSON.stringify(body))
    assert.equal(read.doc.mode, 'selected', JSON.stringify(body))
    // A fresh root has no scope.json; that is the clean default, not a
    // degraded read. The invalid body still leaves the document untouched.
    assert.equal(read.degraded, undefined, JSON.stringify(body))
  }
})

test('scope-set 校验字段类型并裁剪未知键', async () => {
  const d = await deps()
  for (const body of [
    { mode: 'nope' },
    { workspaceIds: ['ok', 1] },
    { workspaceIds: 'ws-1' },
    { shadow: 'yes' },
    { projection: 'partial' },
    null,
    [],
    'x',
  ]) {
    assert.deepEqual(
      await runBoost({ args: { cmd: 'scope-set', body, baseRevision: 0 }, ...d }),
      { ok: false, code: 'ERR_BOOST_INVALID_BODY' },
      JSON.stringify(body),
    )
  }

  const ok = await runBoost({
    args: { cmd: 'scope-set', body: { mode: 'global', nonsense: true }, baseRevision: 0 },
    ...d,
  })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal((ok.data as any).nonsense, undefined)
})

test('scope-set 拒绝缺失或非整数的 baseRevision', async () => {
  const d = await deps()
  for (const baseRevision of [undefined, '0', -1, 1.5, null]) {
    assert.deepEqual(
      await runBoost({
        args: { cmd: 'scope-set', body: { mode: 'global' }, baseRevision: baseRevision as any },
        ...d,
      }),
      { ok: false, code: 'ERR_BOOST_INVALID_ARGS' },
      String(baseRevision),
    )
  }
})

test('scope-set 把 version 1 文件显式升级为 v2（store 的既有写路径）', async () => {
  const d = await dirDeps()
  await writeFile(join(d.dir, 'scope.json'), JSON.stringify({ version: 1, mode: 'global' }))
  const r = await runBoost({
    args: { cmd: 'scope-set', body: { mode: 'global', workspaceIds: ['ws-1'] }, baseRevision: 0 },
    ...d,
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal((r.data as any).version, 2)
    assert.equal((r.data as any).revision, 1)
  }
  const after = await d.scope.read()
  assert.equal(after.degraded, undefined)
  assert.equal(after.doc.version, 2)
})

test('shadow 拒绝自动升级 v1：返回 ERR_SCOPE_UNKNOWN_VERSION 且文件逐字保留', async () => {
  const d = await dirDeps()
  const file = join(d.dir, 'scope.json')
  const v1 = {
    version: 1,
    mode: 'global',
    workspaceIds: ['ws-a'],
    shadow: true,
    projection: 'on',
  }
  await writeFile(file, JSON.stringify(v1))

  assert.deepEqual(await runBoost({ args: { cmd: 'shadow', body: false, baseRevision: 0 }, ...d }), {
    ok: false,
    code: 'ERR_SCOPE_UNKNOWN_VERSION',
  })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), v1)
})

test('scope-set 是 v1 的升级路径：只改调用方点名的字段，其余字段保留', async () => {
  const d = await dirDeps()
  const file = join(d.dir, 'scope.json')
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      mode: 'global',
      workspaceIds: ['ws-a', 'ws-b'],
      shadow: false,
      projection: 'on',
    }),
  )

  const r = await runBoost({
    args: { cmd: 'scope-set', body: { projection: 'off' }, baseRevision: 0 },
    ...d,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  if (!r.ok) return
  const doc = r.data as any
  assert.equal(doc.version, 2)
  assert.equal(doc.mode, 'global')
  assert.deepEqual(doc.workspaceIds, ['ws-a', 'ws-b'])
  assert.equal(doc.shadow, false)
  assert.equal(doc.projection, 'off')

  const after = await d.scope.read()
  assert.equal(after.degraded, undefined)
  assert.deepEqual(after.doc, doc)
})

test('scope-set / shadow 拒绝重写 future version 文件，文件逐字保留', async () => {
  const future = {
    version: 3,
    revision: 4,
    mode: 'global',
    workspaceIds: ['future-ws'],
    shadow: false,
    projection: 'on',
    futureField: { keep: true },
  }

  for (const args of [
    { cmd: 'scope-set', body: { mode: 'selected' }, baseRevision: 0 },
    { cmd: 'shadow', body: true, baseRevision: 0 },
  ] as const) {
    const d = await dirDeps()
    const file = join(d.dir, 'scope.json')
    await writeFile(file, JSON.stringify(future))

    assert.deepEqual(await runBoost({ args, ...d }), {
      ok: false,
      code: 'ERR_SCOPE_FUTURE_VERSION',
    })
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), future)

    const read = await runBoost({ args: { cmd: 'scope-get' }, ...d })
    assert.deepEqual(read, { ok: false, code: 'ERR_SCOPE_FUTURE_VERSION' })
  }
})

test('scope-set 原样透出 ERR_SCOPE_LOCKED', async () => {
  const d = await dirDeps()
  await writeFile(
    join(d.dir, 'scope.lock'),
    JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
  )
  assert.deepEqual(
    await runBoost({ args: { cmd: 'scope-set', body: { mode: 'global' }, baseRevision: 0 }, ...d }),
    { ok: false, code: 'ERR_SCOPE_LOCKED' },
  )
})

// --- rule 3: shadow is its own switch, not projection ----------------------

test('shadow 只切换 shadow 而不动 projection，并走 CAS', async () => {
  const d = await deps()
  const r = await runBoost({ args: { cmd: 'shadow', body: false, baseRevision: 0 }, ...d })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal((r.data as any).shadow, false)
    assert.equal((r.data as any).projection, 'shadow')
    assert.equal((r.data as any).revision, 1)
  }

  const status = await getStatus(d)
  assert.equal(status.shadow, false)
  assert.equal(status.projection, 'shadow')

  assert.deepEqual(
    await runBoost({ args: { cmd: 'shadow', body: true, baseRevision: 0 }, ...d }),
    { ok: false, code: 'ERR_SCOPE_REVISION_CONFLICT' },
  )
  assert.deepEqual(await runBoost({ args: { cmd: 'shadow', body: 'on', baseRevision: 1 }, ...d }), {
    ok: false,
    code: 'ERR_BOOST_INVALID_BODY',
  })
})

// --- rule 4: receipt aggregation across every shard -----------------------

test('status 空收据目录返回零账目而不是抛错', async () => {
  const d = await deps()
  const status = await getStatus(d)
  // A null-prototype map so a receipt code of `toString` or `__proto__` is an
  // ordinary key, not a prototype hit.
  assert.equal(Object.getPrototypeOf(status.counts), null)
  assert.equal(Object.keys(status.counts).length, 0)
  assert.deepEqual(status.saved, {
    substitution: 0,
    projectionGross: 0,
    projectionNet: 0,
    retrievalContent: 0,
    retrievalCalls: 0,
    retrievals: 0,
  })
  assert.deepEqual(status.scope, { mode: 'selected', workspaceIds: [], revision: 0 })
  // A fresh root has no scope.json; that is the clean default, not a failure.
  assert.deepEqual(status.degraded, [])
})

test('status 计数跨分片，空 sessionId 的 skip:no-scope 也计入', async () => {
  const d = await deps()
  const ts = new Date().toISOString()
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: '',
    turn: 0,
    kind: 'skip',
    code: 'skip:no-scope',
  })
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'skip',
    code: 'skip:no-scope',
  })
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'shadow',
    code: 'shadow:recorded',
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.counts['skip:no-scope'], 2)
  assert.equal(status.counts['shadow:recorded'], 1)
})

test('status counts 把 toString / __proto__ 当作普通码，不串值也不丢失', async () => {
  const d = await dirDeps()
  await mkdir(join(d.dir, 'receipts'), { recursive: true })
  const lines = ['toString', '__proto__'].map(code =>
    JSON.stringify({
      version: 1,
      ts: new Date().toISOString(),
      sessionId: 'raw',
      turn: 1,
      kind: 'skip',
      code,
      receipt_hash: code,
      preview: '',
    }),
  )
  await writeFile(join(d.dir, 'receipts', 'raw.jsonl'), `${lines.join('\n')}\n`)

  const status = await getStatus(d)
  assert.equal(Object.getPrototypeOf(status.counts), null)
  assert.equal(status.counts['toString'], 1)
  assert.equal(status.counts['__proto__'], 1)
  assert.equal(typeof status.counts['toString'], 'number')
})

test('status 读取轮转的 .1 分片', async () => {
  const d = await dirDeps()
  const receipts = new ReceiptStore(d.dir, { maxLines: 1 })
  const ts = new Date().toISOString()
  await receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'skip',
    code: 'skip:first',
  })
  await receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'skip',
    code: 'skip:second',
  })
  await receipts.flush()

  const status = await getStatus({ scope: d.scope, receipts })
  assert.equal(status.counts['skip:first'], 1)
  assert.equal(status.counts['skip:second'], 1)
})

test('status 替换账只累加 substitute-settled 的数字型 saved_input_tokens', async () => {
  const d = await deps()
  const ts = new Date().toISOString()
  // The synth-time line is written before any measurement exists; design §5.3
  // says the field is measured, so its 'unknown' must not be counted.
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'substitute',
    code: 'substituted',
    saved_input_tokens: 'unknown',
  })
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'substitute-settled',
    code: 'substitute-settled',
    saved_input_tokens: 2000,
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.saved.substitution, 2000)
  // The substitute line stays visible as an event count, not as savings.
  assert.equal(status.counts['substituted'], 1)
})

test('status 同一替换两行都带数字时只计 settle 一行', async () => {
  const d = await deps()
  const ts = new Date().toISOString()
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'substitute',
    code: 'substituted',
    saved_input_tokens: 700,
  })
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'substitute',
    code: 'substituted',
    saved_input_tokens: 500,
  })
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'substitute-settled',
    code: 'substitute-settled',
    saved_input_tokens: 500,
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.saved.substitution, 500, 'one substitution must be counted once')
})

test('row 7: status.saved.substitution_avoided 是下界，缺字段时整键省略', async () => {
  const d = await deps()
  const ts = new Date().toISOString()

  // No receipt carries the lower estimate yet. Reporting `0` would look like a
  // measured "avoided nothing", so the key is omitted instead.
  const empty = await getStatus(d)
  assert.equal(Object.hasOwn(empty.saved, 'substitution_avoided'), false)

  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'substitute-settled',
    code: 'substitute-settled',
    saved_input_tokens: 2000,
    avoided_total_tokens: 1200,
  })
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'substitute-settled',
    code: 'substitute-settled',
    saved_input_tokens: 900,
    avoided_total_tokens: 350,
  })
  // A malformed value is not a measurement and must not enter the sum.
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'substitute-settled',
    code: 'substitute-settled',
    saved_input_tokens: 100,
    avoided_total_tokens: 'unknown',
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  // The upper estimate stays the measured next-request input.
  assert.equal(status.saved.substitution, 3000)
  // The lower estimate is the avoided request's own total (input + cacheRead +
  // output), summed only where a producer recorded it.
  assert.equal(status.saved.substitution_avoided, 1550)
})

test('status 净额 = 非取回毛额回放 − 取回内容回放 − 取回调用一次', async () => {
  const d = await deps()
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projected',
    saved_projection_tokens: 100,
  })
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projection-retrieval',
    retrieved: true,
    retrieval_call_tokens: 10,
    retrieval_content_tokens: 20,
    retrieval_tokens: 30,
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.deepEqual(status.saved, {
    substitution: 0,
    // saved is replay-aware on both fields: 100 * (1 + 20).
    projectionGross: 100 * 21,
    // (100 - 20) * 21 - 10.
    projectionNet: (100 - 20) * 21 - 10,
    retrievals: 1,
    // The two terms the net subtracts, exposed so the number is explainable.
    retrievalContent: 20 * 21,
    retrievalCalls: 10,
  })
  assert.equal(status.projection_gross_tokens, 100)
  assert.equal(status.projection_gross_replay_tokens, 2_100)
  assert.equal(status.projection_retrieval_tokens, 30)
  assert.equal(status.projection_retrieval_content_tokens, 20)
  assert.equal(status.projection_retrieval_call_tokens, 10)
  assert.equal(status.projection_net_tokens, 1_670)
  assert.equal(status.projection_horizon_steps, 20)
})

test('F4 每条投影按自己的 horizon 回放：历史净额不随当前 horizon 跳动', async () => {
  const d = await deps()
  const ts = new Date().toISOString()
  // Two receipts from different moments. One was measured with no remaining
  // steps, the other with three; neither may be re-valued by today's horizon.
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projected',
    unit: 'raw',
    saved_projection_tokens: 100,
    horizon_steps: 0,
  })
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's2',
    turn: 1,
    kind: 'projection',
    code: 'projected',
    unit: 'raw',
    saved_projection_tokens: 100,
    horizon_steps: 3,
  })
  await d.receipts.flush()

  const status = await runBoost({ args: { cmd: 'status' }, ...d, horizonSteps: 20 })
  assert.equal(status.ok, true, JSON.stringify(status))
  if (!status.ok) return
  const data = status.data as BoostStatus
  assert.equal(data.projection_gross_tokens, 200)
  // 100 × (1 + 0) + 100 × (1 + 3); the current horizon of 20 applies to none.
  assert.equal(data.projection_gross_replay_tokens, 500)
  assert.equal(data.saved.projectionGross, 500)
  assert.equal(data.projection_horizon_steps, 20, 'the current horizon is still reported')
  assert.equal(data.projection_horizon_reestimated, 0, 'every receipt carried its own horizon')
})

test('F4 老收据缺 horizon_steps：用当前 horizon 复算并在输出里标明是重估', async () => {
  const d = await deps()
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projected',
    unit: 'raw',
    saved_projection_tokens: 100,
  })
  await d.receipts.flush()

  const status = await runBoost({ args: { cmd: 'status' }, ...d, horizonSteps: 5 })
  assert.equal(status.ok, true, JSON.stringify(status))
  if (!status.ok) return
  const data = status.data as BoostStatus
  assert.equal(data.projection_gross_replay_tokens, 600, '100 × (1 + 5)')
  assert.equal(data.projection_horizon_reestimated, 1, 'the operator must see this was re-estimated')
})

test('F4 当前 horizon 变化只影响缺字段的老收据', async () => {
  const d = await deps()
  const ts = new Date().toISOString()
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projected',
    unit: 'raw',
    saved_projection_tokens: 100,
    horizon_steps: 2,
  })
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's2',
    turn: 1,
    kind: 'projection',
    code: 'projected',
    unit: 'raw',
    saved_projection_tokens: 100,
  })
  await d.receipts.flush()

  const low = await runBoost({ args: { cmd: 'status' }, ...d, horizonSteps: 0 })
  const high = await runBoost({ args: { cmd: 'status' }, ...d, horizonSteps: 10 })
  assert.equal(low.ok && high.ok, true)
  if (!low.ok || !high.ok) return
  const before = low.data as BoostStatus
  const after = high.data as BoostStatus

  // The pinned receipt contributes 300 in both calls; only the legacy one moves.
  assert.equal(before.projection_gross_replay_tokens, 300 + 100)
  assert.equal(after.projection_gross_replay_tokens, 300 + 1_100)
  assert.equal(before.projection_horizon_reestimated, 1)
  assert.equal(after.projection_horizon_reestimated, 1)
})

test('F4 净额按每条取回收据自己的 horizon 回放内容，调用块只收一次', async () => {
  const d = await deps()
  const ts = new Date().toISOString()
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projected',
    unit: 'raw',
    saved_projection_tokens: 100,
    horizon_steps: 0,
  })
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projection-retrieval',
    retrieved: true,
    retrieval_call_tokens: 10,
    retrieval_content_tokens: 20,
    retrieval_tokens: 30,
    horizon_steps: 2,
  })
  await d.receipts.flush()

  const status = await runBoost({ args: { cmd: 'status' }, ...d, horizonSteps: 20 })
  assert.equal(status.ok, true, JSON.stringify(status))
  if (!status.ok) return
  const data = status.data as BoostStatus
  assert.equal(data.projection_gross_replay_tokens, 100, '100 × (1 + 0)')
  // 100 − 20 × (1 + 2) − 10.
  assert.equal(data.projection_net_tokens, 30)
  assert.equal(data.saved.projectionNet, 30)
})

test('unpriced retrieval makes the net unknown instead of free', async () => {
  const d = await deps()
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projected',
    saved_projection_tokens: 100,
  })
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projection-retrieval',
    retrieved: true,
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.saved.projectionGross, 100 * 21)
  assert.equal(status.saved.retrievals, 1)
  assert.equal(status.projection_retrieval_tokens, 0)
  assert.equal(status.projection_unpriced_retrievals, 1)
  assert.equal(status.saved.projectionNet, 'unknown')
  assert.equal(status.projection_net_tokens, 'unknown')
})

test('pre-schema retrievalCost is subtracted once, never read as free', async () => {
  const d = await deps()
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projected',
    saved_projection_tokens: 100,
  })
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projection-retrieval',
    retrieved: true,
    retrievalCost: 30,
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.saved.projectionGross, 100 * 21)
  assert.equal(status.projection_legacy_retrievals, 1)
  assert.equal(status.projection_unpriced_retrievals, 0)
  // The legacy field was already a replay-aware total; subtract it directly.
  assert.equal(status.saved.projectionNet, 100 * 21 - 30)
  assert.equal(status.projection_net_tokens, 100 * 21 - 30)
})

test('status 投影毛额保留 saved 旧拼写作为后备', async () => {
  const d = await deps()
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projection',
    saved: 100,
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.saved.projectionGross, 100 * 21)
  assert.equal(status.projection_gross_tokens, 100)
})

test('status 投影毛额优先取 saved_projection_tokens 而不是 saved', async () => {
  const d = await deps()
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projection',
    saved_projection_tokens: 120,
    saved: 999,
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.saved.projectionGross, 120 * 21)
  assert.equal(status.projection_gross_tokens, 120)
})

test('status 忽略字符串型 saved，不把文本拼进账目', async () => {
  const d = await deps()
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projection',
    saved: '100',
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.saved.projectionGross, 'unknown', 'a malformed saving is not zero')
  assert.equal(status.projection_unpriced_projections, 1)
})

test('status 不把没有 unit:raw 的 projection 收据算进毛额', async () => {
  const d = await dirDeps()
  await mkdir(join(d.dir, 'receipts'), { recursive: true })
  const line = {
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 'raw',
    turn: 1,
    kind: 'projection',
    code: 'projection',
    receipt_hash: 'hash-no-unit',
    preview: '',
    saved: 999,
  }
  await writeFile(join(d.dir, 'receipts', 'raw.jsonl'), `${JSON.stringify(line)}\n`)

  const status = await getStatus(d)
  assert.equal(status.counts['projection'], 1)
  assert.deepEqual(status.saved, {
    substitution: 0,
    projectionGross: 0,
    projectionNet: 0,
    retrievalContent: 0,
    retrievalCalls: 0,
    retrievals: 0,
  })
})

// --- rule 5: degraded collects observed stable codes ----------------------

test('status 把 projection-skipped:no-spill 映射为 ERR_HOST_NO_SPILL（过滤器，不是生产者）', async () => {
  const d = await deps()
  const ts = new Date().toISOString()
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projection-skipped:no-spill',
  })
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'skip',
    code: 'skip:no-scope',
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.counts['projection-skipped:no-spill'], 1)
  assert.deepEqual(status.degraded, ['ERR_HOST_NO_SPILL'])
  // Without a host probe (this test builds none), status must not invent the
  // capability codes: the token-meter label comes from the host facts, not the
  // receipt stream.
  assert.equal(status.degraded.includes('ERR_HOST_NO_TOKENMETER'), false)
})

test('status 把 projection-skipped:no-footer 映射为 ERR_HOST_NO_SPILL_NOTICE', async () => {
  const d = await deps()
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'skip',
    code: 'projection-skipped:no-footer',
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.counts['projection-skipped:no-footer'], 1)
  // A missing notice module disables every apply-mode projection, so it is a
  // host degradation, not an ordinary "not worth it" skip. Without the mapping
  // the operator saw a healthy spill path and zero projections.
  assert.ok(
    status.degraded.includes('ERR_HOST_NO_SPILL_NOTICE'),
    JSON.stringify(status.degraded),
  )
  // `degraded` carries stable codes only: the receipt code is an input.
  assert.equal(
    status.degraded.some((code) => code.startsWith('projection-skipped:')),
    false,
  )
})

test('status 把 projection-skipped:spill-failed 映射为 ERR_HOST_SPILL_FAILING', async () => {
  const d = await deps()
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'skip',
    code: 'projection-skipped:spill-failed',
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.counts['projection-skipped:spill-failed'], 1)
  // The store exists (`hasSpill` is true) but every write fails: without this
  // mapping 100% of projections could be skipped while `degraded` stayed empty.
  // The code is its own, not `ERR_HOST_NO_SPILL`: a store that rejects every
  // write is not an absent store, and the two need different repairs.
  assert.ok(status.degraded.includes('ERR_HOST_SPILL_FAILING'), JSON.stringify(status.degraded))
  assert.equal(
    status.degraded.includes('ERR_HOST_NO_SPILL'),
    false,
    'a failing store must not be reported as an absent one',
  )
  assert.equal(
    status.degraded.some((code) => code.startsWith('projection-skipped:')),
    false,
  )
})

test('status 把 projection-skipped:footer-failed 映射为 ERR_HOST_NO_SPILL_NOTICE', async () => {
  const d = await deps()
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'skip',
    code: 'projection-skipped:footer-failed',
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.counts['projection-skipped:footer-failed'], 1)
  assert.ok(
    status.degraded.includes('ERR_HOST_NO_SPILL_NOTICE'),
    JSON.stringify(status.degraded),
  )
  assert.equal(
    status.degraded.some((code) => code.startsWith('projection-skipped:')),
    false,
  )
})

test('row 49: selector-unavailable / selector-error reach degraded as one stable code', async () => {
  const d = await deps()
  const ts = new Date().toISOString()
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'skip',
    code: 'selector-unavailable',
  })
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'skip',
    code: 'selector-error',
  })
  // An abstention is the model declining an ambiguous plan, not a host
  // capability absence: it must not masquerade as "the LLM is gone".
  await d.receipts.append({
    version: 1,
    ts,
    sessionId: 's1',
    turn: 1,
    kind: 'skip',
    code: 'selector-abstain',
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.counts['selector-unavailable'], 1)
  assert.equal(status.counts['selector-error'], 1)
  assert.equal(
    status.degraded.filter((code) => code === 'ERR_HOST_SELECTOR_UNAVAILABLE').length,
    1,
    JSON.stringify(status.degraded),
  )
})

test('row 49: a lone selector abstention is not reported as host unavailability', async () => {
  const d = await deps()
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'skip',
    code: 'selector-abstain',
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.degraded.includes('ERR_HOST_SELECTOR_UNAVAILABLE'), false)
})

test('status 在 scope.json 不可读时报稳定码切仍给出账目', async () => {
  const d = await dirDeps()
  // A directory named scope.json is unreadable as a file on every platform.
  await mkdir(join(d.dir, 'scope.json'))
  const status = await getStatus(d)
  assert.ok(status.degraded.includes('ERR_SCOPE_READ_FAILED'))
  assert.equal(status.scope.revision, 0)
  assert.deepEqual(status.saved, {
    substitution: 0,
    projectionGross: 0,
    projectionNet: 0,
    retrievalContent: 0,
    retrievalCalls: 0,
    retrievals: 0,
  })
})

test('status 遇到不可读分片时仍返回，并给出稳定的 degraded 码', async () => {
  const d = await dirDeps()
  const receipts = join(d.dir, 'receipts')
  await mkdir(receipts, { recursive: true })
  // A healthy shard read first, then a directory where a shard file should be:
  // readFile(dir) is EISDIR on POSIX and must not abort the whole status.
  await writeFile(
    join(receipts, 'aa.jsonl'),
    `${JSON.stringify({
      version: 1,
      ts: new Date().toISOString(),
      sessionId: 'aa',
      turn: 1,
      kind: 'skip',
      code: 'skip:no-scope',
      receipt_hash: 'hash-aa',
      preview: '',
    })}\n`,
  )
  await mkdir(join(receipts, 'zz.jsonl'))
  const r = await runBoost({ args: { cmd: 'status' }, ...d })
  assert.equal(r.ok, true, JSON.stringify(r))
  if (!r.ok) return
  const status = r.data as BoostStatus
  assert.ok(status.degraded.includes('ERR_RECEIPTS_UNREADABLE'), JSON.stringify(status.degraded))
  assert.equal(status.counts['skip:no-scope'], 1, 'the healthy shard is still counted')
})

test('D2: status 在分片修复后清掉 ERR_RECEIPTS_UNREADABLE', async () => {
  const d = await dirDeps()
  const receipts = join(d.dir, 'receipts')
  await mkdir(receipts, { recursive: true })
  await mkdir(join(receipts, 'bad.jsonl'))

  const broken = await getStatus(d)
  assert.ok(
    broken.degraded.includes('ERR_RECEIPTS_UNREADABLE'),
    'an unreadable shard must be visible while it exists',
  )

  // The README tells the operator to fix the shard and re-run status. The code
  // must clear, not stay pinned for the life of the process (D2).
  await rm(join(receipts, 'bad.jsonl'), { recursive: true, force: true })
  const repaired = await getStatus(d)
  assert.equal(
    repaired.degraded.includes('ERR_RECEIPTS_UNREADABLE'),
    false,
    JSON.stringify(repaired.degraded),
  )
})

test('D3: status 在 256 分片上限命中时报 ERR_RECEIPTS_TRUNCATED', async () => {
  const d = await dirDeps()
  const receipts = join(d.dir, 'receipts')
  await mkdir(receipts, { recursive: true })
  const total = 257
  for (let i = 0; i < total; i += 1) {
    const name = `s${String(i).padStart(3, '0')}`
    await writeFile(
      join(receipts, `${name}.jsonl`),
      `${JSON.stringify({
        version: 1,
        ts: '2026-11-20T00:00:00.000Z',
        sessionId: name,
        turn: 1,
        kind: 'skip',
        code: 'skip:no-scope',
        receipt_hash: `hash-${name}`,
        preview: '',
      })}\n`,
    )
  }

  const capped = await getStatus(d)
  assert.ok(
    capped.degraded.includes('ERR_RECEIPTS_TRUNCATED'),
    `the capped total must be labelled: ${JSON.stringify(capped.degraded)}`,
  )
  assert.equal(
    Object.values(capped.counts).reduce((sum, n) => sum + n, 0),
    256,
    'the figures cover only the first 256 sorted shards',
  )

  // A hand-built runBoost without the instrumented deps reads the flag from the
  // store itself, so the code cannot silently disappear outside `apply`.
  const bare = await runBoost({ args: { cmd: 'status' }, scope: d.scope, receipts: d.receipts })
  assert.equal(bare.ok, true, JSON.stringify(bare))
  if (bare.ok) assert.ok((bare.data as BoostStatus).degraded.includes('ERR_RECEIPTS_TRUNCATED'))

  // The flag describes the scan, not the process: one shard fewer fits and the
  // code clears.
  await rm(join(receipts, 's256.jsonl'))
  const complete = await getStatus(d)
  assert.equal(
    complete.degraded.includes('ERR_RECEIPTS_TRUNCATED'),
    false,
    JSON.stringify(complete.degraded),
  )
})

test('status 遇到只有不可读分片的账本时仍返回空账与稳定码', async () => {
  const d = await dirDeps()
  const receipts = join(d.dir, 'receipts')
  await mkdir(receipts, { recursive: true })
  await mkdir(join(receipts, 'only.jsonl'))
  const r = await runBoost({ args: { cmd: 'status' }, ...d })
  assert.equal(r.ok, true, JSON.stringify(r))
  if (!r.ok) return
  const status = r.data as BoostStatus
  assert.deepEqual({ ...status.counts }, {})
  assert.ok(status.degraded.includes('ERR_RECEIPTS_UNREADABLE'))
})

test('status 无宿主事实时不输出 hasWorkspaceRegistry 键（undefined 不是合法 JSON）', async () => {
  const d = await deps()
  const r = await runBoost({ args: { cmd: 'status' }, ...d })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const status = r.data as BoostStatus
  assert.equal(Object.hasOwn(status, 'hasWorkspaceRegistry'), false)
  // The spill fact follows the same rule: "not probed" is not "absent".
  assert.equal(Object.hasOwn(status, 'hasSpill'), false)
  // The value the host boundary receives must survive a lossless JSON round
  // trip: an own key whose value is `undefined` is not a legal JSON value.
  assert.doesNotThrow(() => JSON.stringify(status))
})

test('status 在收据目录不可读时仍返回，空账本而不是内部失败', async () => {
  const d = await dirDeps()
  // A file where receipts/ should be is ENOTDIR: an empty ledger, not a crash
  // (review I5). The same shape is reachable through a file-valued $DSH_HOME.
  await writeFile(join(d.dir, 'receipts'), 'not a directory')
  const r = await runBoost({ args: { cmd: 'status' }, ...d })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const data = r.data as { counts: Record<string, number>; projection_retrievals: number }
  assert.deepEqual({ ...data.counts }, {})
  assert.equal(data.projection_retrievals, 0)
})

// --- rule 6: the definition satisfies the host contract ------------------

test('工具定义满足宿主形状，output.schema 接受成功与失败两个分支', async () => {
  const d = await deps()
  const def = boostTool(d)
  assert.equal(def.name, 'boost')
  assert.equal(typeof def.description, 'string')
  assert.ok(def.description.length > 0)
  assert.equal(typeof def.parameters, 'object')
  assert.equal(typeof def.execute, 'function')
  assert.doesNotThrow(() => assertSupportedJsonSchema(def.output.schema))
  // The input schema must stay inside the same enforced subset: the host
  // validates `output.schema` at register today, and a tightening that also
  // asserts `parameters` must not reject the only control tool (row 45).
  assert.doesNotThrow(() => assertSupportedJsonSchema(def.parameters as never))
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, { ok: true, data: { shadow: true } }), [])
  assert.deepEqual(validateJsonSchemaValue(def.output.schema, { ok: false, code: 'ERR_X' }), [])

  const parameters = def.parameters as any
  assert.deepEqual(parameters.properties.cmd.enum, ['status', 'scope-get', 'scope-set', 'shadow'])
  assert.deepEqual(parameters.required, ['cmd'])
})

test('render 把失败信封原样交给模型，不做美化', async () => {
  const d = await deps()
  const def = boostTool(d)
  assert.deepEqual(def.output.render({ cmd: 'nope' }, { ok: false, code: 'ERR_BOOST_UNKNOWN_CMD' }), [
    { type: 'text', text: '{"ok":false,"code":"ERR_BOOST_UNKNOWN_CMD"}' },
  ])
})

test('boostTool.execute 复用 runBoost：成功给 data，失败给稳定码而不是抛错', async () => {
  const d = await deps()
  const def = boostTool(d)
  const ok = await def.execute(
    { cmd: 'scope-set', body: { mode: 'global' }, baseRevision: 0 },
    {},
  )
  assert.equal((ok as any).ok, true)
  assert.equal((ok as any).data.revision, 1)
  assert.deepEqual(await def.execute({ cmd: 'nope' }, {}), {
    ok: false,
    code: 'ERR_BOOST_UNKNOWN_CMD',
  })
})

test('runBoost 对 null 输入与抛错 getter 返回稳定码，不抛错', async () => {
  const d = await deps()
  assert.deepEqual(await runBoost(null as any), { ok: false, code: 'ERR_BOOST_UNKNOWN_CMD' })

  const throwing = {
    get cmd(): string {
      throw new Error('boom')
    },
  }
  assert.deepEqual(await runBoost({ args: throwing as any, ...d }), {
    ok: false,
    code: 'ERR_BOOST_INTERNAL',
  })
})
test('boostTool 把 exec.signal 传给 scope-set，取消后不写盘（row 79）', async () => {
  const d = await dirDeps()
  const controller = new AbortController()
  controller.abort()
  const def = boostTool(d)
  const result = await def.execute(
    { cmd: 'scope-set', body: { mode: 'global' }, baseRevision: 0 },
    { signal: controller.signal },
  )
  assert.deepEqual(result, { ok: false, code: 'ERR_SCOPE_ABORTED' })
  const read = await d.scope.read()
  assert.equal(read.doc.revision, 0)
})

test('boostTool 忽略不是 AbortSignal 的 exec.signal（不因宿主形状抛错）', async () => {
  const d = await dirDeps()
  const def = boostTool(d)
  const result = await def.execute({ cmd: 'status' }, { signal: { aborted: 'no' } })
  assert.equal((result as any).ok, true)
})

/* ------------------------------------------------------------------------- *
 * Cache guardrails in status
 * ------------------------------------------------------------------------- */

test('status 无 usage 样本：cache_hit_ratio 为 null，prefix_drops 为 0/0', async () => {
  const d = await deps()
  const status = await getStatus(d)
  // A rate with no sample is null, never 0; a count with no samples is 0.
  assert.equal(status.cache_hit_ratio, null)
  assert.deepEqual(status.prefix_drops, { count: 0, tokens: 0 })
})

test('status 从 usage 账本读最近命中率与前缀回退（蛇形命名）', async () => {
  const usage = new UsageLedger()
  usage.request({ input: 1000, cacheRead: 0, output: 0 })
  usage.request({ input: 100, cacheRead: 900, output: 0 })

  const d = await deps()
  const r = await runBoost({ args: { cmd: 'status' }, ...d, usage })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.data.cache_hit_ratio, 0.9)
  assert.deepEqual(r.data.prefix_drops, { count: 1, tokens: 100 })
})

test('status 对会抛的 usage 账本仍然作答：null / 0', async () => {
  const d = await deps()
  const usage = {
    hitRate: () => {
      throw new Error('foreign ledger')
    },
    prefixDrops: () => {
      throw new Error('foreign ledger')
    },
  } as unknown as UsageLedger
  const r = await runBoost({ args: { cmd: 'status' }, ...d, usage })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.data.cache_hit_ratio, null)
  assert.deepEqual(r.data.prefix_drops, { count: 0, tokens: 0 })
})
