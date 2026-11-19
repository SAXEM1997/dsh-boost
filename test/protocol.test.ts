import test from 'node:test'
import assert from 'node:assert/strict'
import { PROTOCOL_TEXT } from '../src/prompt/protocol.ts'
import { PROTOCOL_NAME, PROTOCOL_ORDER } from '../src/prompt/protocol.ts'
import { parsePlan } from '../src/gate/plan.ts'
import { TurnClock } from '../src/hooks/clock.ts'

test('协议段含计划标签、绑定语法与 guard 词表', () => {
  for (const needle of ['<CHISEL_PLAN>', '</CHISEL_PLAN>', '$public', 'text_contains', 'text_not_contains', 'json_equals', 'read', 'grep', 'glob']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段不含模板占位符（interpolate:false 的前提）', () => {
  assert.equal(PROTOCOL_TEXT.includes('{{'), false)
})

test('时钟按 host turn 切回合，同回合的请求不重置步数', () => {
  const c = new TurnClock()
  assert.equal(c.turn(), 0)
  assert.equal(c.stepsThisTurn(), 0)
  c.takeStep(); c.takeStep()
  assert.equal(c.stepsThisTurn(), 2)
  c.onModelRequest(1)
  assert.equal(c.turn(), 1)
  assert.equal(c.stepsThisTurn(), 0)
  c.takeStep()
  // DSH 的一个 turn 含多次 model request：同一 host turn 的第二个请求不得清零。
  c.onModelRequest(1)
  assert.equal(c.turn(), 1)
  assert.equal(c.stepsThisTurn(), 1)
  c.onModelRequest(2)
  assert.equal(c.turn(), 2)
  assert.equal(c.stepsThisTurn(), 0)
})

test('协议段注册名与顺序固定', () => {
  assert.equal(PROTOCOL_NAME, 'dsh-boost')
  assert.equal(PROTOCOL_ORDER, 100)
})

test('协议段教 root 与 $scalar，不再教没有生产者的 $single', () => {
  assert.ok(PROTOCOL_TEXT.includes('"after":"root"'))
  assert.ok(PROTOCOL_TEXT.includes('$scalar'))
  assert.ok(PROTOCOL_TEXT.includes('glob'))
  assert.equal(PROTOCOL_TEXT.includes('$single'), false)
})

test('协议段写明守卫读刚到的回执，多步是择一而非排队', () => {
  for (const needle of ['incoming receipt', "not a step's result", 'alternatives', 'one chosen', 'no receipt, no substitution', 'failure skips the step']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段写明可见正文与首个块语义', () => {
  for (const needle of ['visible text, not reasoning', 'first only, even if malformed']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段写明 id 规则与 26 步上限', () => {
  assert.match(PROTOCOL_TEXT, /one capital A-Z/)
  assert.match(PROTOCOL_TEXT, /max 26/)
})

test('协议段写明标识符仅在行首、双引号、唯一出现时绑定', () => {
  for (const needle of ['one line-start X', 'double-quoted, non-empty']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段写明 64 层深度与原型污染键禁令', () => {
  for (const needle of ['depth<=64', '__proto__', 'constructor', 'prototype']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段列出全部 guard 形态并给出 text_contains 正反例', () => {
  for (const needle of ['{"ok":true}', 'text_contains', 'text_not_contains', 'json_equals']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
  assert.match(PROTOCOL_TEXT, /verbatim/)
  assert.ok(PROTOCOL_TEXT.includes('"TODO"'))
  assert.ok(PROTOCOL_TEXT.includes('"no errors"'))
  assert.ok(PROTOCOL_TEXT.includes('whole receipt is JSON'))
})

test('协议段写明 $public 的可绑定来源、步骤 id 与失败后果', () => {
  for (const needle of ['"after":"root"', 'or an earlier step id', 'whole receipt is one token', 'a glob path', 'bash/ssh receipts only', 'not numbered read/grep', 'Else skip step.']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段保持短小（常驻系统提示的成本）', () => {
  assert.ok(PROTOCOL_TEXT.length <= 1250, `协议段 ${PROTOCOL_TEXT.length} 字符`)
})

test('协议段中的示例计划能被 parsePlan 接受，且 read 参数是 file_path', () => {
  const open = PROTOCOL_TEXT.indexOf('<CHISEL_PLAN>')
  const close = PROTOCOL_TEXT.indexOf('</CHISEL_PLAN>')
  assert.ok(open >= 0 && close > open)
  const block = PROTOCOL_TEXT.slice(open, close + '</CHISEL_PLAN>'.length)
  const parsed = parsePlan(block)
  assert.ok('plan' in parsed, `示例计划解析失败：${JSON.stringify(parsed)}`)
  assert.equal(parsed.plan.steps.length, 1)
  assert.deepEqual(parsed.plan.steps[0].args, { file_path: '/a' })
  assert.equal('path' in parsed.plan.steps[0].args, false)
})

test('时钟在第二次模型请求后继续进位', () => {
  const c = new TurnClock()
  c.onModelRequest(1)
  c.takeStep()
  c.onModelRequest(2)
  assert.equal(c.turn(), 2)
  assert.equal(c.stepsThisTurn(), 0)
})
