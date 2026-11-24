# 质量仪：用已有轨迹做配对回放

> 目标读者：准备判断「这个干预到底值不值得开」的维护者。
> 一句话：**仓库只能交付装置的一半**——挑任务的机器与比较的算术；跑两遍需要一台有 agent 的宿主。

## 为什么需要它

到 0.4.1 为止，仓库里的每一项干预都是「可能更好、可能更差」：投影、替换、蒸馏、工具可见性，
全部只记 token 账，没有任何一处回答「结果变差了吗」。设计稿从 v1 起就写着「不评判结果更好」，
但那句话在二期会变成硬伤——继续加干预（PTC、定序链、去重）意味着更大的干预面，失败模式是
「省了 token、答错了」。

0.4.1 的两个分母（`continuation` 1.47%、`duplicates` 0.24%）把收益天花板压到了个位数百分比。
越是这样，越该先测「有没有变差」，而不是继续加干预。

## 装置的两个半边

| 半边 | 在仓库里 | 命令 |
|---|---|---|
| 挑任务 | 是 | `node scripts/quality-tasks.mjs --sessions <dir> [--out <path>]` |
| 跑两遍 | **否**，需要宿主 | 见下方「在宿主上跑」 |
| 比结果 | 是 | `node scripts/quality-compare.mjs --baseline <a.json> --treatment <b.json>` |

### 挑任务

从 `session.v4.jsonl.zstd` 里找**验证命令**——`npm test`、`npm run ci`、`npx tsc`、`pytest`、
`cargo test`、`go test`、`make test`——每个会话取最后一次，标出它是否是该会话的最后一个调用
（`isFinal`）。只有 `isFinal` 的会话才能整体重放：否则这个判定不是终态，任务在它之后还继续了。

在 2,249 个会话上的实测：**48 个候选，其中 2 个 `isFinal`**。语料很小，这正是「装置能交、结论
不能交」的现实理由。

### 比结果

输入两臂，每臂是 `[{id, ok, tokens?}]`（也接受 `{runs:[...]}` 或 `{tasks:[...]}`）。输出：

| 字段 | 含义 |
|---|---|
| `compared` / `agree` / `disagree` | 两臂都有、且结果可比的任务数 |
| `agreementRate` | `agree / compared`；没有配对时是 `null`，不是 0 |
| `tokenDelta` | 只在**两端都报了 token** 的配对上求和；一个配对都没有时是 `null` |
| `mismatches` | 逐条列出 `{id, baseline, treatment}`——**这张表比一致率有用**，它给出失败模式 |
| `missing` | `baselineOnly` / `treatmentOnly`，两边没配上的任务 |
| `conclusion` | `insufficient-pairs`（少于 `--min-pairs`，默认 12）/ `no-difference-observed` / `difference-observed` |

判定规则是预先定死的：**样本不足就说不足**，不用一个小样本的一致率去宣称安全。

## 在宿主上跑

逐步清单见 **[`quality-runbook.md`](quality-runbook.md)**（前置检查、两臂命令、结果文件格式、
五个会毁掉实验的错、预先定死的判据）。下面只是四步的摘要：

1. `node scripts/quality-tasks.mjs --sessions <dsh home>/sessions --out tasks.json`，取 `isFinal` 的那些。
2. 对每个任务，在**同一份工作区快照**上跑两遍，只差一个变量：
   - 基线：`scope.json` 里 `projection: "off"`、`shadow: false`；
   - 处理：`projection: "on"`、`shadow: false`。
3. 两遍都要记 `{id, ok, tokens}`：`ok` 来自第 1 步那条验证命令的**真实**结果（不是模型的自我
   报告），`tokens` 用 `boost status` 的 `totalTokens`，或宿主自己的用量。
4. `node scripts/quality-compare.mjs --baseline base.json --treatment treat.json`。

## 它能证明什么、不能证明什么

| 能 | 不能 |
|---|---|
| 「在同一批任务上，两臂的**终态**是否一致」 | 「答案是不是更好」——一致不等于更好，只等于没变差 |
| 逐条列出不一致的样本，供人工看失败模式 | 给出统计显著性：一致率没有置信区间，样本量在报告里如实列出 |
| token 差的方向与量级 | 把 token 差归因到某一项干预：一次只翻**一个**开关，否则归因不成立 |

三个已知偏差，报告时要说：

1. **样本小**：`isFinal` 的候选只有个位数时，一致率基本没有信息量；`insufficient-pairs` 就是在说这件事。
2. **重放不是原样**：工作区快照之后的文件变化、宿主版本、模型版本都会影响结果，两臂必须同一天跑。
3. **`ok` 的定义由人给**：验证命令通过≠任务完成（设计 §5.4-4 的老问题），所以 `ok` 只对「这条命令测到的东西」负责。

## 之后的判据

M5 交完之后，二期每加一项干预，前置条件变成：

1. 有基线（质量一致率 + token 差），且样本 ≥ `--min-pairs`；
2. 一致率 100%（或所有不一致都有可解释的失败模式，且不是这次干预引入的）；
3. token 差为正，且不小于该干预已知的收益天花板。

三条不满足，就不加。这条规则写在 issue #20 的收尾评论里，避免下一轮又从「感觉能省」开始。
