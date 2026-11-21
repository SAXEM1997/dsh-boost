// `node --test <glob>` exits 0 when the glob matches nothing, so a renamed or
// deleted test tree silently disables the whole regression gate. Expand the
// glob here and refuse to run on an empty set.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const MINIMUM_FILES = 20
const MINIMUM_TESTS = 600

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.name.endsWith('.test.ts')) out.push(path)
  }
  return out
}

const files = walk('test', []).sort()
if (files.length < MINIMUM_FILES) {
  console.error(
    `run-tests: found ${files.length} test file(s) under test/, expected at least ${MINIMUM_FILES}. ` +
      'An empty or truncated test tree must not pass the gate.',
  )
  process.exit(1)
}

// The file count alone is not evidence: twenty empty `.test.ts` files clear it
// and `node --test` reports 20 passing "tests" that assert nothing (review
// ur6-build). Capture the summary line and require real assertions.
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-reporter=spec', ...files],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
)

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
process.stdout.write(output)
if (result.status !== 0) process.exit(result.status ?? 1)

const match = /^\u2139 tests (\d+)$/m.exec(output)
const total = match ? Number(match[1]) : 0
if (total < MINIMUM_TESTS) {
  console.error(
    `run-tests: ${files.length} test file(s) reported ${total} test(s), expected at least ` +
      `${MINIMUM_TESTS}. A tree of empty test files must not pass the gate.`,
  )
  process.exit(1)
}
process.exit(0)
