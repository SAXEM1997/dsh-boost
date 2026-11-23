/**
 * Ticket #10: the distillation decision.
 *
 * `decide` is the whole contract in one function: a pre-gate (over the family's
 * trigger), a table lookup that must win over any model call, a model call
 * bounded by a timeout, a quote check, a post-gate that only adopts a body
 * strictly shorter than the truncation view it replaces, and a write before the
 * bytes are returned. Every failure is a value — `{ content, code }` — never a
 * throw, and every failure returns the truncation view.
 *
 * The fake `DistillFn` counts its calls: "the table won" is only proven when
 * the counter did not move.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decide, verifyQuotes } from '../src/distill/decide.ts'
import type { DecideInput } from '../src/distill/decide.ts'
import type { DistillAnswer, DistillRequest } from '../src/distill/types.ts'
import { questionOf } from '../src/distill/pin.ts'
import { DistillStore } from '../src/distill/store.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { renderHeadLine, truncate } from '../src/projection/truncate.ts'
import type { BoostConfig } from '../src/types.ts'
import { projectApply, projectShadow } from '../src/projection/apply.ts'

const footer = (o: { kind: 'exact'; count: number }, ref: { locator: string }) =>
  `(Omitted ${o.count} bytes. Full formatted result stored at: ${ref.locator}. Read the full result.)`
const SPILL = { saveText: async () => ({ locator: '/spill/bash.txt', retrievalHint: 'read it' }) }

/** A config with distillation on for bash, everything else at its default. */
function onConfig(over: Partial<BoostConfig['distillation']> = {}): BoostConfig {
  return {
    ...DEFAULT_CONFIG,
    distillation: { ...DEFAULT_CONFIG.distillation, enabled: true, ...over },
  }
}



/**
 * A bash receipt whose important line sits in the middle truncation would cut.
 *
 * The length is chosen so the adopted view (~110 characters) is about half the
 * truncation view (~2,700), i.e. it clears the post-gate with room to spare —
 * no test here depends on a borderline comparison.
 */
function receipt(): string {
  const noise = (index: number) => `./step-${index}.sh: running checks (${'ok '.repeat(80)})\n`
  // 2 × 17 lines × ~330 characters ≈ 11,200 code points, comfortably above the
  // family's 4,000 trigger; the middle line is what the windows cut away.
  const head = Array.from({ length: 17 }, (_, i) => noise(i)).join('')
  const middle = 'npm ERR! Test failed: expected 3 got 4\nat src/x.ts:12\nexit code 1\n'
  const tail = Array.from({ length: 17 }, (_, i) => noise(100 + i)).join('')
  return `${head}${middle}${tail}`
}

/** A distillation answer that quotes one real fragment of `text`. */
function goodAnswer(text: string): DistillAnswer {
  const quote = 'npm ERR! Test failed: expected 3 got 4'
  assert.ok(text.includes(quote))
  return {
    text: '`npm test` failed:\n' + quote + '\n`src/x.ts:12`',
    quotes: [quote],
    tokens: 42,
    model: 'deepseek-flash',
  }
}

/** A counting `DistillFn` around a canned answer. */
function fakeFn(build: (request: DistillRequest) => Promise<DistillAnswer | undefined>) {
  const calls: DistillRequest[] = []
  return {
    calls,
    fn: {
      async call(request: DistillRequest) {
        calls.push(request)
        return build(request)
      },
    },
  }
}

async function makeStore(): Promise<DistillStore> {
  return new DistillStore(await mkdtemp(join(tmpdir(), 'dsh-decide-')))
}

function baseInput(store: DistillStore, over: Partial<DecideInput> = {}): DecideInput {
  const text = receipt()
  return {
    text,
    family: 'bash',
    cfg: onConfig(),
    sessionId: 's1',
    store,
    distill: fakeFn(async (request) => goodAnswer(request.text)).fn,
    route: { provider: 'p', model: 'deepseek-flash' },
    formatFooter: footer,
    spill: SPILL,
    ...over,
  }
}

test('verifyQuotes：每个引用都是原文的非空子串才通过', () => {
  const source = 'alpha\nbeta\ngamma'
  assert.equal(verifyQuotes(['alpha', 'gamma'], source), true)
  assert.equal(verifyQuotes([], source), false, 'an answer that quotes nothing is unverifiable, not merely unfaked')
  assert.equal(verifyQuotes(['alpah'], source), false, 'a typo is not a substring')
  assert.equal(verifyQuotes([''], source), false, 'an empty quote is vacuous')
  assert.equal(verifyQuotes(['alpha', 'delta'], source), false, 'one bad quote rejects the answer')
})

test('预门：未超阈值直接返回 null，不建目录、不调模型', async () => {
  const store = await makeStore()
  const fake = fakeFn(async () => undefined)
  const r = await decide(baseInput(store, { text: 'short', distill: fake.fn }))
  assert.equal(r, null)
  assert.equal(fake.calls.length, 0)
})

test('预门：族不在 families 里返回 null（即使超过阈值）', async () => {
  const store = await makeStore()
  const fake = fakeFn(async (request) => goodAnswer(request.text))
  const r = await decide(baseInput(store, { cfg: onConfig({ families: ['ssh'] }), distill: fake.fn }))
  assert.equal(r, null)
  assert.equal(fake.calls.length, 0)
})

test('预门：distillation.enabled=false 时与 0.2.7 完全一致（返回 null）', async () => {
  const store = await makeStore()
  const fake = fakeFn(async (request) => goodAnswer(request.text))
  const r = await decide(baseInput(store, { cfg: { ...onConfig(), distillation: { ...onConfig().distillation, enabled: false } }, distill: fake.fn }))
  assert.equal(r, null)
  assert.equal(fake.calls.length, 0)
})

test('采用：正文 + 宿主页脚 + distill 收据；omitted = 原文 − 蒸馏正文（UTF-8 字节）', async () => {
  const store = await makeStore()
  const input = baseInput(store)
  const fake = fakeFn(async (request) => goodAnswer(request.text))
  const r = await decide({ ...input, distill: fake.fn })
  assert.ok(r?.content, 'the receipt is replaced')
  assert.equal(fake.calls.length, 1)
  const answer = goodAnswer(input.text)
  const omitted = Buffer.byteLength(input.text, 'utf8') - Buffer.byteLength(answer.text, 'utf8')
  const expectedFooter = footer({ kind: 'exact', count: omitted }, { locator: '/spill/bash.txt' })
  const totalChars = Array.from(input.text).length
  assert.ok(
    r.content.startsWith(`[distilled from ${totalChars} chars; bash]\n${answer.text}\n`),
    `unexpected head: ${JSON.stringify(r.content.slice(0, 120))}`,
  )
  assert.ok(r.content.endsWith(`\n\n${expectedFooter}`), 'the host footer keeps its shape')
  assert.equal(r.code, 'distill')
  assert.equal(r.mode, 'adopted')
  assert.deepEqual(r.quotes, answer.quotes)
  assert.equal(r.evidence?.adopted, true)
  // 收据数字与页脚字节自洽：omitted + 蒸馏正文 = 原文
  assert.equal(r.omittedBytes, omitted)
  assert.equal(omitted + Buffer.byteLength(answer.text, 'utf8'), Buffer.byteLength(input.text, 'utf8'))
})

test('查表优先：同一回执第二次调用只查表，不调模型，且字节相同', async () => {
  const store = await makeStore()
  const fake = fakeFn(async (request) => goodAnswer(request.text))
  const input = baseInput(store, { distill: fake.fn })
  const first = await decide(input)
  const second = await decide(input)
  assert.ok(first && second)
  assert.equal(fake.calls.length, 1, 'the second call must not invoke the model')
  assert.equal(first.content, second.content)
  // `called` is the one field that must differ: the first invocation paid for
  // the model, the second read the table.
  assert.equal(first.evidence.called, true)
  assert.equal(second.evidence.called, false)
  // `tokens` and `inputChars` describe the call itself, so a hit — which made
  // no call — legitimately omits both.
  const { tokens: _tokens, inputChars: _inputChars, ...firstEvidence } = first.evidence
  assert.deepEqual({ ...firstEvidence, called: false }, second.evidence)
  assert.deepEqual(first.quotes, second.quotes)
  assert.equal(second.evidence?.adopted, true, 'a hit is reported as adopted')
  assert.equal(first.code, 'distill')
  assert.equal(second.code, 'distill')
})

test('查表命中不再落盘：产物里钉住 locator，重放不产生第二份 spill 文件', async () => {
  const store = await makeStore()
  // The real backend derives the file name from `randomBytes(6)`, so a second
  // `saveText` for the same receipt returns a *different* locator — which would
  // make the composed view differ between the first render and any replay.
  let spills = 0
  const countingSpill = {
    saveText: async () => {
      spills += 1
      return { locator: `/spill/bash-${spills}.txt`, retrievalHint: 'read it' }
    },
  }
  const fake = fakeFn(async (request) => goodAnswer(request.text))
  const input = baseInput(store, { distill: fake.fn, spill: countingSpill })
  const first = await decide(input)
  const second = await decide(input)
  assert.ok(first && second)
  assert.equal(spills, 1, 'a table hit must not write a second spill artifact')
  assert.equal(second.content, first.content, 'the replay renders the same bytes')
  assert.equal(fake.calls.length, 1)
})

test('空正文 → distill-rejected:empty，且不落盘原文', async () => {
  const store = await makeStore()
  let spills = 0
  const countingSpill = { saveText: async () => { spills += 1; return { locator: '/s', retrievalHint: 'r' } } }
  const fake = fakeFn(async () => ({ text: '   ', quotes: ['npm ERR! Test failed'], model: 'm' }))
  const r = await decide(baseInput(store, { distill: fake.fn, spill: countingSpill }))
  assert.equal(r?.code, 'distill-rejected:empty')
  assert.equal(r?.content, null)
  assert.equal(spills, 0, 'a body that cannot be used must not spill the original')
})

test('被拒的结果也钉住：重放读墓碑，不再调模型', async () => {
  const store = await makeStore()
  const fake = fakeFn(async () => ({ text: 'x', quotes: ['not in the receipt'], model: 'm' }))
  const input = baseInput(store, { distill: fake.fn })
  const first = await decide(input)
  assert.equal(first?.code, 'distill-rejected:unverifiable')
  const second = await decide(input)
  assert.equal(second?.code, 'distill-rejected:unverifiable')
  assert.equal(second?.content, null)
  assert.equal(fake.calls.length, 1, 'the refusal is a decision; a replay must not pay for it again')
  assert.equal(second?.evidence.called, false, 'the replay reports that no call happened')
})

test('超时不钉墓碑：迟到答案仍能被重放采用', async () => {
  const store = await makeStore()
  const slow = { call: () => new Promise<never>(() => {}) }
  const input = baseInput(store, {
    distill: slow as never,
    cfg: onConfig({ timeoutMs: 20 }),
  })
  const r = await decide(input)
  assert.equal(r?.code, 'distill-rejected:timeout')
  const again = await decide(baseInput(store, { distill: fakeFn(async (q) => goodAnswer(q.text)).fn }))
  assert.equal(again?.mode, 'adopted', 'nothing was pinned, so a later attempt can still adopt')
})

test('落盘优先：返回的字节 = 盘上的字节；写盘失败 → distill-failed + null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-decide-'))
  await writeFile(join(dir, 'distilled'), 'not a directory')
  const store = new DistillStore(dir)
  const fake = fakeFn(async (request) => goodAnswer(request.text))
  const r = await decide(baseInput(store, { distill: fake.fn }))
  assert.ok(r)
  assert.equal(r.content, null, 'no product reached history')
  assert.equal(r.code, 'distill-failed')
  assert.equal(r.mode, 'fallback')
})

test('伪造引用 → distill-rejected:unverifiable，content 为 null（调用方退回截断）', async () => {
  const store = await makeStore()
  const fake = fakeFn(async (request) => ({
    text: 'summary',
    quotes: [request.text.slice(0, 10), 'NOT IN THE RECEIPT'],
    model: 'm',
  }))
  const r = await decide(baseInput(store, { distill: fake.fn }))
  assert.ok(r)
  assert.equal(r.content, null)
  assert.equal(r.code, 'distill-rejected:unverifiable')
  assert.equal(r.evidence?.reason, 'unverifiable')
})

test('一条引用都没有 → unverifiable（引用是唯一的可核验信号）', async () => {
  const store = await makeStore()
  const fake = fakeFn(async () => ({ text: 's', quotes: [], model: 'm' }))
  const r = await decide(baseInput(store, { distill: fake.fn }))
  assert.equal(r?.code, 'distill-rejected:unverifiable')
})

test('空引用 → unverifiable', async () => {
  const store = await makeStore()
  const fake = fakeFn(async () => ({ text: 's', quotes: [''], model: 'm' }))
  const r = await decide(baseInput(store, { distill: fake.fn }))
  assert.equal(r?.code, 'distill-rejected:unverifiable')
})

test('净赚门：蒸馏正文 + 页脚不短于截断视图 → distill-rejected:not-smaller', async () => {
  const store = await makeStore()
  const input = baseInput(store)
  const quote = 'npm ERR! Test failed: expected 3 got 4'
  // A "summary" as long as the original: it cannot beat the truncation view.
  const fake = fakeFn(async () => ({ text: input.text.slice(0, 6000), quotes: [quote], model: 'm' }))
  const view = truncate(input.text, DEFAULT_CONFIG.projection.bash)!
  const truncationView = `${view.head}\n${footer({ kind: 'exact', count: view.omittedBytes }, { locator: '/spill/bash.txt' })}\n${view.tail}`
  assert.equal(input.text.slice(0, 6000).length >= truncationView.length, true)
  const r = await decide({ ...input, distill: fake.fn })
  assert.equal(r?.code, 'distill-rejected:not-smaller')
  assert.equal(r?.content, null)
})

test('净赚门按 UTF-8 字节：某族按字符比更短、按字节比更长时必须拒绝', async () => {
  const store = await makeStore()
  // A CJK receipt: the configured 2200-code-point trigger is met by 3000 CJK
  // characters, and `truncate`'s own net-gain guard still passes (it compares
  // UTF-16 units), so only the post-gate can see the byte disagreement.
  const text = '中'.repeat(3000)
  const fake = fakeFn(async () => ({ text: '中'.repeat(2200), quotes: ['中'], model: 'm' }))
  const cfg: BoostConfig = {
    ...onConfig(),
    // 3000 CJK characters with head 2100 / tail 90: `truncate` passes its
    // UTF-16 net-gain check (2339 < 3000); the bytes say 6730 > 6719.
    projection: { ...DEFAULT_CONFIG.projection, bash: { triggerChars: 2200, headChars: 2100, tailChars: 90 } },
  }
  const view = truncate(text, cfg.projection.bash)!
  const footerText = footer({ kind: 'exact', count: view.omittedBytes }, { locator: '/spill/bash.txt' })
  const truncationView = `${renderHeadLine(view)}\n${view.head}\n${footerText}\n${view.tail}`
  // 2200 quoted characters plus the marker and the footer: still shorter in
  // characters, longer in bytes.
  const adoptedView = '[distilled from 3000 chars; bash]\n' + '中'.repeat(2200) + '\n\n' + footerText
  // Exactly the disagreement the gate must resolve by bytes, not characters.
  assert.ok(adoptedView.length < truncationView.length, `chars: ${adoptedView.length} vs ${truncationView.length}`)
  assert.ok(Buffer.byteLength(adoptedView, 'utf8') > Buffer.byteLength(truncationView, 'utf8'), `bytes: ${Buffer.byteLength(adoptedView, 'utf8')} vs ${Buffer.byteLength(truncationView, 'utf8')}`)

  const r = await decide(baseInput(store, { text, cfg, distill: fake.fn }))
  assert.equal(r?.code, 'distill-rejected:not-smaller')
  assert.equal(r?.content, null)
})

test('超时：挂起的 DistillFn → distill-rejected:timeout，不抛', async () => {
  const store = await makeStore()
  const fake = fakeFn(() => new Promise(() => {}))
  const started = Date.now()
  const r = await decide(baseInput(store, { cfg: onConfig({ timeoutMs: 120 }), distill: fake.fn }))
  assert.ok(Date.now() - started < 2000, 'the timeout must bound the wait')
  assert.equal(r?.code, 'distill-rejected:timeout')
  assert.equal(r?.content, null)
  assert.equal(r?.evidence?.reason, 'timeout')
})

test('DistillFn 抛错 → distill-failed，不抛', async () => {
  const store = await makeStore()
  const fake = fakeFn(async () => {
    throw new Error('provider exploded')
  })
  const r = await decide(baseInput(store, { distill: fake.fn }))
  assert.equal(r?.code, 'distill-failed')
  assert.equal(r?.content, null)
})

test('DistillFn 返回 undefined → distill-failed', async () => {
  const store = await makeStore()
  const fake = fakeFn(async () => undefined)
  const r = await decide(baseInput(store, { distill: fake.fn }))
  assert.equal(r?.code, 'distill-failed')
})

test('没有模型（未配置 route 也没有边界路由）→ distill-failed，不调用', async () => {
  const store = await makeStore()
  const fake = fakeFn(async (request) => goodAnswer(request.text))
  const r = await decide(baseInput(store, { route: undefined, distill: fake.fn }))
  assert.equal(r?.code, 'distill-failed')
  assert.equal(fake.calls.length, 0)
})

test('distill 为 undefined（宿主无 ctx.llm）→ distill-failed，不抛', async () => {
  const store = await makeStore()
  const r = await decide(baseInput(store, { distill: undefined }))
  assert.equal(r?.code, 'distill-failed')
})

test('超时后迟到的答案不再重复计费：答到后已落盘，再读只查表', async () => {
  const store = await makeStore()
  const { keyOf, questionKeyOf, receiptKeyOf, versionOf } = await import('../src/distill/pin.ts')
  const lateKey = keyOf(receiptKeyOf(receipt()), questionKeyOf(questionOf('bash')!), versionOf('deepseek-flash', questionOf('bash')!))
  let release: (() => void) | undefined
  const fake = fakeFn(
    (request) =>
      new Promise((resolve) => {
        // A call that outlives the timeout but does finish: the decision must
        // not wait for it, and the answer must still be pinned so the replay
        // never pays for the same question twice.
        release = () => resolve(goodAnswer(request.text))
      }),
  )
  const cfg = onConfig({ timeoutMs: 100 })
  const first = await decide(baseInput(store, { cfg, distill: fake.fn }))
  assert.equal(first?.code, 'distill-rejected:timeout')
  release?.()
  await new Promise((resolve) => setTimeout(resolve, 50))
  // The `llm/stream` branch persists a parked call's answer as it lands (that
  // seam is `attempt.test.ts`); this test stands in for it and then proves the
  // replay reads the product instead of calling again.
  const good = goodAnswer(receipt())
  await store.write('s1', lateKey, { text: good.text, quotes: good.quotes, model: good.model! })

  const again = await decide(baseInput(store, { cfg, distill: fake.fn }))
  assert.equal(fake.calls.length, 1, 'the replay found the pinned product: no second call')
  assert.equal(again?.evidence?.called, false)
  assert.equal(again?.evidence?.adopted, true)

})

test('产物被篡改（引用不再存在于原文）→ unverifiable，且不采用', async () => {
  const store = await makeStore()
  const fake = fakeFn(async (request) => goodAnswer(request.text))
  const input = baseInput(store, { distill: fake.fn })
  await decide(input)
  // Rewrite the pinned product so one quote is forged.
  const key = (await import('../src/distill/pin.ts')).keyOf(
    (await import('../src/distill/pin.ts')).receiptKeyOf(input.text),
    (await import('../src/distill/pin.ts')).questionKeyOf(questionOf('bash')!),
    (await import('../src/distill/pin.ts')).versionOf('deepseek-flash', questionOf('bash')!),
  )
  const path = store.pathOf(key)
  const { readFile } = await import('node:fs/promises')
  const body = JSON.parse(await readFile(path, 'utf8'))
  body.quotes = ['forged quote']
  await writeFile(path, JSON.stringify(body))
  const again = await decide(input)
  assert.equal(again?.code, 'distill-rejected:unverifiable')
  assert.equal(fake.calls.length, 1, 'a table hit is never recomputed, even when rejected')
  assert.equal(again?.evidence?.adopted, false)
})

test('页脚渲染失败 → distill-failed', async () => {
  const store = await makeStore()
  const fake = fakeFn(async (request) => goodAnswer(request.text))
  const r = await decide(
    baseInput(store, {
      distill: fake.fn,
      formatFooter: () => {
        throw new Error('footer')
      },
    }),
  )
  assert.equal(r?.code, 'distill-failed')
})

test('spill 写失败 → distill-failed（页脚 locator 不能指向不存在的原文）', async () => {
  const store = await makeStore()
  const fake = fakeFn(async (request) => goodAnswer(request.text))
  const r = await decide(
    baseInput(store, {
      distill: fake.fn,
      spill: {
        saveText: async () => {
          throw new Error('disk full')
        },
      },
    }),
  )
  assert.equal(r?.code, 'distill-failed')
})

test('spill 原文就是回执本身，suggestedName 用工具名', async () => {
  const store = await makeStore()
  const fake = fakeFn(async (request) => goodAnswer(request.text))
  const saved: Array<{ content: string; suggestedName: string }> = []
  const input = baseInput(store, {
    distill: fake.fn,
    spill: {
      saveText: async (request: { content: string; suggestedName: string }) => {
        saved.push(request)
        return { locator: '/spill/bash.txt', retrievalHint: 'h' }
      },
    },
  })
  await decide(input)
  assert.equal(saved.length, 1)
  assert.equal(saved[0]?.content, input.text)
  assert.equal(saved[0]?.suggestedName, 'bash.txt')
})

test('决定不会让投影变大：采用视图严格短于截断视图，更短于原文', async () => {
  const store = await makeStore()
  const input = baseInput(store)
  const r = await decide(input)
  assert.ok(r?.content)
  const truncation = await projectApply({
    text: input.text,
    isError: false,
    family: 'bash',
    cfg: { ...input.cfg, distillation: { ...input.cfg.distillation, enabled: false } },
    sessionId: 's1',
    toolName: 'bash',
    spill: SPILL,
    formatFooter: footer,
  })
  assert.equal(truncation.outcome.kind, 'applied')
  assert.ok(r.content.length < truncation.content.length, 'strictly smaller than the truncation view')
  assert.ok(r.content.length < input.text.length)
})

test('影子模式：已采纳的产物记 projection-shadow，数字与采用时相同', async () => {
  const store = await makeStore()
  const input = baseInput(store)
  const r = await decide(input)
  const estimate = (t: string) => Math.ceil(t.length / 4)
  const shadow = await projectShadow({
    text: input.text,
    isError: false,
    family: 'bash',
    cfg: { ...input.cfg, distillation: { ...input.cfg.distillation, enabled: false } },
    estimate,
  })
  assert.equal(shadow.kind, 'shadow')
  const adopted = estimate(input.text) - estimate(r!.content!)
  assert.equal(typeof adopted, 'number')
  assert.ok(adopted > 0, 'a distilled view is cheaper than the original')
})
