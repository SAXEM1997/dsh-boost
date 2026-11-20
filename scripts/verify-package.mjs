#!/usr/bin/env node
/**
 * Verify the *tarball*, not the working tree.
 *
 * `npm publish` used to accept a package whose `files` array omitted `dist`
 * (the working tree still had it, so the local checks passed). This script
 * packs exactly what `npm publish` would upload and then proves the artifact:
 *
 *   1. the tarball contains every runtime entry and no dev-only tree
 *      (`src/`, `test/`, `scripts/`, `docs/`) and no orphaned `dist/` output
 *      left behind by a deleted source file;
 *   2. it installs into a throwaway project with `--ignore-scripts`;
 *   3. it imports (ESM) and requires (Node's require(esm)) as `dsh-boost` with
 *      the expected `name`, `inject` and `apply`;
 *   4. `dsh-boost/package.json` and the locale entries resolve.
 *
 * On success only the JSON receipt is written to stdout. On failure the temp
 * directory is kept and its path is printed so the packed artifact can be
 * inspected.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
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
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** The plugin contract the host loads: keep this in sync with `src/index.ts`. */
const EXPECTED_INJECT = ['tools', 'llm', 'systemPrompt']

/** Entries `npm publish` must upload for the package to be loadable. */
const REQUIRED_ENTRIES = [
  'package/package.json',
  'package/LICENSE',
  'package/NOTICE',
  'package/README.md',
  'package/README.en.md',
  'package/cordis.patch.yml',
  'package/dist/index.js',
  'package/dist/index.d.ts',
  'package/dist/index.js.map',
  'package/locale/en.json',
  'package/locale/zh.json',
]

/** Trees that belong to the repository, never to the artifact. */
const FORBIDDEN_PREFIXES = ['package/src/', 'package/test/', 'package/scripts/', 'package/docs/', 'package/.superpowers/']

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** npm sets `npm_config_*` for lifecycle scripts; never let `--dry-run` leak in. */
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

/** Every `.js`/`.d.ts` under `dist/` must still have its TypeScript source. */
function assertNoOrphans() {
  const dist = join(root, 'dist')
  const orphans = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts'))) {
        const stem = relative(dist, path).replace(/\.d\.ts$|\.js$/, '')
        if (!existsSync(join(root, 'src', `${stem}.ts`))) orphans.push(relative(root, path))
      }
    }
  }
  walk(dist)
  if (orphans.length > 0) {
    throw new Error(`dist has output with no source (stale build?): ${orphans.join(', ')}`)
  }
}

function main() {
  const work = mkdtempSync(join(tmpdir(), 'dsh-boost-verify-'))
  let ok = false
  try {
    const packDir = join(work, 'pack')
    mkdirSync(packDir)
    run(npm, ['pack', '--pack-destination', packDir, '--loglevel=error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] })
    const tarballs = readdirSync(packDir).filter((name) => name.endsWith('.tgz'))
    if (tarballs.length !== 1) {
      throw new Error(`expected exactly one tarball in ${packDir}, found: ${tarballs.join(', ') || 'none'}`)
    }
    const tarball = join(packDir, tarballs[0])

    // `npm pack` ran `prepare`, so `dist/` is the tree that was just packed.
    assertNoOrphans()

    const listed = run('tar', ['-tzf', tarball], { cwd: root })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    for (const required of REQUIRED_ENTRIES) {
      if (!listed.includes(required)) throw new Error(`tarball is missing ${required}`)
    }
    for (const entry of listed) {
      const forbidden = FORBIDDEN_PREFIXES.find((prefix) => entry.startsWith(prefix))
      if (forbidden) throw new Error(`tarball must not ship ${forbidden}* (got ${entry})`)
    }

    const consumer = join(work, 'consumer')
    mkdirSync(consumer)
    writeFileSync(
      join(consumer, 'package.json'),
      `${JSON.stringify({ name: 'dsh-boost-verify-consumer', private: true, type: 'module' }, null, 2)}\n`,
    )
    run(
      npm,
      ['install', tarball, '--ignore-scripts', '--no-package-lock', '--loglevel=error'],
      { cwd: consumer, stdio: ['ignore', 'ignore', 'inherit'] },
    )

    const installed = join(consumer, 'node_modules', 'dsh-boost')
    const installedPkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
    if (installedPkg.name !== 'dsh-boost') throw new Error(`installed name is ${installedPkg.name}`)
    if (installedPkg.version !== pkg.version) {
      throw new Error(`installed version ${installedPkg.version} != package.json ${pkg.version}`)
    }
    if (!existsSync(join(installed, 'dist', 'index.js'))) throw new Error('installed package has no dist/index.js')

    const probe = `
      import assert from 'node:assert/strict'
      import { createRequire } from 'node:module'
      const mod = await import('dsh-boost')
      assert.equal(mod.name, 'dsh-boost')
      assert.deepEqual(Array.from(mod.inject), ${JSON.stringify(EXPECTED_INJECT)})
      assert.equal(typeof mod.apply, 'function')
      const require = createRequire(process.cwd() + '/probe.mjs')
      const cjs = require('dsh-boost')
      assert.equal(cjs.name, 'dsh-boost')
      assert.equal(typeof cjs.apply, 'function')
      assert.ok(require.resolve('dsh-boost/package.json').endsWith('package.json'))
      assert.ok(require.resolve('dsh-boost/locale/en.json').endsWith('en.json'))
      console.log('import-ok')
    `
    run(process.execPath, ['--input-type=module', '-e', probe], { cwd: consumer, stdio: ['ignore', 'pipe', 'inherit'] })

    ok = true
    const bytes = statSync(tarball).size
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          tarball: tarballs[0],
          bytes,
          entries: listed.length,
          checks: ['tar-entries', 'no-dev-trees', 'no-orphan-dist', 'install-ignore-scripts', 'import', 'require', 'exports-resolve'],
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

try {
  main()
} catch (error) {
  console.error(`verify-package: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}