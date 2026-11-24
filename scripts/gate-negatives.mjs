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
 * All twelve check instances have a case. An earlier version of this file
 * claimed three of them could not be isolated; each of those claims was wrong,
 * and the corrections are what the cases for `install (ignore-scripts)`,
 * `typecheck-no-host-stubs` and `import-require-locales (default)` now pin:
 * a manifest that refuses to install on this platform, a host type hidden past
 * the declaration regex's 400-character reach (the un-stubbed `tsc` pass is the
 * only thing that sees it), and a `postinstall` that breaks the module after a
 * successful install.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { CHECK_NAMES } from './checks.mjs'

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
 * One way to break the artifact, and the message that must name the check.
 *
 * Each `expect` is the *specific* failure text, not a word that happens to
 * appear in several checks' output: `install`, `typecheck` and the probe all
 * print "failed", so a loose pattern lets one case go green on another check's
 * failure.
 *
 * `mutate` returns `true` when it changed something, `false` when this artifact
 * has nothing to change. Anything else is a bug in the case, not a skip.
 */
const CASES = [
  {
    name: 'dist-index-present',
    expect: /tarball has no package\/dist\/index\.js/,
    mutate(dir) {
      for (const name of ['index.js', 'index.mjs', 'index.cjs']) {
        const candidate = join(dir, 'package', 'dist', name)
        if (existsSync(candidate)) rmSync(candidate)
      }
      return true
    },
  },
  {
    name: 'tarball-allowlist',
    expect: /tarball entry is not in the allowlist: package\/dist\/ghost\.js/,
    mutate(dir) {
      writeFileSync(join(dir, 'package', 'dist', 'ghost.js'), 'export {}\n')
      return true
    },
  },
  {
    name: 'exports-targets (ignore-scripts)',
    expect: /declared \. -> \.\/dist\/missing\.js does not exist/,
    mutate(dir, manifest) {
      manifest.exports = { '.': './dist/missing.js' }
      writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify(manifest, null, 2))
      return true
    },
  },
  {
    name: 'client-bundle-structure',
    expect: /client bundle has no `window\.__ModuleLoader__\.load/,
    mutate(dir, manifest) {
      const bundle = manifest.exports?.['./client']
      if (typeof bundle !== 'string') return false
      writeFileSync(safePath(dir, bundle), 'module.exports = {}\n')
      return true
    },
  },
  {
    name: 'bundle-patch (ignore-scripts)',
    expect: /dsh\.bundle\.patch must be a non-empty YAML array of patch entries/,
    mutate(dir, manifest) {
      const patch = manifest.dsh?.bundle?.patch
      if (typeof patch !== 'string') return false
      // Valid YAML, wrong content: the file exists and parses, so only the
      // content assertion can catch it.
      writeFileSync(safePath(dir, patch), 'insert: []\n')
      return true
    },
  },
  {
    name: 'declarations-host-free',
    expect: /imports a host type from @deepseek-ai\//,
    mutate(dir, manifest) {
      const types = manifest.types ?? manifest.exports?.['.']?.types
      if (typeof types !== 'string') return false
      const path = safePath(dir, types)
      writeFileSync(
        path,
        `${readFileSync(path, 'utf8')}\nimport type { ToolsService } from '@deepseek-ai/dsh-tools'\nexport type Leaked = ToolsService\n`,
      )
      return true
    },
  },
  {
    name: 'typecheck-no-host-stubs (ignore-scripts)',
    expect: /consumer type check without host stubs failed/,
    mutate(dir, manifest) {
      const types = manifest.types ?? manifest.exports?.['.']?.types
      if (typeof types !== 'string') return false
      // Hide the host import from the declaration regex (which allows 400
      // characters between `import` and the module name) but keep it real for
      // `tsc`. This is the only case that exercises the un-stubbed pass: the
      // stubbed pass resolves the type and succeeds.
      const pad = ' '.repeat(600)
      const path = safePath(dir, types)
      writeFileSync(
        path,
        `${readFileSync(path, 'utf8')}\nimport type {${pad}JsonSchemaNode} from '@deepseek-ai/dsh-tools'\nexport type Leaked = JsonSchemaNode\n`,
      )
      return true
    },
  },
  {
    name: 'install (ignore-scripts)',
    expect: /ignore-scripts install failed[\s\S]*EBADPLATFORM/,
    mutate(dir, manifest) {
      // The artifact is refused before any script runs, so only the first
      // install can see it. A failing `postinstall` would prove the *second*
      // install instead — that is a different check instance.
      manifest.os = ['aix']
      writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify(manifest, null, 2))
      return true
    },
  },
  {
    name: 'install (default)',
    expect: /default install \(lifecycle scripts enabled\) failed[\s\S]*process\.exit\(1\)/,
    mutate(dir, manifest) {
      manifest.scripts = { ...(manifest.scripts ?? {}), postinstall: 'node -e "process.exit(1)"' }
      writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify(manifest, null, 2))
      return true
    },
  },
  {
    name: 'typecheck (ignore-scripts)',
    expect: /consumer type check with host stubs failed/,
    mutate(dir, manifest) {
      const types = manifest.types ?? manifest.exports?.['.']?.types
      if (typeof types !== 'string') return false
      // A syntactically broken declaration: no host import (so the regex scan
      // stays quiet) and the package still imports fine (so the probe passes).
      writeFileSync(safePath(dir, types), 'export declare const broken: ;\n')
      return true
    },
  },
  {
    name: 'import-require-locales (ignore-scripts)',
    expect: /consumer probe failed \(ignore-scripts install\)/,
    mutate(dir, manifest) {
      const main = manifest.exports?.['.'] ?? manifest.main
      const target = typeof main === 'string' ? main : main?.import ?? main?.default
      if (typeof target !== 'string') return false
      // Importable but not loadable: the probe's `import()` throws.
      writeFileSync(safePath(dir, target), 'throw new Error("gate negative")\n')
      return true
    },
  },
  {
    name: 'import-require-locales (default)',
    expect: /consumer probe failed \(default install\)/,
    mutate(dir, manifest) {
      const main = manifest.exports?.['.'] ?? manifest.main
      const target = typeof main === 'string' ? main : main?.import ?? main?.default
      if (typeof target !== 'string') return false
      // The install itself succeeds; the postinstall then breaks the module, so
      // only the second probe can see it. No nested quoting: the JS is one line
      // with single quotes inside a double-quoted `-e`, and no newline escapes.
      manifest.scripts = {
        ...(manifest.scripts ?? {}),
        postinstall: `node -e "require('fs').writeFileSync('${target.replace(/^\.\//, '')}','throw new Error(1)')"`,
      }
      writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify(manifest, null, 2))
      return true
    },
  },
]

/** Resolve a manifest-relative path, refusing anything that escapes the copy. */
function safePath(dir, relative) {
  const base = resolve(dir, 'package')
  const target = resolve(base, relative)
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`manifest path escapes the package copy: ${relative}`)
  }
  return target
}

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
  const ran = []
  let failures = 0
  try {
    // Preflight: the harness packs the built tree, so a missing artifact is a
    // usage error worth naming, not a stack trace from `execFileSync`.
    for (const [file, hint] of [
      ['dist/index.js', 'npm run build'],
      ['lib/client.js', 'npm run build:client (or npm run build)'],
    ]) {
      if (!existsSync(join(root, file))) {
        throw new Error(`missing ${file}; run \`${hint}\` before this command`)
      }
    }

    // One real tarball, so every case starts from the artifact that passes.
    // `npm pack` is what the gate itself packs; `--ignore-scripts` keeps the
    // lifecycle hooks out of this half (the gate runs them in its own copy).
    run('npm', ['pack', '--ignore-scripts', '--pack-destination', work])
    const packed = run('ls', [work]).split('\n').find((name) => name.endsWith('.tgz'))
    if (packed === undefined) throw new Error(`npm pack wrote no tarball into ${work}`)
    const real = join(work, packed)
    const ok = tryRun(process.execPath, ['scripts/verify-package.mjs', '--tarball', real])
    if (ok.status !== 0) {
      throw new Error(`the unmodified tarball does not pass its own gate:\n${ok.output}`)
    }
    console.log(`baseline: the unmodified tarball passes (${pkgPath()})`)

    for (const testCase of CASES) {
      const dir = join(work, testCase.name.replace(/[^a-z0-9-]+/gi, '-'))
      run('mkdir', ['-p', dir])
      run('tar', ['-xzf', real, '-C', dir, '--no-same-owner'])
      const manifest = JSON.parse(readFileSync(join(dir, 'package', 'package.json'), 'utf8'))
      const applied = testCase.mutate(dir, manifest)
      if (typeof applied !== 'boolean') {
        throw new Error(`${testCase.name}: mutate() must return true or false, got ${typeof applied}`)
      }
      if (!applied) {
        // A skip is a failure: the artifact changed shape, so this check is no
        // longer proven to fail, and a green run would hide that.
        failures += 1
        console.error(`FAIL  ${testCase.name}: nothing to corrupt — the artifact no longer has the target`)
        continue
      }
      const broken = join(work, `${testCase.name.replace(/[^a-z0-9-]+/gi, '-')}.tgz`)
      run('bash', [
        '-c',
        `cd ${JSON.stringify(dir)} && find package -type f -print0 | tar --null -czf ${JSON.stringify(broken)} -T -`,
      ])
      const result = tryRun(process.execPath, ['scripts/verify-package.mjs', '--tarball', broken])
      ran.push(testCase.name)
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
    // Coverage is two statements: every canonical check has a case, and every
    // case ran. `ran.length === CASES.length` alone compares the list to itself.
    const names = CASES.map((testCase) => testCase.name)
    const uncovered = CHECK_NAMES.filter((name) => !names.includes(name))
    const extra = names.filter((name) => !CHECK_NAMES.includes(name))
    if (uncovered.length > 0 || extra.length > 0) {
      failures += 1
      console.error(
        `no case for: ${uncovered.join(', ') || 'none'}; case with no check: ${extra.join(', ') || 'none'}`,
      )
    }
    if (ran.length !== CASES.length) {
      failures += 1
      console.error(`\nonly ${ran.length}/${CASES.length} cases ran`)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  if (failures > 0) {
    console.error(`\n${failures} negative case(s) did not fail the gate (${ran.length}/${CASES.length} ran)`)
    process.exit(1)
  }
  console.log(`\nall ${ran.length}/${CASES.length} negative cases fail the gate`)
}

/** The packed artifact's name, for the baseline line. */
function pkgPath() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return `${manifest.name}@${manifest.version}`
}

main()
