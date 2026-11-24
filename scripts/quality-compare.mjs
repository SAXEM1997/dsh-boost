#!/usr/bin/env node
/**
 * Compare two arms of a paired quality run.
 *
 * The experiment `scripts/quality-tasks.mjs` feeds: the same tasks run twice,
 * once with the intervention off (baseline) and once on (treatment). This
 * script does the arithmetic and nothing else — no model, no judgement, no
 * invented significance. Given too few pairs it says so instead of reporting a
 * rate that cannot carry a conclusion.
 *
 * Input: two JSON files, each either an array of runs or an object with a
 * `runs` (or `tasks`) array. A run is `{ id, ok, tokens? }`.
 *
 * Usage:
 *   node scripts/quality-compare.mjs --baseline <a.json> --treatment <b.json> [--min-pairs <n>]
 */
import { readFileSync } from 'node:fs'

function usage() {
  process.stderr.write(
    'usage: node scripts/quality-compare.mjs --baseline <a.json> --treatment <b.json> [--min-pairs <n>]\n' +
      '  a run is { id, ok, tokens? }; the file may be an array, or an object with `runs`/`tasks`\n' +
      '  --min-pairs <n>  below this many paired tasks the report says it cannot conclude (default 12)\n',
  )
}

function parseArgs(raw) {
  const args = { baseline: undefined, treatment: undefined, minPairs: 12 }
  for (let index = 0; index < raw.length; index += 1) {
    const flag = raw[index]
    if (flag === '--help' || flag === '-h') return { help: true }
    const value = raw[index + 1]
    if (flag === '--baseline' && value !== undefined) {
      args.baseline = value
      index += 1
    } else if (flag === '--treatment' && value !== undefined) {
      args.treatment = value
      index += 1
    } else if (flag === '--min-pairs' && value !== undefined) {
      args.minPairs = Number(value)
      index += 1
    } else {
      throw new Error(`unknown argument: ${flag}`)
    }
  }
  return args
}

/** Accept the shapes an operator will actually hand us, or refuse loudly. */
function runsOf(document, label) {
  const rows = Array.isArray(document)
    ? document
    : Array.isArray(document?.runs)
      ? document.runs
      : Array.isArray(document?.tasks)
        ? document.tasks
        : undefined
  if (rows === undefined) throw new Error(`${label}: expected an array, or an object with runs/tasks`)
  const runs = new Map()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') throw new Error(`${label}: a run must be an object`)
    if (typeof row.id !== 'string' || row.id === '') throw new Error(`${label}: a run needs a non-empty id`)
    if (typeof row.ok !== 'boolean') throw new Error(`${label}: run ${row.id} needs a boolean ok`)
    const tokens = typeof row.tokens === 'number' && Number.isFinite(row.tokens) ? row.tokens : undefined
    runs.set(row.id, { ok: row.ok, tokens })
  }
  return runs
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
  if (args.help === true) {
    usage()
    return
  }
  if (args.baseline === undefined || args.treatment === undefined) {
    usage()
    process.exit(2)
  }
  let baseline
  let treatment
  try {
    baseline = runsOf(JSON.parse(readFileSync(args.baseline, 'utf8')), 'baseline')
    treatment = runsOf(JSON.parse(readFileSync(args.treatment, 'utf8')), 'treatment')
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }

  const ids = [...new Set([...baseline.keys(), ...treatment.keys()])].sort()
  const mismatches = []
  let compared = 0
  let agree = 0
  let baselineTokens = 0
  let treatmentTokens = 0
  let tokensMeasured = 0
  const missing = { baselineOnly: [], treatmentOnly: [] }
  for (const id of ids) {
    const left = baseline.get(id)
    const right = treatment.get(id)
    if (left === undefined) {
      missing.treatmentOnly.push(id)
      continue
    }
    if (right === undefined) {
      missing.baselineOnly.push(id)
      continue
    }
    compared += 1
    if (left.ok === right.ok) agree += 1
    else mismatches.push({ id, baseline: left.ok, treatment: right.ok })
    if (left.tokens !== undefined && right.tokens !== undefined) {
      tokensMeasured += 1
      baselineTokens += left.tokens
      treatmentTokens += right.tokens
    }
  }

  const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null)
  const enough = compared >= args.minPairs
  const report = {
    version: 1,
    generatedBy: 'scripts/quality-compare.mjs',
    compared,
    agree,
    disagree: compared - agree,
    agreementRate: ratio(agree, compared),
    // Deliberately `null`, not 0: with no measured pair there is nothing to say.
    tokenDelta: tokensMeasured > 0 ? treatmentTokens - baselineTokens : null,
    tokenPairs: tokensMeasured,
    baselineTokens: tokensMeasured > 0 ? baselineTokens : null,
    treatmentTokens: tokensMeasured > 0 ? treatmentTokens : null,
    minPairs: args.minPairs,
    conclusion: enough ? (mismatches.length === 0 ? 'no-difference-observed' : 'difference-observed') : 'insufficient-pairs',
    mismatches,
    missing,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main()
