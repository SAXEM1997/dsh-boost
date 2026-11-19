import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { ScopeStore } from '../src/scope/store.ts'

/** A lock mtime comfortably past the 60 s threshold; no test sleeps for it. */
const STALE_LOCK_AT = new Date(Date.now() - 61_000)

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'scope-'))
}

/** Whether `process.kill(pid, 0)` reports the pid as alive (EPERM counts as alive). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('缺失文件返回默认并标 degraded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  const r = await new ScopeStore(dir).read()
  assert.equal(r.doc.mode, 'selected')
  assert.equal(r.degraded, 'scope-degraded')
  assert.equal(r.code, 'ERR_SCOPE_READ_FAILED')
})

test('version 1 映射为 scope-degraded + ERR_SCOPE_UNKNOWN_VERSION（R34）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  await writeFile(join(dir, 'scope.json'), JSON.stringify({ version: 1, mode: 'global' }))
  const r = await new ScopeStore(dir).read()
  assert.equal(r.degraded, 'scope-degraded')
  assert.equal(r.code, 'ERR_SCOPE_UNKNOWN_VERSION')
})

test('写后 revision 自增，mtime 变化让缓存失效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  const s = new ScopeStore(dir)
  const a = await s.write(d => ({ ...d, mode: 'global' }), 0)
  assert.equal(a.revision, 1)
  const b = await s.read()
  assert.equal(b.doc.mode, 'global')
  assert.equal(b.doc.revision, 1)
})

test('base revision 不符时拒绝（TOCTOU）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  const s = new ScopeStore(dir)
  await s.write(d => ({ ...d, mode: 'global' }), 0)
  await assert.rejects(() => s.write(d => d, 0), /ERR_SCOPE_REVISION_CONFLICT/)
})

test('base revision 非法值（-1 / NaN / Infinity）一律冲突且不写盘', async () => {
  const dir = await tempDir()
  const s = new ScopeStore(dir)
  for (const base of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(() => s.write(d => d, base), /ERR_SCOPE_REVISION_CONFLICT/)
    assert.equal(existsSync(join(dir, 'scope.json')), false)
    assert.equal(existsSync(join(dir, 'scope.lock')), false)
  }
  assert.equal((await s.write(d => d, 0)).revision, 1)
})

test('锁被占用时拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  await writeFile(join(dir, 'scope.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
  await assert.rejects(() => new ScopeStore(dir).write(d => d, 0), /ERR_SCOPE_LOCKED/)
})

test('坏 JSON 映射为 scope-degraded + ERR_SCOPE_PARSE_FAILED', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'scope.json'), '{ not json')
  const r = await new ScopeStore(dir).read()
  assert.equal(r.degraded, 'scope-degraded')
  assert.equal(r.code, 'ERR_SCOPE_PARSE_FAILED')
  assert.equal(r.doc.mode, 'selected')
})

test('mtime 相同但 revision 变了，缓存仍失效（同毫秒两次写）', async () => {
  const dir = await tempDir()
  const file = join(dir, 'scope.json')
  const pinned = new Date(1_700_000_000_000)
  await writeFile(file, JSON.stringify({ version: 2, revision: 1, mode: 'selected' }))
  await utimes(file, pinned, pinned)

  const s = new ScopeStore(dir)
  assert.equal((await s.read()).doc.revision, 1)
  const cachedMtime = (await stat(file)).mtimeMs

  await writeFile(file, JSON.stringify({ version: 2, revision: 2, mode: 'global' }))
  await utimes(file, pinned, pinned)
  assert.equal((await stat(file)).mtimeMs, cachedMtime, 'test premise: mtime must be unchanged')

  const second = await s.read()
  assert.equal(second.doc.revision, 2)
  assert.equal(second.doc.mode, 'global')
})

test('mtime 与 revision 都不变但文件内容变了，read 返回新内容', async () => {
  const dir = await tempDir()
  const file = join(dir, 'scope.json')
  const pinned = new Date(1_700_000_001_000)
  await writeFile(file, JSON.stringify({ version: 2, revision: 1, mode: 'selected' }))
  await utimes(file, pinned, pinned)

  const s = new ScopeStore(dir)
  assert.equal((await s.read()).doc.mode, 'selected')
  const cachedMtime = (await stat(file)).mtimeMs

  await writeFile(file, JSON.stringify({ version: 2, revision: 1, mode: 'global' }))
  await utimes(file, pinned, pinned)
  assert.equal((await stat(file)).mtimeMs, cachedMtime, 'test premise: mtime must be unchanged')

  assert.equal((await s.read()).doc.mode, 'global')
})

test('缓存命中返回副本：改写 read 结果不污染缓存', async () => {
  const dir = await tempDir()
  await writeFile(
    join(dir, 'scope.json'),
    JSON.stringify({ version: 2, revision: 3, mode: 'selected', workspaceIds: ['ws-1'] }),
  )
  const s = new ScopeStore(dir)
  const first = await s.read()
  first.doc.workspaceIds.push('ws-poisoned')
  first.doc.mode = 'global'
  first.doc.revision = 99

  const second = await s.read()
  assert.deepEqual(second.doc.workspaceIds, ['ws-1'])
  assert.equal(second.doc.mode, 'selected')
  assert.equal(second.doc.revision, 3)
})

test('mutate 返回的数组被调用方改写，不污染缓存与下一次读', async () => {
  const dir = await tempDir()
  const s = new ScopeStore(dir)
  const held: string[] = ['ws-1']
  await s.write(d => ({ ...d, workspaceIds: held }), 0)
  held.push('ws-INJECTED')

  const after = await s.read()
  assert.deepEqual(after.doc.workspaceIds, ['ws-1'])
  const stored = JSON.parse(await readFile(join(dir, 'scope.json'), 'utf8'))
  assert.deepEqual(stored.workspaceIds, ['ws-1'])
})

test('降级结果不进缓存：文件出现后下一次读取立即看到', async () => {
  const dir = await tempDir()
  const s = new ScopeStore(dir)
  assert.equal((await s.read()).code, 'ERR_SCOPE_READ_FAILED')
  await writeFile(join(dir, 'scope.json'), JSON.stringify({ version: 2, revision: 4 }))
  const after = await s.read()
  assert.equal(after.degraded, undefined)
  assert.equal(after.code, undefined)
  assert.equal(after.doc.revision, 4)
})

test('read 不写盘：缺失文件读取后目录仍为空', async () => {
  const dir = await tempDir()
  const r = await new ScopeStore(dir).read()
  assert.equal(r.degraded, 'scope-degraded')
  assert.deepEqual(await readdir(dir), [])
})

test('mutate 抛错时锁仍被释放，下一次写能成功', async () => {
  const dir = await tempDir()
  const s = new ScopeStore(dir)
  await assert.rejects(
    () =>
      s.write(() => {
        throw new Error('mutate exploded')
      }, 0),
    /mutate exploded/,
  )
  assert.equal(existsSync(join(dir, 'scope.lock')), false)
  const after = await s.write(d => ({ ...d, mode: 'global' }), 0)
  assert.equal(after.revision, 1)
  assert.equal((await s.read()).doc.mode, 'global')
})

test('原子写失败时锁仍被释放，且不残留临时文件', async () => {
  const dir = await tempDir()
  const s = new ScopeStore(dir)
  await assert.rejects(() => s.write(d => ({ ...d, workspaceIds: [1n as unknown as string] }), 0))
  assert.equal(existsSync(join(dir, 'scope.lock')), false)
  assert.deepEqual(await readdir(dir), [])
  assert.equal((await s.write(d => d, 0)).revision, 1)
})

test('释放锁只删自己写的锁：临界区内被替换的锁文件保留', async () => {
  const dir = await tempDir()
  const lock = join(dir, 'scope.lock')
  const s = new ScopeStore(dir)
  await s.write(d => {
    unlinkSync(lock)
    writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: 1 }))
    return d
  }, 0)

  assert.equal(existsSync(lock), true)
  assert.deepEqual(JSON.parse(await readFile(lock, 'utf8')), { pid: 1, startedAt: 1 })
  await unlink(lock)
})

test('清理锁失败不掩盖写入成功（releaseLock 吞掉清理错误）', async () => {
  const dir = await tempDir()
  const lock = join(dir, 'scope.lock')
  const s = new ScopeStore(dir)
  const result = await s.write(d => {
    unlinkSync(lock)
    mkdirSync(lock)
    return d
  }, 0)

  assert.equal(result.revision, 1)
  assert.equal(existsSync(join(dir, 'scope.json')), true)
  await rmdir(lock)
})

test('60 秒前创建且 pid 已死的锁被回收', async () => {
  const dir = await tempDir()
  const lock = join(dir, 'scope.lock')
  await writeFile(lock, JSON.stringify({ pid: 999999, startedAt: Date.now() - 61_000 }))
  await utimes(lock, STALE_LOCK_AT, STALE_LOCK_AT)
  assert.equal(pidAlive(999999), false, 'test premise: pid 999999 must be dead')

  const a = await new ScopeStore(dir).write(d => d, 0)
  assert.equal(a.revision, 1)
  assert.equal(existsSync(lock), false)
})

test('60 秒前创建但 pid 存活（含本进程）的锁不回收', async () => {
  const dir = await tempDir()
  const lock = join(dir, 'scope.lock')
  await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 61_000 }))
  await utimes(lock, STALE_LOCK_AT, STALE_LOCK_AT)

  await assert.rejects(
    () => new ScopeStore(dir).write(d => d, 0),
    (error: unknown) => {
      const scopeError = error as NodeJS.ErrnoException
      assert.equal(scopeError.code, 'ERR_SCOPE_LOCKED')
      assert.match(scopeError.message, /ERR_SCOPE_LOCKED/)
      return true
    },
  )
  assert.equal(existsSync(lock), true)
})

test('过期但不可解析或无 pid 的锁可回收', async () => {
  const dir = await tempDir()
  const lock = join(dir, 'scope.lock')
  const s = new ScopeStore(dir)

  await writeFile(lock, 'not json')
  await utimes(lock, STALE_LOCK_AT, STALE_LOCK_AT)
  assert.equal((await s.write(d => d, 0)).revision, 1)

  await writeFile(lock, JSON.stringify({ startedAt: Date.now() - 61_000 }))
  await utimes(lock, STALE_LOCK_AT, STALE_LOCK_AT)
  assert.equal((await s.write(d => d, 1)).revision, 2)
  assert.equal(existsSync(lock), false)
})

test('pid 超出 32 位范围的过期锁按无主锁回收', async () => {
  const dir = await tempDir()
  const lock = join(dir, 'scope.lock')
  await writeFile(lock, JSON.stringify({ pid: 2 ** 32, startedAt: Date.now() - 61_000 }))
  await utimes(lock, STALE_LOCK_AT, STALE_LOCK_AT)

  assert.equal((await new ScopeStore(dir).write(d => d, 0)).revision, 1)
  assert.equal(existsSync(lock), false)
})

test('未过 60 秒的锁即使 pid 已死不回收（只超时不回收）', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'scope.lock'), JSON.stringify({ pid: 999999, startedAt: Date.now() }))
  await assert.rejects(() => new ScopeStore(dir).write(d => d, 0), /ERR_SCOPE_LOCKED/)
})

test('同一毫秒内连续两次 write，第二次看到第一次的 revision', async () => {
  const dir = await tempDir()
  const s = new ScopeStore(dir)
  const first = await s.write(d => d, 0)
  const second = await s.write(d => ({ ...d, mode: 'global' }), first.revision)
  assert.equal(second.revision, 2)
  const read = await s.read()
  assert.equal(read.doc.revision, 2)
  assert.equal(read.doc.mode, 'global')
})

test('读 → 写 → 读：看到新 revision，write 返回值可安全改写', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'scope.json'), JSON.stringify({ version: 2, revision: 0 }))
  const s = new ScopeStore(dir)
  assert.equal((await s.read()).doc.revision, 0)

  const written = await s.write(d => ({ ...d, mode: 'global' }), 0)
  assert.equal(written.revision, 1)
  written.workspaceIds.push('ws-poisoned')

  const after = await s.read()
  assert.equal(after.degraded, undefined)
  assert.equal(after.doc.revision, 1)
  assert.equal(after.doc.mode, 'global')
  assert.deepEqual(after.doc.workspaceIds, [])
})

test('judgement 按 agent key 隔离，未命中返回 fallback，默认 false', () => {
  const s = new ScopeStore('/nonexistent-scope-dir')
  assert.equal(s.judgement('missing'), false)
  assert.equal(s.judgement('missing', true), true)
  s.remember('a', true)
  s.remember('b', false)
  assert.equal(s.judgement('a'), true)
  assert.equal(s.judgement('b'), false)
  assert.equal(s.judgement('c'), false)
  assert.equal(s.judgement('c', true), true)
  s.remember('a', false)
  assert.equal(s.judgement('a'), false)
})

test('写入把 revision 设为 base+1，updatedAt 设为当前 ISO 时间', async () => {
  const dir = await tempDir()
  const s = new ScopeStore(dir)
  const before = Date.now()
  const a = await s.write(d => ({ ...d, revision: 99, updatedAt: 'stale' }), 0)
  assert.equal(a.revision, 1)
  assert.ok(a.updatedAt !== undefined)
  const stamp = Date.parse(a.updatedAt)
  assert.ok(Number.isFinite(stamp))
  assert.ok(stamp >= before - 1000 && stamp <= Date.now() + 1000)
  assert.equal(new Date(stamp).toISOString(), a.updatedAt)

  // Atomic rewrite leaves exactly the returned document on disk, no temp file.
  const stored = JSON.parse(await readFile(join(dir, 'scope.json'), 'utf8'))
  assert.deepEqual(stored, a)
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), [])
})

test('version 1 文件在显式写入时升级到 v2（baseRevision 取降级读数 0）', async () => {
  const dir = await tempDir()
  const file = join(dir, 'scope.json')
  await writeFile(file, JSON.stringify({ version: 1, mode: 'global' }))
  const s = new ScopeStore(dir)

  const before = await s.read()
  assert.equal(before.code, 'ERR_SCOPE_UNKNOWN_VERSION')
  assert.equal(before.doc.revision, 0)

  const upgraded = await s.write(d => ({ ...d, mode: 'global' }), before.doc.revision)
  assert.equal(upgraded.version, 2)
  assert.equal(upgraded.revision, 1)
  assert.equal(upgraded.mode, 'global')

  const after = await s.read()
  assert.equal(after.degraded, undefined)
  assert.equal(after.doc.version, 2)
})

test('写失败的错误在 message 与 .code 上带同一个稳定码', async () => {
  const dir = await tempDir()
  const s = new ScopeStore(dir)
  await s.write(d => d, 0)
  await assert.rejects(
    () => s.write(d => d, 0),
    (error: unknown) => {
      const scopeError = error as NodeJS.ErrnoException
      assert.equal(scopeError.code, 'ERR_SCOPE_REVISION_CONFLICT')
      assert.match(scopeError.message, /ERR_SCOPE_REVISION_CONFLICT/)
      return true
    },
  )
  assert.equal(existsSync(join(dir, 'scope.lock')), false)
})

test('scope.json 不可读（是目录）时 read 降级、write 抛 ERR_SCOPE_READ_FAILED', async () => {
  const dir = await tempDir()
  await mkdir(join(dir, 'scope.json'))
  const s = new ScopeStore(dir)

  const r = await s.read()
  assert.equal(r.degraded, 'scope-degraded')
  assert.equal(r.code, 'ERR_SCOPE_READ_FAILED')

  await assert.rejects(
    () => s.write(d => d, 0),
    (error: unknown) => {
      const scopeError = error as NodeJS.ErrnoException
      assert.equal(scopeError.code, 'ERR_SCOPE_READ_FAILED')
      assert.match(scopeError.message, /ERR_SCOPE_READ_FAILED/)
      // The underlying errno must survive: EACCES/EISDIR/ENOTDIR are different
      // operator problems, and the message is the only diagnostic channel.
      assert.match(scopeError.message, /EISDIR/)
      return true
    },
  )
  assert.equal(existsSync(join(dir, 'scope.lock')), false)
})
