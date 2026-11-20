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

顺序不能反：**先 `npm pack --dry-run`，再 `npm pack`**。`npm pack` 只校验包名与版本；缺 `files`
条目、缺 `dist/` 它仍可能 exit 0。产物完整性必须显式检查：

```bash
test -f dist/index.js
test -f dist/index.d.ts
tar -tzf dsh-boost-0.1.0.tgz | grep -E 'package/(dist/index\.js|dist/index\.d\.ts|cordis\.patch\.yml|NOTICE|LICENSE)$'
```

验收前的硬约束（设计 §11）：

- `package.json` 的 `name`、`cordis.patch.yml` 行的 `id`、行的 `name`、导出插件的 `name` 四者完全一致；
  宿主按 `row.id == entry.options.id && row.name == entry.options.name` 判定"已装配"，缺一个会被**静默跳过**。
- `version` 必须存在，否则 `npm pack` 在第一步就报 `Invalid package, must have name and version`。
- `files` 与实际布局一致：`scripts/` 与 `test/` 是 dev-only，**不**进包；`dist/` 由 `prepublishOnly` 构建。

## 2. 空项目安装（isolated 布局）

**这一步必须在一个没有任何 `node_modules` 祖先目录的空项目里做。** hoisted（提升）布局会把
`@deepseek-ai/dsh-spill-policy` / `@deepseek-ai/dsh-token-meter` 提升到上层可解析的位置，于是"宿主没装这个
包"根本复现不出来；`ERR_MODULE_NOT_FOUND` 也就测不到。isolated 布局才让缺失真实可见。

```bash
rm -rf /tmp/dsh-boost-accept && mkdir -p /tmp/dsh-boost-accept
cd /tmp/dsh-boost-accept
npm init -y
npm_config_cache=/tmp/npmcache npm install /path/to/dsh-boost-0.1.0.tgz

# 确认安装布局是扁平的、没有上层 node_modules 兜底：
npm ls --all | head -40
test -d node_modules/dsh-boost
```

随后在一个一次性的 `DSH_HOME` 里装配（不碰真实 profile）：

```bash
export DSH_HOME=/tmp/dsh-boost-accept/dsh-home
mkdir -p "$DSH_HOME"
dsh plugin add /tmp/dsh-boost-accept/node_modules/dsh-boost
# 让宿主真正加载一次插件（任一工具回合即可），然后看 boost status。
```

`boost status` 是验收的观察面：它输出 `shadow` / `projection` 两个开关、按 `code` 的收据计数、替换账与
投影账（投影账为净额并附 `projection_retrievals`）、实测固定开销 token，以及稳定降级码。插件本身不说话，
**不要**用"我记得开了"代替 status。

### 2.1 卸载 `@deepseek-ai/dsh-token-meter`

```bash
cd /tmp/dsh-boost-accept
npm uninstall @deepseek-ai/dsh-token-meter
npm ls @deepseek-ai/dsh-token-meter || true   # 必须确认真的不存在
```

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

### 2.2 卸载 `@deepseek-ai/dsh-spill-policy`

```bash
npm uninstall @deepseek-ai/dsh-spill-policy
npm ls @deepseek-ai/dsh-spill-policy || true
```

预期（设计 §5.4 / §11）：

| 观察点 | 期望 |
|---|---|
| 插件加载 | **成功**。`spillStore` 是软依赖 |
| `projection: 'on'` + 超限回执 | **不投影**，原文原样进入历史（保证据） |
| 收据 | `projection-skipped:no-spill` |
| `boost status` 的 `degraded` | 含稳定码 `ERR_HOST_NO_SPILL` |
| `projection: 'shadow'` | 不受影响：影子只记投影前后 token，不落盘、不改 content |
| 替换 | 不受影响（替换不依赖 spill 后端） |
| 失败形态 | 同样不应是 `ERR_MODULE_NOT_FOUND`；页脚格式化器缺失时只能降级为 `projection-skipped:no-footer`，不能抛到工具结果上 |

### 2.3 两条路径都要留证据

每条路径至少保留：

```bash
# 一次 status 的完整输出
dsh ...            # 触发一次工具回合
# 收据里对应 code 的计数（可以直接数行）
grep -c '"code":"projection-skipped:no-spill"' "$DSH_HOME"/boost/receipts/*.jsonl
grep -c '"code":"ERR_HOST_NO_TOKENMETER"' "$DSH_HOME"/boost/receipts/*.jsonl
```

若 `ERR_MODULE_NOT_FOUND` 出现，直接在 isolated 目录里跑 `node -e "import('dsh-boost')"` 复现并记录栈；
hoisted 布局下的"通过"不算通过。

## 3. 20 任务回归门（只规定过程，不附带任务集）

这一节是可执行的过程说明。操作者自备任务清单；每条至少包含 `id`、`prompt` 与"完成"的判定方式
（`isError=false` 即工具调用没有报错）。**两轮**指同一任务在基线配置与开启配置下各跑一次。

设计 §6.1 的 pass 谓词原文：

> pass ⇔（两轮都完成且 `isError=false` 的任务数 ≥ 19）∧（每条被投影的回执都能用页脚 locator 取回，且取回字节数 = 页脚 `count` + 保留窗口字节数）

执行步骤：

1. 准备 ≥20 条任务；两轮使用同一宿主版本、同一模型路由、同一工作区快照。
2. 基线轮：`shadow: true`、`projection: 'off'`（或默认 `selected+[]`）。
3. 开启轮：按 §6 的分批顺序打开替换族（先 `read`，再 `grep`/`glob`，最后 `bash`/`ssh`），
   `projection: 'on'`；每族一个观察窗。
4. 记录每条任务的完成状态与是否 `isError=false`；统计两轮都完成且无错的任务数。
5. 对开启轮每条 `kind:'projection'` 且 `code:'projected'` 的回执，按页脚 locator 取回原文，比较：
   `取回字节数 == 页脚 count + 保留窗口字节数`。任一条不成立即 pass 失败。
6. 结论只写"过门 / 未过门"；**不要**给 20 个任务算成功率或显著性——分辨率是 5 个点，判定不了 1 个百分点。
   v1 不声称守住了 A1 的 1pp。

回归门是"没有灾难性回退"的门，不是"成功率没降"的证明。

## 4. reasoning 兄弟块风险（必须在影子周第一次真实运行前确认）

替换出来的合成工具回执进入历史后，下一次真实请求若走 Anthropic 兼容的 thinking 模式，服务端可能要求
assistant 的 `tool_use` 必须带兄弟 `thinking` 块。我们的合成回合目前没有 `replayState`，真实的
pi-ai `transformMessages` 会丢掉 thinking 块。

**判定信号**：出现一个 **400**，且错误消息包含 `content[].thinking`。这表示被替换回合的 thinking 块
**没有到达线上**（不是参数错、不是模型错）。

处置：

1. 立即在该路由上**关闭替换**（`shadow` 可留，替换不可），改用投影 + 普通模型回合；
2. 保留该 400 的原始请求/响应与 session id，作为证据；
3. 在修复前不要重开：修复方向是给合成消息一个能保住 thinking 块的 `api`/`replayState`，或在该路由上
   永久不合成 `tool_use` 回合；
4. 投影不受这条风险影响，可继续开。

验收时把"是否见过 `content[].thinking` 400"写成明确的是/否；**没见到**也要写"未见"，不能留空。

## 5. 影子周与统计复算

### 5.1 影子报告（收据）

```bash
node scripts/shadow-report.mjs --dir "$DSH_HOME/boost/receipts"
```

输出四个标签（空目录输出四项零值，不抛错）：

| 字段 | 含义 |
|---|---|
| `saveableRatio` | 只读白名单真正能兑现的替换比例：`whitelisted` 影子提交 / 全部替换决策 |
| `byFamily` | 按工具族的命中率：`commits / decisions`（影子期绕过白名单，所以 bash/ssh 的潜力也计入） |
| `candidateRecall` | 候选集召回：`commits / (commits + no-candidate)`，分母是**计划提出的候选集**；`guard-trivial` 不提出候选，不进分母 |
| `retrievalUpperBound` | 取回率上界：取回调用数 / 已应用投影回执数（取回回执本身不计入分母） |

脚本读的是 `ReceiptStore` 写的同一套字段，只读完整行；尾部半行与坏行跳过。它不需要 `src/` 或构建产物。

### 5.2 §2.1 统计与快照

`scripts/session-snapshot.json` 是一个**聚合**，不含任何会话正文：

- `asOf`：冻结时刻（`2026-11-19T03:13:21Z`，设计稿冻结提交的时间）与选择规则；
- 300 个会话的 `id`、`bytes`、`createdAt`；
- 每个会话的计数器：`steps`、`toolCalls`、`callsPerStep`、`requests`、`tokens`、
  `whitelist`、`valueTransfer`；
- 两条数值序列：每个请求的 `totalTokens` 与每个回执的字符数（中位数/分位数需要，仍然不含正文）。

复算（CI 用这个，不碰会话目录）：

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
历史截面，而实时会话文件一直在增长。快照一旦提交就是权威：`--snapshot` 不重新选样，CI 只复算已提交的
聚合。若复算值与设计稿 §2.1 有出入，按快照的实际值报告，**不得**改快照去凑设计稿数字。

## 6. 发布检查清单

- [ ] `npm run build` 干净，`dist/index.js` 与 `dist/index.d.ts` 存在
- [ ] `npm pack --dry-run` 与 `npm pack` 均成功，`version` 非空
- [ ] isolated 空项目安装成功，`node -e "import('dsh-boost')"` 无 `ERR_MODULE_NOT_FOUND`
- [ ] 卸 `dsh-token-meter`：替换拒绝、投影可用、`ERR_HOST_NO_TOKENMETER`、账目 `unknown`
- [ ] 卸 `dsh-spill-policy`：超限回执不投影、`projection-skipped:no-spill`、`ERR_HOST_NO_SPILL`
- [ ] 两条降级路径都在 isolated 布局下验证，并保留 status/收据证据
- [ ] 20 任务门按 §3 跑过，pass 谓词逐字对照，结论只有"过门/未过门"
- [ ] 影子周第一次真实运行检查 `content[].thinking` 400；若有，替换在该路由关闭
- [ ] `npm run stats` 在干净 clone 上可复算 §2.1 聚合
