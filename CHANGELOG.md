# Changelog

本文件记录用户可感知的变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。设计与取舍不在本文件展开，见
`docs/superpowers/specs/`；发布验收流程见 `docs/RELEASE.md`。

This file records user-visible changes. Format follows Keep a Changelog; versions follow SemVer.
Design rationale lives in `docs/superpowers/specs/`; the release-acceptance procedure is in
`docs/RELEASE.md`.

## [0.4.3] - 2026-11-24

两轴评审（Standards / Spec）对 0.3.14 → 0.4.2 的复审修复。其中两条是我在 0.4.x 里自己造出来的。

### 我造的错

- **同一事实抄了三份，只改了一份**：`boost` 是「唯一 scope 豁免 / 始终常驻 / `selected + []` 实际 399」
  这三句话在 `operating.md` 与 `how-it-works.md` 里各有副本；0.4 改掉可见性后只改了其中一份，
  另外两处与代码直接矛盾（评审两轴各自独立发现）。现在统一成「可见 778 / 不可见 0 / `selected + []` 0，
  `fixedOverheadTokens` 是上界」。
- **机械替换毁掉版本归属**：我为了升版本把文档里的 `0.4.1` 批量改成 `0.4.2`，把「0.4.1 交付了什么」
  这段历史一起改写了，还把 `saved_tokens`/`spilled_bytes`（0.3.8）、`test/regression`（0.3.11）
  的错误归属一并扩散。版本清单补回 `0.3.13`/`0.3.14`/`0.4.0`，每条按实际内容重写。

### 测试（两条形式正确但抓不住回归）

- 「已选中工作区仍可见」没有用例：把谓词改成「凡是判过的会话一律隐藏」，测试全绿。补了一个
  真 registry + 真 `scope.json` 的 warm 后可见用例。
- `continuation` 的内层量词（一个调用的多个字符串叶子）没有用例：`every` 改 `some` 全绿。
  fixture 加了「一个调用、两个叶子、只绑定一个」的步。
- 文档引用的 951 / 1.47% / 150 / 0.24% 没有任何测试保护；现在绑定到 `session-snapshot.json`。

### 口径与清理

- `duplicates.duplicateResultChars` 删除：它按到达顺序取 `resultTexts`，并行调用乱序到达时会把
  字节算到别的调用上。字段没人用，删掉比留着错的好（快照同步重生成，其余字段不变）。
- `continuation` 的三个隐含限定（同一 turn、去首尾空白、忽略 <4 字符）写进文档表格。
- `operating.md` 的「工具不见了只有一个原因」不成立：补上「解析失败」与「协议段被宿主替换」
  两个原因。
- 设置页的 `HINT_OVERHEAD` 仍在描述 0.3 的成本模型（「只剩工具 schema」），标签还是「常驻开销（合计）」；
  改成上界语义并重新构建客户端。
- 恢复 `HookDeps.usage`/`sessionState`/`horizonFor` 与 `BoostDeps.host` 的严格可选类型——
  `exactOptionalPropertyTypes` 在 0.4.0 被放宽得比编译器要求更宽；测试改为省略键而不是传 `undefined`。

## [0.4.2] - 2026-11-24

质量仪（issue #20）。到 0.4.1 为止，仓库里每一项干预都只记 token 账，**没有任何一处回答「结果
变差了吗」**；两个新分母把收益天花板压到 1.47% / 0.24%，越是这样越该先测「有没有变差」。

**边界先说清楚**：仓库驱动不了 agent 的 A/B。这一版交的是装置的一半——挑任务的机器与比较的
算术；跑两遍要在宿主上做，规程写在 `docs/quality.md`。

### 新增

- `scripts/quality-tasks.mjs`：从会话日志里找**验证命令**（`npm test` / `npm run ci` / `npx tsc` /
  `pytest` / `cargo test` / `go test` / `make test`），每个会话取最后一次，标出它是否是会话的
  最后一个调用（`isFinal`）——只有终态的判定才能整体重放。2,249 个会话上实测 **48 个候选、
  2 个 `isFinal`**。
- `scripts/quality-compare.mjs`：两臂配对比较，输出 `compared / agree / agreementRate /
  tokenDelta / mismatches / missing / conclusion`。样本低于 `--min-pairs`（默认 12）时
  `conclusion` 是 `insufficient-pairs`——**不用小样本的一致率宣称安全**。没有配对时
  `tokenDelta` 是 `null` 而不是 0。
- `docs/quality.md`：规程、字段口径、三个已知偏差（样本小、重放不是原样、`ok` 的定义由人给）、
  以及二期每加一项干预的前置条件。

### 测试

1003 绿（新增 6 条：验证命令与 `isFinal` 的判定、空目录、不存在的目录、一致率与 `mismatches`、
`insufficient-pairs`、输入形状与报错）。变异验证：`isFinal` 恒真、`minPairs` 恒过 → 各自变红。

## [0.4.1] - 2026-11-24

一期有两条缺口挂着**从没被仪器测量过的**「重启条件」：PTC 等「批量步的收益标签」，去重等
「重复率」。没有分母，条件永远无法满足——于是它们悬了整个 0.1–0.4。

这一版把它们量出来，并因此改变了二期的路线。

### 新增测量（`scripts/session-stats.mjs`）

| 指标 | 定义 | 300 个最长会话上的实测 |
|---|---|---|
| `continuation` | 一步里**所有**调用的字符串参数都逐字来自上一步回执 | 951 / 54,141 步（1.76%），占 1.47% 的 token |
| `duplicates` | 与紧邻上一步或同一步内另一个调用 `(tool, 规范化参数)` 完全相同 | 150 / 62,624（0.24%） |

两个数都是**天花板**：`continuation` 只证明那些往返不需要模型决策，不证明可以无人值守地
一起发出（副作用不在日志里）；`duplicates` 只覆盖现有语料。

### 结论（写进文档，不只是数字）

**「非单工具步占 20.2%」不是可合并的比例。** 多调用步里的调用多数彼此独立、本来就已经在同
一次往返里；真正能省的是 1.76% 的确定性续跑与 0.24% 的重复。所以：

- PTC 从「等影子期数据」变成「上限 1.47%，重启条件改为实测收益 + 质量标签」。
- 去重/合并（设计 N5）从「无法计算」变成「可计算且很小」——按现有证据不值得做。

### 其它

- `scripts/session-snapshot.json` 重生成：`selection`/`asOf` 与 54,141 步 / 62,624 调用 /
  10,575,904,022 token 逐字段不变，只多了 `continuation` 与 `duplicates`。
- `docs/operating.md` 的两条「已知限制」按实测重写；`docs/how-it-works.md` 新增一节讲这两个
  分母能证明什么、不能证明什么。

## [0.4.0] - 2026-11-24

**行为变更**：`boost` 工具不再无条件注入。它和协议段共用同一个可见性判定——本会话的工作区不在
作用域内时，工具 schema 也不下发。

### 为什么

固定开销是每请求 778 token（协议段 379 + 工具 schema 399），而投影在 300 个最长会话上的毛节省
约 0.8%——**开销吃掉了一半的净额**。0.3 及更早，工具是 scope 豁免、始终常驻：一个永远不会命中
作用域的会话只能拿到 `skip:no-scope`，却每请求白付 399。把这两项交给同一个判定，是插件里最便宜
的一笔节省。

### 代价

模型不能再在对话里替你把某个工作区打开。设置页写同一份 `scope.json` 的同样四个字段、走同一个
CAS，所以控制面还在；失去的是「在对话里开」这条路。README 与 operating 的启用步骤已改成
page-first。

### 实现

- `registerBoostTool` 的 `when` 从 `() => true` 改为读可见性判定。三个例外都让工具**显示**：
  拿不到会话键（诊断装配）、可见性缓存还没热（会话最初几步）、判定为可见。前两条是刻意的
  fail-open——控制面不能因为一个谓词 bug 就消失。
- `ScopeStore.peekJudgement(key): boolean | undefined`：`judgement()` 把「没判过」折叠成
  `false`（对必须 fail-closed 的判定是对的），而这里必须能区分「没判过」与「判过且不可见」。
- `fixedOverheadTokens` 现在是**上界**（两项都注入时的合计），不随 scope 翻转；可见时 778、
  不可见时 0。

### 测试

996 绿；新增四条可见性用例（冷缓存显示、判过不可见隐藏、无会话键显示、warm 后隐藏）。变异验证：
把 `when` 改回 `() => true`，新用例变红。

## [0.3.14] - 2026-11-24

第 12 轮通读评审（Standards + Spec 两轴）的修复。**没有 P0**；两条 P1 都在文档里。

### 修复

- **`SCOPE_CODE_TABLE` 改成穷尽映射**（`Record<ScopeCode, true>`）：此前是 `ReadonlySet<ScopeCode>`，只保证「表里的都是合法码」，不保证「合法码都在表里」——往 `ScopeCode` 加一个码而忘了登记，会静默降级成 `ERR_BOOST_INTERNAL`，正是 0.2.3 那个缺陷。现在加成员不登记就编译失败。
- **`scripts/checks.mjs` 成为检查清单的唯一来源**：`verify-package` 断言实际跑过的实例等于清单，`gate-negatives` 断言清单每一项都有负例。此前 `ran.length === CASES.length` 是自己跟自己比，加第 13 个 check 仍报「12/12」。
- **`bundle-patch` 的负例 `expect` 收紧**到该 check 独有的文案；此前的 `/patch/i` 会被 allowlist 的错误文案命中。
- **`ui-payload` 的「degraded 不是数组」用例改为驱动真实守卫**（新抽出的 `degradedCodesOf`）。此前只断言夹具自身形状，把守卫整个删掉测试仍绿——变异验证：删守卫 → 红。
- **`GET /scope` 回 405 而不是 404**：路径存在、动词不对。
- **`slots.register` 抛错时打一条 warn**：静默缺席与「没装插件」不可区分。
- 修掉四处说错话的注释/文案：`attempt.ts` 重复且矛盾的 JSDoc、`boost.ts` 关于 `selector-error` 的自相矛盾、`ci.yml` 说「没有 prepare 钩子」（其实有）、`scripts.test.ts` 说 B/2 是 partial（断言是 0）。
- 回归夹具收敛成 `test/regression/fixture.ts` 一份（`run.mjs` 与 `integrity.test.ts` 曾各存一份）。

### 文档

- 交付版本归属统一为 0.3.11；版本清单补上 0.3.8–0.3.12 五个真实发布版本。
- **启用顺序改对了**：`ERR_HOST_SPILL_UNUSABLE` 只在 `projection: 'on'` 时才进 `degraded`，所以「翻开关前先检查」是一个永远通过的检查。README 与 operating 都改成「先开、立刻查」。
- `files` 清单补 `lib` 与 `static`；patch 节选标明是节选；`SAVED` 的提示不再承诺一个不存在的「重新读取」按钮；影子模式的提示不再声称「不改动发给模型的内容」（投影仍会截断）。
- 码表首列的 `distill`（采用）改为真实码 `projected`；`rejected` 也含墓碑重放；`ERR_SCOPE_ABORTED` 的适用范围改成「任何 boost 子命令」。

## [0.3.13] - 2026-11-24

### 修复（设置页收据面板，#16 评审）

- **两个「真的发生了」的码被归错组**：`substituted` 与 `projected` 不含分隔符，按前缀切分会落进 `other` 并被默认折叠——而那两条正是唯一记录「省了多少」的收据。改为显式别名表；测试夹具补这两个码（此前夹具里没有它们，归错组永远暴露不出来）。
- **净额等式算不平**：`legacyRetrievalCost` 是第三个被减项，只展示两项时 `retrievalContent + retrievalCalls ≠ gross − net`。新增 `saved.retrieval_legacy`（为 0 时省略）与对应的页面行。
- 计数面板显示占比（与行同分母，可相加），默认折叠 `skip` 与 `other`；`<0.1%` 不再渲染成 `0.0%`。
- 补断言「net 为 `unknown` 时三键都缺席」——此前把它改成「永远包含」测试仍全绿。
- `groupCounts` 的注释说「按总数降序」，实现是按固定组序；hover 规则用了 100% currentColor 混 0% 透明（no-op）。

### 文档

- 新增 `docs/research/2026-11-24-tool-ordering-authority.md`：定序权威的一手调研（8 篇论文，逐条标到节/表），结论是引入「守卫门控的短链 K=3」而不是一次定序，并给出可证伪的实验设计（issue #12）。

## [0.3.12] - 2026-11-24

### 修复

- 发布门负例补到**十二个 check 实例全覆蓋**（`0.3.10` 只做了九个，且声明「剩下三组构造不出」）。三个反例都成立：`install (ignore-scripts)` 用 `os: ["aix"]` 让安装本身被拒；`typecheck-no-host-stubs` 把宿主类型的 import 藏到 600 字符之后（声明扫描的正则只看到 400），于是带 stub 的那遍通过、无 stub 的那遍失败；第二次探针用一个成功安装之后才改坏模块的 `postinstall`。
- 每条 `expect` 收紧到该 check 独有的一句话。此前 `install` 的 `/failed|postinstall/i` 会命中 `typecheck` 和探针的输出，`/patch/i` 会命中 allowlist 的错误文案——一个 case 可以在目标 check 根本没跑的情况下变绿。
- skip 现在是失败：`mutate` 必须显式返回布尔值（`undefined` 曾经被当成「已应用」，还会把 `mutate` 调用两遍）；没有可改的东西就计一次失败，结束时断言 `ran === CASES.length`。
- 负例前加 preflight：`dist/index.js` 与 `lib/client.js` 缺失时报「先跑 `npm run ci`」，而不是 `execFileSync` 的堆栈。写文件一律经 `safePath()` 锚在解包目录内（防 manifest 里出现 `../`）。

### 修复（`#17` 评审）

- 完整性检查的「能失败」用例此前只是断言 `assert.equal` 会抛，证明不了检查本身能发现回归。改成通过 `checkIntegrity` 的注入接缝传入一个「只落头段」的投影，断言它被拒绝。
- 断言从「页脚里出现过 locator」改为「页脚点名的是后端返回的那个 locator」，并补 `outcome.locator === handle.locator`。
- `run.mjs` 现在断言 `tasks.jsonl` 里的三个 `expect` 字段（此前只用了 `applied`，`shrink`/`pointsLocator` 是死字段）。

### 文档

- `RELEASE` §6.1 与 `scripts/README` 的发布流程补 `verify:negatives`；CI 注释从「九组」改为「十二个实例」。

## [0.3.11] - 2026-11-24

### 新增

- 取回完整性检查（issue #17）：`test/regression/integrity.ts` 对每个配置了投影的族断言三件事——落给 spill 后端的是**完整原文**（逐字节）、页脚点名的就是后端返回的 locator、页脚里的省略字节数等于两个窗口之外的部分。接进 `npm test`，并有一条「换成截断后的头段就立刻红」的用例证明它真的能失败。
- 冒烟 runner：`npm run test:regression` 跑 `test/regression/tasks.jsonl` 的 6 条合成任务，逐族打印 `view 原始→视图B, omitted N, stored M`。进 `npm run ci`。

### 说明

- 边界如实写进发布说明：宿主 `SpillBackend` 是**只写**的，「宿主真的把字节还回来」插件看不见，仍属宿主责任。这条检查覆盖的是插件自己那一半——「无数据丢失」从 v1 起一直未核实的部分，现在核实到能看见的边界为止。
- 20 条真实回放语料**仍不交付**（2026-11-18 用户否决的是语料，见 `docs/RELEASE.md` 文首）；`tasks.jsonl` 是合成的 6 条，不冒充任务集。

## [0.3.10] - 2026-11-24

### 新增

- `npm run verify:negatives`（issue #15）：把真实 tarball 逐一改坏再跑发布门，证明门能失败并点出是哪一项。之前十二个 check 实例里只有客户端 bundle 一组有负例，其余改坏仍 `exit 0`——不会失败的门等于没有门。**现在十二个实例全部覆盖**：`dist-index-present`、`tarball-allowlist`、`exports-targets`、`client-bundle-structure`、`bundle-patch`、`declarations-host-free`、`typecheck-no-host-stubs`、`install (ignore-scripts)`、`install (default)`、`typecheck`、`import-require-locales (ignore-scripts)`、`import-require-locales (default)`。每条 expect 是该 check 独有的失败文案，不是会命中邻组输出的词。
- 我第一版声明有三组「构造不出」，这是错的：`typecheck-no-host-stubs` 用一个藏在 600 字符之后的宿主类型 import 就能只打红无 stub 的那一遍；`install (ignore-scripts)` 用 `os: ["aix"]` 让安装本身被拒；第二次探针用一个成功安装后用 `postinstall` 改坏模块的 npm 脚本。三条都补上了。

### 修复

- 写这个 harness 时我把一个相对路径当成了仓库路径，`writeFileSync('./lib/client.js')` 把构建产物覆盖成 `module.exports = {}`，随后基线自检报「客户端缺信封」才发现。已修：所有写入都以解包目录为根，并在脚本头注明这一点。

## [0.3.9] - 2026-11-24

### 修复

- 截断视图的模板从三份手抄收敛成一份（`projection/apply.ts` 的 `truncationView`）：投影、影子下界、字节门、回本门、蒸馏基线现在调同一个函数。0.3.5 漏信号行、0.3.8 漏页脚，两次漂移都出在这三份副本上。
- 蒸馏基线的 locator 改用真实的：此前传空串，比同回执的字节门少 17 B / 4 token；注释里「决策时产物还不存在」的说法也不成立——`outcome.locator` 就在手边。
- 采用路径上的宿主页脚调用加了保护：这是该路径唯一未加 try 的宿主调用，抛错会冒到外层 `catch` → 返回原文，已采用的正文与收据双失，且下次重放重复。现在失败只损失测量（`before`/`after` 记 unknown），不损失决定。
- `distill_spilled_bytes` 只在真正落盘的那次上报：表命中重放复用钉住的句柄、不写盘，此前每次重放都会再报一次原文大小，`status.distill.spilled_bytes` 随重放次数膨胀。落盘后才失败的路径（页脚抛错、产物写失败）现在也带上这个尺寸——它们留下的孤儿此前没有任何痕迹。
- `.tmp` 回收的测试改成用真实存活的 pid（`process.ppid`）与一个真的退出过的 pid：此前「活写者」用例走的是「本进程短路」，另一进程的分支从未被执行，删掉保护仍然全绿。

### 文档与测试

- 新增 `test/docs-version.test.ts`：README×2、RELEASE、operating、scripts/README 的安装规格与 `latest` 陈述必须等于 `package.json` 的版本。连续四个版本都有文档落后一到两版，改用会失败的测试盯住。
- `operating` 的 `status.distill` 字段说明补 `saved_tokens`/`spilled_bytes`，并把 `failed` 改为真实的 `fallback`；字节门补「+ 信号行」；设置页蒸馏一节新增两行；README 的字段枚举同步。
- ADR 0001 补 `not-worth-it` 不钉的理由；`decide.ts` 的模块 docstring 与墓碑注释改写（`with the` 悬空句、从未存在过的「旧构建墓碑」论据）。
- CHANGELOG 0.3.6 的「只清十分钟以前的」改为实际的「按 pid 存活判定」。

## [0.3.8] - 2026-11-24

### 新增

- `boost status` 的 `distill` 增加 `saved_tokens`：只累加被采用的收据，回答「蒸馏这条路自己省了多少」。此前 `saved.projectionGross` 把采用与普通投影混在一起，这个数字无处可查。

### 修复

- `distill` 增加 `spilled_bytes` 并随 `distill_spilled_bytes` 落进收据：`not-smaller` 是唯一「先落盘原文、再拒绝」的路径，宿主的 spill 后端没有删除能力，被弃的原文就成了孤儿。现在它至少是可见的计数，不再每次拒绝都静默多一个文件。
- 蒸馏收据的 `before` 现在含页脚：`truncationViewOf` 之前渲染 `head 行 + head + tail + signals`，而投影提交的字节多一个页脚，导致同一回执在两条路径下的基线差一个页脚（实测少报 24 token / 3.9%）。现在用与 `truncationViewBytes` 相同的探测页脚，方向仍然保守（探测串比真实 `retrievalHint` 短）。
- 保留上限的误差写成不变量并加边界测试：只写不超过假定值（4096 字节）的产物时，目录总量不超过 `maxBytes + 一条产物`；超过假定值的那次写会强制测量。

### 文档

- `docs/operating.md` 的蒸馏一节补 `saved_tokens` 与 `spilled_bytes` 两个字段的含义；`docs/RELEASE.md` 的收据码表补 `distill_spilled_bytes`。

## [0.3.7] - 2026-11-24

### 文档

- 版本清单不再记条数，改为指向 `npm view dsh-boost versions`：每发一版那个数字就过期一次，最近三轮通读各抓到过一次。安装规格、`latest` 与 README 示例同步到 0.3.6。

## [0.3.6] - 2026-11-24

### 修复

- 未知原因的墓碑不再冻结回执：读到 `rejected` 不在已知集合里时当作**没有这个产物**并照常调用，此前会走「不是候选」分支——既不调模型也不写收据，该回执从此每次重放都空转。
- 墓碑集合收窄为三个真正该钉的原因（`empty`/`unverifiable`/`not-smaller`）；`timeout` 与 `not-worth-it` 明确不钉，与 README、ADR 0001 的说法一致。
- 新增的墓碑测试此前写的是一个没人读的文件名，删掉守卫仍会通过；改成先用真实路径产出一条墓碑、再手工改坏它的 `rejected` 字段，并断言模型被调用一次。
- 「没有 `horizonFor` 就弃权」的用例此前无法失败（默认 horizon 20 两条路径都放行）；改成把配置 horizon 设为 0，回落即拒绝。
- 保留策略补两条测试：单个产物大于假定值时立即测量（九个 12 KiB 产物不再把目录推到上限之上）、陈旧 `.tmp` 被回收而活写者的不动。
- 裁剪不再无条件删除 `*.tmp`：按 pid 存活判定，只回收所有者已消失的（`kill(pid, 0)` 报 `ESRCH`）与本进程以外的、名字里带 pid 的临时文件。此前每写一次就把所有临时文件删光，另一个进程正在写的那个会让它的 `rename` 报 ENOENT，把一次丢失的竞争变成一次丢失的蒸馏。
- `verifyQuotes` 的 JSDoc 改成与实现一致（零引用失败）；`docs/how-it-works.md` 的字节门补上信号行；`src/distill/decide.ts` 的回本注释与模块 docstring 同步为 `1 + 剩余步数` 与「含信号行」。
- 文档版本线推进到当时的 latest：`RELEASE` 的安装规格、`operating` 的 `latest`、README×2 的安装示例。

## [0.3.5] - 2026-11-24

### 修复

- **回本预判的回放次数改回 `1 + 剩余步数`**（0.3.4 一度写成 `max(1, 剩余步数)`）：`DecideInput.remainingSteps`
  的契约是「不含本次请求的后续回放次数」，账本对采用收据也按 `saved × (1 + horizon)` 计，两者必须同口径。
  旧的写法在 `h ≥ 2` 时少算一次回放，把赚得回的调用判成 `not-worth-it`。新增 `h=1 拒 / h=2 放行` 的边界用例。
- **采用路径保留 §5.4-4 信号行**：被切断的中段里的 `[exit code: N]` 等信号，投影会附在页脚之后，
  蒸馏此前会静默丢掉。现在两条路径用同一个 `signalSuffix()`，`truncationViewOf` 的定价基线也补上它。
- **墓碑的 `rejected` 校验已知集合**：产物是文件，可被手改或由旧构建写入；未知原因当未命中，
  不再让任意字符串变成 `distill-rejected:<anything>`。
- **字节上限不再滞后**：触发条件加上「刚写的产物本身超过 4 KiB 的假设」，此前 9 个 12 KiB 产物能到 2.7× 上限。
- **裁剪失败即停**：`unlink` 失败时不再继续按失真的总量删下去；顺带清理崩溃残留的 `*.tmp`。
- **收窄守卫不再写收据**：采用路径里那个「不可达」分支原来会 `appendReceipt`，多一个调用点就多一条假 skip。
- 文档：`how-it-works` 的「净赚门不看调用成本」改为两道门；`RELEASE`/`operating` 的安装规格统一 `^0.3.4`；
  版本记录条数改正；`verifyQuotes` 的 JSDoc 与实现对齐（零引用是 unverifiable，不是通过）；`store.ts` 的
  Contract 段删掉已不存在的 `clearSession`。

## [0.3.4] - 2026-11-24

### 变更

- **蒸馏产物不再随会话销毁删除**。产物是进入历史的那串字节的证据，而 `resume`/`fork` 会重放同一批
  回执；删掉等于让操作者再付一次调用，而且没有任何信号（收据码仍是 `projected`，`calls` 只多 1）。
  目录改为按上限自我裁剪：超过 5,000 个文件或 16 MiB 时从最旧的开始删，刚写的那条永不被裁；
  字节上限按每个产物约 4 KiB 估过之后才跑全量 `stat`，否则只做一次 `readdir`。要一次性清空就删整个目录。
- **新增回本预判**：调模型之前先算 `最乐观节省（截断视图 − 页脚，含保留的信号行）×（1 + 剩余步数）`
  是否大于 `回执输入 + 输出预算`，不大于就不调（`distill-rejected:not-worth-it`）。此前只有「每次重放
  是否更小」这一道门，它不回答「这次调用能不能赚回来」——剩余步数很少的会话末段必然净亏，现在不会
  被蒸。三种情况这道门弃权（照常调用）：宿主缺估算器、缺可用的剩余步数、估算器答不出价格（抛错或
  非有限数）；回执没有可比的截断视图时同样弃权，不把「超 256 KiB」之类的拒绝记成经济否决。

## [0.3.3] - 2026-11-23

### 修复

- **设置页把「读不到」渲染成「已关闭」**：`/state` 的 `config` 在没有 `distillation` 段的宿主上
  会被判成读失败，于是蒸馏开关显示「已关闭」、其余字段显示「未测量」——把一个没观测到的事实说成
  观测到了。现在分三态：读不到 / 这个构建没有该段 / 有这个段，三种各说各的。
- **「读不到生效配置」旁边的码显示成字面量 `{code}`**：占位符没有被替换。文案不再带占位符，码单独
  渲染；读失败时也不再显示空码。
- **`ERR_HOST_NO_SPILL` 的处置文案说反了**：原文说「投影只保留截断文本、不保存原文」，实际是没有
  spill 后端时**投影被跳过、原文完整保留**。这是一条会让人误以为丢了数据的安全向假警报。
- **「重新读取」按钮出现在重读修不了的失败上**：版本不支持、解析失败、锁被占用这三类失败下，按钮
  既修不好问题又会丢掉草稿。现在只在冲突与读失败时出现。
- **手动重读不取消上一次请求**：两次响应可能乱序落地，旧的覆盖新的，读起来像「刚保存的没生效」。
- **发布门会误拒合法的宿主 `require`**：rollup 会把工厂参数改名成 `require2`（bundle 自己绑定了
  `require` 时），旧正则只认字面 `require`，于是把合法调用判成裸 import。现在按「任意标识符 + 字符串
  字面量」剥离，并补了改名解析器的正反两例。
- 空 `distillation.families` 渲染成空白（读起来像「没配置」），现在渲染「（无）」。
- 替换账的上下界文案用严格「高于/低于」，改成「不低于/不高于」——无回放时两者可以相等。
- 「常驻开销」写「每次请求」，但 778 是协议段 + 工具 schema 的**合计**；当前作用域下实际每请求只付
  其中一部分。标签改「（合计）」，提示里说明。

### 文档

- `AGENTS.md` 的「错误码同步三处码表」改为「`docs/RELEASE.md` 是唯一权威表」——README 从来没有
  码表，规则指向了不存在的东西。
- `docs/operating.md` 补蒸馏一节（六个键、`status.distill` 六个字段、收据码、净赚门的已知偏差、
  回退与产物生命周期），并逐字段定义 `projection_gross_tokens` / `projectionGross` /
  `projectionNet` / `retrievals` 四个数为什么不是同一个数。
- `docs/how-it-works.md` 补蒸馏一章（四道硬约束与为什么需要钉住）。
- 版本串与计数：README×2 的 `latest`、`operating.md` 的安全钉法与历史版本列表、`RELEASE.md` 的
  安装规格与版本记录（补 0.2.2/0.3.1/0.3.2）、发货声明文件「两个」改「三个」、
  `RELEASE.md` 里描述 0.3.2 修掉的那个 bug 的旧措辞、收据表补 `skip:no-scope` 与四个
  `projection-skipped:*`。

## [0.3.2] - 2026-11-23

### 修复

- **蒸馏自 0.3.0 起从未生效**：`llm/stream` 用「请求已注册」判断是否该把流抽干，而注册发生在
  调用模型之前，于是每一次蒸馏（包括调用方还在等的那一次）都被当成迟到答案抽走，调用方拿到
  空串、恒报 `distill-failed`，产物从不落盘——每次启用只是白付一次模型调用与延迟。判据改为
  「已放弃」（超时后 `park()`），活着的调用原样收到自己的流。

## [0.3.1] - 2026-11-23

修复 0.3.0 里蒸馏路径的五处缺陷。前四条在默认配置下不显形（`distillation.enabled` 默认 `false`），但一旦打开就会让投影**变差**。

### 修复

- **拒绝不再取消投影。** 蒸馏被拒、失败或超时时，0.3.0 把原始回执原样交下去，连确定性截断都跳过了——打开蒸馏反而比只开投影更糟，而墓碑会让第一次拒绝永久冻结这个状态。现在一律退回截断视图（#9 的「可回退」）。
- **迟到产物补写 spill 钉。** 超时后落盘的产物不带 `spill`，第一次采用会为它 spill，但那个 locator 没被记下；此后每次采用都重新 spill，页脚因此每次都变——同一回执渲染出不同字节，前缀缓存从那里断掉。
- **模型调用前先查前置条件。** 没有页脚拼装器或没有 spill 后端时，0.3.0 仍先付一次模型调用再把答案丢掉；现在在调用之前返回 `distill-failed`（`distill_calls: 0`）。
- **`distill_input_chars` 覆盖每一次调用。** 抛错、解析失败、超时三条路径原先只记 `calls: 1` 而输入为 0，正好把成本最高的调用记成零输入。
- **迟到收据带上真实回合。** `turn` 在 `post-execute` 到 `decide` 之间没有接线，`distill-late` 收据恒为 `turn: 0`；`DecideInput.turn` 改成必填，漏传现在是类型错误。

### 文档

- `distill-rejected:timeout` 不再声称「重放不会重复计费」——答案始终没来时同一回执会重调一次。
- `distill-rejected:unverifiable` 补上「答案没给出任何引用」这一触发条件。
- 收据码表补 `distill-late` 行；墓碑说明从表内移到表后（它原先切断了表格）。
- 说明 `status.distill.adopted` 数的是采用次数（含读表重放），可能大于 `calls`。

## [0.3.0] - 2026-11-23

### 新增

- 回执蒸馏（ADR 0001，issue #10）：投影前对超过族触发阈值的 `bash`/`ssh` 回执问一个固定问题，用一次有超时的模型调用（`purpose: 'boost-distill'`，不进观测、不结算）得到蒸馏正文。产物按 `(receipt_hash, question_hash, distiller_version)` 存到 `<dshHome>/boost/distilled/`，重放只查表不再调模型；引用必须逐字出现在原文里、且正文按 UTF-8 字节严格短于同一回执的截断视图才采用。默认关（`distillation.enabled: false`），关着时投影路径与 0.2.7 逐字节相同。
- `boost status` 增加 `distill`：`{calls, tokens, adopted, rejected, fallback, input_chars}`，无样本为 0。
- 设置页新增「蒸馏」一节（只读）：六个生效值 + 六行运行态；`enabled` 为真时多一块三句的危险提示（多一次调用、产物钉住、关掉只影响之后）。
- 新收据码 `distill-failed`、`distill-rejected:{empty,timeout,unverifiable,not-smaller}`、`distill-late`；采用时仍写 `projected` 收据，带 `mode` 与 `distill_*` 字段。三处码表（`README.md`、`README.en.md`、`docs/RELEASE.md`）已同步。

### 修复

- 影子模式不再蒸馏：原来判定跑在 `mode === 'shadow'` 分支之前，默认的影子周里每条超阈值回执都会调一次模型、spill 原文、写产物，却不写任何收据。
- 重放不再产生第二份 spill 文件：产物钉住 `{locator, retrievalHint}`，而宿主后端用 `randomBytes(6)` 命名——重新落盘会让页脚（模型读到的那一半）与进历史时的字节不同。
- 被拒的结果也钉墓碑（`empty`/`unverifiable`/`not-smaller`），重放读它而不重新调模型；`timeout` 不钉，好让迟到的答案仍能落地。
- 蒸馏产物的查找与写入统一用请求的模型名：模型自报别的名字时 pin 永不命中。
- 空正文不再被采用（它会通过其余每一道门，然后用一行 marker 替换整条回执）。
- `MAX_ANSWER_CHARS` 成为真上限：夹住单个 delta，不再让一块巨大的增量整块通过。
- 每次调用只注册一个请求对象：原来注册两个，其中一个永不清理，会把还没回答的挂起调用挤出 `MAX_PARKED`。
- 迟到答案的调用成本进 `status.distill.tokens`（另写一条 `mode: 'late'` 收据，只加 token，不加 `calls`）。

## [0.2.7] - 2026-11-23

### 新增

- `boost status` 增加两个缓存护栏字段：`cache_hit_ratio`（最近一次真实请求的命中率，无样本为 `null` 而非 0）与 `prefix_drops`（相邻请求间 `cacheRead` 低于上一次 `input + cacheRead` 的次数与缺口 token 数）。它们只做诊断：压缩、换路由都会造成合法的回落。
- `test/projection-determinism.test.ts` 钉住投影的确定性：同输入同字节，且投影路径不得读时钟或随机源。

### 文档

- 设置页补两行缓存护栏（命中率、前缀回落次数 / 缺口 token），中英各四个键。
- `docs/RELEASE.md` 的版本线回到现状：一路停在 0.2.3 的标题、安装规格、依赖钉版与 allowlist 来源数（六→七）都改正；`engines.dsh` 的 `0.2.3-rc.5` 说法与实测不符，改为「落在区间外，会告警但仍加载」。
- 规格 #2 的 story 5/6 原来说的是「投影节省区间的上下界」，而运行时只报替换账的那一对；ticket #6 的「两类诊断」中 `pathUnmatched` 从未实现、也无法从 `/state` 计算，改为「一个可算诊断 + 移除动作」。
- 新增 `docs/adr/0001-receipt-pinned-distillation.md`：二期蒸馏产物按 `(receipt_hash, question_hash, distiller_version)` 钉住，重放只查表不重算。

## [0.2.6] - 2026-11-23

### 修复 Fixed

- **`degraded` 不是数组时整页崩**（0.2.5 引入）：类型化信封把 `status.degraded` 标成 `string[]`，页面于是直接 `codes.map`；宿主发来一个对象就 TypeError、整页空白。类型只描述我们期望的形状，线上的东西仍然不可信——守卫放回去，并用一个「`degraded` 是对象」的载荷钉住。
- 视界重算那段和收据计数用了同一个标题，连续两节重名；重算那节改用状态标题。
- `CONFIG_UNAVAILABLE` 还写着「config 不是对象」，而现在判断的是 `config.ok`。

## [0.2.5] - 2026-11-23

### 变更 Changed

- **信封成了类型**：`StatePayload` 的 `status`/`scope`/`config` 从 `unknown` 改成判别式信封 + 真实载荷类型（`BoostStatus` / `ScopeDoc` / `BoostConfig`），`runBoost` 补了逐命令重载。两次已发布回归（0.2.1 从信封上读载荷字段、0.2.3 在载荷上问信封）现在都是编译错误，`test/ui-payload.test.ts` 用 `@ts-expect-error` 把两条钉住。
- **`/state` 的 `config` 改为信封**（`{ok,data}`），与 status/scope 一致；这是线上形状的变化，页面与测试同步更新。
- **失效工作区可以移除**：注册表里已经没有、但下次保存仍会保留的 id 现在带一个移除按钮（`data-action="remove-stale-workspace"`），`staleWorkspaceIds` 改读草稿，所以移除在保存前就可见。`unmatchedDraftIds` 与 `LABEL_UNMATCHED_IDS` 删除——它在任何可达状态下都是同一个集合。

### 修复 Fixed

- `LABEL_STALE_IDS` 与新行为不符（列表已跟随草稿）→ 改为「注册表里没有、但下次保存会留下的工作区」。
- `NO_DEGRADED` 把「这次读到的降级码为空」说成「宿主提供了全部服务」——后者是清单声明，前者观测不到。文案改为只陈述观测。
- `projection_horizon_reestimated` 在 status 里但页面从不渲染，而设计 §5.3 存在的意义正是让重算过的数字不被当成实测。现在显示。

## [0.2.4] - 2026-11-23

### 修复 Fixed

- **状态面板永远显示「读不到」**（0.2.3 引入）：上一版让页面「只有 `ok:true` 才敢说没有降级项」，但判断做在**解包后的载荷**上，而载荷是 `BoostStatus`、根本没有 `ok` 字段——于是这个条件永远为假，页面从此只会说「状态不可用」，降级码一个也看不到。比它想修的那个 bug 更糟。现在判断回到信封上，并把这段读法抽成 `envelopeOf()` 由测试钉住。
- **spill 提示把「存在」当「可用」**：`hasSpill` 只证明后端在，不证明写得进去；提示却承诺「原文会落到那里」。另外 `false` 与「读不到」共用一句话，而那句话断言 `boost status` 会报 `ERR_HOST_NO_SPILL`——在那一屏恰恰不会。现在三种情况三句话，且 OK 那句明说它只证明存在。
- **`ERR_RECEIPTS_TRUNCATED` 的建议指向错的地方**：上一版把「旧分片被丢弃」从 `ERR_RECEIPTS_UNREADABLE` 删了，却留在了截断这条上——而分片从不被清理，256 片之后只是没读。改为「只读了前 256 个，把旧的 receipts 目录移走再重来」。
- 版本与计数：两份 README、RELEASE、`scripts/README` 的版本串到 0.2.4（`engines.dsh` 的宿主区间保持 `>=0.2.2-rc.4 <0.2.3-0` 不变），RELEASE 的发布 commit 锚点、`CHANGELOG` 的键数（99）与「九种坏法」。

## [0.2.3] - 2026-11-22

### 修复 Fixed

- **宿主包子句拦错了方向**：上一版让门拒绝任何提及 `@deepseek-ai/*` 的产物，而 `require("@deepseek-ai/x")` 正是文档允许的形式——门在禁止文档要求的写法，且它自己也看不见真正的问题（内联后 specifier 消失）。现在只拒绝 `require(...)` 之外的提及，并补一条「经 `require` 解析必须通过」的正例。
- **工作区名字被丢在路由里**：宿主的 `Workspace` 有 `title`，`listWorkspaces` 把它丢了，页面只能画路径。现在一路带到页面，优先显示 `名字 — 路径`。
- **spill 前置条件翻之前查不到**：提示文案说「页面上也会显示这一条」，但 `ERR_HOST_NO_SPILL` 只在 `projection:'on'` 时出现，翻之前那一屏的降级列表是空的。现在提示直接读 `status.hasSpill`：拿到了就说拿到了，没拿到就说没拿到。
- **状态缺失也被当成健康**：上一版只处理了 `ok:false`，`status` 整个缺失或不是对象时仍会渲染「宿主提供了全部服务」。现在只有 `ok:true` 才允许这么说。
- **设置页路由的生命周期没人管**：`registerHttpApi` 的 disposer 被丢弃，而 `webServer.register` 不是 fiber 托管的——卸载或 HMR 重挂时路由留在原地，再挂一次就因重复注册抛错。现在交给 `ctx.effect`。
- **本地化文案与代码不符**：`ERR_RECEIPTS_UNREADABLE` 说「旧分片被丢弃」（实际从不清理）、`ERR_HOST_NO_SPILL` 说装 `dsh-spill`（后端是 `dsh-spill-local`）、`ERR_SCOPE_LOCKED` 只说「另一个进程拿着锁」（锁文件建不出来也用这个码）、`UNKNOWN` 写成「未知错误」却用来标未测量的数字（改为「未测量」）。
- **发布门可经软链静默不跑**：`invokedDirectly` 直接比较 `import.meta.url` 与 `pathToFileURL(argv[1])`，经软链两者不同 → exit 0、什么都没检查。现在先 `realpathSync` 再比。
- 版本与计数：两份 README 的 `latest` 与安装规格、RELEASE 的标题/版本列表/发布 commit、`scripts/README` 的版本、`CHANGELOG` 的键数（94→99）与「九种坏法」、`prepare` 的文档描述（现在两半分别按需构建）。

## [0.2.2] - 2026-11-22

### 修复 Fixed

- **`ERR_SCOPE_WRITE_FAILED` 到不了调用方**：上一版加了码，但 `SCOPE_CODES` 没把它列进去，`runBoost` 于是把它压成 `ERR_BOOST_INTERNAL`；建目录失败也仍抛读失败码。两处都修好，并补一条钉住「原样返回」的测试。
- **git 安装装出一个没有设置页的包**：`prepare` 只构建服务端，`lib/client.js` 缺失，而宿主遇到缺 `./client` 是直接抛错。现在两半都按需构建，第二次运行两半都跳过。
- **状态读取失败被渲染成「一切正常」**：`/state` 失败时页面显示「宿主提供了全部服务」「还没有任何收据」——一个自信的错答案。现在读不到状态就直说读不到，数字不再冒充「没有」。
- **`SAVED` 声称与磁盘一致**：页面不轮询，别处（例如让模型调用 `boost`）改了 scope 之后它不会知道。改为「与页面上次读到或保存时一致」，并写明要重新读取。
- **投影提示标题说「两件事」但只渲染一条**：`shadow` 与 `content[].thinking` 的那条 400 提示已经移到影子模式开关上，标题跟着改成「一件事」。
- **客户端不变式只对 React 成立**：发布门原来只查 React 是否经 `require` 解析，`@deepseek-ai/*` 被内联也能过。现在门会拒绝任何提及宿主包的产物，并补一条负例。
- **槽位 disposer 被丢弃**：`slots.inject` 的返回值没接，HMR 重挂会叠出第二个设置分区。现在交给 `ctx.effect` 管生命周期。
- 版本与文档：`README` 的 `latest`、安装规格、RELEASE 的版本列表与发布 commit、`CHANGELOG` 的键数（92→94）、README.en 被表格切断的段落、「六种坏法」实为九条。

## [0.2.1] - 2026-11-22

### 修复 Fixed

- **状态面板读高了一层信封**：`/state` 原样返回 `runBoost` 的结果，所以 `status` 是 `{ ok, data }`，而页面在信封上读 `saved`/`degraded`/`counts`——每一行都渲染成「未测量」、降级列表永远为空，页面看起来一切正常其实什么都没看见。新增 `payloadOf` 解开信封（失败时保留，码仍可读），并补上这条接缝的测试：组件按设计不做渲染测试，所以钉的是「路由造出的载荷」与「页面读它用的解包」这两半。
- **两个危险开关的提示挂错了位置**：`content[].thinking` 的 400 来自合成回合，只有替换（`shadow: false`）才会触发，与投影无关。现在投影切到 `on` 只提示 spill 前置条件，关掉影子模式才提示那个 400；两处都给回滚办法。
- **回滚命令写错**：原文让人「跑 `boost shadow true` 回滚投影」，但 `shadow` 子命令写的是 `doc.shadow`，不动 `projection`。改成 `scope-set` 带 `body: {"projection": "shadow"}`。
- **写盘失败被报成读盘失败**：`writeAtomic` 失败原来映射到 `ERR_SCOPE_READ_FAILED`，页面于是建议「重新读取」——那会丢掉一份好草稿，而基线其实还在。新增 `ERR_SCOPE_WRITE_FAILED`（HTTP 500），页面让它原样重试。
- **写 `/state` 返回 404，文档说 405**：写分支把非 `/scope` 的路径一律当未知路由。现在写只读路径是方法错误（405 `ERR_HTTP_METHOD`），测试同时覆盖 `PUT` 与 `POST`。
- 安装规格与文档里的版本串还是 `^0.1.3`（`docs/RELEASE.md`、两份 README），`^` 不跨大版本，照着装会装回没有设置页的版本；统一到 `^0.2.0` 并写明从 `0.1.x` 要显式升级。
- 两份 README 的 `locale` 依赖行说页面「不跟随宿主语言、固定中文」，与实现相反；改为跟随宿主语言、缺服务时回落中文。
- `ERR_BOOST_HTTP_MOUNT_FAILED` 之前只在 `src/index.ts` 的兜底分支里作为字面量出现，而挂载路径自己吞掉失败，那个分支到不了；改为在挂载路径的三处失败上带码告警，并把它声明成常量。
- 发布门的 `factory` 子句缺失败例（七个断言只有六个负例）；补一条「工厂没有 `require` 参数」的负例。
- 客户端的 `external` 只写了 `react-dom` 裸名，`react-dom/client` 会被打进产物而门抓不到；补 `^react-dom\//`，门的 React 断言也一并认 `react-dom`。
- `CHANGELOG` 的 0.2.0 段把 `ERR_BOOST_PARTIAL_MOUNT` 列为新增（它在 0.1.4 就有），UI 键数写成 91（实为 92）；删除无发射点的 `HINT_PROJECTION_ON_THINKING`，补 `ERR_SCOPE_WRITE_FAILED` 的码表行。
- 两份 README 补「设置页」一节：页面在哪、能改什么、读不到数据时显示什么码。
- 死代码与命名：删掉无调用者的 `registryOf`、把测试名里的 `pathUnmatched` 改成 `unmatchedDraftIds`、把客户端日志前缀从 `[boost]` 统一成 `dsh-boost:`，并把槽位 id（契约，仍是 `boost`）与日志前缀分开成两个常量。

## [0.2.0] - 2026-11-22

新增对外面：`dsh.client`、`./client` 出口、设置页数据路由、客户端产物。`0.1.x` 升到这里要显式改版本号（`^0.1.4` 不会自动跳到大版本）。

### 新增

- **设置页**（`settings.section`，id `boost`）：在宿主的设置面板里读写 `scope.json` 的四个字段，走与 `boost scope-set` 同一个 CAS；只读列出 `boost status` 的全部面板（降级码与处置、节省区间上下界、收据计数、常驻开销、生效配置）。
- **数据路由** `/dsh-boost/api`：`GET /state`、`POST /scope`。同源栅栏（`Host` 白名单防 DNS rebinding；写要求 `Origin`，读放行缺失的 `Origin`——同源 `GET` 本来就不带它）。
- **中英双语**：`locale/{zh,en}.json` 各 99 个 UI 键，跟随宿主 `locale` 服务；宿主没有这个服务时页面仍可用，固定中文并 `console.warn` 一次。
- 两个危险开关各有自己的提示，**只提示，不做硬门**：投影切到 `on` 时提示 spill 前置条件；关掉影子模式时提示盯一次含 `content[].thinking` 的 400（那个 400 来自合成回合，只有替换才会触发，与投影无关）。两处都给回滚办法。
- 发布门新增两条不变式：服务端 `dist/` 零静态宿主 import；客户端产物只经 `require` 解析宿主模块且必须带加载器信封。两者都有能失败的负例。
- 新码：`ERR_HTTP_{METHOD,NOT_FOUND,FORBIDDEN,INTERNAL,BODY,WORKSPACES_UNAVAILABLE}`、`ERR_CLIENT_{NETWORK,SHAPE}`、`ERR_BOOST_HTTP_MOUNT_FAILED`、`ERR_SCOPE_WRITE_FAILED`（写盘失败与读盘失败分开：前者不该建议重读，那会丢掉一份好草稿）。

## [0.1.4] - 2026-11-21

### 修复 Fixed

- **节省区间不再可能下界高于上界**：下界是「被跳过那一步的 totalTokens」，上界是「下一次真实请求的输入」。上下文在两次采样之间缩小（压缩、重建请求、适配器不回放整轮输出）时两者会倒挂，现在下界超过上界就置为 `'unknown'`，status 成对求和时该收据只计上界。
- **准入判据与定义一致**：`savedTokensOf` 现在计 `input + cacheRead + output`（此前漏掉 output，比 design §5.3 的定义保守，会拒掉本该做的替换）。
- **被切断中段里的信号不再丢失**：`[exit code: N]` / `exit_code` / `is_error` 这类行会从被省略的中段救出、附在两个窗口之后，并让插件自己的投影识别器接受这个后缀。此前 `Truncation.after` 是个死字段——两个渲染器都从 head/tail 重建，救出的行永远到不了模型。
- **投影收据记录省略量**：`omitted_bytes` / `omitted_code_points`（`ProjectionOutcome` 的这两个字段此前无人读取）。
- **git 安装可用**：`dist/` 在 gitignore 里且没有构建钩子，`dsh plugin add github:...` 装出来的包 `ERR_MODULE_NOT_FOUND`。新增 `prepare`，仅在 `dist/index.js` 缺失时构建，发布路径上是空操作。
- **测试门按用例数而非文件数把关**：`scripts/run-tests.mjs` 此前只数 `.test.ts` 文件，二十个空文件即可通过；现在要求至少 600 个用例。
- **发布门在 Windows 上可用**：`verify-package.mjs` 用 `execFileSync` 启动 `npm.cmd`，Node 不允许不经 shell 启动 `.cmd`；已加 `shell: true`。
- 删除死代码：`shouldTruncate`（第二个只在测试里用的入口）、`markerResetOf` 的不可达空守卫与未用参数。

### 文档 Docs

- 双语 README、发布手册与变更日志按第六轮审计更正：需求 2.1/2.2 的收窄改记为实现者决定 E2（不再引用已删除的「用户裁决第 9 条」），0.4% 不再称「净保底」，`candidateRecall` 改称提交产出率，`retrievalUpperBound` 说明是已观测取回率的下界，准入豁免改述为「单步计划」，补上 ②.3 排序问题这一开放缺口、影子周全零无法与「模型从未写计划」区分、HarnessMM 未移植的 EDG 与 RSI、`kind:'reset'` 收据行、`skip:no-scope` 两条路径的差别、`projection-skipped:no-owner` 从钩子不可达；版本与计数全部对齐 0.1.3/0.1.4。

## [0.1.3] - 2026-11-21

### 修复 Fixed

- **替换不再在模型看不到的输出上提交**：`accept` 自带 `content`（外层 shaper 改写过的正文）时清空计划、不替换；此前守卫与字面量校验读的是原始回执，而模型看到的是改写后的文本。
- **节省改报区间**：`saved_input_tokens` 是上界（后一次请求的输入，含被替换调用自己的结果），新增 `avoided_total_tokens` 是下界（计划那一次请求的 `input + cacheRead + output`）；`status.saved.substitution` / `substitution_avoided` 成对求和，任一收据缺一侧则两侧都不计，避免下界超过上界。
- **计划参数按 JSON 往返归一**：`-0` 与 `1e400` 这类合法 JSON 值此前会被防篡改检查判为篡改，合成回合花掉而工具从未执行。
- **决策阶段抛错留痕**：新增收据码 `substitute-skipped:gate-error`。
- **外层 shaper 的页脚必须同时写明位置与省略字节数**，否则不算同一条回执的改写（此前只要尾部像页脚就接受）。
- **三个新的宿主能力码**：`ERR_HOST_WORKSPACE_REGISTRY_BROKEN`（服务在但 `list()` 抛错）、`ERR_HOST_SPILL_UNUSABLE`（服务在但没有 `saveText`）、`ERR_HOST_SELECTOR_UNAVAILABLE`（LLM 软依赖缺失）。此前这三种都是「看起来健康的插件什么都不做」。`status` 新增 `hasSpill`。
- **版本守卫按 `engines.dsh` 区间判断**：rc.5 / 0.2.2 不再告警。
- **测试门不再可能空跑通过**：`npm test` 改为 `scripts/run-tests.mjs`，测试文件少于 20 个直接失败（此前 glob 匹配不到任何文件时 Node 以 0 退出）。
- **发布门补两道**：`verify:package` 在无宿主 stub 的消费方树里再跑一次类型检查；CI 要求 lockfile 里每条 `resolved` 都是 npmjs。
- 文档与设计稿按本轮审计结果更正（registry 事实、`hasSpill`/`hasWorkspaceRegistry` 的存在性语义、页脚算术、影子报告的能力边界、需求收窄的记录与出处）。

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
- 文档：`^0.1.2` 是安全的钉法（两个 registry 的 `latest` 都是 0.1.2；发布当时的 `^0.1.0` 会因镜像滞后落到 0.1.0）；页脚 190/192 字符、死区从 743 起；收据按「决定」写，无计划的 `write`/`edit` 不落收据；分片轮转与 256 上限按编码后的会话名计；宿主 home 默认是 `~/.dsh`；20 任务门是人工流程且任务集不随包发布；发布门是**实现者**的决定而非用户裁决。

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
- 文档：3.5% 不再被称为「保底」；首次 `status` 的 `degraded` 是空；状态目录
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
