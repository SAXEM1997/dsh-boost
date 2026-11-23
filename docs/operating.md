# 运维：安装、启用、回滚与排障

> 本文回答什么问题：怎么装、怎么启用、怎么回滚、每个配置键与降级码是什么意思，以及 v1 明确
> 不做什么。原理与数字口径见[原理](how-it-works.md)；发布验收见 [`docs/RELEASE.md`](RELEASE.md)。
> 回到 [README](../README.md)。

## 安装与版本

### 前置条件

- Node.js `>=24.9.0`，DSH `>=0.2.2-rc.4 <0.2.3-0`（**区间**，不是精确钉法；宿主按
  `includePrerelease` 语义判定，不满足时会直接停用插件，而 `0.2.2-rc.5` 与本插件触及的宿主包
  逐字节相同）。两者都在 `package.json` 的 `engines` 里；Node 下限对齐宿主
  `@deepseek-ai/dsh@0.2.2-rc.4`。
- **本包不声明任何 peerDependencies**：安装它不会带出任何 `@deepseek-ai/*` 包，模块脱离它们也能
  加载；运行时能力（`tokenMeter`、`spillStore`、估算器、页脚格式化器）由 DSH 宿主进程提供，
  缺失时走降级（见[降级码与错误码](#降级码与错误码)）。
- **替换只在 POSIX 上可用。** Windows（`win32`）上替换被拒绝，`boost status` 的 `degraded`
  会带 `ERR_HOST_PLATFORM_UNSUPPORTED`；投影不依赖平台，仍然工作。
- v1 面向 web profile；不支持 desktop profile。

### 安装命令

`dsh plugin` 要求指定 profile，剩下的参数原样转发给该 profile 目录里的 pnpm：

```bash
# 从 registry 安装：npmjs 上的 latest 是 0.3.4（本仓库 .npmrc 与 lockfile
# 也已钉在 npmjs，见下）
dsh plugin --profile <name> add dsh-boost@^0.3.4 --registry=https://registry.npmjs.org/

# 或从本地 checkout 安装（先构建；dist/ 不入库）
npm run build
dsh plugin --profile <name> add /absolute/path/to/dsh-boost
```

例如 web profile：`dsh plugin --profile web add dsh-boost@^0.3.4 --registry=https://registry.npmjs.org/`。
`dsh plugin` 把操作转发给 pnpm，所以 pnpm 必须在 PATH 上。

### 版本与 registry

> **`^0.3.4` 是当前的安全钉法。** `registry.npmjs.org` 上 `latest` 是 `0.3.4`，历史版本依次是
> `0.3.3`、`0.3.2`、`0.3.1`、`0.3.0`、`0.2.7`、`0.2.6`、`0.2.5`、`0.2.4`、`0.2.3`、`0.2.2`、`0.2.1`、`0.2.0`、
> `0.1.4`、`0.1.3`、`0.1.2`、`0.1.1`、`0.1.0`，以及首次发布时 npm 自动创建的占位版本
> `0.0.0-stage`——**不要安装 `0.0.0-stage`**，它不是可用构建。`0.2.0` 新增了设置页（`dsh.client`
> 与 `./client` 出口、`/dsh-boost/api` 路由、随包发布的 `lib/client.js`）与中英双语；`0.3.0` 新增
> 回执蒸馏（默认关闭），`0.3.2` 修了「每次蒸馏都被自己抽干」的缺陷，`0.3.4` 让产物跨会话保留并加了回本预判——**`0.3.0`/`0.3.1` 的蒸馏从未
> 生效过**，要用就装 `0.3.2` 及以上。`0.1.4` 及更早**没有设置页**，`^0.1.4` 也不会解析到 `0.3.x`
> （`^` 不跨大版本），所以从 `0.1.x`/`0.2.x` 升上来要显式写 `@^0.3.2`。本仓库已把 `.npmrc` 与
> lockfile 钉在 npmjs，但**你机器上的全局 npm 配置**可能仍指向一个尚未同步 `0.3.2` 的镜像：那是
> 本机配置，不是本仓库的状态。在意 registry 时显式传 `--registry=https://registry.npmjs.org/`；
> 镜像滞后时 `@^0.3.2` 会在同步前解析失败。

### 包装形态与重启

包是 ESM（`"type": "module"`），`exports` 的 `.` 条目同时映射 `require` / `default`：Node ≥ 24.9
下 `require('dsh-boost')` 与 `import` 加载同一份代码，装好的包里**不做任何构建**（`files` 只带
`dist`、`locale`、`cordis.patch.yml`、两份 README、`LICENSE`、`NOTICE`，不带 `src/`；`dist` 的
sourcemap 内联了源码）。

包里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，所以安装后宿主会把它登记为 profile 的一个
bundle，patch 的 `insert` 行落在 profile root 上。**装完必须重启 DSH**：插件在宿主启动时加载，
已经在运行的会话看不到 `boost` 工具；web profile 就是重启 `dsh web`。

## 启用

装上之后插件默认**不做事**。`scope.json` 不存在时使用 `DEFAULT_SCOPE`：

```json
{ "version": 2, "revision": 0, "mode": "selected", "workspaceIds": [], "shadow": true, "projection": "shadow" }
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `version` | `2` | store 自有；`scope-set` 的 `body` 里带它会被拒绝 |
| `revision` | `0` | store 自有；每次写加一，用作 CAS 的 `baseRevision` |
| `mode` | `"selected"` | `selected` 只看 `workspaceIds`；`global` 放开到所有**已定义**工作区 |
| `workspaceIds` | `[]` | 宿主的 workspace UUID 列表，不是路径；只在 `selected` 下起作用 |
| `shadow` | `true` | `true` 只记账；`false` 真正替换守卫满足的 `read` / `grep` / `glob` |
| `projection` | `"shadow"` | `off` / `shadow` / `on`；开关在这里，不在 `cordis.patch.yml` |

`workspaceIds` 为空时没有可见工作区：协议段不注入，投影与替换都原样放行，但每个工具调用仍会
记一条 `skip:no-scope` 收据——但 PTC 内层调用（`exec.parent` 存在）与被取消的调用在 scope 门
之前就返回，两条都不记。`boost` 工具本身是唯一的 scope 豁免，因此没有工作区时仍然可以调用它来
启用；它在 scope 外也始终可见。

`boost` 是**模型工具，不是 shell 命令**——这个包没有 `bin`，启用全程都要在对话里让模型调用它
（status、scope-get、scope-set、shadow 都是工具调用，没有 CLI 等价物）。例如：

> 调用 boost 工具，参数 `{"cmd":"status"}`，把 JSON 结果给我。

### 第一次 status

首次 `status` 应看到 `ok: true`；`data.scope.workspaceIds` 为空、`revision` 为 `0`，`shadow` 为
`true`、`projection` 为 `"shadow"`，`counts` 为空（**仅限全新回执根**——`scan()` 读全部分片，
同一 DSH home 里别的会话早先的越界调用已经各记过一条 `skip:no-scope`）。首次 `status` 的
`degraded` 里**不会**因为 `scope.json` 缺失而出现 `ERR_SCOPE_READ_FAILED`：缺失是干净的默认值
（`ENOENT` 不带降级码，`src/scope/store.ts`）；全新根目录且宿主能力齐全时，`degraded` 就是空
数组。在 `status` 的读取路径上，`ERR_SCOPE_READ_FAILED` 只表示文件**存在但读不出来**（权限、
I/O、路径是目录等）——那不是正常的首次状态，要先修掉。写不进去是另一个码
`ERR_SCOPE_WRITE_FAILED`（磁盘满、目录权限），页面拿到它会让你原样重试而不是重读——基线还在，
重读会丢掉草稿。第一次成功的 `scope-set` 会创建这个文件。

### 写入作用域

列出要暴露的工作区：

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
  cwd 映射成这个 id。**发现 UUID 本身有摩擦**：要么问宿主/翻会话记录，要么自己读宿主的
  `<hostDshHome>/storages/workspace.json` 的 `tables.workspaces`（id ↔ path 的映射表）——v1
  没有任何命令替你做这件事。宿主的 home 解析顺序是「非空 `$DSH_HOME`（`~` 会展开）→
  `~/.dsh`」，所以默认安装下文件是 `~/.dsh/storages/workspace.json`，**不是**
  `$DSH_HOME/storages/workspace.json`（除非 `$DSH_HOME` 真的设了）。注意 `config.dshHome`
  只移动插件的 `<dshHome>/boost`，不会移动宿主的这个文件。找不到 UUID 且是单用户机器时，
  可以用 `"mode": "global"` 放开到所有**已定义**的工作区；没有工作区的会话仍然不可见。
- `baseRevision` 取你刚读到的 `data.scope.revision`（首次写入是 `0`）。这是 compare-and-swap：
  revision 过期会返回 `ERR_SCOPE_REVISION_CONFLICT`，重读 `status` 再试。调用被调用方的取消
  信号打断时返回 `ERR_SCOPE_ABORTED`：锁已释放、`scope.json` 原样未动，重读 `revision` 重试
  即可，不留残留。
- `body` 里的 `version` 与 `revision` 是 store 自有的，带这两个字段会被拒绝。

### 写入后的健康检查

写入成功后再 `status` 一次，健康输出应当满足：

- `ok: true`，`data.scope.workspaceIds` 含刚写入的 id，`data.scope.revision` 变成 `1`（每次写加一）。
- `data.shadow` 为 `true`，`data.projection` 为 `"shadow"`——正是影子周的状态。
- `data.degraded` 为空（POSIX、宿主有 token meter 与 spill 后端时）；`estimate_kind` 为
  `"host"`，`fixedOverheadTokens` 是一个数字，不是 `"unknown"`。若估算包
  `@deepseek-ai/dsh-token-meter/estimate` 不可达，`fixedOverheadTokens` 会是字符串
  `"unknown"`（不是 0），`degraded` 带 `ERR_HOST_NO_ESTIMATOR`；此时 `estimate_kind` 仍可能是
  `"host"`，因为 token meter 服务还在——两件事不要混。
- `data.hasSpill` 为 `true`（宿主**提供** spill 服务的存在性）。它**不表示可用**：服务在但
  没有 `saveText` 时仍是 `true`，`degraded` 会带 `ERR_HOST_SPILL_UNUSABLE`。打开
  `projection: 'on'` 前要同时看这两个字段；只看 `hasSpill` 会把一个不可用的后端当成可用。
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
    "fixedOverheadTokens": 778,
    "estimate_kind": "host",
    "counts": { "skip:no-scope": 2 }
  }
}
```

示例里的 `counts` 不是空对象：启用流程中前两次控制调用（`status`、`scope-set`）发起时还没有
可见工作区，每次各记了一条 `skip:no-scope`（post-execute 的 scope 门不豁免 `boost` 自身）。

`fixedOverheadTokens` 是启动时实测的固定开销**合计**：协议段 379 + `boost` 工具 schema 399 =
778（本 checkout）。它不是从使用量里推断的；估算包不可达时它是字符串 `'unknown'`，不是 778，
也不是 0，`status.degraded` 同时带 `ERR_HOST_NO_ESTIMATOR`。**哪个数字适用于当前请求取决于
scope**：`boost` 工具 schema（399）只要插件装配就常驻——`boost` 是唯一的 scope 豁免，始终留在
工具声明里；协议段（379）只在有可见工作区时注入，`selected + []` 下该段文本为空，**每请求固定
开销实际是 399**。`status` 汇报的是合计 778（估算包不可达时是 `'unknown'`），不随 scope 翻转；
上面示例里工作区已选中，778 就是当时的真实每请求开销。设计预算与缓存含义见
[原理的协议段一节](how-it-works.md#协议段与常驻开销)。

### 设置页的两个危险开关

设置页在投影切到 `on` 时提示 spill 前置条件，在关影子时提示盯一次 `content[].thinking` 的
400；两处都给回滚办法，都**只提示不做硬门**。硬门在这里只会给出「已检查过」的错觉：当前路由
是不是 Anthropic 兼容的 thinking 模式，在这台机器上查不出来。页面里的**生效配置是只读的**，
要改配置得编辑 profile 的 `cordis.patch.yml`。作用域冲突时页面给出
`ERR_SCOPE_REVISION_CONFLICT` 并保留你的草稿，由你决定要不要按磁盘上的文档重来。

## 影子周

设计选择**影子优先**：先用一周只记账（不合成回合、不跳过调用，投影只记账不改内容），再决定
是否真的投影与替换。**「什么都不改」并不成立**：`boost` 工具 schema（399 token）只要插件装配
就常驻；只要有可见工作区，协议段（379 token）还会注入系统提示——推荐配置下每请求固定成本
**778**；多候选计划仍会**真实调用一次选择器**（一次独立的辅助模型请求）。影子周不省任何
token，它只产出下一节的四个比例；`selected + []` 下协议段为空，固定成本仍有 **399**。

其中 `saveableRatio`、`byFamily`、`candidateRecall` 提供的是**替换侧的标签，不单独决定
是否开启替换**：白名单能兑现多少替换决策、命中落在哪些工具族、提交产出率多高——也就是
替换打开后会不会真的触发、主要落在哪些族。报告**没有总 token 分母**，所以这些标签判断不了
净收益；它们也**不能决定发布**：v1 按正常版本发布，不把影子期收益当发布门；这个决定是
**实现者在设计阶段做的，不是用户裁决**——用户只接受了为期一周的影子期，没有裁定影子结果
是否该当发布门。它们也**不能测出节省**：`retrievalUpperBound` 在影子期结构性为 `0`（它只
统计 `projection:'on'` 的已应用投影取回），连投影的取回损害都约束不了。投影的放行依据只有
可见性契约（原文可经页脚取回），不是影子标签，也**不是事后检测**：v1 没有误截检测器——
`src/admission/retrieval.ts` 只按精确 locator 统计取回次数，设计稿 §6.1 也写明损害度量未
交付、取回计数不是损害上界。唯一的护栏是模型能取回原文；而「发生过取回」只是信号，不是
「没有误截」的证明。

**全零周不能区分两件事。** 如果模型整周没有写 `<CHISEL_PLAN>`，就没有任何决策收据，
四个比例全是 `0`；这与「没有可省项」在报告里长得一模一样——报告不测 plan 发射率。看到
全零时先查收据里有没有替换决策（`kind:'shadow'` / `kind:'skip'`），不要直接读成
「插件没有效果」。

### 两个开关

`scope.json` 里有两个独立开关：

| 开关 | 取值 | 行为 |
|---|---|---|
| `shadow` | `true` | 替换决策只记账（`kind:'shadow'` 收据），不合成、不跳过任何调用 |
| | `false` | 守卫满足的 `read` / `grep` / `glob` 调用会被真正替换 |
| `projection` | `off` | 完全不投影 |
| | `shadow` | 只计算“如果投影会省多少”，不改模型可见 content，不写 spill |
| | `on` | 先把完整原文交给宿主 spill 后端，再把回执换成 head + 页脚 + tail |

### 推荐顺序

1. **第一周**：按上面的 `scope-set` 使用 `shadow: true`、`projection: 'shadow'`，照常工作。
2. **读报告**：在仓库 checkout 里跑
   `node scripts/shadow-report.mjs --dir "<root>/receipts"`，其中 `<root>` 是装配日志打印的
   `root=`（即 `<dshHome>/boost`；`dshHome` 配置优先于 `$DSH_HOME`，两者都未设时回退
   `~/.dsh`）。这个脚本是 dev-only，不在 npm tarball 里。它输出四个标签：
   `saveableRatio`（白名单能兑现的替换占比 = `whitelisted` 影子提交 / **全部**替换决策——分母
   是每一次替换决策，不只是白名单调用；影子期全族记账，bash/ssh 的潜力看 `byFamily`）、
   `byFamily`（按候选工具族的命中率）、`candidateRecall`（**提交产出率，不是候选集召回**：
   `commits / (commits + noCandidate)`；脚本从不拿候选集去比对模型实际的下一调，所以它回答
   「有候选的决策里多少提交了」，不回答「候选集漏没漏掉模型真正要做的调用」）、
   `retrievalUpperBound`（**已观测取回率的下界，不是取回损害的上界**；影子期没有真正投影，
   结构上恒为 `0`）。
3. **打开投影**：投影的放行不靠影子标签（依据是可见性契约：原文可经页脚取回；v1 没有
   误截检测器）。先确认 `status.data.hasSpill` 为 `true` **且** `degraded` 不含
   `ERR_HOST_SPILL_UNUSABLE`——前者只证明宿主**提供**服务，后者才说明服务可用；再保持
   `shadow: true`，把 `projection` 改成 `'on'`：

   ```json
   { "cmd": "scope-set", "body": { "projection": "on" }, "baseRevision": 1 }
   ```

   `scope-set` 只覆盖你传入的字段，其余保持不变。此时回执开始真正被替换，但替换决策仍然只记账。
4. **再打开替换**：影子报告显示白名单命中与提交产出率可接受时，直接把影子关掉——**先检查再关
   是无效顺序**：影子期从不合成回合，`content[].thinking` 的 400 在结构上不可能出现，
   关影子之前检查它永远只能读到「未见」。这个 400 **只能在真实替换发生后观察**，不存在
   「提前验证」的路径。把 `shadow` 设为 `false` 之后，按
   [`docs/RELEASE.md`](RELEASE.md) §4 在**第一个真正被替换的回合**检查该 400，并在此后的每个
   替换观察窗继续记录：

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
| `admission.thresholdTokens` | 1024 | 每个候选进入替换所需的最小净节省；**单步计划豁免**（`plan.steps.length === 1`，`src/hooks/post-execute.ts` 的 `admittedFor`）——计划只有一步时没有选择器可付，阈值不适用。不是「确定性 && 唯一候选」：多步计划即使只剩一个候选，仍要过阈值（`src/admission/ledger.ts` 的 `worthSubstituting`） |
| `selector.maxTokens` | 512 | 多候选选择器的输出预算（输入 + 输出上界从节省里扣） |
| `stepsPerTurn` | 8 | 每个 turn 的替换步数上限 |
| `horizonSteps` | 20 | 算不出会话历史均值时的剩余步数 horizon |
| `historyTurns` | 5 | 求步数均值所用的最近 turn 数 |
| `dshHome` | `$DSH_HOME`，未设则 `~/.dsh` | 状态根前缀：实际用 `<dshHome>/boost`，且优先于 `$DSH_HOME`；空白或非字符串视为未设，相对路径按装配时 cwd 解析一次。装配日志会打印解析后的 `root=` |

### 蒸馏（`distillation.*`，默认关闭）

回执蒸馏让快速模型把一条 `bash`/`ssh` 回执压成一段可核验的正文，用它替换截断视图。机制与
取舍见 `docs/adr/0001-receipt-pinned-distillation.md`。

| 键 | 默认值 | 作用 |
|---|---|---|
| `distillation.enabled` | `false` | 总开关。关着时**一次模型调用都不发**，也不产生 `distilled/` 产物 |
| `distillation.families` | `['bash','ssh']` | 只对这些族蒸；空数组表示不蒸任何族（页面渲染为「（无）」） |
| `distillation.triggerChars` | `null` | 预门：回执短于它就根本不试。`null` 表示用该族投影的 `triggerChars` |
| `distillation.maxOutputTokens` | 256 | 蒸馏调用的输出预算 |
| `distillation.timeoutMs` | 3000 | 超过它就放弃这次调用（迟到的答案仍会落盘并另记一条 `distill-late`） |
| `distillation.route` | `null` | `null` 表示复用边界路由；给了就显式指定一个更便宜的模型 |

运行态在 `status.distill`：`calls`（真花掉的调用数）、`tokens`（完成 token）、`input_chars`
（送进去的字符数——它是成本主体，`tokens` 只是输出侧）、`adopted`（采用次数，**含读表重放**，
所以可能大于 `calls`）、`rejected`、`failed`。收据码见 `docs/RELEASE.md` 的 `distill-*` 段。

**两道门，各管一件事**：采用后的**字节门**只看视图大小——「蒸馏正文 + 页脚」按 UTF-8 字节严格
短于同回执的截断视图，它回答「每次重放是不是更小」。调用之前的**回本预判**回答另一件事：
`最乐观节省（截断视图 − 页脚，含被保留的信号行）× max(1, 剩余步数)` 必须**大于**
`回执输入 + 输出预算`，否则不调模型（`distill-rejected:not-worth-it`）。前者保证每次重放都更小，
后者保证这次调用本身赚得回来；两者都过才值得做。挡掉的只有「无论蒸成什么样都赚不回」的情形，
典型是剩余步数很少的会话末段。三种情况这道门**弃权**（照常调用，不记成本码）：宿主没有估算器、
没有可用的剩余步数、估算器答不出价格（抛错或非有限数）；回执本身没有可比的截断视图（未过窗口、
超 256 KiB、或窗口不会缩短它）同样弃权——那是别的拒绝理由，不该记成经济否决。

**回退**：把 `enabled` 改回 `false` 并重启，只影响之后的回执；已经进入历史的字节不会回滚。要让某条
回执重新尝试，删掉 `<dshHome>/boost/distilled/` 下对应的文件。

**产物保留**：产物按 `（回执哈希, 问题哈希, 版本）` 钉住，**不随会话销毁删除**——它是进入历史的
那串字节的证据，而 `resume`/`fork` 会重放同一批回执，删掉就等于让操作者再付一次调用、且没有任何
信号。目录按上限自我裁剪：超过 **5,000 个文件**或 **16 MiB** 时从最旧的开始删，刚写的那一条永不
被裁。要一次性清空就删整个目录。

字符按 Unicode 码点计。错误回执与超过 256 KiB 的回执不投影。触发阈值、窗口、页脚与死区的
完整算术见[原理的投影一节](how-it-works.md)；那里也说明了为什么 `triggerChars` 不能只按
`headChars + tailChars + 1` 设。

### Bundle patch

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
等式另有用途——**plugin manager 用它们把运行中的 entry 归属到本 bundle 的行**
（`dsh-plugin-manager` 的 in-use / 可寻址判定，见 `listPlugins` / `removeBundle`）：

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

## 状态与账目

状态在 `<dshHome>/boost/`：`dshHome` 配置**优先于** `$DSH_HOME`，两者都未设置时回退
`~/.dsh`；装配日志打印解析后的 `root=`（就是 `<dshHome>/boost`）。

- `scope.json`——暴露面的唯一事实来源（version 2，带 revision）。
- `scope.lock`——写路径的短锁，正常写入结束后删除。
- `receipts/<encoded-session>.jsonl`——追加式收据。**收据按“决定”写，不是每次调用都写**：
  只有发生投影、替换决策（含 skip）、待发替换因外部改写被放弃（`kind:'reset'`，`code` 为
  `pruned-reset` / `compaction-reset`）或越界 `skip:no-scope` 时才落一行；一个没有计划的
  `write` / `edit` 不产生任何收据，它的参数不会被记录。除 `kind:'reset'` 与
  `appendSkipNoScope` 写出的 `skip:no-scope` 外，每行携带元数据、回执前 256 个码点的
  preview（不存 stdout 全文）和该调用的绑定参数 `args`（模型所写：超过 2048 个码点时以
  `args_truncated` 标记的截断 JSON 落盘；嵌套超过 64 层时以 `args_depth_truncated` 标记，
  并把更深的子树换成 `{ "truncated_depth": 64 }`）。**只有替换类收据**另外携带计划 goal
  （≤256 码点）与守卫（≤8 条，各 ≤300 码点）：`kind:'substitute'`、
  `kind:'substitute-settled'`，以及 `kind:'shadow'` 且 `code:'ok'` 的影子提交。
  `kind:'shadow'` 不是替换专用——投影影子也写 `kind:'shadow'`，但带
  `code:'projection-shadow'`，属于投影收据，没有 plan 证据。
  **投影收据**（`kind:'projection'`、`code:'projected'`，以及投影影子）带 `before` /
  `after` / `saved_projection_tokens` / `unit` / `estimate` / `horizon_steps`；没有 token
  meter 时只有 `estimate:'unknown'`，三个数值字段整体省略。**取回收据**
  （`kind:'projection'`、`code:'projection-retrieval'`）带 `locator` 与
  `retrieval_call_tokens` / `retrieval_content_tokens` / `retrieval_tokens`；三个取回字段
  只在这次取回被定价时写入，未定价时 `estimate` 为 `'unknown'`、字段省略。`skip` 收据只有
  preview 与 args（`skip:no-scope` 分两条路径：走 `appendSkipNoScope` 的分支——无 agent、
  无 session id、会话已不活跃——只记工具名；运行中途可见性翻转的 `ledgerEntry` 分支仍带
  preview 与 args）。

  当前分片超过 8 MiB 或 20,000 行时，下一次写入前轮转为 `<encoded-session>.1.jsonl`；只保留
  当前分片和它的前一份（旧的 `.1` 被覆盖）。`boost status` 先读 `.1` 再读当前分片。256 分片
  上限按**编码后的会话名**计数：轮转出的 `.1.jsonl` 与当前文件同属一个名字，不额外占名额，
  但扫描会把该名字下的两份都读入。

`boost status` 的投影账按每条收据自己的 `horizon_steps` 重放；没有该字段的旧收据按当前
horizon 重放，并计入 `projection_horizon_reestimated`；`projection_horizon_steps` 报告当前
生效的 horizon（活动会话的最小值；没有历史时回落到 `horizonSteps`）。

### `status.data` 的状态与账目字段

`status.data` 里还有几个不在 `degraded` 里的状态/账目字段：

- `cache_hit_ratio` / `prefix_drops`：缓存护栏。前者是最近一次真实请求的命中率（无样本为 `null`，不是 0），
  后者是同一会话内相邻请求间 `cacheRead` 低于上一次 `input + cacheRead` 的次数与缺口 token 数。
  **回落可能是正常的**（压缩重写历史、换路由、provider 淘汰缓存），这两个数只让无解释的回落可见。
- `receipts_stopped`：收据连续写失败 3 次后为 `true`。此时替换被**整体拒绝**（fail-closed，
  不再花选择器调用或预算），投影照常；所有账目是停写前的旧快照。恢复写盘并成功追加一行后
  计数清零、该字段回到 `false`。它是唯一说出「收据已停写」的地方——没有对应的 `degraded` 码。
- `protocol_suppressed`：协议段在装配时被压掉的次数（不可见工作区、没有 agent 的诊断装配，
  以及 `complete: true` 覆盖）。装配每请求都跑，所以只计数、不写收据。
- `projection_locator_evictions`：因每会话 locator 上限（512 个，最旧先丢）被丢弃的 locator
  数；大于 0 表示取回账目有损。
- `projection_unknown_families`：带 `mcp__` 前缀、进入投影阶段但没有匹配到工具族的调用数；
  `projection_unknown_tools` 是其中保留的未映射工具名及次数（最多 32 个），用来发现 mapper
  缺口。
- `hasWorkspaceRegistry`：宿主是否**提供** `workspaceRegistry`（同样是存在性）。生产装配总是传入
  这个键，所以它**总是布尔**：宿主没有该服务是 `false` + `ERR_HOST_NO_WORKSPACE_REGISTRY`；服务在但
  `list()` 抛错是 `true` + `ERR_HOST_WORKSPACE_REGISTRY_BROKEN`——两种都让每个会话被判不可见，但
  修法不同。只有直接构造 `boost` 依赖、完全不给宿主事实时该键才省略（测试场景）。
- `hasSpill`：宿主是否**提供** spill 后端（存在性，不是可用性）。服务缺失是 `false` +
  `ERR_HOST_NO_SPILL`；服务在但不提供 `saveText` 时它**仍是 `true`**，同时 `degraded` 带
  `ERR_HOST_SPILL_UNUSABLE`——能力事实在 `degraded` 里，不在这个布尔里。
- `saved`：兼容旧消费者的 camelCase 账目对象（`substitution` / `substitutionAvoided` /
  `projectionGross` / `projectionNet` / `retrievals`），与顶层 snake_case 字段由同一次聚合派生。
  旧投影收据（pre-T23b）没有 `saved_projection_tokens` 时，按收据里的 legacy `saved` 字段回退计价。
  **两个和覆盖的收据集合可以不同**：下界只累加**同时**带两侧数值的收据，上界只看 `saved_input_tokens` 是否可读。
  这是故意的——写上下界时若一侧缺失就整体不计入下界，能保证下界永不超过上界；反过来只放大上界，只会让区间更宽。
  不要把两个数读成「同一批测量算了两次」。
  **两个替换数是一对区间，不是同一个量**：`substitution` 取被跳过请求的**下一**个真实请求的输入
  （含被替换调用自己的结果，所以是**上界**）；`substitutionAvoided` 取计划那一次请求的
  `input + cacheRead + output`（不含被替换调用的结果，所以是**下界**）。真实节省落在两者之间。
  **三个投影字段各是什么**（它们不是同一个数的三种写法）：
  - `projection_gross_tokens`（顶层，一次性）：每条被投影回执**自己那一次**少掉的 token 之和。
    这是这一单的事实，不含外推。
  - `projectionGross`（`saved` 里，重放口径）：每条回执的节省乘以**它自己的** `(1 + horizon)` 再求和。
    它是净额的被减数，所以和上面那个数不同；每条收据在决策时钉住自己的 `horizon_steps`，
    旧收据没有这个字段时按当前视界重估，并在 `projection_horizon_reestimated` 里报数。
  - `projectionNet`：`重放毛额 − 取回内容成本 − 取回调用成本`。取回成本按模型对 spill locator
    发起的 `read`/`grep` 计价；有取回但无法定价时它是 `'unknown'`，不是 0。
  - `retrievals`：模型对 spill locator 的取回次数（读一次 spill 算一次）。

`projection: 'on'` 时，完整原文在替换发生**之前**写入宿主的 spill 后端，页脚 locator 可以用
`read` / `grep` 取回。投影不会丢掉唯一副本；spill 写入失败就不替换（收据记
`projection-skipped:spill-failed`，页脚渲染失败记 `projection-skipped:footer-failed`；页脚
渲染器加载不到则记 `projection-skipped:no-footer`，见[降级码与错误码](#降级码与错误码)）。

## 回滚与卸载

下面的 `baseRevision` 按「启用」+「影子周」的推荐顺序走完是 `3`——启用结束于 `1`，影子周的
两步各加一——第一条执行完是 `4`；实际使用时永远取你刚从 `status` 读到的
`data.scope.revision`，不要照抄。

- **关掉两个行为**（不再投影、不再替换，但仍然可见的工作区——`selected` 下已选的、`global`
  下全部已定义的——会继续注入协议段，替换决策仍写影子收据，固定开销照旧）：

  ```json
  { "cmd": "scope-set", "body": { "projection": "off", "shadow": true }, "baseRevision": 3 }
  ```

- **回到真正惰性**：把 `mode` 设回 `selected` 并清空列表。**注意 `workspaceIds` 只在
  `selected` 模式下起作用**：`isVisible` 对 `mode:"global"` 下每个**已定义**的工作区为真
  （`src/scope/doc.ts`，`global` 分支不读列表；`workspaceId` 未定义的会话仍为假），所以
  **先处于 `global` 时只写 `workspaceIds: []` 什么都停不下来**——投影与替换会照常进行，
  而你以为已经回滚了。在 `selected` 下移除单个工作区即可；
  在 `global` 下必须同时改 `mode`：

  ```json
  { "cmd": "scope-set", "body": { "mode": "selected", "workspaceIds": [] }, "baseRevision": 4 }
  ```

  `selected` + 空列表时协议段、投影、替换全部停止（只剩下 `boost` 工具 schema 的常驻开销）。

- **卸载插件**：`dsh plugin --profile <name> remove dsh-boost`，然后重启 DSH。
- 删除 `<dshHome>/boost` 会清掉 scope 与收据（回到默认），但不会删除宿主 spill 后端里已经
  写出的原文文件。

## 降级码与错误码

### 宿主依赖

`inject` 是硬依赖：`tools`、`systemPrompt`——缺任一，cordis 让插件停在 pending、不 apply（不是
抛错，但对使用者而言效果相同：插件不工作）。`llm` 是软依赖（只有选择器用），缺失时选择器以
`selector-unavailable` 退回，投影与替换的其余部分照常。

| 依赖 | 形态 | 缺失时 |
|---|---|---|
| `workspaceRegistry` | 软（`ctx.get('workspaceRegistry')`） | **工作区不可见**：cwd 永远映射不到工作区 id，一切按 fail-closed 视为不可见——协议段不注入、投影与替换全部跳过，只有 `skip:no-scope` 收据在涨；`status.degraded` 带 `ERR_HOST_NO_WORKSPACE_REGISTRY`。这是**工作区本应可见却不可见**时的宿主能力解释，不是「装上了却什么都不发生」的唯一解释：默认 `selected + []` 按设计就是惰性的且不报错；缺 token meter 会拒绝真正的替换；`complete: true` 提示段会压掉协议段 |
| `tokenMeter` | 软（`ctx.get('tokenMeter')`） | 拒绝替换；投影仍可用，投影账记 `unknown`（不伪造数字）；`status.degraded` 带 `ERR_HOST_NO_TOKENMETER` |
| `spillStore` | 软（`ctx.get('spillStore')`） | `projection: 'on'` 时超限回执不投影（保住证据），收据记 `projection-skipped:no-spill`；`status.degraded` 带 `ERR_HOST_NO_SPILL`（实时探测只在 on 模式；历史收据在任何模式下都会让它出现） |
| `@deepseek-ai/dsh-spill-policy/notice` | 软（动态 import） | spill 后端在，但页脚渲染器 `formatSpillNotice` 加载不到/不存在：apply 模式无法拼页脚，逐条跳过（收据 `projection-skipped:no-footer`；页脚渲染时抛错则记 `projection-skipped:footer-failed`），`status.degraded` 带 `ERR_HOST_NO_SPILL_NOTICE`。这与「没有 spill 后端」的 `ERR_HOST_NO_SPILL` 是两件事 |
| （spill 后端存在但写失败） | — | 每次 `saveText` 被拒：收据 `projection-skipped:spill-failed`，`status.degraded` 带 **`ERR_HOST_SPILL_FAILING`**。这是**第三种**状态，既不是「没有后端」也不是「没有页脚渲染器」——让操作者去「恢复 spill 包」会把一个已装好却报错的包当成没装 |
| `@deepseek-ai/dsh-token-meter/estimate` | 软（动态 import） | 固定开销无法测量，`fixedOverheadTokens` 为 `'unknown'`；`status.degraded` 带 `ERR_HOST_NO_ESTIMATOR` |
| `locale` | 软（`ctx.get('locale')`） | 设置页**跟随宿主语言**（中英双语，导航项标签一起换）；缺这个服务时回落中文并 `console.warn` 说明一次，页面照常可用；投影、替换与 `boost` 工具不受影响 |
| `webServer` | 软（动态注入 `ctx.inject(['webServer'], …)`） | **设置页读不到数据**：路由没挂上，页面显示 `ERR_CLIENT_NETWORK` 并提示去看宿主日志。投影、替换与 `boost` 工具**完全不受影响**——这是唯一一个缺失只影响页面的依赖。挂上之后 `Host` 的受信名单来自 `webStartup.trustedHosts`（读不到就只信 loopback），所以反向代理没透传 `Host` 时页面会被 `ERR_HTTP_FORBIDDEN` 挡住 |
| `win32` 平台 | 运行时检查 `isPosixOnly()` | 拒绝替换，投影照常；`status.degraded` 带 `ERR_HOST_PLATFORM_UNSUPPORTED` |
| 宿主版本线 | 启动时读 `@deepseek-ai/dsh-app-boot` 的版本 | 版本**落在 `engines.dsh` 区间外**（`>=0.2.2-rc.4 <0.2.3-0`）时日志警告 `ERR_HOST_VERSION_MISMATCH`，插件照常加载（advisory，不是 `status.degraded` 码）；区间内但不是验证过的 `0.2.2-rc.4`（如 `rc.5` / `0.2.3`）只记 info、不发码；版本读不到或区间无法解析时也只记 info |
| 收据分片可读性 | `boost status` 全量扫描（非依赖） | 至少一个收据分片读不出来（EACCES、名为 `x.jsonl` 的目录等）时 `status.degraded` 带 `ERR_RECEIPTS_UNREADABLE`；`status` 仍是**全量聚合**——健康分片照常计数——所以数字可能不完整。查 `<dshHome>/boost/receipts/` 的权限与异常条目，修复后重跑并对比计数 |
| 收据分片数量 | `boost status` 全量扫描（非依赖） | 分片超过 256 个时 `status` 只统计按编码名排序的前 256 个，`status.degraded` 带 `ERR_RECEIPTS_TRUNCATED`，所有计数因此是**下界**；分片永不自动删除，可归档/移走旧会话分片后重跑 `status` |
| 提示段装配瀑布 | 出站请求探测（非依赖） | 宿主的 `complete: true` 提示段在装配瀑布之后替换了整个系统提示、协议段没有到达请求时，`status.degraded` 带 `ERR_HOST_COMPLETE_SECTION`；受影响请求上替换与投影 fail-closed（工作区明明可见插件却不动作）。找出宿主里覆盖瀑布的 complete 段（通常属于另一个插件）并移除，或接受这些请求上不动作 |

`ERR_HOST_NO_STEP_WHEN` 已不存在：步骤级 `when` 从本包声明的最老宿主线起就在
`ToolRegistrationOptions` 里，插件不再探测、无条件注册。

### 注册阶段的码

注册阶段的码分两类。协议段注册抛出**非重复**错误时记 `ERR_BOOST_SECTION_REGISTER_FAILED`
（只进日志）；此后三个事件钩子（`tools/post-execute`、`llm/stream`、`tools/execute`）**逐个
独立挂载**，任何一个失败都会被记名并通过 **`ERR_BOOST_PARTIAL_MOUNT`** 进 `status.degraded`
——装配不全的插件不会再看起来健康。宿主真正的重复注册错误记 `ERR_BOOST_ALREADY_MOUNTED` 并
跳过本次挂载；`boost` 工具自身注册失败记 `ERR_BOOST_TOOL_REGISTER_FAILED`（只进日志）。

### 设置页路由的码

设置页的数据路由有自己的码，它们**不是** `status.degraded` 的成员——每次失败都以 JSON 体返回
一个码，页面据码决定说什么：

| 码 | 出现位置 | 含义 |
|---|---|---|
| `ERR_HTTP_FORBIDDEN` | 路由响应体（403） | 同源栅栏拒绝：`Host` 既非 loopback 也不在 `webStartup.trustedHosts` 里，或 `sec-fetch-site: cross-site`，或 `Origin` 与 `Host` 不同 authority，或 `Origin` 解析不了 |
| `ERR_HTTP_METHOD` | 路由响应体（405） | 对 `/state` 发了写，或对 `/scope` 发了 `GET`/`HEAD`/`POST` 以外的方法 |
| `ERR_HTTP_BODY` | 路由响应体（400） | 写请求的体不是合法 JSON，或超过 64 KiB |
| `ERR_HTTP_NOT_FOUND` | 路由响应体（404） | 前缀匹配上了但子路径不认识：页面与服务端版本不一致 |
| `ERR_HTTP_INTERNAL` | 路由响应体（500） | 读 `status`/`scope` 时宿主服务的 getter 抛错；四块内容一个都不返回 |
| `ERR_HTTP_WORKSPACES_UNAVAILABLE` | 路由响应体（`workspaces.available === false`） | 没有注册表，或 `list()` 抛错：页面禁用保存并说明「读不到」，不渲染空列表 |
| `ERR_CLIENT_NETWORK` | 页面（不经网络） | 页面读不到路由：可能没挂上 |
| `ERR_CLIENT_SHAPE` | 页面（不经网络） | 路由返回的体本页读不懂：版本不匹配 |

`Host` 白名单是**防 DNS rebinding** 的：攻击者控制的域名解析到本服务器时，浏览器自己的请求
看起来就是同源，而 `Host` 是 rebinding 伪造不了的那个头。**读放行缺失 `Origin` 而写要求它**：
纯 HTTP 下同源 GET 不带 `Origin`（设置页自己的读就没有），要求它只会 403 掉页面的读；写是
POST，浏览器一定带 `Origin`，缺失说明不是浏览器，所以写路由要求它（`requireOrigin`）。

`ERR_BOOST_HTTP_MOUNT_FAILED` 只进日志：路由挂载本身抛了（`ctx.inject` 不可用或被拒绝），
页面因此没有数据源。它与 `ERR_BOOST_PARTIAL_MOUNT` 是两件事——后者说的是钩子。

### 不要合并的码

`ERR_HOST_NO_TOKENMETER` 与 `ERR_HOST_NO_ESTIMATOR` 是**两件不同的事**，不要合并：
前者是宿主服务（`ctx.get('tokenMeter')`）不存在，替换被拒绝；后者是纯估算包
`@deepseek-ai/dsh-token-meter/estimate` 不可达，只影响固定开销的数字。一个可以存在而另一个
不存在；合并会把操作者引到错误的宿主上。`ERR_HOST_NO_SPILL`（没有 spill 后端）与
`ERR_HOST_NO_SPILL_NOTICE`（后端在、页脚渲染器不在）也是两件事，修复方式不同。

`ERR_HOST_NO_SPILL` 有两半：**实时宿主探测**只在 `projection: 'on'` 时报告（影子模式不碰
spill，报它只会制造噪音）；但**收据通道**不看当前模式——任何一条历史收据带
`projection-skipped:no-spill`，`status` 都会把它映射成该码，所以把投影切回 `off` 之后，旧收据
仍会让它出现在 `degraded` 里。

`tokenMeter` 与 `spillStore` 不能写进 `inject`：宿主没有该服务时插件会直接加载失败，
“拒绝替换、投影照做、保住证据”的降级路径就不可达。

## 已知限制与未交付项

- 只做两件事：**就地替换工具回执**，以及**替换只读调用**（`read` / `grep` / `glob`）。
- **不批量执行工具调用**（没有 PTC / `run_code`）：这是原始需求 2.1 的**收窄**，也是**实现者
  的范围决定（E2）**，不是用户裁决——**没有用户消息追认这条收窄**。收窄的理由是范围，不是
  「批量派发已被证明没有价值」：每步恰好 1 个工具占 79.8%，但 **20.2% 的步不是单工具步**——
  16.9% 带 ≥2 个调用、3.3% 零调用（`clarifications:17`）；用户明确要求批量派发，非单工具步
  正是它的作用面。PTC 留二期，重启条件是影子期拿到批量步的真实占比与收益标签，而不是
  「79.8% 已证明不需要批量」（见[澄清记录](superpowers/clarifications/2026-11-18-dsh-token-efficiency.md)
  的 2.1 与 E2；设计 N1）。
- **不回答「工具调用顺序由谁定」**：原始需求 2.3 要求调研组合工具的顺序（Jev 决策还是主模型
  一开始定好），v1 **没有交付这项调研**——这是开放缺口，**不被 PTC 的推迟覆盖**。v1 的实现是
  主模型逐步决定下一次调用，Jev 只在已声明候选里选一个、无权加步骤或改序；研究里
  ReWOO / LLMCompiler 的「先声明计划、步骤间不再问模型」证据没有应用到定序权威上，也没有
  对比实验（`clarifications:19`、设计 §9）。
- **不去重、不合并工具调用**（设计 N5）——这条完全没开工，且 v1 **没有任何工具能测出重复
  调用率**：设计稿里用来触发重启判定的「影子周重复率统计」没有交付，`shadow-report.mjs`
  不产出它。
- **HarnessMM 只移植了四件**：扁平候选银行、GDR 守卫、CCS 单候选提交、闭集选择器（Jev）。
  **EDG 的图/链（`predecessor_id`）没有移植**——本插件的计划是扁平、每回执一次性的候选列表，
  源码里没有 `predecessor_id`；**RSI 循环也没有移植**——v1 是固定策略插件，没有训练/选择
  生命周期（`clarifications:16`）。
- **影子周不省 token**：只记账（协议段照注入、选择器照调用），推荐配置下每请求仍固定花
  778（`selected + []` 为 399）；它的产出是四个比例，不是省下的 token。
- **v1 不评判「结果更好」**：只有 token 账目和一套**人工**的 20 任务回退流程（任务集不随包发布，
  见 `docs/RELEASE.md` §3），没有任何质量指标；「替换后结果质量」在 v1 是不可判的。这套流程
  本身也没交付完整：冒烟 runner（`test/regression/run.mjs`）与同一节的取回完整性检查都未实现，
  `test/regression/` 只有 `.gitkeep`，因此 pass 谓词里的「无数据丢失」不变量在 v1 **未经核实**。
- **投影是截断，不是精炼**：它保留头尾、丢掉中段；账本里的 before/after token 差量的是
  「变短」，不是「变相关」。被丢掉的中段可能正是下一步决策要用的内容——`projection: 'on'`
  下原文可经页脚 locator 取回，但取回要花一次工具调用，且 v1 没有指标区分「精炼」与
  「误截」。
- **装上但未启用是小的净亏**：`boost` 工具只要插件装配就注册，schema 实测 399 token/请求
  常驻（见[启用](#启用)一节的分解），收益为零。
- **不支持 desktop profile**（设计 D6）。
- 不替换、也不接管 DSH 的压缩、剪枝与 spill 决策（设计 N3）；投影只改模型可见 content，
  原文仍借宿主 spill 存放。
- 不做模型训练或权重改动（N2）；不追求论文里的 87.93%（N4）。
- 不承诺 10%：3.5% 是事前估算的**下界**，不是保底；10% 是全程存活的理想上界。投影侧在
  300 个最长会话上的聚合净额约 0.4%（毛额约 0.8% 减去每请求固定开销约 0.4%），同样是
  离线估算，**不是每会话保底**（短会话可能倒亏）。影子周只给替换侧的标签（候选覆盖与提交
  产出率），不单独决定是否开启替换、也不决定发布，更不能把区间换成实测值
  （`shadow-report.mjs` 只有四个比例，没有总 token 分母）。
