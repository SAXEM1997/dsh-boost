# dsh-boost

通过**工具回执投影**与**确定性只读替换**降低 DeepSeek Harness（DSH）的 token 消耗。

> **状态：v1 已实现。** 投影、替换与控制面均已落地；`npm run build` 干净，测试套件全部通过。

## 它解决什么

DSH 每次模型请求都会回放全部历史。本机 300 个最长会话的实测聚合（`npm run stats`，快照时刻
`2026-11-19T03:13:21Z`）：54,141 步、54,088 个请求，合计 10,575,904,022 raw token。按步均值
195,340 token，按请求均值 195,531、中位 187,681；97.01% 的输入是缓存读。工具回执是体积主体
（bash 61.75%、read 22.13%、ssh 10.01%），而下一步真正会用到的部分通常远小于回执本身。

插件做两件事：

1. **投影**——工具回执进入上下文之前，按工具族保留头尾，把中段换成可检索的落盘句柄；
   原文仍可取回，页脚给出路径。投影按固定阈值确定性执行，不产生逐次决策。
2. **替换**——计划里重复的只读调用（`read` / `grep` / `glob`）若已有确定性证据满足守卫，
   直接提交，不再向模型要一次决策；多候选时用一个只允许返回单个标签的选择器。

v1 的预期收益区间是 **3.5%（保底）– 10.0%（上界）**，按 raw `totalTokens` 计。
这是设计阶段对一个 300 会话语料做**离线事前估算**得到的区间：不是保证，也不是从交付的
`session-snapshot.json` 能复算出来的数字（快照只存聚合计数，没有估算用的分项）——交付物里
**没有任何工具能复算它**。影子周也**不能**把这个区间变成实测百分比：影子报告只输出四个
比例（见「影子周」一节），没有总 token 分母，`boost status` 也只有绝对值；区间要被实测
取代，得等后续版本补上分母统计。

## 前置条件

- Node.js `>=22.18.0`，DSH `>=0.2.2-rc.1 <0.3.0-0`（两者都在 `package.json` 的 `engines` 里）。
- **替换只在 POSIX 上可用。** Windows（`win32`）上替换被拒绝，`boost status` 的 `degraded`
  会带 `ERR_HOST_PLATFORM_UNSUPPORTED`；投影不依赖平台，仍然工作。
- v1 面向 web profile；不支持 desktop profile。

## 安装

`dsh plugin` 要求指定 profile，剩下的参数原样转发给该 profile 目录里的 pnpm：

```bash
# 已发布到 registry 时
dsh plugin --profile <name> add dsh-boost

# 或从本地 checkout 安装（先构建；dist/ 不入库）
npm run build
dsh plugin --profile <name> add /absolute/path/to/dsh-boost
```

例如 web profile：`dsh plugin --profile web add dsh-boost`。`dsh plugin` 把操作转发给 pnpm，
所以 pnpm 必须在 PATH 上。

包里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，所以安装后宿主会把它登记为 profile 的一个
bundle，patch 的 `insert` 行落在 profile root 上。**装完必须重启 DSH**：插件在宿主启动时加载，
已经在运行的会话看不到 `boost` 工具；web profile 就是重启 `dsh web`。

## 启用

装上之后插件默认**不做事**。`scope.json` 不存在时使用 `DEFAULT_SCOPE`：

```json
{ "version": 2, "revision": 0, "mode": "selected", "workspaceIds": [], "shadow": true, "projection": "shadow" }
```

`workspaceIds` 为空时没有可见工作区：协议段不注入，投影与替换都原样放行。`boost` 工具本身
是唯一的 scope 豁免，因此没有工作区时仍然可以调用它来启用。

`boost` 是**模型工具，不是 shell 命令**——这个包没有 `bin`，启用全程都要在对话里让模型调用
它（status、scope-set、shadow 都是工具调用，没有 CLI 等价物）。例如：

> 调用 boost 工具，参数 `{"cmd":"status"}`，把 JSON 结果给我。

首次 `status` 应看到 `ok: true`；`data.scope.workspaceIds` 为空、`revision` 为 `0`，`shadow` 为
`true`、`projection` 为 `"shadow"`，`counts` 为空（**仅限全新会话**——越界会话更早的工具调用
已经各记过一条 `skip:no-scope`）。`degraded` 里出现 `ERR_SCOPE_READ_FAILED`
是正常的：`scope.json` 还不存在，插件正落在 fail-closed 默认值上。第一次成功的 `scope-set`
会创建这个文件。

然后列出要暴露的工作区：

```json
{
  "cmd": "scope-set",
  "body": {
    "mode": "selected",
    "workspaceIds": ["<workspace-id>"],
    "shadow": true,
    "projection": "shadow"
  },
  "baseRevision": 0
}
```

- `workspaceIds` 是宿主的 workspace UUID，不是路径；宿主通过 workspace registry 把 agent 的
  cwd 映射成这个 id。**发现 UUID 本身有摩擦**：要么问宿主/翻会话记录，要么自己读
  `$DSH_HOME/storages/workspace.json` 的 `tables.workspaces`（id ↔ path 的映射表）——v1 没有
  任何命令替你做这件事。找不到 UUID 且是单用户机器时，可以用 `"mode": "global"` 放开到所有
  **已定义**的工作区；没有工作区的会话仍然不可见。
- `baseRevision` 取你刚读到的 `data.scope.revision`（首次写入是 `0`）。这是 compare-and-swap：
  revision 过期会返回 `ERR_SCOPE_REVISION_CONFLICT`，重读 `status` 再试。
- `body` 里的 `version` 与 `revision` 是 store 自有的，带这两个字段会被拒绝。

写入成功后再 `status` 一次，健康输出应当满足：

- `ok: true`，`data.scope.workspaceIds` 含刚写入的 id，`data.scope.revision` 变成 `1`（每次写加一）。
- `data.shadow` 为 `true`，`data.projection` 为 `"shadow"`——正是影子周的状态。
- `data.degraded` 为空（POSIX、宿主有 token meter 与 spill 后端时）；`estimate_kind` 为
  `"host"`，`fixedOverheadTokens` 是一个数字，不是 `"unknown"`。
- `data.counts` 一开始通常为空——但**控制调用自己也计数**：可见工作区为空时，`boost`
  自己的调用同样要过 post-execute 的 scope 门（那里没有 boost 豁免，豁免只在工具注册层），
  每条记一次 `skip:no-scope`。正常工具调用后会累积，例如出现 `projection-shadow` 条目。

节选（数值示意；账目字段有省略）：

```json
{
  "ok": true,
  "data": {
    "scope": { "mode": "selected", "workspaceIds": ["<workspace-id>"], "revision": 1 },
    "shadow": true,
    "projection": "shadow",
    "degraded": [],
    "fixedOverheadTokens": 772,
    "estimate_kind": "host",
    "counts": { "skip:no-scope": 2 }
  }
}
```

示例里的 `counts` 不是空对象：启用流程中前两次控制调用（`status`、`scope-set`）发起时还没有
可见工作区，每次各记了一条 `skip:no-scope`（post-execute 的 scope 门不豁免 `boost` 自身）。

`fixedOverheadTokens` 是启动时实测的固定开销**合计**：协议段 379 + `boost` 工具 schema 393 =
772（本 checkout）。它不是从使用量里推断的。**哪个数字适用于当前请求取决于 scope**：`boost`
工具 schema（393）只要插件装配就常驻——`boost` 是唯一的 scope 豁免，始终留在工具声明里；
协议段（379）只在有可见工作区时注入，`selected + []` 下该段文本为空，**每请求固定开销实际是
393**。`status` 汇报的始终是合计 772，不随 scope 翻转；上面示例里工作区已选中，772 就是当时的
真实每请求开销。

## 影子周

设计选择**影子优先**：先用一周只记账（不合成回合、不跳过调用，投影只记账不改内容），再决定
是否真的投影与替换。**「什么都不改」并不成立**：只要有可见工作区，协议段（379 token）就会
注入系统提示；多候选计划仍会**真实调用一次选择器**（一次独立的辅助模型请求）。影子周按设计
零节省，它只产出下一节的四个比例。`scope.json` 里有两个独立开关：

| 开关 | 取值 | 行为 |
|---|---|---|
| `shadow` | `true` | 替换决策只记账（`kind:'shadow'` 收据），不合成、不跳过任何调用 |
| | `false` | 守卫满足的 `read` / `grep` / `glob` 调用会被真正替换 |
| `projection` | `off` | 完全不投影 |
| | `shadow` | 只计算“如果投影会省多少”，不改模型可见 content，不写 spill |
| | `on` | 先把完整原文交给宿主 spill 后端，再把回执换成 head + 页脚 + tail |

推荐的顺序：

1. **第一周**：按上面的 `scope-set` 使用 `shadow: true`、`projection: 'shadow'`，照常工作。
2. **读报告**：在仓库 checkout 里跑
   `node scripts/shadow-report.mjs --dir "${DSH_HOME:-$HOME/.dsh}/boost/receipts"`。
   这个脚本是 dev-only，不在 npm tarball 里。它输出四个标签：
   `saveableRatio`（白名单能兑现的替换占比 = `whitelisted` 影子提交 / **全部**替换决策——分母
   是每一次替换决策，不只是白名单调用；影子期全族记账，bash/ssh 的潜力看 `byFamily`）、`byFamily`（按候选工具族的命中率）、
   `candidateRecall`（候选集召回）、`retrievalUpperBound`（取回率上界；影子期没有真正投影，
   结构上恒为 `0`）。
3. **打开投影**：报告支持的话，保持 `shadow: true`，把 `projection` 改成 `'on'`：

   ```json
   { "cmd": "scope-set", "body": { "projection": "on" }, "baseRevision": 1 }
   ```

   `scope-set` 只覆盖你传入的字段，其余保持不变。此时回执开始真正被替换，但替换决策仍然只记账。
4. **再打开替换**：直接把影子关掉——**先检查再关是无效顺序**：影子期从不合成回合，
   `content[].thinking` 的 400 在结构上不可能出现，关影子之前检查它永远只能读到「未见」。
   把 `shadow` 设为 `false` 之后，按 [docs/RELEASE.md](docs/RELEASE.md) §4 在**第一个真正
   被替换的回合**检查该 400，并在此后的每个替换观察窗继续记录：

   ```json
   { "cmd": "shadow", "body": false, "baseRevision": 2 }
   ```

`projection: 'on'` 依赖宿主的 spill 后端。后端缺失时，超限回执**不投影**，原文完整进入历史
（收据 `projection-skipped:no-spill`，`status.degraded` 带 `ERR_HOST_NO_SPILL`）。影子模式
不需要 spill。

## 配置

`cordis.patch.yml` 里的 `config` 是**整体替换**，不做深合并：缺键回落插件默认值。但要注意：
`resolveConfig` 会用默认值填满**全部五个工具族**（`read` / `grep` / `glob` / `bash` / `ssh`），
所以**删掉一个族不是关掉它**——删掉 `projection.bash` 只会让 bash 按默认的 4000/2000/500
投影。要真正关掉一个族，把它的 `triggerChars` 提到你所有回执之上；投影的字节上限是 256 KiB，
`300000` 足以让该族全部不触发（不存在 per-family 的 off 键）。

配置里的 `projection.*` 是**窗口**，不是开关；开关在 `scope.json` 的 `projection` 字段，
由 `boost scope-set` 写。

| 键 | 默认值 | 作用 |
|---|---|---|
| `projection.read.triggerChars` / `headChars` / `tailChars` | 3000 / 2000 / 500 | `read` 回执超过 3000 字符时保留头 2000、尾 500 |
| `projection.grep.*` | 700 / 400 / 100 | `grep` 窗口 |
| `projection.glob.*` | 700 / 400 / 100 | `glob` 窗口 |
| `projection.bash.*` | 4000 / 2000 / 500 | `bash` 窗口 |
| `projection.ssh.*` | 2000 / 1200 / 300 | `mcp__ssh__*`（如 `mcp__ssh__execute-command`）窗口 |
| `admission.thresholdTokens` | 1024 | 每个候选进入替换所需的最小净节省；唯一候选的确定性提交豁免 |
| `selector.maxTokens` | 512 | 多候选选择器的输出预算（输入 + 输出上界从节省里扣） |
| `stepsPerTurn` | 8 | 每个 turn 的替换步数上限 |
| `horizonSteps` | 20 | 算不出会话历史均值时的剩余步数 horizon |
| `historyTurns` | 5 | 求步数均值所用的最近 turn 数 |

字符按 Unicode 码点计。错误回执与超过 256 KiB 的回执不投影。

不变量不是 `triggerChars ≥ headChars + tailChars + 1`。真实替换串是 head line + head + 页脚 +
tail + 3 个换行；页脚由宿主 `formatSpillNotice` 生成，约 190 字符（68 字符 locator、5 位省略
字节数、宿主固定 retrieval hint）。grep/glob 默认 400+100 时：
`400 + 100 + 50（head line） + 192（页脚） + 3 = 745 > 700`。于是刚过 700、约 745 以下的回执
会被 `truncate` 判定“可裁”，但 `projectApply` 组装后并不短于原文，直接返回原文——这是死区，
不是净亏。运行时的 `assembled.length >= text.length` 检查保证投影绝不会让回执变长；要消除
死区，把 `triggerChars` 提到至少这个和（例如 grep/glob 用 800），或缩小窗口。页脚长度会随
locator 与数字位数浮动。

（`projection: 'shadow'` 定价只含 `(Omitted N bytes.)` 省略句，不含 locator/页脚全文，所以
影子账的 `after` 是下界；apply 路径在写入后还会再核对一次。）

## Bundle patch

`cordis.patch.yml` 只有一条 `insert`，落在 profile root 上：

```yaml
- insert:
    - id: dsh-boost
      name: 'dsh-boost'
      config:
        projection:
          read:  { triggerChars: 3000, headChars: 2000, tailChars: 500 }
          grep:  { triggerChars: 700,  headChars: 400,  tailChars: 100 }
          glob:  { triggerChars: 700,  headChars: 400,  tailChars: 100 }
          bash:  { triggerChars: 4000, headChars: 2000, tailChars: 500 }
          ssh:   { triggerChars: 2000, headChars: 1200, tailChars: 300 }
        admission: { thresholdTokens: 1024 }
        selector:  { maxTokens: 512 }
        stepsPerTurn: 8
        horizonSteps: 20
        historyTurns: 5
```

宿主对顶层 `insert` 行**不做任何 id/name 匹配**：加载器（cordis-plugin-include 的
`applyEntryPatches`）直接把行 push 进装配计划，不存在「匹配不上就静默跳过」的路径。这两个
等式另有用途——**plugin manager 用它们把运行中的 entry 归属到本 bundle 的行**（`dsh-plugin-manager`
的 in-use / 可寻址判定，见 `listPlugins` / `removeBundle`）：

```text
row.id   === entry.options.id
row.name === entry.options.name
```

`id` 与 `name` **不需要彼此相等**：第三方插件 `dsh-mcp-btwy`（用户 profile 里自装的 GitHub
包，不是宿主自带的 patch）就写成 `id: dsh-mcp-server`、`name: dsh-mcp-btwy`。本包让四个名字
全部保持为 `dsh-boost`（npm 包名、导出的插件 `name`、patch 行的 `id` 与 `name`），这样
plugin manager 才能把运行中的 entry 认成本包的行、通过 profile patch 寻址与移除；等式不成
立时行**照常装配**，只是在管理面变成不可寻址（读写状态、移除判定都会失灵），而 `name` 指到
不存在的包时加载会**响亮地**失败，不是静默。

## 状态、回滚与卸载

状态在 `$DSH_HOME/boost/`（`$DSH_HOME` 未设置时回退 `~/.dsh`）：

- `scope.json`——暴露面的唯一事实来源（version 2，带 revision）。
- `scope.lock`——写路径的短锁，正常写入结束后删除。
- `receipts/<encoded-session>.jsonl`——追加式收据。除元数据外，每行还携带：回执前 256 个
  码点的 preview（不存 stdout 全文）、**绑定后的参数 `args`（模型所写，截到 2048 个码点，
  超长会以 `args_truncated` 标记的截断 JSON 落盘——`write` / `edit` 的参数可携带整段文件
  内容，同样入账）**、计划 goal（≤256 码点）与守卫（≤8 条，各 ≤300 码点）。

`projection: 'on'` 时，完整原文在替换发生**之前**写入宿主的 spill 后端，页脚 locator 可以用
`read` / `grep` 取回。投影不会丢掉唯一副本；spill 写入失败就不替换（收据记 `spill-failed`，
页脚失败记 `footer-failed`）。

回滚与停用：

- **关掉两个行为**（不再投影、不再替换，但仍然可见的工作区——`selected` 下已选的、`global`
  下全部已定义的——会继续注入协议段，替换决策仍写影子收据，固定开销照旧）：

  ```json
  { "cmd": "scope-set", "body": { "projection": "off", "shadow": true }, "baseRevision": 1 }
  ```

- **回到真正惰性**：把 `mode` 设回 `selected` 并清空列表。**注意 `workspaceIds` 只在
  `selected` 模式下起作用**：`isVisible` 对 `mode:"global"` 恒为真（`src/scope/doc.ts`，
  `global` 分支根本不读列表），所以**先处于 `global` 时只写 `workspaceIds: []` 什么都停不
  下来**——投影与替换会照常进行，而你以为已经回滚了。在 `selected` 下移除单个工作区即可；
  在 `global` 下必须同时改 `mode`：

  ```json
  { "cmd": "scope-set", "body": { "mode": "selected", "workspaceIds": [] }, "baseRevision": 2 }
  ```

  `selected` + 空列表时协议段、投影、替换全部停止（只剩下 `boost` 工具 schema 的常驻开销）。

- **卸载插件**：`dsh plugin --profile <name> remove dsh-boost`，然后重启 DSH。
- 删除 `$DSH_HOME/boost` 会清掉 scope 与收据（回到默认），但不会删除宿主 spill 后端里已经
  写出的原文文件。

## 宿主依赖

`inject` 是硬依赖：`tools`、`llm`、`systemPrompt`——缺任一，插件加载失败。

| 依赖 | 形态 | 缺失时 |
|---|---|---|
| `workspaceRegistry` | 软（`ctx.get('workspaceRegistry')`） | **什么都用不了**：cwd 永远映射不到工作区 id，一切按 fail-closed 视为不可见——协议段不注入、投影与替换全部跳过，只有 `skip:no-scope` 收据在涨；`status.degraded` 带 `ERR_HOST_NO_WORKSPACE_REGISTRY`。这是「装上了却什么都不发生」的唯一解释 |
| `tokenMeter` | 软（`ctx.get('tokenMeter')`） | 拒绝替换；投影仍可用，投影账记 `unknown`（不伪造数字）；`status.degraded` 带 `ERR_HOST_NO_TOKENMETER` |
| `spillStore` | 软（`ctx.get('spillStore')`） | `projection: 'on'` 时超限回执不投影（保住证据），`projection-skipped:no-spill`；`status.degraded` 带 `ERR_HOST_NO_SPILL` |
| `@deepseek-ai/dsh-token-meter/estimate` | 软（动态 import） | 固定开销无法测量，`fixedOverheadTokens` 为 `'unknown'`；`status.degraded` 带 `ERR_HOST_NO_ESTIMATOR` |
| `win32` 平台 | 运行时检查 `isPosixOnly()` | 拒绝替换，投影照常；`status.degraded` 带 `ERR_HOST_PLATFORM_UNSUPPORTED` |
| `tools.resolve` 的步骤级 `when` | 软探测 | 整族（含 `boost` 工具）不注册，`ERR_HOST_NO_STEP_WHEN`；它通常出现在注册警告里，`status` 本身不可用 |

`ERR_HOST_NO_TOKENMETER` 与 `ERR_HOST_NO_ESTIMATOR` 是**两件不同的事**，不要合并：
前者是宿主服务（`ctx.get('tokenMeter')`）不存在，替换被拒绝；后者是纯估算包
`@deepseek-ai/dsh-token-meter/estimate` 不可达，只影响固定开销的数字。一个可以存在而另一个
不存在；合并会把操作者引到错误的宿主上。`ERR_HOST_NO_SPILL` 只在 `projection: 'on'` 时报告，
影子模式不碰 spill，报它只会制造噪音。

`tokenMeter` 与 `spillStore` 不能写进 `inject`：宿主没有该服务时插件会直接加载失败，
“拒绝替换、投影照做、保住证据”的降级路径就不可达。

## v1 的边界

- 只做两件事：**就地替换工具回执**，以及**替换只读调用**（`read` / `grep` / `glob`）。
- **不批量执行工具调用**（没有 PTC / `run_code`，设计 N1）。
- **不去重、不合并工具调用**（设计 N5）——这条完全没开工，且 v1 **没有任何工具能测出重复
  调用率**：设计稿里用来触发重启判定的「影子周重复率统计」没有交付，`shadow-report.mjs`
  不产出它。
- **影子周按设计零节省**：只记账（协议段照注入、选择器照调用），它的产出是四个比例，
  不是省下的 token。
- **v1 不评判「结果更好」**：只有 token 账目与 20 任务回退门，没有任何质量指标；「替换后
  结果质量」在 v1 是不可判的。
- **装上但未启用是小的净亏**：`boost` 工具只要插件装配就注册，schema 实测 393 token/请求
  常驻（见「启用」一节的分解），收益为零。
- **不支持 desktop profile**（设计 D6）。
- 不替换、也不接管 DSH 的压缩、剪枝与 spill 决策（设计 N3）；投影只改模型可见 content，
  原文仍借宿主 spill 存放。
- 不做模型训练或权重改动（N2）；不追求论文里的 87.93%（N4）。
- 不承诺 10%：3.5% 是保底线，10% 是全程存活的理想上界；影子周实测只用于收窄区间。

## 文档

以下文档在**仓库**里，不在 npm tarball 里（`files` 只带 `dist`、`src`、`locale`、
`cordis.patch.yml`、两份 README、`LICENSE`、`NOTICE`）。在 npm 页面上请从仓库读取。

| 文档 | 内容 |
|---|---|
| [设计稿](docs/superpowers/specs/2026-11-18-dsh-token-efficiency-design.md) | 目标、证据、架构、契约、度量、风险、发布形态 |
| [宿主契约附录](docs/superpowers/plans/2026-11-18-host-contracts.md) | 逐条抄自宿主源码的接口准绳 |
| [三层委派研究](docs/research/2026-11-18-three-tier-delegation.md) | 缓存、路由阈值、压缩、校验的 25 条一手来源 |
| [发布验收](docs/RELEASE.md) | `npm pack` / isolated 安装、两条软依赖降级路径、20 任务回归门、影子周与统计复算 |

## 许可证

Apache-2.0。机制移植自 [HarnessMM](https://github.com/YuhuaJiang2002/HarnessMM)（Apache-2.0），
随包分发 `NOTICE`。