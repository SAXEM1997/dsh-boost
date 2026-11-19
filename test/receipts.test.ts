import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, stat, unlink, writeFile } from 'node:fs/promises'
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

test('半行在读取时丢弃并从该偏移截断（R51）', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root)
  await s.append(rec('a'))
  await appendFile(join(root, 'receipts', 'a.jsonl'), '{"version":1,"half":')
  assert.equal(await s.count('a'), 1)
  const text = await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')
  assert.equal(text.endsWith('\n'), true)
  assert.equal(text.includes('"half"'), false)
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

test('.1 分片里的半行同样在读取时丢弃并截断', async () => {
  const root = await freshRoot()
  const s = new ReceiptStore(root, { maxLines: 1 })
  await s.append(rec('a', { turn: 0 }))
  await s.append(rec('a', { turn: 1 }))
  const rotated = join(root, 'receipts', 'a.1.jsonl')
  await appendFile(rotated, '{"version":1,"half":')

  assert.equal(await s.count('a'), 2)
  const text = await readFile(rotated, 'utf8')
  assert.equal(text.endsWith('\n'), true)
  assert.equal(text.includes('"half"'), false)
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
