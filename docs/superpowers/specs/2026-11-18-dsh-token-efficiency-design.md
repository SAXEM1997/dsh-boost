# dsh-boost：用三层委派提高 DSH 的 token 效率

- 日期：2026-11-18
- 状态：已评审（specpowers-review），待批准
- 相关研究：[三层委派的一手来源研究](../../research/2026-11-18-three-tier-delegation.md)

## 1. 意图与为什么

目标是在 DeepSeek Harness（DSH）上做一个插件，让**同样的任务用更少的 token 完成，且成功率不降**。参照 HarnessMM 的"已定决策复用"思路：工具回执回来时，如果下一步在规划时就已经确定，就不必再问一次大模型。

参照对象的核心机制（EDG 计划 / GDR 守卫 / CCS 回调替换 / Jev 快选择）在 `ref-harnessmm/` 中已完整实现，并附带一个能跑的 DSH 插件 `dsh-plugin/harnessmm-desktop`。本项目是**移植 + 改造**，不是从零实现。（Jev = 选择器，见 §5.1 的术语约定。）

要解决的问题在两个方向上都存在：

1. **调用次数**：每一步工具调用都要重新问一次主模型，而其中很多步在规划时就已确定。
2. **每次调用的体积**：工具回执原样进入上下文后，会在后续每一步被重新回放一次。

## 2. 证据

### 2.1 真实会话统计（本机 300 个最大会话）

数据源：`/dsh-home/sessions` 中 300 个最大会话的 `session.v4.jsonl.zstd`，含 provider 记账字段 `usage.{inputTokens, cacheReadTokens, outputTokens}`。

| 指标 | 数值 | 含义 |
|---|---|---|
| 模型调用步数 / 工具调用数 | 54,123 / 62,621 | 平均每会话 180 步 |
| 每步工具调用数 | 1 个：80.0%；2 个：15.8%；≥3：1.0% | 单工具步是主流，批量已存在但非主体 |
| 每请求平均回放 token | 194,473（均值）/ 185,590（中位） | 分母是请求数；上下文重放是绝对主体 |
| 每步平均回放 token | 194,312 | 分母是 54,123 步；与上一行分母不同，不是矛盾 |
| 缓存命中占比 | 97.1% | 几乎全部输入是缓存读 |
| 工具回执大小 | p50 648 / p90 4,635 / p99 18,186 字符 | 超过 2k 字符的占 26.2% |
| 工具回执体积占比 | bash 63.0%、read 20.8%、ssh 9.1% | 攻击面集中；**v1 投影覆盖 read+grep+glob+bash+ssh（合计约 93% 回执体量）** |
| 白名单工具（read/grep/glob）覆盖 | 调用占 5.5%（3,439/62,621）；全覆盖 step 占 3.84%（2,080/54,123）；单调用 step 占 2.98%（1,611/54,123）；这些 step 的 token 占 2.61% | 替换账的 v1 天花板：步数 3.84% / token 2.61% |
| 下一步参数里逐字来自上一步回执 | 7.1%（3,267/45,745；842 全绑定 + 2,425 部分） | 分母是 45,745 个可判定的下一步参数；**值传递是少数** |

**口径与方法**：统计脚本 `scripts/session-stats.mjs`（随仓库交付，见 §11），输入 `$DSH_HOME/sessions`，按 `session.v4.jsonl.zstd` 的**文件大小取前 300**。因此这些是**最长/最贵**的会话，长会话占比偏高，G1 必须按**会话长度分层**报告，不能直接外推到全体。tool-share 按回执字符数归因，分母是 62,621 次工具调用；step 占比的分母是 54,123 步。回执占比为 300 会话口径；前 20 大会话为 bash 60.3 / read 5.0 / ssh 17.9，本稿不采用那一口径。"7.1%"的分母是 **45,745 个可判定的下一步参数位置**（3,267 / 45,745 = 7.14%），是**逐字 span 覆盖率**，也是值传递的**下界**——提取/转换型传递（取字段、改格式）不计入；它既不是步数，也不是调用数。

**§2 全部统计按 `session-snapshot.json` 复算**；按文件大小取前 300 每次跑会漂（二次复算 p50/p90/p99 为 646/4,619/18,057，与文中 648/4,635/18,186 差 <1%，属漂移）。

**替换账有两个天花板，不能只报一个**：白名单全覆盖步 2,080 / 54,123 = 3.84%；这些 step 的 token 占 2.61%（白名单步均 132,170 token，全局步均 194,312）——**token 份额才是替换账可用的上限**，因为它已经按实际 token 体量扣掉了"白名单步更便宜"这个偏差。

两条直接结论：

- **token 数口径下最大的杠杆是"少一次回放"**：跳过一步省的是**该步请求的 `totalTokens`**（含 cacheRead；每请求均值 194,473、中位 185,590）；每缩小上下文 X token，后续每一步都省 X。投影不再只盯 read——bash 63.0% + ssh 9.1% 合计 72.1% 的回执体量，v1 必须给它们投影参数（§5.3）。
- **值传递（把上一步输出喂给下一步的参数）只覆盖 7.1% 的可判定下一步参数位置**。所以"Jev 给'结果能否作为下一工具输入'打分"这个设计只作用在少数路径上，不能作为核心。

### 2.2 一手来源（摘要，详见研究文件）

| 结论 | 对我们 |
|---|---|
| 缓存读按 1 token 计（本稿不打折、不算钱），匹配是精确前缀，任何早于断点的改动会让后缀全部失效 | 追加式、到达即定形，是硬约束 |
| 在固定 95%-of-GPT-4 质量目标下，MT Bench / MMLU / GSM8K 分别报告 85% / 45% / 35% 的成本削减；路由器出分布后接近随机 | 全局单阈值不成立，必须按工具族校准 |
| 字面 span 校验证明"字符串确实出现过"，不证明"选对了"；span 抽取最好约 53.6 F1 | 出处校验只能当**伪造过滤器**，不能当正确性证明 |
| LLM 压缩器在短任务上让 token **增加 24–94%**；确定性遮蔽省 8.6% 且完成率 100% | 蒸馏必须先过后验门，且确定性裁剪优先于模型蒸馏 |
| 乐观执行（先执行再校验）在 ReWOO/LLMCompiler 上不掉成功率，但它们的校验是强模型判定或沙箱状态校验 | 第一版只对**效果可检查**的动作放行 |

## 3. 目标 / 非目标 / 反目标

**目标**

- G1：在真实会话上，provider 记账的 `totalTokens`（= uncached input + cacheRead + cacheWrite + output）相对基线下降。**全部按 raw token 计：cacheRead 也按 1 token 计，不打折、不算钱、不乘任何价格权重。** G1 拆成**两本账**，分别报告、不合并成一个乘法：
  - **替换账**（跳过调用）：跳过一步省的是**该步请求的 `totalTokens`（含 cacheRead）**。天花板两个数并列：步数份额 3.84%、token 份额 **2.61%**（白名单步均 132,170 token vs 全局步均 194,312）；经验换算率 0.68——20% 的步 ≈ 13.6% 的 token（实测），不能把步数份额直接当 token 份额。
  - **投影账**（缩小进入上下文的内容）：`被裁 token × (1 + 剩余步数)`，不乘价格、不乘权重，参数取 §5.3 默认值。**v1 只能给区间，不能给单点**：
    - **上界 10.0%**：假设被裁的 4,655,038 token（2,543 条回执）在其后 166 步里**全程存活**——没有 compaction、没有 pruner 剪裁、没有模型重读。按 167 次回放 = 777,391,346 token，占 300 会话总 `totalTokens`（10,516,734,596）的 7.39%；加替换账 2.61%，合计 10.0%。
    - **下界 3.5%**：投影按 horizon 20 的保守口径，只回放 21 次 = 97,755,798 token（占 0.93%）；加替换账 2.61% 得 3.54%，向下取整为 3.5%。
    - **影子期实测决定落在区间哪一点**：上下界之间就是 compaction、pruner 剪裁与模型重读造成的损耗；实测只用于收窄区间，不把 10% 改成硬承诺。
  - **v1 验收：≥3.5% 保底、目标 10%**。3.5% 是保底线，10% 是全程存活的理想上界；不是"必须 10%"的硬承诺。发布决定仍按下面的 ②。
  - 两账合计 **≥20% 是总目标**（含二期蒸馏），不是 v1 验收线。影子期结束时用实测值修正总目标的可达性判断。
- G2：每一次"没问主模型"的决定都可审计（收据：计划、守卫、绑定、回执、节省量）。
- G3：默认不改变 agent 行为；干预必须显式开启，且只对只读动作（实现见 §5.5）。

**实测低于预期怎么办（三选一，已选 ②，写死）**：即使影子期实测两账合计只有 5%，v1 也按正常版本发布。理由：默认 `selected+[]`（什么都不开）、每次请求固定开销 ≤800 token、任何失败即回退主模型，用户零风险。实测值只用于修正本文的预期数字，不用于决定发不发。（未选：① 合计 <5% 降级为 experimental、默认 off；③ 推迟发布决定到影子期之后。）

**非目标**

- N1：不做 PTC/`run_code` 批量执行（第二期）。一期杠杆在回放裁剪——每步 1 个工具占 80.0%（§2.1），批量步不是主体；二期按影子期收据里批量步的真实占比再决策。
- N2：不做模型训练或权重改动。
- N3：不替换 DSH 的压缩、剪裁、spill 等既有机制，也不接管它们的决策：投影只改模型可见的 `content`，原文借宿主 `spillStore` 存放（§5.4），不另建一套 spill 服务。
- N4：不追求论文里 87.93% 的数字——那是整套配置（含上下文管理与收尾规则）之和，核心机制消融只占 20–27%。
- N5：v1 不处理工具调用本身的去重/合并：原始需求里的"精简冗余工具调用"因此只覆盖一半（回放裁剪这一半），去重/合并留二期——用影子期记录的调用序列统计重复率再定。

**澄清边界**：需求澄清永远在主模型回合内完成，不进入委派/跳过路径，因此澄清轮永不被替换。

**反目标（做到了也算失败）**

- A1：成功率下降超过 1 个百分点。**v1 不可判**（见 §6.1）：只读放行面小、20 任务门分辨率不足，v1 不声称守卫了 1pp。
- A2：token 数降了但**缓存被破坏**——用可观测代理判定：**cache-miss token 的变化**（同类请求上，miss 占比不升）。
- A3：出现无法归因的静默错误执行（守卫放行但参数是错的）。
- A4：给每次请求注入的协议说明本身吃掉了收益（短会话倒亏）。

## 4. 方案与取舍

考虑过三条路线：

| 路线 | 做法 | 取舍 | 结论 |
|---|---|---|---|
| A 影子优先 | 门照常做决定，但仍问主模型，只记账；一周后按真实数据决定是否开启 | 零质量风险、能拿到免费标签；一周内无收益 | **采用** |
| B 直接干预 | 照搬 HarnessMM 插件，日常任务直接开，不区分只读/写 | 立刻见效；守卫写错会让 agent 走错路，且样本少难归因 | 二期（不限只读、不等影子的全量直接开） |
| C 先建基准 | 20 个固定任务双跑 | 数字最硬；半天到一天搭环境，且不反映真实长会话 | 二期，作为回归门 |

被否掉的方案：让 Jev 决定"下一步调哪个工具"（没有候选集时它就退化成第二个主模型，成本回到原点）；让 Jev 给"结果能否作为下一输入"打全局分（值传递只占 7.1%，且阈值不可迁移）。

## 5. 架构

```
主模型 ──计划(候选+投影+守卫)──▶ 控制器
                                  │
   工具回执 ──▶ tools/post-execute ─┤
                                  ├─ 1 绑定(确定性) ── 失败→回退主模型
                                  ├─ 2 守卫(确定性) ── 失败→回退主模型
                                  ├─ 3 多候选? ──是──▶ Jev(单标签) ── ?→回退
                                  ├─ 4 准入(记账) ── 不划算→回退
                                  └─ 5 派发 → llm/stream 合成工具回合
                                              → tools/execute 原样执行
                                              → 收据(证书+节省量)
```

回执到达后的真实次序是 `canonicalise → 绑定/守卫（读原文）→ 投影（改模型可见 content）→ 进历史`（§5.4-5）；图中的 1–5 是**替换决策**链，投影不在其中。

挂载点（来源标注：`tools/execute`、`llm/stream`、`systemPrompt` 与参照插件一致、已验证可用；`tools/post-execute` 是**宿主原生钩子**，参照插件未使用，投影必须用它）：

| 挂载点 | 类型 | 用途 |
|---|---|---|
| `tools/post-execute` | 原生钩子（`ctx.on`） | 回执到达后做绑定/守卫评估与投影；**到达即定形**，此后不再改历史（见 §5.4） |
| `tools/execute` | 原生钩子 | 校验被替换的调用没有被篡改（解析后的实参必须逐字等于解析后的候选） |
| `llm/stream` | 原生钩子 | 用合成的 assistant 回合代替一次主模型调用 |
| `ctx.systemPrompt.section({ name, order, text, interpolate: false })` | **服务，不是钩子** | 计划协议段**常驻且内容稳定**，中途不翻转（见 D4） |

**两处写错会静默失效**：

1. `systemPrompt` 没有 `ctx.on('systemPrompt')` 事件——照"钩子"写法注册既不触发也不报错。必须走 `ctx.systemPrompt.section(...)`（插件以 `inject: ['systemPrompt']` 声明依赖，见 §11）。
2. section 的 `name` 必须唯一（重复注册直接抛错）；`order` 必须是**固定有限数**（按升序拼接，同 order 按名字的 code-unit 序）；`interpolate` 必须显式 `false`——否则 `{{...}}` 会被渲染期替换，协议段的字面量就不再稳定。

### 5.1 三层权限

| 层 | 有权 | 无权 | 输入 |
|---|---|---|---|
| 主模型 | 改计划、改目标、判完成、不可逆操作 | — | 投影后历史 + 原文句柄 |
| Jev | 在已声明候选里选一个，或放弃 | 造参数、加步骤 | 候选清单 + 回执投影 |
| 快速模型（二期） | 从单条回执提取、压缩、回答定点问题 | 做决定、丢证据 | 单条回执（有界）+ 问题 + 最小 schema |

**术语**：Jev = 选择器 = 快速模型在"多候选里选一个"；蒸馏 = 快速模型"压缩单条回执"（二期）。全文统一按这个用。

**Jev 的自调用怎么认**：Jev 自己的每次调用也走 `ctx.llm`，落进同一个 `llm/stream` waterfall，而该钩子的 options 里**没有 agent**（只有可选的 `sessionId`），所以必须显式标记。约定：Jev 的内部调用一律带 `purpose: 'boost-selector'`（`GenerateOptions.purpose`，经 `LlmRequestPurposeMap` 声明合并注册；`GenerateOptions` 没有 `metadata` 字段，不要用它），或走专用 route。`llm/stream` 的**第一条规则**是"见到该标记 → 直接 `next()` 放行，不合成回合、不记账"。没有这条规则，内部调用会被当成边界请求，形成递归合成。

**`purpose` 的风险**：参照实现**刻意不发** `purpose` / `temperature`——provider adapter 拒绝任一可选字段会让整次选择调用报废。因此 `purpose` 必须经 `LlmRequestPurposeMap` 注册，并验证 thinking-only 网关不拒；被拒则回退到专用 route。

**v1 不含快速模型蒸馏**：上表与 §5.3 杠杆表都标二期。理由：研究结论是 LLM 压缩器在短任务上让 token 增加 24–94%，而确定性遮蔽省 8.6%。

### 5.2 七条硬约束

1. **追加式**：回执到达时决定其形态，进了历史就不再改；要原文时追加"展开"。任何回改都会让后缀缓存失效。
2. **确定性优先**：能用投影/正则/JSON pointer 解决的，不用模型。模型只在非结构化文本上有价值。
3. **失败即回退**：绑定不清、守卫不真、schema 不符、账算不过来，一律回退主模型，不做"猜一下"。
4. **按工具族校准**：阈值与准入参数按工具族分别维护，不用全局标量。
5. **替换白名单只到只读三件套**：v1 允许**替换**的工具只有 `read`、`grep`、`glob`。三层口径分开：
   - **投影覆盖已配置的工具族**：v1 覆盖 `read`、`grep`、`glob`、`bash`、`ssh`；其余未配置族**一律不投影**（每个族都要显式给参数，缺省不是"裁剪"而是"不裁剪"）；
   - **替换只对白名单生效**：只有这三个工具能被跳过主模型；
   - **替换的影子对全部工具记录**：影子期替换不设白名单，全量记账（投影仍只覆盖已配置族）。

   `bash` 移出替换白名单：`sandbox_permissions` 只能升不能降，"查询类 bash"没有可执行判定，派发层收窄不了；bash 的只读化等 read-only sandbox 验收通过后再开。`web_fetch` 同样移出：网络非确定性，现有 guard 字段对它没有定义。写操作一律不放行：本 profile 没有文件级快照，`edit` 到已存在文件在 git 之外无法回滚，"可回滚写"这个前提不成立。代价是收益变小，换来的是"错放行不会造成不可逆后果"。
6. **每个 turn 有替换步数上限**（默认 8 步）。达到上限即"图耗尽"：回主模型，收据记 `steps-exhausted`。
7. **"追加式"只约束插件自身**：插件不改写历史；宿主有两类外部失效源：
   - **compaction**：把老区间替换成摘要，且从首个被替换 token 起缓存失效。压缩后计划锚点丢失 → 回主模型、清空 pending、收据记 `compaction-reset`。
   - **tool-result-pruner**：本 profile 已启用 `dsh-compaction-tool-result-pruner`（`thresholdChars: 8192` / `head: 4096` / `tail: 1024`）。它把超限回执**原位**换成 head + marker + tail，且**保留锚点**——所以 pruner 造成的压缩不会触发 `compaction-reset`，而它恰恰是最常见的压缩结果。锚点还在但正文已变，模板/绑定必须判失效，收据记 `pruned-reset`。

   **模板分辨率只用到达时缓存的规范化原文**：缓存随 turn 结束失效，取不到即回主模型。**不能读历史当前正文**重解析——`text_contains` 会假阳性命中已被剪掉的段（历史里只剩 head+tail），把"原文里有"误判成"现在还能校验"。

§5.2-3 的失败路径展开：

| 失败 | 判定 | 动作 | 收据字段 |
|---|---|---|---|
| Jev 超时 / 异常 | 单次选择超过 20s（默认上限）或调用抛错 | abstain，回主模型 | `selector-abstain` / `selector-error` |
| 收据写失败 | 落盘 append 抛错 | 内存缓冲；连续 **3 次** append 抛错即停止替换（fail-closed） | `receipt-write-failed` |
| 派发被拒（参数不符） | `tools/execute` 解析后实参 ≠ 解析后候选 | 该步不执行替换，下一步回主模型 | `dispatch-rejected` |
| 守卫平凡 | 候选只有 `ok: true`，没有一个非平凡 guard | 判不合格，回退主模型 | `guard-trivial` |
| scope 读 / 解析失败 | 文件缺失、JSON 坏、未知 version | 落到 `selected+[]`；`boost status` 暴露 degraded note | `scope-degraded` |
| 宿主 compaction 后锚点丢失 | 计划引用的历史区间已被摘要替换 | 回主模型、清空 pending | `compaction-reset` |
| 宿主 pruner 原位改写回执 | 计划引用的回执被换成 head + marker + tail（锚点仍在） | 回主模型、清空 pending | `pruned-reset` |

**v1 guard 词表**：非 shell 工具没有 `exit_code` / `stderr`，照搬参照实现的 `GUARD_FIELDS`（`ok` / `exit_code` / `stdout_contains` / `stdout_equals` / `stderr_empty` / `json_equals`）会退化成空操作。v1 只收：

| guard | 语义 | 备注 |
|---|---|---|
| `ok` | 回执未标错（`isError` 为假） | **平凡**，单独使用不算 guard |
| `text_contains` | 规范化文本含给定子串，区分大小写 | 子串由图上的确定性抽取给出，不接受模型现编 |
| `text_not_contains` | 规范化文本不含给定子串 | 用于排除错误页脚、堆栈、`[exit code: N]` |
| `json_equals` | 整段文本是 JSON 时，按 JSON pointer 取值等于给定标量 | 解析失败即 guard 不成立（不是抛错） |

- **禁用** `exit_code`、`stderr_empty`：v1 的替换白名单只有 `read`/`grep`/`glob`，非 shell 回执的 `exit_code` 是 `null` → `exit_code_unknown`（恒拒），恒真的是 `stderr_empty`。一个恒拒、一个恒真，两者都不可用。
- **每个候选至少一个非平凡 guard**：只有 `ok: true` 的候选判不合格（`guard-trivial`）。
- guard 一律读**原始规范化回执**（§5.4-5），不读投影后的文本。

**`$public` 文本抽取语法（规范）**：模板值形如 `{ "$public": { "after": "root" | "A"…"P", "field": "<identifier>" | "$scalar" | "$single" } }`，从指定回执的文本里取**唯一**匹配：

| `field` 取值 | 语法 | 失败条件 |
|---|---|---|
| `name`（任意标识符示例） | 文本中 `name:` 或 `name=` 右侧的带引号字符串 | 重复匹配、右侧非字符串、无匹配 → 判歧义 |
| `"$scalar"` | 整段 trim 后匹配 `^[A-Za-z0-9_+@.:/-]+$` | 含空格或其它字符 |
| `"$single"` | 整段形如 `['value']` 的单元素字符串数组 | 多元素、非字符串、带尾随内容 |

- `field` 是**任意标识符**（如 `name`、`path`）或两个保留值 `$scalar` / `$single`；标识符在文本中的形态是 `name:` 或 `name=`，`name` 只是示例，不是保留字。
- `after`：`root` = 本步回执；`A`…`P` = 图上第 N 步的回执（必须在本步之前；字母不在图里即判不可解析）。引用的回执必须**成功且只有单个 text block**，否则模板不可解析。
- 只取**字面量**：不做求值、不做正则替换、不做字段拼接。模板参数**先解析再比对**（D5）。
- 抽取不到或有多解，一律回退主模型，不做"猜一个"。

### 5.3 准入（用记账，不用自评分）

两本账的算法不一样，不能写进同一个乘法：

| 杠杆 | 省下 | 是否乘剩余步数 |
|---|---|---|
| 跳过一次调用 | 该步请求的 `totalTokens`（含 cacheRead）；多候选时再**减去 Jev 的输入+输出上界**（512 token） | **否**，只作用于该步请求 |
| 缩小进入上下文的内容 | 被裁 token ×（1 + 剩余步数） | 是 |
| 模型蒸馏（二期） | 上式再减去：蒸馏调用的输入 + 输出 | 是，但要先减开销 |

**替换**被允许，当且仅当**替换杠杆**的省下 > 该杠杆的新增开销 + 阈值（阈值按工具族分别维护）；蒸馏（二期）要先减开销，再过后验门。

- **v1 不做货币计价**，只用 token 数做准入。`ctx.tokenMeter` 是计数/压力估算器，没有货币价格，不能拿来复算金额。若要费用护栏，由插件配置显式维护 per-route 费率（**可选，默认关闭，不参与验收**）。
- **剩余步数（两种口径，不许混）**：**报告 / 离线复算**用该回执之后的**实际剩余请求数**（§3 的 166 步即此口径，回放 167 次）；**运行期准入**用固定 horizon（默认 20 步）与会话历史均值二者取小做保守下界，不会高估收益。**会话历史均值 = 本会话最近 5 个 turn 的步数均值**，不足 5 个 turn 时直接用 horizon 20。
- **投影按确定性策略执行，不参与准入判断，不产生逐次决策**（按工具族 + 字符阈值）；收益决策只发生在"是否替换"这一步。
- **宿主 compaction 之后的步骤重新按未缓存前缀计**：压缩会把老区间换成摘要，从首个被替换 token 起整段前缀重算；投影账的"剩余步数"也按压缩后的上下文重新起算。

**投影参数（per-family，v1 全部五族：`read` / `grep` / `glob` / `bash` / `ssh`；表中 `grep`/`glob` 合并一行）**：

| 工具族 | 触发阈值（字符） | 窗口（头 + 尾） | 净收益 > 0 的最小长度 | 说明 |
|---|---|---|---|---|
| `read` | 3,000 | 2,000 + 500 | 2,610 | 超过阈值才裁剪 |
| `grep` / `glob` | 700 | 400 + 100 | 610 | 同上 |
| `bash` | 4,000 | 2,000 + 500 | 2,610 | 同上 |
| `ssh`（`mcp__ssh__execute-command`） | 2,000 | 1,200 + 300 | 1,610 | 同上 |

- **净收益 > 0 的最小长度 = 头 + 尾 + 页脚（约 110B，按 ASCII 保守计）**；低于它的回执裁了反而更贵。
- **不变量：触发阈值 ≥ 窗口 + 页脚 + 头行 + 1**（头行 `[output N chars; showing first A and last B]` 加两个换行约 55–60 字符；漏掉它会让「投影后反而变长」在触发阈值附近发生——grep/glob 的 700 只有约 7 字符余量。**装配完页脚后必须复核 `assembled.length < original.length`，否则回退原文**）。表中四项都满足：3,000 ≥ 2,611、700 ≥ 611、4,000 ≥ 2,611、2,000 ≥ 1,611。窗口不得大于等于触发阈值，否则会出现"触发了却裁不动"的净亏区间（旧 read 参数 2,000 触发 / 2,500 窗口时，(2,000, 2,500] 区间内就有 200 条回执净亏）。
- **其余未配置族一律不投影**：没有窗口参数的工具（含 `web_fetch`、`edit`、未来新增工具）直接原样进历史，不设"默认裁剪"。

**其余默认值**：

| 参数 | 默认值 | 作用域 |
|---|---|---|
| 准入阈值 | 1,024 token | 每个候选；**确定性单候选豁免**（`deterministic && 唯一候选`，对齐参照的 `admitted_deterministic`） |
| Jev 输入+输出上界 | 512（见准入表） | 多候选时从节省里扣 |
| 替换步数上限 | 8 步 / turn | §5.2-6 |
| 剩余步数 horizon | 20 | 算不出历史均值时 |
| 会话历史均值 | 本会话最近 5 个 turn 的步数均值；不足 5 个 turn 用 20 | 与 horizon 取小 |
| 收据连续写失败阈值 | **连续 3 次 append 抛错** | 达到即停止替换（fail-closed） |

**配置键名（`cordis.patch.yml` 的 `config`，缺键 = 对应默认值）**：

```yaml
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

§11 的 patch 是**整体替换**，所以装配层必须对每个缺键逐键回落默认值；上面列出的就是该 profile 的完整配置面。没有列出的工具族 = 不投影。

**收据字段（两组，都只记 raw token）**：

替换账：

| 字段 | 定义 | 缺失时 |
|---|---|---|
| `saved_input_tokens` | 发生替换时，**后一次请求的 `(input + cacheRead)`**（取后端点，不做插值） | 该步或后一次请求任一缺失记 `unknown`，**不计入**合计 |
| `cache_hit_delta` | 后一请求与前一次的 `cacheRead / (input + cacheRead)` 之差（正数 = 命中率上升） | 记 `null` |

投影账：

| 字段 | 定义 |
|---|---|
| `projected_tokens_before` | 投影前规范化原文的 token 估计（`estimateContent`） |
| `projected_tokens_after` | 投影后可见 content（窗口 + 页脚）的 token 估计 |
| `saved_projection_tokens` | `before − after`，**毛节省** |
| `projection_unit` | 固定 `'raw'` |
| `projection_retrievals` | 模型对该 spill locator 路径的 `read`/`grep` 次数 |
| `projection_net_tokens` | `saved_projection_tokens − Σ(取回调用 token + 取回内容 × 剩余步数)`；**投影账只报净额** |

投影账报**净额** = 毛节省 − 取回调用及其回放；`projection_retrievals` 与净额都进 `boost status`。

### 5.4 回执投影的可见性契约

裁剪发生在**回执到达、进入历史之前**，且必须自带"裁掉了什么、怎么取回"：

```
[output 18,432 chars; showing first 2,000 and last 500]

(Omitted 15932 bytes. Full formatted result stored at: <path>. Use read with offset/limit, or grep this path to search within it.)
```

**单位**：本例如纯 ASCII，故字符差 = 字节差（18,432 − 2,500 = 15,932）。一般地，被省略字节 = `byteLength(全文) − byteLength(head) − byteLength(tail)`，不能拿字符数直接当字节数。`describeOmitted` 的 `count` 是**被省略的字节数**，不是全文总字节，且无千位分隔符。

**原文由本插件自己存，页脚也由本插件生成**（仅 `projection: 'on'`）：投影前先 `ctx.get('spillStore').saveText({ owner, source, suggestedName, content: 规范化原文 })` 落盘，再用 `formatSpillNotice({ kind: 'exact', count: <被省略的字节数> }, ref)`（`@deepseek-ai/dsh-spill-policy/notice` 导出）生成页脚。`formatSpillNotice` 必须 `await import(...)` 包 try/catch——静态 import 在宿主没装该包时是 `ERR_MODULE_NOT_FOUND`，降级路径根本不可达。因此：

- **不依赖**与 `dsh-spill-policy` 的注册次序。准确说法是：**投影只替换模型可见的 `content`，原文由本插件存入 spill 后端，页脚由本插件生成**——任何一边先跑都不影响正确性。
- `read` 走同一条路径。`dsh-spill-policy` 在 `tools/post-execute` 里对 `exec.name === 'read'` **直接跳过**（源码如此），不能指望它兜底；而 read 正是 v1 白名单之首。
- 页脚格式必须复用宿主的 `formatSpillNotice`，不要手拼 `Full formatted result stored at:` 字符串。
- `owner` 取 `exec.agent.session.header.id`：先判 `exec.agent` 是否为 `undefined`；为 `undefined` 时不投影（PTC 子派发等场景）。`Agent.session` 与 `Session.header` 都是非可选字段，不要再套可选的冗余链。缺 session id 时同样不投影（`projection-skipped:no-owner`）。
- 顺序无关的代价是**多一次落盘**：只对确实要投影的回执落盘，未触发阈值的不落。
- **大回执直接不投影**：`Buffer.byteLength(text, 'utf8') > 256 * 1024` 跳过（**按 UTF-8 字节计，不按 `text.length` 的 UTF-16 单元**——同一段 CJK 的字节数是单元数的 3 倍，用错口径会让上限浮动 2–4 倍）。先比 `text.length` 做粗筛（它是 code point 数的上界），只有确定要裁时才 `Array.from` 转 code point 数组（实测 1 MB 字符串做这一步 17.7 ms、约 9 MB 堆）。
- **`projection: 'shadow'` 不依赖 `spillStore`**：影子模式不改 content、不调 `saveText`、不落盘，只用 `estimateContent`（从 `@deepseek-ai/dsh-token-meter/estimate` **动态导入**，包 try/catch）对原/裁剪文本做对比记账；`projection-skipped:no-spill` 只在 `projection: 'on'` 且确实要落盘时触发。否则宿主没装 spill 包时影子期拿不到账。

可见性三条：

1. **不许静默裁剪**：页脚必须写明省略量与取回路径。
2. **取回是追加**：模型用一次新的 `read`/`grep` 去取，不改写历史。
3. **缺 spill 后端就不投影**：`projection: 'on'` 且要落盘时，`spillStore` 缺失 → 超限回执**原样进入历史**（保住证据），记 `projection-skipped:no-spill`，`boost status` 标 degraded（`ERR_HOST_NO_SPILL`）。不允许"投影了但没有取回路径"。**shadow 不受此限**（见上）。

示例的 18,432 字符 ≈ 4,608 token，低于本部署的 `maxInlineTokens: 12500`（`dsh-base/cordis.patch.yml` 的 `spill-policy.config.maxInlineTokens`；宿主包无内置默认，省略即禁用），**宿主 spill 根本不会介入**——这正是本插件必须自己存原文的原因。反过来，也不能假设"超限了总有人兜底"。

契约化四条：

4. **不可裁剪清单**：错误信号、退出码、状态标记（`is_error` / `exit_code` / `[exit code: N]`）、页脚本身永久保留；裁剪只能作用于正文。
5. **顺序固定**：`canonicalise → 绑定/守卫 → 投影 → 进历史`。绑定与守卫一律读**原始规范化回执**（canonicalise 后的完整文本），投影只改"模型可见的 content"；Jev 与准入读投影后的文本。
6. **投影不新增回放段**：canonicalise 在投影之前、进入历史之前完成，因此不违反追加式；投影后的回执**保持 `tool` 角色、原位替换**，不新增 assistant 段。
7. **两种计量单位不许混写**：投影的长度按 **Unicode code point**（`Array.from(text).length`）计，切点不得切开代理对（surrogate pair）；spill 页脚的省略量按 **UTF-8 字节**（`formatSpillNotice` 的 `count` 是 bytes，且 `describeOmitted` 不加千位分隔符）计。示例里 "18,432 chars" 与 "15932 bytes" 是两个单位；本例纯 ASCII 只是恰好相等，不是笔误。

**与宿主 spill 的关系**：已被 spill 处理过的回执（用 `hasSpillNotice(text)` 判定，从 `@deepseek-ai/dsh-spill-policy/notice` **动态导入**（同样包 try/catch），**不匹配字符串常量**）不再二次投影，也不再重复落盘。**"投影后仍超限交给 spill"这条路径不存在**：要么本插件已把原文存好（页脚含 locator），要么根本不投影。

这条契约是"追加式"成立的前提。模型没看过全文时，必须能凭页脚知道该去取；否则它不是省 token，是丢证据。

### 5.5 暴露面：全局 / 指定工作区

插件不是装上就对所有工作区生效。暴露面直接用宿主原生的步骤级条件，不自造谓词：

```ts
ctx.tools.register({ name, description, parameters, execute }, { when })
```

- `when(context: { agent, signal })` 由宿主**每个模型步骤**判定一次；判 false 的工具既不出现在声明里，也不能被派发。
- 用 **`tools.resolve()` 是否存在**探测宿主是否支持步骤级 `when`；不支持时整族不注册并给出稳定原因码 `ERR_HOST_NO_STEP_WHEN`，**不得静默放行**。
- 关键性质：**没有层要装卸、没有 agent 生命周期要跟、没有重查定时器**——配置一改、新 agent 一出现，下一步就生效。
- 判定本身是**同步读取 `judgement ?? resolveNow(agent)` 并 fail-closed**；异步的 realpath 判定只用于改善结果，不得让判定等待。

scope 文档（`version: 2`）：

```ts
{
  version: 2, revision: 0, updatedAt?: string,
  mode: 'selected' | 'global', workspaceIds: string[],
  shadow: boolean,                          // boost shadow on|off 的持久化
  projection: 'off' | 'shadow' | 'on',      // 投影三态
}
```

- `shadow` 为真时门只记账、不替换；`projection` 决定投影形态：`off` 不投影，`shadow` **只记投影前后 token、不改模型可见 content**，`on` 才真正替换。影子期默认 `projection: 'shadow'`——影子期要观测的正是投影的收益，但此时还不能改模型看到的东西。
- `projection: 'shadow'` **不落盘、不依赖 `spillStore`**（§5.4），否则"没装 spill 包"会让影子期拿不到账。
- `boost status` 必须输出 `shadow` 与 `projection` 两个值，否则"开了影子/投影"无法核实。

四条规则，逐条照抄其语义：

1. **默认谁都不给**：`selected + []`。首次运行、读不到、解析失败，全部落到这一侧。
2. **严格序 / 约束强度递减**：`selected+[]`、`selected+[W]`、`global` 的约束强度依次递减（左侧最严）；任何"读不了 / 判不了"都落到更严的一侧，绝不静默放宽。
3. **未知 version 只读降级**：不覆盖、不重写，单独给一条 note 和稳定的拒绝码。version 1 的旧文件按"未知 version"处理，`boost scope set` 时才显式升级到 2。
4. **`scope.json` 是持久事实来源，内存只是已校验缓存**：每个 step 用 **mtime + revision** 校验缓存，不一致就重读；读失败/解析失败落 `selected+[]`。写路径 validate → prune → revision+1 → 写盘 → 换引用：**锁内临界区不再 await（同步写盘）**，`open(..., 'wx')` 只在锁获取阶段 await 一次。

存储：`$DSH_HOME/boost/scope.json`，与收据同目录。

**写锁（TOCTOU）**：无锁 read-modify-write 会丢更新。用 `$DSH_HOME/boost/scope.lock`（`open(..., 'wx')` 创建，已存在即 `ERR_SCOPE_LOCKED`）包住 read-verify-write，写完删除。锁文件内容写 `{pid, startedAt}`；**回收条件是 `mtime > 60s` 且 pid 不存活**（只超时不回收，避免误删活进程的锁）。不做"单进程假设"：`boost` 工具调用与宿主进程可能同时写。**锁只保护写路径**；step 级读取不加锁，只做 mtime + revision 校验（规则 4）。

workspace 归属由 agent 的 cwd 映射到 workspace id。每个挂载点各有自己的 agent 解析路径，拿不到就按不可见处理：

| 挂载点 | agent 来源 | 拿不到时（fail-closed） | 放行/跳过时的记账 |
|---|---|---|---|
| `tools/*` 钩子 | `exec.agent` | 判为不可见 | 收据 `skip:no-scope` |
| `llm/stream` | 只有可选的 `sessionId`，需经会话表解析 | 原样 `next()` 放行 | 收据 `skip:no-scope`（不合成、不记账为节省） |
| `systemPrompt` | `AssembleContext.scope`（**可选**字段） | 不注入该段 | 只累加 `skip:no-scope` 计数，不逐条写收据 |

**fail-closed 的定义（写死）**：指"**原样放行、不做替换、不注入该段**"，**绝不**指"拦截请求"。对 `tools/*` 而言"判为不可见"是更强的同向处理：连工具声明都不出现，仍然不是拦截。每次 fail-closed 都记一条 `skip:no-scope` 收据（`systemPrompt` 每次装配都会判定，只累计数），并在 `boost status` 暴露，防止静默失效。

**`systemPrompt` 无 scope 的语义**：`AssembleContext.scope` 是可选字段；**无 scope = 全局视图 = 按 `selected+[]` 处理 = 不注入**。这条同样覆盖 `boost` 工具自身的协议段：`boost` 工具的**可见性**豁免 scope（见下），但它的协议段不豁免。

**唯一例外**：`boost` 工具本身**豁免 scope**（只读写本地配置文件、无外部副作用）；否则 `selected+[]` 之下用户没有启用入口。见 §11。

**单一事实来源**：scope 只在 `scope.json`；patch config 不含 scope 字段。`boost scope set` 带 base revision 校验，冲突返回下面的稳定码——**不是 HTTP 409**：工具失败没有状态码，"409" 只是 revision 冲突的语义类比。

**拒绝码（枚举）**：`ERR_SCOPE_UNKNOWN_VERSION` / `ERR_SCOPE_FUTURE_VERSION` / `ERR_SCOPE_PARSE_FAILED` / `ERR_SCOPE_READ_FAILED` / `ERR_SCOPE_REVISION_CONFLICT` / `ERR_SCOPE_LOCKED`。

`ERR_SCOPE_UNKNOWN_VERSION` 只用于 **v1**（可升级）与缺失/非数值 version；`ERR_SCOPE_FUTURE_VERSION` 用于**数值 version > 2**，此时文件只读、任何写操作都必须拒绝——否则一个更新版本的插件写的文档会被旧插件按 v1 升级路径重写成 v2，静默丢掉它不认识的字段与工作区列表。（T9 最初只区分「可读 / 不可读」，CAS 也不保护这种情形，因为降级读出的 revision 是 0。）

**两条错误通道不许混**：

| `boost` 工具失败码（`ToolErrorInfo.code`） | 判定路径的收据字段 | 触发 |
|---|---|---|
| `ERR_SCOPE_UNKNOWN_VERSION` | `scope-degraded` | `scope.json` 的 version 是 v1、缺失或非数值（v1 可升级） |
| `ERR_SCOPE_FUTURE_VERSION` | `scope-degraded` | `scope.json` 的 version 是数值且 > 2；只读，写操作一律拒绝 |
| `ERR_SCOPE_PARSE_FAILED` | `scope-degraded` | JSON 坏 |
| `ERR_SCOPE_READ_FAILED` | `scope-degraded` | 文件缺失 / 无权限 |
| `ERR_SCOPE_REVISION_CONFLICT` | 不写收据，工具直接失败 | base revision 不匹配 |
| `ERR_SCOPE_LOCKED` | 不写收据，工具直接失败 | 另一 writer 持有 `scope.lock` |

- `ERR_SCOPE_*` 是**工具失败**：走 `PostToolDecision.kind = 'block'`（`feedback` + `info.code`），模型能看到反馈。
- `scope-degraded` 是**判定路径的收据字段**：不发往模型，只进收据与 `boost status`。
- 两张表不互相替代：前者是"工具调用失败"，后者是"这一步判定降级后照常回主模型"。

## 6. 度量与验证

**主口径**：provider 记账的 `totalTokens` / **会话**（per-session；需要更细时按 per-turn 报），= uncached input + cacheRead + cacheWrite + output。四个字段是**互斥计数**：`inputTokens` 只含未缓存输入、不含 `cacheReadTokens`，所以不能拿 input+output 当总量。
**"任务"的定义**：若沿用"任务"一词，**task = 一个 turn**；收据记 `sessionId` + `turn`，不再用没有定义的"任务"当分母。
**次口径**：cache-miss token、费用（可选护栏，**不参与验收**）、首 token 延迟。
**收据三类**：分别记 `uncached` / `cacheRead` / `output`，不糊成单一 input 字段。
**护栏**：完成判定（per-session；需要时按 turn 拆）的成功率、回退率、收据里"放行后被主模型推翻"的比例。

**"被推翻"的定义**（护栏与抽样复核都用这一条）：下一步对**同一 target** 发起写/删，或对**同一路径**重读且结果不同。只"再看一眼"不算推翻。

阶段：

1. **影子（1 周）**：门做决定但照常问主模型，只写收据；`projection: 'shadow'`（只记投影前后 token，不落盘、不改 content）。产出：真实可省比例、按工具族的命中率、候选集召回、**取回率上界**（见 §6.1 的损害代理）。
2. **只读放行**：只对白名单工具真正跳过调用；`projection: 'on'` **按工具族分批开**——先 `read`，再 `grep`/`glob`，最后 `bash`/`ssh`，每族过一个观察窗再开下一族，不一次性全工具翻 `'on'`。
3. **回归门**：20 个固定任务双跑，只当"没有灾难性回退"的门。固定任务集不构成可复现回放基准，不允许为其加断言式成功率指标。

**两本账的放行依据不同，不能混**：

- **替换**的放行依据是影子期标签（一致率 / 命中率 / 召回）。
- **投影**的放行依据是**可见性契约（§5.4）+ 外部文献（确定性遮蔽省 8.6%、完成率 100%）+ 事后检测**，**不是影子标签**。影子期只记投影前后 token，给不出"模型是否因看不到全文而走错"的标签；因此投影不靠"影子期收益为正"放行，而靠"模型随时能取回原文 + 事后能检出误裁"。

### 6.1 判据怎么裁决

先说清分辨率，再谈指标：

- **20 个任务双跑判定不了 1 个百分点**（分辨率是 5 个点，一次抖动就翻盘）。它的作用只是拦住灾难性回退，不是证明"成功率没降"。
- **影子期产出的是标签，不是任务成败**：门与主模型的一致率、按工具族的命中率、候选集召回率。
- **真实成败只能从回执和后续行为里推断**：被替换的动作是否报错、下一步主模型是否推翻了它、同一处是否被反复改写。

**影子期的损害代理（投影专用）**：离线统计"模型后续 `read`/`grep` 的参数落在**会被裁掉的区间**内"的比例，作为**取回率上界**。它只扫收据、不改任何可见内容，成本接近零；取回率上界 × 投影账毛节省 = 最坏情况净节省的下界。

v1 的裁决组合：

| 层 | 证据 | 能回答 |
|---|---|---|
| 收据 | 每次放行的前后状态 | 有没有静默错误 |
| 抽样复核 | 每天抽 10 条放行记录人工看 | 语义上对不对 |
| 20 任务回归门 | 清单 `test/regression/tasks.jsonl` 双跑；**pass ⇔（两轮都完成且 `isError=false` 的任务数 ≥ 19）∧（每条被投影的回执都能用页脚 locator 取回，且取回字节数 = 页脚 `count` + 保留窗口字节数）** | 有没有灾难性回退；后半句即"无数据丢失"的可执行定义 |
| 会话统计 | 相对 300 会话基线的 token 分布（按会话长度分层） | 省了多少 |
| 固定开销预算 | 计划段 + `boost` 工具 schema 的每请求开销 ≤ 800 token；用 `estimateSystemMessage` / `estimateContent`（`@deepseek-ai/dsh-token-meter/estimate`，**`await import(...)` 包 try/catch**）**在构建时实测**，实测值写进 `boost status` | A4 的固定成本是否失控 |
| 分桶净节省 | 按会话步数分桶：**≤5 / 6–50 / ≥51** 步，分别报净节省率；**短会话桶另用随机抽 300 个会话**（基线 top-300 里 ≤5 步会话为 0 个）；**样本 < 20 个会话的桶不出数** | 裁决 A4：短会话是否被长会话摊薄 |

**A4 是聚合口径**，不是单会话口径：长会话摊薄固定开销，短会话可能倒亏。所以 A4 用上面的分桶行裁决，不看总体平均。top-300 基线里没有 ≤5 步会话，必须换随机样本才能填满短会话桶；随机样本只用于 A4，不替换 G1 的 top-300 基线。

### 6.2 测试策略

- **确定性组件**（绑定、守卫、准入记账、scope 严格序、拒绝码）：**表驱动单元测试**，一个输入表一组断言，不 mock 模型。
- **挂钩交互**（合成回合、派发防篡改、失败回退）：**假宿主集成测试**，参照仓库已有的 controller + fake-host 两套可直接移植。
- **scope 严格序与 `when` 逐步判定**：需要 fake host 模拟 **step 生命周期**——每一步调用一次 `when`、覆盖 `tools.resolve` 的同步/异步两条分支、以及"配置改了下一步生效"。现有 fake-host 只覆盖单次调用，测不了跨步判定，必须扩。
- **软依赖降级**：在 isolated 布局（`npm pack` 后装进空项目）里分别卸掉 `@deepseek-ai/dsh-spill-policy` 与 `@deepseek-ai/dsh-token-meter`，验证投影跳过与替换拒绝两条路径；hoisted 布局会掩盖 `ERR_MODULE_NOT_FOUND`。
- **20 任务门**：只作发布前人工冒烟，固定任务清单与脚本，不接 CI、不做统计推断。

## 7. 风险

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| 成功率回退 | 候选集覆盖不到、守卫写错 | 影子期先量化；只读白名单；失败即回退 |
| 缓存被破坏 | 任何回溯改写 | 追加式硬约束 + 收据里记 cache 命中率变化 |
| 提取错误被静默采纳 | 模型选错 span | 出处校验 + schema + 下游效果三重检查；错误分两类记录 |
| 延迟变差 | 每步多一跳模型 | v1 不蒸馏，只做确定性投影；Jev 只在多候选时调用；**收据 I/O 不产生每步阻塞**（每 N 行或每 turn 结束 fsync 一次） |
| 实测节省低于预期 | 影子期两账合计 <10%（极端情况只有 5%） | **不改变发布决定**：默认 `selected+[]`、固定开销 ≤800 token、失败即回退、用户零风险；按实测值修正 §3 的预期，不降级发布（§3 已写死选 ②） |
| 蒸馏倒亏（二期） | 短任务上压缩器开销超过节省 | 研究已证短任务 +24~94%；蒸馏必须先过后验门，默认关闭 |
| 工具族划分错误 | 阈值 / 准入按错误的族聚合 | 按 §5.2-4 逐族校准；v1 覆盖 `read` / `grep` / `glob` / `bash` / `ssh` |

## 8. 已做的决定（可否决）

| # | 决定 | 理由 | 代价 |
|---|---|---|---|
| D1 | 主口径用 token 数，费用作可选护栏 | 与"省 token"的原始目标一致；两个口径下优先级不同，混用会导致优化错方向 | 缓存被破坏这类费用异常不直接进主口径，只能靠护栏事后发现；费用配置默认关闭、不参与验收 |
| D2 | 第一版只放行**只读**工具，替换白名单只到 `read` / `grep` / `glob` | 失败代价不对称：错放行一次可能不可逆，错回退只多花一次调用；只读白名单本身不可靠判定（`bash` 无法在派发层收窄、`web_fetch` 无 guard 字段），且本 profile 没有文件级快照，git 之外 `edit` 不可回滚 | 替换面收窄到三件套，v1 收益上限明显变小 |
| D3 | 先影子一周，再开干预 | 没有标签就无法校准；影子期同时产出候选集召回数据 | 一周内零收益，且要维护影子路径与收据 |
| D4 | 计划协议段**常驻**系统提示，稳定、中途不翻转 | 常驻段每次请求固定几百 token，相对一次 194k 回放约 0.29%（两端都按 raw token 计，cacheRead 不打折）。中途翻转会让整段前缀失效并重算，代价高两个数量级。所以"按需打开"是错的，"常驻且稳定"才对 | 每次请求固定多几百 token，短会话摊不回来 |
| D5 | 模板参数**先解析再比对** | `tools/execute` 拿解析后的实参与解析后的候选逐字比较，不是拿模板比；证书措辞改为"由声明的投影解析得到"，不再声称"逐字等于作者所写" | 模板表达力受限（只能填参数、不能造结构），bank 校验要同步改 |
| D6 | 命名 `dsh-boost`，先只针对本 web profile；desktop 二期 | 复用现成插件的钩子层；测试面先减半 | desktop 一期不支持，后续适配要另补 |
| D7 | 要能发布，仓库布局照 `dsh-cherry-bridge` | 见 §11：双语 README、npm public、工作区暴露面 | 发布面扩大：文档、许可证、NOTICE、兼容性承诺都要跟上 |

## 9. 已答复的决定（2026-11-18）

§8 之外只剩两条新答复；影子期与 desktop 已收进 §8（D3 / D6），不再单列。

| 问题 | 答复 | 影响 |
|---|---|---|
| 只自用还是发布 | **发布，提交 GitHub** | 见 D7：双语 README、LICENSE、npm 元数据、工作区暴露面、更严格的失败兜底 |
| 建回放集 | 先不搭 | 用收据 + 抽样复核 + 20 任务回归门 |

剩余未定：无。

## 10. 留给 builder 的

- 移植 `ref-harnessmm/dsh-plugin/harnessmm-desktop` 的 `llm/stream` 合成回合与 `tools/execute` 防篡改逻辑，保留其收据结构。
- 按 D5 展开为模板支持（bank 校验 + 防篡改 + 证书措辞）；起点是 `integrations/deepseek_harness/public_argument_binding.mjs` 的 `$public` 投影（语法规范见 §5.2）。注意现成的 bank 校验**不是**在 `parseBank` 拒模板——`{"path":{"$public":…}}` 是合法字面量对象，能通过解析；真正拒绝的是 `sameLiteral` 逐字校验链（`projectTurn` 的 `chain-arguments-differ` 与 `violateDispatch`）。扩成模板要同步改 `parseBank`、`projectTurn`、`violateDispatch` 三处，结论不变。
- guard 按 §5.2 的词表实现：`ok` / `text_contains` / `text_not_contains` / `json_equals`。**不要**照抄参照实现的 `GUARD_FIELDS`——`stderr_empty` 在 v1 白名单（read/grep/glob）上恒真、`exit_code` 恒 `unknown`（恒拒），两者都不可用；"只有 `ok:true`"必须判不合格。
- 收据格式：完整字段见 §5.3 的两组表——替换账 `saved_input_tokens` / `cache_hit_delta`；投影账 `projected_tokens_before` / `projected_tokens_after` / `saved_projection_tokens` / `projection_unit` / `projection_retrievals` / `projection_net_tokens`。不要写成 `saved_tokens_estimate`。
- 收据存储（`$DSH_HOME/boost/receipts/<encodeSegment(sessionId)>.jsonl`，分片名把 `[A-Za-z0-9_-]` 以外的字符按 UTF-8 字节可逆百分号编码——session id 可能含 `/` 或 `..`，存储绝不能写出 `receipts/`）：
  - 每行一条收据，带 `version`（收据 schema 版本，从 1 起）与 `receipt_hash`（对 `sessionId` / `turn` / `stepId` / 工具名 / 参数 的稳定哈希）。
  - **只存摘要与预览**：`preview` = 规范化回执的前 256 字符，**不存 stdout 全文**；全文只在 spill 后端（页脚 locator 指向它）。
  - 单文件上限默认 8 MiB 或 20,000 行；超限轮转为 `<encodeSegment(sessionId)>.1.jsonl`，保留最近 2 个。
  - **每 N 行或每 turn 结束 `fsync` 一次**（不逐步 fsync，避免每步阻塞）；每行以 `\n` 结尾，**半行（无换行结尾）在读取时丢弃**并从该偏移截断，不猜内容。
  - 写失败：内存缓冲；**连续 3 次 append 抛错**即停止替换（收据 `receipt-write-failed`，见 §5.2）。
- 所有模型调用走 `ctx.llm`，路由可配；默认复用边界请求自身的 route（现成插件已验证这条能避开 thinking-mode 网关的 400）。Jev 自调用带 `purpose: 'boost-selector'`（§5.1）。该 purpose 要先声明合并，否则编译期拒绝：

  ```ts
  import type {} from '@deepseek-ai/dsh-llm/types'
  declare module '@deepseek-ai/dsh-llm/types' {
    interface LlmRequestPurposeMap { 'boost-selector': true }
  }
  ```
- 按 §11 准备仓库骨架与双语 README（`main`/`exports`/`types` 指向 `dist`、Apache-2.0 + `NOTICE`、`files` 与布局一致）。

## 11. 发布形态（照 `dsh-cherry-bridge`）

**平台**：v1 仅 POSIX；启动时检测平台，Windows 上拒绝启用替换（投影仍可用）。

**许可证**：`Apache-2.0`（不是 MIT），随包分发 `NOTICE`，注明移植自 HarnessMM（Apache-2.0）。选移植路线，不声明 clean-room。

仓库布局：

```
dsh-boost/
├── README.md            # 中文（主）
├── README.en.md         # 英文
├── LICENSE              # Apache-2.0
├── NOTICE               # 移植来源与许可声明
├── package.json
├── tsconfig.json        # build: tsc -p tsconfig.json
├── .gitignore           # 忽略 dist/、node_modules/
├── cordis.patch.yml     # bundle patch，装上即插入插件行
├── locale/{zh,en}.json  # 设置项标签
├── scripts/             # §2.1 的统计复算
│   ├── session-stats.mjs
│   └── session-snapshot.json  # 300 个 sessionId + 字节数 + 统计日期
├── test/regression/     # tasks.jsonl + 双跑脚本（§6.1 的 20 任务门）
├── src/                 # TypeScript 源
├── dist/                # 构建产物（不入库；main/exports/types 指向这里）
└── docs/                # 设计稿、研究
```

`package.json` 要点：

```json
{
  "name": "dsh-boost",
  "version": "0.1.0",
  "description": "Cut DSH token usage by projecting tool receipts and skipping deterministic read-only calls",
  "type": "module",
  "license": "Apache-2.0",
  "repository": { "type": "git", "url": "git+https://github.com/SAXEM1997/dsh-boost.git" },
  "keywords": ["dsh", "dsh-plugin", "token-efficiency", "prompt-cache", "tool-receipt", "delegation"],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "stats": "node scripts/session-stats.mjs",
    "prepublishOnly": "npm run build && npm pack --dry-run && test -f dist/index.js && test -f dist/index.d.ts"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@deepseek-ai/dsh-tools": "^0.2.2-rc.1",
    "@deepseek-ai/dsh-spill-policy": "^0.2.2-rc.1",
    "@deepseek-ai/dsh-token-meter": "^0.2.2-rc.1"
  },
  "peerDependencies": {
    "@deepseek-ai/dsh-tools": ">=0.2.2-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-spill-policy": ">=0.2.2-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-token-meter": ">=0.2.2-rc.1 <0.3.0-0"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/dsh-spill-policy": { "optional": true },
    "@deepseek-ai/dsh-token-meter": { "optional": true }
  },
  "publishConfig": { "access": "public" },
  "engines": { "node": ">=22.18.0", "dsh": ">=0.2.2-rc.1 <0.3.0-0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "files": ["dist", "src", "locale", "cordis.patch.yml", "README.md", "README.en.md", "LICENSE", "NOTICE"]
}
```

- **`version` 不能省**：缺 `version` 时 `npm pack` 直接报 `Invalid package, must have name and version`，发布链在第一步就断。`description` / `repository` / `keywords` 同理是 npm 页面与检索的最低要求；owner 沿用同作者的 `dsh-cherry-bridge` 命名空间。
- **仓库双址**：公开主仓是 `github.com/SAXEM1997/dsh-boost`，`repository` 字段指向它；**开发期先推内网镜像** `https://gitlab.ai.isv.iridesc.cn:23000/zyx/dsh-boost`（私有），代码稳定后再同步公开。因此 `origin` 指内网镜像，GitHub 作为第二个 remote 后加——不要反过来先把 GitHub 设成 `origin`。
- `prepublishOnly` 里先 build，再 `npm pack --dry-run`，最后 `test -f dist/index.js && test -f dist/index.d.ts`。**`npm pack` 只校验 name/version，不校验 files**（实测删掉 `dist/` 仍 exit 0），所以产物完整性必须靠显式 `test -f`，不能指望 pack。
- **`dist/` 不入库**（`.gitignore` 忽略），干净 clone 上必须能 `npm run build`——布局里因此要有 `tsconfig.json`，缺它 `tsc -p` 直接 `TS5058`；`prepublishOnly` 已含 build，发布包不会缺 dist。
- `engines.dsh` 由 dsh 插件加载器读取，npm 忽略此字段。
- `files` 与实际布局一致：没有 `lib`，所以不列 `lib`；`scripts/` 与 `test/` 是 dev-only，不进包。
- `$DSH_HOME` 未设置时回退 `~/.dsh`；三处状态按同一规则解析：`boost/scope.json`、`boost/scope.lock`、`boost/receipts/<encodeSegment(sessionId)>.jsonl`（§10；分片名用可逆百分号编码，避免 id 中的 `/` 或 `..` 写出 `receipts/`）。

**依赖声明（`inject`）**：依赖形态在这里定死。

| 依赖 | 形态 | 缺失时 |
|---|---|---|
| `tools` | **硬**（`export const inject = ['tools', 'llm', 'systemPrompt']`） | 插件加载失败 |
| `llm` | **硬** | 插件加载失败 |
| `systemPrompt` | **硬** | 插件加载失败（协议段常驻，缺它闸门无法解释） |
| `tokenMeter` | **软**（`ctx.get('tokenMeter')`） | 拒绝启用替换；投影裁剪仍可用，但投影账的 token 估算记 `unknown`（不伪造数字），`ERR_HOST_NO_TOKENMETER` |
| `spillStore` | **软**（`ctx.get('spillStore')`） | `projection: 'on'` 时超限回执**不投影**（保住证据），`projection-skipped:no-spill`，`ERR_HOST_NO_SPILL`，`boost status` 标 degraded；`projection: 'shadow'` 不受影响 |
| `tools.resolve`（步骤级 `when`） | 软探测 | 整族不注册，`ERR_HOST_NO_STEP_WHEN`（§5.5） |

`tokenMeter` **只能软依赖**：写进 `inject` 的话，宿主没这个服务时插件根本加载不起来，连"拒绝替换、投影照做"的降级都做不到。`spillStore` 同理——硬依赖会让"没有 spill 后端"直接变成启动失败，而正确行为是"不投影、保证据"。

**两个可选 peer 包**：`@deepseek-ai/dsh-spill-policy` 与 `@deepseek-ai/dsh-token-meter` 写进 `peerDependencies`，并在 `peerDependenciesMeta` 标 `optional: true`；代码一律 `await import(...)` 包 try/catch。**只写静态 import 而不声明 peer 依赖**时，宿主没装该包会抛 `ERR_MODULE_NOT_FOUND`，降级路径不可达（本机 hoisted 布局把包提升到可解析位置，**测不出这个问题**）。验收必须在 isolated 布局（`npm pack` 后装进空项目）下做，见 §6.2。

**发布验收顺序**：先 `npm pack --dry-run`（只校验 name/version）→ 再 `npm pack` 并让 `dsh plugin add` 解析安装。反过来做，缺字段时看到的是一句解析错误，不是包本身的问题。

两条来自参照仓库 patch 注释、会静默失败的硬约束：

1. **行的 `id` 必须严格等于导出插件的 `name`，`name` 必须等于 npm 包名**。宿主只追加顶层 `insert` 行，再用 `row.id == entry.options.id && row.name == entry.options.name` 判定"已装配"；缺一个就被**静默跳过**（不报错）。
2. **patch 的 `config` 是整体替换，不是深合并**。删掉一个键不等于"沿用默认"，而是让装配层用自己的默认值。所以装配层必须对每个缺键回落默认值，且 `cordis.patch.yml` 里列出的就是该 profile 的完整配置面（键名见 §5.3）。

### 11.1 控制面

第一版只给一个工具 `boost`，子命令：`status`、`scope get|set`（全局或工作区列表）、`shadow on|off`。配置文件仍是事实来源，工具只是它的安全写入口（走 §5.5 的 validate → prune → revision+1 → 原子写）。

`boost status` 必须输出：`shadow`、`projection`（§5.5 的两个持久字段）、`skip:no-scope` 与 `projection-skipped:*` 的计数、degraded 码（`ERR_HOST_NO_TOKENMETER` / `ERR_HOST_NO_SPILL`）、`estimateSystemMessage` 实测的固定开销 token、累计节省（替换账与投影账分开，**投影账报净额**，附 `projection_retrievals` 计数）。"开了影子/投影"不能只靠用户记忆核实。

`boost` 是 scope 的**唯一豁免**（§5.5）：只读写本地配置文件、无外部副作用；否则 `selected+[]` 下用户没有启用入口。`boost scope set` 复用 §5.5 的同一条写路径——**`scope.lock`（`open(..., 'wx')`）包住 read-verify-write**，带 base revision 校验，冲突或锁占用分别返回 `ERR_SCOPE_REVISION_CONFLICT` / `ERR_SCOPE_LOCKED`。

不做客户端设置页（二期）。理由：设置页要 `dsh.client`、UI 构建和 HMR 验证，成本远高于收益；工具 + 文件已经够用，且更容易测。

### 11.2 双语

- `README.md` 中文为主，`README.en.md` 英文；两份内容对应，不互相引用。
- `locale/zh.json` / `locale/en.json` 给设置项标签用（即使一期没有设置页，配置项标题仍走 locale）。
- 代码注释与提交信息用英文；面向用户的错误提示走 locale。
