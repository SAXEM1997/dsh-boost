# dsh-boost

Cut DeepSeek Harness (DSH) token usage with **tool-receipt projection** and **deterministic
read-only substitution**.

> **Status: v1 is implemented.** Projection, substitution, and the control surface are all in
> place; `npm run build` is clean and the full test suite passes. The benefit range is an
> **ex-ante design estimate** (3.5% lower bound / 10.0% ideal upper bound; ~0.4% honest net
> floor); nothing in the deliverable can recompute it — see below.

## What it does

DSH replays the whole history on every model request. Across the 300 longest sessions measured
locally (`npm run --silent stats` — without `--silent`, npm prints its `> dsh-boost@0.1.0 stats`
banner to stdout, so use `--silent` or `node scripts/session-stats.mjs` for machine-readable
output; snapshot at `2026-11-19T03:13:21Z`): 54,141 steps and 54,088 requests,
10,575,904,022 raw tokens in total. The mean is 195,340 tokens per step and 195,531 per request
(median 187,681 per request); 97.01% of the input was cache reads. Tool receipts dominate the
volume (bash 61.75%, read 22.13%, ssh 10.01%), yet the part of a receipt the next step actually
uses is far smaller than the receipt itself.

The plugin does two things:

1. **Projection** — before a tool receipt enters the context, keep its head and tail per tool
   family and replace the middle with a retrievable on-disk handle. The original stays readable;
   the footer names the path. Projection is deterministic and makes no per-call decision.
2. **Substitution** — when a repeated read-only call (`read` / `grep` / `glob`) in a plan already
   has deterministic evidence satisfying its guard, commit it without asking the model for another
   decision. With several candidates, a single-label selector — one auxiliary request
   (`maxTokens` 512 plus its input) — picks one. This is a **narrowing** of original requirement
   2.2: the request asked Jev to score each tool result and decide whether it could feed the next
   tool; v1 only picks one of several candidates on the same receipt, with no per-result scoring
   (see the 2.2 row and decision 9 in the
   [clarification record](docs/superpowers/clarifications/2026-11-18-dsh-token-efficiency.md)).
   For the three substituted tools, the plan's
   `$public` argument binding (copying a value from an earlier receipt into a later call's
   arguments) is effective in practice only for `glob`'s single-token output; `read` and `grep`
   emit line-numbered or bare-path output that the identifier projection cannot match, so those
   calls fall back to the model.

The **ex-ante estimate** for v1 is **3.5% (lower bound) to 10.0% (ideal upper bound)** of raw
`totalTokens`; **3.5% is not a floor** — it is the lower bound of an offline estimate against a
300-session corpus, and its substitution component (2.70%) is a **ceiling** that must not be
counted as a floor. The honest net floor is about **0.4%** (projection gross ~0.8% minus ~0.4%
fixed per-request overhead). It is not a guarantee, and not a figure the shipped
`session-snapshot.json` can recompute (the snapshot stores aggregate counts only, not the
components of the estimate) — **nothing in the deliverable can recompute it**. Nor can the shadow
week turn the range into a measured percentage: the shadow report outputs four ratios only (see
"Shadow week"), with no total-token denominator, and `boost status` carries absolute values only;
replacing the range with measurements needs a denominator statistic that a later version must add.

## Requirements

- Node.js `>=24.9.0` and DSH `0.2.2-rc.4` (an exact pin, not a range; both in `package.json`
  `engines`; the Node floor matches the host `@deepseek-ai/dsh@0.2.2-rc.4`).
- **The package declares no peerDependencies**: installing it pulls in no `@deepseek-ai/*`
  package, and the module loads without any of them; the runtime capabilities (`tokenMeter`,
  `spillStore`, the estimator, the footer formatter) are provided by the DSH host process, and a
  missing one degrades (see "Host dependencies").
- **Substitution is POSIX-only.** On Windows (`win32`) substitution is refused and
  `boost status` reports `ERR_HOST_PLATFORM_UNSUPPORTED` in `degraded`; projection does not
  depend on the platform and keeps working.
- v1 targets the web profile; the desktop profile is not supported.

## Install

`dsh plugin` requires a profile and forwards the remaining arguments to pnpm in that profile
directory:

```bash
# install from the registry (0.1.0 is the first release and is latest)
dsh plugin --profile <name> add dsh-boost@^0.1.0

# or from a local checkout (build first; dist/ is not committed)
npm run build
dsh plugin --profile <name> add /absolute/path/to/dsh-boost
```

For the web profile: `dsh plugin --profile web add dsh-boost@^0.1.0`. `dsh plugin` forwards the operation
to pnpm, so pnpm must be on `PATH`.

The package is ESM (`"type": "module"`) and the `.` entry of `exports` also maps `require` /
`default`: on Node >= 24.9, `require('dsh-boost')` loads the very same code as `import`. Nothing
is built inside the installed package (`files` ships only `dist`, `locale`, `cordis.patch.yml`,
both READMEs, `LICENSE`, and `NOTICE` — no `src/`; the `dist` source maps inline the sources).

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

With no `workspaceIds` no workspace is visible: the protocol section is not injected and
projection and substitution pass through unchanged — but each tool call still records one
`skip:no-scope` receipt. The `boost` tool itself is the one scope exemption, so it can always be
called to enable a workspace.

`boost` is a **model tool, not a shell command** — this package has no `bin`, and every step of
enabling it (status, scope-set, shadow) is a tool call inside the conversation; there is no CLI
equivalent. In the conversation, ask the agent to call it, for example:

> Call the boost tool with `{"cmd":"status"}` and show me the JSON.

The first `status` should answer `ok: true`, with `data.scope.workspaceIds` empty, `revision` `0`,
`shadow` `true`, `projection` `"shadow"`, and `counts` empty (in a fresh session — any earlier tool
call from an out-of-scope session has already recorded `skip:no-scope`). The first `status` does
**not** report `ERR_SCOPE_READ_FAILED` merely because `scope.json` is missing: a missing file is
the clean default (`ENOENT` carries no degradation code, `src/scope/store.ts`); on a fresh root
with the host capabilities in place, `degraded` is simply an empty array. On the `status` read
path,
`ERR_SCOPE_READ_FAILED` means the file **exists but cannot be read** (permissions, I/O, a
directory in its place, …) — not a normal first run; fix it first. The first successful `scope-set` creates the file.

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
  id through its workspace registry. **Finding the UUID is itself friction**: either ask the
  host / dig through session records, or read `tables.workspaces` (the id ↔ path table) in
  `$DSH_HOME/storages/workspace.json` yourself — v1 ships no command that does this for you. If
  you cannot find the UUID and this is a single-user machine, `"mode": "global"` widens the
  scope to every *defined* workspace; sessions with no workspace stay invisible.
- `baseRevision` is `data.scope.revision` from the status you just read (`0` for the first write).
  This is compare-and-swap: a stale revision returns `ERR_SCOPE_REVISION_CONFLICT`; read `status`
  again and retry. When the caller's cancellation signal interrupts the write, the tool returns
  `ERR_SCOPE_ABORTED`: the lock is released, `scope.json` is untouched, and retrying with a
  freshly read revision is safe — no residue is left behind.
- `version` and `revision` are store-owned; a `body` carrying either is rejected.

After the write, call `status` again. A healthy result looks like this:

- `ok: true`, `data.scope.workspaceIds` contains the id you wrote, and `data.scope.revision` is
  `1` (each write increments it).
- `data.shadow` is `true` and `data.projection` is `"shadow"` — exactly the shadow-week state.
- `data.degraded` is empty on POSIX with a host token meter and spill backend; `estimate_kind` is
  `"host"` and `fixedOverheadTokens` is a number, not `"unknown"`. If the estimate package
  `@deepseek-ai/dsh-token-meter/estimate` is unreachable, `fixedOverheadTokens` is the string
  `"unknown"` (not 0) and `degraded` carries `ERR_HOST_NO_ESTIMATOR`; `estimate_kind` may still be
  `"host"` because the token-meter service is present — the two are different things.
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
    "fixedOverheadTokens": 778,
    "estimate_kind": "host",
    "counts": { "skip:no-scope": 2 }
  }
}
```

The `counts` in the excerpt is not empty: the two earlier control calls (`status` and `scope-set`)
ran while no workspace was visible yet, and each recorded one `skip:no-scope` (the post-execute
scope gate does not exempt `boost` itself).

`fixedOverheadTokens` is measured once at startup and is the **sum** of both components: protocol
section 379 + `boost` tool schema 399 = 778 (in this checkout). It is never inferred from usage;
when the estimate package is unreachable it is the string `'unknown'`, not 778 and not 0, and
`status.degraded` also carries `ERR_HOST_NO_ESTIMATOR`. **Which number applies to a request
depends on scope**: the `boost` tool schema (399) is present whenever the plugin is assembled —
`boost` is the one scope exemption and always stays in the tool declaration — while the protocol
section (379) is injected only when a workspace is visible. Under `selected + []` the section's
text is empty, so the real per-request fixed cost is **399**. `status` reports the combined 778
(or `'unknown'` when the estimate package is unreachable) regardless of scope; in the excerpt
above a workspace is selected, so 778 is the true per-request cost there.

## Shadow week

The design chose **shadow first**: record for a week — no synthesized turns, no skipped calls,
projection priced but never applied — then decide whether to project and substitute for real.
**"Changes nothing the model sees" would be false**: whenever a workspace is visible the protocol
section (379 tokens) is injected into the system prompt, and a multi-candidate plan still makes a
**real selector call** (a separate auxiliary model request). By design the shadow week saves
nothing; it produces only the four ratios below.

Of those ratios, `saveableRatio`, `byFamily`, and `candidateRecall` can decide **whether the
substitution side is worth turning on**: how many substitution decisions the whitelist could
actually deliver, which tool families the hits land in, and how high candidate recall is — that
is, whether substitution would fire at all and where. They **cannot decide release**: that
decision was fixed during design; v1 ships as a normal release and does not gate on shadow-week
savings. They also **cannot measure savings**: the report has no total-token denominator, and
`retrievalUpperBound` is structurally `0` during the shadow week (it only counts applied
`projection:'on'` retrievals), so it cannot even bound projection's retrieval damage. Projection
is released on the visibility contract (the original stays retrievable through the footer) and
post-hoc detection, not on shadow labels.
`scope.json` has two independent switches:

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
   `node scripts/shadow-report.mjs --dir "<root>/receipts"`, where `<root>` is the `root=` printed
   by the assembly log (that is, `<dshHome>/boost`; `dshHome` config wins over `$DSH_HOME`, and
   with neither set it falls back to `~/.dsh`). The script is dev-only and is not in the npm
   tarball. It prints four labels:
   `saveableRatio` (the share of substitution the v1 whitelist could actually deliver: whitelisted
   shadow commits over **all** substitution decisions — the denominator is every substitution
   decision, not just the whitelisted calls; shadow mode records every family, so bash/ssh
   potential shows up in `byFamily`), `byFamily` (hit rate per candidate family), `candidateRecall`
   (recall of the candidate set), and `retrievalUpperBound` (retrieval upper bound; structurally
   `0` during the shadow week because nothing is projected for real).
3. **Turn on projection**: projection is not released on shadow labels (its basis is the
   visibility contract and post-hoc detection); once the host spill backend is available, keep
   `shadow: true` and set `projection` to `'on'`:

   ```json
   { "cmd": "scope-set", "body": { "projection": "on" }, "baseRevision": 1 }
   ```

   `scope-set` patches only the fields you pass; everything else stays as it was. Receipts now get
   replaced, while substitution decisions are still recorded only.
4. **Turn on substitution**: when the shadow report shows acceptable whitelist hits and candidate
   recall, just switch the shadow off — **checking before the switch is a no-op**: the shadow
   week never synthesizes a turn, so a `content[].thinking` 400 is
   structurally impossible and a check made before switching it off can only ever read "not
   seen". After `shadow` becomes `false`, check for that 400 in the **first genuinely
   substituted round** as described in [`docs/RELEASE.md`](docs/RELEASE.md) §4, and keep
   recording it in every substitution window after that:

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
| `dshHome` | `$DSH_HOME`, else `~/.dsh` | State-root prefix: the plugin uses `<dshHome>/boost`, and it wins over `$DSH_HOME`; a blank or non-string value counts as unset, and a relative path is resolved once against the cwd at assembly. The assembly log prints the resolved `root=` |

Characters are Unicode code points. Error receipts and receipts above 256 KiB are never projected.

The invariant is **not** `triggerChars >= headChars + tailChars + 1`. The real replacement is head
line + head + footer + tail + 3 newlines; the footer is produced by the host's `formatSpillNotice`
and is about 196 characters (68-character locator, 5-digit omitted-byte count, the host's fixed
retrieval hint). With the grep/glob defaults of 400+100:
`400 + 100 + 50 (head line) + 196 (footer) + 3 = 749 > 700`. So a receipt just over 700 — up to
about 749 — is judged cuttable by `truncate`, but `projectApply` assembles a replacement that is
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

The host performs **no id/name matching on top-level `insert` rows**: the loader
(cordis-plugin-include's `applyEntryPatches`) pushes them straight into the assembly plan —
there is no "mismatch means the row is silently skipped" path. The two equalities serve another
purpose: **the plugin manager uses them to attribute a running entry to this bundle's row** (the
in-use / addressable determination in `dsh-plugin-manager`, see `listPlugins` / `removeBundle`):

```text
row.id   === entry.options.id
row.name === entry.options.name
```

`id` and `name` do **not** have to equal each other: the third-party plugin `dsh-mcp-btwy` (a
GitHub package installed into the user's profile, not a patch the host ships) uses
`id: dsh-mcp-server` and `name: dsh-mcp-btwy`. This package keeps all four names identical:
`dsh-boost` is the npm package name, the exported plugin `name`, and the patch row's `id` and
`name`, so the plugin manager can attribute the running entry to this bundle and address or
remove it through the profile patch. When an equality fails the row **still assembles** — it
only becomes unaddressable in the management plane (its read/write state and removal detection
break) — and a `name` pointing at a nonexistent package fails the load **loudly**, not
silently.

## State, rollback, and removal

State lives in `<dshHome>/boost/`: `dshHome` config **wins over** `$DSH_HOME`, and with neither
set it falls back to `~/.dsh`; the assembly log prints the resolved `root=` (that is,
`<dshHome>/boost`).

- `scope.json` — the single source of truth for the exposure surface (version 2, with revision).
- `scope.lock` — the short-lived write lock, removed after a normal write.
- `receipts/<encoded-session>.jsonl` — append-only receipts. Every line carries metadata, a
  preview of the first 256 code points of the receipt (never the full stdout), and **the bound
  arguments `args` (model-written: above 2048 code points they are stored as visibly truncated
  JSON with an `args_truncated` flag; nesting deeper than 64 levels sets `args_depth_truncated`
  and replaces the deeper subtree with `{ "truncated_depth": 64 }` — `write` / `edit` arguments
  can carry whole file contents and land here too)**. **Only substitution receipts** also carry
  the plan goal (≤256 code points) and guards (≤8, each ≤300 code points): `kind:'substitute'`,
  `kind:'substitute-settled'`, and `kind:'shadow'` with `code:'ok'`. `kind:'shadow'` is not
  substitution-only — projection shadowing also writes `kind:'shadow'`, but with
  `code:'projection-shadow'`, and that is a projection receipt with no plan evidence; projection
  and skip receipts carry `preview` and `args` only.

`boost status` replays the projection ledger at each receipt's own `horizon_steps`; a receipt
written before that field existed is replayed at the current horizon and counted in
`projection_horizon_reestimated`, while `projection_horizon_steps` reports the horizon currently
in effect (the minimum over live sessions, falling back to `horizonSteps` when no history exists).

With `projection: 'on'`, the complete original is written to the host spill backend **before** the
replacement happens, and the footer locator can be read with `read` / `grep`. Projection never
discards the only copy; if the spill write fails, nothing is replaced (the receipt records
`projection-skipped:spill-failed`; a footer rendering failure records
`projection-skipped:footer-failed`; a missing footer renderer records
`projection-skipped:no-footer`, see "Host dependencies").

Rollback and disablement (the `baseRevision` values below are `3` after the recommended
"Enable it" + "Shadow week" sequence — enablement ends at `1`, and the two shadow-week steps add
one each — and `4` after the first rollback; in practice always use the `data.scope.revision` you
just read from `status`, never copy these):

- **Turn both behaviours off** (no projection, no substitution; the protocol section is still
  injected for every still-visible workspace — the selected ones under `selected`, every defined
  one under `global` — substitution decisions are still recorded in shadow, and the fixed
  overhead remains):

  ```json
  { "cmd": "scope-set", "body": { "projection": "off", "shadow": true }, "baseRevision": 3 }
  ```

- **Go back to fully inert**: set `mode` back to `selected` and empty the list. **Note that
  `workspaceIds` matters only in `selected` mode**: `isVisible` is true under `mode:"global"` for
  every **defined** workspace (`src/scope/doc.ts` — the `global` branch never reads the list; a
  session whose `workspaceId` is undefined stays invisible), so **while in `global`, writing only
  `workspaceIds: []` stops nothing** — projection and substitution keep running while you believe
  you have rolled back. Under `selected`, removing one workspace is
  enough; under `global` you must switch the mode at the same time:

  ```json
  { "cmd": "scope-set", "body": { "mode": "selected", "workspaceIds": [] }, "baseRevision": 4 }
  ```

  With `selected` and an empty list the protocol section, projection, and substitution all stop
  (only the `boost` tool schema's standing cost remains).

- **Uninstall the plugin**: `dsh plugin --profile <name> remove dsh-boost`, then restart DSH.
- Deleting `<dshHome>/boost` clears the scope and receipts (back to defaults), but does not delete
  the original files already written to the host spill backend.

## Host dependencies

`inject` lists hard dependencies: `tools`, `systemPrompt`. Missing either makes the plugin fail
to load. `llm` is soft (only the selector uses it); when absent the selector falls back with
`selector-unavailable` and the rest of projection and substitution keeps working.

| Dependency | Form | When missing |
|---|---|---|
| `workspaceRegistry` | soft (`ctx.get('workspaceRegistry')`) | **The workspace is invisible**: a cwd can never map to a workspace id, so everything fails closed as invisible — no protocol section, projection and substitution all skipped, only `skip:no-scope` receipts accumulating; `status.degraded` reports `ERR_HOST_NO_WORKSPACE_REGISTRY`. This is the host-capability explanation **when a workspace should be visible**, not the only explanation for "installed but nothing happens": the shipped default `selected + []` is inert by design and reports no error; a missing token meter also refuses real substitution; a `complete: true` section also suppresses the protocol |
| `tokenMeter` | soft (`ctx.get('tokenMeter')`) | Substitution is refused; projection keeps working and its accounting records `unknown` (never a fabricated number); `status.degraded` reports `ERR_HOST_NO_TOKENMETER` |
| `spillStore` | soft (`ctx.get('spillStore')`) | With `projection: 'on'`, an over-limit receipt is not projected (evidence preserved) and the receipt records `projection-skipped:no-spill`; `status.degraded` reports `ERR_HOST_NO_SPILL` (the live probe only in on mode; a historical receipt reports it in any mode) |
| `@deepseek-ai/dsh-spill-policy/notice` | soft (dynamic import) | The spill backend exists but the footer renderer `formatSpillNotice` cannot be loaded/is absent: apply-mode projection cannot build its footer and skips every receipt (`projection-skipped:no-footer`); `status.degraded` reports `ERR_HOST_NO_SPILL_NOTICE`. This is a different absence from `ERR_HOST_NO_SPILL` (no spill backend at all) |
| (spill backend present but failing) | — | Every `saveText` is rejected: the receipt records `projection-skipped:spill-failed` and `status.degraded` reports **`ERR_HOST_SPILL_FAILING`**. This is a **third** state — neither "no backend" nor "no footer renderer" — and telling an operator to restore the spill package would send them after a package that is installed and failing |
| `@deepseek-ai/dsh-token-meter/estimate` | soft (dynamic import) | Fixed overhead cannot be measured, so `fixedOverheadTokens` is `'unknown'`; `status.degraded` reports `ERR_HOST_NO_ESTIMATOR` |
| `win32` platform | runtime `isPosixOnly()` check | Substitution is refused, projection still works; `status.degraded` reports `ERR_HOST_PLATFORM_UNSUPPORTED` |
| Host version line | startup check of the `@deepseek-ai/dsh-app-boot` version | A version other than `0.2.2-rc.4` logs `ERR_HOST_VERSION_MISMATCH` and loads anyway — advisory only, not a `status.degraded` code. An undeterminable version logs an info line, no code |
| Receipt shard readability | `boost status` full scan (not a dependency) | When at least one receipt shard cannot be read (EACCES, a directory named `x.jsonl`, …), `status.degraded` carries `ERR_RECEIPTS_UNREADABLE`; `status` stays a **total over the healthy shards** — they are still counted — so the figures may be incomplete. Check permissions and stray entries in `<dshHome>/boost/receipts/`, fix, and re-run `status`, comparing counts |
| Receipt shard count | `boost status` full scan (not a dependency) | When more than 256 shards exist, `status` counts only the first 256 by encoded name and `status.degraded` carries `ERR_RECEIPTS_TRUNCATED`; every count is therefore a **lower bound**. Shards are never pruned automatically; archive or move old session shards and re-run `status` |
| Prompt assembly waterfall | outgoing-request probe (not a dependency) | When the host's `complete: true` prompt section replaces the assembled system prompt after the waterfall and the protocol section never reaches the request, `status.degraded` carries `ERR_HOST_COMPLETE_SECTION`; substitution and projection fail closed for the affected requests (the plugin stays inert although the workspace is visible). Find the complete section overriding the waterfall (usually another plugin's) and remove it, or accept the inaction on those requests |

`ERR_HOST_NO_STEP_WHEN` no longer exists: step-level `when` has been part of
`ToolRegistrationOptions` since the oldest host line this package declares, so the plugin no
longer probes it and registers unconditionally.

Registration codes come in two kinds. A non-duplicate throw while registering the protocol
section logs `ERR_BOOST_SECTION_REGISTER_FAILED` (log only). The three event hooks
(`tools/post-execute`, `llm/stream`, `tools/execute`) are then mounted **independently**: a
failure in any of them is named and reported through **`ERR_BOOST_PARTIAL_MOUNT`** in
`status.degraded`, so a partially assembled plugin no longer looks healthy. The host's genuine
duplicate-section error logs `ERR_BOOST_ALREADY_MOUNTED` and skips this mount; a failure to
register the `boost` tool itself logs `ERR_BOOST_TOOL_REGISTER_FAILED` (log only).

`ERR_HOST_NO_TOKENMETER` and `ERR_HOST_NO_ESTIMATOR` are **two different things**; do not merge
them. The first is the host service (`ctx.get('tokenMeter')`) being absent, which refuses
substitution. The second is the pure estimate package
`@deepseek-ai/dsh-token-meter/estimate` being unreachable, which only makes the fixed-overhead
figure unknown. One can exist without the other, and merging them sends the operator to the wrong
host. `ERR_HOST_NO_SPILL` (no spill backend) and `ERR_HOST_NO_SPILL_NOTICE` (backend present, no
footer renderer) are also two different things with different fixes.

`ERR_HOST_NO_SPILL` has two halves: the **live host probe** reports it only with
`projection: 'on'` (shadow mode never touches spill, so reporting it there would be noise); the
**receipt channel** does not look at the current mode — any historical receipt carrying
`projection-skipped:no-spill` maps to this code, so after you switch projection back to `off`, an
old receipt keeps it in `degraded`.

`tokenMeter` and `spillStore` must not be added to `inject`: with a host that lacks them the
plugin would fail to load outright, and the "refuse substitution, keep projecting, preserve
evidence" degraded path would be unreachable.

## Scope of v1

- Only two things: **replace tool receipts in place** and **substitute read-only calls** (`read` /
  `grep` / `glob`).
- **No batched tool execution** (no PTC / `run_code`): this is not a boundary v1 chose for
  itself but the **narrowed** form of original requirement 2.1 — the request asked for several
  tool calls at once, and the adjudication excluded it explicitly for a later phase (see the
  2.1 row and decision 9 in the
  [clarification record](docs/superpowers/clarifications/2026-11-18-dsh-token-efficiency.md);
  design N1).
- **No deduplication or merging of tool calls** (design N5) — this was not started at all, and
  v1 ships **no tool that measures duplicate-call rate**: the "shadow-week duplication
  statistic" the design reserved as its restart trigger was never delivered; `shadow-report.mjs`
  does not produce it.
- **The shadow week saves nothing by design**: it only records (the protocol section is still
  injected and the selector is still called); its output is four ratios, not saved tokens.
- **v1 does not judge "better results"**: there is a token ledger and a 20-task regression gate,
  no quality metric; whether substituted outcomes are better is unjudgeable in v1.
- **Projection is truncation, not refinement**: it keeps the head and tail and drops the middle;
  the before/after token difference in the ledger measures *shorter*, not *more relevant*. The
  dropped middle may be exactly what the next decision needs — with `projection: 'on'` the
  original can be retrieved through the footer locator, but that costs a tool call, and v1 has
  no metric that separates "refined" from "wrongly cut".
- **Installed but not enabled is a small net loss**: the `boost` tool registers as soon as the
  plugin is assembled, and its schema costs a measured 399 tokens on every request (see the
  breakdown in "Enable it") while yielding nothing.
- **No desktop profile** (design D6).
- Does not replace or take over DSH's compaction, pruning, or spill decisions (design N3);
  projection changes only the model-visible content and keeps the original in the host spill.
- No model training or weight changes (N2); no attempt at the paper's 87.93% (N4).
- No 10% promise: 3.5% is the **lower bound** of the ex-ante estimate, not a floor; 10% is the
  ideal upper bound. The honest net floor is about 0.4% (projection gross ~0.8% minus ~0.4%
  fixed per-request overhead). The shadow week only answers whether the substitution side is
  worth turning on (candidate coverage and hit rate); it does not decide release, and it cannot
  replace the range with a measurement (`shadow-report.mjs` emits four ratios and no total-token
  denominator).

## Documentation

These documents live in the **repository**, not in the npm tarball (`files` ships only `dist`,
`locale`, `cordis.patch.yml`, both READMEs, `LICENSE`, and `NOTICE`; `src/` is not shipped
either, and the `dist` source maps inline the sources). If you are reading on
the npm page, open them from the repository.

The source and docs live in the repository at
[github.com/SAXEM1997/dsh-boost](https://github.com/SAXEM1997/dsh-boost); `package.json` points
`repository`, `homepage`, and `bugs` at it. The document links below are repository-relative.

| Document | Contents |
|---|---|
| [Design](docs/superpowers/specs/2026-11-18-dsh-token-efficiency-design.md) | Goals, evidence, architecture, contracts, measurement, risks, release shape |
| [Host contracts appendix](docs/superpowers/plans/2026-11-18-host-contracts.md) | Interface reference copied line by line from the host sources |
| [Three-tier delegation research](docs/research/2026-11-18-three-tier-delegation.md) | 25 primary sources on caching, routing thresholds, compression, and verification |
| [Release acceptance](docs/RELEASE.md) | The one-command `npm run verify:package` acceptance, the zero-peerDependencies state and install spec, the degradation-code matrix, the 20-task regression gate, and the shadow week and stats recompute |

## License

Apache-2.0. The mechanisms are ported from [HarnessMM](https://github.com/YuhuaJiang2002/HarnessMM)
(Apache-2.0); a `NOTICE` ships with the package.