import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageLedger } from '../src/admission/usage.ts'

test('saved_input_tokens 取后一次请求的 input + cacheRead（不插值）', () => {
  const l = new UsageLedger()
  l.request({ input: 100, cacheRead: 900, output: 10 })   // 替换前那次
  l.markSubstituted('A')
  l.request({ input: 200, cacheRead: 1800, output: 400 })  // 后一次
  const r = l.settle()
  assert.equal(r.saved_input_tokens, 2000)
  assert.equal(r.output_tokens, 400)
})

test('后一次请求缺失记 unknown', () => {
  const l = new UsageLedger()
  l.request({ input: 100, cacheRead: 900, output: 10 })
  l.markSubstituted('A')
  const r = l.settle()
  assert.equal(r.saved_input_tokens, 'unknown')
  assert.equal(r.output_tokens, 'unknown')
})

test('cache_hit_delta = 前后命中率之差', () => {
  const l = new UsageLedger()
  l.request({ input: 1000, cacheRead: 0, output: 0 })    // 0%
  l.markSubstituted('A')
  l.request({ input: 100, cacheRead: 900, output: 0 })   // 90%
  assert.equal(l.settle().cache_hit_delta, 0.9)
})

test('无前一次请求时 delta 记 null', () => {
  const l = new UsageLedger()
  l.markSubstituted('A')
  l.request({ input: 100, cacheRead: 900, output: 0 })
  assert.equal(l.settle().cache_hit_delta, null)
})

test('output 单独记一类，不混进 input（R30）', () => {
  const l = new UsageLedger()
  l.request({ input: 100, cacheRead: 900, output: 7 })
  l.markSubstituted('A')
  l.request({ input: 200, cacheRead: 1800, output: 33 })
  const r = l.settle()
  assert.equal(r.saved_input_tokens, 2000)
  assert.equal(r.output_tokens, 33)   // 不是 200 + 33，也不是 33 个 input
})

/* ------------------------------------------------------------------------- *
 * 规则 1–6 的补充钉死（brief 五条是下限）
 * ------------------------------------------------------------------------- */

test('标记后的第一次请求才是配对目标，后续请求不得覆盖', () => {
  const l = new UsageLedger()
  l.request({ input: 1000, cacheRead: 0, output: 0 })        // 0%
  l.markSubstituted('A')
  l.request({ input: 100, cacheRead: 900, output: 400 })     // 90%——配对目标
  l.request({ input: 500, cacheRead: 9500, output: 999 })    // 更晚，不参与
  const r = l.settle()
  assert.equal(r.saved_input_tokens, 1000)                   // 第一个 after 的 100 + 900
  assert.equal(r.output_tokens, 400)
  assert.equal(r.cache_hit_delta, 0.9)
})

test('settle 消费标记：第二次 settle 返回 unknown/null/unknown，last 仍可读', () => {
  const l = new UsageLedger()
  l.request({ input: 1000, cacheRead: 0, output: 0 })
  l.markSubstituted('A')
  l.request({ input: 100, cacheRead: 900, output: 400 })
  assert.deepEqual(l.settle(), {
    saved_input_tokens: 1000,
    avoided_total_tokens: 1000,
    cache_hit_delta: 0.9,
    output_tokens: 400,
  })
  assert.deepEqual(l.settle(), {
    saved_input_tokens: 'unknown',
    avoided_total_tokens: 'unknown',
    cache_hit_delta: null,
    output_tokens: 'unknown',
  })
  assert.deepEqual(l.last(), { input: 100, cacheRead: 900, output: 400 })
})

test('从未 mark 的 settle：unknown/null/unknown，且不消耗 last', () => {
  const l = new UsageLedger()
  assert.deepEqual(l.settle(), {
    saved_input_tokens: 'unknown',
    avoided_total_tokens: 'unknown',
    cache_hit_delta: null,
    output_tokens: 'unknown',
  })
  l.request({ input: 100, cacheRead: 900, output: 10 })
  assert.deepEqual(l.settle(), {
    saved_input_tokens: 'unknown',
    avoided_total_tokens: 'unknown',
    cache_hit_delta: null,
    output_tokens: 'unknown',
  })
  assert.deepEqual(l.last(), { input: 100, cacheRead: 900, output: 10 })
})

test('标记前没有任何请求：delta 为 null，但节省仍按后一次请求测量', () => {
  const l = new UsageLedger()
  l.markSubstituted('A')
  l.request({ input: 250, cacheRead: 750, output: 5 })
  const r = l.settle()
  assert.equal(r.saved_input_tokens, 1000)
  assert.equal(r.output_tokens, 5)
  assert.equal(r.cache_hit_delta, null)
})

test('任一侧命中率分母为 0：delta 记 null，数字侧照常测量', () => {
  const beforeZero = new UsageLedger()
  beforeZero.request({ input: 0, cacheRead: 0, output: 0 })
  beforeZero.markSubstituted('A')
  beforeZero.request({ input: 100, cacheRead: 900, output: 3 })
  const b = beforeZero.settle()
  assert.equal(b.cache_hit_delta, null)
  assert.equal(b.saved_input_tokens, 1000)

  const afterZero = new UsageLedger()
  afterZero.request({ input: 100, cacheRead: 900, output: 0 })
  afterZero.markSubstituted('A')
  afterZero.request({ input: 0, cacheRead: 0, output: 0 })
  const a = afterZero.settle()
  assert.equal(a.cache_hit_delta, null)
  assert.equal(a.saved_input_tokens, 0)   // 0 是测到的数，不是 unknown
  assert.equal(a.output_tokens, 0)
})

test('后一次样本含 NaN/Infinity/负数：整条不可用，绝不产生 NaN 或 Infinity', () => {
  const badAfter = [
    { input: NaN, cacheRead: 900, output: 10 },
    { input: -1, cacheRead: 900, output: 10 },
    { input: 100, cacheRead: -1, output: 10 },
    { input: 100, cacheRead: 900, output: NaN },
    { input: 100, cacheRead: 900, output: -5 },
    { input: Infinity, cacheRead: 900, output: 10 },
  ]
  for (const bad of badAfter) {
    const l = new UsageLedger()
    l.request({ input: 1000, cacheRead: 0, output: 0 })
    l.markSubstituted('A')
    l.request(bad)
    assert.deepEqual(
      l.settle(),
      {
        saved_input_tokens: 'unknown',
        avoided_total_tokens: 1000,
        cache_hit_delta: null,
        output_tokens: 'unknown',
      },
      `bad after-mark sample ${JSON.stringify(bad)}`,
    )
  }
})

test('前一次样本含 NaN/Infinity/负数：只毁掉 delta，后一次节省仍测量', () => {
  const badBefore = [
    { input: NaN, cacheRead: 900, output: 10 },
    { input: -1, cacheRead: 900, output: 10 },
    { input: 100, cacheRead: -1, output: 10 },
    { input: 100, cacheRead: 900, output: NaN },
    { input: 100, cacheRead: Infinity, output: 10 },
  ]
  for (const bad of badBefore) {
    const l = new UsageLedger()
    l.request(bad)
    l.markSubstituted('A')
    l.request({ input: 200, cacheRead: 1800, output: 7 })
    const r = l.settle()
    assert.equal(r.saved_input_tokens, 2000, `bad pre-mark sample ${JSON.stringify(bad)}`)
    assert.equal(r.output_tokens, 7)
    assert.equal(r.cache_hit_delta, null)
  }
})

test('last() 是只读：任何请求前 undefined，settle 后仍返回最近一次', () => {
  const l = new UsageLedger()
  assert.equal(l.last(), undefined)
  l.request({ input: 1, cacheRead: 2, output: 3 })
  assert.deepEqual(l.last(), { input: 1, cacheRead: 2, output: 3 })
  l.markSubstituted('A')
  l.request({ input: 4, cacheRead: 5, output: 6 })
  assert.deepEqual(l.last(), { input: 4, cacheRead: 5, output: 6 })
  l.settle()
  assert.deepEqual(l.last(), { input: 4, cacheRead: 5, output: 6 })
})

test('saved_input_tokens 不是 input + output，也不是单次 input（第三类计数不合并）', () => {
  const l = new UsageLedger()
  l.request({ input: 100, cacheRead: 900, output: 7 })
  l.markSubstituted('A')
  l.request({ input: 200, cacheRead: 1800, output: 33 })
  const r = l.settle()
  assert.equal(r.saved_input_tokens, 2000)
  assert.notEqual(r.saved_input_tokens, 200 + 33)
  assert.notEqual(r.saved_input_tokens, 200)
  assert.notEqual(r.saved_input_tokens, 2000 + 33)
})

test('markSubstituted 的 candidateId 可读，settle 后清空，且不参与算术', () => {
  const l = new UsageLedger()
  assert.equal(l.pendingCandidateId(), undefined)
  l.request({ input: 10, cacheRead: 90, output: 1 })
  l.markSubstituted('A')
  assert.equal(l.pendingCandidateId(), 'A')
  l.request({ input: 20, cacheRead: 180, output: 2 })
  assert.equal(l.pendingCandidateId(), 'A')
  assert.equal(l.settle().saved_input_tokens, 200)
  assert.equal(l.pendingCandidateId(), undefined)
})

test('重复 mark：配对目标重置为最新一次标记后的第一次请求', () => {
  const l = new UsageLedger()
  l.request({ input: 1000, cacheRead: 0, output: 0 })        // 0%
  l.markSubstituted('A')
  l.request({ input: 500, cacheRead: 500, output: 1 })       // A 的 after（未结算）
  l.markSubstituted('B')                                      // 新的 before = {500, 500} = 50%
  l.request({ input: 250, cacheRead: 750, output: 2 })       // B 的 after = 75%
  const r = l.settle()
  assert.equal(r.saved_input_tokens, 1000)                   // 250 + 750
  assert.equal(r.output_tokens, 2)
  assert.equal(r.cache_hit_delta, 0.25)
})

test('字段有限但 input + cacheRead 溢出为 Infinity：仍按不可用样本处理', () => {
  const l = new UsageLedger()
  l.request({ input: 1000, cacheRead: 0, output: 0 })
  l.markSubstituted('A')
  l.request({ input: Number.MAX_VALUE, cacheRead: Number.MAX_VALUE, output: 1 })
  assert.deepEqual(
    l.settle(),
    {
      saved_input_tokens: 'unknown',
      avoided_total_tokens: 1000,
      cache_hit_delta: null,
      output_tokens: 'unknown',
    },
  )
})

/* ------------------------------------------------------------------------- *
 * Row 7: the lower estimate, `avoided_total_tokens`
 * ------------------------------------------------------------------------- */

test('avoided_total_tokens = 计划请求的 input + cacheRead + output，且不高于 saved', () => {
  const l = new UsageLedger()
  l.request({ input: 100, cacheRead: 900, output: 10 })      // 产出计划的那次请求
  l.markSubstituted('A')
  l.request({ input: 200, cacheRead: 1800, output: 400 })    // 下一条真实请求
  const r = l.settle()
  assert.equal(r.avoided_total_tokens, 1010, '100 + 900 + 10: 含 output，所以叫 total')
  assert.equal(r.saved_input_tokens, 2000)
  assert.ok(
    typeof r.avoided_total_tokens === 'number' && r.avoided_total_tokens <= r.saved_input_tokens,
    'the lower estimate must not exceed the upper one',
  )
})

test('没有计划请求样本：avoided 侧 unknown，upper 侧照常测量（绝不拷贝）', () => {
  const l = new UsageLedger()
  l.markSubstituted('A')
  l.request({ input: 200, cacheRead: 1800, output: 400 })
  const r = l.settle()
  assert.equal(r.avoided_total_tokens, 'unknown')
  assert.equal(r.saved_input_tokens, 2000)
})

test('计划请求样本不可用：avoided 侧 unknown，不是 0 也不是后一次的数字', () => {
  for (const bad of [
    { input: NaN, cacheRead: 900, output: 10 },
    { input: 100, cacheRead: 900, output: -1 },
    { input: Number.MAX_VALUE, cacheRead: Number.MAX_VALUE, output: 1 },
  ]) {
    const l = new UsageLedger()
    l.request(bad)
    l.markSubstituted('A')
    l.request({ input: 200, cacheRead: 1800, output: 400 })
    const r = l.settle()
    assert.equal(r.avoided_total_tokens, 'unknown', `bad pre-mark sample ${JSON.stringify(bad)}`)
    assert.equal(r.saved_input_tokens, 2000)
  }
})

test('没有后一次请求：upper 侧 unknown，但 avoided 侧仍报 lower estimate', () => {
  const l = new UsageLedger()
  l.request({ input: 100, cacheRead: 900, output: 10 })
  l.markSubstituted('A')
  const r = l.settle()
  assert.equal(r.saved_input_tokens, 'unknown')
  assert.equal(r.avoided_total_tokens, 1010)
  assert.equal(r.output_tokens, 'unknown')
})
