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

test('时钟按模型请求切回合，步数逐回合清零', () => {
  const c = new TurnClock()
  assert.equal(c.turn(), 0)
  c.takeStep(); c.takeStep()
  assert.equal(c.stepsThisTurn(), 2)
  c.onModelRequest()
  assert.equal(c.turn(), 1)
  assert.equal(c.stepsThisTurn(), 0)
})

test('协议段注册名与顺序固定', () => {
  assert.equal(PROTOCOL_NAME, 'dsh-boost')
  assert.equal(PROTOCOL_ORDER, 100)
})

test('协议段不引导 after:"root" 死路径', () => {
  assert.equal(/["']?after["']?\s*:\s*["']root["']/.test(PROTOCOL_TEXT), false)
  assert.equal(PROTOCOL_TEXT.includes('root'), false)
})

test('协议段写明单字母 id 与 26 步上限', () => {
  assert.match(PROTOCOL_TEXT, /one capital A-Z/)
  assert.match(PROTOCOL_TEXT, /26 steps/)
})

test('协议段写明标识符仅在行首、双引号、唯一出现时绑定', () => {
  assert.match(PROTOCOL_TEXT, /line-start/)
  assert.match(PROTOCOL_TEXT, /double-quoted/)
  assert.match(PROTOCOL_TEXT, /exactly one/)
})

test('协议段写明 64 层深度与原型污染键禁令', () => {
  for (const needle of ['depth <= 64', '__proto__', 'constructor', 'prototype']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
})

test('协议段列出全部 guard 形态并给出 text_contains 正反例', () => {
  for (const needle of ['{"ok":true}', 'text_contains', 'text_not_contains', 'json_equals']) {
    assert.ok(PROTOCOL_TEXT.includes(needle), `缺少 ${needle}`)
  }
  assert.match(PROTOCOL_TEXT, /verbatim/)
  assert.ok(PROTOCOL_TEXT.includes('"no errors"'))
  assert.ok(PROTOCOL_TEXT.includes('export function'))
})

test('协议段保持短小（常驻系统提示的成本）', () => {
  assert.ok(PROTOCOL_TEXT.length < 1200, `协议段 ${PROTOCOL_TEXT.length} 字符`)
})

test('协议段中的示例计划能被 parsePlan 接受', () => {
  const open = PROTOCOL_TEXT.indexOf('<CHISEL_PLAN>')
  const close = PROTOCOL_TEXT.indexOf('</CHISEL_PLAN>')
  assert.ok(open >= 0 && close > open)
  const block = PROTOCOL_TEXT.slice(open, close + '</CHISEL_PLAN>'.length)
  const parsed = parsePlan(block)
  assert.ok('plan' in parsed, `示例计划解析失败：${JSON.stringify(parsed)}`)
  assert.equal(parsed.plan.steps.length, 1)
})

test('时钟在第二次模型请求后继续进位', () => {
  const c = new TurnClock()
  assert.equal(c.stepsThisTurn(), 0)
  c.onModelRequest()
  c.takeStep()
  c.onModelRequest()
  assert.equal(c.turn(), 2)
  assert.equal(c.stepsThisTurn(), 0)
})
