# dsh-boost

Cut DeepSeek Harness (DSH) token usage with **tool-receipt projection** and **deterministic
read-only substitution**.

> **Status: skeleton.** Plugin metadata, the bundle patch row, the config surface, and the shared
> types are in place; the projection and substitution behaviour modules are not implemented yet.
> Do not enable this version on a production profile.

## What it solves

DSH replays the whole history on every model request. Across the 300 longest sessions measured
locally, each step replayed 194k tokens on average (per request: mean 194,473, median 185,590),
and 97.1% of that input was cache reads. Tool receipts dominate the volume (bash 63.0%, read
20.8%, ssh 9.1%), yet the part of a receipt the next step actually uses is far smaller than the
receipt itself.

The plugin does two things:

1. **Projection** — before a tool receipt enters the context, keep its head and tail per tool
   family and replace the middle with a retrievable on-disk handle. The original stays readable;
   the footer names the path. Projection is deterministic and makes no per-call decision.
2. **Substitution** — when a repeated read-only call (`read` / `grep` / `glob`) already has
   deterministic evidence satisfying its guard, commit it without asking the model for another
   decision. With several candidates, a selector that may only return a single label picks one.

The expected v1 range is **3.5% (floor) to 10.0% (ceiling)** of raw `totalTokens`.

## Installation

The plugin ships as an npm package carrying `cordis.patch.yml`; once `dsh plugin add` resolves and
installs it, the patch inserts one `dsh-boost` row over the profile root.

Row identity is a hard constraint: the patch row's `id`, its `name`, the plugin export name, and
the npm package name must all agree. The host treats a row as installed only when
`row.id === entry.options.id && row.name === entry.options.name`; if one is missing the row is
**skipped silently**.

`@deepseek-ai/dsh-llm` is pinned to `0.2.2-rc.4` in both `peerDependencies` and `devDependencies`:
the registry's `latest` tag points at `0.0.1-rc.1`, an unrelated old API, so a range would install
the wrong one.

## Configuration

`config` in `cordis.patch.yml` is **replaced wholesale**, never deep-merged: a missing key falls
back to the plugin default, and the keys listed there are the profile's complete config surface.
Any tool family not listed is never projected.

| Key | Default | Effect |
|---|---|---|
| `projection.read.triggerChars` / `headChars` / `tailChars` | 3000 / 2000 / 500 | Keep the first 2000 and last 500 characters of `read` receipts longer than 3000 characters |
| `projection.grep.*` | 700 / 400 / 100 | `grep` window |
| `projection.glob.*` | 700 / 400 / 100 | `glob` window |
| `projection.bash.*` | 4000 / 2000 / 500 | `bash` window |
| `projection.ssh.*` | 2000 / 1200 / 300 | `mcp__ssh__execute-command` window |
| `admission.thresholdTokens` | 1024 | Minimum net saving per candidate before substitution; a single deterministic candidate is exempt |
| `selector.maxTokens` | 512 | Output budget for the multi-candidate selector (its input plus output bound is deducted from the saving) |
| `stepsPerTurn` | 8 | Maximum substituted steps per turn |
| `horizonSteps` | 20 | Remaining-step horizon used when the session average cannot be computed |
| `historyTurns` | 5 | Number of recent turns averaged for the step count |

Invariant: `triggerChars >= headChars + tailChars + footer (~110B) + 1`. The window must stay
strictly below the trigger threshold; otherwise a band exists where projection triggers but
cannot shrink anything, and every receipt in it gets more expensive.

## Host dependencies

`inject` lists hard dependencies: `tools`, `llm`, `systemPrompt`. Missing any of them makes the
plugin fail to load.

| Service | Form | When missing |
|---|---|---|
| `tokenMeter` | soft (`ctx.get('tokenMeter')`) | Substitution is refused; projection keeps working and its accounting records `unknown` (never a fabricated number), `ERR_HOST_NO_TOKENMETER` |
| `spillStore` | soft (`ctx.get('spillStore')`) | With `projection: 'on'`, an over-limit receipt is not projected (evidence is preserved), `projection-skipped:no-spill`, `ERR_HOST_NO_SPILL` |
| Step-level `when` on `tools.resolve` | soft probe | The whole family is not registered, `ERR_HOST_NO_STEP_WHEN` |

`tokenMeter` and `spillStore` must not be added to `inject`: with a host that lacks them the
plugin would fail to load outright, and the "refuse substitution, keep projecting, preserve
evidence" degraded path would be unreachable.

## Documentation

| Document | Contents |
|---|---|
| [Design](docs/superpowers/specs/2026-11-18-dsh-token-efficiency-design.md) | Goals, evidence, architecture, contracts, measurement, risks, release shape |
| [Host contracts appendix](docs/superpowers/plans/2026-11-18-host-contracts.md) | Interface reference copied line by line from the host sources |
| [Three-tier delegation research](docs/research/2026-11-18-three-tier-delegation.md) | 25 primary sources on caching, routing thresholds, compression, and verification |

## License

Apache-2.0. The mechanisms are ported from [HarnessMM](https://github.com/YuhuaJiang2002/HarnessMM)
(Apache-2.0); a `NOTICE` ships with the package.