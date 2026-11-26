/**
 * The release path is a workflow, not a habit.
 *
 * Everything asserted here fails silently in production when it is wrong, which
 * is exactly why it belongs in the suite rather than in a checklist:
 *
 *  - A tag that does not name the `package.json` version publishes one version
 *    while the tag and the release announce another.
 *  - A missing `docs/releases/v<version>.md` means the release body has to be
 *    invented in a web form after the fact, and the bilingual format is lost.
 *  - A `ci.yml` that also listens for tags runs the whole suite twice per
 *    release, and makes it ambiguous which run is authoritative.
 *
 * Read as text rather than parsed: the workflows are YAML with heavy comments,
 * and the assertions are about triggers, permissions and command presence, not
 * about structure. A YAML round-trip would drop the comments that carry the
 * reasoning.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

const VERSION = (JSON.parse(read('package.json')) as { version: string }).version

test('release.yml exists, triggers on v* tags, and may write the release', () => {
  const text = read('.github/workflows/release.yml')
  assert.match(text, /^on:\n {2}push:\n {4}tags: \['v\*'\]/m, 'release.yml must trigger on v* tags')
  assert.match(text, /^permissions:\n {2}contents: write$/m, 'creating a release needs contents: write')
})

test('release.yml runs the gate, the negative cases, and publishes', () => {
  const text = read('.github/workflows/release.yml')
  for (const command of [
    'npm run ci && npm run verify:package -- --prebuilt',
    'npm run verify:negatives',
    'npm publish',
    'gh release create',
    'gh release upload',
  ]) {
    assert.ok(text.includes(command), `release.yml is missing: ${command}`)
  }
})

test('ci.yml does not also trigger on tags', () => {
  const text = read('.github/workflows/ci.yml')
  assert.doesNotMatch(text, /tags: \['v\*'\]/, 'tags belong to release.yml; a second gate doubles the suite')
})

test('this version has release notes, in Chinese then English', () => {
  const path = `docs/releases/v${VERSION}.md`
  assert.ok(existsSync(join(root, path)), `${path} is the release body and must exist`)
  const text = read(path)
  const zh = text.indexOf('**中文**')
  const en = text.indexOf('**English**')
  assert.ok(zh >= 0, `${path} has no **中文** section`)
  assert.ok(en > zh, `${path} must put English after Chinese`)
  assert.ok(text.slice(en).trim().length > 200, `${path}'s English half looks empty`)
})

test('every doc that carries the install pin names this version', () => {
  // The same fact as the workflow's own check, kept here so a local `npm test`
  // catches it before a tag is pushed. `docs-version` covers the pin format;
  // this covers the set of files.
  for (const file of ['README.md', 'README.en.md', 'docs/RELEASE.md', 'docs/operating.md']) {
    assert.ok(read(file).includes(`dsh-boost@^${VERSION}`), `${file} does not name @^${VERSION}`)
  }
})
