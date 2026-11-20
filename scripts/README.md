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

`npm run verify:package` packs the artifact exactly as `npm publish` would,
installs it into a throwaway project with `--ignore-scripts`, then asserts the
tarball entries, the absence of dev-only trees and orphaned `dist/` output, the
ESM import, the `require()` path, `name`/`inject`/`apply`, and the
`./package.json` + `./locale/*.json` export subpaths. `prepublishOnly` runs it
after `npm run ci`, so a release cannot skip it.

## Build

`npm run build` removes `dist/` first (`scripts/clean.mjs`) and then runs
`tsc`; a renamed or deleted source file can never leave a stale compiled file
in the tarball. Source maps are emitted with `inlineSources`, so `dist/` is
debuggable without shipping `src/`.