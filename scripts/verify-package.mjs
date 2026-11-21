#!/usr/bin/env node
/**
 * Verify the *tarball*, not the working tree.
 *
 * `npm publish` used to accept a package whose `files` array omitted `dist`
 * (the working tree still had it, so the local checks passed). This script
 * builds the package explicitly, then packs exactly what `npm publish` would
 * upload and proves the artifact:
 *
 *   1. the tarball is an exact allowlist: every entry is accounted for by a
 *      source file (`dist/`), a declared locale, a fixed root file, or the
 *      bundle patch `package.json` declares. An unexpected entry such as
 *      `package/dist/ghost.js` fails by name;
 *   2. it contains `dist/index.js` (the publish guard) and every dist entry
 *      the source tree declares, not just the `exports` map's `dist/index.js`;
 *   3. the bundle patch parses as YAML and carries a non-empty `insert` list
 *      whose rows name this package and have object `config`; the installed
 *      copy is parsed too. A file that merely exists is not enough;
 *   4. no shipped `.d.ts` imports `@deepseek-ai/*` (host packages are
 *      devDependencies); only the public declarations ship at all;
 *   5. `src/index.ts`'s `VERIFIED_HOST_VERSION` is the minimum of
 *      `engines.dsh` and satisfies it under `includePrerelease`, so the two
 *      copies cannot drift;
 *   6. `exports`, `main` and `types` targets all exist in the installed tree,
 *      and the file named by `dsh.bundle.patch` exists there too;
 *   7. it installs into a throwaway project with `--ignore-scripts` (so a
 *      malicious/broken lifecycle script cannot run in CI), and that install
 *      is probed: `import` (ESM), `require` (Node's require(esm)), and both
 *      `locale/en.json` and `locale/zh.json`;
 *   8. a tiny TypeScript consumer compiles with `tsc --noEmit` against the
 *      installed package twice: once with stubs standing in for the host
 *      packages a real host has, and once with no stubs, no `@deepseek-ai/*`
 *      in the consumer tree, and no `paths` mapping, so a shipped declaration
 *      that reaches for a host type fails instead of being masked by the
 *      stubbed pass;
 *   9. it installs a *second* time without `--ignore-scripts`, and that
 *      install is probed too. This is the only check that catches a
 *      `postinstall` that breaks every real user.
 *
 * The release path is deliberately three explicit steps:
 *
 *   npm run ci                                  # one build, at the end
 *   npm run verify:package -- --prebuilt        # pack exactly that tree
 *   npm publish                                 # no `prepare` to rebuild it
 *
 * `--prebuilt` packs the existing `dist/` without rebuilding. Rebuilding here
 * would silently repair a missing or stale build after the build that was
 * supposed to be under test, making the allowlist assertions tautological.
 * `prepublishOnly` runs `npm run ci` and then `--prebuilt`; `package.json` no
 * longer publishes a `prepare` hook, so `npm publish`'s own pack step does not
 * rebuild either. The default mode (no flag) still builds first for standalone
 * local use.
 *
 * `npm pack --ignore-scripts` is used in both modes so the pack step cannot run
 * lifecycle scripts. The receipt (`ok: true`) is JSON on stdout and names the
 * install each assertion used. On failure the temp directory is kept and its
 * path is printed so the packed artifact can be inspected.
 *
 * Usage:
 *   node scripts/verify-package.mjs                 # build, then pack (no scripts)
 *   node scripts/verify-package.mjs --prebuilt      # pack the existing dist
 *   node scripts/verify-package.mjs --tarball <tgz> # verify an existing tarball
 *
 * `--tarball` is the guard for a hand-built artifact: a tarball without
 * `package/dist/index.js` is rejected before any install runs. It cannot make
 * `npm publish <tgz>` safe (npm skips all package scripts for that form); see
 * `docs/RELEASE.md` §6.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml'
import semver from 'semver'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * The registry the package publishes to (`publishConfig.registry`), passed
 * explicitly to every npm command that could consult one. `.npmrc` pins the
 * same host, so the verify run, `npm ci` in CI, and `npm publish` all read the
 * registry the release actually lands on instead of a lagging mirror.
 */
const REGISTRY = 'https://registry.npmjs.org/'

/** The plugin contract the host loads: keep this in sync with `src/index.ts`. */
const EXPECTED_INJECT = ['tools', 'systemPrompt']

/** Locales the published package must expose; `zh` is the primary README. */
const REQUIRED_LOCALES = ['en.json', 'zh.json']

/**
 * The only declarations the tarball ships: the public entry and the one module
 * its declaration imports. Internal declaration files (every `dist` `.d.ts`
 * except those two) are build artifacts
 * for this repo only; several name host types (`@deepseek-ai/*`) that are
 * devDependencies, so shipping them would make a consumer's
 * `skipLibCheck: false` typecheck depend on a host tree this package does not
 * declare. `package.json` `files` excludes them and re-includes these two.
 */
const PUBLIC_DECLARATIONS = new Set(['index', 'types'])

/**
 * Root files `npm publish` must upload. `README.en.md` and `README.md` are
 * hand-maintained, not derivable from `src/`, so they stay an explicit list.
 * The bundle patch is *not* here: `package.json` owns its path, so the
 * allowlist derives that entry from `dsh.bundle.patch` instead of trusting a
 * hardcoded filename.
 */
const ROOT_ENTRIES = [
  'package/package.json',
  'package/LICENSE',
  'package/NOTICE',
  'package/README.md',
  'package/README.en.md',
]

/**
 * The bundle patch a manifest declares, normalized to a package-relative path.
 *
 * `dsh.bundle.patch` is how the host finds the row this package inserts, so a
 * manifest that names a missing file is a broken install even though every
 * `exports` target still resolves. Requiring a string here also keeps the
 * allowlist honest: the entry is derived from the field, never hardcoded.
 */
function bundlePatchOf(manifest, label) {
  const patch = manifest?.dsh?.bundle?.patch
  if (typeof patch !== 'string') {
    throw new Error(`${label}: dsh.bundle.patch must be a string, got ${typeof patch}`)
  }
  const normalized = patch.startsWith('./') ? patch.slice(2) : patch
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(
      `${label}: dsh.bundle.patch must be a non-empty package-relative path, got ${JSON.stringify(patch)}`,
    )
  }
  return normalized
}

/**
 * The host parses `dsh.bundle.patch` as a loader patch list. A file that only
 * *exists* is not enough: invalid YAML, a non-list document, or an empty
 * `insert` ships a bundle that cannot install. The host's parser is `js-yaml`
 * (`dsh-app-boot` uses `JSON_SCHEMA` extended with its `!!js` tag), so use the
 * same library and base schema instead of a hand-rolled subset. This file has
 * no `!!js` values; the schema only makes the accepted scalar set match.
 *
 * The contract asserted here is the one `cordis.patch.yml` documents:
 *   - the document is a non-empty array of patch entries;
 *   - at least one entry has a non-empty `insert` array;
 *   - every inserted row's `id` and `name` equal the package name (that is the
 *     plugin manager's in-use/addressable attribution);
 *   - every inserted row has an object `config`.
 */
function assertBundlePatchContent(text, label, packageName) {
  let document
  try {
    document = loadYaml(text, { schema: JSON_SCHEMA })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label}: dsh.bundle.patch is not valid YAML: ${detail}`)
  }
  if (!Array.isArray(document) || document.length === 0) {
    throw new Error(
      `${label}: dsh.bundle.patch must be a non-empty YAML array of patch entries, got ${describeYamlValue(document)}`,
    )
  }

  const rows = []
  for (const [entryIndex, entry] of document.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `${label}: patch entry ${entryIndex} must be a mapping, got ${describeYamlValue(entry)}`,
      )
    }
    if (!Object.prototype.hasOwnProperty.call(entry, 'insert')) continue
    if (!Array.isArray(entry.insert) || entry.insert.length === 0) {
      throw new Error(`${label}: patch entry ${entryIndex} \`insert\` must be a non-empty array`)
    }
    rows.push(...entry.insert.map((row) => ({ row, entryIndex })))
  }
  if (rows.length === 0) {
    throw new Error(`${label}: dsh.bundle.patch has no \`insert\` rows`)
  }

  for (const [rowIndex, { row, entryIndex }] of rows.entries()) {
    const at = `${label}: insert[${rowIndex}] (patch entry ${entryIndex})`
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${at} must be a mapping, got ${describeYamlValue(row)}`)
    }
    if (row.id !== packageName) {
      throw new Error(`${at}.id must equal the package name ${JSON.stringify(packageName)}, got ${JSON.stringify(row.id)}`)
    }
    if (row.name !== packageName) {
      throw new Error(`${at}.name must equal the package name ${JSON.stringify(packageName)}, got ${JSON.stringify(row.name)}`)
    }
    if (row.config === null || typeof row.config !== 'object' || Array.isArray(row.config)) {
      throw new Error(`${at}.config must be an object, got ${describeYamlValue(row.config)}`)
    }
  }
  return { entries: document.length, rows: rows.length }
}

/** A short, type-first description for a parsed YAML value in error messages. */
function describeYamlValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'a mapping' : `${typeof value} ${JSON.stringify(value)}`
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** npm sets `npm_config_*` for lifecycle scripts; never let them leak in. */
function childEnv() {
  const env = { ...process.env }
  delete env.npm_config_dry_run
  delete env.npm_config_ignore_scripts
  env.npm_config_update_notifier = 'false'
  env.npm_config_audit = 'false'
  env.npm_config_fund = 'false'
  return env
}

function run(command, args, options) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: childEnv(),
    ...options,
  })
}

/** Preflight: without `dist` in `files`, `npm pack` cannot ship the entry point. */
function assertPublishFilesIncludeDist() {
  const files = Array.isArray(pkg.files) ? pkg.files : []
  const includesDist = files.some(
    (entry) => entry === 'dist' || entry === 'dist/' || entry.startsWith('dist/'),
  )
  if (!includesDist) {
    throw new Error('publish blocked: package.json `files` does not include dist')
  }
}

function parseTarballArg(argv) {
  const index = argv.indexOf('--tarball')
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (!value) throw new Error('--tarball requires a path')
  const path = resolve(value)
  if (!existsSync(path)) throw new Error(`--tarball does not exist: ${path}`)
  return path
}

/** Every production TypeScript source, relative to `src/`, with `/` separators. */
function sourceFiles() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(relative(join(root, 'src'), path).split(sep).join('/'))
      }
    }
  }
  walk(join(root, 'src'))
  return files.sort()
}

/**
 * The exact set of paths the tarball may contain. `dist/` is derived from
 * `src/` (one `.js`, `.js.map` and `.d.ts` per source), so a missing build
 * output and an unexpected post-pack file are both visible. Locales are the
 * JSON files actually present in `locale/`, and both required ones are checked
 * separately.
 */
function expectedTarballEntries() {
  const expected = new Set(ROOT_ENTRIES)
  expected.add(`package/${bundlePatchOf(pkg, 'package.json')}`)
  for (const file of sourceFiles()) {
    const stem = file.replace(/\.ts$/, '')
    expected.add(`package/dist/${stem}.js`)
    expected.add(`package/dist/${stem}.js.map`)
    // Internal declarations stay out of the tarball; only the public entry and
    // the module its declaration imports ship (see PUBLIC_DECLARATIONS).
    if (PUBLIC_DECLARATIONS.has(stem)) expected.add(`package/dist/${stem}.d.ts`)
  }
  for (const file of readdirSync(join(root, 'locale')).sort()) {
    if (file.endsWith('.json')) expected.add(`package/locale/${file}`)
  }
  return expected
}

/**
 * Reject the first entry that is not accounted for, then name every missing
 * entry. This is deliberately an exact allowlist, not a forbidden-prefix list:
 * `package/dist/ghost.js` is unexpected even though its prefix is allowed.
 *
 * The declared patch is checked against the source tree first. If
 * `dsh.bundle.patch` names a missing file, the still-shipped old patch is the
 * first *unexpected* entry, so checking entries first reports the healthy file
 * as the problem and never names the broken declaration.
 */
function assertTarballAllowlist(listed) {
  const declaredPatch = bundlePatchOf(pkg, 'package.json')
  const patchPath = join(root, declaredPatch)
  if (!existsSync(patchPath)) {
    throw new Error(
      `dsh.bundle.patch declares a file that does not exist: ${declaredPatch}\n` +
        'fix package.json `dsh.bundle.patch`, or add the file it names',
    )
  }
  // Parse the source copy before the entry allowlist: a syntactically broken
  // patch is still an allowlisted entry, so the allowlist alone cannot see it.
  assertBundlePatchContent(readFileSync(patchPath, 'utf8'), declaredPatch, pkg.name)
  const expected = expectedTarballEntries()
  const present = new Set(listed)
  for (const entry of listed) {
    if (!expected.has(entry)) {
      throw new Error(
        `tarball entry is not in the allowlist: ${entry}\n` +
          'expected only the fixed root files, the manifest-declared bundle patch, locale JSON, ' +
          'one .js/.js.map per src/*.ts, and the public .d.ts files',
      )
    }
  }
  const missing = [...expected].filter((entry) => !present.has(entry)).sort()
  if (missing.length > 0) {
    throw new Error(`tarball is missing ${missing.length} allowlisted entr${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}`)
  }
}

function assertFile(path, label) {
  if (!existsSync(path)) throw new Error(`declared ${label} does not exist in the installed package: ${path}`)
}

function collectExportTargets(value, out) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectExportTargets(item, out)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collectExportTargets(item, out)
  return out
}

/** Every string target in `exports` (plus `main`/`types`) must exist on disk. */
function assertDeclaredTargets(installed, installedPkg) {
  // A missing `exports` map would make every loop below a no-op, so the check
  // would pass on a package whose subpaths no longer resolve. The map is
  // required: consumers import `dsh-boost/package.json` and `dsh-boost/locale/*.json`.
  const exportsMap = installedPkg.exports
  if (exportsMap === null || typeof exportsMap !== 'object' || Array.isArray(exportsMap)) {
    throw new Error('package.json has no `exports` map; subpath imports would not resolve')
  }
  for (const [subpath, value] of Object.entries(exportsMap)) {
    for (const target of collectExportTargets(value, [])) {
      if (subpath.includes('*')) {
        if (!target.includes('*')) {
          throw new Error(`exports pattern ${subpath} has a non-pattern target ${target}`)
        }
        // `./locale/*.json` -> `./locale/en.json`: the `*` is the stem.
        for (const locale of REQUIRED_LOCALES) {
          const concrete = target.replace('*', locale.replace(/\.json$/, ''))
          assertFile(join(installed, concrete), `${subpath} -> ${concrete}`)
        }
      } else {
        assertFile(join(installed, target), `${subpath} -> ${target}`)
      }
    }
  }
  for (const field of ['main', 'types']) {
    const target = installedPkg[field]
    if (typeof target === 'string') assertFile(join(installed, target), field)
  }
}

/**
 * The manifest-declared bundle patch must be present *and valid* in the
 * installed tree. The host parses the installed copy, so checking only the
 * source tree would miss a pack that shipped a different file.
 */
function assertBundlePatch(installed, installedPkg) {
  const patch = bundlePatchOf(installedPkg, 'installed package.json')
  const path = join(installed, patch)
  assertFile(path, `dsh.bundle.patch -> ${patch}`)
  assertBundlePatchContent(readFileSync(path, 'utf8'), `installed ${patch}`, installedPkg.name)
}

/**
 * `src/index.ts` keeps `VERIFIED_HOST_VERSION` as the advisory startup check;
 * `package.json` `engines.dsh` is the host's preflight gate. They are two
 * copies of the same fact, so the release gate asserts:
 *
 *   - the literal parses as a semver version;
 *   - `engines.dsh` accepts it under the host's own
 *     `includePrerelease: true` comparison;
 *   - the literal is the range's minimum, so widening the range below the
 *     verified line, or bumping the literal without the range (or vice versa),
 *     fails instead of silently drifting.
 *
 * `src/index.ts` is read, never modified.
 */
function assertHostVersionAgreement() {
  const sourcePath = join(root, 'src', 'index.ts')
  const source = readFileSync(sourcePath, 'utf8')
  const match = /const VERIFIED_HOST_VERSION = '([^']+)'/.exec(source)
  if (!match) {
    throw new Error(`${sourcePath}: cannot find \`const VERIFIED_HOST_VERSION = '...'\``)
  }
  const verified = match[1]
  const range = pkg.engines?.dsh
  if (typeof range !== 'string' || range.trim() === '') {
    throw new Error('package.json `engines.dsh` must be a non-empty semver range')
  }
  if (!semver.valid(verified)) {
    throw new Error(`src/index.ts VERIFIED_HOST_VERSION is not a semver version: ${verified}`)
  }
  if (!semver.satisfies(verified, range, { includePrerelease: true })) {
    throw new Error(
      `host version mismatch: src/index.ts VERIFIED_HOST_VERSION ${verified} is not accepted by ` +
        `package.json engines.dsh ${JSON.stringify(range)} under includePrerelease`,
    )
  }
  const minimum = semver.minVersion(range, { includePrerelease: true })
  if (minimum === null || !semver.eq(minimum, verified)) {
    throw new Error(
      `host version mismatch: package.json engines.dsh ${JSON.stringify(range)} has minimum ` +
        `${minimum?.version ?? 'none'}, but src/index.ts VERIFIED_HOST_VERSION is ${verified}; ` +
        'update both together',
    )
  }
  return { verified, range }
}

/**
 * Every shipped `.d.ts` must stand on its own: host packages are
 * devDependencies, so an `import ... from '@deepseek-ai/*'` in a published
 * declaration makes a consumer's `skipLibCheck: false` typecheck fail unless
 * the consumer happens to have the host tree. The tarball allowlist already
 * rejects internal declarations; this check also covers the public two.
 */
function assertDeclarationsDoNotImportHostTypes(tarball, listed) {
  const declarations = listed.filter((entry) => entry.endsWith('.d.ts'))
  if (declarations.length === 0) throw new Error('tarball has no .d.ts files')
  for (const entry of declarations) {
    const text = run('tar', ['-xOzf', tarball, entry], { cwd: root })
    // `[^\n]*` stopped at the first newline, so an import written across lines
    // (`import type {\n  JsonSchemaNode,\n} from '@deepseek-ai/dsh-tools'`) slipped
    // past. Match across lines instead, and also catch `export * from`.
    const importPattern =
      /(?:^|\n)\s*(?:import|export)\b[\s\S]{0,400}?['"]@deepseek-ai\/|(?:^|\n)\s*import\(\s*['"]@deepseek-ai\/|(?:^|\n)\s*\/\/\/\s*<reference\s+types=["']@deepseek-ai\//
    if (importPattern.test(text)) {
      throw new Error(
        `${entry} imports a host type from @deepseek-ai/*; host packages are devDependencies, ` +
          'so a consumer with skipLibCheck:false would need a tree this package does not declare. ' +
          'Use a local structural alias, or exclude the declaration from the tarball.',
      )
    }
  }
  return declarations
}

/** The consumer probe: shape, both module systems, and both locales. */
const PROBE = `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const mod = await import('dsh-boost')
assert.equal(mod.name, 'dsh-boost')
assert.deepEqual(Array.from(mod.inject), ${JSON.stringify(EXPECTED_INJECT)})
assert.equal(typeof mod.apply, 'function')

const require = createRequire(import.meta.url)
const cjs = require('dsh-boost')
assert.equal(cjs.name, 'dsh-boost')
assert.equal(typeof cjs.apply, 'function')
assert.ok(require.resolve('dsh-boost/package.json').endsWith('package.json'))

for (const locale of ${JSON.stringify(REQUIRED_LOCALES)}) {
  const request = 'dsh-boost/locale/' + locale
  assert.ok(require.resolve(request).endsWith(locale))
  const dict = require(request)
  assert.equal(typeof dict?.meta?.description, 'string')
  assert.ok(dict.meta.description.length > 0, request + ' has an empty description')
  assert.equal(typeof dict?.meta?.title, 'string')
}
console.log('probe-ok')
`

/** A tiny consumer; `tsc --noEmit` must resolve the installed declarations. */
const TYPECHECK_CONSUMER = `
import { apply, name } from 'dsh-boost'
import type { inject } from 'dsh-boost'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T

type NameIsExact = Assert<Equal<typeof name, 'dsh-boost'>>
type InjectIsExact = Assert<
  Equal<typeof inject, readonly ['tools', 'systemPrompt']>
>

const fakeContext = {
  logger: { info() {}, warn() {} },
  on() {},
  tools: { register() {}, resolve() { return Promise.resolve({ dispose() {}, view() { return new Map() } }) } },
  llm: { async *stream() {} },
  systemPrompt: { section() {} },
  get() { return undefined },
}

apply(fakeContext, {})

export type { NameIsExact, InjectIsExact }
`

/**
 * Host packages are devDependencies, so the throwaway consumer does not have
 * them. A real DSH host does. Stub only the host symbols the published
 * declarations import; the package's own declarations are still checked with
 * `skipLibCheck: false`.
 */
const HOST_STUBS = `
declare module '@deepseek-ai/dsh-llm' {
  export interface GenerateOptions { readonly [key: string]: unknown }
  export interface StreamChunk { readonly [key: string]: unknown }
}
declare module '@deepseek-ai/dsh-llm/types' {
  export interface LlmRequestPurposeMap {}
}
declare module '@deepseek-ai/dsh-tools' {
  export interface JsonSchemaNode { readonly [key: string]: unknown }
}
`

const TYPECHECK_TSCONFIG = {
  compilerOptions: {
    target: 'ES2023',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
    lib: ['ES2023', 'DOM'],
  },
}

/**
 * The stub-free project must be at least as strict as the stubbed one. If a
 * later edit relaxes `skipLibCheck`, pulls ambient `@types` back in, or adds a
 * `paths` mapping, this check could pass without the host tree and stop
 * proving anything. Assert the discipline instead of trusting the constant.
 */
function assertNoStubDiscipline(options, label) {
  if (options.skipLibCheck !== false) throw new Error(`${label}: skipLibCheck must be false`)
  if (!Array.isArray(options.types) || options.types.length !== 0) {
    throw new Error(`${label}: types must be an empty array`)
  }
  if (options.paths !== undefined) {
    throw new Error(`${label}: a paths mapping could resolve @deepseek-ai/* without the host tree`)
  }
}

/** Write one consumer project; `hostStubs` decides whether the stubs are part of it. */
function writeTypecheckProject(dir, { hostStubs }) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'consumer.ts'), TYPECHECK_CONSUMER)
  const include = ['consumer.ts']
  if (hostStubs) {
    writeFileSync(join(dir, 'host-stubs.d.ts'), HOST_STUBS)
    include.push('host-stubs.d.ts')
  } else {
    assertNoStubDiscipline(TYPECHECK_TSCONFIG.compilerOptions, 'no-stub typecheck')
  }
  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify({ ...TYPECHECK_TSCONFIG, include }, null, 2)}\n`,
  )
}

/** The stub-free pass only means something if no host package is installed. */
function assertNoHostPackages(consumer) {
  const hostScope = join(consumer, 'node_modules', '@deepseek-ai')
  if (existsSync(hostScope)) {
    throw new Error(
      `consumer node_modules contains ${hostScope}; the no-stub typecheck would resolve host ` +
        'types from the install instead of failing',
    )
  }
}

function tscProject(tsc, project, label, install) {
  try {
    run(process.execPath, [tsc, '--noEmit', '-p', join(project, 'tsconfig.json')], {
      cwd: project,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim()
    throw new Error(`${label} failed (${install} install)${detail ? `:\n${detail}` : ''}`)
  }
}

function writeConsumerPackage(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-boost-verify-consumer', private: true, type: 'module' }, null, 2)}\n`,
  )
}

function installTarball(dir, tarball, { ignoreScripts }) {
  const label = ignoreScripts ? 'ignore-scripts install' : 'default install (lifecycle scripts enabled)'
  const args = [
    'install',
    ignoreScripts ? '--ignore-scripts' : '--ignore-scripts=false',
    tarball,
    '--no-package-lock',
    `--registry=${REGISTRY}`,
    '--loglevel=error',
  ]
  try {
    run(npm, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim()
    throw new Error(`${label} failed${detail ? `:\n${detail}` : ''}`)
  }
}

function runProbe(consumer, install, checks) {
  writeFileSync(join(consumer, 'probe.mjs'), PROBE)
  try {
    run(process.execPath, ['probe.mjs'], { cwd: consumer, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim()
    throw new Error(`consumer probe failed (${install} install)${detail ? `:\n${detail}` : ''}`)
  }
  checks.push({ name: 'import-require-locales', install })
}

function runTypecheck(consumer, install, checks) {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tsc)) {
    throw new Error(`TypeScript is not installed at ${tsc}; run \`npm ci\` before verify:package`)
  }

  // 1. A real DSH host has the @deepseek-ai tree, so this pass models the
  //    consumer that does. The stubs stand in only for packages the published
  //    manifest does not declare.
  const stubbed = join(consumer, 'typecheck-host-stubs')
  writeTypecheckProject(stubbed, { hostStubs: true })
  tscProject(tsc, stubbed, 'consumer type check with host stubs', install)
  checks.push({ name: 'typecheck', install })

  // 2. The same consumer with no stubs, no host packages, and no `paths`
  //    mapping. A shipped declaration that reaches for a host type must fail
  //    here; without this pass the stubs above mask exactly that defect, and
  //    the regex scan would be the only guard against it.
  assertNoHostPackages(consumer)
  const bare = join(consumer, 'typecheck-no-host-stubs')
  writeTypecheckProject(bare, { hostStubs: false })
  tscProject(tsc, bare, 'consumer type check without host stubs', install)
  checks.push({ name: 'typecheck-no-host-stubs', install })
}

function verify({ tarball, tarballName, packed, prebuilt }) {
  const checks = []

  const listed = run('tar', ['-tzf', tarball], { cwd: root })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  // The hard publish guard: `prepublishOnly` calls this script, so a tarball
  // that lost `dist/index.js` — a `files`/ignore filter dropped it, or the
  // artifact came in through `--tarball` — stops before any install.
  if (!listed.includes('package/dist/index.js')) {
    throw new Error(
      'publish blocked: tarball has no package/dist/index.js ' +
        '(the build did not run, or package.json `files` does not include dist)',
    )
  }
  checks.push({ name: 'dist-index-present', install: null })

  // Exact allowlist for the artifact actually packed (default path: the tree
  // `npm run build` just produced) or handed in with `--tarball`.
  assertTarballAllowlist(listed)
  checks.push({ name: 'tarball-allowlist', install: null })

  const declarations = assertDeclarationsDoNotImportHostTypes(tarball, listed)
  checks.push({ name: 'declarations-host-free', install: null, files: declarations.length })

  const work = mkdtempSync(join(tmpdir(), 'dsh-boost-verify-'))
  let ok = false
  try {
    const primary = join(work, 'consumer-ignore-scripts')
    writeConsumerPackage(primary)
    installTarball(primary, tarball, { ignoreScripts: true })
    checks.push({ name: 'install', install: 'ignore-scripts' })

    const installed = join(primary, 'node_modules', 'dsh-boost')
    const installedPkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
    if (installedPkg.name !== 'dsh-boost') throw new Error(`installed name is ${installedPkg.name}`)
    if (installedPkg.version !== pkg.version) {
      throw new Error(`installed version ${installedPkg.version} != package.json ${pkg.version}`)
    }

    assertDeclaredTargets(installed, installedPkg)
    checks.push({ name: 'exports-targets', install: 'ignore-scripts' })

    assertBundlePatch(installed, installedPkg)
    checks.push({ name: 'bundle-patch', install: 'ignore-scripts' })

    runProbe(primary, 'ignore-scripts', checks)
    runTypecheck(primary, 'ignore-scripts', checks)

    // Second install, same tarball, lifecycle scripts enabled. This is what a
    // real `npm install dsh-boost` does; a broken postinstall must fail here.
    const secondary = join(work, 'consumer-with-scripts')
    writeConsumerPackage(secondary)
    installTarball(secondary, tarball, { ignoreScripts: false })
    checks.push({ name: 'install', install: 'default' })

    const secondaryInstalled = join(secondary, 'node_modules', 'dsh-boost')
    assertFile(join(secondaryInstalled, 'dist', 'index.js'), 'dist/index.js')
    runProbe(secondary, 'default', checks)

    ok = true
    const bytes = statSync(tarball).size
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          source: packed
            ? prebuilt
              ? 'npm pack --ignore-scripts (--prebuilt)'
              : 'npm pack --ignore-scripts'
            : '--tarball',
          build: prebuilt ? 'skipped (--prebuilt)' : packed ? 'npm run build' : 'not run (--tarball)',
          tarball: tarballName,
          bytes,
          entries: listed.length,
          installs: {
            primary: 'npm install <tarball> --ignore-scripts',
            secondary: 'npm install <tarball> (lifecycle scripts enabled)',
          },
          checks,
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    if (ok) rmSync(work, { recursive: true, force: true })
    else console.error(`verify-package: kept work dir ${work}`)
  }
}

function main() {
  const argv = process.argv.slice(2)
  const prebuilt = argv.includes('--prebuilt')
  const explicit = parseTarballArg(argv)
  if (prebuilt && explicit) throw new Error('--prebuilt and --tarball are mutually exclusive')

  assertHostVersionAgreement()

  if (explicit) {
    verify({
      tarball: explicit,
      tarballName: explicit.split(sep).pop() ?? explicit,
      packed: false,
      prebuilt: false,
    })
    return
  }

  assertPublishFilesIncludeDist()
  const work = mkdtempSync(join(tmpdir(), 'dsh-boost-pack-'))
  let ok = false
  try {
    const packDir = join(work, 'pack')
    mkdirSync(packDir)
    if (prebuilt) {
      // `prepublishOnly` runs one explicit build (`npm run ci`'s last step) and
      // then this mode. Packing the existing tree is the point: rebuilding here
      // would silently repair a missing or stale `dist/` after the build that
      // was supposed to be under test.
      if (!existsSync(join(root, 'dist', 'index.js'))) {
        throw new Error('--prebuilt requires an existing build; dist/index.js is missing (run npm run build first)')
      }
      process.stderr.write('verify-package: --prebuilt (packing the existing dist, no build)\n')
    } else {
      // Build here, explicitly. `npm pack` with lifecycle scripts enabled would
      // run `prepare` -> clean -> tsc inside the pack step, so a tampered or
      // stale `dist/` would be silently repaired instead of reported, and the
      // artifact would not be the tree under test. `--ignore-scripts` below
      // makes the packed tree exactly what this build produced.
      process.stderr.write('verify-package: npm run build (before packing)\n')
      // Build output goes to stderr: stdout is reserved for the JSON receipt, so
      // `npm run --silent verify:package | jq` keeps working.
      run(npm, ['run', 'build'], { cwd: root, stdio: ['ignore', 2, 2] })
    }
    run(npm, ['pack', '--ignore-scripts', '--pack-destination', packDir, '--loglevel=error'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    const tarballs = readdirSync(packDir).filter((name) => name.endsWith('.tgz'))
    if (tarballs.length !== 1) {
      throw new Error(`expected exactly one tarball in ${packDir}, found: ${tarballs.join(', ') || 'none'}`)
    }
    verify({
      tarball: join(packDir, tarballs[0]),
      tarballName: tarballs[0],
      packed: true,
      prebuilt,
    })
    ok = true
  } finally {
    if (ok) rmSync(work, { recursive: true, force: true })
    else console.error(`verify-package: kept pack dir ${work}`)
  }
}

try {
  main()
} catch (error) {
  console.error(`verify-package: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
