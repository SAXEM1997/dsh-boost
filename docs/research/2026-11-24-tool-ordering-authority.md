# 工具调用定序权威：谁决定顺序

**日期：** 2026-11-24 · 只读一手来源；数字尽量标到节/表。术语：**一次定序**＝规划器在第一次模型调用里给出完整步骤序列，步骤之间不再问主模型；**逐步定序**＝每个回执后由主模型决定下一步；**混合**＝粗粒度序列 + 局部选择/局部重规划。本文回答 dsh-boost 原始需求 2.3（Jev 只选不定序，v1 为主模型逐步定序）。

## 结论

1. **一次定序在“环境可预判、步骤可并行”时同时省 token、省延迟，精度基本不降**：ReWOO 六个公开基准平均 token −64%、绝对精度 +4.4pp（HotpotQA 9795→1986 token，40.8→42.4）[ReWOO](https://arxiv.org/abs/2305.18323)；LLMCompiler 在 HotpotQA/Movie Rec 上延迟 1.80×/3.74×、成本 3.37×/6.73×，精度持平或更高 [LLMCompiler](https://arxiv.org/abs/2312.04511)。
2. **但“声明的顺序”本身不保证被执行：链越长，保真度越差**。跨 ALFWorld/Mind2Web/SWE-bench 仅 22–45% 的轨迹保留了声明结构；ALFWorld 4–5 步为 36.5–49.6%，6–7 步跌到 4.8–21.4%，更长趋近 0 [Do LLM Agents Execute the Plans They Declare?](https://arxiv.org/abs/2609.38108)。
3. **逐步定序不是无条件更差**：环境部分可观测时一次定序会输给逐步——Plan-and-Execute 在 WebShop 只有 17.0%，ReAct 32.0%；ReWOO 自己也承认 ALFWorld 无法预先枚举所有分支（§4）[ADaPT](https://arxiv.org/abs/2311.05772)、[ReWOO](https://arxiv.org/abs/2305.18323)。
4. **混合形态已有明确先例，且“局部”都由结构边界定义**：ADaPT 只递归分解失败的子任务（ALFWorld 71.6% vs Plan-and-Execute 43.3%）；AdaPlanner 用 in-plan/out-of-plan 区分“改下一步”与“改剩余计划”；LLMCompiler 只在迭代边界重规划 [ADaPT](https://arxiv.org/abs/2311.05772)、[AdaPlanner](https://arxiv.org/abs/2305.16653)、[LLMCompiler](https://arxiv.org/abs/2312.04511)。
5. **对本插件：引入“守卫门控的短链”（混合），而不是一次定序**。同源的 HarnessMM 消融显示预授权链执行省 18.62% token、成功率低 1.56pp（257 个 MBPP 任务，93.77% vs 95.33%），这是目前唯一可比的直接数据 [HarnessMM](https://github.com/YuhuaJiang2002/HarnessMM)。

## 证据

### 一次定序

**ReWOO（Planner–Worker–Solver）。** Planner 一次写出带 `#E1…` 占位符的完整计划，Worker 逐步取数（不再问 LLM），Solver 汇总。HotpotQA 上 ReAct 用 9795.1 token、4.97 步、40.8% 准确率，ReWOO 用 1986.2 token、4.45 步、42.4%（§3.2.1 Tab. 2）；六基准平均 token −64%、准确率 +4.4pp；SOTUQA +8pp 且 token −43%。注意这是 2023 年的 token 口径，没有 provider 前缀缓存。
工具全挂时（强制返回 “No evidence found”），ReAct 准确率 −40.8pp（40.8→0.0），ReWOO −29.2pp（42.4→13.2）且 token 反降 110.8（§3.2.1 Tab. 5）。这说明一次定序在“观测不可用”时更稳，但也只是从 42.4 跌到 13.2，并非无损。
**边界（作者自述）：** 环境上下文不足时（ALFWorld “把花瓶放进保险柜”），Planner 没有房间布局的先验，只能枚举所有可能计划，步数等价于观测依赖推理的最坏复杂度（§4 Limitations）。

**LLMCompiler（Planner/DAG + Task Fetching Unit + Executor）。** Planner 一次生成带依赖的 DAG，执行器按拓扑并发跑，步骤间没有 LLM。§5.1 Tab. 1/2 的数字：

| 基准 | ReAct† | LLMCompiler | 加速/成本 |
|---|---|---|---|
| HotpotQA (GPT) | 62.47% @7.12s | 62.00% @3.95s | 1.80×；$5.00→1.47/1k（3.37×） |
| Movie Rec (GPT) | 72.47% @20.47s | 77.13% @5.47s | 3.74×；$20.46→3.04/1k（6.73×） |
| ParallelQA (LLaMA-2) | 59.59% @15.47s | 68.14% @26.20s | 2.27×；+8.55pp |
| Game of 24 | ToT 74.00% @241.2s | 75.33% @83.6s | 2.89×（每轮重规划） |

**边界：** WebShop 上精度大涨但延迟变差——GPT-3.5 19.8%→48.2%，5.98s→10.48s；GPT-4 35.2%→55.6%，19.90s→26.73s（§5.4 Tab. 3），作者归因于 Planner 开销。**混杂因素：** 上述收益同时来自“一次定序”“并行执行”“更少 LLM 调用”，论文没有把定序单独拆出来，不能当作定序的净效应。

### 逐步定序

- ReAct 的失败模式被量化：Movie Recommendation 上约 85% 的样例过早停止（没搜完 8 部电影），LLMCompiler 99% 搜完（附录 A，Fig. A.1）；ParallelQA 的 LLaMA-2 实验里约 20% 样例出现重复调用（§5.2）。这些是“每步都问模型”的可测代价：重复与早停。
- 但观测确实能救场：ADaPT 的 Plan-and-Execute 基线在 ALFWorld 与 ReAct 打平（43.3% vs 43.3%），在 WebShop 崩到 17.0%（ReAct 32.0%），TextCraft 27.0% vs 19.0%（Tab. 1/2）。同一个“一次定序”基线在不同环境里从持平到腰斩，说明定序权威的优劣取决于观测是否在规划时可得。
- 逐步的极端脆弱性也有数：工具全失败时 ReAct 归零（见上 Tab. 5）。

### 混合形态

- **ADaPT（按需分解）：** 先让 executor 直接做；失败才让 planner 分解*这个*子任务，递归进行，兄弟子任务不动。ALFWorld 71.6%、WebShop 44.0%、TextCraft 52.0%，相对 Plan-and-Execute 的 43.3/17.0/27.0（Tab. 1/2）。“局部”＝失败子树的根。
- **AdaPlanner（计划即代码 + 两类反馈）：** in-plan 反馈只做局部推理（`ask_LLM()` 抽取信息、改当前动作）；out-of-plan 反馈才重写剩余计划，并从当前中间点继续而不是重开 episode（§2/§3）。ALFWorld 91.79%、MiniWoB++ 91.11%（有反馈）/93.22%（无反馈）。“局部”＝观测是否落在计划预期内。
- **Plan-and-Act（子目标 + 接地）：** Planner 出子目标序列，Executor 把每个子目标翻成具体动作；关键在 §3.3：Planner **每个 Executor step 后**都用当前状态重写剩余计划。静态计划 43.63% → 每步重规划 53.94%（+10.31pp），Base Executor 配动态计划 44.24%（Tab. 1）。“局部”在这里是*接地*局部，不是*修复*局部——计划仍在全量重写。
- **LLMCompiler 的重规划：** 只在“一轮迭代结束、且没有候选达到 24”时把中间结果送回 Planner 重编 DAG（§3.4/§5.3），不是每步重规划。“局部”＝一次迭代的边界。
- **HarnessMM（与本插件同源）：** 慢模型预先写出 EDG 的精确动作，回执守卫命中就直接经原生工具执行，需要新推理时 actor 才恢复；图/链用 `predecessor_id` 表示。257 个 MBPP 任务的四条件消融：完整链执行 13.17k token/任务、93.77%；关掉 EDG 执行（回到每步问模型）16.19k、95.33%；单次使用 EDG 18.03k、93.00%（README “Decision reuse and callback substitution”）。这是“预授权顺序”与“逐步”最接近本插件的一组配对数字，但为作者自报、非同行评审，且是代码任务。
- **执行器必须强制顺序，光“告知”不够：** 把计划作为上下文交给通用 ReAct，只有 22–45% 的轨迹保住结构；改成按模式分派的执行器后，ALFWorld 成功率 0.480→0.918（DeepSeek-V4）、0.540→0.796（Qwen3.6-35B）[2609.38108](https://arxiv.org/abs/2609.38108)。对本插件，这意味着“顺序”必须编码进确定性执行路径（守卫/链），而不是写进提示词。

### 失效与重规划

- **计划被推翻的比例（代理指标）：** 上面的 22–45% 结构保真度等价于 55–78% 的轨迹偏离声明顺序；且随长度单调恶化（ALFWorld 6–7 步只剩 4.8–21.4%）。WebArena 是短计划边界：65.6–69.1% 保真，但平均计划只有 3.3–3.8 步 [2609.38108](https://arxiv.org/abs/2609.38108)。
- **修复 vs 全量重规划的成本（唯一找到的逐项计量）：** 500 个单扰动旅行行程上，全量重规划（LLM–Z3/Gemini）97.0% 成功、平均 6.6 处编辑、保留 65% 已接受安排；分层修复（IPyHOPPER）96.8%、1 处编辑、保留 92%（联合成功 346 例：6.809 vs 1.000 处编辑，64.70% vs 92.68% 保留）。成本：全量重规划 1 次调用/938–1,369 token；IPyHOPPER 0 次 LLM 调用、2.05s 中位；LLM 局部修订（iTIMO）虽然只改 1 处，却要 19,486–24,205 token [Replan, Repair, or Edit?](https://arxiv.org/abs/2609.19654)（Tab. 2/3）。**“编辑少”不等于“推理便宜”。**
- **重规划的理论代价：** 单点失效平均迫使 `1 + R(G)/n` 个动作重新验证（R(G) 为依赖路径对数）；全串行计划的阈值比 w 条并行链小约 w 倍；重复扰动下最优策略是带迟滞的“先修、深则重规划、再不值就放弃”[Threshold Theory of Plan Commitment](https://arxiv.org/abs/2611.19663)。这是模型推演 + 160 万次数值检查，不是实测。
- **Plan-and-Act 的代价没报：** 每步重规划换来 +10.31pp，但论文只给成功率，没有 token/延迟；LLMCompiler 的 Game of 24 也只报延迟（2.89×），没报每次重规划的 token。**“重规划贵多少”在 LLM agent 文献里基本是空白。**

## 对本插件的建议（含实验设计）

**建议：引入混合——“主模型定序 + 守卫门控的短链”，链长上限 K=3；不引入一次定序。** 具体规则（可判定）：

1. 主模型仍是唯一定序权威；它可以在一次回复里声明一条**有序链**（2–3 步），每步必须是“工具 + 字面量参数 + 确定性守卫”，不接受自由文本计划。
2. 执行器仅在守卫为真时提交第 i 步；任一步守卫失败、或链结束，立即回到主模型——这次返回就是重规划，不另设 planner。
3. Jev 仍只在同一位置的闭集候选里选，不得加步、改序、跳步；链用 `predecessor_id` 线性连接（HarnessMM 有、本仓库未移植，见 `README.md:143`）。
4. 不做的理由：一次定序在部分可观测下会输（WebShop 17.0% vs 32.0%），长链保真度在 6–7 步已跌到 4.8–21.4%；纯逐步则放弃 18.62% 的同源 token 收益。

**实验设计（能证伪上述建议）：**

- **数据：** 从现有 DSH 会话轨迹抽 300 个可重放任务：≥3 次工具调用、工具有确定性副作用边界（写操作只落在临时目录/沙箱）、有机器可判的终态（文件哈希、命令输出、DB 行）。按所需链长分层：3–5 / 6–8 / ≥9 各 100。排除有人工介入的会话。
- **三臂：** A＝v1 逐步（主模型每步）；B＝一次定序（主模型一次给全序列，失败则整体重发）；C＝混合 K=3（守卫失败即回主模型）。同模型、同工具、同温度；每任务三臂配对，臂序随机化；3 个种子。
- **指标：** 主指标成功率；次指标总 token（输入+输出，含选择器与重规划）、主模型调用次数、p95 墙钟、守卫中止率、重规划次数、前缀缓存命中率。成本同时按缓存价与列表价各算一遍。
- **判据（预先注册）：** 仅当 C 相对 A 的成功率 95% CI 下界 > −2pp、总 token 降 ≥15%、中止率 ≤30%、p95 延迟不劣化 >10% 时，才把 C 设为默认；否则维持 A。若 B 在 3–5 层以非劣成功率省 ≥30% token，可只在 short 层用 B。
- **规模与功效：** 300 对（McNemar，α=.05，power=.8）约可检出 8pp 的成功率差；3 臂×3 种子＝2,700 次任务运行；先跑 30 任务 pilot 估方差与中止率。
- **证伪条件：** C 的 token 节省 <15%，或成功率下界 <−2pp，或中止率 >30%，或 3–5 层完全没有节省——任一成立即放弃混合，维持逐步。
- **必须计入的缓存折扣：** 本仓库实测 97.01% 的输入是缓存读（`README.md:18`）。ReWOO 的 64% 是 2023 年无前缀缓存的 token 口径；在本插件里，跳过一轮主模型主要省的是**输出 token + 未命中前缀的增量**，不是整段输入。因此判据要看“按缓存计价的实际成本”，若成本节省 <5%，即使 raw token 达标也不引入。

## 参考

- [ReWOO: Decoupling Reasoning from Observations for Efficient Augmented Language Models](https://arxiv.org/abs/2305.18323)（Xu et al., 2023；§3.2.1 Tab. 2/5，§4）
- [An LLM Compiler for Parallel Function Calling](https://arxiv.org/abs/2312.04511)（Kim et al., ICML 2024；§5.1 Tab. 1/2，§5.3，§5.4 Tab. 3，附录 A）
- [Plan-and-Act: Improving Planning of Agents for Long-Horizon Tasks](https://arxiv.org/abs/2503.09572)（Erdogan et al., 2025；§3.3，§5.3 Tab. 1）
- [ADaPT: As-Needed Decomposition and Planning with Language Models](https://arxiv.org/abs/2311.05772)（Prasad et al., 2023；Tab. 1/2）
- [AdaPlanner: Adaptive Planning from Feedback with Language Models](https://arxiv.org/abs/2305.16653)（Sun et al., NeurIPS 2023；§2/§3，Tab. 2/3）
- [Do LLM Agents Execute the Plans They Declare? From Planning-Mode Declaration to Pattern-Specific Execution](https://arxiv.org/abs/2609.38108)（2026；§5 Tab. 1/2，§5 RQ3）
- [Replan, Repair, or Edit? A Unified Empirical Evaluation of Travel Agents for Itinerary Revision under Resource Disruptions](https://arxiv.org/abs/2609.19654)（Yuan et al., 2026；Tab. 2/3/4）
- [When AI Agents Should Repair, Replan, or Abandon: A Threshold Theory of Plan Commitment](https://arxiv.org/abs/2611.19663)（Tewari, 2026；§3–§6）
- [HarnessMM](https://github.com/YuhuaJiang2002/HarnessMM)（README “How it works”“Decision reuse and callback substitution”；257 任务消融，作者自报）

**我没能回答的：**（1）没有找到把“定序权威”作为唯一自变量的受控实验——ReWOO/LLMCompiler 的对比都混入了并行化、提示词差异和额外的 planner 调用；（2）没有 LLM 工具链中“计划被推翻比例”的直接测量，只有计划结构保真度和行程修复两个代理；（3）Plan-and-Act 与 LLMCompiler 都没报重规划的单次 token 成本，只有延迟或成功率；（4）没有 Jev 这类“闭集选择器 + 守卫”架构的证据，HarnessMM 最接近但非同行评审、任务域是 MBPP；（5）没有覆盖“多候选是同一位置备选、而非序列”的定序研究。