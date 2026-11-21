# Changelog

本文件记录用户可感知的变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。设计与取舍不在本文件展开，见
`docs/superpowers/specs/`；发布验收流程见 `docs/RELEASE.md`。

This file records user-visible changes. Format follows Keep a Changelog; versions follow SemVer.
Design rationale lives in `docs/superpowers/specs/`; the release-acceptance procedure is in
`docs/RELEASE.md`.

## [Unreleased]

## [0.1.2] - 2026-11-21

### 修复 Fixed

- **scope 文件不再被静默覆盖。** 坏 JSON / 非对象 / 数组（`ERR_SCOPE_PARSE_FAILED`）以及「版本缺失或非数值、且没有可识别的 v1 字段」（`ERR_SCOPE_UNKNOWN_VERSION`）两种情况下，`scope-set` 与 `shadow` 现在**拒绝写入**并把文件原样留在盘上；此前会以默认文档为基底覆盖它，`workspaceIds` 会变成空数组。带可识别字段的 v1 文件仍按原路升级并保留 `mode` / `global` / `workspaceIds`。
- **`engines.dsh` 从精确 `0.2.2-rc.4` 改为 `>=0.2.2-rc.4 <0.2.3-0`。** 宿主按 `includePrerelease` 判定并在不满足时**直接停用插件**，而 `0.2.2-rc.5` 在本插件触及的九个包里与 rc.4 逐字节相同（复核命令、九个包名与日期见 `docs/RELEASE.md` §2.4「`0.2.2-rc.5` 逐字节复核」）——精确钉法会让一个兼容宿主上的插件静默不加载。
- **装配不全不再看起来健康。** 七个会话监听改为逐个独立挂载，失败者记名并进 `missingMounts`；此前它们共用一个裸 catch，首个抛错会静默丢掉其余六个（包括 `session/disposed`，于是每会话状态在进程生命周期内泄漏）。
- **被替换或销毁的宿主服务不再被永久缓存。** `llm` 与 `workspaceRegistry` 此前只 memo 首次成功的绑定，provider 换掉后仍用旧对象；现在失败即重置、销毁即失效。
- **合成调用会按本步的工具准入集过滤。** 候选工具不在 `exec.toolSet` 里就弃权，避免派发一个宿主会以 `UNKNOWN_TOOL` 拒绝的调用；取不到准入集时照常替换，但记 `substitute-skipped:no-toolset` 让这种不可验证状态可见。
- **共享运行时借不到时按耗尽处理。** 此前「预算被别的会话持有」与「没接线预算」都返回 `undefined`，前者被当成无上限，导致每回合步数上限静默失效。
- **翻转结算用派发回合记账**，被 `tools/pre-execute` 拒绝的合成派发在翻转时也会报告被跳过的模型回合（此前丢弃，少报一次真实节省）。
- **锚点存储冷或抛错时 fail closed**：提交后没有锚点记录、或读取抛错，都走 reset 而不是在无法验证「模型是否还持有证据」时合成。
- **`tools/execute` 跳过 PTC 内层调用**，与 `tools/post-execute` 一致。
- **`verify:package` 现在解析 `cordis.patch.yml`**（`insert` 非空、`id`/`name` 等于包名、`config` 是对象），不再只查文件存在；`--prebuilt` 让 allowlist 描述 CI 刚构建的那棵树，而不是重新构建它；`prepare` 已移除，`npm publish` 自己的 pack 也不会重建。
- **`shadow-report.mjs`**：`--help` 退出 0；目录不存在时以 2 退出，需要空报告要显式 `--allow-empty`。
- **`.npmrc` 与 lockfile 改钉 `registry.npmjs.org`**，与 `publishConfig` 同源；CI 断言不残留镜像 URL。此前发布校验查的是镜像，镜像的 `latest` 滞后，一次失败的发布可以看起来是成功的。
- 文档：`^0.1.0` 不是安全的钉法（npmjs 是 0.1.1、镜像是 0.1.0）；页脚 190/192 字符、死区从 743 起；收据按「决定」写，无计划的 `write`/`edit` 不落收据；分片轮转与 256 上限按编码后的会话名计；宿主 home 默认是 `~/.dsh`；20 任务门是人工流程且任务集不随包发布；发布门是**实现者**的决定而非用户裁决。

## [0.1.1] - 2026-11-21

第二轮与第三轮审查（各六个独立维度）的修复。**没有行为退化，但有三处会让功能静默失效的缺陷被修掉。**

### 修复 Fixed

- **辅助模型请求不再被误判为「协议段被吞掉」。** 宿主对**每一条** `llm/stream` 都派发，包括
  `purpose: 'compaction'` 与 `purpose: 'session-title'`。旧检测器把它们的系统提示读成「完整
  section 覆盖了协议段」，于是累计 `ERR_HOST_COMPLETE_SECTION` 永久留在 `status.degraded`、
  并把该会话判为不可见——**投影恰好在压缩前后、回执最大时被关掉**。现在任何带 `purpose` 的
  请求都不参与该探测。
- **装配不全不再看起来健康。** 协议段注册失败后，三个事件钩子改为逐个独立挂载，失败者记名并
  通过新的 `ERR_BOOST_PARTIAL_MOUNT` 进 `status.degraded`。
- **坏掉的 spill 后端有了自己的码。** `projection-skipped:spill-failed` 现在映射到新的
  `ERR_HOST_SPILL_FAILING`，不再复用 `ERR_HOST_NO_SPILL`——「后端存在但每次写都失败」与
  「后端缺失」的修法不同，前者去重装 spill 包是错的。
- **`$DSH_HOME` 里的 `~` 会被展开**，与宿主 `expandHomePath` 一致；此前 `DSH_HOME='~/x'`
  会在 cwd 下建一个字面 `~` 目录，把收据写到宿主 home 之外。
- **出错的流不再把替换的用量标记留给下一次请求**（`try/finally` 结算为 `'unknown'`，不再
  高报 `saved_input_tokens`）。
- **共享运行时的借用按实例记属主**，会话销毁时释放；此前第二个会话可能读到第一个会话的请求。
- **pruner 标记不再是身份证据**：内嵌了被锚定回执裁剪文本的另一条回执（例如 `read` 会话日志）
  不再被判为「仍被携带」。
- **回合翻转会结算已派发的替换**，不再把一次真实的跳过模型往返丢成 `'unknown'`。
- **版本守卫忽略 build 元数据**；`ERR_SCOPE_LOCKED` 的说明改为「未陈旧的持锁」而不是「超过超时」。
- **CI 不再必然失败。** 工作流原本跑 `npm publish --dry-run`，在 0.1.0 已发布之后每次 push 都会
  以 `You cannot publish over the previously published versions` 结束。现在跑
  `npm run ci && npm run verify:package`。
- **`verify:package` 的 dist 断言不再被 `prepare` 重建掩盖**：默认路径显式 `npm run build` 后
  `npm pack --ignore-scripts`。
- 文档：3.5% 不再被称为「保底」（净保底约 0.4%）；首次 `status` 的 `degraded` 是空；状态目录
  以 `config.dshHome` 优先；澄清表删掉「计划时冻结」这个不存在的机制，并写明 EDG 的图与链
  没有移植；`package.json` 的 description 改为 substituting。

### 变更 Changed

- `@types/node` 升到 `^24`，与 `engines.node >= 24.9.0` 一致。

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
  `dist` 的 sourcemap 内联源码。0.1.0 是首次发布：registry 的 `latest` 即 0.1.0，
  所以 `dsh-boost@^0.1.0` 就是正确的安装规格。
  Zero-peerDependencies install surface: the package declares no peerDependencies — installing
  it adds only `dsh-boost` itself and no longer pulls a duplicate `@deepseek-ai/*` host tree;
  the host provides the runtime capabilities and gaps degrade. `exports` also maps
  `require`/`default` (Node >= 24.9 require(esm) works); `src/` is no longer shipped and the
  `dist` source maps inline the sources. 0.1.0 is the first release: the
  registry `latest` tag is 0.1.0, so `dsh-boost@^0.1.0` is simply correct.

### 修复 Fixed

- `boost status` 的分片扫描超过 256 个时报告 `ERR_RECEIPTS_TRUNCATED`，不再把截断后的计数当作完整总数。
  `boost status` reports `ERR_RECEIPTS_TRUNCATED` when the shard scan exceeds 256, instead of presenting the truncated counts as complete totals.

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
