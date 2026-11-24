# 跑一次 A/B：可执行的清单

> 配套文档：[质量仪](quality.md)（概念、口径、偏差）。
> 这里只有步骤。每条都能复制粘贴；**判据在最后，不在中途**。

## 0. 前置（十分钟）

- [ ] 插件已装、DSH 已重启，设置页能看到「Token 效率」。
- [ ] 本会话的工作区**已选中**（`boost` 工具可见——不可见就没法记 `tokens`）。
- [ ] 记下三件事，写进结果文件头部：
      `git -C <repo> rev-parse HEAD`、`npm view dsh-boost version`、`date -u +%FT%TZ`。
- [ ] 冻结工作区：`git status --porcelain` 必须为空；实验期间**不改代码、不改插件版本**。

两臂只差**一个开关**（`projection`）。`shadow` 两臂都必须是 `false`，否则测量的是影子模式。

## 1. 产任务表

```bash
node scripts/quality-tasks.mjs --sessions "$DSH_HOME/sessions" --out /tmp/tasks.json
```

只取 `isFinal: true` 的那些（判定不是终态的会话不能整体重放）。在当前语料上只有个位数——
**个位数就只能得到个位数的结论**，见第 5 步。

- [ ] 打开 `/tmp/tasks.json`，人工过一遍 `task` 字段：它是那次会话的开场白，可能带上下文
      （例如「只读评审」），跑之前把它改成能独立执行的陈述。
- [ ] 每条记下**怎么判定 `ok`**——必须是能机器读的东西（退出码、`ℹ fail 0`、`git status --porcelain`
      为空），不是「看起来对了」。

## 2. 跑基线臂（`projection: off`）

- [ ] 设置页 → 作用域 → 把 `projection` 设成 `off`，`shadow` 设成 `false`，保存。
- [ ] `boost status` 确认：`looksAt.data.scope.projection === 'off'`、`shadow === false`。
- [ ] 对每个任务：**新开一个会话**，粘贴任务陈述，让它跑到终态；记一行

      { "id": "<sessionId 或自定义名>", "ok": true|false, "tokens": <totalTokens> }

      `tokens` 取 `boost status` 的 `data.usage.totalTokens`（该会话的累计），或宿主自己给的数。
- [ ] 全部跑完后**不要**改工作区。

## 3. 跑处理臂（`projection: on`）

- [ ] 把工作区恢复到基线开始前的同一状态（`git status --porcelain` 为空；必要时 `git stash`/`reset --hard`）。
- [ ] `projection` 设成 `on`、`shadow` 仍是 `false`，保存；`status` 再确认一次。
- [ ] 同一批任务、同样的顺序、**同一天**重跑，记同样的三字段。

> 两臂之间唯一允许变的东西是 `projection`。版本、模型、工作区、当天时间带都不是变量。

## 4. 比较

```bash
node scripts/quality-compare.mjs --baseline base.json --treatment treat.json --min-pairs 12
```

读四个字段：

| 字段 | 怎么读 |
|---|---|
| `conclusion` | `insufficient-pairs` → **停**，样本不够，不要再解读其它数字 |
| `mismatches` | 逐条看：是这次干预引入的，还是本来就随机 |
| `tokenDelta` | 负数=处理臂更省；`null`=没有一对两端都报了 token |
| `missing` | 两臂没配上的任务，说明有一臂漏跑 |

## 5. 判据（预先定死，跑完不许改）

一项干预可以进主线，当且仅当：

1. `conclusion` 不是 `insufficient-pairs`（≥ `--min-pairs` 对）；
2. `agreementRate === 1`，或所有 `mismatches` 都有可解释的失败模式且**不是这次干预引入的**；
3. `tokenDelta < 0`，且幅度不小于该干预的收益天花板（PTC 1.47%、去重 0.24%，见
   [原理的两个分母](how-it-works.md#两个值不值得做下一个功能的分母)）。

三条任一不满足 → **不加**。允许的例外只有一个：把 `mismatches` 逐条写清楚之后，由人显式
裁决「接受这个失败模式」，并把裁决写进结果文件的 `notes`。

## 6. 结果文件长什么样

```json
{
  "meta": { "commit": "…", "plugin": "0.4.4", "startedAt": "…", "host": "…" },
  "arm": { "baseline": { "projection": "off", "shadow": false },
           "treatment": { "projection": "on", "shadow": false } },
  "notes": "mismatches 里 t3 是任务本身不确定（依赖网络）",
  "baseline": [ { "id": "t1", "ok": true, "tokens": 120000 } ],
  "treatment": [ { "id": "t1", "ok": true, "tokens": 98000 } ]
}
```

`quality-compare.mjs` 直接吃 `baseline`/`treatment` 两个数组（也接受 `{runs:[...]}`）。

## 7. 五个会毁掉这次实验的错

| 错 | 症状 | 预防 |
|---|---|---|
| 两臂之间改了代码或升了插件 | `tokenDelta` 混着两个变量 | 第 0 步写死 commit 与版本，每臂开始前再 `git status` 一次 |
| `shadow` 没关 | 处理臂其实什么都没做 | 每臂 `boost status` 都确认 `shadow === false` |
| 用「模型说完成了」当 `ok` | 一致率虚高 | `ok` 只能来自验证命令的真实输出 |
| 一臂在上午、一臂在下午 | 缓存与网络状态不同 | 同一天连着跑，中途不切分支 |
| 样本 4 对就下结论 | `insufficient-pairs` 被无视 | 第 5 步第 1 条是硬门 |
