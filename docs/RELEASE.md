# dsh-boost 发布验收

本文是 `dsh-boost` 0.2.2 的发布验收手册（版本以 `package.json` 为准）。它覆盖四件事：

1. `npm run verify:package` 一条命令的打包与产物验收（§1），以及零 peerDependencies 现状下
   两条降级路径的验收方式（§2）；
2. 20 任务回归门的**判定过程**与 pass 谓词（任务清单由操作者自备）；
3. 影子周脚本的跑法、`session-snapshot.json` 的来源与复算方式；
4. CI 到底做什么、不做什么，lockfile 的 China mirror 怎么处理，以及 npm 的发布旁路（§6）。

> 记录在案的决定：本项目**不附带** 20 任务回放集，也不提供 `test/regression/run.mjs`。用户明确
> 否决的是"搭回放集"的**语料**部分（2026-11-18）；这条豁免**只免除语料**。冒烟 runner 与
> locator 取回完整性检查**不需要语料**，不在这条豁免内——当前两者都未交付。因此第 3 节只规定
> 过程与判据，**不伪造任务集**。

---

## 1. 打包与产物验收：一条命令

在仓库根目录：

```bash
npm run verify:package
```

`scripts/verify-package.mjs` 把机械验收一次做完。它不依赖 `npm publish` 或 `prepublishOnly`，
可以单独跑；前置条件只有一次 `npm ci`（脚本会显式跑 `npm run build`，需要仓库自己的 `tsc`）。
0.1.2 的发布 commit `3ec82f3` 上实测 exit 0：tarball 78 个条目，回执里 10 条 `checks` 记录。
这两个数字是 0.1.2 的记录；`0.2.0` 的 `verify-package.mjs` 增加了断言，发布前请在目标 commit
上重跑并以其回执为准。
两个数字都随树的形状变化（条目数随文件集合，`checks` 数随脚本里的断言组），不是版本常量：

1. 脚本显式跑 `npm run build`，再用 `npm pack --ignore-scripts` 打出真实 tarball。
   `--ignore-scripts` 的作用不是挡住重建——`prepare` 现在存在（`scripts/prepare-build.mjs`：
   只在 `dist/index.js`（或 `lib/client.js`）缺失时构建，供 git 安装使用；`scripts/` 不进 tarball），但
   `--ignore-scripts` 会跳过它，所以 tarball 只描述上一条 `npm run build` 留下的那棵树；
   将来若有人把 `prepare` 改成无条件重建，这条也不会让它在断言之前悄悄重建（并“修复”）工作树。
   显式构建后打包，包内容就是这次构建的产物；干净 clone 上即使 `dist/` 不存在也能跑，因为构建
   发生在打包之前。
2. **exact allowlist**：每一个 tar 条目都必须由五类来源之一解释——固定根文件（`package.json`、
   `LICENSE`、`NOTICE`、两份 README）、`dsh.bundle.patch` 指向的 patch 文件、`locale/*.json`、
   `exports["./client"]` 指向的客户端产物（仅当 `dsh.client` 声明时；两者必须同时存在或同时缺席，
   缺一半会在 allowlist 之前点名），或 `src/**/*.ts` 对应的一个 `dist/**.js` + `.js.map`
   （声明文件只发 `dist/index.d.ts` 与 `dist/types.d.ts` 两个；其余内部 `.d.ts` 被 `files` 的
   `!dist/**/*.d.ts` 排除）。多出 `package/dist/ghost.js`
   之类的条目立即失败并点名；少一个也失败并列出缺失项。这是精确集合，不是“必需项齐全 + 禁止前缀
   不出现”。patch 条目不是硬编码的 `cordis.patch.yml`：脚本从 `package.json` 的
   `dsh.bundle.patch` 派生它，字段缺失、不是字符串或指向不存在的文件都会红；指向不存在的文件时，
   脚本在 allowlist 之前就点名那条声明（不会把仍在树里的旧 patch 报成“不在允许清单”）。默认路径
   会先构建，所以“少一个”不能靠删工作树文件复现——构建会把 `dist/` 重新生成。要复现缺失/多余
   条目，用 `npm pack --ignore-scripts` 打一个不重建的 tarball，再跑
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
`prepublishOnly` 现在就是 `npm run ci && npm run verify:package -- --prebuilt`（`ci` = typecheck +
test + build）；`--prebuilt` 让 allowlist 描述 `ci` 刚构建的那棵树，而不是在验收里再重建。所以
**不带 flags 的** `npm publish` 本身会跑完这道门。但 npm 仍有两个旁路，见 §6.3。

### 1.0 客户端半：构建与开发页

设置页的浏览器产物是 `lib/client.js`（单个 CJS 文件，外包宿主的
`window.__ModuleLoader__.load({ id, factory })` 信封）。它**不**由 `tsc` 产出，而是由 `vite`：

```bash
npm run build:client   # 产出 lib/client.js
npm run dev:ui         # 独立开发页，不需要宿主
```

`npm run build` 已经包含 `build:client`，所以 `ci` 与 `prepublishOnly` 都会构建它。`lib/` 与
`dist/` 一样不入库（`.gitignore`），发布时由构建产出。

构建的两个不可省之处，改动前先读 `ui/vite.config.ts` 的注释：

- **React 必须 external**。宿主以共享单例提供 React 18，bundle 里再打一份就是第二个实例，hooks 会崩。
- **构建必须按 production 出 JSX 转换**。开发模式会发 `require("react/jsx-dev-runtime")`，而宿主的
  模块表里只有 `react/jsx-runtime`——文件在桩里能加载，进设置页就抛 `Cannot find module`。

`test/client-bundle.test.ts` 用 `NODE_ENV=test` 构建并把产物**执行**在宿主的加载器桩上（不是
正则匹配源码），所以上面两条都有测试钉住；它还断言 `apply` 确实向 `settings.section` 认领了座位
（`name`/`id`/`order` 三者是契约，T5 只改 `label` 的**文本**）。

### 1.0.1 两条不变式

本包的发布门守两条不变式，**各自对应一套产物**，不能互相替代：

1. **服务端**：`dist/` 里不得出现对 `@deepseek-ai/*` 的**静态** import。宿主包只以精确钉版的
   devDependency 存在，装机时不会带出宿主树；静态 import 会让消费方在缺宿主树时
   `ERR_MODULE_NOT_FOUND`。守卫是 `assertDeclarationsDoNotImportHostTypes`（声明文件侧）与
   消费方的 `typecheck-no-host-stubs`（运行与类型两侧）。
2. **客户端**：`lib/client.js` **只允许**通过 `require` 解析宿主平台模块，且必须带加载器信封。
   宿主按 URL 把它当经典脚本加载，从不经过 Node 的解析器——所以任何 install 探针都看不见它能否
   加载，只能在打包后的字节上断言。守卫是 `assertClientBundleText`：信封、`id` 等于包名、
   `factory`、`apply`/`inject` 导出、`require("react…")` 存在、无内联 React、无
   `jsx-dev-runtime`。

第 2 条在门里是 `client-bundle-structure` 一项。它为什么必须单独存在：这条路径上的每一种坏法
（漏信封、`id` 写错、React 被打进产物、用了 dev 的 JSX 转换）都会让文件在桩里**正常加载**，然后
在设置页里失败。`test/verify-client.test.ts` 用构造产物逐个打红这八种坏法。

端到端复现其中一种（`--prebuilt` 直接打当前树，不重建）：

```bash
sed -i '1s|window.__ModuleLoader__.load({|(function () {|' lib/client.js
npm run verify:package -- --prebuilt   # exit 1，消息点名「no ... envelope」
git checkout lib/client.js             # 或 npm run build:client 重建
```

### 1.1 手工回退与维护

- `npm ci`：按已提交的 `package-lock.json` 复现开发依赖树（TypeScript、`tsx`、`@types/node`
  都由 lockfile 钉住）。`verify:package` 用的是当前工作树，不替你确认 commit 状态。
- 完整路径清单已由 exact allowlist 覆盖，不需要再手工 `diff` 集合。要审**内容**（不是路径集合）
  仍然可以 `tar -tzf "dsh-boost-$(node -p "require('./package.json').version").tgz"` 或
  `npm pack --dry-run` 人工看（前者要求 tarball 就在仓库根目录）。
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
  `dist`、`locale`、`cordis.patch.yml`、两份 README、`LICENSE`、`NOTICE`）；`dist/` 由
  `npm run build`（clean + `tsc` + 客户端）构建；`prepare`（`scripts/prepare-build.mjs`）按缺失的那一半分别构建（git 安装用）——`dist/index.js` 与 `lib/client.js` 都在时是 no-op，所以 `npm publish` 的
  pack 步骤不会重建已构建的树；sourcemap 以 `inlineSources` 内联源码，装好的包没有 `src/`
  也能对上源码。

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
# 在仓库根目录求版本，tarball 文件名随之变化；手工下载的包直接写绝对路径
TARBALL="/path/to/dsh-boost-$(node -p "require('./package.json').version").tgz"
dsh plugin --profile accept add "$TARBALL"
# 或本地 checkout 目录；从 registry 安装时写 dsh-boost@^0.2.0 --registry=https://registry.npmjs.org/
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
`"on"`，且 `hasSpill` 为 `true`（存在性；若 `degraded` 带 `ERR_HOST_SPILL_UNUSABLE`，服务在但
不可用，投影会逐条跳过）。这几项是后续所有观察的前置条件；只看“我记得设了”不算数。

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

### 2.0.1 人可点的路径：设置页

`0.2.0` 起除了 `boost` 工具，还有一条不用模型介入的路径：宿主设置面板里的 **Token 效率**（`settings.section`，id `boost`）。它读写的是**同一份** `scope.json`、走**同一个** CAS，所以两条路径可以混用——页面上改的东西 `boost status` 立刻看得见，反过来也一样。

验证顺序（在 §2.0 之后跑）：

1. 打开宿主设置面板，确认「Token 效率」一节在。不在的话先看 `status.degraded` 里有没有 `ERR_BOOST_PARTIAL_MOUNT`（提示段或钩子没挂上），再看宿主日志里有没有 `webServer`。
2. `curl -s http://127.0.0.1:<port>/dsh-boost/api/state | head -c 200` 应当返回 `{"status":…,"scope":…,"workspaces":…,"config":…}` 四块。返回 `{"error":"ERR_HTTP_FORBIDDEN"}` 说明 `Host` 不在受信名单里（反向代理没透传 `Host`，或用了非 loopback 的地址而宿主没 `--trusted-host`）。
3. 在页面上把「作用范围」改成「所有工作区」并保存，然后 `boost status` 的 `scope.mode` 应当立刻是 `global`。
4. 制造一次冲突：页面不重读，另外用工具跑一次 `scope-set`，再在页面上保存——应当拿到 `ERR_SCOPE_REVISION_CONFLICT` 与一个显式的「重新读取」按钮，**草稿不被覆盖**。

**`^0.1.4` 的用户要显式升到 `0.2.0`**：`^0.1.4` 不会跨大版本，`npm install dsh-boost` 拿到的仍是 `0.1.4`。设置页是新增对外面（`dsh.client`、`./client`、HTTP 路由、客户端产物），按 SemVer 走次版本。

### 2.1 降级门：宿主缺 `tokenMeter`（先验健康，再验降级）

**门的构造方式变了。** `tokenMeter` 从来是宿主服务（`ctx.get('tokenMeter')`），不是本包安装的
包；过去它同时是 optional peer，可以用 npm 往消费项目里装/卸来构造“缺失”——**包已不声明任何
peer**（§2.4），消费项目 `node_modules` 里装什么、卸什么都不再影响宿主进程里的服务，
`npm uninstall` 那条路线整条作废。现在这个门由两层承担：

- **单元测试注入宿主事实**：`test/host.test.ts` 以 `host: { hasTokenMeter: false }` 之类的宿主
  事实断言下表的全部预期（`npm test` 全套）；`test/boost-tool.test.ts` 只断言该字段**缺席**时的
  渲染（不注入 `hasTokenMeter`）。缺服务时的加载、替换拒绝与 `ERR_HOST_NO_TOKENMETER` 都在这层
  被锁定。
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
`SpillStore` 抽象服务的本地实现）；`@deepseek-ai/dsh-spill-policy` **不是**“只是页脚格式化器”，
而是宿主的 token 预算保留策略：它的 `apply` 给已接受的工具结果与 PTC 日志挂上保留/省略逻辑，
保留原语（`TextRetainer` / `ItemRetainer` / `describeOmitted` / `formatRetentionNotice`）来自它
依赖的 `@deepseek-ai/dsh-output-retention`。本插件只消费它的 `./notice` 子路径
（`@deepseek-ai/dsh-spill-policy/notice` 的 `formatSpillNotice`）来渲染页脚；卸它得到的是
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
- 与宿主的兼容性由 `engines.dsh`（区间 `>=0.2.2-rc.4 <0.2.3-0`，按宿主自己的 `includePrerelease` 语义）声明；`engines.node` 是
  `>=24.9.0`（对齐宿主 `@deepseek-ai/dsh@0.2.2-rc.4` 的 Node 下限）。加载时若解析到的宿主版本
  **落在区间外**，插件告警 `ERR_HOST_VERSION_MISMATCH` 但**仍然加载**（advisory：版本不符是风险，
  不是 API 已改的证明；改名仍可能让插件失效）。区间内但不是验证过的 `0.2.2-rc.4`（如 `rc.5` /
  `0.2.2`）只记 info、不发码——`0.2.2-rc.5` 与本插件触及的九个包逐字节相同。

安装规格：**`dsh-boost@^0.2.2`**。registry 上有九条版本记录，其中一条是占位版本，不要把它当成
“更早的 API”：

- `0.2.2` — 当前 `latest`；第二轮通读后的修复，其中三条是 0.2.1 带着发布的（写失败码被 `SCOPE_CODES` 吞成 `ERR_BOOST_INTERNAL`、git 安装缺 `lib/client.js`、`/state` 失败被渲染成「一切正常」）；
- `0.2.1` — 第一轮通读后的修复，其中三条是 0.2.0 带着发布的行为错误（状态面板读高一层信封、危险提示挂错开关、写失败被报成读失败）；
- `0.2.0` — 首个带设置页的版本；新增设置页（`dsh.client`、`./client` 出口、`/dsh-boost/api` 路由、
  随包发布的 `lib/client.js`）与中英双语；`0.1.x` 没有设置页；
- `0.1.4` — 上一版；替换节省下界不再可能高于上界（上下文缩小即丢下界），投影页脚救出被切断
  中段的 `[exit code: N]` 等信号；
- `0.1.3` — 替换不再在模型看不到的输出上提交，节省改报上下界区间（`avoided_total_tokens`），
  新增三个宿主能力降级码与 `status.hasSpill`；
- `0.1.2` — 含 scope 文件写入的修复（§2.5）；
- `0.1.1` — 十项修复；
- `0.1.0` — 首个可用版本，**缺 0.1.1 及以后的全部修复**，其中数项修的是静默失效；
- `0.0.0-stage` — npm 对**全新包**做 staged publish 时自动创建的公开占位版本（`stub: true`，
  描述是 “Temporary package placeholder for staged publishing”；tarball 只有 `package.json` +
  `README.md`，没有 `dist/`）。它装得上，但 `import 'dsh-boost'` 报 `ERR_MODULE_NOT_FOUND`；
  它低于 `0.1.0`，所以 `^0.1.0` **不会**选中它，`latest` 也不是它。

**写成 `^0.2.0` 而不是 `^0.1.4`**：`^` 不跨大版本，`^0.1.4` 永远解析不到 `0.2.0`，所以从 `0.1.x`
升上来必须显式写 `@^0.2.0`；`^0.2.0` 表达的是“至少含 0.2.0 的修复”，镜像在发布后短暂滞后时它会
解析失败，而不是悄悄装回没有设置页的旧构建。在意 registry 时显式传
`--registry=https://registry.npmjs.org/`。

本仓库的 `.npmrc` 与 `package-lock.json` 已钉在 `registry.npmjs.org`（与 `publishConfig` 同一个
源），CI 断言 lockfile 里不残留 `registry.npmmirror.com`。发布者执行 `npm publish` 即可
（`prepublishOnly` 跑 `ci` + `verify:package -- --prebuilt`）。

建议（可选，不属于发布门）：给占位版本加一条弃用说明，让误装的人看到原因——
`npm deprecate dsh-boost@0.0.0-stage "npm first-publish placeholder" --registry=https://registry.npmjs.org/`。
它只写该版本的 deprecation 元数据，不改 `latest`、不影响 `^0.2.2` 的解析；本文档只建议，
不代替发布者执行。

本节取代旧版安装矩阵（rc.4 / rc.5 两侧对照、含一行 `ERESOLVE` 失败）：那张表记录的是 **peer
还存在时**的安装行为，自 `0567347` 起不再适用；§1 的 `verify:package` 与上面的裸装事实是现行
依据。

#### `0.2.2-rc.5` 逐字节复核（2026-11-21）

`engines.dsh` 的上界放行 `0.2.2-rc.5`，依据是它在本插件触及的九个宿主包里与 rc.4 逐字节相同。
这条断言可以复跑（需要能访问 registry；无 `DIFF` 输出即九个包的 `lib/` 全部相同）：

```bash
export npm_config_cache=/tmp/npmcache   # 本仓库验收环境的缓存位置；普通环境可省略
pkgs="dsh-agent dsh-app-boot dsh-llm dsh-session dsh-spill dsh-spill-policy dsh-system-prompt dsh-token-meter dsh-tools"
d=$(mktemp -d)
for v in 0.2.2-rc.4 0.2.2-rc.5; do for p in $pkgs; do
  npm pack --silent --pack-destination "$d" "@deepseek-ai/$p@$v" >/dev/null
  mkdir -p "$d/$v/$p"; tar -xzf "$d/deepseek-ai-$p-$v.tgz" -C "$d/$v/$p" --strip-components=1
done; done
for p in $pkgs; do diff -r "$d/0.2.2-rc.4/$p/lib" "$d/0.2.2-rc.5/$p/lib" >/dev/null || echo "DIFF $p"; done
```

九个包：`dsh-agent`、`dsh-app-boot`、`dsh-llm`、`dsh-session`、`dsh-spill`、`dsh-spill-policy`、
`dsh-system-prompt`、`dsh-token-meter`、`dsh-tools`。只比较 `lib/`（发布的运行时代码）；tarball
的 `package.json` 版本字段本来就不同。2026-11-21 复核结果为零差异。

### 2.5 降级码矩阵（稳定码全表）

`boost status` 的 `degraded` 数组与 `boost` 工具调用的失败 `code` 都是稳定契约；日志里的稳定码
是第三类观察面，不是工具返回值。§2.1、§2.2 是可构造的门的验收细则；本表是操作者看到某个码时的
速查。收据流里的 `projection-skipped:no-spill` / `projection-skipped:no-footer` 是**输入**，
分别映射成 `ERR_HOST_NO_SPILL` / `ERR_HOST_NO_SPILL_NOTICE`，本身不是稳定码。本表的代码行号以
0.2.2 的发布 commit `db3da9b` 为准；源码继续演进时按函数名/命令名定位（行号可能已移动）。

`ERR_HTTP_*` 是**设置页数据路由**的响应体码，不是 `status.degraded` 的成员：路由的每次失败都以
JSON 体返回一个码，页面据码决定说什么。`ERR_CLIENT_*` 是页面自己产生的两个码（读不到路由、
返回体形状不认识），只出现在页面上，不经过网络。

路由是**一个** prefix 注册（`/dsh-boost/api`），两个端点：

| 端点 | 方法 | 作用 |
|---|---|---|
| `/state` | `GET` / `HEAD` | 页面读的全部数据：`status`、`scope`、`workspaces`、`config`，与 `boost status` / `scope-get` 同一份计算 |
| `/scope` | `POST` | 写四个可写字段，走 `scope-set` 的校验与 CAS；体是 `{ body, baseRevision }`，上限 64 KiB |

两者都过同源栅栏（`src/http/fence.ts`），但**写要求 `Origin`**：浏览器对同源 `GET` 不发 `Origin`，
对写一定会发，所以「读放行缺失的 `Origin`、写要求它」既能挡住跨站写，又不会把页面自己的读挡掉。
`Host` 必须是 loopback 或宿主的 `trustedHosts` 之一，防的是 DNS rebinding——只比 `Origin` 与 `Host`
挡不住它，因为攻击者可以把两者都设成自己的域名。

| 码 | 观察面 | 可观察症状 | 操作者动作 |
|---|---|---|---|
| `ERR_HOST_NO_WORKSPACE_REGISTRY` | `status.degraded` | cwd 永远映射不到工作区，一切 fail-closed，“装上了却什么都不发生” | 宿主未提供 workspaceRegistry；换正确宿主 |
| `ERR_HOST_NO_TOKENMETER` | `status.degraded`（两种 `shadow` 模式都可见）+ 被拒替换的收据（仅 `shadow:false`） | 替换全部拒绝，投影账记 `unknown`；影子模式下只有 `degraded` 可见 | 宿主缺 `tokenMeter` 服务（§2.1） |
| `ERR_HOST_NO_ESTIMATOR` | `status.degraded` | `fixedOverheadTokens` 为 `'unknown'` | 宿主树缺 `@deepseek-ai/dsh-token-meter/estimate`；与上一行是两件事 |
| `ERR_HOST_NO_SPILL` | `status.degraded`（收据映射在任何模式；宿主探针仅 `projection:'on'`） | 超限回执不投影，`projection-skipped:no-spill` | 恢复/检查的是 spill **后端**（`dsh-spill-local`，§2.2） |
| `ERR_HOST_NO_SPILL_NOTICE` | `status.degraded`（收据映射） | spill 后端在，但页脚模块解析不到 `formatSpillNotice`；投影全部跳过，收据 `projection-skipped:no-footer`，原文保留 | 恢复宿主树里的 `@deepseek-ai/dsh-spill-policy/notice`；这是与 no-spill 不同的门（§2.2 末行） |
| `ERR_HOST_SPILL_FAILING` | `status.degraded`（收据映射） | spill 后端**在**，但 `saveText` 每次都被拒；投影全部跳过，收据 `projection-skipped:spill-failed`，原文保留。与 `ERR_HOST_NO_SPILL`（后端缺失）是两种状态，修法不同 | 查后端写权限/磁盘/路径；`ERR_HOST_NO_SPILL` 那条的处置会把人引向「重装 spill 包」，在这里是错的 |
| `ERR_HOST_WORKSPACE_REGISTRY_BROKEN` | `status.degraded` | registry 服务在，但 `list()` 抛错或返回的不是数组：每个会话都被判不可见，投影与替换全部跳过，而 `hasWorkspaceRegistry` 仍是 `true`——没有这个码，`status` 看起来是健康的 | 查宿主 workspace 存储（`~/.dsh/storages/workspace.json` 或宿主自身日志）；这不是"没装服务"，重装无用 |
| `ERR_HOST_SPILL_UNUSABLE` | `status.degraded` | spill 后端服务在，但不提供 `saveText`（例如只注入了一个 `{}`）：apply 模式的投影无法落盘，`hasSpill` 仍为 `true` | 查宿主注入的 spill 服务是不是真后端（`dsh-spill-local`，§2.2）；与 `ERR_HOST_NO_SPILL`（服务缺失）是两种状态 |
| `ERR_HOST_SELECTOR_UNAVAILABLE` | `status.degraded`（只由 `selector-unavailable` 收据映射） | LLM 软依赖不可用：多候选计划永远弃权，单候选替换不受影响。`selector-error` **不映射**——它是可能瞬时的调用失败，按历史求和会把健康宿主永久标成降级（`src/tools/boost.ts:239-250`） | 查 LLM 路由；`selector-abstain` 与 `selector-error` 都不映射到本码，前者是正常弃权，后者看收据计数 |
| `ERR_HOST_PLATFORM_UNSUPPORTED` | `status.degraded` | win32 上替换拒绝，投影不受影响 | 平台限制，无需处置 |
| `ERR_HOST_COMPLETE_SECTION` | `status.degraded` | 宿主的 `complete: true` 提示段在装配瀑布之后替换了整个系统提示，协议段没有到达出站请求；受影响请求上替换与投影 fail-closed（会话被判不可见），工作区明明可见插件却不动作 | 找出宿主提示配置里覆盖瀑布装配的 complete 段（通常属于另一个插件）；移除它，或接受这些请求上替换/投影不可用 |
| `ERR_RECEIPTS_TRUNCATED` | `status.degraded` | 收据分片超过 256 个；`status` 只聚合按名排序的前 256 个，`counts` 与两账因此都是**下界**，不是漏算就是少算——方向安全但数字偏小 | 归档或清理旧分片，重跑 `status`；要全量就分批统计 |
| `ERR_RECEIPTS_UNREADABLE` | `status.degraded` | 至少一个收据分片读不出来（EACCES、名为 `x.jsonl` 的目录等）；`status` 仍是**全量聚合**——健康分片照常计数——并带该码，数字因此可能不完整 | 检查 `<dshHome>/boost/receipts/`（设了 `config.dshHome` 时以它为准，否则 `$DSH_HOME`）的权限与异常条目，修复后重跑 `status`，对比修复前后计数 |
| `ERR_SCOPE_UNKNOWN_VERSION` | `status.degraded` + `scope-get` 失败 `code`；`shadow` 对两种都拒绝 | scope 文件版本不是 2。分两种：**v1**（带可识别的旧字段，读出的 code 是它且带 `upgrade`）与**无法识别**（version 缺失或非数值，没有 `upgrade`）。读都按 fail-closed 默认 | **v1**：`scope-set` 是文档化的升级路径，会保留 `mode`/`global`/`workspaceIds` 并写成 v2（`src/scope/store.ts:323-345`、`src/tools/boost.ts` 的 `scopeSetCommand`，`1dd93c6` 的 `:1139-1149`）；`shadow` **拒绝** v1，不做隐式升级（`src/tools/boost.ts` 的 `shadowCommand`，`1dd93c6` 的 `:1160-1169`）。**无法识别**：`scope-set` 与 `shadow` **都拒绝**（`src/scope/store.ts:336-341`），必须自己修文件（补 `"version": 2`）或把它移走后重设——插件不会替你覆盖 |
| `ERR_SCOPE_FUTURE_VERSION` | `status.degraded` + `scope-get` 失败 `code` | scope 文件版本比本插件认识的新；只读 | 升级插件；不要用旧版本覆盖 |
| `ERR_SCOPE_PARSE_FAILED` | `status.degraded` + `scope-get` 失败 `code` | scope 文件不是合法 scope 文档（坏 JSON、非对象、数组）。读按默认；**写一律拒绝**，`scope-set` / `shadow` 不会覆盖它——文件原样留在盘上 | 修文件或删除后重设。**插件不会替你覆盖**，所以「保留现场」是默认结果，不是需要你额外做的事 |
| `ERR_SCOPE_READ_FAILED` | `status.degraded` + `scope-get` 失败 `code` | scope 文件存在但**读不出来**（权限、I/O、路径是目录）；fail-closed 默认 | 查文件与目录权限与异常条目；修好后重试 |
| `ERR_SCOPE_WRITE_FAILED` | `/scope` 写失败 `code`（HTTP 500） | scope 文件**写不进去**：`writeAtomic` 落盘或 `ensureDirectory` 建目录失败（权限、磁盘满、IO）。与 `ERR_SCOPE_READ_FAILED` 分开，因为基线仍然有效、草稿仍然可用——建议「重新读取」会丢掉一份好草稿 | 查目录权限与剩余空间；改好后原样重试，不需要重读 |
| `ERR_SCOPE_REVISION_CONFLICT` | `scope-set` / `shadow` 失败 `code`（**不在** `degraded` 里） | 调用方的 `baseRevision` 已过期；CAS 拒绝，未覆盖 | 重读 `status` 取当前 `revision` 后重试 |
| `ERR_SCOPE_LOCKED` | `scope-set` / `shadow` 失败 `code` | 两种情形共用这个码：**锁被另一个写者持有**（未判定为陈旧，也未到 10 分钟接管阈值），或**锁文件根本创建不出来/写不进去**（目录只读、磁盘满、`.lock` 被一个目录占住）。两种情形本次写入都未发生。插件**不等待**：判定为 `'held'` 时立即抛 | 先排除「锁文件建不出来」——查 `<dshHome>/boost` 的写权限、剩余空间与同名异常条目；确认是并发写者才重试。60 s 陈旧 / 10 min 接管是分类阈值，不是等待时间 |
| `ERR_SCOPE_ABORTED` | `scope-set` / `shadow` 失败 `code` | 调用方的取消信号打断了 `boost` 写入；锁已释放、`scope.json` 原样未动，无残留 | 重读 `status` 取当前 `revision` 后重试即可 |
| `ERR_BOOST_UNKNOWN_CMD` | `boost` 工具失败 `code` | `cmd` 不在 `status` / `scope-get` / `scope-set` / `shadow` 里 | 改传四个子命令之一 |
| `ERR_BOOST_INVALID_ARGS` | `boost` 工具失败 `code` | `baseRevision` 缺失或不是非负整数（`scope-set` / `shadow`） | 从 `status` 取整数 revision 再传 |
| `ERR_BOOST_INVALID_BODY` | `boost` 工具失败 `code` | `body` 形状/类型不对；`scope-set` 带了保留字段 `version` / `revision`；`shadow` 的 body 不是布尔 | 按工具 schema 重写 body |
| `ERR_BOOST_INTERNAL` | `boost` 工具失败 `code` | 未预期的内部失败（工具仍以值返回，不抛出） | 记录 `status` 与日志，按 bug 上报 |
| `ERR_HOST_VERSION_MISMATCH` | 加载日志警告 | 解析到的宿主版本**落在 `engines.dsh` 区间外**（`<0.2.2-rc.4` 或 `>=0.2.3-0`）；插件**仍然加载**，改名 API 仍可能让它失效。区间内的 `rc.5` / `0.2.2` 只记 info，不发码 | 核对 `engines.dsh` 与宿主版本；换回区间内或接受风险 |
| `ERR_HOST_NO_AGENT_REQUEST` | 加载日志警告（一次） | `llm/stream` 前没观察到 `agent/request`；selector 路由捕获不到，多候选替换会 fail-closed | 宿主事件已废弃/移除；升级宿主，或只用单候选替换 |
| `ERR_HOST_NO_SYSTEM_PROMPT_ASSEMBLE` | 加载日志警告（一次） | 首个 `agent/pre-step` 到达前从未观察到 `system-prompt/assemble`：协议段无法预热/打补丁（事件可能被改名或移除）。事件名同时进 `missingMounts`，所以 `status.degraded` 里看到的是 `ERR_BOOST_PARTIAL_MOUNT` | 核对宿主提示装配事件；升级宿主，或接受协议段不可用 |
| `ERR_HOST_NO_AGENT_PRE_STEP` | 加载日志警告（一次） | 首个**主** `llm/stream` 前没有该会话的 `agent/pre-step`：步进时钟无法推进，替换不可能（带 `purpose` 的辅助请求不触发）。同样进 `missingMounts` | 升级宿主；此宿主上替换不可用，投影仍可用 |
| `ERR_HTTP_FORBIDDEN` | 设置页路由的响应体（403） | 请求被同源栅栏拒绝：`Host` 既不是 loopback 也不在宿主的 `trustedHosts` 里；或 `sec-fetch-site: cross-site`；或 `Origin` 与 `Host` 指向不同的 authority；或 `Origin` 在但解析不了 | 用受信的 Host 打开页面（宿主启动时的 `--trusted-host`）；反向代理没把 `Host` 透传过来时，页面与路由看到的是两个 authority |
| `ERR_HTTP_METHOD` | 设置页路由的响应体（405） | 对 `/state` 发了写，或对 `/scope` 发了 `GET`/`HEAD`/`POST` 以外的方法 | 检查调用方；这不是权限问题，是路由不提供那种方法 |
| `ERR_HTTP_BODY` | 设置页路由的响应体（400） | 写请求的体不是合法 JSON，或超过 64 KiB | 检查调用方；页面自己不会发出这种请求 |
| `ERR_HTTP_NOT_FOUND` | 设置页路由的响应体（404） | 前缀匹配上了但子路径不认识：页面与服务端版本不一致 | 升级插件到页面与产物同一个版本 |
| `ERR_HTTP_INTERNAL` | 设置页路由的响应体（500） | `status`/`scope` 的计算在路由里抛了（宿主服务的 getter 抛错）。四个字段一个都不会返回 | 看宿主日志；这是 bug 级失败，不是配置问题 |
| `ERR_HTTP_WORKSPACES_UNAVAILABLE` | 设置页路由的响应体（`workspaces.available === false`） | 宿主没有 workspace 注册表，或 `list()` 抛错/返回的不是数组。页面因此**禁用保存**，并说明「读不到」而不是渲染空列表 | 与 `ERR_HOST_NO_WORKSPACE_REGISTRY` / `ERR_HOST_WORKSPACE_REGISTRY_BROKEN` 同源，处置见那两行 |
| `ERR_CLIENT_NETWORK` | 页面上（不经网络） | 页面读不到数据路由：路由没挂上（见 `ERR_BOOST_HTTP_MOUNT_FAILED`），或请求被网络层打断 | 看宿主日志里有没有 `webServer`；headless 部署没有页面，这条不会出现 |
| `ERR_CLIENT_SHAPE` | 页面上（不经网络） | 路由返回的 JSON 体本页读不懂（`workspaces` 既不是 `available:true` 也不是带 `code` 的 `available:false`） | 页面与产物版本不一致；升级插件 |
| `ERR_BOOST_HTTP_MOUNT_FAILED` | 加载日志警告 | 挂载数据路由本身抛了（`ctx.inject` 不可用或被拒绝）。投影、替换与 `boost` 工具都不受影响，只有页面没有数据源。与 `ERR_BOOST_PARTIAL_MOUNT`（钩子没挂上）是两件事 | 宿主没有动态注入能力；页面上会显示 `ERR_CLIENT_NETWORK` |
| `ERR_HOST_NO_MODEL_SELECTION` | 加载日志警告（一次） | `agent/pre-step` 没带 `modelSelection`，选择器路由回退到已废弃的 `agent/request` 事件（可能被移除） | 升级宿主；若 `agent/request` 也被移除，多候选替换会 fail-closed（`ERR_HOST_NO_AGENT_REQUEST`） |
| `ERR_BOOST_ALREADY_MOUNTED` | 加载日志警告 | 重复 `apply` 命中已有装配；本次注册跳过 | 确保只装配一次；移除重复的 bundle 行/重复加载 |
| `ERR_BOOST_SECTION_REGISTER_FAILED` | 加载日志警告 | 协议段注册失败；三个事件钩子随后**逐个独立挂载**，失败者记名（见下一行） | 查宿主提示段冲突（另一个插件占了同名段）；修好后重启 |
| `ERR_BOOST_PARTIAL_MOUNT` | `status.degraded` | 至少一个挂载点没挂上：协议段、`registerHooks`，或三个事件钩子（`tools/post-execute` / `llm/stream` / `tools/execute`）中的任一个，或七个会话监听中的任一个；插件装配不全，对应能力（投影/替换/可见性预热）实际不可用 | 看同一次加载日志里的**记名**失败项（每个挂载点单独记）；多数是 `apply` 与 dispose/HMR 竞争，重启即可 |
| `ERR_BOOST_TOOL_REGISTER_FAILED` | 加载日志警告 | `boost` 工具注册失败；用户失去控制面 | 查宿主 `tools` 服务与日志；修好后重启 |
| `ERR_SCOPE_LOCK_TAKEOVER` | 日志警告（**不是**工具失败 `code`） | 锁龄超过 10 分钟，插件按接管处理（即使 pid 仍活）；只记录，不影响本次写入结果 | 无需处置；作为崩溃写者/pid 复用的证据保留 |

#### 收据 `code`：跳过与重置

这些码写在收据的 `code` 字段里，回答“这次决定为什么没做/为什么重来”；`boost status` 会按
`code` 计入 `counts`。它们本身不是 `degraded` 数组的成员——少数收据码经
`src/tools/boost.ts` 的 `RECEIPT_DEGRADATION` 映射成 `ERR_*`（如 `projection-skipped:no-spill`
→ `ERR_HOST_NO_SPILL`），映射后的码才进 `degraded`。

| `code` | 含义 | 操作者动作 |
|---|---|---|
| `substitution-unavailable` | 替换因环境原因没跑：`platform-unsupported`（win32）、`no-step`（步进时钟缺失）、`no-queue`（没有待发队列）、`queue-failed`（入队抛错，预算已花） | 看 `reason`：win32 是预期；`no-step`/`no-queue` 说明宿主事件缺失，按 `ERR_HOST_NO_AGENT_PRE_STEP` 排查 |
| `not-admitted` | 已定价但被该步的准入判定拒绝（省得不够）；`reason:'no-estimator'` 是拿不到估算器 | 正常预算行为；`no-estimator` 见 `ERR_HOST_NO_TOKENMETER` / `ERR_HOST_NO_ESTIMATOR` |
| `steps-exhausted` | 该步的替换预算已用完，或共享预算被别的会话持有；未入队、未派发 | 正常上限；持续出现说明预算或共享运行时配置过紧 |
| `tool-not-whitelisted` | 计划里有候选，但没有一个在 read/grep/glob 白名单内 | 模型计划用了不可替换的工具；不需要处置 |
| `selector-error` | 选择器调用失败（派发错误）而弃权 | 查 LLM 路由与日志；与“选择器正常但没标签”区分 |
| `selector-abstain` | 选择器没给出标签或超时，不是调用失败 | 正常弃权；多候选时替换不提交 |
| `dispatch-rejected` | 合成派发的工具名/参数与决定不符（防篡改检查），该次派发被拒、队列已清 | 到达的调用不是插件决定的那一个；查是否有别的写入者或中间层改了参数 |
| `pruned-reset` / `compaction-reset` | `llm/stream` 或 `tools/post-execute` 时锚点无法验证：历史被 pruner 裁掉（`pruned-reset`），或锚定回执已不在/被压缩替换（`compaction-reset`）；写一条 `kind:'reset'` 收据，队列与锚点清空后放行 | 压缩/裁剪后的预期重置；替换在下一回合重新开始 |
| `projection-skipped:no-owner` | **hook 不可达**：`projectApply` 的直接调用契约在 session id 为空时返回它（`src/projection/apply.ts` 的 `!sessionId` 分支），但 `tools/post-execute` 在无 agent / 无 session id 时更早返回并记 `skip:no-scope`，生产调用总是传字符串（设计 §5.4 已记为不可达） | 无需处置。若真看到它，来源是直接调用 `projectApply` 的代码路径（测试或未来调用方），不是宿主漏传 session |
| `substitute-skipped:gate-error` | 决策阶段抛错（计划形状过了 `safePlan` 但绑定/守卫抛，或回执映射异常），该步替换被丢弃且没有别的收据能说明原因 | 记录 `status` 与日志，按 bug 上报——正常输入不应让决策层抛 |
| `substitute-skipped:no-toolset` | 替换**已提交**，但该步的准入工具集不可得，无法用 `exec.toolSet` 复核；派发照常 | 可见性信号，不是失败；宿主缺 toolSet 时每次替换都会记一条 |

## 3. 20 任务回归门（人工流程；任务集与 runner 都不随包发布）

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
   的回执**带** `locator`；三个取回账目字段 `retrieval_call_tokens` / `retrieval_content_tokens` /
   `retrieval_tokens` 只在这次取回被**定价**时写入（`cost !== undefined`，
   `src/hooks/post-execute.ts` 的 `recordProjectionRetrieval`），未定价的取回 `estimate` 为
   `'unknown'`、三个字段全部省略。定价的 retrieval 回执能和 locator 直接 join，`projected`
   回执不能。对开启轮每条 `code:'projected'` 的回执，按
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

> 路径以组装日志里打印的 `root=` 为准。设置了 `config.dshHome` 时它**优先于** `$DSH_HOME`，
> 照本节字面写 `$DSH_HOME/...` 会读到一个空目录并拿到四项零值（不是「没有收据」的证据）。

```bash
node scripts/shadow-report.mjs --dir "${BOOST_ROOT:-$DSH_HOME}/boost/receipts"   # 目录不存在时以 2 退出，确认要空报告就加 --allow-empty
```

输出四个标签（空目录输出四项零值，不抛错）：

| 字段 | 含义 |
|---|---|
| `saveableRatio` | 只读白名单真正能兑现的替换比例：`whitelisted` 影子提交 / 全部替换决策 |
| `byFamily` | 按**候选工具族**的命中率：`commits / decisions`。键是收据里的 `candidateTool`（门决定的族），不是刚执行的 `tool`；老收据没有该字段时回退到 `tool`。**例外**：`code:'no-candidate'` 的 skip 收据本来就没有 `candidateTool`（`src/hooks/post-execute.ts` 的 `decideSubstitution` containment 分支，`1dd93c6` 的 `:1759`），脚本按同一回退把它归到刚执行的 `tool` 的族——这些决策没有候选，`commits` 恒为 0，只抬高该族的 `decisions` 分母，所以读命中率时要知道分母含无候选决策。影子期绕过白名单，所以 bash/ssh 的潜力也计入 |
| `candidateRecall` | **提交产出率，不是候选集召回**：`commits / (commits + noCandidate)`，分母是**到达绑定/守卫判定的替换决策数**（`commit` 与 `no-candidate` 两种结局各计一次，一次决策一条，**不是**候选条数——同一决策可有多个候选）；`guard-trivial` 不提出候选，不进分母。脚本从不拿候选集比对模型实际的下一调，所以它不能回答「候选集有没有漏掉模型真正要做的调用」 |
| `retrievalUpperBound` | **已观测取回率的下界，不是取回损害的上界**：取回调用数 / 已应用投影回执数（取回回执本身不计入分母）。**只在 `projection: 'on'` 成立**：影子期只写 `kind:'shadow'` / `code:'projection-shadow'`，没有 `kind:'projection'` 回执，所以影子账上它按结构恒为 `0`，不能用它约束影子期取回损害；`0` 只说明没有观测到精确 locator 取回，不说明没有取回 |

**全零报告不能区分两件事。** 如果模型整周没有写 `<CHISEL_PLAN>`，`safePlan` 直接返回，一条
决策收据都没有，四个比例全是 `0`；这与「没有可省项」在报告里无法区分——报告不测 plan 发射率。
看到全零时先查收据里有没有替换决策（`kind:'shadow'` / `kind:'skip'`），不要直接读成
「插件没有效果」。影子报告只提供标签：它不单独决定是否开启替换，也不决定发布。

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
- 两条数值序列：每个请求的 `requestTokens` 与每个回执的 `receiptChars`（中位数/分位数需要，仍然不含正文）。

快照按**一个会话一行**序列化：数组内的每个 session 对象占一行，diff 里可逐条 review；解析后的数字与
单行 JSON 完全相同。

复算（手工可重复，不碰会话目录；CI 只做发布门 `ci` + `verify:package`，不跑统计复算，见 §6.1）。
机器可读的管道用下面两种之一：不带 `--silent` 的 `npm run stats` 会把 npm 的
`> dsh-boost@0.2.2 stats` 横幅打进 **stdout**（stderr 重定向拦不住），直接接 `jq` 之类会破：

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

- 断言 `package-lock.json` 里没有 `registry.npmmirror.com`（§6.2），然后 `npm ci --registry=https://registry.npmjs.org/`；
- 跑 `npm run ci`（typecheck + `npm test` + clean build），再跑
  `npm run verify:package -- --prebuilt`——这正是 `prepublishOnly` 的两条命令，按同一顺序显式执行，
  所以 §1 的整道门在 CI 里跑。`--prebuilt` 是承重的：不带它，`verify:package` 会在自己的 pack 步骤
  里重新 build，于是「缺一个 dist 文件」「多一个 ghost dist 条目」两个断言会被修复或掩盖，而不是报错；
- 权限只有 `contents: read`，没有 registry token，也**没有**任何 `npm publish` 调用（连
  `--dry-run` 都没有）：npm 要先跑完 `prepublishOnly` 才检查 registry，`--dry-run` 只会让每次
  push 在几分钟绿灯后以 `You cannot publish over the previously published versions: <当前版本>` 变红；
- `v*` tag **不会**把任何东西推到 registry；打 tag 只是再跑一遍这两条命令。

注意：§1 的次安装会执行包内 lifecycle 脚本；`pull_request` 上也会执行。runner 是临时的、
没有 registry token，但这仍是在跑不可信代码——不要给这个 job 加 secrets 或写权限。

它**不**检查：真实发布所需的认证/2FA、registry 的 `latest` dist-tag、provenance/签名、装进真实
DSH 宿主后的行为、§3 的 20 任务回退流程（人工）、§5 的统计复算。workflow 是为公共 GitHub mirror 准备的；
内部 GitLab remote 不执行它（见 yml 文件头）。

### 6.2 registry：一个源，而不是两个

`.npmrc` 与 `package-lock.json` 都钉在 `registry.npmjs.org`——与 `publishConfig.registry` 同一个
源。旧版这里写的是「lockfile 钉 npmmirror、runner 上 sed 重写」，代价是**发布校验查的是镜像**：
镜像的 `latest` 滞后，于是 `npm view` 看到 0.1.0、而 npmjs 上已经是 0.1.1，一次失败的发布可以
看起来是成功的。现在没有重写步骤，CI 改为**断言**：lockfile 里出现 `registry.npmmirror.com` 即
失败。代价一句话：CI 依赖公网 npmjs，npmjs 不可达时直接红、没有镜像兜底。

### 6.3 包内无法修复的旁路

`--ignore-scripts` and `npm publish <tgz>` skip the gate entirely; the only defence is running
`npm run verify:package` on the commit you tag. 具体地，`npm publish --ignore-scripts` 不跑
`prepublishOnly`，`npm publish ./dsh-boost-0.2.2.tgz` 对 tarball 发布也不跑包内任何脚本；两者都能
把没有 `dist/index.js` 的 8 文件空包推到 registry（本机 npm 11.19.1 实测：无 `dist/` 的干净 clone
上 `npm publish --dry-run --ignore-scripts` exit 0，8 files / 29,532 字节，约 29.5 kB；该数是按
0.1.1 的载荷量的，0.1.2 改了两份 README 与版本号，数字会略有出入）。`prepublishOnly` 只保护
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
- [ ] `prepublishOnly`（`npm run ci && npm run verify:package -- --prebuilt`）在发布前整体跑过一遍；明确知道 `npm publish --ignore-scripts` 和 `npm publish <tgz>` 会绕过它（§6.3）
- [ ] CI 在同一个 commit 上绿；明确知道它只跑 `ci` + `verify:package`、不跑 `npm publish`，`v*` tag 不会上传（§6.1）
- [ ] `dsh plugin --profile <name> add dsh-boost@^0.2.1 --registry=https://registry.npmjs.org/`（或本地路径/tarball）成功，`--dump-config` 里有 `id: dsh-boost` 行
- [ ] 测试工作区已写入 `scope.workspaceIds`，`shadow: true`、`projection: 'on'` 经 `boost status` 确认
- [ ] no-tokenmeter 门按 §2.1 承担：单元测试注入 `hasTokenMeter: false` 锁定预期（替换拒绝、投影可用、账目 `unknown`、`ERR_HOST_NO_TOKENMETER`）；活宿主复核仅在确要部署缺该服务的宿主时做，先验健康态，再把 `shadow` 设为 `false` 验拒绝收据（影子模式下只有 `status.degraded` 可观察，不能算过门）
- [ ] no-spill 门按 §2.2 完整跑过：移除的是 spill **后端**（`dsh-spill-local`），观察到超限回执不投影、`projection-skipped:no-spill`、`ERR_HOST_NO_SPILL`；只移除 `dsh-spill-policy`（宿主的 token 预算保留策略插件，从宿主树解析）的话得到的是 `projection-skipped:no-footer` 与 `ERR_HOST_NO_SPILL_NOTICE`
- [ ] 两条降级路径都保留 status/收据证据；验收中出现的每个稳定码都按 §2.5 的矩阵处置并留证（含 `ERR_HOST_NO_SPILL_NOTICE` / `ERR_HOST_VERSION_MISMATCH` / `ERR_BOOST_SECTION_REGISTER_FAILED`，以及已有的 `ERR_RECEIPTS_UNREADABLE` / `ERR_RECEIPTS_TRUNCATED` / `ERR_HOST_COMPLETE_SECTION` / `ERR_SCOPE_ABORTED` / `ERR_HOST_SPILL_FAILING` / `ERR_BOOST_PARTIAL_MOUNT`）；同时确认 `status.data.receipts_stopped` 为 `false`（为 `true` 表示收据已连续写失败 3 次、替换被整体拒绝）
- [ ] 第一次开启替换的真实回合检查 `content[].thinking` 400（不是影子周）；若有，替换在该路由关闭
- [ ] `npm run --silent stats` 在干净 clone 上可复算 §5.2 的聚合（口径对应设计稿 §2.1）
- [ ] 发布侧：`npm publish` 走 `publishConfig.registry`（registry.npmjs.org、public）；用 `npm view dsh-boost dist-tags --registry=https://registry.npmjs.org/` 确认 `latest` 是 `package.json` 里的版本（registry 上另有 npm 自动创建的 `0.0.0-stage` 占位版本，见 §2.4）；**必须带 `--registry`**，否则读到的是镜像的旧 `latest`；安装规格是 `dsh-boost@^0.2.1`

**未交付、因此不在上表可勾选范围：§3 的 20 任务门，以及同一节里的取回完整性检查。**
`test/regression/` 只有 `.gitkeep`——本仓库不附带任务集，也不提供 `test/regression/run.mjs`
（2026-11-18 用户明确否决“搭回放集”，见文首记录）。用户豁免的是**回放语料**；冒烟 runner 与
取回完整性检查按裁决并不需要语料，但同样没有交付，这一项由项目自行记录为「欠」，不是「豁免」。
要执行它，维护者必须自备恰好 20 条任务，按 §3 的步骤与 pass 谓词跑两轮（基线 `shadow: true` +
`projection: 'off'`；开启轮 `projection: 'on'`），结论只写“过门 / 未过门”。这一项无法由仓库内容
核对，所以不放进可勾选清单：勾选它等于声称跑过一份仓库里并不存在的任务集。
