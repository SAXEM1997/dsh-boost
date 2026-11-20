# fix-c2 Report: Spec corrections for round-1 rows 13, 14, 26, 27, 47, 49

**Branch**: `main` @ `095c0c7` → one new commit
**Files modified**:
- `docs/superpowers/specs/2026-11-18-dsh-token-efficiency-design.md` (639 → 639 lines)
- `docs/superpowers/clarifications/2026-11-18-dsh-token-efficiency.md` (49 → 50 lines)
- `docs/superpowers/plans/2026-11-18-dsh-token-efficiency.md` (2349 → 2350 lines)

---

## Row-by-row

### Row 13 — 20-task regression gate does not exist

| | Detail |
|---|---|
| **Old claim** | Design §6.1 presents the 20-task gate as delivered, with `tasks.jsonl` and a double-run script; plan T26 claims it delivered both. |
| **New claim** | The gate is **operator-supplied, not delivered**. `test/regression/` holds only `.gitkeep`. The 2026-11-18 ruling (m00234: "不搭回放集；20 任务门只作冒烟") is recorded beside the gate. The retrieval-integrity half ("retrieved byte count = count + retained window bytes") is explicitly marked **unverified** — no test or script covers it anywhere. |
| **Justifying fact** | `ls test/regression/` → only `.gitkeep`. `grep -r "tasks.jsonl\|run.mjs" test/` → no hits. The requester's decision is recorded in the clarifications file row 4 ("不搭回放集；20 任务门只作冒烟"). |
| **Plan fix** | T26's Files list and Step 3 now state that `test/regression/tasks.jsonl` and `test/regression/run.mjs` were **not delivered**; the commit step no longer stages `test/regression/`. |

### Row 14 — No ratification for the two narrowed requirement-2 asks

| | Detail |
|---|---|
| **Old claim** | The clarifications' user-ruling table recorded the narrowing of requirements 2.1/2.2 in the "澄清后的结论" section but had no explicit ratification row for the narrowing of these two specific asks. |
| **New claim** | Added user-ruling row #9 to the clarifications table, dated 2026-11-20, recording: (a) what was narrowed, (b) both justifications (79.8% single-tool steps; 7.2% value-transfer rate), (c) revisit triggers (shadow-week batch-step share; value-transfer above 7.2%), and (d) that this entry records a documented narrowing, not a silent reduction. Marked as "实现者按请求方指示" (implementer recording at requester's instruction). |
| **Justifying fact** | The narrowing is real and shipped: `src/` implements single-tool-at-a-time with read-only three-tool whitelist; no batch execution, no per-result Jev scoring. The justifications cite the shipped snapshot stats from `npm run stats` (79.8% single-tool; 7.2% value-transfer). |

### Row 26 — Stats table and ceilings quote pre-snapshot numbers

| | Detail |
|---|---|
| **Old claim** | §2.1 headline table and G1 ceilings quoted: 54,123 steps / 62,621 calls / p50 648 / step share 3.84% / token share 2.61%. |
| **New claim** | All updated to the shipped snapshot: **54,141 steps / 62,624 calls / p50 623 / step share 4.00% / token share 2.70%**. Per-family values, per-step values, value-transfer rate, and derived ceilings (G1's "两个天花板", "经验换算率", per-request means, N1's "79.8%") all updated. The "snapshot is authoritative" note is preserved and strengthened. |
| **Justifying fact** | `npm run stats --silent` output: `steps: 54141`, `toolCalls: 62624`, `receiptChars.p50: 623`, `whitelist.fullStepShare: 0.04`, `whitelist.tokenShare: 0.027`. `test/scripts.test.ts` pins the same values and passes (5/5). |

### Row 27 — A4 bucketed net-savings has no tooling

| | Detail |
|---|---|
| **Old claim** | §6.1's adjudication table listed "分桶净节省" as a v1 evidence row without noting it was unimplemented. |
| **New claim** | The row is now explicitly marked **"v1 未实现"**: no script in the repo produces bucketed net savings. The shadow week's aggregate (from `scripts/shadow-report.mjs`) replaces it as v1's A4 adjudication evidence. The paragraph below the table now says: shadow-week overall net-savings rate is the actual A4 evidence; if it shows significant short-vs-long session variance, implement bucketing then. |
| **Justifying fact** | `grep -r "bucket\|分桶\|≤5.*6–50" scripts/ src/` → no script or source file implements bucketing. `scripts/shadow-report.mjs` exists and produces aggregate ratios. |

### Row 47 — §6.1 still presents 20-task gate as phase-3 gate

| | Detail |
|---|---|
| **Old claim** | Phase-3 section presented the 20-task gate as the regression gate without noting it was declined and not built. |
| **New claim** | Phase-3 item now states the gate is **未交付**: `tasks.jsonl` and the double-run script are operator-supplied (2026-11-18 ruling), and the retrieval-integrity invariant has no coverage. §4's "C 先建基准" row is updated from "二期，作为回归门" to "未采用" with the same ruling cited. §9's "建回放集" row is updated. §11's directory layout comment for `test/regression/` now says it holds only `.gitkeep`. |
| **Justifying fact** | Same as Row 13: `test/regression/` contains only `.gitkeep`; the 2026-11-18 ruling is in the clarifications file. |

### Row 49 — "更高质" has no metric in v1

| | Detail |
|---|---|
| **Old claim** | §1 stated the goal as "同样的任务用更少的 token 完成，且成功率不降" without addressing the "更高质" (higher quality) half of the original requirement. |
| **New claim** | Added an explicit note after the §1 goal statement: "更精炼" is measured by projection before/after token delta; **"更高质" is an untested assumption in v1** — v1 can at most claim "same or better" (also unmeasured), not verified quality improvement. The metrics that would judge quality (task completion rate, override rate) are defined in §6.1's guardrails but v1 does not produce them. |
| **Justifying fact** | A1 ("success rate drop > 1pp") is explicitly declared "v1 不可判" in the anti-goals. There is no quality metric in the codebase or reports. |

---

## Post-edit grep verification

```
$ grep '54,123\|62,621\|3\.84\|2\.61\|648' design.md
Line 40: ...初稿的 p50/p90/p99（648/4,635/18,186）差约 4%/1.4%/0.5%...
```

**What remains**: A single `648` inside the historical-comparison note on line 40, which explicitly describes the *first-draft* values and why they differ from the shipped snapshot. This is intentional historical context, not a current claim. All other old numbers (54,123 / 62,621 / 3.84 / 2.61) are fully removed.

## Could not verify

- **Row 14's requester instruction**: I recorded the ratification as "实现者按请求方指示，2026-11-20" per the task instruction. The original conversation (m00234/m00330/m00705) is not accessible from this checkout; the framing and date follow the task specification exactly.
- **Plan T26's claim of delivery**: The plan's original wording asserted T26 delivered `test/regression/tasks.jsonl` and `test/regression/run.mjs`. The shipped tree disproves this. I corrected the plan record but could not determine whether the plan was wrong at write-time or the delivery was skipped during implementation.

## Line counts

| File | Before | After |
|---|---|---|
| `docs/superpowers/specs/2026-11-18-dsh-token-efficiency-design.md` | 639 | 639 |
| `docs/superpowers/clarifications/2026-11-18-dsh-token-efficiency.md` | 49 | 50 |
| `docs/superpowers/plans/2026-11-18-dsh-token-efficiency.md` | 2349 | 2350 |
