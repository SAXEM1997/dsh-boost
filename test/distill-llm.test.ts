/**
 * Ticket #10: the real model call behind `DistillFn`.
 *
 * The seam follows the selector's pattern exactly: the request carries the
 * route at the top level (never a `route` object), always carries
 * `purpose: 'boost-distill'` so the `llm/stream` hook lets it through without
 * observing or settling it, and every failure is a value. The answer is one
 * JSON object; anything else is "no answer" (which `decide` maps to
 * `distill-failed`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createLlmDistiller, DISTILL_PURPOSE, distillPromptText, DISTILL_SYSTEM_PROMPT } from '../src/distill/llm.ts'
import { questionOf } from '../src/distill/pin.ts'

const question = questionOf('bash')!

function request(over: Partial<Parameters<ReturnType<typeof createLlmDistiller>['call']>[0]> = {}) {
  return {
    text: 'line1\nnpm ERR! boom\nline3',
    question,
    provider: 'deepseek',
    model: 'deepseek-chat',
    maxOutputTokens: 256,
    timeoutMs: 3000,
    key: { receiptHash: 'r', questionHash: 'q', version: 'v', file: 'r-q-v' },
    sessionId: 's1',
    ...over,
  }
}

/** An LLM that answers with `text` as one streamed delta, then a normal finish. */
function llmOf(text: string, seen: { options?: GenerateOptions } = {}, usage?: unknown) {
  return {
    async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      seen.options = options
      yield { type: 'text-delta', index: 0, text }
      if (usage !== undefined) yield { type: 'usage', usage } as StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('请求带 purpose=boost-distill 与顶层 provider/model/maxTokens', async () => {
  const seen: { options?: GenerateOptions } = {}
  const answer = JSON.stringify({ text: 'npm ERR! boom', quotes: ['npm ERR! boom'] })
  const distill = createLlmDistiller(llmOf(answer, seen))
  const got = await distill.call(request())
  assert.equal(seen.options?.purpose, DISTILL_PURPOSE)
  assert.equal(DISTILL_PURPOSE, 'boost-distill')
  assert.equal(seen.options?.provider, 'deepseek')
  assert.equal(seen.options?.model, 'deepseek-chat')
  assert.equal(seen.options?.maxTokens, 256)
  assert.equal('route' in (seen.options ?? {}), false, 'the route is top-level, never a route object')
  assert.equal(seen.options?.system, DISTILL_SYSTEM_PROMPT)
  assert.ok(DISTILL_SYSTEM_PROMPT.includes('{"text"') || DISTILL_SYSTEM_PROMPT.includes('"quotes"'))
  const messages = seen.options?.messages ?? []
  assert.equal(messages.length, 1)
  assert.ok(JSON.stringify(messages).includes('npm ERR! boom'), 'the receipt text is sent')
  assert.deepEqual(got, { text: 'npm ERR! boom', quotes: ['npm ERR! boom'], model: 'deepseek-chat' })
})

test('提示词含族问题与原文，且原文整段可逐字引用', () => {
  const prompt = distillPromptText({ question, text: 'a\u0000b' })
  assert.ok(prompt.includes(question.text))
  assert.ok(prompt.includes('a\u0000b'))
})

test('JSON 解析失败返回 undefined（→ distill-failed）', async () => {
  const distill = createLlmDistiller(llmOf('not json at all'))
  assert.equal(await distill.call(request()), undefined)
})

test('形状不对返回 undefined：缺 text、quotes 不是字符串数组', async () => {
  for (const bad of [
    JSON.stringify({ quotes: ['x'] }),
    JSON.stringify({ text: 'x' }),
    JSON.stringify({ text: 'x', quotes: [1, 2] }),
    JSON.stringify(['x']),
    'null',
  ]) {
    const distill = createLlmDistiller(llmOf(bad))
    assert.equal(await distill.call(request()), undefined, bad)
  }
})

test('stream 抛错向上抛（由 decide 归为 distill-failed）', async () => {
  const llm = {
    async *stream(): AsyncGenerator<StreamChunk> {
      throw new Error('provider down')
    },
  }
  const distill = createLlmDistiller(llm)
  await assert.rejects(() => distill.call(request()))
})

test('finish=error 视为失败，即使已有部分文本', async () => {
  const llm = {
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '{"text":"x","quotes":[]}' }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream' } } } as StreamChunk
    },
  }
  assert.equal(await createLlmDistiller(llm).call(request()), undefined)
})

test('usage 存在时带 tokens', async () => {
  const answer = JSON.stringify({ text: 'x', quotes: ['line3'] })
  const distill = createLlmDistiller(llmOf(answer, {}, { completionTokens: 17 }))
  const got = await distill.call(request())
  assert.equal(got?.tokens, 17)
})

test('围栏代码块里的 JSON 也被接受；额外空白被忽略', async () => {
  const answer = '```json\n{"text":"x","quotes":["line1"]}\n```'
  const got = await createLlmDistiller(llmOf(answer)).call(request())
  assert.deepEqual(got, { text: 'x', quotes: ['line1'], model: 'deepseek-chat' })
})

test('answers 的 model 字段被忽略：模型标识来自请求路由', async () => {
  const answer = JSON.stringify({ text: 'x', quotes: [], model: 'someone-else' })
  const got = await createLlmDistiller(llmOf(answer)).call(request())
  assert.equal(got?.model, 'deepseek-chat')
})
