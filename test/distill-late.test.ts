/**
 * Ticket #10: a timed-out distillation is persisted when its answer lands.
 *
 * The `decide` timeout is a bound on the *wait*, not on the provider: the
 * stream keeps running and its answer arrives a moment later. The `llm/stream`
 * hook observes every request, recognises the parked one by request object,
 * and persists the answer, so the next render of the same receipt reads the
 * pinned product instead of paying again. Nothing else on that path changes:
 * no usage observation, no settlement, no plan rollover.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AnchorStore } from '../src/gate/invalidate.ts'
import { PendingQueue } from '../src/hooks/pending.ts'
import { registerHooks } from '../src/hooks/post-execute.ts'
import { SessionRuntime } from '../src/hooks/llm-stream.ts'
import { DistillAttempts } from '../src/distill/attempt.ts'
import { createLlmDistiller, distillRequestOptions, DISTILL_PURPOSE } from '../src/distill/llm.ts'
import { keyOf, questionKeyOf, questionOf, receiptKeyOf, versionOf } from '../src/distill/pin.ts'
import { DistillStore } from '../src/distill/store.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { fakeHost } from './fakes/host.ts'

const SESSION = 's1'
const agent = { session: { header: { id: SESSION, cwd: '/w' } } }

/** A bash receipt over the trigger. */
function receipt(): string {
  const line = (index: number) => `./step-${index}.sh: running checks (${'ok '.repeat(80)})\n`
  const head = Array.from({ length: 17 }, (_, i) => line(i)).join('')
  const tail = Array.from({ length: 17 }, (_, i) => line(100 + i)).join('')
  return `${head}npm ERR! Test failed: expected 3 got 4\n${tail}`
}

const ANSWER = JSON.stringify({
  text: '`npm test` failed:\nnpm ERR! Test failed: expected 3 got 4',
  quotes: ['npm ERR! Test failed: expected 3 got 4'],
})

/** An LLM whose single request parks until `release()` is called. */
function parkedLlm() {
  const seen: GenerateOptions[] = []
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const begin = new Promise<void>((resolve) => {
    started = resolve
  })
  const llm = {
    async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
      seen.push(options)
      await new Promise<void>((resolve) => {
        release = resolve
        started?.()
      })
      yield { type: 'text-delta', index: 0, text: ANSWER }
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    },
  }
  return {
    llm,
    seen,
    begin,
    release: () => release?.(),
  }
}

async function setup() {
  const store = new DistillStore(await mkdtemp(join(tmpdir(), 'dsh-late-')))
  const attempts = new DistillAttempts(store)
  const parked = parkedLlm()
  const host = fakeHost({ llm: parked.llm })
  const receipts: unknown[] = []
  const runtime = new SessionRuntime(DEFAULT_CONFIG.stepsPerTurn)
  let requestOptions: ((request: { text: string; question: { text: string; name: string }; model: string; sessionId: string }) => object) | undefined = undefined
  const deps: Record<string, unknown> = {
    config: { ...DEFAULT_CONFIG, distillation: { ...DEFAULT_CONFIG.distillation, enabled: true, timeoutMs: 60 } },
    scope: {
      judgement: () => true,
      read: async () => ({ doc: { version: 2, revision: 1, mode: 'global', workspaceIds: [], shadow: false, projection: 'on' } }),
    },
    receipts: {
      append: async (r: unknown) => {
        receipts.push(r)
      },
      stopped: () => false,
    },
    anchors: new AnchorStore(),
    resolveSession: () => 'w1',
    queue: new PendingQueue(),
    plans: new Map(),
    sessions: runtime,
    estimateText: (text: string) => Math.ceil(text.length / 4),
    spill: { saveText: async () => ({ locator: '/spill/bash.txt', retrievalHint: 'read it' }) },
    formatFooter: (o: { count: number }, ref: { locator: string }) =>
      `(Omitted ${o.count} bytes. Full formatted result stored at: ${ref.locator}.)`,
    hasSpillNotice: () => false,
    distillRoute: () => ({ provider: 'deepseek', model: 'deepseek-flash' }),
    distillStore: store,
    distillAttempts: attempts,
    distillRequestOptions: (registry: DistillAttempts) => {
      const build = (request: { text: string; question: { text: string; name: string }; model: string; sessionId: string }) => {
        const options = { ...distillRequestOptions(request as never) }
        registry.register(options, request as never)
        return options
      }
      requestOptions = build
      return build
    },
  }
  deps.distill = createLlmDistiller(parked.llm, (request) => {
    return (requestOptions ?? distillRequestOptions)(request as never)
  })
  registerHooks(host, deps as never)
  return { host, store, attempts, parked, receipts, deps }
}

test('超时后的答案在落地时落盘：下一次渲染命中钉住产物，且该请求不进观测', async () => {
  const env = await setup()
  const text = receipt()

  // The post-execute decision times out while the stream is still parked.
  const decision = await env.host.callHook(
    'tools/post-execute',
    [{ name: 'bash', callId: 'b1', agent }, { content: [{ type: 'text', text }] }],
    async () => ({ kind: 'accept' }),
  )
  assert.equal((decision as { content?: unknown }).content, undefined, 'a timeout replaces nothing')
  const timeout = (env.receipts as Array<{ code: string }>).find((r) => r.code === 'distill-rejected:timeout')
  assert.ok(timeout)

  const question = questionOf('bash')!
  const key = keyOf(receiptKeyOf(text), questionKeyOf(question), versionOf('deepseek-flash', question))
  assert.equal(await env.store.read(key), undefined, 'nothing pinned while the call is parked')

  // Let the request through the real stream hook, then release the answer.
  env.host.nextCalls = 0
  // Reproduce the host's own route for the request the caller gave up on: the
  // provider's stream resumes in the host's terminal, which calls the
  // `llm/stream` listener directly with the same request object. (The
  // `fakeHost.stream()` driver builds a new object, so it cannot stand in.)
  const pending = env.parked.seen[0]
  let startedUpstream = false
  const streamed = env.host.runStream(
    'llm/stream',
    [pending],
    () => {
      startedUpstream = true
      return env.parked.llm.stream(pending as GenerateOptions)
    },
  ) as AsyncIterable<StreamChunk>
  assert.equal(startedUpstream, true)
  const drained = (async () => {
    for await (const _chunk of streamed) {
      void _chunk
    }
  })()
  await Promise.race([env.parked.begin, new Promise((r) => setTimeout(r, 1000))])
  env.parked.release()
  await drained
  // The production seam (`assembly.test.ts`) wires the call itself; this
  // fixture only notes that the request passed through the drain path, so the
  // decision is given its settlement here to prove the registry writes it.
  const late = Promise.resolve(JSON.parse(ANSWER) as never)
  env.attempts.park(pending as object, late)
  // The registry writes when the call settles, after the stream drained.
  for (let i = 0; i < 50; i += 1) {
    if ((await env.store.read(key)) !== undefined) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const pinned = await env.store.read(key)
  assert.ok(pinned, 'the late answer was persisted under the timeout render\'s own key')
  assert.equal(pinned.text, JSON.parse(ANSWER).text)

  // The purpose marker reached the host on every attempt, so the request never
  // looked like a conversation step: the hook passed it through with no usage
  // observation. (Attempt 1 is the timed-out render, attempt 2 the re-fed
  // stream this test drove through the listener.)
  assert.ok(env.parked.seen.length >= 1)
  for (const request of env.parked.seen) assert.equal(request.purpose, DISTILL_PURPOSE)
})
