# dsh-boost

Cut DeepSeek Harness (DSH) token usage with **tool-receipt projection** and **deterministic
read-only substitution**.

> **Status: v1 is implemented.** Projection, substitution, and the control surface are all in
> place; `npm run build` is clean and the full test suite passes.

## What it does

DSH replays the whole history on every model request. Across the 300 longest sessions measured
locally (`npm run stats`, snapshot at `2026-11-19T03:13:21Z`): 54,141 steps and 54,088 requests,
10,575,904,022 raw tokens in total. The mean is 195,340 tokens per step and 195,531 per request
(median 187,681 per request); 97.01% of the input was cache reads. Tool receipts dominate the
volume (bash 61.75%, read 22.13%, ssh 10.01%), yet the part of a receipt the next step actually
uses is far smaller than the receipt itself.

The plugin does two things:

1. **Projection** — before a tool receipt enters the context, keep its head and tail per tool
   family and replace the middle with a retrievable on-disk handle. The original stays readable;
   the footer names the path. Projection is deterministic and makes no per-call decision.
2. **Substitution** — when a repeated read-only call (`read` / `grep` / `glob`) already has
   deterministic evidence satisfying its guard, commit it without asking the model for another
   decision. With several candidates, a selector that may only return a single label picks one.

The expected v1 range is **3.5% (floor) to 10.0% (ceiling)** of raw `totalTokens`. It was
**estimated offline** against a 300-session corpus during design: not a guarantee, and not a figure
the shipped `session-snapshot.json` can recompute (the snapshot stores aggregate counts only, not
the components of the estimate). The shadow week narrows and then replaces it with measurements.

## Requirements

- Node.js `>=22.18.0` and DSH `>=0.2.2-rc.1 <0.3.0-0` (both in `package.json` `engines`).
- **Substitution is POSIX-only.** On Windows (`win32`) substitution is refused and
  `boost status` reports `ERR_HOST_PLATFORM_UNSUPPORTED` in `degraded`; projection does not
  depend on the platform and keeps working.
- v1 targets the web profile; the desktop profile is not supported.

## Install

`dsh plugin` requires a profile and forwards the remaining arguments to pnpm in that profile
directory:

```bash
# once published to a registry
dsh plugin --profile <name> add dsh-boost

# or from a local checkout (build first; dist/ is not committed)
npm run build
dsh plugin --profile <name> add /absolute/path/to/dsh-boost
```

For the web profile: `dsh plugin --profile web add dsh-boost`. `dsh plugin` forwards the operation
to pnpm, so pnpm must be on `PATH`.

The package's `dsh.bundle.patch` points at `cordis.patch.yml`, so after installation the host
registers it as a profile bundle and the patch's `insert` row lands over the profile root. **You
must restart DSH after installing**: plugins load at host startup, so a session that is already
running will not see the `boost` tool. For the web profile, restart `dsh web`.

## Enable it

After installation the plugin is inert. While `scope.json` does not exist it uses
`DEFAULT_SCOPE`:

```json
{ "version": 2, "revision": 0, "mode": "selected", "workspaceIds": [], "shadow": true, "projection": "shadow" }
```

With no `workspaceIds` no workspace is visible: the protocol section is not injected and every
hook returns the original. The `boost` tool itself is the one scope exemption, so it can always be
called to enable a workspace.

`boost` is a **model tool, not a shell command** — this package has no `bin`. In the conversation,
ask the agent to call it, for example:

> Call the boost tool with `{"cmd":"status"}` and show me the JSON.

The first `status` should answer `ok: true`, with `data.scope.workspaceIds` empty, `revision` `0`,
`shadow` `true`, `projection` `"shadow"`, and `counts` empty (in a fresh session — any earlier tool
call from an out-of-scope session has already recorded `skip:no-scope`). `degraded` containing
`ERR_SCOPE_READ_FAILED` is expected: `scope.json` does not exist yet, so the plugin is on its
fail-closed default. The first successful `scope-set` creates the file.

Then list the workspace to expose:

```json
{
  "cmd": "scope-set",
  "body": {
    "mode": "selected",
    "workspaceIds": ["<workspace-id>"],
    "shadow": true,
    "projection": "shadow"
  },
  "baseRevision": 0
}
```

- `workspaceIds` are the host's workspace UUIDs, not paths; the host maps the agent's cwd to this
  id through its workspace registry. If you cannot find the UUID and this is a single-user
  machine, `"mode": "global"` widens the scope to every *defined* workspace; sessions with no
  workspace stay invisible.
- `baseRevision` is `data.scope.revision` from the status you just read (`0` for the first write).
  This is compare-and-swap: a stale revision returns `ERR_SCOPE_REVISION_CONFLICT`; read `status`
  again and retry.
- `version` and `revision` are store-owned; a `body` carrying either is rejected.

After the write, call `status` again. A healthy result looks like this:

- `ok: true`, `data.scope.workspaceIds` contains the id you wrote, and `data.scope.revision` is
  `1` (each write increments it).
- `data.shadow` is `true` and `data.projection` is `"shadow"` — exactly the shadow-week state.
- `data.degraded` is empty on POSIX with a host token meter and spill backend; `estimate_kind` is
  `"host"` and `fixedOverheadTokens` is a number, not `"unknown"`.
- `data.counts` usually starts empty — but **control calls count too**: while no workspace is
  visible, `boost`'s own calls pass the same post-execute scope gate (there is no boost exemption
  there; the exemption lives at tool registration), each recording one `skip:no-scope`. It grows
  after normal tool calls, for example with `projection-shadow` entries.

Excerpt (illustrative values; ledger fields omitted):

```json
{
  "ok": true,
  "data": {
    "scope": { "mode": "selected", "workspaceIds": ["<workspace-id>"], "revision": 1 },
    "shadow": true,
    "projection": "shadow",
    "degraded": [],
    "fixedOverheadTokens": 772,
    "estimate_kind": "host",
    "counts": { "skip:no-scope": 2 }
  }
}
```

The `counts` in the excerpt is not empty: the two earlier control calls (`status` and `scope-set`)
ran while no workspace was visible yet, and each recorded one `skip:no-scope` (the post-execute
scope gate does not exempt `boost` itself).

`fixedOverheadTokens` is measured once at startup and is the **sum** of both components: protocol
section 379 + `boost` tool schema 393 = 772 (in this checkout). It is never inferred from usage.
**Which number applies to a request depends on scope**: the `boost` tool schema (393) is present
whenever the plugin is assembled — `boost` is the one scope exemption and always stays in the tool
declaration — while the protocol section (379) is injected only when a workspace is visible. Under
`selected + []` the section's text is empty, so the real per-request fixed cost is **393**. `status`
always reports the combined 772 regardless of scope; in the excerpt above a workspace is selected,
so 772 is the true per-request cost there.

## Shadow week

The design chose **shadow first**: record for a week without changing what the model sees, then
decide whether to project and substitute for real. `scope.json` has two independent switches:

| Switch | Value | Behaviour |
|---|---|---|
| `shadow` | `true` | Substitution decisions are recorded only (`kind:'shadow'` receipts); nothing is synthesized or skipped |
| | `false` | Qualifying `read` / `grep` / `glob` calls are actually substituted |
| `projection` | `off` | No projection at all |
| | `shadow` | Price what projection would save; model-visible content is unchanged, no spill write |
| | `on` | Spill the full original first, then replace the receipt with head + footer + tail |

The recommended sequence:

1. **Week one**: use `shadow: true` and `projection: 'shadow'` with the `scope-set` above, and work
   normally.
2. **Read the report**: from a repository checkout, run
   `node scripts/shadow-report.mjs --dir "${DSH_HOME:-$HOME/.dsh}/boost/receipts"`. The script is
   dev-only and is not in the npm tarball. It prints four labels:
   `saveableRatio` (the share of substitution the v1 whitelist could actually deliver: whitelisted
   shadow commits over **all** substitution decisions — the denominator is every substitution
   decision, not just the whitelisted calls; shadow mode records every family, so bash/ssh
   potential shows up in `byFamily`), `byFamily` (hit rate per candidate family), `candidateRecall`
   (recall of the candidate set), and `retrievalUpperBound` (retrieval upper bound; structurally
   `0` during the shadow week because nothing is projected for real).
3. **Turn on projection**: if the report supports it, keep `shadow: true` and set `projection` to
   `'on'`:

   ```json
   { "cmd": "scope-set", "body": { "projection": "on" }, "baseRevision": 1 }
   ```

   `scope-set` patches only the fields you pass; everything else stays as it was. Receipts now get
   replaced, while substitution decisions are still recorded only.
4. **Turn on substitution**: after confirming there is no `content[].thinking` 400 as described in
   [`docs/RELEASE.md`](docs/RELEASE.md) §4, switch the shadow off:

   ```json
   { "cmd": "shadow", "body": false, "baseRevision": 2 }
   ```

`projection: 'on'` depends on the host spill backend. Without it, an over-limit receipt is **not**
projected and the original enters history intact (receipt `projection-skipped:no-spill`,
`status.degraded` with `ERR_HOST_NO_SPILL`). Shadow mode does not need spill.

## Configuration

`config` in `cordis.patch.yml` is **replaced wholesale**, never deep-merged: a missing key falls
back to the plugin default. But note: `resolveConfig` fills **all five tool families** (`read` /
`grep` / `glob` / `bash` / `ssh`) from defaults, so **deleting a family does not disable it** —
deleting `projection.bash` just projects bash with the default 4000/2000/500 window. To truly
disable a family, raise its `triggerChars` above every receipt you will see; the projection byte
cap is 256 KiB, so `300000` prevents the family from triggering at all (there is no per-family
`off` key).

`projection.*` here is a **window**, not a switch. The switch lives in `scope.json`'s
`projection` field and is written by `boost scope-set`.

| Key | Default | Effect |
|---|---|---|
| `projection.read.triggerChars` / `headChars` / `tailChars` | 3000 / 2000 / 500 | Keep the first 2000 and last 500 characters of `read` receipts longer than 3000 characters |
| `projection.grep.*` | 700 / 400 / 100 | `grep` window |
| `projection.glob.*` | 700 / 400 / 100 | `glob` window |
| `projection.bash.*` | 4000 / 2000 / 500 | `bash` window |
| `projection.ssh.*` | 2000 / 1200 / 300 | `mcp__ssh__*` (such as `mcp__ssh__execute-command`) window |
| `admission.thresholdTokens` | 1024 | Minimum net saving per candidate before substitution; a single deterministic candidate is exempt |
| `selector.maxTokens` | 512 | Output budget for the multi-candidate selector (its input plus output bound is deducted from the saving) |
| `stepsPerTurn` | 8 | Maximum substituted steps per turn |
| `horizonSteps` | 20 | Remaining-step horizon used when the session average cannot be computed |
| `historyTurns` | 5 | Number of recent turns averaged for the step count |

Characters are Unicode code points. Error receipts and receipts above 256 KiB are never projected.

The invariant is **not** `triggerChars >= headChars + tailChars + 1`. The real replacement is head
line + head + footer + tail + 3 newlines; the footer is produced by the host's `formatSpillNotice`
and is about 190 characters (68-character locator, 5-digit omitted-byte count, the host's fixed
retrieval hint). With the grep/glob defaults of 400+100:
`400 + 100 + 50 (head line) + 192 (footer) + 3 = 745 > 700`. So a receipt just over 700 — up to
about 745 — is judged cuttable by `truncate`, but `projectApply` assembles a replacement that is
not shorter than the original and returns the original. That is a dead band, not a net loss. The
runtime `assembled.length >= text.length` check guarantees projection never makes a receipt
longer; to remove the dead band, raise `triggerChars` to at least that sum (for example 800 for
grep/glob) or shrink the windows. The footer length varies with the locator and digit count.

(`projection: 'shadow'` prices only the `(Omitted N bytes.)` clause, not the locator or the full
footer, so the shadow account's `after` is a lower bound; the apply path re-checks after the write.)

## Bundle patch

`cordis.patch.yml` is one `insert` over the profile root:

```yaml
- insert:
    - id: dsh-boost
      name: 'dsh-boost'
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

The host treats a row as installed when two **independent** equalities hold:

```text
row.id   === entry.options.id
row.name === entry.options.name
```

`id` and `name` do **not** have to equal each other: the host's own `dsh-mcp-btwy` patch uses
`id: dsh-mcp-server` and `name: dsh-mcp-btwy`. This package keeps all four names identical:
`dsh-boost` is the npm package name, the exported plugin `name`, and the patch row's `id` and
`name`. If either equality fails, the host **skips the row silently**; there is no error.

## State, rollback, and removal

State lives in `$DSH_HOME/boost/` (`$DSH_HOME` falls back to `~/.dsh` when unset):

- `scope.json` — the single source of truth for the exposure surface (version 2, with revision).
- `scope.lock` — the short-lived write lock, removed after a normal write.
- `receipts/<encoded-session>.jsonl` — append-only receipts holding metadata and a preview of the
  first 256 code points, not the full stdout.

With `projection: 'on'`, the complete original is written to the host spill backend **before** the
replacement happens, and the footer locator can be read with `read` / `grep`. Projection never
discards the only copy; if the spill write fails, nothing is replaced (the receipt records
`spill-failed`; a footer failure records `footer-failed`).

Rollback and disablement:

- **Turn both behaviours off** (no projection, no substitution; the protocol section is still
  injected for the selected workspaces, substitution decisions are still recorded in shadow, and
  the fixed overhead remains):

  ```json
  { "cmd": "scope-set", "body": { "projection": "off", "shadow": true }, "baseRevision": 1 }
  ```

- **Remove one workspace (fully inert)**: drop it from `workspaceIds`; with an empty list the
  protocol section, projection, and substitution all stop.

  ```json
  { "cmd": "scope-set", "body": { "workspaceIds": [] }, "baseRevision": 2 }
  ```

- **Uninstall the plugin**: `dsh plugin --profile <name> remove dsh-boost`, then restart DSH.
- Deleting `$DSH_HOME/boost` clears the scope and receipts (back to defaults), but does not delete
  the original files already written to the host spill backend.

## Host dependencies

`inject` lists hard dependencies: `tools`, `llm`, `systemPrompt`. Missing any of them makes the
plugin fail to load.

| Dependency | Form | When missing |
|---|---|---|
| `tokenMeter` | soft (`ctx.get('tokenMeter')`) | Substitution is refused; projection keeps working and its accounting records `unknown` (never a fabricated number); `status.degraded` reports `ERR_HOST_NO_TOKENMETER` |
| `spillStore` | soft (`ctx.get('spillStore')`) | With `projection: 'on'`, an over-limit receipt is not projected (evidence preserved), `projection-skipped:no-spill`; `status.degraded` reports `ERR_HOST_NO_SPILL` |
| `@deepseek-ai/dsh-token-meter/estimate` | soft (dynamic import) | Fixed overhead cannot be measured, so `fixedOverheadTokens` is `'unknown'`; `status.degraded` reports `ERR_HOST_NO_ESTIMATOR` |
| `win32` platform | runtime `isPosixOnly()` check | Substitution is refused, projection still works; `status.degraded` reports `ERR_HOST_PLATFORM_UNSUPPORTED` |
| Step-level `when` on `tools.resolve` | soft probe | The whole family (including the `boost` tool) is not registered, `ERR_HOST_NO_STEP_WHEN`; it normally surfaces in the registration warning because `status` itself is unavailable |

`ERR_HOST_NO_TOKENMETER` and `ERR_HOST_NO_ESTIMATOR` are **two different things**; do not merge
them. The first is the host service (`ctx.get('tokenMeter')`) being absent, which refuses
substitution. The second is the pure estimate package
`@deepseek-ai/dsh-token-meter/estimate` being unreachable, which only makes the fixed-overhead
figure unknown. One can exist without the other, and merging them sends the operator to the wrong
host. `ERR_HOST_NO_SPILL` is reported only with `projection: 'on'`; shadow mode never touches
spill, and reporting it there would be noise.

`tokenMeter` and `spillStore` must not be added to `inject`: with a host that lacks them the
plugin would fail to load outright, and the "refuse substitution, keep projecting, preserve
evidence" degraded path would be unreachable.

## Scope of v1

- Only two things: **replace tool receipts in place** and **substitute read-only calls** (`read` /
  `grep` / `glob`).
- **No batched tool execution** (no PTC / `run_code`; design N1).
- **No deduplication or merging of tool calls** (design N5).
- **No desktop profile** (design D6).
- Does not replace or take over DSH's compaction, pruning, or spill decisions (design N3);
  projection changes only the model-visible content and keeps the original in the host spill.
- No model training or weight changes (N2); no attempt at the paper's 87.93% (N4).
- No 10% promise: 3.5% is the floor and 10% the ideal upper bound; the shadow week only narrows
  the range.

## Documentation

These documents live in the **repository**, not in the npm tarball (`files` ships only `dist`,
`src`, `locale`, `cordis.patch.yml`, both READMEs, `LICENSE`, and `NOTICE`). If you are reading on
the npm page, open them from the repository.

| Document | Contents |
|---|---|
| [Design](docs/superpowers/specs/2026-11-18-dsh-token-efficiency-design.md) | Goals, evidence, architecture, contracts, measurement, risks, release shape |
| [Host contracts appendix](docs/superpowers/plans/2026-11-18-host-contracts.md) | Interface reference copied line by line from the host sources |
| [Three-tier delegation research](docs/research/2026-11-18-three-tier-delegation.md) | 25 primary sources on caching, routing thresholds, compression, and verification |
| [Release acceptance](docs/RELEASE.md) | `npm pack` / isolated install, both soft-dependency degraded paths, the 20-task regression gate, and the shadow week and stats recompute |

## License

Apache-2.0. The mechanisms are ported from [HarnessMM](https://github.com/YuhuaJiang2002/HarnessMM)
(Apache-2.0); a `NOTICE` ships with the package.