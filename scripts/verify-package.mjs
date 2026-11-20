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
 *   3. `exports`, `main` and `types` targets all exist in the installed tree,
 *      and the file named by `dsh.bundle.patch` exists there too;
 *   4. it installs into a throwaway project with `--ignore-scripts` (so a
 *      malicious/broken lifecycle script cannot run in CI), and that install
 *      is probed: `import` (ESM), `require` (Node's require(esm)), and both
 *      `locale/en.json` and `locale/zh.json`;
 *   5. a tiny TypeScript consumer compiles with `tsc --noEmit` against the
 *      installed package, so a missing or widened declaration fails;
 *   6. it installs a *second* time without `--ignore-scripts`, and that
 *      install is probed too. This is the only check that catches a
 *      `postinstall` that breaks every real user.
 *
 * The default path runs `npm run build` and then `npm pack --ignore-scripts`,
 * so the artifact is the tree that build produced: packing with lifecycle
 * scripts enabled would let `prepare` rebuild (and thereby repair) the tree
 * inside the pack step, after which the dist assertions no longer describe the
 * tree under test.
 *
 * The receipt (`ok: true`) is JSON on stdout and names the install each
 * assertion used. On failure the temp directory is kept and its path is
 * printed so the packed artifact can be inspected.
 *
 * Usage:
 *   node scripts/verify-package.mjs                 # build, then pack (no scripts)
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

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** The plugin contract the host loads: keep this in sync with `src/index.ts`. */
const EXPECTED_INJECT = ['tools', 'systemPrompt']

/** Locales the published package must expose; `zh` is the primary README. */
const REQUIRED_LOCALES = ['en.json', 'zh.json']

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
    const stem = `package/dist/${file.replace(/\.ts$/, '')}`
    expected.add(`${stem}.js`)
    expected.add(`${stem}.js.map`)
    expected.add(`${stem}.d.ts`)
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
  if (!existsSync(join(root, declaredPatch))) {
    throw new Error(
      `dsh.bundle.patch declares a file that does not exist: ${declaredPatch}\n` +
        'fix package.json `dsh.bundle.patch`, or add the file it names',
    )
  }
  const expected = expectedTarballEntries()
  const present = new Set(listed)
  for (const entry of listed) {
    if (!expected.has(entry)) {
      throw new Error(
        `tarball entry is not in the allowlist: ${entry}\n` +
          'expected only the fixed root files, the manifest-declared bundle patch, locale JSON, ' +
          'and one .js/.js.map/.d.ts per src/*.ts',
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
  for (const [subpath, value] of Object.entries(installedPkg.exports ?? {})) {
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

/** The manifest-declared bundle patch must be present in the installed tree. */
function assertBundlePatch(installed, installedPkg) {
  const patch = bundlePatchOf(installedPkg, 'installed package.json')
  assertFile(join(installed, patch), `dsh.bundle.patch -> ${patch}`)
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
  include: ['consumer.ts', 'host-stubs.d.ts'],
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
  writeFileSync(join(consumer, 'consumer.ts'), TYPECHECK_CONSUMER)
  writeFileSync(join(consumer, 'host-stubs.d.ts'), HOST_STUBS)
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    `${JSON.stringify(TYPECHECK_TSCONFIG, null, 2)}\n`,
  )
  try {
    run(process.execPath, [tsc, '--noEmit', '-p', join(consumer, 'tsconfig.json')], {
      cwd: consumer,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim()
    throw new Error(`consumer type check failed (${install} install)${detail ? `:\n${detail}` : ''}`)
  }
  checks.push({ name: 'typecheck', install })
}

function verify({ tarball, tarballName, packed }) {
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
          source: packed ? 'npm pack --ignore-scripts' : '--tarball',
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
  const explicit = parseTarballArg(process.argv.slice(2))
  if (explicit) {
    verify({ tarball: explicit, tarballName: explicit.split(sep).pop() ?? explicit, packed: false })
    return
  }

  assertPublishFilesIncludeDist()
  const work = mkdtempSync(join(tmpdir(), 'dsh-boost-pack-'))
  let ok = false
  try {
    const packDir = join(work, 'pack')
    mkdirSync(packDir)
    // Build here, explicitly. `npm pack` with lifecycle scripts enabled would
    // run `prepare` -> clean -> tsc inside the pack step, so a tampered or
    // stale `dist/` would be silently repaired instead of reported, and the
    // artifact would not be the tree under test. `--ignore-scripts` below
    // makes the packed tree exactly what this build produced.
    process.stderr.write('verify-package: npm run build (before packing)\n')
    // Build output goes to stderr: stdout is reserved for the JSON receipt, so
    // `npm run --silent verify:package | jq` keeps working.
    run(npm, ['run', 'build'], { cwd: root, stdio: ['ignore', 2, 2] })
    run(npm, ['pack', '--ignore-scripts', '--pack-destination', packDir, '--loglevel=error'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    const tarballs = readdirSync(packDir).filter((name) => name.endsWith('.tgz'))
    if (tarballs.length !== 1) {
      throw new Error(`expected exactly one tarball in ${packDir}, found: ${tarballs.join(', ') || 'none'}`)
    }
    verify({ tarball: join(packDir, tarballs[0]), tarballName: tarballs[0], packed: true })
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
