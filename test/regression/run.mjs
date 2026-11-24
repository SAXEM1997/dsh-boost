#!/usr/bin/env node
/**
 * Smoke runner for the projection's "no data lost" invariant.
 *
 * The release notes have called this owed since v1: the 20-task fallback is a
 * human procedure whose task set is not shipped, and the retrieval-integrity
 * check had no automatable form. This runner is that automatable form — it reads
 * `tasks.jsonl`, projects each receipt in-process, and asserts the properties
 * that would break if a future edit spilled a window instead of the receipt.
 *
 * It needs TypeScript sources, so it runs under `tsx`:
 *
 *     npm run test:regression
 *
 * Exit status is the number of failed tasks (0 = all passed).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkIntegrity } from './integrity.ts'

const here = import.meta.dirname
const tasks = readFileSync(join(here, 'tasks.jsonl'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line))

let failed = 0
for (const task of tasks) {
  try {
    const report = await checkIntegrity(task.family, receiptFor(task.lines))
    if (task.expect.applied && !report.applied) throw new Error('expected a projection, got a skip')
    if (!task.expect.applied && report.applied) throw new Error('expected a skip, got a projection')
    const shape = `view ${report.originalBytes}->${report.viewBytes}B, omitted ${report.omittedBytes}, stored ${report.storedBytes}B`
    console.log(`ok   ${task.id.padEnd(20)} ${task.family.padEnd(5)} ${shape}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${task.id.padEnd(20)} ${error instanceof Error ? error.message : String(error)}`)
  }
}

function receiptFor(lines) {
  const row = (index) => `./step-${index}.sh: running checks (${'ok '.repeat(30)})\n`
  return Array.from({ length: lines }, (_, index) => row(index)).join('') + 'ERROR: build failed at src/x.ts:12\nexit code 1\n'
}

console.log(`\n${tasks.length - failed}/${tasks.length} tasks passed`)
process.exit(failed === 0 ? 0 : 1)
