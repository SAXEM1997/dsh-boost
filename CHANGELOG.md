# Changelog

本文件记录用户可感知的变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。设计与取舍不在本文件展开，见
`docs/superpowers/specs/`；发布验收流程见 `docs/RELEASE.md`。

This file records user-visible changes. Format follows Keep a Changelog; versions follow SemVer.
Design rationale lives in `docs/superpowers/specs/`; the release-acceptance procedure is in
`docs/RELEASE.md`.

## [Unreleased]

### 修复 Fixed

- `boost status` 的分片扫描超过 256 个时报告 `ERR_RECEIPTS_TRUNCATED`，不再把截断后的计数当作完整总数。
  `boost status` reports `ERR_RECEIPTS_TRUNCATED` when the shard scan exceeds 256, instead of presenting the truncated counts as complete totals.

## [0.1.0] - 2026-11-20

<!-- 版本链接暂缺：还没有 v0.1.0 标签，任何 releases/tag 或 compare 链接今天都会 404。
     发布标签后恢复 [Unreleased]/[0.1.0] 链接定义。 / Version links omitted for now: there
     is no v0.1.0 tag yet, so releases/tag and compare URLs would 404 today. Restore the
     [Unreleased]/[0.1.0] link definitions once a tag is published. -->
首个可用版本。默认作用域是 `selected` + 空工作区列表：不投影、不替换、不注入协议段——但
**不是零成本**：`boost` 工具只要插件装配就注册，其 schema（本 checkout 实测 399 token）
随**每个**模型请求常驻。装上但未启用是一个每请求 399 token 的小额净支出。

First usable release. The default scope is `selected` with an empty workspace list: no
projection, no substitution, no protocol section — but **not zero-cost**: the `boost` tool
registers as soon as the plugin is assembled, and its schema (399 tokens measured in this
checkout) rides along on **every** model request. Installed-but-not-enabled is a small net cost
of 399 tokens per request.

### 新增 Added

- **回执投影**：超过阈值的工具输出按保留头尾窗口裁剪，完整原文经宿主 spill 后端落盘，页脚给出可
  取回的定位符。五族（`read` / `grep` / `glob` / `bash` / `ssh`）各自有触发阈值与窗口参数。
  Projection of oversized tool results: head/tail windows are kept, the full text goes to the
  host's spill backend, and the footer carries a locator that retrieves it. Five families, each
  with its own trigger and window.
- **确定性替换**：模型可在一条消息里写一份计划，把下一步的若干个候选（字面量参数 + 回执局部守卫）
  一次声明完；守卫由代码判定，单一候选直接提交，多候选交给一次单标签选择器（一次辅助请求，
  输出预算 512 token，输入另计）。替换只覆盖 `read` / `grep` / `glob` 三个只读工具。
  Deterministic substitution: the model declares a plan with literal arguments and receipt-local
  guards; code evaluates the guards, a single eligible candidate commits, several go to a
  single-label selector — one auxiliary request, 512-token output budget plus its input.
  Substitution is limited to three read-only tools.
- **影子模式**：`shadow: true` 时替换决策只记账，不合成回合。投影由**独立的** `projection`
  字段控制；默认 `projection: 'shadow'` 同样只记账、不改模型可见内容，真正投影要显式设为
  `'on'`。影子周按设计零节省，用于上线前的观察周。
  Shadow mode records substitution decisions without synthesizing anything. Projection is
  governed by the **separate** `projection` field; the default `projection: 'shadow'` likewise
  only prices and never changes model-visible content — real projection requires explicitly
  setting `'on'`. By design the shadow week saves nothing; it exists for the observation week
  before substitution is enabled.
- **`boost` 控制工具**：`status` / `scope-get` / `scope-set` / `shadow` 四个子命令，全部写入走
  revision 校验，冲突返回稳定码而不是覆盖。
  The `boost` control tool: `status`, `scope-get`, `scope-set`, `shadow`. Every write is
  revision-checked; a conflict returns a stable code instead of overwriting.
- **可审计的收据**：每次决定写一行 JSONL。替换类收据含计划目标与守卫、绑定后的参数、回执预览
  与节省量；投影类与跳过类收据含参数与预览，但**不带**计划证据。写入按会话分片、崩溃安全、
  **连续 3 次**写失败即停止替换（fail-closed）。
  Auditable receipts: one JSONL line per decision. Substitution receipts carry the plan goal and
  guards, the bound arguments, a receipt preview and the saving; projection and skip receipts
  carry arguments and a preview but **no** plan evidence. Sharded per session, crash-safe, and
  fail-closed after 3
  consecutive write failures.
- **失败即可见的降级**：`boost status` 暴露稳定的 `ERR_HOST_*` 码与 `protocol_suppressed`
  计数，所以"插件没生效"与"宿主缺能力"可以区分开。收据分片读不出来时另报
  `ERR_RECEIPTS_UNREADABLE`（status 仍是全量聚合并标注不完整）；宿主的 `complete: true`
  提示段顶掉装配出的协议段时报 `ERR_HOST_COMPLETE_SECTION`（受影响请求替换与投影
  fail-closed）；`boost` 写入被调用方信号取消时返回 `ERR_SCOPE_ABORTED`（锁已释放、
  `scope.json` 未动，可安全重试）。
  Visible degradation: `boost status` reports stable `ERR_HOST_*` codes and a
  `protocol_suppressed` counter, so "the plugin is inert" and "the host lacks a capability" are
  distinguishable. An unreadable receipt shard additionally reports
  `ERR_RECEIPTS_UNREADABLE` (status stays a total and flags the figures incomplete); a host
  `complete: true` prompt section displacing the assembled protocol section reports
  `ERR_HOST_COMPLETE_SECTION` (substitution and projection fail closed for affected requests);
  a `boost` write cancelled by the caller's signal returns `ERR_SCOPE_ABORTED` (lock released,
  `scope.json` untouched, safe to retry).
- **零 peerDependencies 的安装面**：包不声明任何 peerDependencies——安装只新增 `dsh-boost`
  本体，不再拉出重复的 `@deepseek-ai/*` 宿主树；运行时能力由宿主提供，缺了走降级。
  `exports` 同时带 `require`/`default`（Node ≥ 24.9 的 require(esm) 可用）；`src/` 不进包，
  `dist` 的 sourcemap 内联源码。0.1.0 是首次发布：发布后 registry 的 `latest` 即 0.1.0，
  所以 `dsh-boost@^0.1.0` 就是正确的安装规格。
  Zero-peerDependencies install surface: the package declares no peerDependencies — installing
  it adds only `dsh-boost` itself and no longer pulls a duplicate `@deepseek-ai/*` host tree;
  the host provides the runtime capabilities and gaps degrade. `exports` also maps
  `require`/`default` (Node >= 24.9 require(esm) works); `src/` is no longer shipped and the
  `dist` source maps inline the sources. 0.1.0 is the first release: once published, the
  registry `latest` tag is 0.1.0, so `dsh-boost@^0.1.0` is simply correct.

### 已知限制 Known limitations

- 只支持 POSIX 平台的替换；Windows 上替换被拒绝（`ERR_HOST_PLATFORM_UNSUPPORTED`），投影仍可用。
  Substitution is POSIX-only; on Windows it is refused while projection still works.
- 不含工具批量调用（PTC）、不做工具调用去重、不支持 desktop profile。
  No batched tool calls, no deduplication of tool calls, no desktop profile.
- 模型路由若为 Anthropic 兼容 thinking 模式，合成回合**会**先发一个 `reasoning` 块，但该消息没有
  `replayState`；pi-ai 的 `transformMessages` 会在上线前丢掉这个块，服务端仍可能看到没有 sibling
  `thinking` 的 `tool_use` 并返回含 `content[].thinking` 的 400。上线首轮需按 `docs/RELEASE.md`
  检查这个 400。
  On an Anthropic-compatible thinking route the synthesized turn **does** emit a `reasoning` block
  first, but the message has no `replayState`; pi-ai's `transformMessages` drops the block before the
  wire, so the server may still see a `tool_use` without a sibling `thinking` and return a 400
  mentioning `content[].thinking`. Check for that 400 in the first substitution round, per
  `docs/RELEASE.md`.
