import test from 'node:test'
import assert from 'node:assert/strict'
import { remainingSteps, worthSubstituting, StepBudget } from '../src/admission/ledger.ts'

test('不足 5 个 turn 直接用 horizon；满 5 个才取均值（R11）', () => {
  assert.equal(remainingSteps({ stepsSoFar: [50, 60, 70, 80, 90], horizonSteps: 20, historyTurns: 5 }), 20)
  assert.equal(remainingSteps({ stepsSoFar: [2, 3], horizonSteps: 20, historyTurns: 5 }), 20)
  assert.equal(remainingSteps({ stepsSoFar: [], horizonSteps: 20, historyTurns: 5 }), 20)
  assert.equal(remainingSteps({ stepsSoFar: [10, 10, 10, 10, 10], horizonSteps: 20, historyTurns: 5 }), 10)
  assert.equal(remainingSteps({ stepsSoFar: [10, 10, 10, 10, 10, 10], horizonSteps: 20, historyTurns: 5 }), 10)
})

test('确定性单候选豁免阈值', () => {
  assert.equal(worthSubstituting({ savedTokens: 100, overheadTokens: 0, thresholdTokens: 1024, deterministicSingle: true }), true)
  assert.equal(worthSubstituting({ savedTokens: 100, overheadTokens: 0, thresholdTokens: 1024, deterministicSingle: false }), false)
  assert.equal(worthSubstituting({ savedTokens: 2000, overheadTokens: 100, thresholdTokens: 1024, deterministicSingle: false }), true)
})

test('每 turn 8 步上限（Review Focus #5）', () => {
  const b = new StepBudget(8)
  for (let i = 0; i < 8; i++) assert.equal(b.take(), true)
  assert.equal(b.take(), false)
  assert.equal(b.exhausted(), true)
  assert.equal(b.count(), 8)
})

/* ------------------------------------------------------------------------- *
 * 规则 1–4 的补充钉死（brief 三条是下限）
 * ------------------------------------------------------------------------- */

test('确定性单候选即使净节省为负也豁免（没有选择器开销）', () => {
  assert.equal(worthSubstituting({ savedTokens: 0, overheadTokens: 5000, thresholdTokens: 1024, deterministicSingle: true }), true)
})

test('恰好 historyTurns 个条目进入均值分支（两个不同的 N）', () => {
  assert.equal(remainingSteps({ stepsSoFar: [6, 6, 6, 6, 6], horizonSteps: 20, historyTurns: 5 }), 6)
  assert.equal(remainingSteps({ stepsSoFar: [8, 8, 8, 8], horizonSteps: 20, historyTurns: 4 }), 8)
})

test('超过 historyTurns 时只看最近 N 个；更早的条目不得改变均值', () => {
  // 全部 6 个的均值是 25（会被 clamp 到 20）；最近 5 个的均值是 10。
  assert.equal(remainingSteps({ stepsSoFar: [100, 10, 10, 10, 10, 10], horizonSteps: 20, historyTurns: 5 }), 10)
  // 最近 5 个是 [10,10,10,10,2]，均值 8.4 → 8。
  assert.equal(remainingSteps({ stepsSoFar: [10, 10, 10, 10, 10, 2], horizonSteps: 20, historyTurns: 5 }), 8)
})

test('均值四舍五入：2.5 向上、2.2 向下', () => {
  assert.equal(remainingSteps({ stepsSoFar: [2, 3], horizonSteps: 20, historyTurns: 2 }), 3) // 2.5 → 3
  assert.equal(remainingSteps({ stepsSoFar: [2, 2, 2, 2, 3], horizonSteps: 20, historyTurns: 5 }), 2) // 2.2 → 2
})

test('均值高于 horizon 时被 clamp；低于时保留均值', () => {
  assert.equal(remainingSteps({ stepsSoFar: [50, 50, 50, 50, 50], horizonSteps: 20, historyTurns: 5 }), 20)
  assert.equal(remainingSteps({ stepsSoFar: [5, 5, 5, 5, 5], horizonSteps: 20, historyTurns: 5 }), 5)
})

test('historyTurns <= 0：没有可平均的窗口，回落到 horizon 而不是 NaN', () => {
  assert.equal(remainingSteps({ stepsSoFar: [99], horizonSteps: 20, historyTurns: 0 }), 20)
  assert.equal(remainingSteps({ stepsSoFar: [99], horizonSteps: 20, historyTurns: -1 }), 20)
  assert.equal(remainingSteps({ stepsSoFar: [], horizonSteps: 20, historyTurns: 0 }), 20)
  assert.equal(Number.isNaN(remainingSteps({ stepsSoFar: [], horizonSteps: 20, historyTurns: 0 })), false)
})

test('horizonSteps 为 0 时剩余 0 步', () => {
  assert.equal(remainingSteps({ stepsSoFar: [], horizonSteps: 0, historyTurns: 5 }), 0)
  assert.equal(remainingSteps({ stepsSoFar: [10, 10, 10, 10, 10], horizonSteps: 0, historyTurns: 5 }), 0)
})

test('节省必须严格大于阈值；saved === overhead 不值得替换', () => {
  assert.equal(worthSubstituting({ savedTokens: 500, overheadTokens: 500, thresholdTokens: 0, deterministicSingle: false }), false)
  assert.equal(worthSubstituting({ savedTokens: 1124, overheadTokens: 100, thresholdTokens: 1024, deterministicSingle: false }), false)
  assert.equal(worthSubstituting({ savedTokens: 1125, overheadTokens: 100, thresholdTokens: 1024, deterministicSingle: false }), true)
})

test('StepBudget(0)：从未 take 就已 exhausted，take 永远 false', () => {
  const b = new StepBudget(0)
  assert.equal(b.exhausted(), true)
  assert.equal(b.take(), false)
  assert.equal(b.count(), 0)
})

test('StepBudget 负数与 0 同义：take 永远 false', () => {
  const b = new StepBudget(-3)
  assert.equal(b.exhausted(), true)
  assert.equal(b.take(), false)
  assert.equal(b.count(), 0)
})

test('reset() 把计数归零并重新放行（生命周期单例的救命阀）', () => {
  const b = new StepBudget(3)
  assert.equal(b.take(), true)
  assert.equal(b.take(), true)
  assert.equal(b.count(), 2)
  assert.equal(b.exhausted(), false)

  b.reset()
  assert.equal(b.count(), 0)
  assert.equal(b.exhausted(), false)

  assert.equal(b.take(), true)
  assert.equal(b.count(), 1)
  assert.equal(b.take(), true)
  assert.equal(b.take(), true)
  assert.equal(b.take(), false)
  assert.equal(b.count(), 3)
  assert.equal(b.exhausted(), true)
})

test('take() 在预算用尽后不再增加 count()', () => {
  const b = new StepBudget(3)
  for (let i = 0; i < 5; i++) b.take()
  assert.equal(b.count(), 3)
  assert.equal(b.exhausted(), true)
})

test('小数 max 向下取整，count() 永不越界', () => {
  const b = new StepBudget(2.5)
  assert.equal(b.take(), true)
  assert.equal(b.take(), true)
  assert.equal(b.take(), false)
  assert.equal(b.count(), 2)
})
