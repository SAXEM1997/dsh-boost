# Maintainer scripts

These scripts are repository tooling. They are not part of the published
package (`package.json`'s `files` omits `scripts/`), so run them from a
checkout with the development dependencies installed.

## Session statistics

`npm run stats` prints npm's own banner (`> dsh-boost@0.1.0 stats` and the
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

## Package verification

`npm run verify:package` runs `npm run build` and then `npm pack --ignore-scripts`, so the pack
step cannot rebuild the tree it is verifying: the artifact is exactly what that build produced.
It installs the tarball into a throwaway project with `--ignore-scripts`, then asserts the exact
tarball allowlist (on a hand-built artifact an extra `dist/` entry such as `dist/ghost.js` is
named, and a missing one is listed), the ESM import, the `require()` path, `name`/`inject`/`apply`,
the `./package.json` + `./locale/*.json` export subpaths, and a tiny TypeScript consumer.
`--tarball <tgz>` runs the same assertions on an artifact you built yourself, without rebuilding.
`prepublishOnly` runs it after `npm run ci`, so a release cannot skip it.

## Build

`npm run build` removes `dist/` first (`scripts/clean.mjs`) and then runs
`tsc`; a renamed or deleted source file can never leave a stale compiled file
in the tarball. Source maps are emitted with `inlineSources`, so `dist/` is
debuggable without shipping `src/`.