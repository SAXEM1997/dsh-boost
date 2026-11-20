# dsh-boost 发布验收

本文是 `dsh-boost` 0.1.0 的发布验收手册。它覆盖三件事：

1. `npm pack` 后在 **isolated** 布局里安装，并验证两条软依赖降级路径；
2. 20 任务回归门的**判定过程**与 pass 谓词（任务清单由操作者自备）；
3. 影子周脚本的跑法、`session-snapshot.json` 的来源与复算方式。

> 记录在案的决定：本项目**不附带** 20 任务回放集，也不提供 `test/regression/run.mjs`。用户明确否决了
> "搭回放集"（2026-11-18）。因此第 3 节只规定过程与判据，**不伪造任务集**。

---

## 1. 打包

在仓库根目录：

```bash
npm ci
npm run build
npm pack --dry-run
npm pack
```

`npm ci` 依赖已提交的 `package-lock.json`，先 `npm ci` 再打包才能复现同一棵依赖树（TypeScript、
`tsx`、`@types/node` 都由 lockfile 钉住）。`package.json` 的 `prepack` 会在每次 `npm pack`
（含 `--dry-run`）前执行 `npm run build`，所以干净 clone 上即使 `dist/` 不存在，打出的包也会
包含构建产物；`prepublishOnly` 不再是唯一的构建防线。

`npm pack` 只校验包名与版本；缺 `files` 条目它仍可能 exit 0。因此产物完整性必须显式检查，且
**不能**用“任意一行匹配”的 `grep -E`：`tar -tzf … | grep -E '…|…|…'` 在五个必需文件只命中
一个时也 exit 0。用排序后的清单做集合相等比较：

```bash
required=$(printf '%s\n' \
  package/LICENSE \
  package/NOTICE \
  package/cordis.patch.yml \
  package/dist/index.js \
  package/dist/index.d.ts | sort)
actual=$(tar -tzf dsh-boost-0.1.0.tgz \
  | grep -E '^package/(dist/index\.js|dist/index\.d\.ts|cordis\.patch\.yml|NOTICE|LICENSE)$' \
  | sort)
if [ "$actual" != "$required" ]; then
  echo "tarball manifest mismatch; missing:"
  comm -23 <(printf '%s\n' "$required") <(printf '%s\n' "$actual")
  exit 1
fi
test "$(printf '%s\n' "$actual" | grep -c .)" -eq 5
```

`[ "$actual" != "$required" ]` 能抓的只有**缺项**：`actual` 由只放行五个模式的 `grep -E` 过滤
而来，tarball 里**多出的任何其他文件根本不会出现在 `actual` 里**，这个检查对它失明（顺序
不同也不影响，两侧都经过 `sort`）；最后的计数同样只断言“五行都在”。要抓多余文件，必须另做
完整清单比较，例如 `diff <(tar -tzf dsh-boost-0.1.0.tgz | sed '/^package\/$/d' | sort) <(…预期的
完整文件清单…)`，或人工 review `npm pack --dry-run` 的完整输出。`test -f dist/index.js` /
`dist/index.d.ts` 仍建议保留，但它们是本地构建目录的检查，不能证明 tarball 里有这两项。

验收前的硬约束（设计 §11）：

- `package.json` 的 `name`、`cordis.patch.yml` 行的 `id`、行的 `name`、导出插件的 `name` 四者完全一致。
  注意：顶层 `insert` 行在装配时**不做** id/name 匹配（加载器直接 push），等式
  `row.id == entry.options.id && row.name == entry.options.name` 是 plugin manager 的 in-use /
  可寻址归属判定——不一致时行照常装配，但会在管理面变成不可寻址、移除判定失灵；`name` 指向
  不存在的包则加载**响亮失败**。四名一致是为了保住管理面的可寻址性。
- `version` 必须存在，否则 `npm pack` 在第一步就报 `Invalid package, must have name and version`。
- `files` 与实际布局一致：`scripts/` 与 `test/` 是 dev-only，**不**进包；`dist/` 由 `prepack` 构建。

## 2. 空项目安装（isolated 布局）

**这一步必须在一个没有任何 `node_modules` 祖先目录的空项目里做。** 一个真正不存在的包在任何布局下都会
`ERR_MODULE_NOT_FOUND`；hoisted（提升）布局掩盖的是**缺失**本身——它可能从上层祖先的 `node_modules`
解析到同一份副本，于是"宿主没装这个包"根本复现不出来。isolated 布局才让缺失真实可见。

```bash
rm -rf /tmp/dsh-boost-accept && mkdir -p /tmp/dsh-boost-accept
cd /tmp/dsh-boost-accept
npm init -y
npm_config_cache=/tmp/npmcache npm install /path/to/dsh-boost-0.1.0.tgz

# 确认安装布局是扁平的、没有上层 node_modules 兜底：
npm ls --all | head -40
test -d node_modules/dsh-boost

# 看 peer 实际解析到哪个 rc：范围必须同时接受 rc.4 与 rc.5，不能钉死一个版本。
npm ls @deepseek-ai/dsh-llm @deepseek-ai/dsh-tools

# 插件在无宿主进程时也必须能作为模块加载：
node --input-type=module -e "const m = await import('dsh-boost'); console.log(m.name)"

# M3 回归：宿主用 Node resolver 读元数据，这两个路径必须能解析。
node --input-type=module -e "console.log(import.meta.resolve('dsh-boost/package.json'))"
node --input-type=module -e "console.log(import.meta.resolve('dsh-boost/locale/en.json'))"
```

最后两条 `import.meta.resolve` 缺一不可：`exports` 不声明 `./package.json` / `./locale/*.json` 时
Node 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，宿主的 `readPluginMeta` 把该错误当成“文件不存在”，
插件的名称、描述与 locale 字典就全部回退成空。

随后在一个一次性的 `DSH_HOME` 里装配（不碰真实 profile）。`--profile` 是 `dsh plugin` 的**必填**
选项，且要放在 `add` 这个被透传的 pnpm 子命令**之前**；写成 `dsh plugin add <path>` 会在安装前
因缺少必填项失败：

```bash
export DSH_HOME=/tmp/dsh-boost-accept/dsh-home
mkdir -p "$DSH_HOME"
dsh plugin --profile accept add /tmp/dsh-boost-accept/node_modules/dsh-boost
# 确认宿主确实把这一行并入了装配计划：
dsh --profile accept --dump-config | grep -A2 'id: dsh-boost'
```

### 2.0 先让插件对测试工作区生效

刚初始化的 `scope.json` 是 `{mode:'selected', workspaceIds:[], shadow:true, projection:'shadow'}`
（`src/scope/doc.ts`）。工作区列表为空时插件对任何会话都不可见：投影根本不会发生，§2.1 的
“投影照常裁剪”和 §2.2 的 `projection-skipped:no-spill` / `ERR_HOST_NO_SPILL` 都无法观察到
（`ERR_HOST_NO_SPILL` 只在 `projection === 'on'` 时加入 `degraded`）。先加入测试工作区。

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

> 降级验收要在**宿主实际解析依赖的那棵树**里移除包。用 `dsh plugin --profile accept` 装进 profile
> 时，宿主在 `$DSH_HOME/profiles/accept` 下解析；`/tmp/dsh-boost-accept` 的 `npm uninstall`
> 只改了另一份副本，不能证明宿主缺包。用
> `dsh plugin --profile accept remove <pkg>` 移除，或用
> `find "$DSH_HOME/profiles/accept/node_modules" -maxdepth 4 -name '<pkg>'` 确认它本来就不在
> profile 里（可选 peer 未被安装时就是这种情况）。

`boost status` 是验收的观察面：它输出 `shadow` / `projection` 两个开关、按 `code` 的收据计数、替换账与
投影账（投影账为净额并附 `projection_retrievals`）、实测固定开销 token，以及稳定降级码。插件本身不说话，
**不要**用"我记得开了"代替 status。

### 2.1 降级门：`@deepseek-ai/dsh-token-meter`（先装、验健康，再卸、验降级）

`dsh-token-meter` 是 **optional peer**（`peerDependenciesMeta`），npm 在隔离项目里**不会**自动
安装它，profile 里初始也没有——直接 `npm uninstall` 是 **no-op**：什么都没移除，降级状态
在测试开始前就存在，这样的“门”永远绿。这个门必须**先构造被测状态**：

```bash
# 1) 先把 peer 装进宿主实际解析的那棵树（二选一）。
# isolated 项目布局：
cd /tmp/dsh-boost-accept
npm install @deepseek-ai/dsh-token-meter@0.2.2-rc.4
npm ls @deepseek-ai/dsh-token-meter          # 必须确认真的存在
# profile 布局（§2 的 dsh plugin 布局）：
dsh plugin --profile accept add @deepseek-ai/dsh-token-meter
find "$DSH_HOME/profiles/accept/node_modules" -maxdepth 4 -name 'dsh-token-meter' -print

# 2) 【前置断言】重启宿主后先验健康：agent 会话里 boost status 必须显示
#    degraded 不含 ERR_HOST_NO_TOKENMETER、estimate_kind 为 "host"、fixedOverheadTokens 是数字。
#    验不到健康态，后面的“降级”就无从谈起——门在此处就该判失败。

# 3) 再从同一棵树移除（isolated 布局用 npm，profile 布局用 dsh plugin remove）。
cd /tmp/dsh-boost-accept
npm uninstall @deepseek-ai/dsh-token-meter
npm ls @deepseek-ai/dsh-token-meter || true   # 必须确认真的不存在
dsh plugin --profile accept remove @deepseek-ai/dsh-token-meter || true
find "$DSH_HOME/profiles/accept/node_modules" -maxdepth 4 -name 'dsh-token-meter' -print

# 4) 重启宿主，按下表验降级。
```

以宿主实际解析的那棵树里的 `npm ls` / `find` 结果为准；另一棵树的“已卸载”不算证据。**没有
第 1、2 步的安装与健康验证，这个门什么都没测**——降级状态先于测试存在，第 3 步是空跑。

预期（设计 §9 / §11）：

| 观察点 | 期望 |
|---|---|
| 插件加载 | **成功**。`tokenMeter` 是软依赖，只能 `ctx.get('tokenMeter')` / 动态 import，不能进 `inject` |
| 替换 | **拒绝**：没有计量就不做替换，不拿 `chars/4` 的假数字放行 |
| 投影 | **照常裁剪**（裁剪本身不需要 token meter） |
| 投影账 | token 估算记 `'unknown'`，**不伪造数字**；`projection_gross_tokens` / `projection_net_tokens` 为 `'unknown'` |
| `boost status` 的 `degraded` | 含稳定码 `ERR_HOST_NO_TOKENMETER` |
| 收据 | 每个被拒的替换决策有 `skip` / `ERR_HOST_NO_TOKENMETER`（代码里也写稳定码本身） |
| 失败形态 | **不是** `ERR_MODULE_NOT_FOUND`。若看到它，说明代码里出现了对可选 peer 的静态 import，回到 isolated 环境排查 |

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
| 失败形态 | 不应是 `ERR_MODULE_NOT_FOUND`（`spillStore` 经 `ctx.get` 动态获取）；注意与另一条降级区分——**若只卸 `dsh-spill-policy`（页脚格式化器、本包的 optional peer），得到的是 `projection-skipped:no-footer`，`ERR_HOST_NO_SPILL` 不会出现**；那条路径同样可验，但它是另一个门 |

### 2.3 两条路径都要留证据

每条路径至少保留：

```bash
# 一次 status 的完整输出：在 agent 会话里发送“请调用 boost 工具：{"cmd":"status"}”，
# 把工具返回的 JSON 原样贴进证据（不要只写结论）。
# 收据里对应 code 的计数（可以直接数行）
grep -c '"code":"projection-skipped:no-spill"' "$DSH_HOME"/boost/receipts/*.jsonl
grep -c '"code":"ERR_HOST_NO_TOKENMETER"' "$DSH_HOME"/boost/receipts/*.jsonl
```

若 `ERR_MODULE_NOT_FOUND` 出现，直接在 isolated 目录里跑 `node -e "import('dsh-boost')"` 复现并记录栈；
hoisted 布局下的"通过"不算通过。

### 2.4 安装矩阵记录（2026-11-20，基线 `8765f0f` + 本修复 `5df8185`）

`dsh-llm` 的 peer 改用与另外三个 peer 相同的范围
`">=0.2.2-rc.1 <0.3.0-0"`；`devDependencies` 的精确钉法保留（registry 的 `latest` 是
`0.0.1-rc.1`，属于另一套旧 API，不能跟随）。两侧各在空项目里从 tarball 安装一次：

| 场景 | 命令 | 结果 |
|---|---|---|
| **修复前**，空项目 + rc.5 解析链 | `npm install` 旧 tarball | **exit 1**，`ERESOLVE`：`Found: dsh-llm@0.2.2-rc.4`，而 `dsh-tools@rc.5` 的 peer 要求 `dsh-llm@0.2.2-rc.5`；错误里出现 `peer dsh-llm@"0.2.2-rc.4" from dsh-boost` |
| **rc.5**，空项目直接装新 tarball | `npm install ./dsh-boost-0.1.0.tgz` | **exit 0**；`dsh-llm@0.2.2-rc.5`、`dsh-tools@0.2.2-rc.5`；`import('dsh-boost')` 返回 `name/inject/apply`；`package.json` 与 `locale/en.json` 均可 `import.meta.resolve` |
| **rc.4**，先装四件套 rc.4 再装新 tarball | `npm install @deepseek-ai/dsh-{tools,llm,spill-policy,token-meter}@0.2.2-rc.4`，再 `npm install ./dsh-boost-0.1.0.tgz` | **exit 0**；解析保持 rc.4，未被升级；模块加载与两个元数据路径解析同上 |
| **实际装配命令** | `DSH_HOME=/tmp/… dsh plugin --profile accept add <tarball 或包目录>` | **exit 0**；`dsh --profile accept --dump-config` 中出现 `id: dsh-boost` / `name: dsh-boost` 行 |

本表记录的是 **install / peer 解析 / 模块加载 / 宿主装配**这一半；§2.1、§2.2 的降级矩阵要在
agent 会话里由模型调用 `boost` 才能观察（步骤已在 §2.0 给出），本次未在无交互的 shell 中伪造。

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
5. `kind:'projection'` 回执**不带 locator**：`before` / `after` / `saved_projection_tokens` /
   `unit` / `estimate` 是它全部的账目字段。locator 只出现在模型可见的页脚和进程内 retrieval
   ledger 里，所以回执无法和 locator 直接 join。对开启轮每条 `code:'projected'` 的回执，按可见
   页脚取 locator、在**磁盘上**量原文：
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

复算（手工可重复，不碰会话目录；本仓库没有配置 CI 流水线，不存在“CI 用这个”的自动步骤）：

```bash
npm run stats
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

## 6. 发布检查清单

- [ ] `npm ci` 成功（lockfile 与 `package.json` 一致），`npm run build` 干净，`dist/index.js` 与 `dist/index.d.ts` 存在
- [ ] `npm pack --dry-run` 与 `npm pack` 均成功，`version` 非空
- [ ] tarball 的排序清单比较通过（§1），五个必需文件一个不少
- [ ] isolated 空项目安装成功（rc.4 与 rc.5 各一次），`node -e "import('dsh-boost')"` 无 `ERR_MODULE_NOT_FOUND`
- [ ] `import.meta.resolve('dsh-boost/package.json')` 与 `…/locale/en.json` 均可解析（M3）
- [ ] `dsh plugin --profile <name> add <path>` 成功，`--dump-config` 里有 `id: dsh-boost` 行
- [ ] 测试工作区已写入 `scope.workspaceIds`，`shadow: true`、`projection: 'on'` 经 `boost status` 确认
- [ ] no-tokenmeter 门按 §2.1 完整跑过：**先装 peer、验健康态（无 `ERR_HOST_NO_TOKENMETER`）**，再卸、验降级（替换拒绝、投影可用、账目 `unknown`）
- [ ] no-spill 门按 §2.2 完整跑过：移除的是 spill **后端**（`dsh-spill-local`），观察到超限回执不投影、`projection-skipped:no-spill`、`ERR_HOST_NO_SPILL`；只卸 `dsh-spill-policy` 的话只能验到 `projection-skipped:no-footer`
- [ ] 两条降级路径都在宿主实际解析的依赖树里验证，并保留 status/收据证据
- [ ] 20 任务门按 §3 跑过，pass 谓词逐字对照，结论只有"过门/未过门"
- [ ] 第一次开启替换的真实回合检查 `content[].thinking` 400（不是影子周）；若有，替换在该路由关闭
- [ ] `npm run stats` 在干净 clone 上可复算 §5.2 的聚合（口径对应设计稿 §2.1）
