import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReceiptStore, receiptHash } from '../src/receipts/store.ts'

const rec = (sessionId: string, over: any = {}): any => ({
  version: 1, ts: '2026-11-19T00:00:00.000Z', sessionId, turn: 1,
  stepId: 'A', tool: 'read', kind: 'shadow', code: 'ok', preview: 'x', ...over,
})

const freshRoot = () => mkdtemp(join(tmpdir(), 'boost-'))

test('按 session 分片写入，补齐 version/hash/preview', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a'))
  await s.append(rec('b'))
  const a = await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')
  assert.equal(a.trim().split('\n').length, 1)
  const line = JSON.parse(a.trim())
  assert.equal(line.version, 1)
  assert.equal(line.receipt_hash, receiptHash({ sessionId: 'a', turn: 1, stepId: 'A', tool: 'read', args: {} }))
})

test('preview 截到 256 code point', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a', { preview: '😀'.repeat(300) }))
  const line = JSON.parse((await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')).trim())
  assert.equal(Array.from(line.preview).length, 256)
})

test('args 超长时落盘截断并标记，但 hash 仍按完整 args 算', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  const args = { path: '/a', blob: 'x'.repeat(4096) }
  await s.append(rec('a', { args }))
  const line = JSON.parse((await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')).trim())

  assert.equal(line.args_truncated, true)
  assert.ok(Array.from(JSON.stringify(line.args)).length <= 2100, 'the stored copy stays bounded')
  assert.match(line.args.truncated_json, /…$/)
  // Identity is unaffected: the hash is over the full args, so two calls that
  // differ only after the cap still hash differently even though the stored
  // copies are identical.
  assert.equal(
    line.receipt_hash,
    receiptHash({ sessionId: 'a', turn: 1, stepId: 'A', tool: 'read', args }),
  )
  const other = receiptHash({ sessionId: 'a', turn: 1, stepId: 'A', tool: 'read', args: { ...args, blob: `${'x'.repeat(4096)}y` } })
  assert.notEqual(line.receipt_hash, other)
})

test('短 args 原样保留，不标记截断', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a', { args: { path: '/a' } }))
  const line = JSON.parse((await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')).trim())
  assert.deepEqual(line.args, { path: '/a' })
  assert.equal(line.args_truncated, undefined)
})

test('count 与 scan 可读回，scan(undefined) 跨会话', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a')); await s.append(rec('a')); await s.append(rec('b'))
  assert.equal(await s.count('a'), 2)
  const rows: any[] = []
  for await (const r of s.scan('a')) rows.push(r)
  assert.equal(rows.length, 2)
  const all: any[] = []
  for await (const r of s.scan()) all.push(r)
  assert.equal(all.length, 3)
})

test('连续 3 次写失败后停止替换（成功一次即清零）（fail-closed）', async () => {
  const s = new ReceiptStore('/proc/definitely-not-writable')
  for (let i = 0; i < 3; i++) await s.append(rec('a'))
  assert.equal(s.failures(), 3)
  assert.equal(s.stopped(), true)
  // 成功一次即清零，不能是“累计 3 次”
  const ok = new ReceiptStore(await freshRoot())
  await ok.append(rec('a')); await ok.append(rec('a'))
  assert.equal(ok.failures(), 0)
})

test('半行在读取时丢弃但读取不改写分片（R51 / row 32）', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a'))
  const path = join(root, 'receipts', 'a.jsonl')
  await appendFile(path, '{"version":1,"half":')
  const before = await readFile(path, 'utf8')

  assert.equal(await s.count('a'), 1, 'the unfinished tail is not a receipt')
  assert.equal(
    await readFile(path, 'utf8'),
    before,
    'a read path must not truncate: a concurrent append could be cut',
  )
})

test('row 32：读取后再补全那条半行，补全的字节仍可读', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a', { turn: 0 }))
  const path = join(root, 'receipts', 'a.jsonl')
  // A concurrent writer has emitted the first half of a valid line.
  await appendFile(path, '{"version":1,"turn":1,"sessionId":"a","kind":"shadow","code":"ok","tail":"')

  assert.equal(await s.count('a'), 1)
  // The writer completes the line after the read. A read that truncated the
  // prefix would have cut these bytes off and lost the receipt.
  await appendFile(path, 'done"}\n')
  assert.equal(await s.count('a'), 2)
  const turns: number[] = []
  for await (const r of s.scan('a')) turns.push(r.turn)
  assert.deepEqual(turns, [0, 1])
})

test('超限轮转保留当前 + .1 两份（R47）', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root, { maxBytes: 400, maxLines: 4 })
  for (let i = 0; i < 9; i++) await s.append(rec('a', { turn: i }))
  // 只保留当前 + .1 两份、maxLines=4 ⇒ 最多能读回 8 行；要求 9 行会逼实现违反保留策略
  assert.ok(await s.count('a') <= 8)
  await stat(join(root, 'receipts', 'a.1.jsonl'))
})

test('receiptHash 覆盖 args：仅 args 不同则 hash 不同，且键序无关', async () => {
  const base = { sessionId: 'a', turn: 1, stepId: 'A', tool: 'read' }
  const args = { path: 'x', depth: 2 }
  const h1 = receiptHash({ ...base, args })
  const h2 = receiptHash({ ...base, args: { path: 'y', depth: 2 } })
  assert.notEqual(h1, h2)
  assert.match(h1, /^[0-9a-f]{16}$/)
  // 稳定序列化：嵌套对象的键序不影响 hash
  assert.equal(
    receiptHash({ ...base, args: { b: { d: 3, c: 2 }, a: 1 } }),
    receiptHash({ ...base, args: { a: 1, b: { c: 2, d: 3 } } }),
  )
  // 缺省 args 等价于 {}（brief 的断言依赖这一点）
  assert.equal(receiptHash(base), receiptHash({ ...base, args: {} }))

  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a', { args }))
  const line = JSON.parse((await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')).trim())
  assert.equal(line.receipt_hash, h1)
  assert.deepEqual(line.args, args)
})

test('写成功一次即把 failures 清零（连续失败不是累计）', async () => {
  const root = await freshRoot()
  const blocker = join(root, 'receipts')
  await writeFile(blocker, 'not a directory')
  const s = new ReceiptStore(root)
  await s.append(rec('a'))
  await s.append(rec('a'))
  assert.equal(s.failures(), 2)
  assert.equal(s.stopped(), false)

  await unlink(blocker)
  await s.append(rec('a'))
  assert.equal(s.failures(), 0)
  assert.equal(s.stopped(), false)
  // 失败期间缓冲的收据在恢复后按序补写
  assert.equal(await s.count('a'), 3)
})

test('scan 跳过中间的损坏行，count 只数可读收据', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  for (let i = 0; i < 3; i++) await s.append(rec('a', { turn: i }))
  const path = join(root, 'receipts', 'a.jsonl')
  const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l !== '')
  lines[1] = '{"version":1,"broken":'
  await writeFile(path, lines.join('\n') + '\n')

  assert.equal(await s.count('a'), 2)
  const turns: number[] = []
  for await (const r of s.scan('a')) turns.push(r.turn)
  assert.deepEqual(turns, [0, 2])
})

test('轮转丢弃最旧分片，只保留当前 + .1', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root, { maxLines: 2 })
  for (let i = 0; i < 6; i++) await s.append(rec('a', { turn: i }))

  const turns: number[] = []
  for await (const r of s.scan('a')) turns.push(r.turn)
  assert.deepEqual(turns, [2, 3, 4, 5])
  assert.equal(await s.count('a'), 4)
  await stat(join(root, 'receipts', 'a.1.jsonl'))
  await assert.rejects(stat(join(root, 'receipts', 'a.2.jsonl')))
})

test('projection 收据的 unit:"raw" 字面量原样落盘（T19/T26 过滤依据）', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a', { kind: 'projection', unit: 'raw', before: 120, after: 30 }))
  const line = JSON.parse((await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')).trim())
  assert.equal(line.kind, 'projection')
  assert.equal(line.unit, 'raw')
  assert.equal(line.before, 120)
  assert.equal(line.after, 30)
})

test('projection 缺 unit 或被篡改时由 store 强制写 unit:"raw"', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a', { kind: 'projection', before: 5, after: 2 }))
  await s.append(rec('a', { kind: 'projection', unit: 'tokens', before: 9, after: 3 }))
  const lines = (await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')).trim().split('\n')
  const [first, second] = lines
  assert.ok(first !== undefined)
  assert.ok(second !== undefined)
  assert.equal(JSON.parse(first).unit, 'raw')
  assert.equal(JSON.parse(second).unit, 'raw')
})

test('调用方传入的 receipt_hash 不可信，store 总是重算', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a', { receipt_hash: 'deadbeefdeadbeef' }))
  const line = JSON.parse((await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')).trim())
  assert.equal(line.receipt_hash, receiptHash({ sessionId: 'a', turn: 1, stepId: 'A', tool: 'read', args: {} }))
  assert.notEqual(line.receipt_hash, 'deadbeefdeadbeef')
})

test('新 store 首次 append 先截断崩溃残留的半行，不把新收据拼上去', async () => {
  const root = await freshRoot()
  const first = new ReceiptStore(root)
  await first.append(rec('a', { turn: 0 }))
  await appendFile(join(root, 'receipts', 'a.jsonl'), '{"version":1,"half":')

  const second = new ReceiptStore(root)
  await second.append(rec('a', { turn: 1 }))
  const text = await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')
  const lines = text.split('\n').filter((line) => line !== '')
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map((line) => JSON.parse(line).turn), [0, 1])
  assert.equal(text.includes('"half"'), false)
  assert.equal(await second.count('a'), 2)
})

test('只有半行的分片先截为空再追加', async () => {
  const root = await freshRoot()
  await mkdir(join(root, 'receipts'), { recursive: true })
  await writeFile(join(root, 'receipts', 'a.jsonl'), '{"version":1,"half":')

  const s = new ReceiptStore(root)
  await s.append(rec('a', { turn: 7 }))
  const text = await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')
  const lines = text.split('\n').filter((line) => line !== '')
  assert.equal(lines.length, 1)
  const [line] = lines
  assert.ok(line !== undefined)
  assert.equal(JSON.parse(line).turn, 7)
  assert.equal(text.includes('"half"'), false)
  assert.equal(await s.count('a'), 1)
})

test('sessionId 编码成单个安全分片名，收据体保留原始 id', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('../escape'))
  await s.append(rec('team/2026'))
  await s.append(rec('a..b'))

  // 编码后的文件名都落在 receipts/ 内；原始 id 不会变成路径
  await stat(join(root, 'receipts', '%2E%2E%2Fescape.jsonl'))
  await stat(join(root, 'receipts', 'team%2F2026.jsonl'))
  await stat(join(root, 'receipts', 'a%2E%2Eb.jsonl'))
  await assert.rejects(stat(join(root, 'escape.jsonl')))
  assert.equal(s.failures(), 0)
  assert.equal(s.stopped(), false)

  // count/scan 用原始 id 寻址
  assert.equal(await s.count('../escape'), 1)
  assert.equal(await s.count('team/2026'), 1)
  assert.equal(await s.count('a..b'), 1)
  const rows: any[] = []
  for await (const r of s.scan('team/2026')) rows.push(r)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionId, 'team/2026')

  // 收据体里的 sessionId 是原值，hash 也覆盖原值
  const line = JSON.parse((await readFile(join(root, 'receipts', '%2E%2E%2Fescape.jsonl'), 'utf8')).trim())
  assert.equal(line.sessionId, '../escape')
  assert.equal(
    line.receipt_hash,
    receiptHash({ sessionId: '../escape', turn: 1, stepId: 'A', tool: 'read', args: {} }),
  )

  // scan() 无参按分片读回全部三条，id 来自收据体
  const all: any[] = []
  for await (const r of s.scan()) all.push(r)
  assert.deepEqual(all.map((r) => r.sessionId).sort(), ['../escape', 'a..b', 'team/2026'])
})

test('空 sessionId 的分片也能被 scan() 读回', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec(''))
  await s.append(rec('x'))
  await stat(join(root, 'receipts', '.jsonl'))

  const all: any[] = []
  for await (const r of s.scan()) all.push(r)
  assert.deepEqual(all.map((r) => r.sessionId).sort(), ['', 'x'])

  const empty: any[] = []
  for await (const r of s.scan('')) empty.push(r)
  assert.equal(empty.length, 1)
  assert.equal(await s.count(''), 1)
})

test('.1 分片里的半行同样只在读取时丢弃，不改写分片', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root, { maxLines: 1 })
  await s.append(rec('a', { turn: 0 }))
  await s.append(rec('a', { turn: 1 }))
  const rotated = join(root, 'receipts', 'a.1.jsonl')
  await appendFile(rotated, '{"version":1,"half":')
  const before = await readFile(rotated, 'utf8')

  assert.equal(await s.count('a'), 2)
  assert.equal(await readFile(rotated, 'utf8'), before, 'rotated shards are never repaired by a read')
})

test('flush 把失败期间缓冲的收据补写落盘，且不抛错', async () => {
  const root = await freshRoot()
  const blocker = join(root, 'receipts')
  await writeFile(blocker, 'not a directory')
  const s = new ReceiptStore(root)
  await s.append(rec('a', { turn: 0 }))
  assert.equal(s.failures(), 1)

  await unlink(blocker)
  await s.flush()
  assert.equal(await s.count('a'), 1)
  // 空 store 的 flush 同样是 no-op，不抛错
  await new ReceiptStore(await freshRoot()).flush()
})

test('row 3：6000 层深的 args 仍有收据且不计失败（深度有界 + 标记）', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  let deep: Record<string, unknown> = { leaf: 'x' }
  for (let i = 0; i < 6000; i += 1) deep = { next: deep }
  // The premise: a recursive serialiser cannot survive this tree.
  assert.throws(() => JSON.stringify(deep), RangeError)

  await s.append(rec('a', { args: deep }))

  assert.equal(s.failures(), 0, 'a deep argument must not count as a write failure')
  assert.equal(s.stopped(), false)
  const line = JSON.parse((await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')).trim())
  assert.equal(line.args_depth_truncated, true, 'the depth cut is visible, not silent')
  const serialised = JSON.stringify(line.args)
  assert.match(serialised, /"truncated_depth":64/)
  // The stored tree is shallow enough to be rewritten and read back.
  let node: any = line.args
  for (let guard = 0; guard < 100; guard += 1) {
    if (node === null || typeof node !== 'object' || !('next' in node)) break
    node = node.next
  }
  assert.equal(node.truncated_depth, 64)
})

test('row 33：自有 __proto__ 键参与 hash 与落盘', async () => {
  const base = { sessionId: 'a', turn: 1, stepId: 'A', tool: 'read' }
  const first = JSON.parse('{"__proto__":"first"}') as Record<string, unknown>
  const second = JSON.parse('{"__proto__":"second"}') as Record<string, unknown>
  assert.equal(Object.hasOwn(first, '__proto__'), true)

  const h1 = receiptHash({ ...base, args: first })
  const h2 = receiptHash({ ...base, args: second })
  assert.notEqual(h1, h2, 'an own __proto__ key must not be swallowed by the prototype setter')

  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a', { args: first }))
  const line = JSON.parse((await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')).trim())
  assert.equal(line.receipt_hash, h1)
  assert.equal(line.args.__proto__, 'first', 'the stored args keep the own key')
})

test('row 34：一个不可读分片不中断整库扫描，readErrors() 计数', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a'))
  await s.append(rec('b'))
  // A directory with a shard's name is unreadable as a file (EISDIR).
  await mkdir(join(root, 'receipts', 'bad.jsonl'))

  const rows: any[] = []
  for await (const r of s.scan()) rows.push(r)
  assert.deepEqual(rows.map((r) => r.sessionId).sort(), ['a', 'b'])
  assert.equal(s.readErrors(), 1)

  // An explicit session still works and an unreadable one degrades to empty.
  // Named scans neither contribute to nor clear the whole-store reading.
  assert.equal(await s.count('a'), 1)
  assert.equal(await s.count('bad'), 0)
  assert.equal(s.readErrors(), 2)

  // D2: repairing the shard and re-running the whole-store scan clears the
  // reading, so status can drop ERR_RECEIPTS_UNREADABLE.
  await rm(join(root, 'receipts', 'bad.jsonl'), { recursive: true, force: true })
  const repaired: any[] = []
  for await (const r of s.scan()) repaired.push(r)
  assert.deepEqual(repaired.map((r) => r.sessionId).sort(), ['a', 'b'])
  assert.equal(s.readErrors(), 0, 'a fully readable scan resets the reading')
})

test('row 39：整库 scan 有分片上限，超出的分片被明确跳过而不是无界扫描', async () => {
  const root = await freshRoot()
  await mkdir(join(root, 'receipts'), { recursive: true })
  const total = 300
  for (let i = 0; i < total; i += 1) {
    const name = `s${String(i).padStart(3, '0')}`
    await writeFile(join(root, 'receipts', `${name}.jsonl`), `${JSON.stringify(rec(name))}\n`)
  }

  const rows: any[] = []
  const s = new ReceiptStore(root)
  for await (const r of s.scan()) rows.push(r)
  assert.equal(rows.length, 256, 'the whole-store scan is capped')
  assert.equal(s.readErrors(), 0)
  // A named session is still addressable even when its shard is past the cap.
  assert.equal(await s.count('s299'), 1)
})

// ---------------------------------------------------------------------------
// I7: per-session state and the failure buffer must be bounded/disposable.
// ---------------------------------------------------------------------------

test('I7: disposeSession evicts the shard state and drops later receipts', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a'))
  assert.equal(await s.count('a'), 1)

  s.disposeSession('a')
  // The cached shard counters are gone, not retained for a dead session.
  assert.equal((s as unknown as { states: Map<string, unknown> }).states.size, 0)

  await s.append(rec('a', { turn: 2 }))
  assert.equal(await s.count('a'), 1, 'a late hook must record nothing for a disposed session')

  // A live session is unaffected by another session's disposal.
  await s.append(rec('b'))
  assert.equal(await s.count('b'), 1)
})

test('I7: the disposed-id set is bounded, so a long process cannot grow it forever', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  for (let i = 0; i < 300; i++) s.disposeSession(`s${i}`)
  const disposed = (s as unknown as { disposed: Set<string> }).disposed
  assert.ok(disposed.size <= 256, `disposed set grew to ${disposed.size}`)
  // The newest id is remembered and the oldest evicted.
  assert.equal(disposed.has('s299'), true)
  assert.equal(disposed.has('s0'), false)
})

test('I7: once stopped() the pending buffer is dropped instead of growing unbounded', async () => {
  const root = await freshRoot()
  const blocker = join(root, 'receipts')
  await writeFile(blocker, 'not a directory')
  const s = new ReceiptStore(root)
  for (let i = 0; i < 25; i++) await s.append(rec('a', { turn: i }))

  assert.equal(s.stopped(), true)
  const pending = (s as unknown as { pending: unknown[] }).pending
  assert.deepEqual(pending, [])
  assert.equal(s.failures(), 25)
})

test('I7: a failed flush keeps the session’s buffered lines for a later flush', async () => {
  const root = await freshRoot()
  const blocker = join(root, 'receipts')
  await writeFile(blocker, 'not a directory')
  const s = new ReceiptStore(root)

  await s.append(rec('a', { turn: 0 }))
  await s.flush()
  assert.equal(s.failures() > 0, true, 'the flush must fail on this root')
  assert.equal(
    (s as unknown as { pending: unknown[] }).pending.length,
    1,
    'the failed flush leaves the line buffered',
  )

  // Disposal after the failed flush must not destroy the evidence the flush
  // promised to keep: the buffer is bounded and is dropped once stopped().
  s.disposeSession('a')
  assert.equal(
    (s as unknown as { pending: unknown[] }).pending.length,
    1,
    'a failed flush must not be finished by eviction',
  )

  await unlink(blocker)
  await s.flush()
  assert.equal(await s.count('a'), 1, 'the retained line is written once the disk recovers')
})
