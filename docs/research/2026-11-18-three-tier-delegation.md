# Three-tier delegation for DSH: what the evidence supports

**Date:** 2026-11-18 · Primary sources only; numbers are linked to the document that owns them. Weak or indirect evidence is labelled.

## Summary

The cache economics are established and unusually strong: on DeepSeek's price sheet a cache hit costs 1/50th of a miss for `deepseek-flash` and 1/30th for `deepseek-v4-pro`, and matching is exact-prefix, so rewriting an earlier message forfeits the discount for everything after it. Cheap-model filtering and plan-then-execute loops have decent support (Mind2Web, ReWOO, LLMCompiler), and the one systematic comparison of observation condensation found LLM-based summarisation costs more tokens than it saves. What is *not* established is the part the design leans on hardest: that a small model's extraction plus a literal span check is trustworthy enough to drive deterministic code. The check proves a string occurs at a span, not that the span is the right value; semantic attribution is unreliable (~80% macro-F1 for a fine-tuned GPT-3.5), and span *selection* is the bottleneck (53.6 word-level F1). Thresholds are strongly distribution-dependent (35–85% savings at fixed quality across three benchmarks), so one global scalar is not defensible. Optimistic execution preserves success in published systems, but they verify with a semantic judge or a sandboxed state check, not a cheap predicate. I found no paper measuring our exact architecture; it is a reasonable synthesis, not a validated result.

## 1. Extraction with verification and attribution

Three different checks get conflated.

**Syntactic (schema).** JSON-Schema-constrained decoding guarantees shape, not truth. Azure's docs draw the line: older JSON mode "guaranteed valid JSON but couldn't ensure strict adherence to the supplied schema", while structured outputs follow the schema ([Azure structured outputs](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs)). Useful, but it says nothing about correctness — and constraining generation measurably degrades reasoning, more so as constraints tighten ([Tam et al., 2024](https://arxiv.org/abs/2408.02442)). Keep the extractor's schema minimal and non-reasoning.

**Literal (span occurrence).** This is deterministic and cheap, and the strongest guarantee in the stack — but it verifies *occurrence*, not *selection*. Extractive QA is "hallucination-free" only in that narrow sense; its errors move to picking the wrong span. On a research-paper benchmark the best span extractor, a 150M token classifier, reached 53.6 word-level F1, ahead of the strongest LLM extractor at 48.7 ([Recski et al., 2026](https://arxiv.org/abs/2605.21102)): a large share of spans is wrong or missed. Span verification filters fabrication, not selection error; log the two separately.

**Semantic (does the span support the claim).** Not reliable enough to be a hard gate. Even a fine-tuned GPT-3.5 reaches only ~80% macro-F1 on binary attribution ([Li et al., 2024](https://arxiv.org/abs/2402.15089)), and on ELI5 "even the best models lack complete citation support 50% of the time" ([Gao et al., 2023](https://arxiv.org/abs/2305.14627)). A literal check is more trustworthy than an LLM judge for "is this string present", but cannot answer "is this the right string".

Two framing results. Calibrated generative models have a statistical lower bound on hallucinating arbitrary facts, near the fraction of facts seen exactly once ([Kalai & Vempala, STOC 2024](https://arxiv.org/abs/2311.14648)) — a principled reason to extract rather than generate factual values. And RAG outputs still contain unsupported claims across ~18,000 annotated responses, though a fine-tuned small model detects them competitively with GPT-4 prompting ([Niu et al., 2024](https://arxiv.org/abs/2401.00396)) — a small verifier is viable, as a detector rather than a guarantee.

**Gap:** I found no head-to-head measurement, in an agent loop, of task success or hallucination rate for span-grounded versus free-form extraction. Treat this tier as promising and cheap, not validated.

## 2. Cascades and routing thresholds

The cascade literature agrees that the decision rule is learned per query, and that its operating point depends on traffic.

FrugalGPT learns "which combinations of LLMs to use for different queries" and matches GPT-4 with up to 98% cost reduction, or +4% accuracy at the same cost ([Chen et al., 2023](https://arxiv.org/abs/2305.05176)). That 98% is a best case, not a constant. RouteLLM is the clearest evidence that a threshold does not transfer across task distributions: at a fixed 95%-of-GPT-4 target, reported cost reductions are "over 85% on MT Bench, 45% on MMLU, and 35% on GSM8K" ([LMSYS report](https://www.lmsys.org/blog/2024-07-01-routellm/); [paper](https://arxiv.org/abs/2406.18665)) — a 2.4× spread at the same quality target. Routers trained only on Arena data are "near-random" on MMLU until given ~1,500 in-domain samples, and the best still needs 54% GPT-4 calls there; the paper's own summary is cost reduction "by over 2 times in certain cases".

Conformal prediction explains why. Its guarantee is *marginal* — coverage on average over the calibration and test distribution ([Angelopoulos & Bates, 2021](https://arxiv.org/abs/2107.07511)) — and adaptive sets "tend to undercover hard subgroups and overcover easy ones". A threshold calibrated on pooled traffic can silently under-cover a specific tool or task family. Learning-to-defer makes the same structural move: a rejector learned jointly with the predictor, i.e. a function of the input trained with a consistent surrogate, not a constant ([Mozannar & Sontag, ICML 2020](https://arxiv.org/abs/2006.01862)).

**Not directly proven:** no paper I found states and tests "one scalar threshold across heterogeneous agent tasks is unsound". It is an inference from marginal-only coverage plus the measured 35–85% spread. The supported replacement is per-domain or per-tool calibration to a target risk, plus an explicit abstain.

## 3. Speculative and optimistic execution in agent loops

Speculative decoding is the right analogy but a weaker guarantee than it looks: it accelerates 2–3× with *identical* output distribution because rejection sampling provably preserves it ([Leviathan et al., ICML 2023](https://arxiv.org/abs/2211.17192)). Agent-side verification has no such theorem; acceptance means "the check passed", not "the distribution is unchanged".

The closest agent prior art is plan-then-execute. ReWOO has a planner emit the whole tool-call plan and a worker execute it without an LLM between steps: 5× token efficiency and +4% accuracy on HotpotQA, plus tool-failure robustness ([Xu et al., 2023](https://arxiv.org/abs/2305.18323)). LLMCompiler compiles a DAG and runs independent calls in parallel: up to 3.7× latency speedup, 6.7× cost saving, ~9% accuracy gain versus ReAct ([Kim et al., ICML 2024](https://arxiv.org/abs/2312.04511)). Both pre-declare actions; neither skips the model call at execution — execution is deterministic.

The most direct evidence for "execute, verify, else fall back" is recent and preprint-only. SpecAgent has a weak model draft steps with real read-only tool calls, holds the first mutating action, and lets the strong model verify the draft in one prefill pass, committing the longest judged-valid prefix: within one point of Strong-only on τ²-bench, 43–57% of memory traffic and 41–54% of wall time, recovering 44%/75% of the Weak–Strong gap on AutomationBench/VitaBench ([Wang et al., 2026](https://arxiv.org/abs/2610.21463)). TomasuLLM runs calls out of order in copy-on-write sandboxes and commits only after validation against committed state: 1.31× on 100 SWE-bench Verified tasks and **zero false accepts across 4,010 audited commit-validation records** ([Yu et al., 2026](https://arxiv.org/abs/2609.38201)).

The caveat is central: both verify semantically or by sandboxed state comparison, not with a cheap literal predicate, and neither reports a shallow check that passes while the action is wrong.

## 4. Prompt-cache economics

**DeepSeek.** Caching is on by default and matches *prefix units* exactly: after `A+B`, a request `A+C` misses entirely, and the shared prefix `A` is persisted only later ([KV cache guide](https://api-docs.deepseek.com/guides/kv_cache)). Hit rate is "best-effort", and caches are cleared "usually within a few hours to a few days". Prices as of 2026-11-18 ([pricing](https://api-docs.deepseek.com/quick_start/pricing)):

| model | hit / 1M | miss / 1M | ratio |
|---|---|---|---|
| `deepseek-flash` (off-peak / peak) | $0.003 / $0.006 | $0.15 / $0.30 | 50× |
| `deepseek-v4-pro` (off-peak / peak) | $0.022 / $0.044 | $0.66 / $1.32 | 30× |

A 30–50× ratio is a far stronger argument than the 2× common elsewhere, and it multiplies the cost of any history rewrite.

**Anthropic.** Writes cost 25% more than base input for the 5-minute TTL and 2× for 1 hour; reads cost 10% of base input (0.05×/0.025× on the newest models). Minimum cacheable prefixes are 512–4,096 tokens. The hierarchy is `tools → system → messages`, and "changes at each level invalidate that level and all subsequent levels": editing tool definitions invalidates everything; changing `tool_choice` or adding/removing an image invalidates messages. A 20-block lookback means a long turn can miss even with an unchanged prefix ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).

**OpenAI (via Azure's compatible docs).** Minimum 1,024 tokens, and "a single character difference in the first 1,024 tokens results in a cache miss". The documented best practice is our constraint: "keep conversation context append-only". Cached content includes messages, tool definitions, and the structured-output schema appended to the system message ([Azure](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/prompt-caching)).

Consequence: append-only distillation is shaped correctly and pays well on DeepSeek — but the *selector's* calls cannot assume cached input, since short prompts fall under the 512–1,024-token minimum or never hit.

## 5. Small-model observation summarisation in agent loops

The most direct measurement compares eight condensation strategies on 60 DiscoveryBench tasks (480 evaluations), GPT-4o agent, GPT-5-mini condenser ([Chintalapati et al., 2026](https://arxiv.org/abs/2605.18854)):

- **Masking tool outputs** outside a recent window: 68,718 vs 75,147 tokens (8.6% net saving) with **100% completion**.
- **LLM condensers** (free-form, 18-field structured, relevance-ranked): **+24–94%** total tokens from condensation overhead and extra turns.
- No condenser changed solution quality significantly.

Caveat: ~9 events and ~75k tokens per task, so fixed per-call overhead dominates. Long coding trajectories could flip the arithmetic — that is extrapolation, not measurement.

Other evidence supports *filtering* more than summarising. Mind2Web filtered raw HTML with a fine-tuned small LM, "significantly improv[ing] the effectiveness and efficiency" of the agent; its candidate generator reached ~85–89% Recall@50 ([Deng et al., NeurIPS 2023](https://arxiv.org/abs/2306.06070)) — which is also a ceiling, since 11–15% of gold elements never reach the model. AgentOccam gained 26.6 points (+161%) on WebArena purely by aligning the observation/action representation ([Yang et al., 2024](https://arxiv.org/abs/2410.13825)). AgentFold shows learned multi-scale folding reaching 36.2% on BrowseComp with a 30B model ([Ye et al., 2025](https://arxiv.org/abs/2510.24699)) — but that model was trained for folding.

**Gap:** no study isolates "a separate small model rewrites each tool result before the main model" in a coding agent and reports both success and net tokens.

## Implications for our design

Assumption 1: a cheap selector can replace many main-model decisions. Assumption 2: a small extractor plus span provenance is trustworthy enough to act on. Assumption 3: distil-at-arrival with append-only history preserves cache economics.

- **Keep history append-only; distil once at arrival.** *Supports assumption 3.* A 30–50× hit/miss ratio ([pricing](https://api-docs.deepseek.com/quick_start/pricing)) plus tool-level invalidation cascading through the suffix ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) makes transcript cleanup the most expensive operation available.
- **No single global selector threshold.** *Contradicts assumption 1 as stated.* Savings at fixed quality range 35–85% across benchmarks and routers go near-random out of distribution ([RouteLLM](https://www.lmsys.org/blog/2024-07-01-routellm/)); conformal coverage is marginal and under-covers hard subgroups ([tutorial](https://arxiv.org/abs/2107.07511)). Calibrate per tool/task family, with abstain, and recalibrate when tools change.
- **Measure candidate-set recall before tuning the selector.** *Constrains assumption 1.* A closed-set selector cannot beat its candidate set; Mind2Web's filter was ~85–89% Recall@50, an 11–15% hard ceiling ([Mind2Web](https://arxiv.org/abs/2306.06070)).
- **Treat literal verification as a fabrication filter, not a correctness proof.** *Partially contradicts assumption 2.* It proves occurrence; selection is the error-prone step (53.6 F1), and semantic attribution tops out near 80% ([AttributionBench](https://arxiv.org/abs/2402.15089)). Log "not found at span" separately from "found but wrong".
- **Keep extractor output minimal and non-reasoning.** *Supports assumption 2's shape.* Schema constraints guarantee syntax, not truth ([Azure](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs)), and format restrictions degrade reasoning ([Tam et al.](https://arxiv.org/abs/2408.02442)).
- **Gate the extractor on projected savings.** *Contradicts "always extract".* LLM condensers added 24–94% tokens on short tasks while masking saved 8.6% ([study](https://arxiv.org/abs/2605.18854)); a per-observation call must earn its fixed cost.
- **Restrict optimistic execution to actions with checkable effects.** *Leaves the success claim open.* Plan-then-execute held or improved success ([ReWOO](https://arxiv.org/abs/2305.18323), [LLMCompiler](https://arxiv.org/abs/2312.04511)), but the zero-false-accept result comes from sandboxed state validation ([TomasuLLM](https://arxiv.org/abs/2609.38201)), and SpecAgent still needs the strong model to verify ([SpecAgent](https://arxiv.org/abs/2610.21463)).
- **The architecture as a whole is unvalidated.** *Leaves all three assumptions partly open.* The load-bearing unproven claim is that per-result extraction is net token-negative on long trajectories; the evidence is an extrapolation from short-task condensation.

## Sources

1. Kalai & Vempala, *Calibrated Language Models Must Hallucinate*, STOC 2024 — https://arxiv.org/abs/2311.14648
2. Gao et al., *Enabling LLMs to Generate Text with Citations* (ALCE), EMNLP 2023 — https://arxiv.org/abs/2305.14627
3. Li et al., *AttributionBench*, 2024 — https://arxiv.org/abs/2402.15089
4. Recski et al., *ACL-Verbatim*, 2026 — https://arxiv.org/abs/2605.21102
5. Tam et al., *Let Me Speak Freely?*, 2024 — https://arxiv.org/abs/2408.02442
6. Niu et al., *RAGTruth*, 2024 — https://arxiv.org/abs/2401.00396
7. Azure OpenAI, *Structured outputs* — https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs
8. Chen, Zaharia & Zou, *FrugalGPT*, 2023 — https://arxiv.org/abs/2305.05176
9. Ong et al., *RouteLLM*, 2024 — https://arxiv.org/abs/2406.18665
10. LMSYS, *RouteLLM* report, 2024 — https://www.lmsys.org/blog/2024-07-01-routellm/
11. Angelopoulos & Bates, *A Gentle Introduction to Conformal Prediction*, 2021/22 — https://arxiv.org/abs/2107.07511
12. Mozannar & Sontag, *Consistent Estimators for Learning to Defer*, ICML 2020 — https://arxiv.org/abs/2006.01862
13. Leviathan et al., *Fast Inference via Speculative Decoding*, ICML 2023 — https://arxiv.org/abs/2211.17192
14. Xu et al., *ReWOO*, 2023 — https://arxiv.org/abs/2305.18323
15. Kim et al., *An LLM Compiler for Parallel Function Calling*, ICML 2024 — https://arxiv.org/abs/2312.04511
16. Wang et al., *SpecAgent*, 2026 — https://arxiv.org/abs/2610.21463
17. Yu et al., *TomasuLLM*, 2026 — https://arxiv.org/abs/2609.38201
18. DeepSeek, *Context Caching* — https://api-docs.deepseek.com/guides/kv_cache
19. DeepSeek, *Models & Pricing* (retrieved 2026-11-18) — https://api-docs.deepseek.com/quick_start/pricing
20. Anthropic, *Prompt caching* — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
21. Azure OpenAI, *Prompt caching* — https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/prompt-caching
22. Chintalapati et al., *Memory Condensation Strategies for Coding Agents*, 2026 — https://arxiv.org/abs/2605.18854
23. Deng et al., *Mind2Web*, NeurIPS 2023 — https://arxiv.org/abs/2306.06070
24. Yang et al., *AgentOccam*, 2024 — https://arxiv.org/abs/2410.13825
25. Ye et al., *AgentFold*, 2025 — https://arxiv.org/abs/2510.24699
