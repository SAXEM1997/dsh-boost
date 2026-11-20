import test from 'node:test'
import assert from 'node:assert/strict'
import { projectApply } from '../src/projection/apply.ts'
import { renderHeadLine, truncate } from '../src/projection/truncate.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'

const spill = { saveText: async () => ({ locator: '/spill/read-1.txt', retrievalHint: 'Use read with offset/limit' }) }
const footer = (o: { kind: 'exact'; count: number }, ref: { locator: string; retrievalHint?: string }) =>
  `Omitted ${o.count} bytes. Full formatted result stored at: ${ref.locator}.`

test('on 模式：原文落盘、content 变短、页脚含 locator', async () => {
  const text = 'a'.repeat(18432)
  const r = await projectApply({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', spill, formatFooter: footer })
  assert.ok(r.content.length < text.length)
  assert.match(r.content, /Full formatted result stored at: \/spill\/read-1\.txt/)
  assert.equal(r.outcome.kind, 'applied')
})

test('缺 spill 后端：不投影，原样返回（§5.4 可见性三条 3）', async () => {
  const text = 'a'.repeat(18432)
  const r = await projectApply({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', spill: undefined, formatFooter: footer })
  assert.equal(r.content, text)
  assert.equal(r.outcome.reason, 'no-spill')
})

test('缺 sessionId：不投影', async () => {
  const text = 'a'.repeat(18432)
  const r = await projectApply({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, sessionId: undefined, toolName: 'read', spill, formatFooter: footer })
  assert.equal(r.content, text)
  assert.equal(r.outcome.reason, 'no-owner')
})

test('错误回执不裁剪（R24）', async () => {
  const text = 'x'.repeat(18432)
  const r = await projectApply({ text, isError: true, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', spill, formatFooter: footer })
  assert.equal(r.content, text)
  assert.equal(r.outcome.reason, 'error-receipt')
})

test('saveText 抛错时回退原文（R18）', async () => {
  const text = 'x'.repeat(18432)
  const bad = { saveText: async () => { throw new Error('disk full') } }
  const r = await projectApply({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', spill: bad, formatFooter: footer })
  assert.equal(r.content, text)
  assert.equal(r.outcome.reason, 'spill-failed')
})

test('formatFooter 抛错时不冒泡：回退原文，记 footer-failed', async () => {
  const text = 'a'.repeat(18432)
  let spills = 0
  const capture = { saveText: async () => { spills++; return { locator: '/spill/read-1.txt', retrievalHint: 'h' } } }
  const badFooter = () => { throw new Error('notice renderer exploded') }
  const r = await projectApply({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', spill: capture, formatFooter: badFooter })
  assert.equal(r.content, text)
  assert.deepEqual(r.outcome, { kind: 'skipped', reason: 'footer-failed' })
  assert.equal(spills, 1)
})

test('缺 formatFooter 不落盘（R16）', async () => {
  const text = 'a'.repeat(18432)
  let saved = 0
  const counting = { saveText: async () => { saved++; return { locator: '/x', retrievalHint: 'h' } } }
  const r = await projectApply({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', spill: counting, formatFooter: undefined })
  assert.equal(r.content, text)
  assert.equal(r.outcome.reason, 'projection-skipped:no-footer')
  assert.equal(saved, 0)
})

test('原文完整落盘、页脚字节账闭合（R28）', async () => {
  const text = 'a'.repeat(18432)
  let saved: any
  let footerCount = 0
  const capture = { saveText: async (i: any) => { saved = i; return { locator: '/spill/read-1.txt', retrievalHint: 'h' } } }
  const countingFooter = (o: { count: number }, ref: { locator: string }) => { footerCount = o.count; return `Omitted ${o.count} bytes. Full formatted result stored at: ${ref.locator}.` }
  const t = truncate(text, DEFAULT_CONFIG.projection.read)!
  await projectApply({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', callId: 'call-1', label: 'read /a', spill: capture, formatFooter: countingFooter })
  assert.equal(saved.content, text)
  assert.deepEqual(saved.source, { kind: 'tool', toolName: 'read', callId: 'call-1', label: 'read /a' })
  assert.equal(footerCount, t.omittedBytes)
  assert.equal(Buffer.byteLength(text, 'utf8'), t.omittedBytes + Buffer.byteLength(t.head, 'utf8') + Buffer.byteLength(t.tail, 'utf8'))
})

test('页脚收到 { kind: exact, count: omittedBytes }（formatSpillNotice 的形状）', async () => {
  const text = 'a'.repeat(18432)
  const t = truncate(text, DEFAULT_CONFIG.projection.read)!
  let seen: any
  const spyFooter = (o: any, ref: { locator: string }) => {
    seen = o
    return `Omitted ${o.count} bytes. Full formatted result stored at: ${ref.locator}.`
  }
  await projectApply({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', spill, formatFooter: spyFooter })
  assert.deepEqual(seen, { kind: 'exact', count: t.omittedBytes })
})

test('页脚夹在两个窗口之间：content === head 行 + head + 页脚 + tail', async () => {
  const text = 'a'.repeat(18432)
  const t = truncate(text, DEFAULT_CONFIG.projection.read)!
  const r = await projectApply({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', spill, formatFooter: footer })
  const expected = `${renderHeadLine(t)}\n${t.head}\n${footer({ kind: 'exact', count: t.omittedBytes }, { locator: '/spill/read-1.txt', retrievalHint: 'Use read with offset/limit' })}\n${t.tail}`
  assert.equal(r.content, expected)
  assert.ok(r.content.length < text.length)
})

test('applied 结果带省略字节与码点，token 计量留给调用方（T23b）', async () => {
  const text = 'a'.repeat(18432)
  const t = truncate(text, DEFAULT_CONFIG.projection.read)!
  const r = await projectApply({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', spill, formatFooter: footer })
  assert.deepEqual(r.outcome, {
    kind: 'applied',
    omittedBytes: t.omittedBytes,
    omittedCodePoints: t.omittedCodePoints,
    locator: '/spill/read-1.txt',
  })
})

test('低于触发阈值：不投影、不落盘，outcome 带 not-worth-it', async () => {
  const text = 'a'.repeat(2999)
  let saved = 0
  const counting = { saveText: async () => { saved++; return { locator: '/x', retrievalHint: 'h' } } }
  const r = await projectApply({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', spill: counting, formatFooter: footer })
  assert.equal(r.content, text)
  assert.deepEqual(r.outcome, { kind: 'skipped', reason: 'not-worth-it' })
  assert.equal(saved, 0)
})

test('未配置的工具族跳过（family-not-configured），不落盘', async () => {
  let saved = 0
  const counting = { saveText: async () => { saved++; return { locator: '/x', retrievalHint: 'h' } } }
  const r = await projectApply({
    text: 'a'.repeat(18432),
    isError: false,
    family: 'web_fetch' as never,
    cfg: DEFAULT_CONFIG,
    sessionId: 's1',
    toolName: 'web_fetch',
    spill: counting,
    formatFooter: footer,
  })
  assert.equal(r.content, 'a'.repeat(18432))
  assert.deepEqual(r.outcome, { kind: 'skipped', reason: 'family-not-configured' })
  assert.equal(saved, 0)
})

test('callId / label 缺省用 toolName / family，suggestedName 跟随宿主约定', async () => {
  const text = 'a'.repeat(18432)
  let saved: any
  const capture = { saveText: async (i: any) => { saved = i; return { locator: '/spill/read-1.txt', retrievalHint: 'h' } } }
  await projectApply({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', spill: capture, formatFooter: footer })
  assert.deepEqual(saved.owner, { sessionId: 's1' })
  assert.deepEqual(saved.source, { kind: 'tool', toolName: 'read', callId: 'read', label: 'read' })
  assert.equal(saved.suggestedName, 'read.txt')
})

test('页脚把回执撑得比原文更长时回退原文（规则 2）', async () => {
  // grep 的触发阈值是 700：701 字符刚过界，50 字符头行 + 两窗口 ≈ 552。
  // 232 字符的页脚会把组装结果推到 ~785，反而比原文更长。
  const text = 'a'.repeat(701)
  let spills = 0
  let spilledContent = ''
  const capture = { saveText: async (i: any) => { spills++; spilledContent = i.content; return { locator: '/spill/g.txt', retrievalHint: 'h' } } }
  const longFooter = (o: { count: number }, ref: { locator: string }) =>
    `Omitted ${o.count} bytes. ${'x'.repeat(200)} ${ref.locator}`
  const r = await projectApply({ text, isError: false, family: 'grep', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'grep', spill: capture, formatFooter: longFooter })
  assert.equal(r.content, text)
  assert.deepEqual(r.outcome, { kind: 'skipped', reason: 'not-worth-it' })
  // locator 只有落盘后才知道；后端没有删除接口，已写入的原件只能留在 store 里。
  // 断言它至少存的是原文，不是投影半成品。
  assert.equal(spills, 1)
  assert.equal(spilledContent, text)
})

test('恰好等长：assembled.length === text.length 时返回原文，不产出零节省的投影（apply 侧 >= 边界）', async () => {
  // 构造等长：trigger 100 / head 10 / tail 5，text 150 字符。组装 = 头行 + 1 + 10 +
  // 1 + 页脚 + 1 + 5；150 的头行是 47 字符，页脚取 85 字符时组装恰为 150。判据若是
  // > 而非 >=，这里会发出一条同长度的“投影”与一份节省为 0 的 applied 收据，页脚
  // 还指向一份没人需要的 spill 原件——等于白付一次落盘。
  const P = { triggerChars: 100, headChars: 10, tailChars: 5 }
  const text = 'a'.repeat(150)
  const t = truncate(text, P)!
  const footerLen = text.length - (renderHeadLine(t).length + 1 + P.headChars + 1 + 1 + P.tailChars)
  const exactFooter = () => 'F'.repeat(footerLen)
  // 等长自检：本用例确实站在 >= 与 > 的分岔点上。
  const assembled = `${renderHeadLine(t)}\n${t.head}\n${exactFooter()}\n${t.tail}`
  assert.equal(assembled.length, text.length)
  let spills = 0
  const capture = { saveText: async () => { spills++; return { locator: '/spill/eq.txt', retrievalHint: 'h' } } }
  const r = await projectApply({
    text, isError: false, family: 'read',
    cfg: { ...DEFAULT_CONFIG, projection: { ...DEFAULT_CONFIG.projection, read: P } },
    sessionId: 's1', toolName: 'read', spill: capture, formatFooter: exactFooter,
  })
  assert.equal(r.content, text) // 原文逐字节返回，不产出同长度 receipt
  assert.deepEqual(r.outcome, { kind: 'skipped', reason: 'not-worth-it' }) // 无零节省的 applied 收据
  // 注意：这一侧的 saveText 已经发生——页脚的 locator 只有落盘后才知道，组装长度只能
  // 事后复核（apply.ts: "the footer is only known after the write"）。若要求“等长不落盘”，
  // 那是代码改动（把长度预判挪到写盘前），不是测试改动；与上一条“更长”用例同一取舍。
  assert.equal(spills, 1)
})

test('等长在 truncate 一侧被拦下：after.length === text.length 时 precheck 即返回，spill 从未发生', async () => {
  // 另一条 >= 边界在 truncate 自己的净收益护栏上：trigger 100 / head 80 / tail 40，
  // text 170 时头行 [output 170 chars; showing first 80 and last 40] 是 48 字符，
  // after = 48 + 1 + 80 + 1 + 40 = 170，恰好等长，truncate 返回 null，projectApply
  // 在 precheck（落盘之前）就放弃。
  const P = { triggerChars: 100, headChars: 80, tailChars: 40 }
  const text = 'a'.repeat(170)
  // 构造自检：头行长度 + 两个换行 + 窗口 === 原文长度，等长确实成立。
  assert.equal(`[output 170 chars; showing first 80 and last 40]`.length + 1 + P.headChars + 1 + P.tailChars, text.length)
  assert.equal(truncate(text, P), null)
  let spills = 0
  const capture = { saveText: async () => { spills++; return { locator: '/spill/eq2.txt', retrievalHint: 'h' } } }
  const r = await projectApply({
    text, isError: false, family: 'read',
    cfg: { ...DEFAULT_CONFIG, projection: { ...DEFAULT_CONFIG.projection, read: P } },
    sessionId: 's1', toolName: 'read', spill: capture, formatFooter: footer,
  })
  assert.equal(r.content, text)
  assert.deepEqual(r.outcome, { kind: 'skipped', reason: 'not-worth-it' })
  assert.equal(spills, 0) // 这条边界在写盘之前就被拦下
})

test('入口顺序：error-receipt > no-spill > no-owner > no-footer', async () => {
  const text = 'a'.repeat(18432)
  const base = { text, isError: false, family: 'read' as const, cfg: DEFAULT_CONFIG, toolName: 'read' }

  const error = await projectApply({ ...base, isError: true, sessionId: undefined, spill: undefined, formatFooter: undefined })
  assert.equal(error.outcome.reason, 'error-receipt')

  const noSpill = await projectApply({ ...base, sessionId: undefined, spill: undefined, formatFooter: undefined })
  assert.equal(noSpill.outcome.reason, 'no-spill')

  const noOwner = await projectApply({ ...base, sessionId: undefined, spill, formatFooter: undefined })
  assert.equal(noOwner.outcome.reason, 'no-owner')

  const noFooter = await projectApply({ ...base, sessionId: 's1', spill, formatFooter: undefined })
  assert.equal(noFooter.outcome.reason, 'projection-skipped:no-footer')
})
