import test from 'node:test'
import assert from 'node:assert/strict'
import { PROTOCOL_TEXT } from '../src/prompt/protocol.ts'
import { PROTOCOL_NAME, PROTOCOL_ORDER } from '../src/prompt/protocol.ts'
import { parsePlan } from '../src/gate/plan.ts'
import { TurnClock } from '../src/hooks/clock.ts'

const PLAN_OPEN = '<CHISEL_PLAN>'
const PLAN_CLOSE = '</CHISEL_PLAN>'

/** The example block is the last opener: the protocol prose mentions the tag too. */
function exampleBlock(): string {
  const open = PROTOCOL_TEXT.lastIndexOf(PLAN_OPEN)
  const close = PROTOCOL_TEXT.indexOf(PLAN_CLOSE, open)
  return PROTOCOL_TEXT.slice(open, close + PLAN_CLOSE.length)
}

test('协议段含计划标签、绑定语法与 guard 词表', () => {
  for (const needle of [PLAN_OPEN, PLAN_CLOSE, '$public', 'text_contains', 'text_not_contains', 'json_equals', 'read', 'grep', 'glob']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段不含模板占位符（interpolate:false 的前提）', () => {
  assert.equal(PROTOCOL_TEXT.includes('{{'), false)
})

test('时钟按 host turn 切回合，新回合复位 host step', () => {
  const c = new TurnClock()
  assert.equal(c.turn(), 0)
  assert.equal(c.step(), 0)
  c.onModelRequest(1, 2)
  assert.equal(c.turn(), 1)
  assert.equal(c.step(), 2)
  // DSH 的一个 turn 含多次 model request：同一 host turn 的第二个请求不得清零。
  c.onModelRequest(1, 3)
  assert.equal(c.turn(), 1)
  assert.equal(c.step(), 3)
  c.onModelRequest(2, 0)
  assert.equal(c.turn(), 2)
  assert.equal(c.step(), 0)
})

test('时钟忽略 NaN 与倒退的 host turn', () => {
  const c = new TurnClock()
  c.onModelRequest(2, 4)
  // A non-finite turn is ignored; the host step is still copied forward because
  // it is the host's number, not a plugin count.
  c.onModelRequest(NaN, 5)
  assert.equal(c.turn(), 2)
  assert.equal(c.step(), 5)
  c.onModelRequest(1, 1)
  assert.equal(c.turn(), 2, 'a backwards turn must not move the clock back')
  assert.equal(c.step(), 5, 'nor may its step index move back')

  const fresh = new TurnClock()
  fresh.onModelRequest(NaN)
  assert.equal(fresh.turn(), 0)
  assert.equal(fresh.step(), 0)
})

test('协议段注册名与顺序固定', () => {
  assert.equal(PROTOCOL_NAME, 'dsh-boost')
  assert.equal(PROTOCOL_ORDER, 100)
})

test('协议段教 root 与 $scalar，不再教没有生产者的 $single', () => {
  assert.ok(PROTOCOL_TEXT.includes('"after":"root"'))
  assert.ok(PROTOCOL_TEXT.includes('$scalar'))
  assert.equal(PROTOCOL_TEXT.includes('$single'), false)
})

test('协议段写明守卫读刚到的回执，多步是择一而非排队', () => {
  for (const needle of ['guards test the receipt that just arrived', "not that call's own result", 'No receipt, no substitution', 'one is chosen', 'any failure runs the call normally']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段写明可见正文与首个块语义', () => {
  for (const needle of ['visible text, not reasoning', 'only the first counts']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段写明 id 规则与 26 步上限', () => {
  assert.match(PROTOCOL_TEXT, /one capital A-Z/)
  assert.match(PROTOCOL_TEXT, /max 26 steps/)
})

test('协议段恢复根模板与原型键两条坏形状', () => {
  for (const needle of ['not $public itself', 'depth<=64', 'no prototype keys', 'no $-key except $public']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段写明 guard 数量与单形态键规则', () => {
  for (const needle of ['>=1 other than {"ok":true}', 'each guard object has exactly one form key']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段列出全部 guard 形态与正负语义', () => {
  for (const needle of ['{"ok":true}', 'expected present', 'expected absent', 'case-sensitive', 's non-empty', 'never guessed', 'whole receipt must be JSON']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
  assert.equal(PROTOCOL_TEXT.includes('verbatim'), false)
})

test('协议段写明 $public 的来源、两种 field 与多行限制', () => {
  for (const needle of ['"after":"root"', 'a step that already ran', 'the whole receipt is one token', 'one-path glob', 'exactly one line-start X', 'double-quoted, non-empty', 'not read or grep', 'A multi-line value cannot be projected', 'type it literally', 'Else that step is skipped.']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段写明替换白名单', () => {
  for (const needle of ['read, grep, glob', 'others run normally']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段保持短小（常驻系统提示的成本）', () => {
  assert.ok(PROTOCOL_TEXT.length <= 1500, `协议段 ${PROTOCOL_TEXT.length} 字符`)
})

test('协议段示例可解析、用 file_path，并由下一句复述 guard 操作数', () => {
  const block = exampleBlock()
  const parsed = parsePlan(block)
  assert.ok('plan' in parsed, `示例计划解析失败：${JSON.stringify(parsed)}`)
  assert.equal(parsed.plan.steps.length, 1)
  const step = parsed.plan.steps[0]
  assert.ok(step !== undefined)
  assert.deepEqual(step.args, { file_path: '/repo/b.ts' })
  assert.equal('path' in step.args, false)

  const operand = (step.guards[0] as { text_contains: string }).text_contains
  assert.equal(operand, '2 matches')
  const close = PROTOCOL_TEXT.indexOf(PLAN_CLOSE, PROTOCOL_TEXT.lastIndexOf(PLAN_OPEN))
  const after = PROTOCOL_TEXT.slice(close + PLAN_CLOSE.length)
  assert.ok(after.includes(`says "${operand}"`), `示例后的说明未复述操作数 ${operand}`)
})
