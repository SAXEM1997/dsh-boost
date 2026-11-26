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
 *  - A retry budget shorter than the registry's measured lag turns a complete
 *    release into a red run (0.4.7 had 27 seconds of margin).
 *  - A `gh release create` without `--latest` lets the version-independent
 *    asset URL drift onto whichever release was created most recently.
 *
 * Parsed as YAML rather than matched as text: a text assertion passes on a step
 * that has been commented out, and cannot see which step carries which env.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

// `new URL('..', import.meta.url).pathname` yields `/C:/…` on Windows, where
// readFileSync then fails. docs-version.test.ts already resolves this way.
const root = join(import.meta.dirname, '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

const VERSION = (JSON.parse(read('package.json')) as { version: string }).version

interface Step {
  name?: string
  uses?: string
  run?: string
  if?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
  id?: string
}
interface Workflow {
  on: Record<string, unknown>
  permissions?: Record<string, string>
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean }
  jobs: Record<string, { steps: Step[] }>
}

const workflow = (path: string): Workflow => load(read(path)) as Workflow
const release = workflow('.github/workflows/release.yml')
const ci = workflow('.github/workflows/ci.yml')
const steps = release.jobs['release']?.steps ?? []
const runOf = (s: Step): string => s.run ?? ''
const find = (needle: string): Step | undefined =>
  steps.find((s) => runOf(s).includes(needle) || s.uses?.startsWith(needle) === true)
// Looked up by id or name, not by substring: a step's `run` contains comments,
// and a comment mentioning `npm pack` made a substring search find the wrong
// step (the retry-budget assertion read 20 × 30s from the state probe).
const byId = (id: string): Step => {
  const step = steps.find((s) => s.id === id)
  assert.ok(step, `release.yml has no step with id ${id}`)
  return step
}
const byName = (name: string): Step => {
  const step = steps.find((s) => s.name === name)
  assert.ok(step, `release.yml has no step named ${name}`)
  return step
}

test('release.yml triggers on v* tags and can be exercised without one', () => {
  const push = release.on['push'] as { tags?: string[] } | undefined
  assert.deepEqual(push?.tags, ['v*'], 'release.yml must trigger on v* tags')
  assert.ok(release.on['workflow_dispatch'], 'a tag-only workflow is untested until it matters')
  const dispatch = release.on['workflow_dispatch'] as { inputs?: Record<string, unknown> } | undefined
  assert.ok(dispatch?.inputs?.['dry_run'], 'dispatch must default to a dry run')
})

test('the release job is serialised and may write the release', () => {
  assert.equal(release.permissions?.['contents'], 'write', 'creating a release needs contents: write')
  assert.ok(release.concurrency?.group, 'two runs for one tag race each other into a 409')
  assert.equal(release.concurrency?.['cancel-in-progress'], false, 'cancelling a publish halfway is worse')
})

test('checkout does not persist the write token into .git/config', () => {
  const checkout = find('actions/checkout')
  assert.ok(checkout, 'release.yml has no checkout step')
  assert.equal(checkout.with?.['persist-credentials'], false,
    'the gate runs install scripts; the write token must not be readable by them')
})

test('the gate runs, and the negative cases run with it', () => {
  assert.ok(steps.some((s) => runOf(s).trim() === 'npm run ci'),
    'the explicit gate must be the `npm run ci` step, not a longer command that duplicates prepublishOnly')
  assert.ok(steps.some((s) => runOf(s).includes('npm run verify:negatives')))
})

test('the publish step is the only one holding the npm token', () => {
  const withToken = steps.filter((s) => s.env?.['NODE_AUTH_TOKEN'] === '${{ secrets.NPM_TOKEN }}')
  assert.equal(withToken.length, 2, 'the state probe and the publish step need it; nothing else does')
  const publish = steps.find((s) => runOf(s).trim() === 'npm publish')
  assert.ok(publish, 'no step runs `npm publish`')
  assert.equal(publish.env?.['NODE_AUTH_TOKEN'], '${{ secrets.NPM_TOKEN }}')
  // `if:` is what keeps a dry run from publishing; without it, dispatch publishes.
  assert.match(publish.if ?? '', /dry_run/, 'the publish step must be skipped by a dry run')
})

test('the registry retry budget outlasts the lag we measured', () => {
  // 0.4.7 needed 5m03s; the previous budget was 12 × 30s = 5m30s, which left 27
  // seconds. Anything under 15 minutes repeats that.
  const tarball = byId('tarball')
  const loop = /seq 1 (\d+)/.exec(runOf(tarball))
  assert.ok(loop, 'the pack retry loop is gone')
  const attempts = Number(loop[1])
  const sleeps = Number((/sleep (\d+)/.exec(runOf(tarball)) ?? [])[1] ?? 0)
  assert.ok(attempts * sleeps >= 15 * 60,
    `retry budget ${attempts}×${sleeps}s is under the 15 minutes the registry has needed`)
})

test('the release is created with an explicit latest marker', () => {
  const create = find('gh release create')
  assert.ok(create, 'no step creates the release')
  assert.match(runOf(create), /--latest/,
    'without --latest, releases/latest/download can resolve to another version')
  assert.match(runOf(create), /--notes-file/,
    'the body must come from docs/releases/, not from a web form')
})

test('the asset check compares bytes, not just a status code', () => {
  const check = byName('latest points at this version, byte for byte')
  assert.match(runOf(check), /sha1sum/, 'a 200 can be another version\'s asset')
  assert.match(runOf(check), /tagName/, 'a 200 can be another release\'s asset')
})

test('ci.yml does not also trigger on tags', () => {
  const push = ci.on['push'] as { tags?: string[] } | undefined
  assert.equal(push?.tags, undefined, 'tags belong to release.yml; a second gate doubles the suite')
})

test('this version has release notes, in Chinese then English', () => {
  const path = `docs/releases/v${VERSION}.md`
  assert.ok(existsSync(join(root, path)), `${path} is the release body and must exist`)
  const text = read(path)
  const zh = text.indexOf('**中文**')
  const en = text.indexOf('**English**')
  assert.ok(zh >= 0, `${path} has no **中文** section`)
  assert.ok(en > zh, `${path} must put English after Chinese`)
  // Both halves, not just the English one: clearing the Chinese half used to
  // leave this test green while the release body lost half its content.
  assert.ok(text.slice(zh + '**中文**'.length, en).trim().length > 200,
    `${path}'s Chinese half looks empty`)
  assert.ok(text.slice(en).trim().length > 200, `${path}'s English half looks empty`)
})

// The install pins are NOT re-asserted here. `test/docs-version.test.ts`
// already requires every `^0.4.x` in every doc to equal the current version —
// a strictly stronger claim than "each file mentions the pin at least once",
// which this file used to make and which stayed green with a stale pin sitting
// next to a correct one. The workflow keeps its own grep for the same reason it
// keeps any check: it fails in five seconds, before `npm ci`.
