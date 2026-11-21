// `node --test <glob>` exits 0 when the glob matches nothing, so a renamed or
// deleted test tree silently disables the whole regression gate. Expand the
// glob here and refuse to run on an empty set.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const MINIMUM_FILES = 20

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

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { stdio: 'inherit' },
)
process.exit(result.status ?? 1)
