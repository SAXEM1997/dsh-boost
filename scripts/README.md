# Maintainer scripts

These scripts are repository tooling. They are not part of the published
package (`package.json`'s `files` omits `scripts/`), so run them from a
checkout with the development dependencies installed.

## Session statistics

`npm run stats` prints npm's own banner (`> dsh-boost@0.2.3 stats` and the
command line) on **stdout** before the JSON, so it must not be piped directly.
For a machine-readable stream use one of the quiet forms:

```bash
node scripts/session-stats.mjs            # the committed snapshot
node scripts/session-stats.mjs --snapshot /path/to/snapshot.json
node scripts/session-stats.mjs --sessions "$DSH_HOME/sessions" --as-of 2026-11-19T00:00:00Z
npm run --silent stats                    # --silent drops npm's banner
```

Both write only the JSON document to stdout; diagnostics go to stderr and a
non-zero exit means nothing was written. `npm run stats` (without `--silent`)
stays convenient for humans and is intentionally noisy.

## Shadow-week report

`node scripts/shadow-report.mjs --dir <receipts dir>` reads the `*.jsonl`
receipts (including rotated `.1.jsonl` shards) and prints the four shadow-week
labels as JSON. `--help` prints usage and exits 0. A directory that does not
exist is not silently reported as an all-zero week: the script warns on stderr
and exits 2, because a typo'd path would otherwise look exactly like a genuine
zero-result week. Pass `--allow-empty` when the empty report is intentional.

## Package verification

The release path is three explicit steps, in this order:

```bash
npm run ci                            # typecheck, tests, and one clean build
npm run verify:package -- --prebuilt  # pack and verify exactly that dist
npm publish                           # `prepare` runs, but both halves exist, so it is a no-op
```

`prepublishOnly` is `npm run ci && npm run verify:package -- --prebuilt`, so a
release cannot skip the gate. `package.json` publishes `prepare`, because a git install has neither half
built. It builds only the half that is missing, and `npm pack --ignore-scripts`
skips it, so the tarball still describes exactly the tree `npm run build` left.
Relying on `prepublishOnly`
for the release build also means `npm publish`'s own pack step cannot rebuild
the tree after verification.

`npm run verify:package` (no flag) still builds first and then packs, for
standalone local use. `--prebuilt` skips the build and packs the existing
`dist/`; that is what makes the allowlist assertions meaningful after the one
explicit build. `--tarball <tgz>` runs the same assertions on an artifact you
built yourself, without rebuilding or packing.

The gate packs with `npm pack --ignore-scripts`, so the pack step cannot run
lifecycle scripts. It installs the tarball into a throwaway project with
`--ignore-scripts`, then asserts:

- the exact tarball allowlist (an extra `dist/ghost.js` is named, and a missing
  entry is listed);
- `dsh.bundle.patch` parses as YAML (with `js-yaml`, the host's parser family)
  and its non-empty `insert` rows have `id`/`name` equal to the package name
  and an object `config`; the installed copy is parsed too. A file that merely
  exists is not accepted;
- `src/index.ts`'s `VERIFIED_HOST_VERSION` is the minimum of `engines.dsh` and
  satisfies it under the host's `includePrerelease` comparison, so the advisory
  literal and the host preflight range cannot drift apart;
- no shipped `.d.ts` imports `@deepseek-ai/*`. Host packages are
  devDependencies, so a published declaration that names them would break a
  consumer's `skipLibCheck: false` typecheck. Only `dist/index.d.ts` and
  `dist/types.d.ts` ship; `package.json` `files` excludes the internal
  declarations with `!dist/**/*.d.ts` and re-includes the public two;
- the ESM import, the `require()` path, `name`/`inject`/`apply`, the
  `./package.json` + `./locale/*.json` export subpaths, and a tiny TypeScript
  consumer.

### Registry

`.npmrc` and the committed `package-lock.json` both point at
`https://registry.npmjs.org/`, the registry `publishConfig` publishes to. The
verify script also passes `--registry=https://registry.npmjs.org/` explicitly
to every npm install it runs, and CI asserts that no `registry.npmmirror.com`
URL survives in the lockfile before `npm ci`. This keeps release checks from
reading a mirror whose `latest` tag lags the real publication.

## Build

`npm run build` removes `dist/` first (`scripts/clean.mjs`) and then runs
`tsc`; a renamed or deleted source file can never leave a stale compiled file
in the tarball. Source maps are emitted with `inlineSources`, so `dist/` is
debuggable without shipping `src/`.
