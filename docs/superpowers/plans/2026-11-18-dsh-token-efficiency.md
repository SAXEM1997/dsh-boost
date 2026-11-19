# dsh-boost 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DSH 插件在工具回执进入上下文前做追加式投影、对只读三件套做确定性替换，按 raw token 记账。

**Architecture:** 一个 cordis 插件，挂 `tools/post-execute`（投影）、`tools/execute`（防篡改）、`llm/stream`（合成替换回合）与 `ctx.systemPrompt.section`（协议段）。纯函数层（截断、守卫、绑定、计划解析、准入）与宿主适配层（钩子、spill、scope 解析）分离，前者用 `node --test` 表驱动，后者用假宿主集成测试。

**Tech Stack:** TypeScript 5.6 / ESM / Node ≥ 22.18 / `node --test` + `tsx` / cordis 插件 API（`@deepseek-ai/dsh-tools`、`dsh-llm`、`dsh-system-prompt`）。

**Spec:** `docs/superpowers/specs/2026-11-18-dsh-token-efficiency-design.md`（下称"设计稿"，行号引用以该文件为准）
**Clarifications:** `docs/superpowers/clarifications/2026-11-18-dsh-token-efficiency.md`

## Global Constraints

- TypeScript 严格模式；`"type": "module"`；Node `>=22.18.0`。
- 不引运行时依赖（`dependencies` 为空）。宿主包走 `peerDependencies`，`dsh-spill-policy` / `dsh-token-meter` 标 `optional`（设计稿 §11）。
- 所有宿主管线之外的模块必须是**纯函数**，输入输出只含字符串/对象，便于表驱动测试。
- 一切失败**回退主模型**，不猜（§5.2-3）。
- v1 替换白名单只有 `read` / `grep` / `glob`；投影覆盖 `read` / `grep` / `glob` / `bash` / `ssh`（§5.2-5）。
- 计量单位：投影长度按 **Unicode code point**，spill 页脚按 **UTF-8 字节**，两者不许混写（§5.4-7）。
- 默认值一律以 §5.3 的表为准，测试里逐字断言这些数字。
- 提交信息用 `feat:` / `test:` / `chore:` 前缀；每个 task 一次提交。

## Review Focus

1. **空回执**（`text === ''`）——投影必须原样放行，不得产出"showing first 0 and last 0"这种空窗口页脚。（T4）
2. **纯 CJK / emoji 回执**——截断不得切开代理对，页脚字节数不等于字符数。（T4）
3. **模板指向不存在的图节点**（`after: "C"` 但图上只有 A、B）——判不可解析并回退，不得静默取 `root`。（T13）
4. **`scope.json` 被外部改成 version 1 或写坏**——只读降级到 `selected+[]`，不得覆盖原文件、不得抛错中断插件。（T8）
5. **同一 turn 第 9 次替换**——必须命中 `steps-exhausted` 回主模型，而不是继续替换。（T19）

---

### Task 1: 插件骨架与加载

**Files:**
- Create: `package.json`, `tsconfig.json`, `cordis.patch.yml`, `LICENSE`（Apache-2.0 全文）, `NOTICE`（注明移植自 HarnessMM）, `README.en.md`, `src/index.ts`, `src/types.ts`, `test/plugin-load.test.ts`, `.gitignore`

**Interfaces:**
- Produces: `export const name = 'dsh-boost'`；`export const inject = ['tools', 'llm', 'systemPrompt'] as const`；`export function apply(ctx: PluginContext): void`
- Produces: `src/types.ts` 的 `export type ToolFamily = 'read' | 'grep' | 'glob' | 'bash' | 'ssh'`、`export interface BoostConfig { projection: Record<ToolFamily, ProjectionParams>; admission: { thresholdTokens: number }; selector: { maxTokens: number }; stepsPerTurn: number; horizonSteps: number; historyTurns: number }`、`export interface ProjectionParams { triggerChars: number; headChars: number; tailChars: number }`

- [ ] **Step 1: 写失败的加载测试**

```ts
// test/plugin-load.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../src/index.ts'

test('插件导出 cordis 需要的元数据', () => {
  assert.equal(plugin.name, 'dsh-boost')
  assert.deepEqual([...plugin.inject], ['tools', 'llm', 'systemPrompt'])
  assert.equal(typeof plugin.apply, 'function')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/plugin-load.test.ts`
Expected: FAIL，`Cannot find module '../src/index.ts'`

- [ ] **Step 3: 建骨架**

`package.json` 逐字采用设计稿 §11 的块（含 `version: 0.1.0`、`exports`、`peerDependencies` + `peerDependenciesMeta.optional`、`engines.dsh`、`dsh.bundle.patch`），只补 `"scripts": { "build": "tsc -p tsconfig.json", "test": "node --import tsx --test test/**/*.test.ts" }` 与 `devDependencies: { typescript, tsx }`。
`tsconfig.json`：`target: ES2023`、`module: NodeNext`、`strict: true`、`outDir: dist`、`rootDir: src`、`include: ["src"]`。
`src/index.ts` 只导出上面三个符号；`apply` 暂为空函数体加 `ctx.logger?.info?.('dsh-boost loaded')`。
`cordis.patch.yml` 按 §5.3 的完整 config 面写，`maxInlineTokens` 不下发（那是宿主 spill 的键，不是本插件的）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/plugin-load.test.ts`
Expected: PASS（1 test）

- [ ] **Step 5: 提交**

```bash
git add package.json tsconfig.json cordis.patch.yml LICENSE NOTICE README.en.md src/ test/ .gitignore
git commit -m "feat: 插件骨架与加载测试"
```

---

### Task 2: 配置解析与缺键回落

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`
- Modify: `src/index.ts`（在 `apply` 里调用 `resolveConfig`）

**Interfaces:**
- Consumes: `BoostConfig`、`ProjectionParams`（Task 1）
- Produces: `export const DEFAULT_CONFIG: BoostConfig`；`export function resolveConfig(raw: unknown): BoostConfig`

- [ ] **Step 1: 写失败测试**

```ts
// test/config.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, DEFAULT_CONFIG } from '../src/config.ts'

test('空配置等于默认值', () => {
  assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG)
  assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG)
})

test('逐键回落：只覆盖 read 的窗口，其余保持默认', () => {
  const c = resolveConfig({ projection: { read: { triggerChars: 5000 } } })
  assert.equal(c.projection.read.triggerChars, 5000)
  assert.equal(c.projection.read.headChars, 2000)
  assert.equal(c.projection.bash.triggerChars, 4000)
  assert.equal(c.stepsPerTurn, 8)
})

test('默认值逐字符合设计稿 §5.3', () => {
  assert.deepEqual(DEFAULT_CONFIG.projection.read, { triggerChars: 3000, headChars: 2000, tailChars: 500 })
  assert.deepEqual(DEFAULT_CONFIG.projection.grep, { triggerChars: 700, headChars: 400, tailChars: 100 })
  assert.deepEqual(DEFAULT_CONFIG.projection.glob, { triggerChars: 700, headChars: 400, tailChars: 100 })
  assert.deepEqual(DEFAULT_CONFIG.projection.bash, { triggerChars: 4000, headChars: 2000, tailChars: 500 })
  assert.deepEqual(DEFAULT_CONFIG.projection.ssh, { triggerChars: 2000, headChars: 1200, tailChars: 300 })
  assert.equal(DEFAULT_CONFIG.admission.thresholdTokens, 1024)
  assert.equal(DEFAULT_CONFIG.selector.maxTokens, 512)
  assert.equal(DEFAULT_CONFIG.horizonSteps, 20)
  assert.equal(DEFAULT_CONFIG.historyTurns, 5)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/config.test.ts`
Expected: FAIL，`Cannot find module '../src/config.ts'`

- [ ] **Step 3: 实现**

`resolveConfig` 对 `projection` 的每个族逐键合并（`raw?.projection?.[family]?.triggerChars ?? DEFAULT...`），其余标量同理。非对象输入一律返回 `DEFAULT_CONFIG` 的深拷贝（`structuredClone`），避免调用方改写默认值。**不做校验抛错**——错配置退化为默认值是这里要的行为。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/config.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add src/config.ts src/index.ts test/config.test.ts
git commit -m "feat: 配置解析与逐键回落"
```

---

### Task 3: 回执规范化

**Files:**
- Create: `src/projection/canonicalise.ts`, `test/canonicalise.test.ts`

**Interfaces:**
- Produces: `export interface CanonicalReceipt { text: string; isError: boolean; empty: boolean }`；`export function canonicalise(blocks: ReadonlyArray<{ type: string; text?: string }>, isError: boolean): CanonicalReceipt`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalise } from '../src/projection/canonicalise.ts'

test('多个 text block 按顺序拼成一个字符串', () => {
  const r = canonicalise([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], false)
  assert.equal(r.text, 'ab')
})

test('非 text block 被跳过，图片不参与规范化', () => {
  const r = canonicalise([{ type: 'text', text: 'x' }, { type: 'image' }, { type: 'text', text: 'y' }], false)
  assert.equal(r.text, 'xy')
})

test('空回执标记 empty', () => {
  assert.equal(canonicalise([], false).empty, true)
  assert.equal(canonicalise([{ type: 'text', text: '' }], false).empty, true)
  assert.equal(canonicalise([{ type: 'text', text: ' ' }], false).empty, false)
})

test('isError 透传', () => {
  assert.equal(canonicalise([{ type: 'text', text: 'boom' }], true).isError, true)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/canonicalise.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

按顺序 `filter(type === 'text')` 后 `map(b => b.text ?? '').join('')`；`empty = text.length === 0`。**不做 trim**：规范化文本要逐字可比对。不做任何转义或截断。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/canonicalise.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/projection/canonicalise.ts test/canonicalise.test.ts
git commit -m "feat: 回执规范化"
```

---

### Task 4: 截断与页脚（纯函数）

**Files:**
- Create: `src/projection/truncate.ts`, `test/truncate.test.ts`

**Interfaces:**
- Consumes: `ProjectionParams`（Task 1）
- Produces: `export interface Truncation { before: string; after: string; head: string; tail: string; omittedBytes: number; omittedCodePoints: number }`
- Produces: `export function shouldTruncate(text: string, params: ProjectionParams): boolean`
- Produces: `export function truncate(text: string, params: ProjectionParams): Truncation | null`（`null` = 不值得裁）
- Produces: `export function renderHeadLine(truncation: Truncation): string`，格式逐字为 `[output 18,432 chars; showing first 2,000 and last 500]`（千位分隔符用 `toLocaleString('en-US')`）

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { truncate, shouldTruncate, renderHeadLine } from '../src/projection/truncate.ts'

const READ = { triggerChars: 3000, headChars: 2000, tailChars: 500 }

test('低于触发阈值不裁', () => {
  assert.equal(shouldTruncate('x'.repeat(2999), READ), false)
  assert.equal(truncate('x'.repeat(2999), READ), null)
})

test('空回执不裁（Review Focus #1）', () => {
  assert.equal(shouldTruncate('', READ), false)
  assert.equal(truncate('', READ), null)
})

test('触发后头尾按参数切分', () => {
  const t = truncate('a'.repeat(1000) + 'M'.repeat(5000) + 'z'.repeat(1000), READ)!
  assert.equal(t.head.length, 2000)
  assert.equal(t.tail.length, 500)
  assert.ok(t.after.length < t.before.length)
})

test('中文与 emoji 不切开代理对（Review Focus #2）', () => {
  const text = '😀'.repeat(4000) // 每个 emoji 是 1 code point / 2 UTF-16 units
  const t = truncate(text, READ)!
  assert.equal(Array.from(t.head).length, 2000)
  assert.equal(Array.from(t.tail).length, 500)
  assert.equal(t.omittedCodePoints, 4000 - 2500)
  // 字节数 ≠ 字符数
  assert.equal(t.omittedBytes, 1500 * 4)
})

test('页脚头行逐字格式', () => {
  const t = truncate('a'.repeat(18432), READ)!
  assert.equal(renderHeadLine(t), '[output 18,432 chars; showing first 2,000 and last 500]')
})

test('不变量：触发阈值 ≥ 窗口 + 页脚 + 1', () => {
  const footerBytes = 110
  for (const p of [READ, { triggerChars: 700, headChars: 400, tailChars: 100 }]) {
    assert.ok(p.triggerChars >= p.headChars + p.tailChars + footerBytes + 1)
  }
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/truncate.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

用 `Array.from(text)` 转 code point 数组后再切（`const cp = Array.from(text)`），`head = cp.slice(0, headChars).join('')`、`tail = cp.slice(-tailChars).join('')`。`omittedCodePoints = cp.length - headChars - tailChars`；`omittedBytes = Buffer.byteLength(head + tail, 'utf8')` 之差——正确写法是 `Buffer.byteLength(text,'utf8') - Buffer.byteLength(head,'utf8') - Buffer.byteLength(tail,'utf8')`。`shouldTruncate` 先比 `text.length`（UTF-16，省一次 `Array.from`），`> triggerChars` 才进入细节；**`text.length > 256 * 1024` 直接返回 `false`**（§5.4，大回执不投影）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/truncate.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 提交**

```bash
git add src/projection/truncate.ts test/truncate.test.ts
git commit -m "feat: 截断窗口与页脚头行"
```

---

### Task 5: 投影执行——影子模式

**Files:**
- Create: `src/projection/apply.ts`, `test/projection-shadow.test.ts`

**Interfaces:**
- Consumes: `canonicalise`（T3）、`truncate`/`shouldTruncate`（T4）、`resolveConfig`（T2）
- Produces: `export type ProjectionMode = 'off' | 'shadow' | 'on'`
- Produces: `export interface ProjectionOutcome { kind: 'skipped' | 'shadow' | 'applied'; reason?: string; before?: number; after?: number; saved?: number }`
- Produces: `export async function projectShadow(text: string, family: ToolFamily, cfg: BoostConfig, estimate: (s: string) => number): Promise<ProjectionOutcome>`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { projectShadow } from '../src/projection/apply.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'

const estimate = (s: string) => Math.ceil(s.length / 4)

test('影子模式不改动文本，只报前后 token', async () => {
  const text = 'x'.repeat(20000)
  const o = await projectShadow(text, 'read', DEFAULT_CONFIG, estimate)
  assert.equal(o.kind, 'shadow')
  assert.equal(o.before, 5000)
  assert.ok(o.after! < o.before!)
  assert.equal(o.saved, o.before! - o.after!)
})

test('未配置的工具族直接跳过', async () => {
  const o = await projectShadow('x'.repeat(9999), 'web_fetch' as never, DEFAULT_CONFIG, estimate)
  assert.equal(o.kind, 'skipped')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/projection-shadow.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`projectShadow` 只读文本、算两份估计，**不触碰 content**（§5.4：shadow 不落盘、不依赖 spillStore）。`after` 的估计对象是"头行 + head + 省略说明 + tail"的拼接串，用同一个 `estimate`。未配置族返回 `{ kind: 'skipped', reason: 'family-not-configured' }`。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/projection-shadow.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add src/projection/apply.ts test/projection-shadow.test.ts
git commit -m "feat: 影子模式投影计量"
```

---

### Task 6: 投影执行——真替换（spill 落盘 + 页脚）

**Files:**
- Modify: `src/projection/apply.ts`, `test/projection-apply.test.ts`

**Interfaces:**
- Produces: `export interface SpillHandle { locator: string; retrievalHint: string }`
- Produces: `export interface SpillBackend { saveText(input: { owner: { sessionId: string }; source: { kind: 'tool'; toolName: string; callId?: string; label?: string }; suggestedName: string; content: string }): Promise<SpillHandle> }`
- Produces: `export async function projectApply(input: { text: string; family: ToolFamily; cfg: BoostConfig; sessionId: string | undefined; toolName: string; spill: SpillBackend | undefined; formatFooter: ((o: { kind: 'exact'; count: number }, ref: SpillHandle) => string) | undefined }): Promise<{ content: string; outcome: ProjectionOutcome }>`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { projectApply } from '../src/projection/apply.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'

const spill = { saveText: async () => ({ locator: '/spill/read-1.txt', retrievalHint: 'Use read with offset/limit' }) }
const footer = (o: { count: number }, ref: { locator: string }) =>
  `Omitted ${o.count} bytes. Full formatted result stored at: ${ref.locator}.`

test('on 模式：原文落盘、content 变短、页脚含 locator', async () => {
  const text = 'a'.repeat(18432)
  const r = await projectApply({ text, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', spill, formatFooter: footer })
  assert.ok(r.content.length < text.length)
  assert.match(r.content, /Full formatted result stored at: \/spill\/read-1\.txt/)
  assert.equal(r.outcome.kind, 'applied')
})

test('缺 spill 后端：不投影，原样返回（§5.4 可见性三条 3）', async () => {
  const text = 'a'.repeat(18432)
  const r = await projectApply({ text, family: 'read', cfg: DEFAULT_CONFIG, sessionId: 's1', toolName: 'read', spill: undefined, formatFooter: footer })
  assert.equal(r.content, text)
  assert.equal(r.outcome.reason, 'no-spill')
})

test('缺 sessionId：不投影', async () => {
  const text = 'a'.repeat(18432)
  const r = await projectApply({ text, family: 'read', cfg: DEFAULT_CONFIG, sessionId: undefined, toolName: 'read', spill, formatFooter: footer })
  assert.equal(r.content, text)
  assert.equal(r.outcome.reason, 'no-owner')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/projection-apply.test.ts`
Expected: FAIL，`projectApply is not a function`

- [ ] **Step 3: 实现**

顺序：`shouldTruncate` 为假 → `{kind:'skipped'}`；缺 `spill` → `no-spill`；缺 `sessionId` → `no-owner`；缺 `formatFooter` → `no-footer`。都过了才 `saveText({ content: text })`（**存规范化原文，不是投影后文本**，§5.4），再拼 `renderHeadLine + head + footer + tail`。`formatFooter` 由调用方动态导入宿主函数（Task 17 接），这里只收函数，不 import——保证纯函数可测。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/projection-apply.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add src/projection/apply.ts test/projection-apply.test.ts
git commit -m "feat: 投影真替换与 spill 落盘"
```

---

### Task 7: 收据存储

**Files:**
- Create: `src/receipts/store.ts`, `test/receipts.test.ts`

**Interfaces:**
- Produces: `export type ReceiptKind = 'substitute' | 'shadow' | 'projection' | 'skip' | 'reset'`
- Produces: `export interface Receipt { v: 1; ts: string; sessionId: string; turn: number; kind: ReceiptKind; code: string; [k: string]: unknown }`
- Produces: `export class ReceiptStore { constructor(root: string); append(r: Receipt): Promise<void>; failures(): number; stopped(): boolean }`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReceiptStore } from '../src/receipts/store.ts'

const rec = (sessionId: string): any => ({ v: 1, ts: '2026-11-19T00:00:00.000Z', sessionId, turn: 1, kind: 'shadow', code: 'ok' })

test('按 session 分片写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boost-'))
  const s = new ReceiptStore(root)
  await s.append(rec('a'))
  await s.append(rec('b'))
  const a = await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')
  assert.equal(a.trim().split('\n').length, 1)
})

test('连续 3 次写失败后停止替换（fail-closed）', async () => {
  const s = new ReceiptStore('/proc/definitely-not-writable')
  for (let i = 0; i < 3; i++) await s.append(rec('a'))
  assert.equal(s.failures(), 3)
  assert.equal(s.stopped(), true)
})

test('半行损坏被忽略，不抛错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boost-'))
  const s = new ReceiptStore(root)
  await s.append(rec('a'))
  assert.equal(await s.count('a'), 1)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/receipts.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

路径 `<root>/receipts/<sessionId>.jsonl`；`append` 用 `appendFile` 后 `open(f).sync()` 每 20 行一次（不每行 fsync，§5.3 备注）。捕获异常→`failures++`、内存缓冲、返回；不抛给调用方。`stopped()` 当 `failures >= 3`。单文件超 8 MiB 或 20,000 行时轮转（`.1` 保留一份）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/receipts.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add src/receipts/store.ts test/receipts.test.ts
git commit -m "feat: 分片收据存储与失败熔断"
```

---

### Task 8: scope 文档模型

**Files:**
- Create: `src/scope/doc.ts`, `test/scope-doc.test.ts`

**Interfaces:**
- Produces: `export interface ScopeDoc { version: 2; revision: number; updatedAt?: string; mode: 'selected' | 'global'; workspaceIds: string[]; shadow: boolean; projection: ProjectionMode }`
- Produces: `export const DEFAULT_SCOPE: ScopeDoc`（`selected + []`，`shadow: true`，`projection: 'shadow'`）
- Produces: `export function parseScope(raw: unknown): { doc: ScopeDoc; degraded?: 'unknown-version' | 'parse-failed' }`
- Produces: `export function isVisible(doc: ScopeDoc, workspaceId: string | undefined): boolean`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseScope, isVisible, DEFAULT_SCOPE } from '../src/scope/doc.ts'

test('默认谁都不给', () => {
  assert.deepEqual(DEFAULT_SCOPE.workspaceIds, [])
  assert.equal(isVisible(DEFAULT_SCOPE, 'ws-1'), false)
  assert.equal(isVisible(DEFAULT_SCOPE, undefined), false)
})

test('version 1 只读降级，不抛错（Review Focus #4）', () => {
  const r = parseScope({ version: 1, mode: 'global' })
  assert.equal(r.degraded, 'unknown-version')
  assert.deepEqual(r.doc, DEFAULT_SCOPE)
})

test('坏 JSON 对象降级', () => {
  assert.equal(parseScope('not an object').degraded, 'parse-failed')
  assert.equal(parseScope(null).degraded, 'parse-failed')
})

test('selected + [ws] 只对该工作区可见', () => {
  const d = { ...DEFAULT_SCOPE, workspaceIds: ['ws-1'] }
  assert.equal(isVisible(d, 'ws-1'), true)
  assert.equal(isVisible(d, 'ws-2'), false)
})

test('global 对任何有 workspace 的 agent 可见，但 undefined 仍不可见', () => {
  const d = { ...DEFAULT_SCOPE, mode: 'global' as const }
  assert.equal(isVisible(d, 'ws-1'), true)
  assert.equal(isVisible(d, undefined), false)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/scope-doc.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`parseScope` 只认 `version === 2`；其余一律 `{ doc: structuredClone(DEFAULT_SCOPE), degraded: 'unknown-version' }`。`mode` 非 `'selected' | 'global'` 时按 `'selected'`、`workspaceIds` 非数组时按 `[]`（更严的一侧）。`isVisible`：`workspaceId === undefined` 一律 false（无 scope = 全局视图 = 不注入，§5.5）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/scope-doc.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add src/scope/doc.ts test/scope-doc.test.ts
git commit -m "feat: scope 文档模型与严格序"
```

---

### Task 9: scope 存储（mtime+revision 缓存、锁、原子写）

**Files:**
- Create: `src/scope/store.ts`, `test/scope-store.test.ts`

**Interfaces:**
- Consumes: `ScopeDoc`、`parseScope`（T8）
- Produces: `export class ScopeStore { constructor(dir: string); read(): Promise<{ doc: ScopeDoc; degraded?: string }>; write(mutate: (d: ScopeDoc) => ScopeDoc, baseRevision: number): Promise<ScopeDoc> }`
- Produces: 错误码常量 `ERR_SCOPE_LOCKED`、`ERR_SCOPE_REVISION_CONFLICT`、`ERR_SCOPE_READ_FAILED`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScopeStore } from '../src/scope/store.ts'

test('缺失文件返回默认并标 degraded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  const r = await new ScopeStore(dir).read()
  assert.equal(r.doc.mode, 'selected')
  assert.equal(r.degraded, 'read-failed')
})

test('写后 revision 自增，mtime 变化让缓存失效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  const s = new ScopeStore(dir)
  const a = await s.write(d => ({ ...d, mode: 'global' }), 0)
  assert.equal(a.revision, 1)
  const b = await s.read()
  assert.equal(b.doc.mode, 'global')
  assert.equal(b.doc.revision, 1)
})

test('base revision 不符时拒绝（TOCTOU）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  const s = new ScopeStore(dir)
  await s.write(d => ({ ...d, mode: 'global' }), 0)
  await assert.rejects(() => s.write(d => d, 0), /ERR_SCOPE_REVISION_CONFLICT/)
})

test('锁被占用时拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  await writeFile(join(dir, 'scope.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
  await assert.rejects(() => new ScopeStore(dir).write(d => d, 0), /ERR_SCOPE_LOCKED/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/scope-store.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`read`：`stat` 取 mtime + 读文件 → `parseScope`；缓存命中条件 = `mtime` 与 `revision` 都未变。`write`：`open(lock,'wx')`（`await` 一次）→ 读 → 校验 `baseRevision` → `mutate` → `revision + 1` → **同步** `writeFileSync` 到临时文件 + `renameSync` → `unlink(lock)`。锁已存在时先判回收（`mtime > 60s` 且 pid 不存活），否则抛 `ERR_SCOPE_LOCKED`。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/scope-store.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/scope/store.ts test/scope-store.test.ts
git commit -m "feat: scope 原子写与锁"
```

---

### Task 10: workspace 解析与 `when` 注册

**Files:**
- Create: `src/scope/resolve.ts`, `test/scope-resolve.test.ts`, `test/fakes/host.ts`

**Interfaces:**
- Consumes: `isVisible`（T8）、`ScopeStore`（T9）
- Produces: `export function workspaceIdOf(agent: { session?: { header?: { cwd?: string } } } | undefined): string | undefined`
- Produces: `export async function resolveVisible(store: ScopeStore, agent: unknown): Promise<boolean>`
- Produces: `export function supportsStepWhen(tools: { resolve?: unknown } | undefined): boolean`（`typeof tools?.resolve === 'function'`）
- Produces: `test/fakes/host.ts` 的 `export function fakeHost(overrides?: Record<string, unknown>): any`（可注入 `tools.register/resolve/definitions`、`llm.stream`、`systemPrompt.section`、`tokenMeter`、`spillStore`）

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceIdOf, resolveVisible, supportsStepWhen } from '../src/scope/resolve.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScopeStore } from '../src/scope/store.ts'

test('cwd 映射到 workspace id', () => {
  assert.equal(workspaceIdOf({ session: { header: { cwd: '/w/a' } } }), '/w/a')
  assert.equal(workspaceIdOf(undefined), undefined)
})

test('无 agent 一律不可见', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  assert.equal(await resolveVisible(new ScopeStore(dir), undefined), false)
})

test('global 模式下有 cwd 即可见', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  const s = new ScopeStore(dir)
  await s.write(d => ({ ...d, mode: 'global' }), 0)
  assert.equal(await resolveVisible(s, { session: { header: { cwd: '/w/a' } } }), true)
})

test('宿主没有 tools.resolve 时判不支持步骤级 when', () => {
  assert.equal(supportsStepWhen({}), false)
  assert.equal(supportsStepWhen({ resolve: () => [] }), true)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/scope-resolve.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`workspaceIdOf` 读 `agent?.session?.header?.cwd`（`Session.header` 非可选，不套多余可选链）。`resolveVisible` 先取 doc 再 `isVisible(doc, workspaceIdOf(agent))`，任何异常 → `false`。`supportsStepWhen` 只做 `typeof` 判断。`test/fakes/host.ts` 提供一个最小假宿主：记录 `register` 调用（含 `when`）、`resolve()` 返回已注册列表、`llm.stream` 可控返回。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/scope-resolve.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/scope/resolve.ts test/scope-resolve.test.ts test/fakes/host.ts
git commit -m "feat: workspace 解析与 when 能力探测"
```

---

### Task 11: 计划解析（候选与守卫）

**Files:**
- Create: `src/gate/plan.ts`, `test/plan.test.ts`

**Interfaces:**
- Produces: `export type Guard = { ok: true } | { text_contains: string } | { text_not_contains: string } | { json_equals: { pointer: string; value: string | number | boolean } }`
- Produces: `export interface Candidate { id: string; tool: string; args: Record<string, unknown>; guards: Guard[] }`
- Produces: `export interface Plan { goal: string; steps: Candidate[] }`
- Produces: `export function parsePlan(text: string): { plan: Plan } | { error: 'no-plan' | 'bad-json' | 'bad-shape' }`
- Produces: `export function isTrivial(c: Candidate): boolean`（只有一个 `ok: true` 或多个 `ok:true` 但无其它 guard）

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePlan, isTrivial } from '../src/gate/plan.ts'

const wrap = (json: string) => `前言\n<CHISEL_PLAN>${json}</CHISEL_PLAN>\n后记`

test('解析出计划与候选', () => {
  const r = parsePlan(wrap(JSON.stringify({ goal: 'g', steps: [{ id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ text_contains: 'x' }] }] })))
  assert.ok('plan' in r)
  if ('plan' in r) assert.equal(r.plan.steps[0].id, 'A')
})

test('没有计划块返回 no-plan', () => {
  assert.deepEqual(parsePlan('nothing here'), { error: 'no-plan' })
})

test('坏 JSON 返回 bad-json', () => {
  assert.deepEqual(parsePlan(wrap('{oops')), { error: 'bad-json' })
})

test('只有 ok:true 判平凡（guard-trivial）', () => {
  assert.equal(isTrivial({ id: 'A', tool: 'read', args: {}, guards: [{ ok: true }] }), true)
  assert.equal(isTrivial({ id: 'A', tool: 'read', args: {}, guards: [{ ok: true }, { text_contains: 'x' }] }), false)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/plan.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

用 `/<CHISEL_PLAN>([\s\S]*?)<\/CHISEL_PLAN>/` 取第一块；`JSON.parse` 失败 → `bad-json`；`steps` 非数组或某项缺 `id`/`tool`/`guards` → `bad-shape`。**只收字面量**：`args` 里出现非字面量结构（函数、`$eval` 等）→ `bad-shape`；`$public` 模板原样保留，校验交给 Task 13。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/plan.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/gate/plan.ts test/plan.test.ts
git commit -m "feat: 计划解析与平凡守卫判定"
```

---

### Task 12: `$public` 参数绑定

**Files:**
- Create: `src/gate/binding.ts`, `test/binding.test.ts`

**Interfaces:**
- Consumes: `CanonicalReceipt`（T3）
- Produces: `export type PublicTemplate = { $public: { after: 'root' | string; field: string } }`
- Produces: `export function isTemplate(v: unknown): v is PublicTemplate`
- Produces: `export function bindArgs(args: Record<string, unknown>, receipts: ReadonlyMap<string, CanonicalReceipt>): { ok: true; args: Record<string, unknown> } | { ok: false; reason: 'ambiguous' | 'unresolvable' | 'missing-receipt' | 'not-single-text' }`
- Produces: `export function extractField(text: string, field: string): string | undefined`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { bindArgs, extractField } from '../src/gate/binding.ts'

const r = (text: string) => ({ text, isError: false, empty: text.length === 0 })

test('identifier 取 name: "x" / name=x', () => {
  assert.equal(extractField('garbage\nname: "abc"\n', 'name'), 'abc')
  assert.equal(extractField('name=abc', 'name'), 'abc')
})

test('$scalar 整段匹配，含空格即失败', () => {
  assert.equal(extractField('  abc-1  ', '$scalar'), 'abc-1')
  assert.equal(extractField('a b', '$scalar'), undefined)
})

test('$single 取单元素数组', () => {
  assert.equal(extractField("['v']", '$single'), 'v')
  assert.equal(extractField("['a','b']", '$single'), undefined)
})

test('重复匹配判歧义', () => {
  assert.equal(extractField('name: "a"\nname: "b"', 'name'), undefined)
})

test('root 模板绑定到本步回执', () => {
  const out = bindArgs({ path: { $public: { after: 'root', field: '$scalar' } } }, new Map([['root', r('/tmp/x')]]))
  assert.deepEqual(out, { ok: true, args: { path: '/tmp/x' } })
})

test('引用不存在的图节点判 unresolvable（Review Focus #3）', () => {
  const out = bindArgs({ path: { $public: { after: 'C', field: '$scalar' } } }, new Map([['A', r('x')], ['B', r('y')]]))
  assert.deepEqual(out, { ok: false, reason: 'unresolvable' })
})

test('引用出错回执判 missing-receipt', () => {
  const m = new Map([['A', { text: 'x', isError: true, empty: false }]])
  const out = bindArgs({ p: { $public: { after: 'A', field: '$scalar' } } }, m)
  assert.deepEqual(out, { ok: false, reason: 'missing-receipt' })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/binding.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`extractField`：`$scalar` 用 `/^[A-Za-z0-9_+@.:/-]+$/` 对 trim 后全文；`$single` 用 `/^\['([^']*)'\]$/`；标识符用 `new RegExp(`(?:^|\\n)\\s*${escape(field)}[:=]\\s*"?([^"\\n]+)"?`)` 全局匹配，**恰好 1 个**才算成功。`bindArgs` 递归替换模板；`after` 不在 `receipts` 里 → `unresolvable`；命中回执 `isError` 或 `empty` → `missing-receipt`；非模板值原样保留。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/binding.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: 提交**

```bash
git add src/gate/binding.ts test/binding.test.ts
git commit -m "feat: \$public 参数绑定与唯一性判定"
```

---

### Task 13: 守卫求值

**Files:**
- Create: `src/gate/guard.ts`, `test/guard.test.ts`

**Interfaces:**
- Consumes: `Guard`（T11）、`CanonicalReceipt`（T3）
- Produces: `export type GuardResult = 'pass' | 'fail' | 'unknown'`
- Produces: `export function evaluateGuard(g: Guard, r: CanonicalReceipt): GuardResult`
- Produces: `export function evaluateAll(guards: Guard[], r: CanonicalReceipt): { ok: boolean; failed?: Guard }`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateGuard, evaluateAll } from '../src/gate/guard.ts'

const r = (text: string, isError = false) => ({ text, isError, empty: text.length === 0 })

test('ok 读 isError', () => {
  assert.equal(evaluateGuard({ ok: true }, r('x')), 'pass')
  assert.equal(evaluateGuard({ ok: true }, r('x', true)), 'fail')
})

test('text_contains 区分大小写', () => {
  assert.equal(evaluateGuard({ text_contains: 'Foo' }, r('a Foo b')), 'pass')
  assert.equal(evaluateGuard({ text_contains: 'foo' }, r('a Foo b')), 'fail')
})

test('text_not_contains 用于排除错误页脚', () => {
  assert.equal(evaluateGuard({ text_not_contains: '[exit code: 1]' }, r('ok')), 'pass')
  assert.equal(evaluateGuard({ text_not_contains: '[exit code: 1]' }, r('x\n[exit code: 1]')), 'fail')
})

test('json_equals 解析失败判 fail，不抛错', () => {
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: 1 } }, r('{"a":1}')), 'pass')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: 2 } }, r('{"a":1}')), 'fail')
  assert.equal(evaluateGuard({ json_equals: { pointer: '/a', value: 1 } }, r('not json')), 'fail')
})

test('全部通过才 ok，返回第一个失败项', () => {
  const guards = [{ ok: true }, { text_contains: 'x' }] as any
  assert.deepEqual(evaluateAll(guards, r('x')), { ok: true })
  assert.deepEqual(evaluateAll(guards, r('y')), { ok: false, failed: guards[1] })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/guard.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

四个分支直接对照表格语义（§5.2）。`json_equals` 用 `JSON.parse` + 手写 pointer 走查（`pointer.split('/').slice(1)`），解析失败或路径缺失一律 `fail`。**不实现** `exit_code` / `stderr_empty`（§5.2 明确禁用）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/guard.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add src/gate/guard.ts test/guard.test.ts
git commit -m "feat: 四类守卫求值"
```

---

### Task 14: 选择器（Jev）

**Files:**
- Create: `src/selector/jev.ts`, `test/jev.test.ts`

**Interfaces:**
- Consumes: 宿主 `llm`（`{ stream(opts): AsyncIterable<{ text?: string }> }`）
- Produces: `export interface LlmLike { stream(opts: unknown): AsyncIterable<{ text?: string }> }`
- Produces: `export const SELECTOR_PURPOSE = 'boost-selector'`
- Produces: `export async function choose(input: { llm: LlmLike; candidates: { id: string; summary: string }[]; receiptText: string; maxTokens: number; timeoutMs?: number }): Promise<{ choice: string } | { abstain: 'timeout' | 'error' | 'no-label' }>`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { choose, SELECTOR_PURPOSE } from '../src/selector/jev.ts'

const llmOf = (chunks: string[], delay = 0) => ({
  async *stream(opts: any) {
    for (const c of chunks) { if (delay) await new Promise(r => setTimeout(r, delay)); yield { text: c } }
    return opts
  }
})

const cands = [{ id: 'A', summary: 'read /a' }, { id: 'B', summary: 'read /b' }]

test('单标签被解析为选择', async () => {
  const r = await choose({ llm: llmOf(['B']) as any, candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { choice: 'B' })
})

test('问号与其它字符一律 abstain:no-label', async () => {
  for (const s of ['?', 'AB', 'neither']) {
    const r = await choose({ llm: llmOf([s]) as any, candidates: cands, receiptText: 'x', maxTokens: 512 })
    assert.deepEqual(r, { abstain: 'no-label' })
  }
})

test('超时 abstain:timeout', async () => {
  const r = await choose({ llm: llmOf(['A'], 100) as any, candidates: cands, receiptText: 'x', maxTokens: 512, timeoutMs: 10 })
  assert.deepEqual(r, { abstain: 'timeout' })
})

test('调用抛错 abstain:error', async () => {
  const llm = { async *stream() { throw new Error('boom') } }
  const r = await choose({ llm: llm as any, candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { abstain: 'error' })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/jev.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

调 `llm.stream({ purpose: SELECTOR_PURPOSE, maxTokens, messages: [...] })`，`for await` 收集文本；`Promise.race` 加 20s 默认超时。只接受**恰好等于某个候选 id 的单字符**；`?` 或其它 → `no-label`。系统提示逐字限定"只允许输出一个候选标签或 `?`"。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/jev.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/selector/jev.ts test/jev.test.ts
git commit -m "feat: 单标签选择器与合作超时"
```

---

### Task 15: 替换决策编排

**Files:**
- Create: `src/gate/decide.ts`, `test/decide.test.ts`

**Interfaces:**
- Consumes: `parsePlan`/`isTrivial`（T11）、`bindArgs`（T12）、`evaluateAll`（T13）、`choose`（T14）
- Produces: `export type Decision = { kind: 'commit'; candidateId: string; args: Record<string, unknown> } | { kind: 'ask-selector'; candidates: Candidate[] } | { kind: 'fallback'; code: string }`
- Produces: `export function decide(input: { plan: Plan; stepId: string; receipts: ReadonlyMap<string, CanonicalReceipt> }): Decision`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { decide } from '../src/gate/decide.ts'

const rc = (t: string) => ({ text: t, isError: false, empty: false })
const plan = (cands: any[]) => ({ goal: 'g', steps: cands })

test('唯一合格候选直接提交', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ text_contains: 'x' }] },
                { id: 'B', tool: 'read', args: { path: '/b' }, guards: [{ text_contains: 'nope' }] }]),
    stepId: 'root', receipts: new Map([['root', rc('x')]]),
  })
  assert.equal(d.kind, 'commit')
  if (d.kind === 'commit') assert.deepEqual(d.args, { path: '/a' })
})

test('多候选且全合格 → ask-selector', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ text_contains: 'x' }] },
                { id: 'B', tool: 'read', args: { path: '/b' }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', receipts: new Map([['root', rc('x')]]),
  })
  assert.equal(d.kind, 'ask-selector')
})

test('平凡守卫回退 guard-trivial', () => {
  const d = decide({ plan: plan([{ id: 'A', tool: 'read', args: {}, guards: [{ ok: true }] }]), stepId: 'root', receipts: new Map([['root', rc('x')]]) })
  assert.deepEqual(d, { kind: 'fallback', code: 'guard-trivial' })
})

test('绑定歧义回退', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: { $public: { after: 'root', field: 'name' } } }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', receipts: new Map([['root', rc('x')]]),
  })
  assert.equal(d.kind, 'fallback')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/decide.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

流程：过滤平凡 → 逐个 `bindArgs`（失败即该候选淘汰）→ `evaluateAll`（非 `pass` 淘汰）→ 0 个 `fallback: no-candidate`，1 个 `commit`，≥2 个 `ask-selector`。**不做**任何"猜一个"。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/decide.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/gate/decide.ts test/decide.test.ts
git commit -m "feat: 替换决策编排"
```

---

### Task 16: 准入记账

**Files:**
- Create: `src/admission/ledger.ts`, `test/ledger.test.ts`

**Interfaces:**
- Consumes: `BoostConfig`（T1）
- Produces: `export function remainingSteps(input: { stepsSoFar: number[]; horizonSteps: number; historyTurns: number }): number`
- Produces: `export function worthSubstituting(input: { savedTokens: number; overheadTokens: number; thresholdTokens: number; deterministicSingle: boolean }): boolean`
- Produces: `export class StepBudget { constructor(max: number); take(): boolean; exhausted(): boolean; count(): number }`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { remainingSteps, worthSubstituting, StepBudget } from '../src/admission/ledger.ts'

test('剩余步数取 horizon 与历史均值的较小者', () => {
  assert.equal(remainingSteps({ stepsSoFar: [50, 60, 70, 80, 90], horizonSteps: 20, historyTurns: 5 }), 20)
  assert.equal(remainingSteps({ stepsSoFar: [2, 3], horizonSteps: 20, historyTurns: 5 }), 3)
  assert.equal(remainingSteps({ stepsSoFar: [], horizonSteps: 20, historyTurns: 5 }), 20)
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/ledger.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`remainingSteps`：`stepsSoFar.length === 0` → `horizonSteps`；否则 `Math.min(horizonSteps, Math.round(mean))`，均值只取最后 `historyTurns` 个。`worthSubstituting`：`deterministicSingle || saved - overhead > threshold`。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/ledger.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add src/admission/ledger.ts test/ledger.test.ts
git commit -m "feat: 准入记账与每轮步数预算"
```

---

### Task 17: 钩子装配（post-execute / llm-stream / execute / systemPrompt）

**Files:**
- Create: `src/hooks/post-execute.ts`, `src/hooks/llm-stream.ts`, `src/hooks/execute.ts`, `test/hooks.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `projectApply`/`projectShadow`（T5/T6）、`ReceiptStore`（T7）、`ScopeStore`/`resolveVisible`（T9/T10）、`SELECTOR_PURPOSE`（T14）
- Produces: `export function registerHooks(ctx: PluginContext, deps: { config: BoostConfig; scope: ScopeStore; receipts: ReceiptStore }): void`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeHost } from './fakes/host.ts'
import { SELECTOR_PURPOSE } from '../src/selector/jev.ts'

test('llm/stream 见到 selector 标记直接放行（不合成回合）', async () => {
  const host = fakeHost()
  // registerHooks 已把 handler 挂到 host.on('llm/stream')
  const opts = { purpose: SELECTOR_PURPOSE, messages: [] }
  const out = await host.callHook('llm/stream', [opts], async () => 'PASSTHROUGH')
  assert.equal(out, 'PASSTHROUGH')
})

test('post-execute 对未配置族原样返回', async () => {
  const host = fakeHost()
  const res = await host.callHook('tools/post-execute', [{ name: 'web_fetch', agent: undefined }, { content: [{ type: 'text', text: 'x'.repeat(5000) }] }], async () => ({ kind: 'accept' }))
  assert.equal(res.kind, 'accept')
})

test('缺 agent 时不投影，记 skip:no-scope', async () => {
  const host = fakeHost()
  await host.callHook('tools/post-execute', [{ name: 'read', agent: undefined }, { content: [{ type: 'text', text: 'x'.repeat(5000) }] }], async () => ({ kind: 'accept' }))
  assert.ok(host.receipts.some((r: any) => r.code === 'skip:no-scope'))
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/hooks.test.ts`
Expected: FAIL，`fakeHost` 未接钩子

- [ ] **Step 3: 实现**

`registerHooks` 里按 §5 的表注册四件事；`post-execute` 的顺序严格为 `canonicalise →（替换决策）→ 投影 → 返回 decision`；`llm/stream` 第一行判 `opts?.purpose === SELECTOR_PURPOSE` 即 `return next()`。`systemPrompt` 用 `ctx.systemPrompt.section({ name: 'dsh-boost', order: 100, text, interpolate: false })`。`execute` 做防篡改（Task 18 填充）。`fakeHost` 增加 `callHook(name: string, args: unknown[], next: () => Promise<unknown>)` 与 `receipts` 数组——瀑布钩子统一按"先参数数组、后 next"调用。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/hooks.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add src/hooks/ test/hooks.test.ts test/fakes/host.ts src/index.ts
git commit -m "feat: 四挂载点装配"
```

---

### Task 18: 派发防篡改

**Files:**
- Create: `src/hooks/execute.ts`（覆盖 T17 的空壳）, `test/execute.test.ts`

**Interfaces:**
- Consumes: `bindArgs`（T12）
- Produces: `export function sameLiteral(a: unknown, b: unknown): boolean`；`export function rejectIfTampered(exec: { name: string; arguments: unknown }, pending: PendingDispatch | undefined): { reject: true; code: 'dispatch-rejected' } | { reject: false }`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { sameLiteral, rejectIfTampered } from '../src/hooks/execute.ts'

test('字面量逐字比对，键序无关', () => {
  assert.equal(sameLiteral({ a: 1, b: 'x' }, { b: 'x', a: 1 }), true)
  assert.equal(sameLiteral({ a: 1 }, { a: 2 }), false)
  assert.equal(sameLiteral({ a: 1, b: 2 }, { a: 1 }), false)
})

test('实参被改动则拒绝派发', () => {
  const pending = { candidateId: 'A', name: 'read', args: { path: '/a' } } as any
  assert.deepEqual(rejectIfTampered({ name: 'read', arguments: { path: '/b' } }, pending), { reject: true, code: 'dispatch-rejected' })
  assert.deepEqual(rejectIfTampered({ name: 'read', arguments: { path: '/a' } }, pending), { reject: false })
})

test('无 pending 时不干预', () => {
  assert.deepEqual(rejectIfTampered({ name: 'read', arguments: {} }, undefined), { reject: false })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/execute.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`sameLiteral` 递归比较：对象比键集合与每键递归，数组按序，标量 `Object.is`。`rejectIfTampered` 只比对 `name` 与 `arguments`；不一致返回 `dispatch-rejected` 并清 pending。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/execute.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add src/hooks/execute.ts test/execute.test.ts
git commit -m "feat: 派发防篡改比对"
```

---

### Task 19: `boost` 工具与状态输出

**Files:**
- Create: `src/tools/boost.ts`, `test/boost-tool.test.ts`
- Modify: `src/index.ts`（在 `apply` 里 `ctx.tools.register(...)`，带 `when`）

**Interfaces:**
- Consumes: `ScopeStore`（T9）、`ReceiptStore`（T7）、`supportsStepWhen`（T10）
- Produces: `export interface BoostStatus { scope: { mode: string; workspaceIds: string[]; revision: number }; shadow: boolean; projection: ProjectionMode; saved: { substitution: number; projectionGross: number; projectionNet: number; retrievals: number }; counts: Record<string, number>; degraded: string[] }`
- Produces: `export async function runBoost(input: { args: { cmd: 'status' | 'scope-get' | 'scope-set' | 'shadow'; body?: unknown; baseRevision?: number }; scope: ScopeStore; receipts: ReceiptStore }): Promise<{ ok: true; data: unknown } | { ok: false; code: string }>`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBoost } from '../src/tools/boost.ts'
import { ScopeStore } from '../src/scope/store.ts'
import { ReceiptStore } from '../src/receipts/store.ts'

const deps = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boost-'))
  return { scope: new ScopeStore(dir), receipts: new ReceiptStore(dir) }
}

test('status 输出 shadow 与 projection（否则无法核实）', async () => {
  const d = await deps()
  const r = await runBoost({ args: { cmd: 'status' }, ...d })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal((r.data as any).shadow, true)
    assert.equal((r.data as any).projection, 'shadow')
  }
})

test('scope-set 带 baseRevision，冲突返回稳定码', async () => {
  const d = await deps()
  await runBoost({ args: { cmd: 'scope-set', body: { mode: 'global' }, baseRevision: 0 }, ...d })
  const r = await runBoost({ args: { cmd: 'scope-set', body: { mode: 'global' }, baseRevision: 0 }, ...d })
  assert.deepEqual(r, { ok: false, code: 'ERR_SCOPE_REVISION_CONFLICT' })
})

test('未知子命令返回稳定码', async () => {
  const d = await deps()
  const r = await runBoost({ args: { cmd: 'nope' as any }, ...d })
  assert.equal(r.ok, false)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/boost-tool.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

四个子命令；`scope-set` 先 `validate → prune → write`，把 `ScopeStore.write` 的错误码原样透出（`ERR_SCOPE_REVISION_CONFLICT` / `ERR_SCOPE_LOCKED`）。`status` 扫收据聚合三类计数与两组账，`degraded` 收集 `no-spill` / `no-tokenmeter` / `scope-degraded`。工具注册用 `ctx.tools.register(def, { when })`；`supportsStepWhen` 为假时**整族不注册**并 `ctx.logger.warn('ERR_HOST_NO_STEP_WHEN')`；`boost` 自身**豁免 scope**（`when: () => true`），但协议段不豁免。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/boost-tool.test.ts && npm test`
Expected: 全部 PASS

- [ ] **Step 5: 提交并推送**

```bash
git add src/tools/boost.ts test/boost-tool.test.ts src/index.ts
git commit -m "feat: boost 工具与状态聚合"
git push origin main
```

---

### Task 20: 协议段文本与回合时钟

**Files:**
- Create: `src/prompt/protocol.ts`, `src/hooks/clock.ts`, `test/protocol.test.ts`

**Interfaces:**
- Produces: `export const PROTOCOL_NAME = 'dsh-boost'`；`export const PROTOCOL_ORDER = 100`
- Produces: `export const PROTOCOL_TEXT: string`——注入主模型的计划协议段（常驻、字面量稳定，`interpolate: false`）
- Produces: `export class TurnClock { onModelRequest(): void; turn(): number; takeStep(): void; stepsThisTurn(): number }`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { PROTOCOL_TEXT } from '../src/prompt/protocol.ts'
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/protocol.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`PROTOCOL_TEXT` 用纯字符串模板写死四段：①计划格式（`<CHISEL_PLAN>` 内的 `goal` + `steps`，每步 `id`/`tool`/`args`/`guards`）；②允许的工具只有 `read`/`grep`/`glob`（其余写了也不会被替换）；③`$public` 三种取法；④"守卫失败即回主模型"的后果声明。**不得包含 `{{`**——协议段以 `interpolate: false` 注入，但保持字面量干净便于日后放松。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/protocol.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add src/prompt/protocol.ts src/hooks/clock.ts test/protocol.test.ts
git commit -m "feat: 计划协议段与回合时钟"
```

---

### Task 21: 用量配对（`saved_input_tokens` / `cache_hit_delta`）

**Files:**
- Create: `src/admission/usage.ts`, `test/usage.test.ts`

**Interfaces:**
- Produces: `export interface Usage { input: number; cacheRead: number }`
- Produces: `export class UsageLedger { request(u: Usage): void; markSubstituted(candidateId: string): void; settle(): { saved_input_tokens: number | 'unknown'; cache_hit_delta: number | null } }`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { UsageLedger } from '../src/admission/usage.ts'

test('saved_input_tokens 取后一次请求的 input + cacheRead（不插值）', () => {
  const l = new UsageLedger()
  l.request({ input: 100, cacheRead: 900 })   // 替换前那次
  l.markSubstituted('A')
  l.request({ input: 200, cacheRead: 1800 })  // 后一次
  const r = l.settle()
  assert.equal(r.saved_input_tokens, 2000)
})

test('后一次请求缺失记 unknown', () => {
  const l = new UsageLedger()
  l.request({ input: 100, cacheRead: 900 })
  l.markSubstituted('A')
  assert.equal(l.settle().saved_input_tokens, 'unknown')
})

test('cache_hit_delta = 前后命中率之差', () => {
  const l = new UsageLedger()
  l.request({ input: 1000, cacheRead: 0 })    // 0%
  l.markSubstituted('A')
  l.request({ input: 100, cacheRead: 900 })   // 90%
  assert.equal(l.settle().cache_hit_delta, 0.9)
})

test('无前一次请求时 delta 记 null', () => {
  const l = new UsageLedger()
  l.markSubstituted('A')
  l.request({ input: 100, cacheRead: 900 })
  assert.equal(l.settle().cache_hit_delta, null)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/usage.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

只保留"上一次请求"与"待配对标记"两个槽位（不建全表，YAGNI）。`settle()` 消费并清空。命中率 = `cacheRead / (input + cacheRead)`，分母为 0 记 `null`。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/usage.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add src/admission/usage.ts test/usage.test.ts
git commit -m "feat: 用量配对与节省字段"
```

---

### Task 22: 外部失效源与二次投影防护

**Files:**
- Create: `src/gate/invalidate.ts`, `test/invalidate.test.ts`
- Modify: `src/hooks/post-execute.ts`（调用失效检测与 `hasSpillNotice`）

**Interfaces:**
- Produces: `export interface PendingPlan { stepId: string; anchors: Record<string, string> }`（`anchors` = 候选引用的回执 id → 到达时的规范化原文）
- Produces: `export const PRUNE_MARKER = '[…pruned'`（与宿主 `dsh-compaction-tool-result-pruner` 的 marker 前缀一致）
- Produces: `export function looksPruned(text: string): boolean`
- Produces: `export function alreadySpilled(text: string, hasNotice: (t: string) => boolean): boolean`
- Produces: `export function invalidate(pending: PendingPlan | undefined, receiptText: string): 'pruned-reset' | 'compaction-reset' | undefined`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { looksPruned, alreadySpilled, invalidate } from '../src/gate/invalidate.ts'

test('识别宿主 pruner 的截断标记', () => {
  assert.equal(looksPruned('head\n[…pruned 4096 of 9000 chars…]\ntail'), true)
  assert.equal(looksPruned('plain output'), false)
})

test('已含 spill 页脚的回执不再二次投影', () => {
  assert.equal(alreadySpilled('x', () => true), true)
  assert.equal(alreadySpilled('x', () => false), false)
})

test('锚点回执被 pruner 改写判 pruned-reset', () => {
  const pending = { stepId: 'A', anchors: { A: 'head\n[…pruned 1 of 2 chars…]' } } as any
  assert.equal(invalidate(pending, 'head\n[…pruned 1 of 2 chars…]'), 'pruned-reset')
})

test('锚点回执与实际不符判 compaction-reset', () => {
  const pending = { stepId: 'A', anchors: { A: 'original text' } } as any
  assert.equal(invalidate(pending, 'completely different'), 'compaction-reset')
})

test('无 pending 不触发', () => {
  assert.equal(invalidate(undefined, 'x'), undefined)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/invalidate.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`looksPruned` 只做前缀匹配（宿主改文案时退化为"检测不到"，方向是安全的多裁一次，不会误放行）。`invalidate`：待用锚点与当前回执文本不一致 → 先判 `looksPruned` 得 `pruned-reset`，否则 `compaction-reset`；`pending` 为空返回 `undefined`。`post-execute` 里在投影前调用，命中即清 pending 并写收据（**不读历史当前正文**，§5.2-7）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/invalidate.test.ts && npm test`
Expected: 全部 PASS

- [ ] **Step 5: 提交并推送**

```bash
git add src/gate/invalidate.ts test/invalidate.test.ts src/hooks/post-execute.ts
git commit -m "feat: 外部失效源检测与二次投影防护"
git push origin main
```
