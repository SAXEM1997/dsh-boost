import test from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { PendingQueue, callIdFor } from '../src/hooks/pending.ts'
import type { PendingEntry } from '../src/hooks/pending.ts'
import { synthesizeTurn } from '../src/hooks/synthesize.ts'

function entry(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    callId: callIdFor('session-1', 3, 'cand-7'),
    candidateId: 'cand-7',
    name: 'read',
    args: { path: '/tmp/example.txt', limit: 10 },
    turn: 3,
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

async function collect(e: PendingEntry): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of synthesizeTurn(e)) chunks.push(chunk)
  return chunks
}

function blockOf(chunks: StreamChunk[], index: number): Extract<StreamChunk, { type: 'block-end' }>['block'] {
  const chunk = chunks[index]
  assert.equal(chunk?.type, 'block-end')
  if (chunk?.type !== 'block-end') throw new Error(`chunk ${index} is not block-end`)
  return chunk.block
}

// ---------------------------------------------------------------------------
// 简报五条（逐条保留）
// ---------------------------------------------------------------------------

test('队列按 sessionId 隔离：peek 另一会话返回 undefined', () => {
  const queue = new PendingQueue()
  queue.set('session-a', entry())
  assert.equal(queue.peek('session-b'), undefined)
  assert.equal(queue.peek('session-a')?.candidateId, 'cand-7')
})

test('callIdFor 对同候选不同 turn 产生不同 id，同参数幂等', () => {
  const id = callIdFor('session-1', 3, 'cand-7')
  assert.equal(callIdFor('session-1', 3, 'cand-7'), id)
  assert.notEqual(callIdFor('session-1', 4, 'cand-7'), id)
  assert.notEqual(callIdFor('session-1', 3, 'cand-8'), id)
})

test('合成回合的 chunk 类型序列恰为七块', async () => {
  const chunks = await collect(entry())
  assert.deepEqual(
    chunks.map(chunk => chunk.type),
    [
      'block-start',
      'reasoning-delta',
      'block-end',
      'block-start',
      'tool-call-delta',
      'block-end',
      'finish',
    ],
  )
})

test('tool-call 的 block.arguments 是 JSON 串、与 argumentsDelta 相同，block.id 非空', async () => {
  const pending = entry()
  const chunks = await collect(pending)

  const delta = chunks[4]
  assert.equal(delta?.type, 'tool-call-delta')
  if (delta?.type !== 'tool-call-delta') throw new Error('chunk 4 is not tool-call-delta')

  const block = blockOf(chunks, 5)
  assert.equal(block.type, 'tool-call')
  if (block.type !== 'tool-call') throw new Error('chunk 5 does not carry a tool-call block')

  assert.equal(typeof block.arguments, 'string')
  assert.equal(block.arguments, delta.argumentsDelta)
  assert.equal(block.id, pending.callId)
  assert.equal(block.id.length > 0, true)
  assert.equal(block.name, pending.name)
  assert.deepEqual(JSON.parse(block.arguments), pending.args)
})

test('首个 chunk 是 reasoning（缺它下一次请求 400，附录 §7）', async () => {
  const chunks = await collect(entry())
  const first = chunks[0]
  assert.equal(first?.type, 'block-start')
  if (first?.type !== 'block-start') throw new Error('first chunk is not block-start')
  assert.equal(first.index, 0)
  assert.equal(first.blockType, 'reasoning')

  const firstTool = chunks.findIndex(
    chunk => chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call'),
  )
  assert.equal(firstTool, 3)
})

// ---------------------------------------------------------------------------
// 规则 1：PendingQueue 是 sessionId 键的 Map，每会话一条
// ---------------------------------------------------------------------------

test('set 覆盖同会话旧条目，size 不增长', () => {
  const queue = new PendingQueue()
  const first = entry({ candidateId: 'cand-1' })
  const second = entry({ candidateId: 'cand-2' })
  queue.set('session-a', first)
  queue.set('session-a', second)
  assert.equal(queue.size(), 1)
  assert.equal(queue.peek('session-a'), second)
})

test('take 移除并返回条目，第二次 take 为 undefined', () => {
  const queue = new PendingQueue()
  const pending = entry()
  queue.set('session-a', pending)
  assert.equal(queue.take('session-a'), pending)
  assert.equal(queue.take('session-a'), undefined)
  assert.equal(queue.size(), 0)
})

test('peek 不移除，take 空队列返回 undefined', () => {
  const queue = new PendingQueue()
  const pending = entry()
  queue.set('session-a', pending)
  assert.equal(queue.peek('session-a'), pending)
  assert.equal(queue.size(), 1)
  assert.equal(queue.take('session-b'), undefined)
})

test('clear 移除条目，对不存在的会话是 no-op', () => {
  const queue = new PendingQueue()
  queue.set('session-a', entry())
  queue.clear('session-a')
  assert.equal(queue.size(), 0)
  queue.clear('never-set')
  assert.equal(queue.size(), 0)
})

test('size 按会话计数，跨会话互不影响', () => {
  const queue = new PendingQueue()
  queue.set('session-a', entry({ candidateId: 'cand-a' }))
  queue.set('session-b', entry({ candidateId: 'cand-b' }))
  assert.equal(queue.size(), 2)
  assert.equal(queue.peek('session-a')?.candidateId, 'cand-a')
  assert.equal(queue.peek('session-b')?.candidateId, 'cand-b')
  queue.take('session-a')
  assert.equal(queue.size(), 1)
  assert.equal(queue.peek('session-b')?.candidateId, 'cand-b')
})

// ---------------------------------------------------------------------------
// 规则 2：callIdFor 是 sha256 前 16 位十六进制，跨进程稳定
// ---------------------------------------------------------------------------

test('callIdFor 固定输入的字面量哈希（跨进程稳定）', () => {
  const id = callIdFor('sess-1', 3, 'cand-7')
  assert.match(id, /^[0-9a-f]{16}$/)
  // sha256('sess-1/3/cand-7').slice(0, 16)，由独立进程复算后钉死。
  assert.equal(id, '4b1a7bc52a16f2e1')
})

test('callIdFor 对 turn 0 与字符串 turn 都返回 16 位十六进制', () => {
  assert.match(callIdFor('session-1', 0, 'cand-7'), /^[0-9a-f]{16}$/)
  assert.match(callIdFor('session-1', '3', 'cand-7'), /^[0-9a-f]{16}$/)
})

test('callIdFor 对同值数字与字符串 turn 一致（拼接按字符串进行）', () => {
  assert.equal(callIdFor('session-1', 3, 'cand-7'), callIdFor('session-1', '3', 'cand-7'))
  assert.equal(callIdFor('session-1', 0, 'cand-7'), callIdFor('session-1', '0', 'cand-7'))
})

// ---------------------------------------------------------------------------
// 规则 3/4/5：chunk 的 index、字段形状与顺序
// ---------------------------------------------------------------------------

test('index 值固定为 reasoning 0、tool-call 1，finish 没有 index', async () => {
  const chunks = await collect(entry())
  const indexed = chunks.flatMap(chunk => (chunk.type === 'finish' ? [] : [chunk.index]))
  assert.deepEqual(indexed, [0, 0, 0, 1, 1, 1])
})

test('没有 usage chunk（没有测量就不能伪造账本条目）', async () => {
  const chunks = await collect(entry())
  assert.equal(chunks.some(chunk => chunk.type === 'usage'), false)
})

test('reasoning 块只有 type/text，无伪造签名', async () => {
  const chunks = await collect(entry())
  const reasoning = blockOf(chunks, 2)
  assert.equal(reasoning.type, 'reasoning')
  if (reasoning.type !== 'reasoning') throw new Error('chunk 2 does not carry a reasoning block')
  assert.deepEqual(Object.keys(reasoning).sort(), ['text', 'type'])
  assert.equal(reasoning.text.length > 0, true)

  const delta = chunks[1]
  assert.equal(delta?.type, 'reasoning-delta')
  if (delta?.type !== 'reasoning-delta') throw new Error('chunk 1 is not reasoning-delta')
  assert.equal(delta.text, reasoning.text)
})

test('tool-call 的 block-start 在工具块之前，finish 以 tool-calls 结束', async () => {
  const chunks = await collect(entry())
  const toolStart = chunks[3]
  assert.equal(toolStart?.type, 'block-start')
  if (toolStart?.type !== 'block-start') throw new Error('chunk 3 is not block-start')
  assert.equal(toolStart.index, 1)
  assert.equal(toolStart.blockType, 'tool-call')

  assert.deepEqual(chunks[6], { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('tool-call block 只含 type/id/name/arguments 四个字段', async () => {
  const chunks = await collect(entry())
  const block = blockOf(chunks, 5)
  if (block.type !== 'tool-call') throw new Error('chunk 5 does not carry a tool-call block')
  assert.deepEqual(Object.keys(block).sort(), ['arguments', 'id', 'name', 'type'])
})

// ---------------------------------------------------------------------------
// 规则 6/7：纯生成、坏输入不抛出
// ---------------------------------------------------------------------------

test('同一 entry 两次生成逐块相同，且 createdAt 不参与输出（不读时钟）', async () => {
  const first = await collect(entry({ createdAt: 1 }))
  const second = await collect(entry({ createdAt: 999_999_999_999 }))
  assert.deepEqual(first, second)
})

test('生成不修改 entry.args', async () => {
  const pending = entry()
  const original = JSON.parse(JSON.stringify(pending.args))
  await collect(pending)
  assert.deepEqual(pending.args, original)
})

test('空 callId 被拒绝：生成器在首个 yield 前抛 RangeError', async () => {
  await assert.rejects(collect(entry({ callId: '' })), /callId.*non-empty/)
})

test('不可序列化 args（BigInt）不抛出，以 error finish 终止且不发 tool-call', async () => {
  const chunks = await collect(entry({ args: { count: 1n } }))
  assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
  const last = chunks.at(-1)
  assert.equal(last?.type, 'finish')
  if (last?.type !== 'finish') throw new Error('last chunk is not finish')
  assert.equal(last.reason.kind, 'error')
  if (last.reason.kind !== 'error') throw new Error('finish reason is not error')
  assert.equal(last.reason.failure.code, 'BOOST_ARGS_UNSERIALISABLE')
  assert.match(last.reason.failure.message, /serialise/)
})

test('不可序列化 args（环）不抛出，以 error finish 终止', async () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const chunks = await collect(entry({ args: cyclic }))
  assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
  const last = chunks.at(-1)
  assert.equal(last?.type, 'finish')
  if (last?.type !== 'finish') throw new Error('last chunk is not finish')
  assert.equal(last.reason.kind, 'error')
  if (last.reason.kind !== 'error') throw new Error('finish reason is not error')
  assert.equal(last.reason.failure.code, 'BOOST_ARGS_UNSERIALISABLE')
})

// ---------------------------------------------------------------------------
// 代码组织：模块只导出约定符号
// ---------------------------------------------------------------------------

test('pending.ts 只导出 PendingQueue 与 callIdFor', async () => {
  const module = await import('../src/hooks/pending.ts')
  assert.deepEqual(Object.keys(module).sort(), ['PendingQueue', 'callIdFor'])
})

test('synthesize.ts 只导出 synthesizeTurn，两个 helper 保持私有', async () => {
  const module = await import('../src/hooks/synthesize.ts')
  assert.deepEqual(Object.keys(module).sort(), ['synthesizeTurn'])
})
