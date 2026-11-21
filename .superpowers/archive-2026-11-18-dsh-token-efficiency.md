# Archive — 2026-11-18-dsh-token-efficiency

Phase 4 close-out for a Phase-1-skipped change (`.superpowers/.phase1-skipped`),
so there is no `openspec/changes/` tree to move: the deliverables are the
design doc, the plan, the implementation and the published package.

## Deliverables

| artifact | path |
|---|---|
| requirement record | `docs/superpowers/clarifications/2026-11-18-dsh-token-efficiency.md` |
| design | `docs/superpowers/specs/2026-11-18-dsh-token-efficiency-design.md` |
| host contract appendix | `docs/superpowers/plans/2026-11-18-host-contracts.md` |
| implementation plan | `docs/superpowers/plans/2026-11-18-dsh-token-efficiency.md` |
| research | `docs/research/2026-11-18-three-tier-delegation.md` |
| release runbook | `docs/RELEASE.md` |
| code | `src/`, `test/` (778 tests) |

## Gates

- Gate 0 — design approved by the user (m00234 and the round-3 adjudication).
- Gate 1 — skipped by user decision (m00705, `PP-03=skip`).
- Gate 2 — plan, six rounds, `.superpowers/.gate-passed-2`.
- Gate 3 — code, six UltraReview rounds, `.superpowers/.gate-passed-3`.
  Round 6 closed with `p0=0 p1=0 p2=0 p3=3`; Step 3 supervision for round 6 was
  not dispatched (the user asked to stop after that round) and is declared
  degraded in `.superpowers/review/round6-merged.md`.
- Gate 4 — this file: full suite 778/778, `typecheck`/`build`/`verify:package`
  green, release `dsh-boost@0.1.4` published and installable.

## Known open items, recorded rather than waived

1. The synthesized turn's reasoning block does not reach the wire: the turn has
   no `replayState`, so `toPiAssistant` takes the `foreignAssistant` path and
   pi-ai's `transformMessages` drops thinking blocks. If the route is an
   Anthropic-compatible thinking endpoint, a substituted turn may 400 with
   `content[].thinking`. Detection signal: that 400 on the first genuinely
   replaced turn.
2. The smoke runner and the locator-retrieval integrity check were never
   delivered. The user's decision waived the corpus, not these.
3. §5.4-4's uncuttable list is now implemented for exit codes and error flags
   rescued from the cut-away middle; a marker the two windows do not bracket is
   still not recoverable in general.
4. No test exercises the two degradation paths in an isolated install
   (design §6.2); the in-process paths are covered.
5. `ERR_SCOPE_ABORTED` is a seventh scope code; the design's §5.5 table lists
   six.
6. The release gate's negative cases are proven by hand, not pinned by a test.
