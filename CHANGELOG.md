# Changelog

本文件记录用户可感知的变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。设计与取舍不在本文件展开，见
`docs/superpowers/specs/`；发布验收流程见 `docs/RELEASE.md`。

This file records user-visible changes. Format follows Keep a Changelog; versions follow SemVer.
Design rationale lives in `docs/superpowers/specs/`; the release-acceptance procedure is in
`docs/RELEASE.md`.

## [Unreleased]

## [0.2.3] - 2026-11-22

### 修复 Fixed

- **宿主包子句拦错了方向**：上一版让门拒绝任何提及 `@deepseek-ai/*` 的产物，而 `require("@deepseek-ai/x")` 正是文档允许的形式——门在禁止文档要求的写法，且它自己也看不见真正的问题（内联后 specifier 消失）。现在只拒绝 `require(...)` 之外的提及，并补一条「经 `require` 解析必须通过」的正例。
- **工作区名字被丢在路由里**：宿主的 `Workspace` 有 `title`，`listWorkspaces` 把它丢了，页面只能画路径。现在一路带到页面，优先显示 `名字 — 路径`。
- **spill 前置条件翻之前查不到**：提示文案说「页面上也会显示这一条」，但 `ERR_HOST_NO_SPILL` 只在 `projection:'on'` 时出现，翻之前那一屏的降级列表是空的。现在提示直接读 `status.hasSpill`：拿到了就说拿到了，没拿到就说没拿到。
- **状态缺失也被当成健康**：上一版只处理了 `ok:false`，`status` 整个缺失或不是对象时仍会渲染「宿主提供了全部服务」。现在只有 `ok:true` 才允许这么说。
- **设置页路由的生命周期没人管**：`registerHttpApi` 的 disposer 被丢弃，而 `webServer.register` 不是 fiber 托管的——卸载或 HMR 重挂时路由留在原地，再挂一次就因重复注册抛错。现在交给 `ctx.effect`。
- **本地化文案与代码不符**：`ERR_RECEIPTS_UNREADABLE` 说「旧分片被丢弃」（实际从不清理）、`ERR_HOST_NO_SPILL` 说装 `dsh-spill`（后端是 `dsh-spill-local`）、`ERR_SCOPE_LOCKED` 只说「另一个进程拿着锁」（锁文件建不出来也用这个码）、`UNKNOWN` 写成「未知错误」却用来标未测量的数字（改为「未测量」）。
- **发布门可经软链静默不跑**：`invokedDirectly` 直接比较 `import.meta.url` 与 `pathToFileURL(argv[1])`，经软链两者不同 → exit 0、什么都没检查。现在先 `realpathSync` 再比。
- 版本与计数：两份 README 的 `latest` 与安装规格、RELEASE 的标题/版本列表/发布 commit、`scripts/README` 的版本、`CHANGELOG` 的键数（94→95）与「九种坏法」、`prepare` 的文档描述（现在两半分别按需构建）。

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
- **中英双语**：`locale/{zh,en}.json` 各 95 个 UI 键，跟随宿主 `locale` 服务；宿主没有这个服务时页面仍可用，固定中文并 `console.warn` 一次。
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
