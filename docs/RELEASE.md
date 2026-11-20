# dsh-boost 发布验收

本文是 `dsh-boost` 0.1.0 的发布验收手册。它覆盖四件事：

1. `npm run verify:package` 一条命令的打包与产物验收（§1），以及零 peerDependencies 现状下
   两条降级路径的验收方式（§2）；
2. 20 任务回归门的**判定过程**与 pass 谓词（任务清单由操作者自备）；
3. 影子周脚本的跑法、`session-snapshot.json` 的来源与复算方式；
4. CI 到底做什么、不做什么，lockfile 的 China mirror 怎么处理，以及 npm 的发布旁路（§6）。

> 记录在案的决定：本项目**不附带** 20 任务回放集，也不提供 `test/regression/run.mjs`。用户明确否决了
> "搭回放集"（2026-11-18）。因此第 3 节只规定过程与判据，**不伪造任务集**。

---

## 1. 打包与产物验收：一条命令

在仓库根目录：

```bash
npm run verify:package
```

`scripts/verify-package.mjs` 把机械验收一次做完。它不依赖 `npm publish` 或 `prepublishOnly`，
可以单独跑；前置条件只有一次 `npm ci`（后面 `npm pack` 的 `prepare` 需要仓库自己的 `tsc`）。
本 checkout 实测 exit 0：tarball 110 个条目，回执里 9 条 `checks` 记录：

1. `npm pack` 打出真实 tarball。`package.json` 的 `prepare` 会在 pack（含 `--dry-run`）前执行
   `npm run build`（生命周期钩子名是 `prepare`；`prepack` 已不存在，本机已复验），所以干净
   clone 上即使 `dist/` 不存在，打出的包也会包含构建产物。
2. **exact allowlist**：每一个 tar 条目都必须由四类来源之一解释——固定根文件（`package.json`、
   `LICENSE`、`NOTICE`、两份 README）、`dsh.bundle.patch` 指向的 patch 文件、`locale/*.json`、或
   `src/**/*.ts` 对应的一个 `dist/**.js` + `.js.map` + `.d.ts`。多出 `package/dist/ghost.js`
   之类的条目立即失败并点名；少一个也失败并列出缺失项。这是精确集合，不是“必需项齐全 + 禁止前缀
   不出现”。patch 条目不是硬编码的 `cordis.patch.yml`：脚本从 `package.json` 的
   `dsh.bundle.patch` 派生它，字段缺失、不是字符串或指向不存在的文件都会红。默认路径下“少一个”
   不能靠删工作树文件复现——`npm pack` 会先跑 `prepare` 重建 `dist/`。要复现缺失条目，用
   `npm pack --ignore-scripts` 打一个不重建的 tarball，再跑
   `node scripts/verify-package.mjs --tarball <tgz>`；例如删掉 `dist/types.d.ts` 后这样打包，
   allowlist 步骤会列出缺失的 `package/dist/types.d.ts`（若整个 `dist/` 都不存在，则先被下一条
   publish guard 挡住）。
3. **publish guard**：tarball 里没有 `package/dist/index.js` 时，脚本在任何安装之前失败，
   消息是 `publish blocked: tarball has no package/dist/index.js`。`npm pack --ignore-scripts`
   在无 `dist/` 的干净 clone 上打出的 8 文件空包，就是被这条挡住的。
4. 安装树里每一个 `exports` 字符串目标（包括 `./locale/*.json` 按 en/zh 展开）、`main`、`types`
   以及 `dsh.bundle.patch` 指向的文件都必须存在。检查的是“声明了的路径”，不只是 `dist/index.js`
   一个文件；patch 字段不是字符串或规范化后逃出包根也会红。
5. 把 tarball 装进一次性消费项目，带 `--ignore-scripts`（**主安装**；CI 上不执行包内生命周期
   脚本）。在装好的包上跑 import/require 探针：`name` / `inject` / `apply` 来自 ESM `import`，
   `require('dsh-boost')` 也拿到同一组；`require.resolve('dsh-boost/package.json')`、
   `require.resolve('dsh-boost/locale/en.json')` 与 `.../zh.json` 都能解析，两个 locale 都
   解析出非空 `meta.description`。zh 是主 README 的语言，**两个 locale 都是契约**；把
   `"./locale/*.json"` 收窄到 en 会在这里得到 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
6. 在同一个已安装包上编译一个 tiny TypeScript consumer：`import { apply, name } from
   'dsh-boost'` 加 `import type { inject } from 'dsh-boost'`，用仓库自己的 `tsc --noEmit`
   （`skipLibCheck: false`）对**装好的**包编译。缺 `dist/types.d.ts` 时这里红（消费项目里直接
   复现是 `TS7016: Could not find a declaration file for module './types.js'`）；`name` /
   `inject` 的字面量类型和 `apply` 的参数形状也一起钉住。宿主类型用最小 stub，宿主 API 本身由
   `npm run typecheck` 对真实 devDependencies 检查。
7. **再装一次，不带 `--ignore-scripts`**（**次安装**；生命周期脚本启用），并在这次安装上重跑
   import/require/locale 探针。`postinstall` 非零会让整个 `npm install` 非零，门就红；这是
   唯一能发现“postinstall 让真实用户装不上”的检查。它会在一次性临时目录里执行包内脚本——
   **不要在不可信的 commit 上跑 `verify:package`**。

成功只往 stdout 打 JSON 回执；`checks[].install` 明说每条断言用的是 `ignore-scripts` 还是
`default` 安装。失败保留临时目录并打印其路径供检查。
`prepublishOnly` 现在就是 `npm run ci && npm run verify:package`（`ci` = typecheck + test +
build），所以**不带 flags 的** `npm publish` 本身会跑完这道门。但 npm 仍有两个旁路，见 §6.3。

### 1.1 手工回退与维护

- `npm ci`：按已提交的 `package-lock.json` 复现开发依赖树（TypeScript、`tsx`、`@types/node`
  都由 lockfile 钉住）。`verify:package` 用的是当前工作树，不替你确认 commit 状态。
- 完整路径清单已由 exact allowlist 覆盖，不需要再手工 `diff` 集合。要审**内容**（不是路径集合）
  仍然可以 `tar -tzf dsh-boost-0.1.0.tgz` 或 `npm pack --dry-run` 人工看。
- 新增 `src/**/*.ts` 或 `locale/*.json` 时 allowlist 自动跟随，不用改脚本；新增**根文件**才需要
  改 `scripts/verify-package.mjs` 的 `ROOT_ENTRIES`（`dsh.bundle.patch` 指向的 patch 文件除外，
  它的条目从字段派生，不写进 `ROOT_ENTRIES`）。
- `node scripts/verify-package.mjs --tarball <tgz>`：对已有 tarball 跑同一套检查（不重新 pack）。
  没有 `dist/index.js` 会直接拒绝。它不能把 `npm publish <tgz>` 变安全（§6.3）。

验收前的硬约束（设计 §11）：

- `package.json` 的 `name`、`cordis.patch.yml` 行的 `id`、行的 `name`、导出插件的 `name` 四者完全一致。
  注意：顶层 `insert` 行在装配时**不做** id/name 匹配（加载器直接 push），等式
  `row.id == entry.options.id && row.name == entry.options.name` 是 plugin manager 的 in-use /
  可寻址归属判定——不一致时行照常装配，但会在管理面变成不可寻址、移除判定失灵；`name` 指向
  不存在的包则加载**响亮失败**。四名一致是为了保住管理面的可寻址性。
- `version` 必须存在，否则 `npm pack` 在第一步就报 `Invalid package, must have name and version`。
- `files` 与实际布局一致：`scripts/`、`test/`、`src/` 是 dev-only，**不**进包（`files` 只带
  `dist`、`locale`、`cordis.patch.yml`、两份 README、`LICENSE`、`NOTICE`）；`dist/` 由 `prepare`
  构建，sourcemap 以 `inlineSources` 内联源码，装好的包没有 `src/` 也能对上源码。

## 2. 装进宿主（一次性 DSH_HOME）

机械的那一半——空项目安装、模块加载、元数据路径解析——已并入 §1 的 `npm run verify:package`
（一次性消费项目 + `import`/`require`/locale 探针 + 子路径解析断言 + 类型检查）。**本包不再声明任何
peerDependencies**（§2.4），所以“peer 在空项目里解析到哪个 rc”这一步已经不存在：裸装 tarball
只新增 `dsh-boost` 一个包（约 1.4 MB），不会带出任何 `@deepseek-ai/*` 宿主树；旧版用 isolated
布局把“缺失 peer”真实暴露出来的动机也随之消失。§1 的第 5 步（import/require/locale 探针）
就是当年手工 `import('dsh-boost')` 与两条 `import.meta.resolve` 检查的自动化版本。

剩下需要活宿主的部分照旧。`--profile` 是 `dsh plugin` 的**必填**
选项，且要放在 `add` 这个被透传的 pnpm 子命令**之前**；写成 `dsh plugin add <path>` 会在安装前
因缺少必填项失败：

```bash
export DSH_HOME=/tmp/dsh-boost-accept/dsh-home
mkdir -p "$DSH_HOME"
dsh plugin --profile accept add /path/to/dsh-boost-0.1.0.tgz
# 或本地 checkout 目录；从 registry 安装时写 dsh-boost@^0.1.0（0.1.0 是首次发布，发布后 latest 即 0.1.0）
# 确认宿主确实把这一行并入了装配计划：
dsh --profile accept --dump-config | grep -A2 'id: dsh-boost'
```

### 2.0 先让插件对测试工作区生效

刚初始化的 `scope.json` 是 `{mode:'selected', workspaceIds:[], shadow:true, projection:'shadow'}`
（`src/scope/doc.ts`）。工作区列表为空时插件对任何会话都不可见：投影根本不会发生，§2.1 的
“投影照常裁剪”和 §2.2 的 `projection-skipped:no-spill` / `ERR_HOST_NO_SPILL` 都无法观察到
（宿主探针版的 `ERR_HOST_NO_SPILL` 只在 `projection === 'on'` 时加入 `degraded`；收据里的
`projection-skipped:no-spill` 在**任何**模式下都会映射成该码，但没有可见会话就不会有收据）。
先加入测试工作区。

工作区 id 是宿主注册表里的 UUID，不是路径。从 `$DSH_HOME/storages/workspace.json` 的
`tables.workspaces` 找到路径为测试工作区的条目：

```bash
node -e '
const s = require(process.env.DSH_HOME + "/storages/workspace.json")
for (const [id, w] of Object.entries(s.tables.workspaces)) console.log(id, w.path)
'
```

`boost` 是**模型工具调用**，不是 shell 命令：包里没有 `bin`，在终端敲 `boost` 只会得到
`command not found`。在 agent 会话里直接发送下面三句用户消息，让模型依次调用它：

```text
请调用 boost 工具：{"cmd":"status"}
请调用 boost 工具：{"cmd":"scope-set","baseRevision":<上一步返回的 scope.revision>,"body":{"mode":"selected","workspaceIds":["<测试工作区 id>"],"shadow":true,"projection":"on"}}
请调用 boost 工具：{"cmd":"status"}
```

最后一次 `status` 必须显示 `scope.workspaceIds` 含该 id、`shadow` 为 `true`、`projection` 为
`"on"`。这三项是后续所有观察的前置条件；只看“我记得设了”不算数。

> 降级验收要在**宿主实际解析依赖的那棵树**里移除包（这一条适用于宿主树里的包，如 spill 后端；
> 本包自身已无可移除的 peer，§2.4）。用 `dsh plugin --profile accept` 装进 profile
> 时，宿主在 `$DSH_HOME/profiles/accept` 下解析；消费项目目录里的 `npm uninstall`
> 只改了另一份副本，不能证明宿主缺包。用
> `dsh plugin --profile accept remove <pkg>` 移除，或用
> `find "$DSH_HOME/profiles/accept/node_modules" -maxdepth 4 -name '<pkg>'` 确认它本来就不在
> profile 里。

`boost status` 是验收的观察面：它输出 `shadow` / `projection` 两个开关、按 `code` 的收据计数、替换账与
投影账（投影账为净额并附 `projection_retrievals`）、实测固定开销 token，以及稳定降级码。投影账不是把
一个全局倍率套到总额上：每条投影回执都钉住自己决策时的 `horizon_steps`，`status` 按各自的值复算；
没有该字段的旧回执按当前 horizon 计并计入 `projection_horizon_reestimated`，当前生效的 horizon 报在
`projection_horizon_steps`。插件本身不说话，**不要**用"我记得开了"代替 status。

### 2.1 降级门：宿主缺 `tokenMeter`（先验健康，再验降级）

**门的构造方式变了。** `tokenMeter` 从来是宿主服务（`ctx.get('tokenMeter')`），不是本包安装的
包；过去它同时是 optional peer，可以用 npm 往消费项目里装/卸来构造“缺失”——**包已不声明任何
peer**（§2.4），消费项目 `node_modules` 里装什么、卸什么都不再影响宿主进程里的服务，
`npm uninstall` 那条路线整条作废。现在这个门由两层承担：

- **单元测试注入宿主事实**：`test/host.test.ts` 与 `test/boost-tool.test.ts` 以
  `host: { hasTokenMeter: false }` 之类的宿主事实断言下表的全部预期（`npm test` 全套）。
  缺服务时的加载、替换拒绝与 `ERR_HOST_NO_TOKENMETER` 都在这层被锁定。
- **活宿主复核**只在真要部署一台缺该服务的宿主时手工做：先验健康态（agent 会话里 `boost
  status` 的 `degraded` 不含 `ERR_HOST_NO_TOKENMETER`、`estimate_kind` 为 `"host"`、
  `fixedOverheadTokens` 是数字）。然后**把 `shadow` 设为 `false`**
  （`boost` 的 `{"cmd":"shadow","baseRevision":<rev>,"body":false}`；§2.0 的默认
  `shadow:true` 只走 record-only 分支），再在缺服务的宿主上重启并按下表验降级。替换拒绝只在
  `shadow:false` 时发生（`src/hooks/post-execute.ts` 的 `!ctx.doc.shadow` 条件）。验完把
  `shadow` 设回原值。`status.degraded` 里的 `ERR_HOST_NO_TOKENMETER` 来自宿主事实
  `hasTokenMeter === false`，在两种模式下都可见；但影子模式下它只证明宿主缺服务，不证明拒绝路径
  真的跑过，所以本门不能只在 `shadow:true` 下“通过”。验不到健康态，后面的“降级”就无从谈起——
  门在此处就该判失败。

预期（设计 §9 / §11；行为未变，变的只是构造方式）：

| 观察点 | 期望 |
|---|---|
| 插件加载 | **成功**。`tokenMeter` 是软依赖，只能 `ctx.get('tokenMeter')` / 动态 import，不能进 `inject` |
| 替换 | **拒绝**（仅 `shadow:false`）：没有计量就不做替换，不拿 `chars/4` 的假数字放行；`shadow:true` 下不进入替换决策，看不到拒绝 |
| 投影 | **照常裁剪**（裁剪本身不需要 token meter） |
| 投影账 | token 估算记 `'unknown'`，**不伪造数字**；`projection_gross_tokens` / `projection_net_tokens` 为 `'unknown'` |
| `boost status` 的 `degraded` | 含稳定码 `ERR_HOST_NO_TOKENMETER`（`shadow:true` 下也可观察，来自宿主事实） |
| 收据 | 每个被拒的替换决策有 `skip` / `ERR_HOST_NO_TOKENMETER`（代码里也写稳定码本身）；仅 `shadow:false` 会产生 |
| 失败形态 | **不是** `ERR_MODULE_NOT_FOUND`。若看到它，说明代码里出现了对宿主侧包的静态 import（本包声明零 peer，见 §2.4）；用 §1 verify:package 的一次性消费项目复现排查 |

### 2.2 降级门：spill 后端（卸错包什么都验不到）

**`spillStore` 服务由 `@deepseek-ai/dsh-spill-local` 提供**（`@deepseek-ai/dsh-spill` 定义的
`SpillStore` 抽象服务的本地实现）；`@deepseek-ai/dsh-spill-policy` **只是页脚格式化器**
（消费 `ctx.get('spillStore')`，提供 `formatSpillNotice`），卸它得到的是
`projection-skipped:no-footer`（见本节末行），**永远得不到** `ERR_HOST_NO_SPILL`。要验
no-spill 降级，必须移除的是**后端**：

```bash
# dsh-spill-local 是宿主 dsh-base 的依赖，不是本包的 peer，通常不在 profile 顶层。
# 在一次性 DSH_HOME 里先定位宿主实际解析到的那份：
find "$DSH_HOME" /path/to/dsh/install -maxdepth 6 -type d -name 'dsh-spill-local' -print
# 验收沙箱里直接把解析到的那份目录改名/删除，再重启宿主：
# mv <上面找到的目录> <同路径>.removed
# （若它被直接装进了 profile，则 dsh plugin --profile accept remove @deepseek-ai/dsh-spill-local）
```

预期（设计 §5.4 / §11；移除的是 spill **后端**）：

| 观察点 | 期望 |
|---|---|
| 插件加载 | **成功**。`spillStore` 是软依赖 |
| `projection: 'on'` + 超限回执 | **不投影**，原文原样进入历史（保证据） |
| 收据 | `projection-skipped:no-spill`（`src/projection/apply.ts`：`spill` 缺失走 `no-spill` 分支） |
| `boost status` 的 `degraded` | 含稳定码 `ERR_HOST_NO_SPILL` |
| `projection: 'shadow'` | 不受影响：影子只记投影前后 token，不落盘、不改 content |
| 替换 | 不受影响（替换不依赖 spill 后端） |
| 失败形态 | 不应是 `ERR_MODULE_NOT_FOUND`（`spillStore` 经 `ctx.get` 动态获取）；注意与另一条降级区分——**若只移除 `dsh-spill-policy`（页脚格式化器；它已不是本包声明的依赖，代码经守护的动态 import 从宿主树解析 `@deepseek-ai/dsh-spill-policy/notice`，解析不到即降级），得到的是 `projection-skipped:no-footer` 与 `ERR_HOST_NO_SPILL_NOTICE`，`ERR_HOST_NO_SPILL` 不会出现**；那条路径同样可验，但它是另一个门 |

### 2.3 两条路径都要留证据

每条路径至少保留：

```bash
# 一次 status 的完整输出：在 agent 会话里发送“请调用 boost 工具：{"cmd":"status"}”，
# 把工具返回的 JSON 原样贴进证据（不要只写结论）。
# 收据里对应 code 的计数（可以直接数行）
grep -c '"code":"projection-skipped:no-spill"' "$DSH_HOME"/boost/receipts/*.jsonl
grep -c '"code":"ERR_HOST_NO_TOKENMETER"' "$DSH_HOME"/boost/receipts/*.jsonl
```

若 `ERR_MODULE_NOT_FOUND` 出现，跑 §1 的 `npm run verify:package`（或手工在一次性空项目里
`npm install <tarball>` 后 `node -e "import('dsh-boost')"`）复现并记录栈；本包声明零 peer
（§2.4），任何布局下都不应再出现依赖解析歧义。

### 2.4 依赖声明现状（2026-11-20，`0567347` 起）：零 peerDependencies

`package.json` **不声明任何 `peerDependencies` / `peerDependenciesMeta`**。四个
`@deepseek-ai/*`（`dsh-llm`、`dsh-tools`、`dsh-spill-policy`、`dsh-token-meter`）只以精确钉版
出现在 `devDependencies`（`0.2.2-rc.4`，不跟随范围）。
删除的原因：npm 11 会把声明的 peerOptional **直接装上**——在 rc.4 宿主树里装带 peer 的旧
tarball 会拉进 `dsh-spill-policy@rc.5` 并 `ERESOLVE`（当时实测 exit 1），“optional 标记允许
宿主不装”的初衷反被堵死。删除之后的事实：

- 裸装 tarball 只新增 1 个包（约 1.4 MB），不再带出 20 个包/15 MB 的重复宿主树；
- 模块**不依赖它们也能加载**：`dsh-llm` / `dsh-tools` 在运行时是纯 type import；
  `@deepseek-ai/dsh-token-meter/estimate` 与 `@deepseek-ai/dsh-spill-policy/notice` 是带兜底的
  动态 import，从**宿主树**解析——宿主提供它们，解析不到走降级（§2.1、§2.2）；
- 与宿主的兼容性由 `engines.dsh`（精确 `0.2.2-rc.4`）声明；`engines.node` 是
  `>=24.9.0`（对齐宿主 `@deepseek-ai/dsh@0.2.2-rc.4` 的 Node 下限）。加载时若解析到的宿主版本
  不是这条验证线，插件告警 `ERR_HOST_VERSION_MISMATCH` 但**仍然加载**（advisory：版本不符是风险，
  不是 API 已改的证明；改名仍可能让插件失效）。

安装规格：**`dsh-boost@^0.1.0`**。0.1.0 是首次发布，registry 上没有更早的 `dsh-boost`；发布后
`latest` 即 0.1.0，所以这个范围就是正确的，不存在“latest 还指向旧 API”的问题。发布者执行
`npm publish` 即可（`prepublishOnly` 会跑 `ci` + `verify:package`；`.npmrc` 钉的是 npmmirror
安装源，`publishConfig.registry` 已把发布指向 registry.npmjs.org）。

本节取代旧版安装矩阵（rc.4 / rc.5 两侧对照、含一行 `ERESOLVE` 失败）：那张表记录的是 **peer
还存在时**的安装行为，自 `0567347` 起不再适用；§1 的 `verify:package` 与上面的裸装事实是现行
依据。

### 2.5 降级码矩阵（稳定码全表）

`boost status` 的 `degraded` 数组与 `boost` 工具调用的失败 `code` 都是稳定契约；日志里的稳定码
是第三类观察面，不是工具返回值。§2.1、§2.2 是可构造的门的验收细则；本表是操作者看到某个码时的
速查。收据流里的 `projection-skipped:no-spill` / `projection-skipped:no-footer` 是**输入**，
分别映射成 `ERR_HOST_NO_SPILL` / `ERR_HOST_NO_SPILL_NOTICE`，本身不是稳定码。

| 码 | 观察面 | 可观察症状 | 操作者动作 |
|---|---|---|---|
| `ERR_HOST_NO_WORKSPACE_REGISTRY` | `status.degraded` | cwd 永远映射不到工作区，一切 fail-closed，“装上了却什么都不发生” | 宿主未提供 workspaceRegistry；换正确宿主 |
| `ERR_HOST_NO_TOKENMETER` | `status.degraded`（两种 `shadow` 模式都可见）+ 被拒替换的收据（仅 `shadow:false`） | 替换全部拒绝，投影账记 `unknown`；影子模式下只有 `degraded` 可见 | 宿主缺 `tokenMeter` 服务（§2.1） |
| `ERR_HOST_NO_ESTIMATOR` | `status.degraded` | `fixedOverheadTokens` 为 `'unknown'` | 宿主树缺 `@deepseek-ai/dsh-token-meter/estimate`；与上一行是两件事 |
| `ERR_HOST_NO_SPILL` | `status.degraded`（收据映射在任何模式；宿主探针仅 `projection:'on'`） | 超限回执不投影，`projection-skipped:no-spill` | 恢复/检查的是 spill **后端**（`dsh-spill-local`，§2.2） |
| `ERR_HOST_NO_SPILL_NOTICE` | `status.degraded`（收据映射） | spill 后端在，但页脚模块解析不到 `formatSpillNotice`；投影全部跳过，收据 `projection-skipped:no-footer`，原文保留 | 恢复宿主树里的 `@deepseek-ai/dsh-spill-policy/notice`；这是与 no-spill 不同的门（§2.2 末行） |
| `ERR_HOST_PLATFORM_UNSUPPORTED` | `status.degraded` | win32 上替换拒绝，投影不受影响 | 平台限制，无需处置 |
| `ERR_HOST_COMPLETE_SECTION` | `status.degraded` | 宿主的 `complete: true` 提示段在装配瀑布之后替换了整个系统提示，协议段没有到达出站请求；受影响请求上替换与投影 fail-closed（会话被判不可见），工作区明明可见插件却不动作 | 找出宿主提示配置里覆盖瀑布装配的 complete 段（通常属于另一个插件）；移除它，或接受这些请求上替换/投影不可用 |
| `ERR_RECEIPTS_TRUNCATED` | `status.degraded` | 收据分片超过 256 个；`status` 只聚合按名排序的前 256 个，`counts` 与两账因此都是**下界**，不是漏算就是少算——方向安全但数字偏小 | 归档或清理旧分片，重跑 `status`；要全量就分批统计 |
| `ERR_RECEIPTS_UNREADABLE` | `status.degraded` | 至少一个收据分片读不出来（EACCES、名为 `x.jsonl` 的目录等）；`status` 仍是**全量聚合**——健康分片照常计数——并带该码，数字因此可能不完整 | 检查 `$DSH_HOME/boost/receipts/` 的权限与异常条目，修复后重跑 `status`，对比修复前后计数 |
| `ERR_SCOPE_UNKNOWN_VERSION` | `status.degraded` + `scope-get` 失败 `code`；`shadow` 也拒绝 | scope 文件版本不是 2（含 v1）；读按 fail-closed 默认，写不盲改 | 跑一次 `scope-set` 走显式升级；或按 v2 手写 |
| `ERR_SCOPE_FUTURE_VERSION` | `status.degraded` + `scope-get` 失败 `code` | scope 文件版本比本插件认识的新；只读 | 升级插件；不要用旧版本覆盖 |
| `ERR_SCOPE_PARSE_FAILED` | `status.degraded` + `scope-get` 失败 `code` | scope 文件不是合法 scope 文档；读按默认、写拒绝 | 修文件或删除后重设；保留现场再处理 |
| `ERR_SCOPE_READ_FAILED` | `status.degraded` + `scope-get` 失败 `code` | scope 文件存在但读失败（权限等）；fail-closed 默认 | 修文件/权限后重试 |
| `ERR_SCOPE_REVISION_CONFLICT` | `scope-set` / `shadow` 失败 `code`（**不在** `degraded` 里） | 调用方的 `baseRevision` 已过期；CAS 拒绝，未覆盖 | 重读 `status` 取当前 `revision` 后重试 |
| `ERR_SCOPE_LOCKED` | `scope-set` / `shadow` 失败 `code` | 另一个写者持锁超过超时；本次写入未发生 | 确认没有并发写者后重试 |
| `ERR_SCOPE_ABORTED` | `scope-set` / `shadow` 失败 `code` | 调用方的取消信号打断了 `boost` 写入；锁已释放、`scope.json` 原样未动，无残留 | 重读 `status` 取当前 `revision` 后重试即可 |
| `ERR_BOOST_UNKNOWN_CMD` | `boost` 工具失败 `code` | `cmd` 不在 `status` / `scope-get` / `scope-set` / `shadow` 里 | 改传四个子命令之一 |
| `ERR_BOOST_INVALID_ARGS` | `boost` 工具失败 `code` | `baseRevision` 缺失或不是非负整数（`scope-set` / `shadow`） | 从 `status` 取整数 revision 再传 |
| `ERR_BOOST_INVALID_BODY` | `boost` 工具失败 `code` | `body` 形状/类型不对；`scope-set` 带了保留字段 `version` / `revision`；`shadow` 的 body 不是布尔 | 按工具 schema 重写 body |
| `ERR_BOOST_INTERNAL` | `boost` 工具失败 `code` | 未预期的内部失败（工具仍以值返回，不抛出） | 记录 `status` 与日志，按 bug 上报 |
| `ERR_HOST_VERSION_MISMATCH` | 加载日志警告 | 解析到的宿主版本不是验证线 `0.2.2-rc.4`；插件**仍然加载**，改名 API 仍可能让它失效 | 核对 `engines.dsh` 与宿主版本；换回验证线或接受风险 |
| `ERR_HOST_NO_AGENT_REQUEST` | 加载日志警告（一次） | `llm/stream` 前没观察到 `agent/request`；selector 路由捕获不到，多候选替换会 fail-closed | 宿主事件已废弃/移除；升级宿主，或只用单候选替换 |
| `ERR_BOOST_ALREADY_MOUNTED` | 加载日志警告 | 重复 `apply` 命中已有装配；本次注册跳过 | 确保只装配一次；移除重复的 bundle 行/重复加载 |
| `ERR_BOOST_SECTION_REGISTER_FAILED` | 加载日志警告 | 协议段注册失败；`registerHooks` 在第一个挂载处中止，后续替换/投影/execute 钩子都不会注册（`boost` 工具与会话事件仍会尝试挂载），请求路径实际 inert | 查宿主提示段冲突（另一个插件占了同名段）；修好后重启 |
| `ERR_BOOST_TOOL_REGISTER_FAILED` | 加载日志警告 | `boost` 工具注册失败；用户失去控制面 | 查宿主 `tools` 服务与日志；修好后重启 |
| `ERR_SCOPE_LOCK_TAKEOVER` | 日志警告（**不是**工具失败 `code`） | 锁龄超过 10 分钟，插件按接管处理（即使 pid 仍活）；只记录，不影响本次写入结果 | 无需处置；作为崩溃写者/pid 复用的证据保留 |

## 3. 20 任务回归门（只规定过程，不附带任务集）

这一节是可执行的过程说明。操作者自备任务清单；每条至少包含 `id`、`prompt` 与"完成"的判定方式
（`isError=false` 即工具调用没有报错）。**两轮**指同一任务在基线配置与开启配置下各跑一次。

设计 §6.1 的 pass 谓词原文：

> pass ⇔（两轮都完成且 `isError=false` 的任务数 ≥ 19）∧（每条被投影的回执都能用页脚 locator 取回，且取回字节数 = 页脚 `count` + 保留窗口字节数）

执行步骤：

1. 准备**恰好 20 条**任务；两轮使用同一宿主版本、同一模型路由、同一工作区快照。多一条会让 19/21
   通过也过门，门就比设计弱；判定按 20 条做。
2. 基线轮：`shadow: true`、`projection: 'off'`（或默认 `selected+[]`）。
3. 开启轮先把 `projection` 置为 `'on'`（`boost` 的 `scope-set`，见 §2.0）。**不存在按族开关**：
   `projection` 是一个全局模式，`resolveConfig` 总是补齐五个族（read/grep/glob/bash/ssh），配置里
   漏写某族也不会让它“关闭”。替换白名单固定为 read/grep/glob；**bash/ssh 不是替换族**，它们只受
   投影影响，永远不会被替换。要分批观察，只能改各族的 `triggerChars`：回执长度必须超过该族的
   trigger 才会被裁剪，所以把暂不观察的族 `triggerChars` 调高到测试回执长度以上，等于让该族
   保持原样；下一窗口再调回来。覆盖写在 profile 的用户 patch 层
   （`$DSH_HOME/profiles/<name>/cordis.patch.yml`）的 dsh-boost 行 `config` 里——patch 会整块替换
   `config`，必须把五个族都写全——然后重启宿主。先观察 read，再观察 grep/glob；bash/ssh 不参与
   替换批次。
4. 记录每条任务的完成状态与是否 `isError=false`；统计两轮都完成且无错的任务数。
5. `kind:'projection'` 回执分两种，不能一概而论。`code:'projected'` 的回执**不带 locator**：
   `before` / `after` / `saved_projection_tokens` / `unit` / `estimate` / `horizon_steps` 是它的
   账目字段；它的 locator 只在模型可见的页脚和进程内 retrieval ledger 里。`code:'projection-retrieval'`
   的回执**带** `locator`，并带 `retrieval_call_tokens` / `retrieval_content_tokens` /
   `retrieval_tokens`（`src/hooks/post-execute.ts` 的 `recordProjectionRetrieval`），所以 retrieval
   回执能和 locator 直接 join，`projected` 回执不能。对开启轮每条 `code:'projected'` 的回执，按
   可见页脚取 locator、在**磁盘上**量原文：
   - 从该工具结果的页脚 `(... Full formatted result stored at: <locator>. ...)` 取 locator；
   - **不要**用 `read <locator>` 的输出计数：那本身是一次 `read`，会被再次投影，输出不是原文，
     也不是完整 artifact；
   - 在磁盘上量原文：`wc -c <locator>`（locator 是宿主 spill 后端落盘的完整原文文件路径）；
   - 页脚 `Omitted N bytes` 的 N 是**省略的 UTF-8 字节数**；保留窗口字节数要从可见投影里分别
     取头部和尾部两段文本，用 `printf '%s' "$head" | wc -c` 与 `printf '%s' "$tail" | wc -c`
     量，**不是** `headChars + tailChars`：页脚按字节报数，首行
     `[output … chars; showing first … and last …]` 按字符报数，中文/emoji 下两者不相等；
   - 判定：`wc -c <locator>` == 页脚 N + 头部窗口字节数 + 尾部窗口字节数。任一条不成立即 pass
     失败；locator 不是当前机器可直接访问的文件路径时，这一条记为“未能复核”，不能算通过。
6. 结论只写"过门 / 未过门"；**不要**给 20 个任务算成功率或显著性——分辨率是 5 个点，判定不了 1 个百分点。
   v1 不声称守住了 A1 的 1pp。

回归门是"没有灾难性回退"的门，不是"成功率没降"的证明。

## 4. reasoning 兄弟块风险（必须在第一次开启替换的真实回合确认）

替换出来的合成工具回执进入历史后，下一次真实请求若走 Anthropic 兼容的 thinking 模式，服务端可能要求
assistant 的 `tool_use` 必须带兄弟 `thinking` 块。我们的合成回合目前没有 `replayState`，真实的
pi-ai `transformMessages` 会丢掉 thinking 块。

**影子周不能验证这条。** 影子期 `decideSubstitution` 走 record-only 分支：写一条
`{kind:'shadow', decision:'commit'}` 收据后直接返回（`ctx.doc.shadow` 分支，
`src/hooks/post-execute.ts`；代码里**没有** `shadowCommitted` 这个返回值），`projectDecision`
只记录、不改写 content，整个影子周不会合成任何回合；因此 `content[].thinking` 的 400 在结构上
不可能出现。在影子周检查只会永远读到“未见”，再被记成通过，随后可能在没有任何检查的情况下开启
替换。这条检查必须放到**第一次开启替换的真实回合**：把 `shadow` 设为 `false` 后
（`boost` 的 `{"cmd":"shadow","baseRevision":<rev>,"body":false}`），第一个被替换的只读调用就是
判定点；此后的每个替换观察窗也要继续记录。

**判定信号**：出现一个 **400**，且错误消息包含 `content[].thinking`。这表示被替换回合的 thinking 块
**没有到达线上**（不是参数错、不是模型错）。

处置：

1. 立即在该路由上**关闭替换**（`shadow` 设回 `true`；投影不受影响，可继续开），改用普通模型回合；
2. 保留该 400 的原始请求/响应与 session id，作为证据；
3. 在修复前不要重开：修复方向是给合成消息一个能保住 thinking 块的 `api`/`replayState`，或在该路由上
   永久不合成 `tool_use` 回合；
4. 投影不受这条风险影响，可继续开。

验收时把"第一次开启替换后是否见过 `content[].thinking` 400"写成明确的是/否；**没见到**也要写
“未见”，不能留空，也不能把影子周的“未见”当作结论。

## 5. 影子周与统计复算

### 5.1 影子报告（收据）

```bash
node scripts/shadow-report.mjs --dir "$DSH_HOME/boost/receipts"
```

输出四个标签（空目录输出四项零值，不抛错）：

| 字段 | 含义 |
|---|---|
| `saveableRatio` | 只读白名单真正能兑现的替换比例：`whitelisted` 影子提交 / 全部替换决策 |
| `byFamily` | 按**候选工具族**的命中率：`commits / decisions`。键是收据里的 `candidateTool`（门决定的族），不是刚执行的 `tool`；老收据没有该字段时回退到 `tool`。影子期绕过白名单，所以 bash/ssh 的潜力也计入 |
| `candidateRecall` | 候选集召回：`commits / (commits + no-candidate)`，分母是**到达绑定/守卫判定的替换决策数**（`commit` 与 `no-candidate` 两种结局各计一次，一次决策一条，**不是**候选条数——同一决策可有多个候选）；`guard-trivial` 不提出候选，不进分母 |
| `retrievalUpperBound` | 取回率上界：取回调用数 / 已应用投影回执数（取回回执本身不计入分母）。**只在 `projection: 'on'` 成立**：影子期只写 `kind:'shadow'` / `code:'projection-shadow'`，没有 `kind:'projection'` 回执，所以影子账上它按结构恒为 `0`，不能用它约束影子期取回损害 |

脚本读的是 `ReceiptStore` 写的同一套字段，只读完整行；尾部半行与坏行跳过；`kind:'projection'`
但缺 `unit:'raw'` 的 pre-schema 回执也会跳过，并在 stderr 打印跳过计数。它不需要 `src/` 或构建产物。

### 5.2 统计与快照（对应设计稿 §2.1 的口径）

`scripts/session-snapshot.json` 是一个**聚合**，不含任何会话正文：

- `asOf`：冻结时刻（`2026-11-19T03:13:21Z`，设计稿冻结提交的时间）与选择规则；
- 300 个会话的 `id`、`bytes`、`createdAt`；`bytes` 是**该时刻的原始前缀字节数**，不是压缩文件大小
  （压缩大小没有保留，见下面的选择口径脚注）；
- 每个会话的计数器：`steps`、`toolCalls`、`callsPerStep`、`requests`、`tokens`、
  `whitelist`、`valueTransfer`；
- `toolChars`：每个会话按工具族归因的回执字符数；
- `valueTransfer`：call-level 的逐字传递计数——位置是"下一步调用"，且上一步只有**一个**工具调用
  （回执来源唯一）；`full` 是该调用的长度 ≥ 4 的字符串参数全部逐字出现，`partial` 是未全绑定但至少一个
  ≥ 8 字符的参数逐字出现；
- 两条数值序列：每个请求的 `totalTokens` 与每个回执的字符数（中位数/分位数需要，仍然不含正文）。

快照按**一个会话一行**序列化：数组内的每个 session 对象占一行，diff 里可逐条 review；解析后的数字与
单行 JSON 完全相同。

复算（手工可重复，不碰会话目录；CI 只做发布门 dry-run，不跑统计复算，见 §6.1）。
机器可读的管道用下面两种之一：不带 `--silent` 的 `npm run stats` 会把 npm 的
`> dsh-boost@0.1.0 stats` 横幅打进 **stdout**（stderr 重定向拦不住），直接接 `jq` 之类会破：

```bash
npm run --silent stats
# 等价于
node scripts/session-stats.mjs --snapshot scripts/session-snapshot.json
```

从真实 `$DSH_HOME/sessions` 重生（只在需要更新快照时跑；会读 300 个大会话）：

```bash
node scripts/session-stats.mjs \
  --sessions "$DSH_HOME/sessions" \
  --as-of 2026-11-19T03:13:21Z \
  --out scripts/session-snapshot.json
```

`--as-of` 只统计该时刻及之前的记录，并按该时刻的**原始前缀字节**排序取前 300；这是因为设计稿的快照是
历史截面，而实时会话文件一直在增长。

空目录或全部文件解压失败时脚本**拒绝写快照并以非零退出**，避免一个 `$DSH_HOME` 拼写错误把已提交的聚合
覆盖成零值；确实要生成空快照时显式传 `--allow-empty`。部分会话损坏时会打印跳过计数，快照的
`selection.skipped` 也会记录。

**选择口径脚注（与设计稿的差异）**：设计稿按 `session.v4.jsonl.zstd` 的**压缩后**文件大小取前 300，但
压缩大小不会被会话日志保留；本快照按冻结时刻的**原始前缀字节**排序。两者在边界上会换入/换出不同会话，
因此本稿的 p50/p90/p99（648/4,635/18,186）与提交快照的复算值（623/4,572/18,087）差约 4%/1.4%/0.5%，
tool share 变动约 ±1.3pp。这是选择边界差，不是公式差；设计稿说的"<1% 漂移"只适用于同一选择规则的
重跑，不描述提交的这个聚合。

快照一旦提交就是权威：`--snapshot` 不重新选样，复算只复算已提交的聚合。若复算值与设计稿 §2.1 有出入，
按快照的实际值报告，**不得**改快照去凑设计稿数字。

## 6. CI 与发布旁路

### 6.1 workflow 做什么、不做什么

`.github/workflows/ci.yml` 在 `push` 到 `main`、`v*` tag 和 `pull_request` 时跑一个 job：

- 把 runner checkout 里的 `package-lock.json` 从 npmmirror 重写到 npmjs（§6.2），然后 `npm ci`；
- 跑 `npm publish --dry-run`。这会执行 `prepublishOnly` = `npm run ci`（typecheck + `npm test` +
  clean build）+ `npm run verify:package`，所以 §1 的整道门在 CI 里跑；
- 权限只有 `contents: read`，没有 registry token；`npm publish` 永远带 `--dry-run`，**从不发布**；
- `v*` tag **不会**把任何东西推到 registry；打 tag 只是再跑一遍同一个 dry-run。

注意：§1 的次安装会执行包内 lifecycle 脚本；`pull_request` 上也会执行。runner 是临时的、
没有 registry token，但这仍是在跑不可信代码——不要给这个 job 加 secrets 或写权限。

它**不**检查：真实发布所需的认证/2FA、registry 的 `latest` dist-tag、provenance/签名、装进真实
DSH 宿主后的行为、§3 的 20 任务门、§5 的统计复算。workflow 是为公共 GitHub mirror 准备的；
内部 GitLab remote 不执行它（见 yml 文件头）。

### 6.2 lockfile 的 China mirror

已提交的 `package-lock.json` 把所有 `resolved` URL 钉在 `registry.npmmirror.com`；在没有该镜像的
runner 上冷跑 `npm ci` 会 `ECONNREFUSED`，而 `--registry=https://registry.npmjs.org/` 不会覆盖
lockfile 里的 tarball URL。workflow 选的是**先重写、再安装**：一步 `sed` 把 runner 上的
`package-lock.json` 从 npmmirror 全量替换为 npmjs，并断言无残留，然后
`npm ci --registry=https://registry.npmjs.org/`。代价一句话：CI 从此依赖公网 npmjs，npmjs 不可达
时直接红、没有镜像兜底；换来的是 runner 不必能连中国镜像，且 integrity 仍逐 tarball 校验。
重写只发生在 runner 的 checkout，不提交回仓库；本地开发继续用 `.npmrc` 的镜像。

### 6.3 包内无法修复的旁路

`--ignore-scripts` and `npm publish <tgz>` skip the gate entirely; the only defence is running
`npm run verify:package` on the commit you tag. 具体地，`npm publish --ignore-scripts` 不跑
`prepublishOnly`，`npm publish ./dsh-boost-0.1.0.tgz` 对 tarball 发布也不跑包内任何脚本；两者都能
把没有 `dist/index.js` 的 8 文件空包推到 registry（本机 npm 11.19.1 实测：无 `dist/` 的干净 clone
上 `npm publish --dry-run --ignore-scripts` exit 0，8 files / 约 27 kB）。`prepublishOnly` 只保护
“在这个 checkout 里、不带 flags 的 `npm publish`”。npm **确实**有 `postpack` 钩子：它在 publish
时执行，非零退出会中止发布；但 `postpack` 看不到最终上传的那个 tarball，所以它不能替代对发布产物
的验收（而且 `--ignore-scripts` 与 `npm publish <tgz>` 会连它一起跳过）。真正的门仍是
`verify:package`。因此发布顺序只有一个：在**要打 tag 的那个 commit** 上运行
`npm run verify:package`（exit 0），确认 `git status --short` 干净后打 tag，再从同一个 checkout
执行不带 flags 的 `npm publish`；不要用 `--ignore-scripts`，不要发布手工 tarball。

## 7. 发布检查清单

- [ ] `npm ci` 成功（lockfile 与 `package.json` 一致），开发树可复现
- [ ] 在**要打 tag 的那个 commit** 上 `npm run verify:package` exit 0（§1）：exact allowlist（无多余/缺失条目，含 `dsh.bundle.patch` 指向的文件）、`dist/index.js` guard、所有 `exports`/`main`/`types` 与 `dsh.bundle.patch` 目标存在、主安装 `--ignore-scripts` 与次安装（生命周期脚本启用）都成功、两次安装的 import/require/locale 探针通过（en 与 zh）、tiny TS consumer 的 `tsc --noEmit` 通过（缺/错 `.d.ts` 会红）
- [ ] 该 commit 的 `git status --short` 为空；`verify:package` 只证明工作树或给定 tarball，不证明 commit 状态
- [ ] `prepublishOnly`（`npm run ci && npm run verify:package`）在发布前整体跑过一遍；明确知道 `npm publish --ignore-scripts` 和 `npm publish <tgz>` 会绕过它（§6.3）
- [ ] CI 在同一个 commit 上绿；明确知道它只 dry-run、不发布，`v*` tag 不会上传（§6.1）
- [ ] `dsh plugin --profile <name> add dsh-boost@^0.1.0`（或本地路径/tarball）成功，`--dump-config` 里有 `id: dsh-boost` 行
- [ ] 测试工作区已写入 `scope.workspaceIds`，`shadow: true`、`projection: 'on'` 经 `boost status` 确认
- [ ] no-tokenmeter 门按 §2.1 承担：单元测试注入 `hasTokenMeter: false` 锁定预期（替换拒绝、投影可用、账目 `unknown`、`ERR_HOST_NO_TOKENMETER`）；活宿主复核仅在确要部署缺该服务的宿主时做，先验健康态，再把 `shadow` 设为 `false` 验拒绝收据（影子模式下只有 `status.degraded` 可观察，不能算过门）
- [ ] no-spill 门按 §2.2 完整跑过：移除的是 spill **后端**（`dsh-spill-local`），观察到超限回执不投影、`projection-skipped:no-spill`、`ERR_HOST_NO_SPILL`；只移除 `dsh-spill-policy`（页脚格式化器，从宿主树解析）的话得到的是 `projection-skipped:no-footer` 与 `ERR_HOST_NO_SPILL_NOTICE`
- [ ] 两条降级路径都保留 status/收据证据；验收中出现的每个稳定码都按 §2.5 的矩阵处置并留证（含 `ERR_HOST_NO_SPILL_NOTICE` / `ERR_HOST_VERSION_MISMATCH` / `ERR_BOOST_SECTION_REGISTER_FAILED`，以及已有的 `ERR_RECEIPTS_UNREADABLE` / `ERR_RECEIPTS_TRUNCATED` / `ERR_HOST_COMPLETE_SECTION` / `ERR_SCOPE_ABORTED`）
- [ ] 20 任务门按 §3 跑过，pass 谓词逐字对照，结论只有"过门/未过门"
- [ ] 第一次开启替换的真实回合检查 `content[].thinking` 400（不是影子周）；若有，替换在该路由关闭
- [ ] `npm run --silent stats` 在干净 clone 上可复算 §5.2 的聚合（口径对应设计稿 §2.1）
- [ ] 发布侧：`npm publish` 走 `publishConfig.registry`（registry.npmjs.org、public）；0.1.0 是首次发布，发布后用 `npm view dsh-boost dist-tags` 确认 `latest` 是 0.1.0；`dsh-boost@^0.1.0` 就是正确的安装规格
