# dsh-boost

通过**工具回执投影**与**确定性只读替换**降低 DeepSeek Harness（DSH）的 token 消耗。

> **状态：骨架。** 插件元数据、patch 行、配置面与共享类型已落地；投影与替换的行为模块尚未实现，
> 当前版本不要在正式 profile 上启用。

## 它解决什么

DSH 每次模型请求都会回放全部历史。实测 300 个最长会话：每步平均回放 19.4 万 token
（每请求均值 194,473 / 中位 185,590），其中 97.1% 的输入是缓存读；工具回执是体积主体
（bash 63.0%、read 20.8%、ssh 9.1%）。返回给模型的原始回执里，真正会被下一步用到的部分
远少于它的体积。

插件做两件事：

1. **投影**——工具回执进入上下文之前，按工具族保留头尾，把中段换成可检索的落盘句柄；
   原文仍可取回，页脚给出路径。投影按固定阈值确定性执行，不产生逐次决策。
2. **替换**——计划里重复的只读调用（`read` / `grep` / `glob`）若已有确定性证据满足守卫，
   直接提交，不再向模型要一次决策；多候选时用一个只允许返回单个标签的选择器。

v1 的预期收益区间是 **3.5%（保底）– 10.0%（上界）**，按 raw `totalTokens` 计。

## 安装

插件以 npm 包发布，包内携带 `cordis.patch.yml`；`dsh plugin add` 解析安装后，会在 profile 的
patch 层插入一行 `dsh-boost`。

行身份是硬约束：patch 行的 `id`、`name`、插件导出名与 npm 包名四者必须一致。宿主只按
`row.id === entry.options.id && row.name === entry.options.name` 判定"已装配"，缺一个就被**静默跳过**。

`@deepseek-ai/dsh-llm` 在 `peerDependencies` 与 `devDependencies` 中都固定为 `0.2.2-rc.4`：
registry 的 `latest` 标签指向 `0.0.1-rc.1`，那是无关的旧 API，用范围会装错。

## 配置

`cordis.patch.yml` 里的 `config` 是**整体替换**，不做深合并：缺键回落插件默认值，列出的键就是
该 profile 的完整配置面。没有列出的工具族一律不投影。

| 键 | 默认值 | 作用 |
|---|---|---|
| `projection.read.triggerChars` / `headChars` / `tailChars` | 3000 / 2000 / 500 | `read` 回执超过 3000 字符时保留头 2000、尾 500 |
| `projection.grep.*` | 700 / 400 / 100 | `grep` 窗口 |
| `projection.glob.*` | 700 / 400 / 100 | `glob` 窗口 |
| `projection.bash.*` | 4000 / 2000 / 500 | `bash` 窗口 |
| `projection.ssh.*` | 2000 / 1200 / 300 | `mcp__ssh__execute-command` 窗口 |
| `admission.thresholdTokens` | 1024 | 每个候选进入替换所需的最小净节省；唯一候选的确定性提交豁免 |
| `selector.maxTokens` | 512 | 多候选选择器的输出预算（输入 + 输出上界从节省里扣） |
| `stepsPerTurn` | 8 | 每个 turn 的替换步数上限 |
| `horizonSteps` | 20 | 算不出会话历史均值时的剩余步数 horizon |
| `historyTurns` | 5 | 求步数均值所用的最近 turn 数 |

不变量：`triggerChars ≥ headChars + tailChars + 页脚（约 110B） + 1`。窗口不得大于等于触发阈值，
否则会出现"触发了却裁不动"的净亏区间。

## 宿主依赖

`inject` 是硬依赖：`tools`、`llm`、`systemPrompt`——缺任一，插件加载失败。

| 服务 | 形态 | 缺失时 |
|---|---|---|
| `tokenMeter` | 软（`ctx.get('tokenMeter')`） | 拒绝启用替换；投影仍可用，投影账记 `unknown`（不伪造数字），`ERR_HOST_NO_TOKENMETER` |
| `spillStore` | 软（`ctx.get('spillStore')`） | `projection: 'on'` 时超限回执不投影（保住证据），`projection-skipped:no-spill`，`ERR_HOST_NO_SPILL` |
| `tools.resolve` 的步骤级 `when` | 软探测 | 整族不注册，`ERR_HOST_NO_STEP_WHEN` |

`tokenMeter` 与 `spillStore` 不能写进 `inject`：宿主没有该服务时插件会直接加载失败，
"拒绝替换、投影照做、保住证据"的降级路径就不可达。

## 文档

| 文档 | 内容 |
|---|---|
| [设计稿](docs/superpowers/specs/2026-11-18-dsh-token-efficiency-design.md) | 目标、证据、架构、契约、度量、风险、发布形态 |
| [宿主契约附录](docs/superpowers/plans/2026-11-18-host-contracts.md) | 逐条抄自宿主源码的接口准绳 |
| [三层委派研究](docs/research/2026-11-18-three-tier-delegation.md) | 缓存、路由阈值、压缩、校验的 25 条一手来源 |

## 许可证

Apache-2.0。机制移植自 [HarnessMM](https://github.com/YuhuaJiang2002/HarnessMM)（Apache-2.0），
随包分发 `NOTICE`。