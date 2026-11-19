# 宿主契约附录（v1，逐条抄自源码）

> 本文件是 `2026-11-18-dsh-token-efficiency.md` 的**接口准绳**。凡计划里与本文冲突之处，以本文为准。
> 全部条目在 2026-11-19 对 `/dsh-home/profiles/web/node_modules/@deepseek-ai/` 的源码逐行核对，行号为该时点。

## 0. 怎么用

写任何跨包调用前，先查本文对应小节。**不要凭类型名猜形状**——本计划前两轮 9 条 P0 里有 6 条是这么来的。

## 1. LLM（`@deepseek-ai/dsh-llm`）

### 1.1 `StreamChunk`（`src/types.ts:496-508`）

```ts
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }
```

- **没有 `chunk.text`**：文本在 `text-delta.text`。
- `ToolCallBlock = { type:'tool-call'; id: ToolCallId; name: string; arguments: string }`，`arguments` 是**原始 JSON 字符串**（`:112-118`）。
- 适配器在 `finish` 之前发 `usage`，之后不发任何东西。
- 错误/中止是 `finish.reason = { kind: 'error' | 'aborted', ... }`，不是抛异常。

### 1.2 `TokenUsage`（`src/types.ts:182-196`）

```ts
{ inputTokens: number; outputTokens: number; totalTokens?: number;
  cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
```

- `inputTokens` **不含** cacheRead/cacheWrite（缓存部分单列，`billed input = 三者之和`）。
- 必填只有 `inputTokens` / `outputTokens`。

### 1.3 `GenerateOptions`（`src/types.ts:564-606`）

`provider` / `model` **是顶层字段**，没有 `route` 嵌套。其余：`reasoningEffort?`、`messages`、`system?`、`tools?`、`toolHistory?`、`temperature?`、`maxTokens?`、`stop?`、`signal?`、`sessionId?`、`purpose?`。

- **没有 `usage` 字段**：想拿用量只能读流里的 `usage` chunk。
- `LlmRuntime.stream(options): AsyncIterable<StreamChunk>`（`src/index.ts:1185`）。

## 2. 工具（`@deepseek-ai/dsh-tools`）

### 2.1 注册条件（`src/contracts.ts:106-128`）

```ts
interface ToolActivationContext { readonly agent: Agent; readonly modelSelection: ModelSelection; readonly signal: AbortSignal }
interface ToolRegistrationOptions { readonly when?: (context: ToolActivationContext) => boolean | Promise<boolean> }
```

- **`when` 允许返回 Promise**——异步可见性判定不必绕同步缓存。
- `Agent` 有 `session`（`dsh-agent/src/runtime-types.ts:191-203`），`Agent.id` 是 `SessionId`（`dsh-agent/src/types.ts:16-19`）。

### 2.2 执行期字段（`src/contracts.ts:168-200`）

`ToolExecutionInput`：`callId`、`rootCallId?`、`name`、`arguments: unknown`、`agent?`、`toolSet?`、`parent?`。

- **`exec.callId` 存在**，且 `exec.arguments` 是已解析对象。
- `tools/execute` 的 `next(): Promise<ToolExecutionResult>`；`tools/post-execute` 的 `next(): Promise<PostToolDecision>`。

### 2.3 返回值（`src/contracts.ts:364`）

```ts
type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure
```

拒绝必须构造成 `failure`（`isError: true` + `error.message` + 可选 `info.code`），不能返回 `{reject: true}`。

### 2.4 钩子时序

`pre-execute` → `execute` → `post-execute`（waterfall，可替换 result）→ `result`（只观察，异常被吞）。
**cordis 的 waterfall 是同步的**（`@deepseek-ai/cordis/src/events.ts:246-262`）：listener 的返回值被原样交回。

## 3. 系统提示（`@deepseek-ai/dsh-system-prompt`）

```ts
interface AssembleContext { scope?: ScopeKey; signal?: AbortSignal }     // :42-50
interface PromptSection { name: string; order: number;
  text: string | ((context: AssembleContext) => string);                 // :53-68
  interpolate?: boolean; /* … */ }
```

- `text` **可以是函数**，每次装配同步调用——不能返回 Promise。
- `AssembleContext` 只有 `scope` 与 `signal`，**没有 `agent`**；scoped 装配时 `scope` 就是 agent。
- 返回 `''` 即该次不注入。

## 4. 工作区（`@deepseek-ai/dsh-workspace`）

```ts
interface WorkspaceRegistry {
  list(): readonly Workspace[]                                  // 同步，:302-315
  resolveByPath(path: string): Promise<Workspace | undefined>   // 异步，:520-529
}
interface Workspace { id: string; path: string; sessionIds: …; … }  // types.ts:60-100
```

- **没有 `byPath`**。
- 同步路径（`systemPrompt` 装配、`when` 的同步分支）只能用 `list()` 自己查。

## 5. 会话与回合

- `Session.header` 有 `id`、`cwd`（非可选）。
- turn/step 由 `agent/request` 携带 `{ turn, step }`（`dsh-agent/src/runtime-types.ts:374`）；session log 另有 `turn/start`。
- **一次 `llm/stream` 不等于一个 turn**：一个 turn 内可以有多个 step/请求。

## 6. 计量（`@deepseek-ai/dsh-token-meter`）

`measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement`（`src/index.ts:151`）——纯计算，不调模型。

## 7. 本计划踩过的坑（写实现时逐条复检）

| 坑 | 症状 | 正确做法 |
|---|---|---|
| `llm/stream` 钩子写成 `async` | 宿主拿到 `Promise<AsyncIterable>`，`for await` TypeError，**每个请求都失败** | 写成 `(o, next) => (async function* () { … yield* next() })()` |
| 合成回合只发 `tool-call` 块 | DeepSeek thinking 模式下一次请求 400（`content[].thinking … must be passed back`） | 先发一块无签名 `reasoning` 作为 sibling |
| `section({ text: '(c) => …' })` 返回 Promise | prompt 装配拿到 Promise 对象 | 同步读缓存，或干脆用 `when` 做门 |
| 用 `registry.byPath` | `undefined` → 全量不可见且静默 | `list().find(w => w.path === cwd)` |
| 用 `chunk.text` 取选择器输出 | 恒 `undefined` → 永远 `no-label` | 拼 `text-delta.text` |
| `usage.request(chunk.usage)` 直传 | 字段名不匹配 → 三个 `undefined` | 映射 `{input: u.inputTokens, cacheRead: u.cacheReadTokens ?? 0, output: u.outputTokens}` |
| `queue.peek(callId)` | 队列按 sessionId 存 → 恒 `undefined`，防篡改静默失效 | `peek(sessionId)` 后比 `entry.callId === exec.callId` |
| `budget.take()` 放在"有 pending"判定之前 | 每个普通请求都扣一次，8 次后永久关闭替换 | 先判 pending，再 take |
| 用 `text.length` 比 code point 阈值 | emoji 越裁越长、页脚出现负数 | `Array.from(text).length` |
| `src` 内 `import './x.ts'` | `module: NodeNext` 下 TS5097，构建失败 | 源码用 `./x.js` 说明符（测试可保留 `.ts`，取决于 runner） |
