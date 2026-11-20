# Changelog

本文件记录用户可感知的变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。设计与取舍不在本文件展开，见
`docs/superpowers/specs/`；发布验收流程见 `docs/RELEASE.md`。

This file records user-visible changes. Format follows Keep a Changelog; versions follow SemVer.
Design rationale lives in `docs/superpowers/specs/`; the release-acceptance procedure is in
`docs/RELEASE.md`.

## [Unreleased]

（无 / none）

## [0.1.0] - 2026-11-20

首个可用版本。默认不改变任何行为：作用域是 `selected` + 空工作区列表，插件装上即静默。

First usable release. It changes nothing by default: the scope is `selected` with an empty workspace
list, so installing the plugin is inert until a workspace is added.

### 新增 Added

- **回执投影**：超过阈值的工具输出按保留头尾窗口裁剪，完整原文经宿主 spill 后端落盘，页脚给出可
  取回的定位符。五族（`read` / `grep` / `glob` / `bash` / `ssh`）各自有触发阈值与窗口参数。
  Projection of oversized tool results: head/tail windows are kept, the full text goes to the
  host's spill backend, and the footer carries a locator that retrieves it. Five families, each
  with its own trigger and window.
- **确定性替换**：模型可在一条消息里写一份计划，把下一步的若干个候选（字面量参数 + 回执局部守卫）
  一次声明完；守卫由代码判定，单一候选直接提交，多候选交给一次一 token 的选择器。替换只覆盖
  `read` / `grep` / `glob` 三个只读工具。
  Deterministic substitution: the model declares a plan with literal arguments and receipt-local
  guards; code evaluates the guards, a single eligible candidate commits, several go to a
  one-token selector. Substitution is limited to three read-only tools.
- **影子模式**：`shadow: true` 时只记账不替换，投影照常生效。默认开启，用于上线前的观察周。
  Shadow mode records decisions without substituting, while projection still applies. It is on by
  default, for the observation week before substitution is enabled.
- **`boost` 控制工具**：`status` / `scope-get` / `scope-set` / `shadow` 四个子命令，全部写入走
  revision 校验，冲突返回稳定码而不是覆盖。
  The `boost` control tool: `status`, `scope-get`, `scope-set`, `shadow`. Every write is
  revision-checked; a conflict returns a stable code instead of overwriting.
- **可审计的收据**：每次决定写一行 JSONL，含计划目标、守卫、绑定后的参数、回执预览与节省量；
  写入按会话分片、崩溃安全、写失败即停止替换（fail-closed）。
  Auditable receipts: one JSONL line per decision with the plan goal, guards, bound arguments, a
  receipt preview and the saving. Sharded per session, crash-safe, and fail-closed after repeated
  write failures.
- **失败即可见的降级**：`boost status` 暴露稳定的 `ERR_HOST_*` 码与 `protocol_suppressed`
  计数，所以"插件没生效"与"宿主缺能力"可以区分开。
  Visible degradation: `boost status` reports stable `ERR_HOST_*` codes and a
  `protocol_suppressed` counter, so "the plugin is inert" and "the host lacks a capability" are
  distinguishable.

### 已知限制 Known limitations

- 只支持 POSIX 平台的替换；Windows 上替换被拒绝（`ERR_HOST_PLATFORM_UNSUPPORTED`），投影仍可用。
  Substitution is POSIX-only; on Windows it is refused while projection still works.
- 不含工具批量调用（PTC）、不做工具调用去重、不支持 desktop profile。
  No batched tool calls, no deduplication of tool calls, no desktop profile.
- 模型路由若为 Anthropic 兼容 thinking 模式，合成回合缺少 sibling `thinking` 块可能被拒；上线
  首轮需按 `docs/RELEASE.md` 检查含 `content[].thinking` 的 400。
  On an Anthropic-compatible thinking route, a synthesized turn without a sibling `thinking` block
  may be rejected; check for a 400 mentioning `content[].thinking` in the first substitution round.

[Unreleased]: https://github.com/SAXEM1997/dsh-boost/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SAXEM1997/dsh-boost/releases/tag/v0.1.0