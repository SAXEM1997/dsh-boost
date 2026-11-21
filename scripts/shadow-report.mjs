#!/usr/bin/env node
/**
 * Shadow-week label report.
 *
 * Reads the receipts `ReceiptStore` writes (`<dir>/*.jsonl`, including rotated
 * `.1.jsonl` shards) and prints the four labels the shadow week exists to
 * produce (design §6.1):
 *
 * - `saveableRatio` — the share of substitution decisions the v1 whitelist
 *   could actually realize. Shadow mode records every family (`decide` skips
 *   the whitelist under `shadow: true`), so the numerator is shadow commits
 *   whose `whitelisted` flag is true; the denominator is every substitution
 *   decision. Every-family potential lives in `byFamily`.
 * - `byFamily` — commits / decisions per projection family (`bash`, `read`,
 *   `ssh`, `grep`, `glob`; every other tool is `other`). The key is the
 *   **candidate's** family (`candidateTool`, written by the shadow receipt),
 *   not the tool the model happened to execute; pre-schema receipts without
 *   the field fall back to `tool`.
 * - `candidateRecall` — **not** recall: the commit yield. `commits /
 *   (commits + no-candidate)`, i.e. of the receipts that offered a non-trivial
 *   candidate set, how many produced a commit. Candidate-set recall — did the
 *   plan offer the call the model actually made next? — is unmeasured: shadow
 *   mode never compares the candidate set to the model's next call (design
 *   §6.1). The name is kept for receipt compatibility; read it as a yield.
 * - `retrievalUpperBound` — retrieval calls / applied projection receipts.
 *   Despite the name this is a **lower bound on observed retrieval**, not an
 *   upper bound on damage: it counts only exact locator hits, and a reader who
 *   never finds the locator is invisible here (design §6.1). Treat it as "was
 *   the original ever fetched", not "how much was lost".
 *   A retrieval receipt is itself a cost line, so it is not part of the
 *   projection denominator; otherwise one retrieval would read as 1/2.
 *   **This figure is on-mode-only.** Only `projection:'on'` writes
 *   `kind:'projection'` receipts; a shadow ledger carries `kind:'shadow'` /
 *   `code:'projection-shadow'`, so the ratio is structurally 0 during the
 *   shadow week and cannot bound retrieval damage from that ledger. The
 *   header says so instead of presenting the zero as a measurement.
 *
 * The script is standalone on purpose: it ships to operators, must run under
 * plain `node`, and cannot import the built package (design §11). It only
 * knows the receipt fields the store writes; a corrupt line or an unfinished
 * tail line is skipped, never fatal.
 *
 * A missing directory is *not* silently an empty ledger: an all-zero report
 * from a typo'd path is indistinguishable from a genuine zero-result week, so
 * the script warns on stderr and exits 2 unless `--allow-empty` says the empty
 * report is intentional.
 *
 * Usage: `node scripts/shadow-report.mjs --dir <receipts dir> [--allow-empty]`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const USAGE = `usage: node scripts/shadow-report.mjs --dir <receipts dir> [--allow-empty]

Reads <dir>/*.jsonl (including rotated .1.jsonl shards) and prints the shadow
week labels as JSON.

  --dir <path>     receipts directory written by ReceiptStore
  --allow-empty    print the all-zero report even if <dir> does not exist
  --help, -h       show this message and exit 0
`

const FAMILIES = new Set(['read', 'grep', 'glob', 'bash', 'ssh'])
const MCP_PREFIX = 'mcp__'

/** The projection family of a host tool name; unmapped tools group under `other`. */
function familyOf(name) {
  if (typeof name !== 'string' || name === '') return 'other'
  if (FAMILIES.has(name)) return name
  if (!name.startsWith(MCP_PREFIX)) return 'other'
  const rest = name.slice(MCP_PREFIX.length)
  const separator = rest.indexOf('__')
  if (separator <= 0) return 'other'
  const server = rest.slice(0, separator)
  return FAMILIES.has(server) ? server : 'other'
}

/** Read complete lines only: a trailing line without `\n` was never finished. */
function readShard(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1)
  const rows = []
  for (const line of complete.split('\n')) {
    if (line === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // A corrupt middle line is skipped; it is evidence we cannot use, not a
      // reason to throw away the rest of the ledger.
    }
  }
  return rows
}

/** Every `.jsonl` shard under `dir`, sorted for deterministic output. */
function shards(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries.filter((name) => name.endsWith('.jsonl')).sort().map((name) => join(dir, name))
}

/** Why a receipt counts as a substitution decision attempt, if it does. */
function isDecision(receipt) {
  if (receipt.kind === 'shadow') return receipt.code === 'ok'
  if (receipt.kind !== 'skip') return false
  const code = typeof receipt.code === 'string' ? receipt.code : ''
  // Out-of-scope sessions pay nothing, projection skips are policy not a
  // decision, and the reset/receipt kinds are invalidation evidence.
  return code !== 'skip:no-scope' && !code.startsWith('projection-skipped:')
}

const args = process.argv.slice(2)
function valueOf(flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(USAGE)
  process.exit(0)
}

const allowEmpty = args.includes('--allow-empty')
const dir = valueOf('--dir')
if (dir === undefined || dir === '' || dir.startsWith('--')) {
  console.error(USAGE)
  process.exit(2)
}

let directoryExists = false
try {
  directoryExists = statSync(dir).isDirectory()
} catch {
  directoryExists = false
}
if (!directoryExists) {
  console.error(`shadow-report: receipts directory does not exist or is not a directory: ${dir}`)
  if (!allowEmpty) {
    console.error(
      'shadow-report: refusing to print an all-zero report from a missing directory; ' +
        'pass --allow-empty if this is intentional',
    )
    process.exit(2)
  }
  console.error('shadow-report: --allow-empty set; printing the zero report')
}

let decisions = 0
let whitelistedCommits = 0
let commits = 0
let noCandidate = 0
let appliedProjections = 0
let retrievals = 0
let skippedProjectionShape = 0
const byFamily = new Map()

for (const shard of shards(dir)) {
  for (const receipt of readShard(shard)) {
    if (receipt.kind === 'projection') {
      if (receipt.unit !== 'raw') {
        // Pre-schema/hand-written projection receipts lack the literal the
        // store forces; count them instead of silently folding them into a
        // denominator they do not belong to.
        skippedProjectionShape += 1
        continue
      }
      if (receipt.retrieved === true) retrievals += 1
      else appliedProjections += 1
      continue
    }
    if (!isDecision(receipt)) continue

    decisions += 1
    const family = familyOf(receipt.candidateTool ?? receipt.tool)
    const row = byFamily.get(family) ?? { decisions: 0, commits: 0 }
    row.decisions += 1

    if (receipt.kind === 'shadow' && receipt.decision === 'commit') {
      commits += 1
      row.commits += 1
      if (receipt.whitelisted === true) whitelistedCommits += 1
    } else if (receipt.kind === 'skip' && receipt.code === 'no-candidate') {
      noCandidate += 1
    }
    byFamily.set(family, row)
  }
}

const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : 0)

const report = {
  saveableRatio: ratio(whitelistedCommits, decisions),
  byFamily: Object.fromEntries(
    [...byFamily.entries()].map(([family, row]) => [
      family,
      { decisions: row.decisions, commits: row.commits, hitRate: ratio(row.commits, row.decisions) },
    ]),
  ),
  candidateRecall: ratio(commits, commits + noCandidate),
  retrievalUpperBound: ratio(retrievals, appliedProjections),
}
if (skippedProjectionShape > 0) {
  console.error(
    `shadow-report: skipped ${skippedProjectionShape} projection receipt(s) without unit:'raw'`,
  )
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
