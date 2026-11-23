# 蒸馏产物钉在回执上，而不是每次渲染重算

二期要用快速模型压缩长回执（「蒸馏」）。我们决定：**一条回执的蒸馏结果只在它第一次到达时计算一次，
按 `(receipt_hash, question_hash, distiller_version)` 三元组落盘，此后任何重放只查表、不重算。**

理由是缓存，不是性能。DSH 的输入里约 97% 是缓存读，而缓存按**精确前缀**匹配：同一段历史如果
第二次渲染出不同的字节，断点之后全部失效——按缓存命中约 1/50 的价差折算（`docs/research/2026-11-18-three-tier-delegation.md` 的来源是 `deepseek-flash`；
换成 1/30 的 `deepseek-v4-pro` 结论只会更强），一次约 19 万 token 的前缀失配约等于 **9.6M**
token 当量，抵得掉约 **700** 次投影省下的量。模型输出即使在 `temperature=0` 下也会
跨批次、跨 provider 版本漂移，而且**漂了没人知道**，直到某次 `resume` 出现大面积 miss。
把它变成数据，是让不确定性只发生一次的唯一确定做法。

## Status

accepted（2026-11-23）

## Considered Options

- **只用确定性裁剪（不做蒸馏）**：零风险，但压缩率封顶在「保留头尾」，做不到「从 20 万字符里抽出那三行报错」。它仍然是**兜底**：蒸馏超时或失败一律退回确定性裁剪。
- **每次渲染重新蒸**：字节不可复现，等于每回合自愿放弃缓存；成本也从 O(1) 变成 O(重放次数)。
- **依赖采样参数保证稳定**：跨批次、跨 provider 版本不成立，且失效时没有信号。

## Consequences

- **首次延迟**：蒸馏是一次辅助请求，落在关键路径上；只在超过阈值的回执上开。
- **质量钉死在第一次**：蒸坏了就坏着。改 `distiller_version` 能让新回执换行为，但**老回执必须继续用旧产物**——否则升级动作本身等于一次全量失效。所以版本升级要当缓存事件排期。
- **跨机器不保证**：产物跟着 `dshHome` 走，换机器 fork 同一会话会重算，字节可能不同。那台机器本来也是冷缓存，影响有限，但**不能声称跨机器一致**。
- **产物需要清理**：与收据同生命周期、同淘汰策略。
- 这条约束由 `AGENTS.md` 的「变换必须只追加」与 `test/projection-determinism.test.ts` 承载；二期蒸馏落地时必须复用同一套测试思路，而不是新写一套。

## Replay is a decision, not only an adoption

A refusal is pinned too. `empty`, `unverifiable` and `not-smaller` write a
bodyless tombstone under the same `(receipt, question, version)` key, so a replay
reads the refusal instead of paying for the same call again. `timeout` is
deliberately not pinned: it has no answer, and the parked call exists precisely
so a late answer can still land.

The product also pins the spill handle (`locator` + `retrievalHint`), because the
host backend names each artifact with `randomBytes(6)`: re-spilling on a replay
would change the footer — the half of the view the model reads — and the bytes
would no longer be the ones that entered history.

Deleting the product file is the documented way to make one receipt eligible
again.
