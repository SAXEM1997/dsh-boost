// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
const VERSION = pkg.version

/**
 * The install spec every operator-facing document names.
 *
 * Four releases in a row shipped with these strings one or two versions behind
 * (0.3.4 in the README while the registry said 0.3.5, `^0.3.6` in five files
 * while `package.json` said 0.3.8). A prose reminder does not survive a release;
 * a failing test does.
 */
const DOCS: { file: string; label: string }[] = [
  { file: 'README.md', label: 'README' },
  { file: 'README.en.md', label: 'README.en' },
  { file: 'docs/RELEASE.md', label: 'RELEASE' },
  { file: 'docs/operating.md', label: 'operating' },
  // `scripts/README.md` used to be listed here and contained no pin at all, so
  // its assertion passed on an empty set — a check that matched nothing read as
  // a check that passed. It is dropped rather than given a pin it does not need.
]

for (const { file, label } of DOCS) {
  test(`${label} 的安装规格与 package.json 版本一致`, () => {
    const text = readFileSync(join(root, file), 'utf8')
    const pinned = [...text.matchAll(/\^0\.\d+\.\d+/g)].map((m) => m[0])
    // Older minor lines (`^0.1.4`, `^0.2.3`) stay in the docs as history and
    // as the "you must bump the minor explicitly" explanation. Only the line
    // the package is currently on must name the current patch.
    const series = `^${VERSION.split('.').slice(0, 2).join('.')}.`
    // A file that names no pin at all would otherwise pass every assertion
    // below by having nothing to fail on.
    assert.ok(pinned.length > 0, `${file} carries no install pin for this test to check`)
    const stale = pinned.filter((p) => p.startsWith(series) && p !== `^${VERSION}`)
    assert.deepEqual(stale, [], `${file} pins ${stale.join(', ')} but the package is ${VERSION}`)
  })
}

test('README 与 operating 写的 latest 就是 package.json 的版本', () => {
  const cases: { file: string; pattern: RegExp }[] = [
    { file: 'README.md', pattern: /`latest` 是\s*`(\d+\.\d+\.\d+)`/ },
    { file: 'README.en.md', pattern: /`latest` at `(\d+\.\d+\.\d+)`/ },
    { file: 'docs/operating.md', pattern: /`latest` 是 `(\d+\.\d+\.\d+)`/ },
  ]
  for (const { file, pattern } of cases) {
    const text = readFileSync(join(root, file), 'utf8')
    const found = text.match(pattern)
    assert.ok(found, `${file} no longer states the latest version in a form this test can read`)
    assert.equal(found[1], VERSION, `${file} says latest is ${String(found[1])}`)
  }
})

test('RELEASE 的版本清单把当前版本标成 latest，且只标一个', () => {
  const text = readFileSync(join(root, 'docs/RELEASE.md'), 'utf8')
  const marked = [...text.matchAll(/^- `(\d+\.\d+\.\d+)` — 当前 `latest`/gm)].map((m) => m[1])
  assert.deepEqual(marked, [VERSION], `the latest marker names ${marked.join(', ')}`)
  assert.ok(
    text.includes(`- \`${VERSION}\` — 当前 \`latest\``),
    `the version list has no entry for ${VERSION}`,
  )
})
