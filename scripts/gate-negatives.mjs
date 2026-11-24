#!/usr/bin/env node
/**
 * Prove the publish gate can fail.
 *
 * `AGENTS.md` requires the gate to be green *and* to have a negative that fails.
 * `test/verify-client.test.ts` covers the client-bundle group; every other
 * assertion in `verify-package.mjs` was only ever observed passing, so a typo in
 * a comparison could turn it into a no-op without anyone noticing.
 *
 * Each case below takes the real, verified tarball, breaks exactly one thing,
 * repacks, and runs the gate against it. A case passes when the gate exits
 * non-zero *and* names the check it failed — exit 1 alone could mean any check
 * fired.
 *
 * Slow by design (the cases that reach the install/typecheck stage run two
 * installs and two `tsc` passes), so it is a separate command rather than part
 * of `npm test`:
 *
 *     npm run verify:negatives
 *
 * Two checks have no case here, and cannot have one:
 *
 *   - `typecheck-no-host-stubs` is a strict superset of `typecheck` by
 *     construction: it drops the stubs that mask host types, so every artifact
 *     that fails it also fails the stubbed pass. Its own guard is the
 *     `declarations-host-free` regex, which runs earlier — a host reference that
 *     regex misses is, by definition, one nobody has found yet.
 *   - the second `import-require-locales` is the same probe against the
 *     lifecycle-scripts install; the `install` case above already proves that
 *     install is checked at all.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const MAX_BUFFER = 64 * 1024 * 1024

/** Run a command, returning its status and combined output instead of throwing. */
function tryRun(file, args, cwd = root) {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER })
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function run(file, args, cwd = root) {
  return execFileSync(file, args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * One way to break the artifact, and the check that must catch it.
 *
 * `mutate` receives the extracted `package/` directory. Every case is applied to
 * a fresh copy, so they cannot mask each other.
 */
const CASES = [
  {
    name: 'dist-index-present',
    expect: /tarball has no package\/dist\/index\.js/,
    mutate(dir) {
      const entry = join(dir, 'package', 'dist', 'index.js')
      // `npm pack` may place the entry under a path the manifest names; delete
      // every candidate so the guard is what fires, not a missing-file error
      // from somewhere else.
      for (const name of ['index.js', 'index.mjs', 'index.cjs']) {
        const candidate = join(dir, 'package', 'dist', name)
        if (existsSync(candidate)) rmSync(candidate)
      }
      if (existsSync(entry)) rmSync(entry)
    },
  },
  {
    name: 'tarball-allowlist',
    expect: /tarball entry is not in the allowlist: package\/dist\/ghost\.js/,
    mutate(dir) {
      writeFileSync(join(dir, 'package', 'dist', 'ghost.js'), 'export {}\n')
      // Keep the exports map honest: the point is an *extra* file, not a broken one.
      const manifestPath = join(dir, 'package', 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    },
  },
  {
    name: 'exports-targets',
    expect: /package\.json exports\b|does not exist/,
    mutate(dir) {
      const manifestPath = join(dir, 'package', 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.exports = { '.': './dist/missing.js' }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    },
  },
  {
    name: 'client-bundle-structure',
    expect: /client bundle/,
    mutate(dir, manifest) {
      const bundle = manifest.exports?.['./client']
      if (typeof bundle !== 'string') return false
      // Relative to the extracted package, never to the repo: writing to the
      // bare manifest value clobbers the real `lib/client.js` in the checkout.
      writeFileSync(join(dir, 'package', bundle), 'module.exports = {}\n')
      return true
    },
    skipIf: (manifest) => manifest.exports?.['./client'] === undefined,
  },
  {
    name: 'bundle-patch',
    expect: /bundle patch|patch/i,
    mutate(dir, manifest) {
      const patch = manifest.dsh?.bundle?.patch
      if (typeof patch !== 'string') return false
      // Valid YAML, wrong content: the file exists and parses, so only the
      // content assertion can catch it.
      writeFileSync(join(dir, 'package', patch), 'insert: []\n')
      return true
    },
    skipIf: (manifest) => typeof manifest.dsh?.bundle?.patch !== 'string',
  },
  {
    name: 'declarations-host-free',
    expect: /@deepseek-ai|host type/,
    mutate(dir, manifest) {
      const types = manifest.types ?? manifest.exports?.['.']?.types
      if (typeof types !== 'string') return false
      const path = join(dir, 'package', types)
      writeFileSync(
        path,
        `${readFileSync(path, 'utf8')}\nimport type { ToolsService } from '@deepseek-ai/dsh-tools'\nexport type Leaked = ToolsService\n`,
      )
      return true
    },
    skipIf: (manifest) => typeof (manifest.types ?? manifest.exports?.['.']?.types) !== 'string',
  },
  {
    name: 'install',
    expect: /failed|postinstall/i,
    mutate(dir, manifest) {
      // A lifecycle script that fails on every real install. The ignore-scripts
      // pass still succeeds, so only the second install can see it.
      manifest.scripts = { ...(manifest.scripts ?? {}), postinstall: 'node -e "process.exit(1)"' }
      writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify(manifest, null, 2))
      return true
    },
  },
  {
    name: 'typecheck',
    expect: /consumer type check/,
    mutate(dir, manifest) {
      const types = manifest.types ?? manifest.exports?.['.']?.types
      if (typeof types !== 'string') return false
      // A syntactically broken declaration: no host import (so the regex scan
      // stays quiet) and the package still imports fine (so the probe passes).
      writeFileSync(join(dir, 'package', types), 'export declare const broken: ;\n')
      return true
    },
    skipIf: (manifest) => typeof (manifest.types ?? manifest.exports?.['.']?.types) !== 'string',
  },
  {
    name: 'import-require-locales',
    expect: /consumer probe failed/,
    mutate(dir, manifest) {
      // Importable but not loadable: the probe's `import()` throws.
      const main = manifest.exports?.['.'] ?? manifest.main
      const target = typeof main === 'string' ? main : main?.import ?? main?.default
      if (typeof target !== 'string') return false
      writeFileSync(join(dir, 'package', target), 'throw new Error("gate negative")\n')
      return true
    },
    skipIf: (manifest) => manifest.exports?.['.'] === undefined && manifest.main === undefined,
  },
]

function repack(dir, out) {
  // File names only: `tar` would otherwise record a bare `package/` (and one per
  // directory) as its own entry, which the allowlist correctly rejects — the
  // real `npm pack` artifact lists files only.
  run('bash', [
    '-c',
    `cd ${JSON.stringify(dir)} && find package -type f -print0 | tar --null -czf ${JSON.stringify(out)} -T -`,
  ])
}

function main() {
  const work = mkdtempSync(join(tmpdir(), 'dsh-boost-negatives-'))
  let failures = 0
  try {
    // One real tarball, so every case starts from the artifact that passes.
    // `npm pack` is what the gate itself packs; `--ignore-scripts` keeps the
    // lifecycle hooks out of this half (the gate runs them in its own copy).
    run(process.execPath, ['scripts/verify-package.mjs', '--prebuilt'])
    run('npm', ['pack', '--ignore-scripts', '--pack-destination', work])
    const packed = run('ls', [work]).split('\n').find((name) => name.endsWith('.tgz'))
    if (packed === undefined) throw new Error(`npm pack wrote no tarball into ${work}`)
    const real = join(work, packed)
    const ok = tryRun(process.execPath, ['scripts/verify-package.mjs', '--tarball', real])
    if (ok.status !== 0) {
      throw new Error(`the unmodified tarball does not pass its own gate:\n${ok.output}`)
    }
    console.log('baseline: the unmodified tarball passes')

    for (const testCase of CASES) {
      const dir = join(work, testCase.name)
      run('mkdir', ['-p', dir])
      run('tar', ['-xzf', real, '-C', dir, '--no-same-owner'])
      const manifest = JSON.parse(readFileSync(join(dir, 'package', 'package.json'), 'utf8'))
      if (testCase.skipIf?.(manifest) === true) {
        console.log(`skip  ${testCase.name}: this artifact has no such target`)
        continue
      }
      const applied = testCase.mutate(dir, manifest) === true || testCase.mutate(dir) !== false
      if (!applied) {
        console.log(`skip  ${testCase.name}: nothing to corrupt`)
        continue
      }
      const broken = join(work, `${testCase.name}.tgz`)
      repack(dir, broken)
      const result = tryRun(process.execPath, ['scripts/verify-package.mjs', '--tarball', broken])
      const caught = result.status !== 0 && testCase.expect.test(result.output)
      if (caught) {
        console.log(`ok    ${testCase.name}: gate exits ${result.status} and names the check`)
      } else {
        failures += 1
        console.error(
          `FAIL  ${testCase.name}: expected exit != 0 matching ${testCase.expect} — got ${result.status}\n` +
            `${result.output.split('\n').slice(0, 12).join('\n')}`,
        )
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  if (failures > 0) {
    console.error(`\n${failures} negative case(s) did not fail the gate`)
    process.exit(1)
  }
  console.log('\nall negative cases fail the gate')
}

main()
