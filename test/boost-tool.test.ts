import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { runBoost, boostTool } from '../src/tools/boost.ts'
import type { BoostStatus } from '../src/tools/boost.ts'
import { ScopeStore } from '../src/scope/store.ts'
import { ReceiptStore } from '../src/receipts/store.ts'

const deps = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boost-'))
  return { scope: new ScopeStore(dir), receipts: new ReceiptStore(dir) }
}

/** Same as `deps()`, but keeps the root so a test can plant files the stores read. */
const dirDeps = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boost-'))
  return { dir, scope: new ScopeStore(dir), receipts: new ReceiptStore(dir) }
}

/** Await a status call and narrow the success branch for the assertions below. */
const getStatus = async (d: { scope: ScopeStore; receipts: ReceiptStore }): Promise<BoostStatus> => {
  const r = await runBoost({ args: { cmd: 'status' }, ...d })
  assert.equal(r.ok, true)
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
  const blocks = def.output.render({ cmd: 'status' }, { ok: true, data: { shadow: true } })
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /shadow/)
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
    assert.equal(read.degraded, 'scope-degraded', JSON.stringify(body))
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
    retrievals: 0,
  })
  assert.deepEqual(status.scope, { mode: 'selected', workspaceIds: [], revision: 0 })
  // A fresh root has no scope.json; the store's degraded read is the honest
  // answer, not a status failure.
  assert.deepEqual(status.degraded, ['scope-degraded'])
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

test('status 投影毛额读 saved_projection_tokens，净额扣掉已记录的 retrievalCost', async () => {
  const d = await deps()
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projection',
    saved_projection_tokens: 100,
    retrieved: true,
    retrievalCost: 30,
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.deepEqual(status.saved, {
    substitution: 0,
    projectionGross: 100,
    projectionNet: 70,
    retrievals: 1,
  })
})

test('status 取回未记录 retrievalCost 时净额等于毛额', async () => {
  const d = await deps()
  await d.receipts.append({
    version: 1,
    ts: new Date().toISOString(),
    sessionId: 's1',
    turn: 1,
    kind: 'projection',
    code: 'projection',
    saved_projection_tokens: 100,
    retrieved: true,
  })
  await d.receipts.flush()

  const status = await getStatus(d)
  assert.equal(status.saved.projectionGross, 100)
  assert.equal(status.saved.retrievals, 1)
  assert.equal(status.saved.projectionNet, 100)
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
  assert.equal(status.saved.projectionGross, 100)
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
  assert.equal(status.saved.projectionGross, 120)
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
  assert.equal(status.saved.projectionGross, 0)
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
  assert.deepEqual(status.degraded, ['ERR_HOST_NO_SPILL', 'scope-degraded'])
  // ERR_HOST_NO_TOKENMETER has no receipt channel until T25's host probe; a
  // literal code must not be conjured from the receipt stream.
  assert.equal(status.degraded.includes('ERR_HOST_NO_TOKENMETER'), false)
})

test('status 在 scope.json 不可读时报 scope-degraded 且仍给出账目', async () => {
  const d = await dirDeps()
  // A directory named scope.json is unreadable as a file on every platform.
  await mkdir(join(d.dir, 'scope.json'))
  const status = await getStatus(d)
  assert.ok(status.degraded.includes('scope-degraded'))
  assert.equal(status.scope.revision, 0)
  assert.deepEqual(status.saved, {
    substitution: 0,
    projectionGross: 0,
    projectionNet: 0,
    retrievals: 0,
  })
})

test('status 在收据目录不可读时返回稳定码而不是抛错', async () => {
  const d = await dirDeps()
  // A file where receipts/ should be makes the all-shard scan throw.
  await writeFile(join(d.dir, 'receipts'), 'not a directory')
  const r = await runBoost({ args: { cmd: 'status' }, ...d })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(typeof r.code, 'string')
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