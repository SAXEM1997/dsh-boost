# dsh-boost 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DSH 插件在工具回执进入上下文前做追加式投影、对只读三件套做确定性替换，按 raw token 记账。

**Architecture:** 一个 cordis 插件，挂 `tools/post-execute`（投影）、`tools/execute`（防篡改）、`llm/stream`（合成替换回合）与 `ctx.systemPrompt.section`（协议段）。纯函数层（截断、守卫、绑定、计划解析、准入）与宿主适配层（钩子、spill、scope 解析）分离，前者用 `node --test` 表驱动，后者用假宿主集成测试。

**Task Map:** 共 28 个任务——T1–T22 是单元层（每个都能独立 RED→GREEN），T23a/b/c 是装配层（协议层 / post-execute / llm-stream 三段，拆开是为了让每段能独立 RED→GREEN），T24–T26 是集成、降级与发布门。

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
- 提交信息**一律英文**，用 `feat:` / `test:` / `chore:` 前缀；每个 task 一次提交。
- 每个 task 稳定节奏：功能测试 GREEN → `REFACTOR`（无重构就写明「无需重构」）→ 全量 `npm test` → 提交；单文件 GREEN 不算完成。

## Review Focus

1. **空回执**（`text === ''`）——投影必须原样放行，不得产出"showing first 0 and last 0"这种空窗口页脚。（T4）
2. **纯 CJK / emoji 回执**——截断不得切开代理对，页脚字节数不等于字符数。（T4）
3. **模板指向不存在的图节点**（`after: "C"` 但图上只有 A、B）——判不可解析并回退，不得静默取 `root`。（T12；图节点存在性由 T15 `decide` 的 `receipts` 集合保证。）
4. **`scope.json` 被外部改成 version 1 或写坏**——只读降级到 `selected+[]`，不得覆盖原文件、不得抛错中断插件。（T8）
5. **同一 turn 第 9 次替换**——必须命中 `steps-exhausted` 回主模型，而不是继续替换。（T23c）

---

### Task 1: 插件骨架与加载

**Files:**
- Create: `package.json`, `tsconfig.json`, `cordis.patch.yml`, `LICENSE`（Apache-2.0 全文）, `NOTICE`（注明移植自 HarnessMM）, `README.md`（中文主）, `README.en.md`, `locale/zh.json`, `locale/en.json`, `scripts/.gitkeep`, `test/regression/.gitkeep`, `src/index.ts`, `src/types.ts`, `test/plugin-load.test.ts`, `.gitignore`

**Interfaces:**
- Produces: `export const name = 'dsh-boost'`；`export const inject = ['tools', 'llm', 'systemPrompt'] as const`；`export function apply(ctx: PluginContext, config: unknown): void`
- Produces: `export interface AgentLike { session: { header: { id: string; cwd: string } } }`（宿主 `Agent` 的最小投影）
- Produces: `src/types.ts` 的 `export interface PluginContext { logger: { info(msg: string): void; warn(msg: string): void }; on(event: string, handler: (...args: any[]) => unknown): void; tools: { register(def: unknown, opts?: { when?: (c: { agent: AgentLike; signal: AbortSignal }) => boolean | Promise<boolean> }): void; resolve(): readonly unknown[] }; llm: { stream(opts: GenerateOptions): AsyncIterable<StreamChunk> }; systemPrompt: { section(s: { name: string; order: number; text: string | ((c: { scope?: unknown }) => string); interpolate?: boolean }): void }; get<T = unknown>(name: string): T | undefined }`
- Produces: `src/types.ts` 的 `export type ToolFamily = 'read' | 'grep' | 'glob' | 'bash' | 'ssh'`、`export interface BoostConfig { projection: Record<ToolFamily, ProjectionParams>; admission: { thresholdTokens: number }; selector: { maxTokens: number }; stepsPerTurn: number; horizonSteps: number; historyTurns: number }`、`export interface ProjectionParams { triggerChars: number; headChars: number; tailChars: number }`
- Produces: `src/types.ts` 的 `declare module '@deepseek-ai/dsh-llm/types' { interface LlmRequestPurposeMap { 'boost-selector': true } }`（T14 的 `purpose` 靠它通过编译）

- [ ] **Step 1: 写失败的加载测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as plugin from '../src/index.ts'

test('插件导出 cordis 需要的元数据', () => {
  assert.equal(plugin.name, 'dsh-boost')
  assert.deepEqual([...plugin.inject], ['tools', 'llm', 'systemPrompt'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply 接受 ctx 与 config 两个参数', () => {
  assert.equal(plugin.apply.length, 2)
})

test('patch 行的 id/name 与 plugin.name、包名三者一致（R50）', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const yml = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const rowId = yml.match(/^\s*-\s*id:\s*['"]?([^'"\s]+?)['"]?\s*$/m)?.[1]
  const rowName = yml.match(/^\s*name:\s*['"]?([^'"\s]+?)['"]?\s*$/m)?.[1]
  assert.equal(plugin.name, 'dsh-boost')
  assert.equal(pkg.name, plugin.name)
  assert.equal(rowId, plugin.name)
  assert.equal(rowName, plugin.name)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/plugin-load.test.ts`
Expected: FAIL，`Cannot find module '../src/index.ts'`

- [ ] **Step 3: 建骨架**

`package.json` 逐字采用设计稿 §11 的块（含 `version: 0.1.0`、`exports`、`peerDependencies` + `peerDependenciesMeta.optional`、`engines.dsh`、`dsh.bundle.patch`），只补 `"scripts": { "build": "tsc -p tsconfig.json", "test": "node --import tsx --test \"test/**/*.test.ts\"" }` 与 `devDependencies: { typescript, tsx, @types/node }`。**glob 必须加引号**：不加引号时 sh 只展开单层，根目录测试会被漏跑。
**另需**：`peerDependencies` 与 `devDependencies` 都加上 `@deepseek-ai/dsh-llm`（`declare module` 合并与 T14 的 `GenerateOptions`/`StreamChunk` 类型都靠它；isolated 布局下缺它直接 TS2307）。源码内 import 一律用 `./x.js` 说明符——`module: NodeNext` 下写 `.ts` 会 TS5097、写裸 `./x` 会 TS2835，第一个跨模块 import 就会让 `npm run build` 失败。
`tsconfig.json`：`target: ES2023`、`module: NodeNext`、`strict: true`、`declaration: true`、`types: ["node"]`、`outDir: dist`、`rootDir: src`、`include: ["src"]`。`declaration` 缺失时 `prepublishOnly` 的 `test -f dist/index.d.ts` 必挂；`types: ["node"]` 让 `node:fs` / `Buffer` 通过编译。
`src/index.ts` 只导出上面三个符号；`apply` 暂为空函数体加 `ctx.logger?.info?.('dsh-boost loaded')`。
`cordis.patch.yml` 按 §5.3 的完整 config 面写，`maxInlineTokens` 不下发（那是宿主 spill 的键，不是本插件的）；行必须是 `- id: dsh-boost` + `name: 'dsh-boost'`（缺一个宿主就静默跳过，§11）。`README.md` 用中文写主文档、`README.en.md` 是英文对应版（§11.2）；`locale/zh.json` / `locale/en.json` 放配置项标题；`scripts/` 与 `test/regression/` 先放 `.gitkeep` 占位，由 T26 落内容。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/plugin-load.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 构建产物校验**

Run: `npm run build && test -f dist/index.d.ts && test -f dist/index.js`
Expected: exit 0（`declaration: true` 生效；`dist/` 被 `.gitignore` 忽略）

- [ ] **Step 6: 布置 remote**

Run:
```bash
git remote add origin https://gitlab.ai.isv.iridesc.cn:23000/zyx/dsh-boost.git
git remote -v
```
Expected: `origin` 指向内网镜像。开发期先推内网，GitHub 作为第二个 remote 后加（§11；不要先把 GitHub 设成 origin）。

- [ ] **Step 7: 重构**

无需重构（骨架任务，只有常量与测试）。若"读仓库文件"出现第二次，抽成 `readRepoFile(name)`。

- [ ] **Step 8: 全量测试**

Run: `npm test`
Expected: 全部 PASS（3 tests）

- [ ] **Step 9: 提交**

```bash
git add package.json tsconfig.json cordis.patch.yml LICENSE NOTICE README.md README.en.md locale/ scripts/ test/ src/ .gitignore
git commit -m "feat: scaffold plugin and load test"
```

---

### Task 2: 配置解析与缺键回落

**Files:**
- Create: `src/config.ts`, `test/config.test.ts`
- Modify: `src/index.ts`（在 `apply` 里调用 `resolveConfig`）

**Interfaces:**
- Consumes: `BoostConfig`、`ProjectionParams`、`PluginContext`（Task 1）
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

`src/index.ts` 的 `apply(ctx: PluginContext, config: unknown)` 里先 `const cfg = resolveConfig(config)`，再把 `cfg` 传给 T17 的 `registerHooks` 与 T19 的工具注册；`config` 就是 patch 的 `config`（整体替换，缺键逐键回落）。
`resolveConfig` 对 `projection` 的每个族逐键合并（`raw?.projection?.[family]?.triggerChars ?? DEFAULT...`），其余标量同理。非对象输入一律返回 `DEFAULT_CONFIG` 的深拷贝（`structuredClone`），避免调用方改写默认值。**不做校验抛错**——错配置退化为默认值是这里要的行为。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/config.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；逐键回落的重复表达式抽成 `pick` 辅助。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/config.ts src/index.ts test/config.test.ts
git commit -m "feat: config resolution with per-key fallback"
```

---

### Task 3: 回执规范化

**Files:**
- Create: `src/projection/canonicalise.ts`, `test/canonicalise.test.ts`

**Interfaces:**
- Produces: `export interface CanonicalReceipt { text: string; isError: boolean; empty: boolean; textBlocks: number }`；`export function canonicalise(blocks: ReadonlyArray<{ type: string; text?: string }>, isError: boolean): CanonicalReceipt`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalise } from '../src/projection/canonicalise.ts'

test('多个 text block 按顺序拼成一个字符串', () => {
  const r = canonicalise([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], false)
  assert.equal(r.text, 'ab')
  assert.equal(r.textBlocks, 2)
})

test('非 text block 被跳过，图片不参与规范化', () => {
  const r = canonicalise([{ type: 'text', text: 'x' }, { type: 'image' }, { type: 'text', text: 'y' }], false)
  assert.equal(r.text, 'xy')
  assert.equal(r.textBlocks, 2)   // 不是 blocks.length（= 3）
})

test('空回执标记 empty', () => {
  assert.equal(canonicalise([], false).empty, true)
  assert.equal(canonicalise([], false).textBlocks, 0)
  assert.equal(canonicalise([{ type: 'text', text: '' }], false).empty, true)
  assert.equal(canonicalise([{ type: 'text', text: ' ' }], false).empty, false)
})

test('isError 透传', () => {
  const r = canonicalise([{ type: 'text', text: 'boom' }], true)
  assert.equal(r.isError, true)
  assert.equal(r.textBlocks, 1)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/canonicalise.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

按顺序 `filter(type === 'text')` 后 `map(b => b.text ?? '').join('')`；`textBlocks` = **过滤后的元素个数**（不是入参 `blocks.length`，图片等非 text block 不计）；`empty = text.length === 0`。**不做 trim**：规范化文本要逐字可比对。不做任何转义或截断。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/canonicalise.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；单函数，无可抽取点。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/projection/canonicalise.ts test/canonicalise.test.ts
git commit -m "feat: canonicalise tool receipts"
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

test('阈值按 code point 比较，不按 UTF-16 长度（边界）', () => {
  // 1600 个 emoji：code point 1600 < 3000，UTF-16 units 3200 > 3000
  assert.equal(shouldTruncate('😀'.repeat(1600), READ), false)
  // 若按 text.length 比较会误裁，且头 2000 + 尾 500 会把 1600 个全吃进去，
  // 产出比原文更长的回执与负数的 omitted 计数
  assert.equal(truncate('😀'.repeat(1600), READ), null)
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

用 `Array.from(text)` 转 code point 数组后再切（`const cp = Array.from(text)`），`head = cp.slice(0, headChars).join('')`、`tail = cp.slice(-tailChars).join('')`。`omittedCodePoints = cp.length - headChars - tailChars`；`omittedBytes = Buffer.byteLength(head + tail, 'utf8')` 之差——正确写法是 `Buffer.byteLength(text,'utf8') - Buffer.byteLength(head,'utf8') - Buffer.byteLength(tail,'utf8')`。`shouldTruncate` 先比 `text.length` 做**粗筛**（UTF-16 长度 ≥ code point 长度，只用来快速排除），粗筛通过后再用 `Array.from(text).length > triggerChars` 精确判定——**绝不能用 `text.length` 直接当阈值**，否则短 emoji 串会被误裁并产出负的 `omitted` 计数；**`Buffer.byteLength(text, 'utf8') > 256 * 1024` 直接返回 `false`**（§5.4，大回执不投影；按 UTF-8 字节计，不用 `text.length` 的 UTF-16 单元数——否则 CJK/emoji 的阈值会差一倍以上），并加一条 emoji 边界测试。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/truncate.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；code point 切片与字节差各抽一个小函数。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/projection/truncate.ts test/truncate.test.ts
git commit -m "feat: truncation window and footer head line"
```

---

### Task 5: 投影执行——影子模式

**Files:**
- Create: `src/projection/apply.ts`, `test/projection-shadow.test.ts`

**Interfaces:**
- Consumes: `truncate`/`shouldTruncate`/`renderHeadLine`（T4）、`BoostConfig`/`ToolFamily`（T1）
- Produces: `export type ProjectionMode = 'off' | 'shadow' | 'on'`
- Produces: `export interface ProjectionOutcome { kind: 'skipped' | 'shadow' | 'applied'; reason?: string; before?: number; after?: number; saved?: number }`
- Produces: `export async function projectShadow(input: { text: string; isError: boolean; family: ToolFamily; cfg: BoostConfig; estimate: (s: string) => number }): Promise<ProjectionOutcome>`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { projectShadow } from '../src/projection/apply.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'

const estimate = (s: string) => Math.ceil(s.length / 4)

test('影子模式不改动文本，只报前后 token', async () => {
  const text = 'x'.repeat(20000)
  const o = await projectShadow({ text, isError: false, family: 'read', cfg: DEFAULT_CONFIG, estimate })
  assert.equal(o.kind, 'shadow')
  assert.equal(o.before, 5000)
  assert.ok(o.after! < o.before!)
  assert.equal(o.saved, o.before! - o.after!)
})

test('未配置的工具族直接跳过', async () => {
  const o = await projectShadow({ text: 'x'.repeat(9999), isError: false, family: 'web_fetch' as never, cfg: DEFAULT_CONFIG, estimate })
  assert.equal(o.kind, 'skipped')
  assert.equal(o.reason, 'family-not-configured')
})

test('错误回执不裁剪、不记账（R24）', async () => {
  const o = await projectShadow({ text: 'x'.repeat(20000), isError: true, family: 'read', cfg: DEFAULT_CONFIG, estimate })
  assert.deepEqual(o, { kind: 'skipped', reason: 'error-receipt' })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/projection-shadow.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

入口第一判 `isError` → `{ kind: 'skipped', reason: 'error-receipt' }`（错误回执原样进历史，§5.4-4）。`projectShadow` 只读文本、算两份估计，**不触碰 content**（§5.4：shadow 不落盘、不依赖 spillStore）。`after` 的估计对象是"头行 + head + 省略说明 + tail"的拼接串，用同一个 `estimate`。未配置族返回 `{ kind: 'skipped', reason: 'family-not-configured' }`。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/projection-shadow.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；两次 `estimate` 调用收成一次成对估计。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/projection/apply.ts test/projection-shadow.test.ts
git commit -m "feat: shadow-mode projection accounting"
```

---

### Task 6: 投影执行——真替换（spill 落盘 + 页脚）

**Files:**
- Modify: `src/projection/apply.ts`
- Create: `test/projection-apply.test.ts`

**Interfaces:**
- Consumes: `truncate`/`renderHeadLine`（T4）、`ProjectionOutcome`（T5）
- Produces: `export interface SpillHandle { locator: string; retrievalHint: string }`
- Produces: `export interface SpillBackend { saveText(input: { owner: { sessionId: string }; source: { kind: 'tool'; toolName: string; callId: string; label: string }; suggestedName: string; content: string }): Promise<SpillHandle> }`（`callId` / `label` **必填**，对齐宿主 `SaveTextSpill` 的真实形状）
- Produces: `export async function projectApply(input: { text: string; isError: boolean; family: ToolFamily; cfg: BoostConfig; sessionId: string | undefined; toolName: string; callId?: string; label?: string; spill: SpillBackend | undefined; formatFooter: ((o: { kind: 'exact'; count: number }, ref: SpillHandle) => string) | undefined }): Promise<{ content: string; outcome: ProjectionOutcome }>`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { projectApply } from '../src/projection/apply.ts'
import { truncate } from '../src/projection/truncate.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'

const spill = { saveText: async () => ({ locator: '/spill/read-1.txt', retrievalHint: 'Use read with offset/limit' }) }
const footer = (o: { count: number }, ref: { locator: string }) =>
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/projection-apply.test.ts`
Expected: FAIL，`projectApply is not a function`

- [ ] **Step 3: 实现**

入口第一判 `isError` → `{ kind: 'skipped', reason: 'error-receipt' }`（错误回执必须原样进历史，§5.4-4）；`shouldTruncate` 为假 → `{kind:'skipped'}`；缺 `spill` → `no-spill`；缺 `sessionId` → `no-owner`；缺 `formatFooter` → `projection-skipped:no-footer`（**不落盘**）。都过了才在 try/catch 里 `await saveText({ owner, source: { kind: 'tool', toolName, callId, label }, suggestedName, content: text })`（**存规范化原文，不是投影后文本**，§5.4）；`saveText` 抛错 → 原样返回 `{ content: text, outcome: { kind: 'skipped', reason: 'spill-failed' } }`，不得让异常冒到 `post-execute`。成功后再拼 `renderHeadLine + head + footer + tail`。`source.callId` / `source.label` 必填，缺省用 `callId = toolName`、`label = family` 兜底。`formatFooter` 由调用方动态导入宿主函数（T17/T25 接），这里只收函数，不 import——保证纯函数可测。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/projection-apply.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；前置条件按序抽成 `precheck`，主函数只留编排。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/projection/apply.ts test/projection-apply.test.ts
git commit -m "feat: apply projection with spill persistence"
```

---

### Task 7: 收据存储

**Files:**
- Create: `src/receipts/store.ts`, `test/receipts.test.ts`

**Interfaces:**
- Produces: `export type ReceiptKind = 'substitute' | 'substitute-settled' | 'shadow' | 'projection' | 'skip' | 'reset'`
- 不变量：`kind === 'projection'` 的收据**必带** `unit: 'raw'` 字面量（T19/T26 按它过滤）
- Produces: `export interface Receipt { version: 1; ts: string; sessionId: string; turn: number; stepId?: string; kind: ReceiptKind; code: string; tool?: string; receipt_hash: string; preview: string; [k: string]: unknown }`
- Produces: `export function receiptHash(r: { sessionId: string; turn: number; stepId?: string; tool?: string; args?: unknown }): string`——`sha256(稳定 JSON)` 的十六进制前 16 位
- Produces: `export class ReceiptStore { constructor(root: string, opts?: { fsyncEveryLines?: number; maxBytes?: number; maxLines?: number }); append(r: Receipt): Promise<void>; flush(): Promise<void>; count(sessionId: string): Promise<number>; scan(sessionId?: string): AsyncIterable<Receipt>; failures(): number; stopped(): boolean }`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReceiptStore, receiptHash } from '../src/receipts/store.ts'

const rec = (sessionId: string, over: any = {}): any => ({
  version: 1, ts: '2026-11-19T00:00:00.000Z', sessionId, turn: 1,
  stepId: 'A', tool: 'read', kind: 'shadow', code: 'ok', preview: 'x', ...over,
})

test('按 session 分片写入，补齐 version/hash/preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boost-'))
  const s = new ReceiptStore(root)
  await s.append(rec('a'))
  await s.append(rec('b'))
  const a = await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')
  assert.equal(a.trim().split('\n').length, 1)
  const line = JSON.parse(a.trim())
  assert.equal(line.version, 1)
  assert.equal(line.receipt_hash, receiptHash({ sessionId: 'a', turn: 1, stepId: 'A', tool: 'read', args: {} }))
})

test('preview 截到 256 code point', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boost-'))
  const s = new ReceiptStore(root)
  await s.append(rec('a', { preview: '😀'.repeat(300) }))
  const line = JSON.parse((await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')).trim())
  assert.equal(Array.from(line.preview).length, 256)
})

test('count 与 scan 可读回，scan(undefined) 跨会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boost-'))
  const s = new ReceiptStore(root)
  await s.append(rec('a')); await s.append(rec('a')); await s.append(rec('b'))
  assert.equal(await s.count('a'), 2)
  const rows: any[] = []
  for await (const r of s.scan('a')) rows.push(r)
  assert.equal(rows.length, 2)
  const all: any[] = []
  for await (const r of s.scan()) all.push(r)
  assert.equal(all.length, 3)
})

test('连续 连续 3 次写失败后停止替换（成功一次即清零）（fail-closed）', async () => {
  const s = new ReceiptStore('/proc/definitely-not-writable')
  for (let i = 0; i < 3; i++) await s.append(rec('a'))
  assert.equal(s.failures(), 3)
  assert.equal(s.stopped(), true)
  // 成功一次即清零，不能是"累计 3 次"
  const ok = new ReceiptStore(await mkdtemp(join(tmpdir(), 'boost-')))
  await ok.append(rec('a')); await ok.append(rec('a'))
  assert.equal(ok.failures(), 0)
})

test('半行在读取时丢弃并从该偏移截断（R51）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boost-'))
  const s = new ReceiptStore(root)
  await s.append(rec('a'))
  await appendFile(join(root, 'receipts', 'a.jsonl'), '{"version":1,"half":')
  assert.equal(await s.count('a'), 1)
  const text = await readFile(join(root, 'receipts', 'a.jsonl'), 'utf8')
  assert.equal(text.endsWith('\n'), true)
  assert.equal(text.includes('"half"'), false)
})

test('超限轮转保留当前 + .1 两份（R47）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boost-'))
  const s = new ReceiptStore(root, { maxBytes: 400, maxLines: 4 })
  for (let i = 0; i < 9; i++) await s.append(rec('a', { turn: i }))
  // 只保留当前 + .1 两份、maxLines=4 ⇒ 最多能读回 8 行；要求 9 行会逼实现违反保留策略
  assert.ok(await s.count('a') <= 8)
  await stat(join(root, 'receipts', 'a.1.jsonl'))
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/receipts.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

路径 `<root>/receipts/<sessionId>.jsonl`；`append` 先补齐 `version` / `receipt_hash` / `preview`（`Array.from(s).slice(0, 256).join('')`，**不存全文**）再落一行。`receiptHash` 对 `{ sessionId, turn, stepId, tool, args }`（`args` 用稳定序列化，键排序）求 sha256，取前 16 位十六进制——**漏了 args 会让同一 turn 同名工具的不同调用撞 hash**。fsync **不每行做**：每 `fsyncEveryLines`（默认 100）行或显式 `flush()`（**每 turn 结束**由 T17/T23c 调用）时 `open(f).sync()`。捕获异常→`failures++`、内存缓冲、返回；不抛给调用方。`stopped()` 当 `failures >= 3`。单文件超 8 MiB 或 20,000 行时轮转：当前文件改名 `<sessionId>.1.jsonl`（已有的 `.1` 覆盖，**只保留当前 + .1 共 2 个**），再新建当前文件。`count` / `scan` 按 `.1` → 当前的顺序读；遇到**不以 `\n` 结尾的尾行**即丢弃并从该偏移截断文件；`scan(sessionId?)` 省略参数时遍历 `receipts/` 下所有分片。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/receipts.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；行序列化与 hash 计算抽成纯函数。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/receipts/store.ts test/receipts.test.ts
git commit -m "feat: sharded receipt store with circuit breaker"
```

---

### Task 8: scope 文档模型

**Files:**
- Create: `src/scope/doc.ts`, `test/scope-doc.test.ts`

**Interfaces:**
- Consumes: `ProjectionMode`（T5）
- Produces: `export type ScopeCode = 'ERR_SCOPE_UNKNOWN_VERSION' | 'ERR_SCOPE_FUTURE_VERSION' | 'ERR_SCOPE_PARSE_FAILED' | 'ERR_SCOPE_READ_FAILED' | 'ERR_SCOPE_REVISION_CONFLICT' | 'ERR_SCOPE_LOCKED'`
- Produces: 六个 `export const ERR_SCOPE_UNKNOWN_VERSION` / `ERR_SCOPE_FUTURE_VERSION` / `ERR_SCOPE_PARSE_FAILED` / `ERR_SCOPE_READ_FAILED` / `ERR_SCOPE_REVISION_CONFLICT` / `ERR_SCOPE_LOCKED` 常量（值等于上面的字符串，T9 用）
- Produces: `export interface ScopeDoc { version: 2; revision: number; updatedAt?: string; mode: 'selected' | 'global'; workspaceIds: string[]; shadow: boolean; projection: ProjectionMode }`
- Produces: `export const DEFAULT_SCOPE: ScopeDoc`（`selected + []`，`shadow: true`，`projection: 'shadow'`）
- Produces: `export function parseScope(raw: unknown): { doc: ScopeDoc; code?: 'ERR_SCOPE_UNKNOWN_VERSION' | 'ERR_SCOPE_PARSE_FAILED' }`
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
  assert.equal(r.code, 'ERR_SCOPE_UNKNOWN_VERSION')
  assert.deepEqual(r.doc, DEFAULT_SCOPE)
})

test('非对象 / 数组 / null 判 parse-failed；对象但 version≠2 判 unknown-version（R12）', () => {
  for (const raw of ['not an object', null, [], 42]) {
    assert.equal(parseScope(raw).code, 'ERR_SCOPE_PARSE_FAILED')
  }
  assert.equal(parseScope({ version: 2.1 }).code, 'ERR_SCOPE_FUTURE_VERSION')
  assert.equal(parseScope({ version: '3' }).code, 'ERR_SCOPE_UNKNOWN_VERSION')
  assert.equal(parseScope({ mode: 'global' }).code, 'ERR_SCOPE_UNKNOWN_VERSION')
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

`parseScope` 先做**类型定界**：`raw === null || typeof raw !== 'object' || Array.isArray(raw)` → `{ doc: structuredClone(DEFAULT_SCOPE), code: 'ERR_SCOPE_PARSE_FAILED' }`；是对象但 `version !== 2`（含缺 version）→ `{ doc: structuredClone(DEFAULT_SCOPE), code: 'ERR_SCOPE_UNKNOWN_VERSION' }`；只有 `version === 2` 才读其余字段。`mode` 非 `'selected' | 'global'` 时按 `'selected'`、`workspaceIds` 非数组时按 `[]`（更严的一侧）。`isVisible`：`workspaceId === undefined` 一律 false（无 scope = 全局视图 = 不注入，§5.5）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/scope-doc.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；分支定界写成常量表，不散在 if 里。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/scope/doc.ts test/scope-doc.test.ts
git commit -m "feat: scope document model and strict ordering"
```

---

### Task 9: scope 存储（mtime+revision 缓存、锁、原子写）

**Files:**
- Create: `src/scope/store.ts`, `test/scope-store.test.ts`

**Interfaces:**
- Consumes: `ScopeDoc`、`parseScope`、`ERR_SCOPE_*`（T8）
- Produces: `export class ScopeStore { constructor(dir: string); read(): Promise<{ doc: ScopeDoc; degraded?: 'scope-degraded'; code?: ScopeCode }>; write(mutate: (d: ScopeDoc) => ScopeDoc, baseRevision: number): Promise<ScopeDoc>; remember(key: string, visible: boolean): void; judgement(key: string, fallback?: boolean): boolean }`
- Produces: 写入失败抛出的 `Error` 带 `code` 属性（`ERR_SCOPE_LOCKED` / `ERR_SCOPE_REVISION_CONFLICT` / `ERR_SCOPE_READ_FAILED`），消息里带同一个码

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
  assert.equal(r.degraded, 'scope-degraded')
  assert.equal(r.code, 'ERR_SCOPE_READ_FAILED')
})

test('version 1 映射为 scope-degraded + ERR_SCOPE_UNKNOWN_VERSION（R34）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  await writeFile(join(dir, 'scope.json'), JSON.stringify({ version: 1, mode: 'global' }))
  const r = await new ScopeStore(dir).read()
  assert.equal(r.degraded, 'scope-degraded')
  assert.equal(r.code, 'ERR_SCOPE_UNKNOWN_VERSION')
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

`read`：`stat` 取 mtime + 读文件 → `parseScope`；缓存命中条件 = `mtime` 与 `revision` 都未变。`remember(key, visible)` / `judgement(key, fallback?)` 是**按 agent 键**（取 `agent.session.header.id`）的同步缓存：`resolveVisible`（异步，`when` 里用）算完就把结果 `remember` 进去；`systemPrompt.section` 的 provider 是同步的，只能读 `judgement(key)`，未命中返回 `fallback ?? false`（§5.5「同步读 `judgement ?? resolveNow`」）。**无参的全局 judgement 是错的**——它对所有 agent 返回同一个值。任何读取 / 解析失败都返回 `{ doc: DEFAULT_SCOPE 的深拷贝, degraded: 'scope-degraded', code }`，**不抛错、不覆盖原文件**；`code` 取 `parseScope` 给的码，读文件失败则 `ERR_SCOPE_READ_FAILED`。`write`：`open(lock,'wx')`（`await` 一次）→ 读 → 校验 `baseRevision` → `mutate` → `revision + 1` → **同步** `writeFileSync` 到临时文件 + `renameSync` → `unlink(lock)`。锁已存在时先判回收（`mtime > 60s` 且 pid 不存活），否则抛 `ERR_SCOPE_LOCKED`。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/scope-store.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；锁的获取与回收抽成 `acquireLock`。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/scope/store.ts test/scope-store.test.ts
git commit -m "feat: atomic scope writes with lock"
```

---

### Task 10: workspace 解析与 `when` 注册

**Files:**
- Create: `src/scope/resolve.ts`, `test/scope-resolve.test.ts`, `test/fakes/host.ts`

**Interfaces:**
- Consumes: `isVisible`（T8）、`ScopeStore`（T9）
- Produces: `export interface WorkspaceRegistry { list(): readonly { id: string; path: string }[]; resolveByPath?(path: string): Promise<{ id: string } | undefined> }`——**宿主只有同步 `list()` 与异步 `resolveByPath()`，没有 `byPath`**
- Produces: `export function workspaceIdOf(agent: { session?: { header?: { cwd?: string } } } | undefined, registry: WorkspaceRegistry | undefined): string | undefined`（`cwd` 经 `registry.list()` 按 `path` 精确匹配换成宿主 UUID；**不是路径本身**，也不 await——`systemPrompt` 装配是同步的。异步 `resolveByPath` 只用于预热缓存）
- Produces: `export async function resolveVisible(store: ScopeStore, agent: unknown, registry: WorkspaceRegistry | undefined): Promise<boolean>`
- Produces: `export function supportsStepWhen(tools: { resolve?: unknown }): boolean`——探测宿主 `ctx.tools.resolve` 是否可用（`typeof tools?.resolve === 'function'`）；为假时 T19 整族不注册
- Produces: `test/fakes/host.ts` 的 `export function fakeHost(overrides?: Record<string, unknown>): any`——**必须暴露**：`register/resolve/definitions`、`llm.stream`、`systemPrompt.section`、`tokenMeter`、`spillStore`、`callHook(name, args, next)`、`receipts: unknown[]`、`hooked(): string[]`、`section(name?): { text: (c: any) => string } | undefined`、`nextCalls: number`、`synthesized: number`、`stream(sessionId: string, options?: Partial<GenerateOptions>): AsyncIterable<StreamChunk>`、`lastStream(): AsyncIterable<StreamChunk> | undefined`、`visible(name: string, agent: AgentLike): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceIdOf, resolveVisible, supportsStepWhen } from '../src/scope/resolve.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScopeStore } from '../src/scope/store.ts'

test('cwd 经 registry 映射到 workspace UUID，不是路径本身（R10）', () => {
  const registry = { list: () => [{ id: 'ws-uuid-1', path: '/w/a' }] }
  assert.equal(workspaceIdOf({ session: { header: { cwd: '/w/a' } } }, registry), 'ws-uuid-1')
  assert.equal(workspaceIdOf({ session: { header: { cwd: '/w/b' } } }, registry), undefined)
  assert.equal(workspaceIdOf(undefined, registry), undefined)
  assert.equal(workspaceIdOf({ session: { header: { cwd: '/w/a' } } }, undefined), undefined)
})

test('无 agent 一律不可见', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  const registry = { list: () => [{ id: 'ws-uuid-1', path: '/w/a' }] }
  assert.equal(await resolveVisible(new ScopeStore(dir), undefined, registry), false)
})

test('global 模式下能解析出 UUID 即可见', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scope-'))
  const s = new ScopeStore(dir)
  await s.write(d => ({ ...d, mode: 'global' }), 0)
  const registry = { list: () => [{ id: 'ws-uuid-1', path: '/w/a' }] }
  assert.equal(await resolveVisible(s, { session: { header: { cwd: '/w/a' } } }, registry), true)
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

`workspaceIdOf` 读 `agent?.session?.header?.cwd`（`Session.header` 非可选，不套多余可选链），再 `registry?.list().find(w => w.path === cwd)?.id`；没有 registry 或查不到 → `undefined`（**不可见**）。`resolveVisible` 先取 doc 再 `isVisible(doc, workspaceIdOf(agent, registry))`，任何异常 → `false`。`supportsStepWhen` 只做 `typeof` 判断。`test/fakes/host.ts` 提供一个最小假宿主：记录 `register` 调用（含 `when`）、`resolve()` 返回已注册列表、`llm.stream` 可控返回。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/scope-resolve.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；本任务无可抽取的重复结构。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/scope/resolve.ts test/scope-resolve.test.ts test/fakes/host.ts
git commit -m "feat: workspace resolution and step-when probe"
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

用 `/<CHISEL_PLAN>([\s\S]*?)<\/CHISEL_PLAN>/` 取第一块；`JSON.parse` 失败 → `bad-json`；`steps` 非数组或某项缺 `id`/`tool`/`guards` → `bad-shape`。**只收字面量**：`args` 里出现非字面量结构（函数、`$eval` 等）→ `bad-shape`；`$public` 模板原样保留，校验交给 Task 12（绑定）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/plan.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；失败路径统一走 `fail(code)`。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/gate/plan.ts test/plan.test.ts
git commit -m "feat: plan parsing and trivial-guard detection"
```

---

### Task 12: `$public` 参数绑定

**Files:**
- Create: `src/gate/binding.ts`, `test/binding.test.ts`

**Interfaces:**
- Consumes: `CanonicalReceipt`（T3，含 `textBlocks`）
- Produces: `export type PublicTemplate = { $public: { after: 'root' | string; field: string } }`
- Produces: `export function isTemplate(v: unknown): v is PublicTemplate`
- Produces: `export function bindArgs(args: Record<string, unknown>, receipts: ReadonlyMap<string, CanonicalReceipt>): { ok: true; args: Record<string, unknown> } | { ok: false; reason: 'ambiguous' | 'unresolvable' | 'missing-receipt' | 'not-single-text' }`
- Produces: `export function extractField(text: string, field: string): string | undefined`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { bindArgs, extractField } from '../src/gate/binding.ts'

const r = (text: string) => ({ text, isError: false, empty: text.length === 0, textBlocks: 1 })

test('identifier 只认带引号的值；无引号判歧义（R29）', () => {
  assert.equal(extractField('garbage\nname: "abc"\n', 'name'), 'abc')
  assert.equal(extractField('name="abc"', 'name'), 'abc')
  assert.equal(extractField('name=abc', 'name'), undefined)
  const out = bindArgs({ p: { $public: { after: 'A', field: 'name' } } }, new Map([['A', r('name=abc')]]))
  assert.deepEqual(out, { ok: false, reason: 'ambiguous' })
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
  const m = new Map([['A', { text: 'x', isError: true, empty: false, textBlocks: 1 }]])
  const out = bindArgs({ p: { $public: { after: 'A', field: '$scalar' } } }, m)
  assert.deepEqual(out, { ok: false, reason: 'missing-receipt' })
})

test('回执不是单个 text block 时判 not-single-text（R40）', () => {
  const m = new Map([['A', { text: 'x', isError: false, empty: false, textBlocks: 2 }]])
  const out = bindArgs({ p: { $public: { after: 'A', field: '$scalar' } } }, m)
  assert.deepEqual(out, { ok: false, reason: 'not-single-text' })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/binding.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`extractField`：`$scalar` 用 `/^[A-Za-z0-9_+@.:/-]+$/` 对 trim 后全文；`$single` 用 `/^\['([^']*)'\]$/`；标识符用 `new RegExp(`(?:^|\n)\s*${escape(field)}\s*[:=]\s*"([^"\n]+)"`)` 全局匹配，**值必须带双引号**（`name=abc` 不匹配 → 0 个匹配 → 歧义）；**恰好 1 个**才算成功。`bindArgs` 递归替换模板；`after` 不在 `receipts` 里 → `unresolvable`；命中回执 `isError` 或 `empty` → `missing-receipt`；`textBlocks !== 1` → `not-single-text`（设计稿要求"成功且只有单个 text block"）；非模板值原样保留。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/binding.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；三个 field 分支各一个函数。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/gate/binding.ts test/binding.test.ts
git commit -m "feat: $public argument binding and uniqueness"
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

const r = (text: string, isError = false) => ({ text, isError, empty: text.length === 0, textBlocks: 1 })

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

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；本任务无可抽取的重复结构。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/gate/guard.ts test/guard.test.ts
git commit -m "feat: four guard evaluators"
```

---

### Task 14: 选择器（Jev）

**Files:**
- Create: `src/selector/jev.ts`, `test/jev.test.ts`

**Interfaces:**
- Consumes: 宿主 `llm`（`stream(opts: GenerateOptions): AsyncIterable<StreamChunk>`）；`LlmRequestPurposeMap` 的 `'boost-selector'` 声明合并（T1）
- Produces: `export interface LlmLike { stream(opts: GenerateOptions): AsyncIterable<StreamChunk> }`
- Produces: `export const SELECTOR_PURPOSE = 'boost-selector'`
- Produces: `export async function choose(input: { llm: LlmLike; provider: string; model: string; reasoningEffort?: string; candidates: { id: string; summary: string }[]; receiptText: string; maxTokens: number; timeoutMs?: number }): Promise<{ choice: string } | { abstain: 'timeout' | 'error' | 'no-label' }>`——**`provider`/`model` 是 `GenerateOptions` 的顶层字段，没有 `route` 嵌套**

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { choose, SELECTOR_PURPOSE } from '../src/selector/jev.ts'

const ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }

const llmOf = (chunks: string[], delay = 0) => ({
  async *stream(opts: any) {
    for (const c of chunks) { if (delay) await new Promise(r => setTimeout(r, delay)); yield { text: c } }
    return opts
  }
})

const cands = [{ id: 'A', summary: 'read /a' }, { id: 'B', summary: 'read /b' }]

test('单标签被解析为选择', async () => {
  const r = await choose({ llm: llmOf(['B']) as any, provider: 'deepseek', model: 'deepseek-chat', candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { choice: 'B' })
})

test('问号与其它字符一律 abstain:no-label', async () => {
  for (const s of ['?', 'AB', 'neither']) {
    const r = await choose({ llm: llmOf([s]) as any, provider: 'deepseek', model: 'deepseek-chat', candidates: cands, receiptText: 'x', maxTokens: 512 })
    assert.deepEqual(r, { abstain: 'no-label' })
  }
})

test('超时 abstain:timeout', async () => {
  const r = await choose({ llm: llmOf(['A'], 100) as any, provider: 'deepseek', model: 'deepseek-chat', candidates: cands, receiptText: 'x', maxTokens: 512, timeoutMs: 10 })
  assert.deepEqual(r, { abstain: 'timeout' })
})

test('调用抛错 abstain:error', async () => {
  const llm = { async *stream() { throw new Error('boom') } }
  const r = await choose({ llm: llm as any, provider: 'deepseek', model: 'deepseek-chat', candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.deepEqual(r, { abstain: 'error' })
})

test('stream 收到 purpose 与 route（R17）', async () => {
  let seen: any
  const llm = { async *stream(opts: any) { seen = opts; yield { type: 'text-delta', index: 0, text: 'B' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  await choose({ llm: llm as any, provider: 'p', model: 'm', candidates: cands, receiptText: 'x', maxTokens: 512 })
  assert.equal(seen.purpose, SELECTOR_PURPOSE)
  assert.equal(seen.provider, 'p'); assert.equal(seen.model, 'm')
  assert.equal(seen.maxTokens, 512)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/jev.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

调 `llm.stream({ provider, model, reasoningEffort, purpose: SELECTOR_PURPOSE, maxTokens, messages: [...] })`（provider/model 透传边界请求自身的值），`for await` 只累加 `{type:'text-delta'}` 的 `text`；遇到 `{type:'finish', reason:{kind:'error'|'aborted'}}` 记 `error`；`Promise.race` 加 20s 默认超时。只接受**恰好等于某个候选 id 的单字符**；`?` 或其它 → `no-label`。系统提示逐字限定"只允许输出一个候选标签或 `?`"。`purpose` 已在 T1 经 `LlmRequestPurposeMap` 声明合并；网关拒绝 `purpose` 时，回退到不带 `purpose` 的同一 provider/model 重试一次（§5.1）；`BoostConfig.selector` 只有 `maxTokens`，没有 `model`。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/jev.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；超时包装抽成 `withTimeout`。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/selector/jev.ts test/jev.test.ts
git commit -m "feat: single-label selector with cooperative timeout"
```

---

### Task 15: 替换决策编排

**Files:**
- Create: `src/gate/decide.ts`, `test/decide.test.ts`

**Interfaces:**
- Consumes: `parsePlan`/`isTrivial`（T11）、`bindArgs`（T12）、`evaluateAll`（T13）
- Produces: `export type Decision = { kind: 'commit'; candidateId: string; args: Record<string, unknown> } | { kind: 'ask-selector'; candidates: Candidate[] } | { kind: 'fallback'; code: string }`
- 影子语义：`decide(..., { shadow: true })` 时**跳过白名单过滤**（§5.2-5「影子期替换不设白名单，全量记账」）——否则 bash/ssh 的替换潜力在影子期永远记不到账，`shadow-report` 的按族命中率只有三件套。
- Produces: `export function decide(input: { plan: Plan; stepId: string; receipts: ReadonlyMap<string, CanonicalReceipt>; whitelist: ReadonlySet<string>; shadow?: boolean }): Decision`——**`shadow: true` 时跳过白名单过滤**（§5.2-5：影子期不设白名单、全量记账）

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { decide } from '../src/gate/decide.ts'

const rc = (t: string) => ({ text: t, isError: false, empty: false, textBlocks: 1 })
const plan = (cands: any[]) => ({ goal: 'g', steps: cands })
const WL = new Set(['read', 'grep', 'glob'])

test('唯一合格候选直接提交', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ text_contains: 'x' }] },
                { id: 'B', tool: 'read', args: { path: '/b' }, guards: [{ text_contains: 'nope' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]),
  })
  assert.equal(d.kind, 'commit')
  if (d.kind === 'commit') assert.deepEqual(d.args, { path: '/a' })
})

test('多候选且全合格 → ask-selector', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: '/a' }, guards: [{ text_contains: 'x' }] },
                { id: 'B', tool: 'read', args: { path: '/b' }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]),
  })
  assert.equal(d.kind, 'ask-selector')
})

test('非白名单工具即使守卫合格也淘汰（R1）', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'bash', args: { command: 'ls' }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]),
  })
  assert.deepEqual(d, { kind: 'fallback', code: 'tool-not-whitelisted' })
})

test('全部平凡守卫回退 guard-trivial（R13）', () => {
  const d = decide({ plan: plan([{ id: 'A', tool: 'read', args: {}, guards: [{ ok: true }] }]), stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]) })
  assert.deepEqual(d, { kind: 'fallback', code: 'guard-trivial' })
})

test('非平凡候选全部失败回退 no-candidate（R13）', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: { $public: { after: 'root', field: 'name' } } }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')]]),
  })
  assert.deepEqual(d, { kind: 'fallback', code: 'no-candidate' })
})

test('候选引用图上不存在的节点 C → fallback（R43）', () => {
  const d = decide({
    plan: plan([{ id: 'A', tool: 'read', args: { path: { $public: { after: 'C', field: '$scalar' } } }, guards: [{ text_contains: 'x' }] }]),
    stepId: 'root', whitelist: WL, receipts: new Map([['root', rc('x')], ['A', rc('y')], ['B', rc('z')]]),
  })
  assert.deepEqual(d, { kind: 'fallback', code: 'no-candidate' })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/decide.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

流程：① 白名单过滤 `whitelist.has(c.tool)`，全被滤掉 → `{ kind: 'fallback', code: 'tool-not-whitelisted' }`（非白名单候选永不提交，**不在派发路径补判**）；② 过滤平凡候选，若全部平凡 → `guard-trivial`；③ 逐个 `bindArgs`（失败即淘汰）→ `evaluateAll`（非 `pass` 淘汰），0 个 → `no-candidate`，1 个 → `commit`，≥2 个 → `ask-selector`。**不做**任何"猜一个"。`bindArgs` 的 `unresolvable` 同时覆盖"模板指向图上不存在的节点"——`receipts` 只含已发生的步骤。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/decide.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；过滤链改成数组组合，而非层层 if。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/gate/decide.ts test/decide.test.ts
git commit -m "feat: substitution decision pipeline"
```

---

### Task 16: 准入记账

**Files:**
- Create: `src/admission/ledger.ts`, `test/ledger.test.ts`

**Interfaces:**
- Consumes: 无跨任务符号；默认值来源见 `BoostConfig`（T1）
- Produces: `export function remainingSteps(input: { stepsSoFar: number[]; horizonSteps: number; historyTurns: number }): number`
- Produces: `export class StepBudget { constructor(max: number); take(): boolean; reset(): void; exhausted(): boolean; count(): number }`——**必须有 `reset()`**，否则插件生命周期单例会在 8 次普通请求后永久关闭替换
- Produces: `export function worthSubstituting(input: { savedTokens: number; overheadTokens: number; thresholdTokens: number; deterministicSingle: boolean }): boolean`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/ledger.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`remainingSteps`：`stepsSoFar.length < historyTurns` → `horizonSteps`（设计稿：不足 5 个 turn 直接用 20，**不拿短历史估均值**）；否则 `Math.min(horizonSteps, Math.round(mean))`，均值只取最后 `historyTurns` 个。`worthSubstituting`：`deterministicSingle || saved - overhead > threshold`。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/ledger.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；本任务无可抽取的重复结构。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/admission/ledger.ts test/ledger.test.ts
git commit -m "feat: admission accounting and per-turn step budget"
```

---

### Task 17: 钩子装配（post-execute / llm-stream / execute / systemPrompt）

**Files:**
- Create: `src/hooks/post-execute.ts`, `test/hooks.test.ts`
- Modify: `src/index.ts`, `test/fakes/host.ts`
- 注意：`src/hooks/llm-stream.ts` 由 **T23c** 创建（本任务只做 `llm/stream` 的第一行 selector 放行占位，直接写在 `post-execute.ts` 的 `registerHooks` 里；T23c 再把钩子体抽到独立文件）

**Interfaces:**
- Consumes: `canonicalise`（T3）、`projectApply`/`projectShadow`（T5/T6）、`ReceiptStore`（T7）、`ScopeStore`/`resolveVisible`（T9/T10）、`SELECTOR_PURPOSE`（T14）
- Produces: `export function registerHooks(ctx: PluginContext, deps: { config: BoostConfig; scope: ScopeStore; receipts: ReceiptStore }): void`（**T23b 会把 `deps` 扩成 `HookDeps`**，新字段全部可选或由 T23c 的生产装配注入，T17 的测试不需要改）

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeHost } from './fakes/host.ts'
import { registerHooks } from '../src/hooks/post-execute.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { DEFAULT_SCOPE } from '../src/scope/doc.ts'
import { SELECTOR_PURPOSE } from '../src/selector/jev.ts'

const setup = (over: any = {}) => {
  const host = fakeHost()
  const deps = {
    config: DEFAULT_CONFIG,
    scope: over.scope ?? { read: async () => ({ doc: { ...DEFAULT_SCOPE, mode: 'global' } }) },
    receipts: { append: async (r: any) => { host.receipts.push(r) } },
  }
  registerHooks(host, deps as any)
  return { host, deps }
}

test('registerHooks 真的注册了四个挂载点（R4）', () => {
  const { host } = setup()
  assert.deepEqual(host.hooked().sort(), ['llm/stream', 'systemPrompt', 'tools/execute', 'tools/post-execute'])
  const s = host.section('dsh-boost')
  assert.equal(s.order, 100)
  assert.equal(s.interpolate, false)
})

test('llm/stream 见到 selector 标记直接放行（不合成回合）', async () => {
  const { host } = setup()
  const opts = { purpose: SELECTOR_PURPOSE, messages: [] }
  const out = await host.callHook('llm/stream', [opts], async () => 'PASSTHROUGH')
  assert.equal(out, 'PASSTHROUGH')
})

test('post-execute 对未配置族原样返回', async () => {
  const { host } = setup()
  const res = await host.callHook('tools/post-execute', [{ name: 'web_fetch', agent: undefined }, { content: [{ type: 'text', text: 'x'.repeat(5000) }] }], async () => ({ kind: 'accept' }))
  assert.equal(res.kind, 'accept')
})

test('缺 agent 时不投影，记 skip:no-scope', async () => {
  const { host } = setup()
  await host.callHook('tools/post-execute', [{ name: 'read', agent: undefined }, { content: [{ type: 'text', text: 'x'.repeat(5000) }] }], async () => ({ kind: 'accept' }))
  assert.ok(host.receipts.some((r: any) => r.code === 'skip:no-scope'))
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/hooks.test.ts`
Expected: FAIL，`fakeHost` 未接钩子

- [ ] **Step 3: 实现**

`registerHooks(ctx, deps)` 从 `src/hooks/post-execute.ts` 导出（**T23b 扩展 `deps`、T23c 补第三条钩子**），本任务注册四件事：① `ctx.on('tools/post-execute', ...)`，顺序严格为 `canonicalise →（替换决策占位）→ 投影 → 返回 decision`，`exec.agent` 为空时直接 `next()` 并写 `skip:no-scope` 收据；② `ctx.on('llm/stream', ...)`，第一行 `opts?.purpose === SELECTOR_PURPOSE → next()`；③ `ctx.on('tools/execute', ...)` 先注册**直通占位**（T18 换成 `rejectIfTampered`）；④ `ctx.systemPrompt.section({ name: 'dsh-boost', order: 100, text: (c) => (c.scope && deps.scope.judgement(agentKeyOf(c.scope)) ? PLACEHOLDER_TEXT : '')
// PLACEHOLDER_TEXT = ''（T17 先占位，T20 换成 PROTOCOL_TEXT）；agentKeyOf(c) 读 (c as AgentLike).session.header.id, interpolate: false })`——**`text` 必须是函数形式**（宿主 `PromptSection.text: string | ((c: AssembleContext) => string)`，接一个静态字符串就等于对所有会话无条件注入、违反 G3）；provider 是**同步**的，只能读 `judgement` 缓存，不能 await。T17 先用占位常量，T20 换成 `PROTOCOL_TEXT`。注册本身必须在 T17 完成且可断言。`fakeHost` 增加 `callHook(name, args, next)`、`receipts` 数组、`hooked()`、`section(name)` 与 `when` 注册捕获——瀑布钩子统一按"先参数数组、后 next"调用。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/hooks.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；四个注册块各一个函数，`registerHooks` 只做编排。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/hooks/ test/hooks.test.ts test/fakes/host.ts src/index.ts
git commit -m "feat: wire the four hook mount points"
```

---

### Task 18: 派发防篡改

**Files:**
- Create: `src/hooks/execute.ts`, `test/execute.test.ts`
- Modify: `src/hooks/post-execute.ts`（把 T17 的 `tools/execute` 直通占位换成 `rejectIfTampered`）

**Interfaces:**
- Consumes: 无跨任务符号；pending 只按结构类型 `{ name: string; args: Record<string, unknown> }` 读取（与 T23a 的 `PendingEntry` 结构兼容，但不 import，避免前向引用）
- Produces: `export function sameLiteral(a: unknown, b: unknown): boolean`；`export function rejectIfTampered(exec: { name: string; arguments: unknown }, pending: { name: string; args: Record<string, unknown> } | undefined): { reject: true; code: 'dispatch-rejected' } | { reject: false }`

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

`sameLiteral` 递归比较：对象比键集合与每键递归，数组按序，标量 `Object.is`。`rejectIfTampered` 只比对 `name` 与 `arguments`；不一致返回 `dispatch-rejected`。**本函数不清 pending**——它拿不到队列，清理由 `registerHooks` 在收到 reject 后做（**T23b 接线**）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/execute.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；本任务无可抽取的重复结构。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/hooks/execute.ts test/execute.test.ts
git commit -m "feat: dispatch tamper check"
```

---

### Task 19: `boost` 工具与状态输出

**Files:**
- Create: `src/tools/boost.ts`, `test/boost-tool.test.ts`
- Modify: `src/index.ts`（在 `apply` 里 `ctx.tools.register(...)`，带 `when`）

**Interfaces:**
- Consumes: `ScopeStore`（T9）、`ReceiptStore`（T7）、`supportsStepWhen`（T10）、`ProjectionMode`（T5）
- Produces: `export interface BoostStatus { scope: { mode: string; workspaceIds: string[]; revision: number }; shadow: boolean; projection: ProjectionMode; saved: { substitution: number; projectionGross: number; projectionNet: number; retrievals: number }; counts: Record<string, number>; degraded: string[] }`
- Produces: `export async function runBoost(input: { args: { cmd: 'status' | 'scope-get' | 'scope-set' | 'shadow'; body?: unknown; baseRevision?: number }; scope: ScopeStore; receipts: ReceiptStore }): Promise<{ ok: true; data: unknown } | { ok: false; code: string }>`
- Produces: `export function boostTool(deps: { scope: ScopeStore; receipts: ReceiptStore }): { name: 'boost'; description: string; parameters: unknown; output: { schema: unknown; render: (args: unknown, value: unknown) => { type: 'text'; text: string }[] }; execute: (args: unknown, exec: unknown) => Promise<unknown> }`——`output` 与 `render` 是宿主工具定义的必填字段，缺了注册不合法；`render` 把 `{ ok, data }` 渲成一个 text block

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBoost, boostTool } from '../src/tools/boost.ts'
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

test('工具定义带宿主必填的 output.render（R32）', async () => {
  const d = await deps()
  const def = boostTool(d)
  assert.equal(def.name, 'boost')
  assert.equal(typeof def.output.render, 'function')
  const blocks = def.output.render({ cmd: 'status' }, { ok: true, data: { shadow: true } })
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /shadow/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/boost-tool.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

四个子命令；`scope-set` 先 `validate → prune → write`，把 `ScopeStore.write` 的错误码原样透出（`ERR_SCOPE_REVISION_CONFLICT` / `ERR_SCOPE_LOCKED`）。`status` 扫收据聚合三类计数与两组账，`degraded` 收集稳定码 `ERR_HOST_NO_SPILL` / `ERR_HOST_NO_TOKENMETER` / `scope-degraded`（T25 再补 `ERR_HOST_PLATFORM_UNSUPPORTED` / `ERR_HOST_NO_STEP_WHEN`）。工具注册用 `ctx.tools.register(def, { when })`；`supportsStepWhen` 为假时**整族不注册**并 `ctx.logger.warn('ERR_HOST_NO_STEP_WHEN')`；`boost` 自身**豁免 scope**（`when: () => true`），但协议段不豁免。
工具定义由 `boostTool(deps)` 产出：除 `name` / `description` / `parameters` / `execute` 外，必须带宿主必填的 `output: { schema, render }`；`render(_args, value)` 把 `{ ok, data }` 序列化为 `[{ type: 'text', text: JSON.stringify(value) }]`。注册用 `ctx.tools.register(boostTool(deps), { when: () => true })`。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/boost-tool.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；子命令表驱动，`status` 的聚合单独一个函数。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交并推送**

```bash
git add src/tools/boost.ts test/boost-tool.test.ts src/index.ts
git commit -m "feat: boost tool and status aggregation"
git push origin main   # remote 由 T1 布置（内网镜像）；GitHub 作为第二个 remote 后加
```

---

### Task 20: 协议段文本与回合时钟

**Files:**
- Create: `src/prompt/protocol.ts`, `src/hooks/clock.ts`, `test/protocol.test.ts`
- Modify: `src/hooks/post-execute.ts`（把 T17 的 `text: ''` 占位换成 `PROTOCOL_TEXT`）

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

`PROTOCOL_TEXT` 用纯字符串模板写死四段：①计划格式（`<CHISEL_PLAN>` 内的 `goal` + `steps`，每步 `id`/`tool`/`args`/`guards`）；②允许的工具只有 `read`/`grep`/`glob`（其余写了也不会被替换）；③`$public` 三种取法；④"守卫失败即回主模型"的后果声明。**不得包含 `{{`**——协议段以 `interpolate: false` 注入，但保持字面量干净便于日后放松。落文本的同时，在 `src/hooks/post-execute.ts` 把 T17 的 `text: ''` 占位替换为 `text: PROTOCOL_TEXT`（`name` / `order` / `interpolate` 三处不变）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/protocol.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；本任务无可抽取的重复结构。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/prompt/protocol.ts src/hooks/clock.ts src/hooks/post-execute.ts test/protocol.test.ts
git commit -m "feat: plan protocol section and turn clock"
```

---

### Task 21: 用量配对（`saved_input_tokens` / `cache_hit_delta`）

**Files:**
- Create: `src/admission/usage.ts`, `test/usage.test.ts`

**Interfaces:**
- Produces: `export interface Usage { input: number; cacheRead: number; output: number }`
- Produces: `export class UsageLedger { request(u: Usage): void; last(): Usage | undefined; markSubstituted(candidateId: string): void; settle(): { saved_input_tokens: number | 'unknown'; cache_hit_delta: number | null; output_tokens: number | 'unknown' } }`
- 注意：`Usage` 由 `llm/stream` 的 `{type:'usage'}` chunk 映射（`inputTokens`/`cacheReadTokens`/`outputTokens`），`GenerateOptions` 里没有 usage

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/usage.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

只保留"上一次请求"与"待配对标记"两个槽位（不建全表，YAGNI）。**usage 的来源是 `llm/stream` 的 `{type:'usage'}` chunk，不是 `GenerateOptions`**——调用方把 `chunk.usage` 里的 `inputTokens`/`cacheReadTokens`/`outputTokens` 映射成 `Usage` 再 `request()`。`settle()` 消费并清空。`output` 是**第三类计数**：`output_tokens` 取后一次请求的 `output`，缺失记 `'unknown'`，不并进 input。命中率 = `cacheRead / (input + cacheRead)`，分母为 0 记 `null`。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/usage.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；本任务无可抽取的重复结构。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交**

```bash
git add src/admission/usage.ts test/usage.test.ts
git commit -m "feat: usage pairing and savings fields"
```

---

### Task 22: 外部失效源与二次投影防护

**Files:**
- Create: `src/gate/invalidate.ts`, `test/invalidate.test.ts`
- Modify: `src/hooks/post-execute.ts`（调用失效检测与 `hasSpillNotice`）

**Interfaces:**
- Produces: `export class AnchorStore { set(sessionId: string, a: ReceiptAnchors): void; get(sessionId: string): ReceiptAnchors | undefined; clear(sessionId: string): void }`——按 session 的锚点存储，`post-execute` 写入、`invalidate` 读取
- Produces: `export interface ReceiptAnchors { stepId: string; anchors: Record<string, string> }`（`anchors` = 候选引用的回执 id → 到达时的规范化原文；这是**锚点记录**，不是派发队列——`PendingQueue` 只存 T23a 的 `PendingEntry`，两者由同一个 `post-execute` 决策分别写入）
- Produces: `export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'`（宿主 `dsh-compaction-tool-result-pruner` 的真实串；用 `includes` 判定，不做前缀匹配）
- Produces: `export function looksPruned(text: string): boolean`
- Produces: `export function alreadySpilled(text: string, hasNotice: (t: string) => boolean): boolean`
- Produces: `export function invalidate(pending: ReceiptAnchors | undefined, receiptText: string): 'pruned-reset' | 'compaction-reset' | undefined`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { PRUNE_MARKER, looksPruned, alreadySpilled, invalidate } from '../src/gate/invalidate.ts'

test('识别宿主 pruner 的截断标记', () => {
  assert.equal(looksPruned(`head${PRUNE_MARKER}tail`), true)
  assert.equal(looksPruned('plain output'), false)
})

test('已含 spill 页脚的回执不再二次投影', () => {
  assert.equal(alreadySpilled('x', () => true), true)
  assert.equal(alreadySpilled('x', () => false), false)
})

test('marker 出现即判 pruned-reset（锚点仍相等，pruner 保留锚点）', () => {
  const t = `head${PRUNE_MARKER}tail`
  const pending = { stepId: 'A', anchors: { A: t } } as any
  assert.equal(invalidate(pending, t), 'pruned-reset')
})

test('锚点不符且无 marker 判 compaction-reset', () => {
  const pending = { stepId: 'A', anchors: { A: 'original text' } } as any
  assert.equal(invalidate(pending, 'completely different'), 'compaction-reset')
})

test('锚点相等且无 marker 不触发', () => {
  const pending = { stepId: 'A', anchors: { A: 'same' } } as any
  assert.equal(invalidate(pending, 'same'), undefined)
})

test('无 pending 不触发', () => {
  assert.equal(invalidate(undefined, 'x'), undefined)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/invalidate.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`looksPruned` = `text.includes(PRUNE_MARKER)`（宿主换文案时就检测不到；方向是多裁一次，不会误放行）。`invalidate`：`pending` 为空 → `undefined`；`receiptText` 含 marker → `pruned-reset`（**无论锚点是否相等**——pruner 保留锚点，这正是最常见路径）；否则取 `pending.anchors[pending.stepId]`，存在且与 `receiptText` 不相等 → `compaction-reset`；anchor 缺失或相等 → `undefined`。`post-execute` 里在投影前调用，命中即清 pending 并写收据（**不读历史当前正文**，§5.2-7）。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/invalidate.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: 重构**

无重构则写明「无需重构」；本任务无可抽取的重复结构。

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含本任务与全部前序任务的测试）

- [ ] **Step 7: 提交并推送**

```bash
git add src/gate/invalidate.ts test/invalidate.test.ts src/hooks/post-execute.ts
git commit -m "feat: external invalidation and double-projection guard"
git push origin main   # remote 由 T1 布置（内网镜像）；GitHub 作为第二个 remote 后加
```

---

### Task 23a: 待办队列与合成回合（纯协议层）

**Files:**
- Create: `src/hooks/pending.ts`, `src/hooks/synthesize.ts`, `test/hooks-pending.test.ts`

**Interfaces:**
- Consumes: `StreamChunk`/`TokenUsage`/`ToolCallId`（`@deepseek-ai/dsh-llm/types`，T1 已加 peer 依赖）
- Produces: `export interface PendingEntry { callId: string; candidateId: string; name: string; args: Record<string, unknown>; turn: number | string; step: number | string; createdAt: number }`——`step` 是**宿主回合内的步号**，不是插件自数的计数：同一候选在同一回合的两个不同步上替换时必须得到不同的 `callId`，否则宿主会落两条 `id` 相同的 assistant `tool_use`，Anthropic 风格的路由会直接拒绝。
- Produces: `export class PendingQueue { set(sessionId: string, e: PendingEntry): void; take(sessionId: string): PendingEntry | undefined; peek(sessionId: string): PendingEntry | undefined; clear(sessionId: string): void; size(): number }`——键是 **sessionId**
- Produces: `export function callIdFor(sessionId: string, turn: number | string, step: number | string, candidateId: string): string`——`sha256(JSON.stringify([sessionId, String(turn), String(step), candidateId]))` 前 16 位。**用 JSON 数组而不是 `/` 拼接**：拼接对分隔符有歧义（`('s','1','2/3','c')` 与 `('s','1/2',3,'c')` 同串）。
- Produces: `export async function* synthesizeTurn(e: PendingEntry): AsyncIterable<StreamChunk>`

**测试（只列断言，不写实现体）**
- `队列按 sessionId 隔离`：`peek` 另一会话返回 `undefined`
- `callIdFor 对同候选不同 turn 产生不同 id`，同参数幂等
- `合成回合的 chunk 类型序列` 恰为 `block-start(reasoning) → reasoning-delta → block-end → block-start(tool-call) → tool-call-delta → block-end → finish`
- `tool-call 的 block.arguments 是 JSON 串且与 argumentsDelta 相同`，`block.id` 非空
- `首个 chunk 是 reasoning`（缺它下一次请求 400，见附录 §7）

- [ ] **Step 1: 写失败测试**（上述五条）
- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/hooks-pending.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`PendingQueue` 用 `Map<string, PendingEntry>`。`callIdFor` 用 `node:crypto`。`synthesizeTurn` 按附录 §1.1 逐个 `yield`，字段名与顺序以附录为准，不照本计划的散文猜。

- [ ] **Step 4: 运行确认通过** — 5 tests PASS
- [ ] **Step 5: 重构** — 抽 `reasoningText(e)` / `toolCallBlock(e)`，不导出
- [ ] **Step 6: 全量测试** — `npm test` 全绿
- [ ] **Step 7: 提交**

```bash
git add src/hooks/pending.ts src/hooks/synthesize.ts test/hooks-pending.test.ts
git commit -m "feat: pending queue and synthesized tool turn"
```

---

### Task 23b: post-execute 装配（决策、准入、投影、影子）

**Files:**
- Modify: `src/hooks/post-execute.ts`（T17 骨架）
- Create: `test/hooks-post.test.ts`

**Interfaces:**
- Consumes: `decide`（T15，含 `shadow` 形参）、`rejectIfTampered`（T18）、`worthSubstituting`（T16）、`canonicalise`（T3）、`projectApply`/`projectShadow`（T5/T6）、`invalidate`+`ReceiptAnchors`（T22）、`PendingQueue`/`callIdFor`（T23a）、`parsePlan`（T11）
- Produces: `export interface HookDeps { config: BoostConfig; scope: ScopeStore; receipts: ReceiptStore; anchors: AnchorStore; resolveSession: (sessionId: string) => string | undefined; queue?: PendingQueue; budget?: StepBudget; usage?: UsageLedger; clock?: TurnClock; plans?: Map<string, Plan>; spill?: SpillBackend; estimateText?: (t: string) => number }`——**`step` 的唯一来源是 `clock.step()`**（T20 的 `TurnClock` 由宿主 `{turn, step}` 事件驱动）；`tools/post-execute` 的 `ToolExecution` 没有 turn/step 字段，**不得**用插件自数的计数冒充步号，否则同一回合内两次替换会撞同一个 `callId`。——**`anchors` 与 `resolveSession` 必填**（缺后者会让替换永远走不到，见第 4 轮 P0-1）
- Consumes: `AnchorStore`（T22）
- Produces: `export function registerHooks(ctx: PluginContext, deps: HookDeps): void`（本任务接 `tools/post-execute` 与 `tools/execute`）

**测试**
- `影子期 commit`：写 shadow 收据（含 `decision`/`candidateId`/`admitted`），`queue.peek` 为 `undefined`
- `非影子 commit`：入队，`callId` 可由 `callIdFor(sessionId, clock.turn(), clock.step(), candidateId)` 复算
- `无 agent`：`next()` 被调一次 + `skip:no-scope` 收据
- `投影收据`：`kind:'projection'` 且 `unit:'raw'`、`before`/`after` 为数字
- `防篡改`：`callId` 不匹配 → 返回 failure（`isError:true`）且队列被清；**走 T18 的 `rejectIfTampered`，不另写比对**

- [ ] **Step 1: 写失败测试** → **Step 2** `node --import tsx --test test/hooks-post.test.ts` 失败
- [ ] **Step 3: 实现接线**

顺序固定：`next() → canonicalise → invalidate → decide → （shadow 写收据 | 非 shadow 准入后入队 | fallback 清队列）→ 投影 → 返回 decision`。
投影放在 decide 之后，因为守卫与 Jev 读的是**规范化原文**；投影只影响进历史的内容。
`tools/execute`：`peek(sessionId)` 取 entry；先比对 `exec.callId === entry.callId`（`rejectIfTampered` 只比 name/args，callId 由本处负责），再交 `rejectIfTampered(exec, entry)`。**两条路径都必须 `clear(sessionId)`**——拒绝路径写 `dispatch-rejected` 收据并返回 failure 分支（`{isError:true, error:{message, info:{code}}, content}`，见附录 §2.3）；接受路径也必须清，否则残留的 entry 会让该 session 后续每一个不同的调用都被误判为 `dispatch-rejected`。`DispatchExec` 需要 `callId` 与 `agent` 两个字段（T18 只声明了 `name`/`arguments`）。

- [ ] **Step 4: 运行确认通过** — 5 tests PASS
- [ ] **Step 5: 重构** — 抽 `applyDecision(deps, result, ctx)`
- [ ] **Step 6: 全量测试** — `npm test` 全绿
- [ ] **Step 7: 提交**

```bash
git add src/hooks/post-execute.ts test/hooks-post.test.ts
git commit -m "feat: wire post-execute decisions, admission, projection and tamper guard"
```

---

### Task 23c: llm/stream 包装与生产装配

**Files:**
- Create: `src/hooks/llm-stream.ts`
- Modify: `src/hooks/post-execute.ts`（注册第三条钩子）、`src/index.ts`（**生产装配**）
- Create: `test/hooks-stream.test.ts`

**Interfaces:**
- Consumes: T23a/b 全部导出、`SELECTOR_PURPOSE`（T14）、`StepBudget`（T16）、`UsageLedger`（T21）、`TurnClock`（T20）
- Produces: `export function streamHook(deps: HookDeps): (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>`——**同步返回**，不能是 `async` 函数
- Produces: `apply` 内一次性构造 `pending/budget/usage/clock/plans/anchors/resolveSession` 并注入 `registerHooks`——**这是唯一的生产装配点**，缺它所有单元测试绿而产品不工作

**测试**
- `selector 自身调用放行`（`purpose === SELECTOR_PURPOSE`）
- `无 pending 放行`
- `scope 不可见放行 + skip:no-scope`
- `收据停写 fail-closed 放行`
- `预算耗尽回主模型`：`nextCalls === 1` 且流里无 `tool-call-delta`
- `有 pending 时合成`：`nextCalls === 0`，流里有 `tool-call-delta`，收据 `kind:'substitute'`
- `usage 映射`：流里 `{inputTokens:100, cacheReadTokens:900, outputTokens:10}` → `ledger.last()` 的 `input=100 / cacheRead=900`
- `跨回合结算`：合成后下一次真实请求结束 → 追加 `substitute-settled` 收据

- [ ] **Step 1: 写失败测试** → **Step 2** 失败
- [ ] **Step 3: 实现**

规则顺序（**检查必须在写收据与 `queue.take` 之前**）：`purpose` → `receipts.stopped()` → 可见性（`resolveSession` **必填**，返回 `undefined` 即放行并清该 session 队列）→ 无 pending → 回合有效（`entry.turn === clock.turn()`，否则清队列放行）→ 锚点仍完好 → **不取预算**（T23b 在 `post-execute` 已经 `budget.take()` 过；此处再取会让每次替换扣 2 格）→ 合成。

**T23c 必须满足的十一条**（每条都来自前序任务的复审发现，缺一条产品就是坏的或测不到的）：
1. **clock 与 budget 必须按 session 分**。`HookDeps` 目前是单实例；已证跨会话污染：s2 的事件会让 s1 的 `callId` 用上 s2 的 turn/step，s2 的换回合会中途清掉 s1 的收据表（丢 `$public` 绑定），共享 `StepBudget(1)` 会让一个会话饿死另一个。
2. **不要在这里再 `budget.take()`**（见上）。
3. **`peek` 不 `take`**，entry 必须活到 `tools/execute`。
4. **回合有效性**：换回合时的清队列发生在"新回合第一次 `post-execute`"，而它晚于新回合第一次 `llm/stream`；不在这里比 `entry.turn` 就会合成一个上一回合的替换，而它的 `callId` 随后还能匹配上、被接受。
5. **`usage.markSubstituted` 没有 unmark**。reset 或换回合丢掉 entry 却留着标记，下一次透传请求就会为一次从未发生的替换结算"节省"。这里要 settle-and-discard。
6. **剪枝/压缩检测在这里**：对 `options.messages` 检查承载锚点的消息是否含 `PRUNE_MARKER`、或锚点原文是否已不在；命中即放弃 pending。`ReceiptAnchors` 没有 turn 字段，所以只能用 `entry.turn` 判新旧。
7. **`purpose === SELECTOR_PURPOSE` 的请求不得进 `usage.request()`**，否则选择器自己那次调用会成为配对样本，`saved_input_tokens` 直接算错。
8. **`ask-selector` 由本任务兑现**：调 `choose`，commit 必须用 `decision.candidates[].args`（已绑定）。
9. **`resolveSession` 必须是真实现**（当前 stub 恒 `undefined`，整条路径不工作），且必须在该 session 第一次有意义的 `post-execute` 之前预热可见性判定。`llm/stream` 是**同步** waterfall 返回 `AsyncIterable`，所以预热在那里启动、在生成器第一次 `yield` 之前 await。
10. **会话结束要清理**：`ReceiptSessionState.clear`（已暴露为 `HookDeps.sessionState`）与 `AnchorStore.clear` 都需要调用者；`sessionState.clear` 目前只清收据与派发表，不清队列和锚点。
11. **收据**：合成时写 `{kind:'substitute'}`；下一次真实请求结束时若有过 `markSubstituted`，`settle()` 并写 `{kind:'substitute-settled'}`（`saved_input_tokens` / `output_tokens` 原样落盘，`'unknown'` 不计数）。
合成分支：`markSubstituted(candidateId)` → 写 `{kind:'substitute'}` → **`peek`（不是 `take`）** → `yield* synthesizeTurn(e)`，**不再调 `next()`**。entry 必须存活到 `tools/execute`：合成的回合在流结束后才派发工具调用，若此处 `take` 掉，T23b 的 `peek` 永远为空，防篡改在生产路径上**一次都不会触发**（而 T23b 的单元测试手工塞队列仍然全绿）。消费方是 T23b 的 execute 钩子。
透传分支：`yield* next()`，遇 `{type:'usage'}` 映射后 `request()`；若上一轮有 `markSubstituted`，此时 `settle()` 并追加 `substitute-settled`。
`plans`：拼 `text-delta` 成文本，流结束后 `parsePlan` 存进 map。
`clock`：由 `agent/pre-step`（或 `agent/request`）的 `{turn, step}` 驱动 `onModelRequest(turn, step)`，turn 变化时 `budget.reset()`。**`TurnClock` 因此需要 `step()`**——T20 只做了 `turn()`/`stepsThisTurn()`，`stepsThisTurn()` 是插件自数的替换次数，**不是宿主步号**，不能拿它当 `callIdFor` 的 `step`。

- [ ] **Step 4: 运行确认通过** — 8 tests PASS
- [ ] **Step 5: 重构** — 抽 `resolveStreamPlan(deps, options)`
- [ ] **Step 6: 全量测试** — `npm test` 全绿
- [ ] **Step 7: 提交**

```bash
git add src/hooks/llm-stream.ts src/hooks/post-execute.ts src/index.ts test/hooks-stream.test.ts
git commit -m "feat: wrap llm/stream and wire production assembly"
```

---

### Task 24: 端到端替换集成

**Files:**
- Create: `test/integration/substitute.test.ts`
- Modify: `test/fakes/host.ts`（如需）

**Interfaces:**
- Consumes: T11 `parsePlan`、T12 `bindArgs`、T13 `evaluateAll`、T15 `decide`、T14 `choose`、T16 `worthSubstituting`、T23a `PendingQueue`/`synthesizeTurn`、T23b `registerHooks`/`HookDeps`、T23c `streamHook`

- [ ] **Step 1: 写五条路径的失败测试**

```ts
// test/integration/substitute.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeHost } from '../fakes/host.ts'
import { PendingQueue } from '../../src/hooks/pending.ts'
import { ReceiptStore } from '../../src/receipts/store.ts'

// runPath/collect 是本文件的夹具，不是被测代码——Step 3 把它们写完整
async function runPath(opts: { path: string; guardFails?: boolean; candidates?: string[]; selectorChoice?: string; threshold?: number; prefillBudget?: number }) {
  const host = fakeHost()
  const receipts: any[] = []
  const queue = new PendingQueue()
  // …按 opts 装配 scope / budget / selector / spill，注册 registerHooks，驱动一次 llm/stream
  return { host, receipts, queue }
}
async function collect(iter: AsyncIterable<any>) { const out: any[] = []; for await (const c of iter) out.push(c); return out }
test('成功替换：合成回合出现 tool-call，收据含 saved_input_tokens', async () => {
  const { host, receipts } = await runPath({ path: 'happy' })
  const chunks = collect(await host.lastStream())
  assert.ok(chunks.some(c => c.type === 'tool-call-delta'))
  assert.ok(receipts.some(r => r.kind === 'substitute' && r.saved_input_tokens !== undefined))
})
test('守卫失败：不合成，pending 清空，记 fallback 收据', async () => {
  const { host, queue, receipts } = await runPath({ guardFails: true })
  assert.equal(queue.peek('s1'), undefined)
  assert.ok(receipts.some(r => r.code === 'no-candidate'))
})
test('多候选：selector 返回 B 后合成的是 B 的调用', async () => {
  const { host } = await runPath({ candidates: ['A', 'B'], selectorChoice: 'B' })
  const delta = collect(await host.lastStream()).find(c => c.type === 'tool-call-delta')
  assert.equal(delta.name, 'read')
  assert.match(delta.argumentsDelta, '/b')
})
test('准入不过：worthSubstituting 为假 → 不合成', async () => {
  const { host } = await runPath({ threshold: 10 ** 6 })
  assert.equal(host.synthesized, 0)
})
test('第 9 次：steps-exhausted 且不发合成', async () => {
  const { host, receipts } = await runPath({ prefillBudget: 8 })
  assert.equal(host.synthesized, 0)
  assert.ok(receipts.some(r => r.code === 'steps-exhausted'))
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/integration/substitute.test.ts`
Expected: FAIL，文件不存在

- [ ] **Step 3: 实现测试夹具**

用 `fakeHost` + 内存 `ReceiptStore` + 假的 `spillStore`，把 11→12→13→15 串成一条 `simulateReceipt()` 辅助函数；每个用例只改一处输入。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/integration/substitute.test.ts && npm test`
Expected: 全部 PASS（含前序 25 个任务 T1–T22、T23a–T23c 的测试）

- [ ] **Step 5: 重构**

如果 `simulateReceipt()` 超过 40 行，拆成"构造回执"与"跑决策"两半。

- [ ] **Step 6: 提交**

```bash
git add test/integration/substitute.test.ts test/fakes/host.ts
git commit -m "test: end-to-end substitution paths"
```

---

### Task 25: 观测、降级与平台

**Files:**
- Create: `src/admission/fixed-cost.ts`, `src/admission/retrieval.ts`, `src/host/loader.ts`, `src/host/root.ts`, `src/host/platform.ts`, `src/tools/family.ts`
- Modify: `src/tools/boost.ts`, `src/hooks/post-execute.ts`
- Create: `test/host.test.ts`, `test/family.test.ts`（测试文件）

**Interfaces:**
- Produces: `export async function loadOptional<T>(specifier: string): Promise<T | undefined>`
- Produces: `export function resolveBoostRoot(): string`（`process.env.DSH_HOME ?? join(homedir(), '.dsh')` + `/boost`）
- Produces: `export function familyOf(name: string): ToolFamily | undefined`（`mcp__ssh__execute-command` → `ssh`）
- Produces: `export async function measureFixedCost(text: string): Promise<number | 'unknown'>`
- Produces: `export function recordRetrieval(params: unknown, locators: ReadonlySet<string>): boolean`
- Produces: `export const isPosixOnly: () => boolean`

- [ ] **Step 1: 写失败测试**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { isPosixOnly } from '../src/host/platform.ts'
import { familyOf } from '../src/tools/family.ts'
import { resolveBoostRoot } from '../src/host/root.ts'
import { loadOptional } from '../src/host/loader.ts'
import { recordRetrieval } from '../src/admission/retrieval.ts'
import { runBoost } from '../src/tools/boost.ts'

test('Windows 上禁替换但投影仍可用', () => {
  const saved = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    assert.equal(isPosixOnly(), false)
    // 禁用替换的判定由 boost status 的 degraded 暴露，断言稳定码（不另造 degradedCodes 辅助）
    const status = await runBoost({ cmd: 'status' })
    assert.ok((status.data as any).degraded.includes('ERR_HOST_PLATFORM_UNSUPPORTED'))
  } finally {
    Object.defineProperty(process, 'platform', { value: saved, configurable: true })
  }
})

test('familyOf 映射 ssh 的宿主工具名', () => {
  assert.equal(familyOf('read'), 'read')
  assert.equal(familyOf('mcp__ssh__execute-command'), 'ssh')
  assert.equal(familyOf('web_fetch'), undefined)
})

test('resolveBoostRoot 在未设 DSH_HOME 时回退 ~/.dsh/boost', () => {
  const saved = process.env.DSH_HOME
  delete process.env.DSH_HOME
  assert.ok(resolveBoostRoot().endsWith('.dsh/boost'))
  process.env.DSH_HOME = saved
})

test('loadOptional 对不存在的包返回 undefined，不抛错', async () => {
  assert.equal(await loadOptional('@deepseek-ai/definitely-not-installed'), undefined)
})

test('recordRetrieval 只认命中 locator 的参数', () => {
  const locs = new Set(['/spill/read-1.txt'])
  assert.equal(recordRetrieval({ path: '/spill/read-1.txt' }, locs), true)
  assert.equal(recordRetrieval({ path: '/other' }, locs), false)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/host.test.ts test/family.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`loadOptional` 用 `await import(name)` 包 try/catch（这是 R16 的落点：静态 import 在宿主缺包时直接 `ERR_MODULE_NOT_FOUND`）。`measureFixedCost` 动态导入 `estimateSystemMessage`，失败返回 `'unknown'`。`boost status` 增加 `fixedOverheadTokens`、`projection_retrievals`、`projection_net_tokens`；`degraded` 一律输出 `ERR_HOST_*` / `ERR_SCOPE_*` 稳定码（含 `ERR_HOST_NO_TOKENMETER`、`ERR_HOST_PLATFORM_UNSUPPORTED`）。`isPosixOnly()` 为假时禁用替换（`degraded` 加码），投影照常。

- [ ] **Step 4: 运行确认通过**

Run: `node --import tsx --test test/host.test.ts test/family.test.ts && npm test`
Expected: 全部 PASS

- [ ] **Step 5: 重构**

无重构则写明「无需重构」。

- [ ] **Step 6: 提交**

```bash
git add src/host/ src/tools/family.ts src/admission/fixed-cost.ts src/admission/retrieval.ts src/tools/boost.ts src/hooks/post-execute.ts test/host.test.ts test/family.test.ts
git commit -m "feat: host capability probes, family mapping, fixed-cost measurement"
```

---

### Task 26: 分析脚本与发布验收

**Files:**
- Create: `scripts/shadow-report.mjs`, `scripts/session-stats.mjs`, `scripts/session-snapshot.json`, `test/regression/tasks.jsonl`, `test/regression/run.mjs`, `test/scripts.test.ts`, `docs/RELEASE.md`

**Interfaces:**
- Consumes: 收据格式（T7）、`boost status`（T19/T25）

- [ ] **Step 1: 写失败的验收脚本测试**

```js
// scripts/shadow-report.test.mjs（或 test/scripts.test.ts）
test('shadow-report 对空收据目录输出四项零值，不抛错', async () => {
  const out = JSON.parse(await run('scripts/shadow-report.mjs', ['--dir', emptyDir]))
  assert.deepEqual(out, { saveableRatio: 0, byFamily: {}, candidateRecall: 0, retrievalUpperBound: 0 })
})
test('session-stats 对固定 snapshot 复算出 54,123 步 / 62,621 调用', async () => {
  const out = JSON.parse(await run('scripts/session-stats.mjs', ['--snapshot', 'scripts/session-snapshot.json']))
  assert.equal(out.steps, 54123)
  assert.equal(out.toolCalls, 62621)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --import tsx --test test/scripts.test.ts`
Expected: FAIL，脚本不存在

- [ ] **Step 3: 实现三个脚本 + 一个门**

`shadow-report.mjs` 扫 `receipts/*.jsonl`，输出四类标签：真实可省比例、按族命中率、候选集召回、取回率上界（`取回调用数 / 投影回执数`）。
`session-stats.mjs` 按 `session-snapshot.json` 复算 §2.1 全部统计。
`test/regression/run.mjs` 读 `tasks.jsonl`（20 条，每条 `{ id, prompt, expect }`），pass 谓词按设计稿 §6.1：`两轮都完成且 isError=false 的任务数 ≥ 19 ∧ 每条被投影回执可取回且字节数 = count + 保留窗口字节数`。
`docs/RELEASE.md` 写清 `npm pack` → 空项目安装 → 分别卸掉 `dsh-spill-policy` / `dsh-token-meter` 验证两条降级路径（isolated 布局；hoisted 布局测不出 `ERR_MODULE_NOT_FOUND`）。

- [ ] **Step 4: 运行确认通过**

Run: `npm run stats && node --import tsx --test test/scripts.test.ts && npm test`
Expected: 全部 PASS

- [ ] **Step 5: 重构**

无重构则写明「无需重构」。

- [ ] **Step 6: 提交并推送**

```bash
git add scripts/ test/regression/ test/scripts.test.ts docs/RELEASE.md
git commit -m "feat: shadow report, stats replay and release acceptance"
git push origin main
```
