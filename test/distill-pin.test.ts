/**
 * Ticket #10: the pinned identity of a distillation product.
 *
 * A product is addressed by `(receipt_hash, question_hash, version)`. The
 * receipt hash must be a pure function of the receipt's bytes — the same text
 * under a different call id, turn or session is the same evidence and must
 * reuse the same product — while the version must move whenever any input of
 * the prompt changes, because a product computed under one prompt is not a
 * product of another.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DISTILLER_VERSION,
  keyOf,
  questionOf,
  receiptKeyOf,
  versionOf,
} from '../src/distill/pin.ts'
import { truncate } from '../src/projection/truncate.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'

test('questionOf：每个可蒸馏族一个固定问题与短名，其余族没有', () => {
  for (const family of ['bash', 'ssh'] as const) {
    const question = questionOf(family)
    assert.ok(question, `${family} must be distillable`)
    assert.ok(question.text.length > 0)
    assert.ok(question.name.length > 0)
    // The short name is what the head marker shows; a space would make it
    // ambiguous with the rest of the `[distilled from N chars; Q]` line.
    assert.doesNotMatch(question.name, /\s/)
  }
  assert.equal(questionOf('read'), undefined)
  assert.equal(questionOf('grep'), undefined)
  assert.equal(questionOf('glob'), undefined)
  assert.deepEqual(questionOf('bash'), questionOf('bash'), 'the question is a constant per family')
})

test('questionOf 是常量：同一族两次调用返回同一个值（question_hash 稳定）', () => {
  assert.deepEqual(questionOf('ssh'), questionOf('ssh'))
})

test('receiptKeyOf：同一串字节得到同一个 hash，与调用 id / 会话无关', () => {
  const text = 'b'.repeat(5000)
  assert.equal(receiptKeyOf(text), receiptKeyOf(text))
  assert.equal(receiptKeyOf(text).length, 16)
  assert.notEqual(receiptKeyOf(text), receiptKeyOf(`${text}x`), 'different bytes are a different receipt')
})

test('versionOf：常量版本 + 模型 + 问题文本', () => {
  const question = questionOf('bash')!
  const v = versionOf('deepseek-flash', question)
  assert.equal(v, versionOf('deepseek-flash', question))
  assert.match(v, new RegExp(`^${DISTILLER_VERSION}-`), 'the constant version leads')
  assert.notEqual(v, versionOf('deepseek-v4-pro', question), 'a different model is a different version')
  assert.notEqual(v, versionOf('deepseek-flash', { ...question, text: `${question.text}?` }))
})

test('keyOf：三个分量共同决定文件名，且文件名不含路径分隔符', () => {
  const key = keyOf('0a1b2c3d4e5f6071', '1111222233334444', 'v1-deepseek-flash-abc')
  assert.equal(key.file, `0a1b2c3d4e5f6071-1111222233334444-${'v1-deepseek-flash-abc'}`)
  assert.doesNotMatch(key.file, /[/\\]/)
  assert.notEqual(key.file, keyOf('0a1b2c3d4e5f6071', '1111222233334444', 'v2-x').file)
})

test('version 升级只影响新回执：旧 keys 仍按自己的版本查找', () => {
  const question = questionOf('bash')!
  const oldKey = keyOf('aaaa', 'bbbb', versionOf('m1', question))
  const newKey = keyOf('aaaa', 'bbbb', versionOf('m2', question))
  assert.notEqual(oldKey.file, newKey.file)
})

test('纯净性：pin 模块不读时钟或随机源（可复现）', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/distill/pin.ts', import.meta.url), 'utf8')
  // Comments are stripped the same way the determinism test strips them: a
  // commented-out mention is documentation, not a call.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
  for (const token of ['Date.now', 'new Date', 'Math.random', 'randomUUID', 'randomBytes']) {
    assert.equal(code.includes(token), false, `pin.ts must not use ${token}`)
  }
})

test('truncate 视图是独立的：同一原文的截断长度只由原文与配置决定', () => {
  const text = 'x'.repeat(5000)
  const a = truncate(text, DEFAULT_CONFIG.projection.bash)!
  const b = truncate(text, DEFAULT_CONFIG.projection.bash)!
  assert.equal(a.after, b.after)
})
