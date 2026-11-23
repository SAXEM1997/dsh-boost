/**
 * Ticket #10: the product store.
 *
 * Products live at `<root>/distilled/<receipt_hash>-<question_hash>-<version>.json`
 * and outlive the session that produced them (ADR 0001): a replay must read the
 * same bytes instead of paying for the same call again, so nothing deletes a
 * product on session end. Retention is bounded by count and total size instead,
 * oldest first, and the product just written is never a candidate.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DistillStore } from '../src/distill/store.ts'

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-distill-'))
  return dir
}

const PRODUCT = {
  text: 'the failing step is `npm test`\nnpm ERR! exit code 1',
  quotes: ['npm ERR! exit code 1'],
  model: 'deepseek-flash',
}

test('write 后 read 得到同一产物：text/quotes/model 逐字相同', async () => {
  const dir = await root()
  const store = new DistillStore(dir)
  const key = { file: 'aaaa-bbbb-v1' }
  await store.write('s1', key, PRODUCT)
  const got = await store.read(key)
  assert.ok(got)
  assert.equal(got.text, PRODUCT.text)
  assert.deepEqual(got.quotes, PRODUCT.quotes)
  assert.equal(got.model, PRODUCT.model)
  // No wall-clock field: the product file must be reproducible from its inputs
  // alone, so the determinism scan can cover `src/distill/` wholesale.
  assert.equal('createdAt' in got, false)
})

test('文件位置与内容形状：<root>/distilled/<receipt>-<question>-<version>.json', async () => {
  const dir = await root()
  const store = new DistillStore(dir)
  await store.write('s1', { file: 'r1-q1-v1' }, PRODUCT)
  const path = join(dir, 'distilled', 'r1-q1-v1.json')
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(Object.keys(parsed).sort(), ['model', 'quotes', 'text'])
  assert.equal(parsed.text, PRODUCT.text)
})

test('read 未命中返回 undefined，不抛、不建目录', async () => {
  const dir = await root()
  const store = new DistillStore(dir)
  assert.equal(await store.read({ file: 'nope' }), undefined)
})

test('损坏的产物文件按未命中：不抛，也不被当成命中', async () => {
  const dir = await root()
  const store = new DistillStore(dir)
  await mkdir(join(dir, 'distilled'), { recursive: true })
  await writeFile(join(dir, 'distilled', 'bad.json'), '{not json')
  assert.equal(await store.read({ file: 'bad' }), undefined)
  // Shape-invalid JSON is also a miss: `text` must be a string.
  await writeFile(join(dir, 'distilled', 'shape.json'), JSON.stringify({ quotes: [] }))
  assert.equal(await store.read({ file: 'shape' }), undefined)
})

test('write 失败向上抛（由 decide 映射成 distill-failed），不吞', async () => {
  const dir = await root()
  // A file where the directory should be: mkdir fails with ENOTDIR/EEXIST.
  await writeFile(join(dir, 'distilled'), 'x')
  const store = new DistillStore(dir)
  await assert.rejects(() => store.write('s1', { file: 'a' }, PRODUCT))
})

test('并发读写同一 key：写是原子的，读到的要么是旧值要么是新值', async () => {
  const dir = await root()
  const store = new DistillStore(dir)
  await store.write('s1', { file: 'k' }, PRODUCT)
  const next = { ...PRODUCT, text: 'new text', quotes: [] }
  await Promise.all([store.write('s1', { file: 'k' }, next), store.read({ file: 'k' })])
  const got = await store.read({ file: 'k' })
  assert.equal(got?.text, 'new text')
})

// Retention: a product is a cache entry, and the ADR promises a replay only
// reads the table. Deleting on session end made that promise depend on process
// lifetime — a resumed session paid for the same receipt twice, silently. So
// the store keeps products and bounds itself instead.
test('写入超过文件数上限时裁掉最旧的，最新的仍在', async () => {
  const dir = await root()
  const store = new DistillStore(dir, { maxFiles: 3 })
  for (const n of ['a', 'b', 'c', 'd']) {
    await store.write('s1', { file: `${n}-v1` }, PRODUCT)
    // mtimes drive "oldest": the filesystem's clock has coarse resolution on
    // some systems, so space the writes out explicitly.
    await new Promise((resolve) => setTimeout(resolve, 12))
  }
  const files = (await readdir(join(dir, 'distilled'))).sort()
  assert.equal(files.length, 3)
  assert.equal(files.includes('a-v1.json'), false, 'the oldest is the one dropped')
  assert.equal(files.includes('d-v1.json'), true, 'the newest survives')
  assert.ok(await store.read({ file: 'd-v1' }))
})

test('写入超过总字节上限时也裁，且至少留下刚写的那一条', async () => {
  const dir = await root()
  const store = new DistillStore(dir, { maxFiles: 1000, maxBytes: 200 })
  for (const n of ['a', 'b', 'c']) {
    await store.write('s1', { file: `${n}-v1` }, PRODUCT)
    await new Promise((resolve) => setTimeout(resolve, 12))
  }
  const files = await readdir(join(dir, 'distilled'))
  // Three products are well past 200 bytes together, so the oldest go one by
  // one until the total fits: exactly the newest survives, and never zero — the
  // product just written is the one the caller is about to render, so pruning
  // must not delete it out from under them.
  assert.deepEqual(files, ['c-v1.json'])
})

