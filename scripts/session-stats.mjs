#!/usr/bin/env node
/**
 * §2.1 session statistics, replayable from a committed aggregate.
 *
 * Two modes, both printing JSON:
 *
 * - `--snapshot <path>` (the default, and what `npm run stats` uses) folds the
 *   committed `scripts/session-snapshot.json`. The snapshot holds per-session
 *   counters and the two numeric series the percentiles need, never a
 *   transcript, so CI can verify the design's §2.1 table from a clean clone.
 * - `--sessions <dir>` regenerates that snapshot from a real `$DSH_HOME/sessions`
 *   tree (`session.v4.jsonl.zstd` files), taking the 300 largest by compressed
 *   size as §2.1 does. With `--out <path>` the snapshot is written there and a
 *   small JSON receipt is printed instead of the whole document. `--as-of
 *   <ISO-8601>` freezes the event view: only lines at or before that instant
 *   are counted, and sessions are ranked by their raw prefix bytes. That option
 *   exists because the design's snapshot is historical — the live tree keeps
 *   growing — and a frozen cut is the only honest way to replay it. An empty
 *   or wholly unreadable corpus is refused (non-zero, nothing written) unless
 *   `--allow-empty` is passed.
 *
 * The script is delivered to operators (design §11) and therefore imports only
 * `node:` builtins; it must not import `src/` or require the package's build.
 * It runs under plain `node` (the package's `engines.node` floor, >= 24.9; `zlib.zstdDecompressSync`
 * is available well below that, but the floor is what a maintainer can rely on).
 *
 * ## The §2.1 definitions implemented here
 *
 * - **Step** is one `step/start` record; **tool call** is one `tool/call`
 *   record. The token denominator is steps, exactly as §2.1 states.
 * - **Replay tokens** per request is `usage.totalTokens` (`uncached input +
 *   cacheRead + cacheWrite + output`); per step it is the sum of the step's
 *   request tokens divided by steps.
 * - **Cache hit share** is `Σ cacheRead / (Σ input + Σ cacheRead)`, the same
 *   definition `cache_hit_delta` uses (design §5.3): `inputTokens` already
 *   excludes the cached part.
 * - **Receipt size** is the character count of the concatenated text blocks in
 *   one `tool/result`; percentiles use the nearest-lower rank on the pooled
 *   sorted array.
 * - **Tool share** attributes a result's characters to the `tool/call` name
 *   that produced it, mapped to a projection family (`bash` / `read` / `ssh` /
 *   `grep` / `glob`); every other tool is `other`.
 * - **Whitelist coverage**: *call share* is read/grep/glob calls over all
 *   calls; a **full-coverage step** has at least one call and every call is
 *   whitelisted; a **single-call step** has exactly one call and it is
 *   whitelisted. The token share is the full-coverage steps' token sum over all
 *   steps' tokens.
 * - **Value transfer** is call-level, not leaf-level: one position is one
 *   next-step call whose previous step (same turn) has exactly one tool call,
 *   so the receipt source is unambiguous. For that call, every string argument
 *   leaf of length >= 4 is tested. *Full* means there is at least one such
 *   leaf and every one occurs verbatim in the previous step's receipt text.
 *   *Partial* means not full, but at least one leaf of length >= 8 occurs
 *   verbatim. A call with no qualifying leaf is still a position (it is a
 *   decidable next call) but contributes to neither bound count. The design's
 *   7.14% is a lower bound of extraction/transformation transfers; this
 *   implements the verbatim half only.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const SESSION_FILE = 'session.v4.jsonl.zstd'
const TOP_SESSIONS = 300
const WHITELIST = new Set(['read', 'grep', 'glob'])
const FAMILIES = new Set(['read', 'grep', 'glob', 'bash', 'ssh'])
const MCP_PREFIX = 'mcp__'
/** A shorter argument is not a meaningful verbatim-transfer test. */
const MIN_POSITION_CHARS = 4
/** A partial binding needs a whole argument of at least this length. */
const MIN_PARTIAL_CHARS = 8

const round = (value, digits) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/** Every `session.v4.jsonl.zstd` under `root`, recursively (symlinks skipped). */
function listSessionFiles(root) {
  const files = []
  const visit = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name === SESSION_FILE) files.push(path)
    }
  }
  visit(root)
  return files
}

/** Header fields and the raw prefix size up to `asOf`; no event accounting. */
function prefixInfo(path, asOf) {
  let text
  try {
    text = zstdDecompressSync(readFileSync(path)).toString('utf8')
  } catch {
    return undefined
  }
  let bytes = 0
  let id
  let createdAt
  for (const line of text.split('\n')) {
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      bytes += Buffer.byteLength(line) + 1
      continue
    }
    if (asOf !== undefined) {
      const time = eventTime(record)
      if (time !== undefined && time > asOf) break
    }
    bytes += Buffer.byteLength(line) + 1
    if (record.type === 'session') {
      if (typeof record.id === 'string') id = record.id
      if (typeof record.createdAt === 'number') createdAt = record.createdAt
    }
  }
  return { id, createdAt, prefixBytes: bytes }
}

// ---------------------------------------------------------------------------
// Session analysis
// ---------------------------------------------------------------------------

/** The projection family of a host tool name, or `other` when unmapped. */
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

/** All string leaves of a parsed JSON value, recursively. */
function stringLeaves(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const child of value) stringLeaves(child, out)
  else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) stringLeaves(child, out)
  }
  return out
}

function parseArgs(raw) {
  if (raw !== null && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function textOfResult(data) {
  const content = data?.message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && block.text !== undefined) {
      text += block.text
    }
  }
  return text
}

/** The event timestamp, or `undefined` for header/derived records. */
function eventTime(record) {
  if (typeof record.time === 'number') return record.time
  if (typeof record.data?.time === 'number') return record.data.time
  return undefined
}

/**
 * One session's counters.
 *
 * `asOf` is an epoch-ms cutoff (inclusive): records after it are ignored, and
 * the returned `bytes` is the raw inspected-prefix size rather than the live
 * compressed size. The array series (`requestTokens`, `receiptChars`) are what
 * the pooled median/percentiles need; everything else is already a counter.
 */
function analyseSession(path, asOf) {
  let text
  try {
    text = zstdDecompressSync(readFileSync(path)).toString('utf8')
  } catch {
    return undefined
  }

  let prefixBytes = 0
  let id
  let createdAt
  let requests = 0
  let toolCalls = 0
  const tokens = { input: 0, cacheRead: 0, output: 0, total: 0 }
  const requestTokens = []
  const receiptChars = []
  const toolChars = {}
  const callNames = new Map()
  const steps = []
  const stepByKey = new Map()
  let currentStep

  const stepFor = (turn, step) => {
    const key = `${turn}:${step}`
    let row = stepByKey.get(key)
    if (row === undefined) {
      row = { turn, step, names: [], argsList: [], resultTexts: [], tokens: 0 }
      stepByKey.set(key, row)
      steps.push(row)
    }
    return row
  }

  for (const line of text.split('\n')) {
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      prefixBytes += Buffer.byteLength(line) + 1
      continue
    }
    const time = eventTime(record)
    if (asOf !== undefined && time !== undefined && time > asOf) break
    prefixBytes += Buffer.byteLength(line) + 1

    if (record.type === 'session') {
      if (typeof record.id === 'string') id = record.id
      if (typeof record.createdAt === 'number') createdAt = record.createdAt
      continue
    }
    if (record.type === 'step/start') {
      currentStep = stepFor(record.data?.turn, record.data?.step)
      continue
    }
    if (record.type === 'tool/call') {
      toolCalls += 1
      const data = record.data ?? {}
      const row = currentStep ?? stepFor(data.turn, data.step)
      row.names.push(typeof data.name === 'string' ? data.name : '')
      row.argsList.push(parseArgs(data.arguments))
      if (typeof data.callId === 'string' && typeof data.name === 'string') {
        callNames.set(data.callId, data.name)
      }
      continue
    }
    if (record.type === 'tool/result') {
      const data = record.data ?? {}
      const text = textOfResult(data)
      receiptChars.push(text.length)
      const row = stepByKey.get(`${data.turn}:${data.step}`) ?? currentStep
      if (row !== undefined) row.resultTexts.push(text)
      const toolCallId =
        typeof data.toolCallId === 'string' ? data.toolCallId : data.message?.toolCallId
      const name = typeof toolCallId === 'string' ? callNames.get(toolCallId) : undefined
      const family = familyOf(name)
      toolChars[family] = (toolChars[family] ?? 0) + text.length
      continue
    }
    if (record.type === 'assistant/message') {
      const usage = record.data?.usage
      if (usage === null || typeof usage !== 'object') continue
      // `cacheReadTokens`/`cacheWriteTokens` are omitted when zero; the three
      // mutually exclusive sides default to zero, but a missing total cannot be
      // reconstructed honestly and is skipped.
      const input = Number(usage.inputTokens ?? 0)
      const cacheRead = Number(usage.cacheReadTokens ?? 0)
      const output = Number(usage.outputTokens ?? 0)
      const total = Number(usage.totalTokens)
      if (![input, cacheRead, output, total].every(Number.isFinite)) continue
      requests += 1
      tokens.input += input
      tokens.cacheRead += cacheRead
      tokens.output += output
      tokens.total += total
      requestTokens.push(total)
      const row = stepByKey.get(`${record.data?.turn}:${record.data?.step}`)
      if (row !== undefined) row.tokens += total
    }
  }

  let whitelistCalls = 0
  let fullSteps = 0
  let singleCallSteps = 0
  let fullStepTokens = 0
  let positions = 0
  let full = 0
  let partial = 0
  const callsPerStep = {}

  for (let index = 0; index < steps.length; index += 1) {
    const rowCalls = steps[index].names.length
    callsPerStep[rowCalls] = (callsPerStep[rowCalls] ?? 0) + 1
    const row = steps[index]
    const count = row.names.length
    const allWhitelisted = count > 0 && row.names.every((name) => WHITELIST.has(name))
    for (const name of row.names) if (WHITELIST.has(name)) whitelistCalls += 1
    if (allWhitelisted) {
      fullSteps += 1
      fullStepTokens += row.tokens
    }
    if (count === 1 && WHITELIST.has(row.names[0])) singleCallSteps += 1

    const previous = steps[index - 1]
    if (previous === undefined || previous.turn !== row.turn) continue
    // The design's unit is the call, not the leaf: an unambiguous receipt
    // source is a previous step with exactly one tool call. Every next call
    // in that step is one position, even when it carries no string argument.
    if (previous.names.length !== 1) continue
    const haystack = previous.resultTexts.join('\n')
    for (const args of row.argsList) {
      positions += 1
      const values = stringLeaves(args)
        .map((value) => value.trim())
        .filter((value) => value.length >= MIN_POSITION_CHARS)
      if (values.length === 0) continue
      const matched = values.filter((value) => haystack.includes(value))
      if (matched.length === values.length) {
        full += 1
      } else if (values.some((value) => value.length >= MIN_PARTIAL_CHARS && haystack.includes(value))) {
        partial += 1
      }
    }
  }

  return {
    id: id ?? sessionIdOf(path),
    bytes: asOf === undefined ? statSync(path).size : prefixBytes,
    createdAt,
    steps: steps.length,
    toolCalls,
    callsPerStep,
    requests,
    tokens,
    requestTokens,
    receiptChars,
    toolChars,
    valueTransfer: { positions, full, partial },
    whitelist: { calls: whitelistCalls, fullSteps, singleCallSteps, fullStepTokens },
  }
}

/** Header id, falling back to the containing directory name. */
function sessionIdOf(path) {
  return dirname(path).split(/[\\/]/).pop() ?? path
}

// ---------------------------------------------------------------------------
// Snapshot → §2.1 table
// ---------------------------------------------------------------------------

/** Pooled percentile, nearest-lower rank; `sorted` must be ascending. */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]
}

/** Recompute every §2.1 row from the aggregate. */
function statsFromSnapshot(snapshot) {
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : []
  const requestTokens = []
  const receiptChars = []
  const callsPerStep = { 0: 0, 1: 0, 2: 0, threeOrMore: 0 }
  const tokens = { input: 0, cacheRead: 0, output: 0, total: 0 }
  const toolChars = {}
  let steps = 0
  let toolCalls = 0
  let requests = 0
  let whitelistCalls = 0
  let fullSteps = 0
  let singleCallSteps = 0
  let fullStepTokens = 0
  let positions = 0
  let full = 0
  let partial = 0

  for (const session of sessions) {
    steps += session.steps ?? 0
    toolCalls += session.toolCalls ?? 0
    requests += session.requests ?? 0
    for (const key of ['input', 'cacheRead', 'output', 'total']) {
      tokens[key] += session.tokens?.[key] ?? 0
    }
    for (const value of session.requestTokens ?? []) requestTokens.push(value)
    for (const value of session.receiptChars ?? []) receiptChars.push(value)
    for (const [family, chars] of Object.entries(session.toolChars ?? {})) {
      toolChars[family] = (toolChars[family] ?? 0) + chars
    }
    const histogram = session.callsPerStep ?? {}
    for (const [calls, count] of Object.entries(histogram)) {
      const n = Number(calls)
      if (n === 0) callsPerStep[0] += count
      else if (n === 1) callsPerStep[1] += count
      else if (n === 2) callsPerStep[2] += count
      else callsPerStep.threeOrMore += count
    }
    whitelistCalls += session.whitelist?.calls ?? 0
    fullSteps += session.whitelist?.fullSteps ?? 0
    singleCallSteps += session.whitelist?.singleCallSteps ?? 0
    fullStepTokens += session.whitelist?.fullStepTokens ?? 0
    positions += session.valueTransfer?.positions ?? 0
    full += session.valueTransfer?.full ?? 0
    partial += session.valueTransfer?.partial ?? 0
  }

  requestTokens.sort((a, b) => a - b)
  receiptChars.sort((a, b) => a - b)
  const receiptCharsTotal = toolCharsTotal(toolChars)
  const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : 0)

  const toolShare = {}
  for (const [family, chars] of Object.entries(toolChars).sort((a, b) => b[1] - a[1])) {
    toolShare[family] = round(ratio(chars, receiptCharsTotal), 4)
  }

  return {
    asOf: snapshot?.asOf ?? null,
    sessionCount: sessions.length,
    steps,
    toolCalls,
    stepsPerSession: round(ratio(steps, sessions.length), 2),
    callsPerStep: {
      zero: round(ratio(callsPerStep[0], steps), 3),
      one: round(ratio(callsPerStep[1], steps), 3),
      two: round(ratio(callsPerStep[2], steps), 3),
      threeOrMore: round(ratio(callsPerStep.threeOrMore, steps), 3),
    },
    requests,
    totalTokens: tokens.total,
    meanTokensPerRequest: Math.round(ratio(tokens.total, requests)),
    medianTokensPerRequest: percentile(requestTokens, 0.5),
    meanTokensPerStep: Math.round(ratio(tokens.total, steps)),
    cacheHitShare: round(ratio(tokens.cacheRead, tokens.input + tokens.cacheRead), 4),
    receiptChars: {
      count: receiptChars.length,
      p50: percentile(receiptChars, 0.5),
      p90: percentile(receiptChars, 0.9),
      p99: percentile(receiptChars, 0.99),
      over2000Share: round(
        ratio(receiptChars.filter((chars) => chars > 2000).length, receiptChars.length),
        4,
      ),
    },
    toolShare,
    whitelist: {
      calls: whitelistCalls,
      callShare: round(ratio(whitelistCalls, toolCalls), 4),
      fullSteps,
      fullStepShare: round(ratio(fullSteps, steps), 4),
      singleCallSteps,
      singleCallShare: round(ratio(singleCallSteps, steps), 4),
      tokenShare: round(ratio(fullStepTokens, tokens.total), 4),
      stepMeanTokens: Math.round(ratio(fullStepTokens, fullSteps)),
      globalStepMeanTokens: Math.round(ratio(tokens.total, steps)),
    },
    valueTransfer: {
      positions,
      full,
      partial,
      rate: round(ratio(full + partial, positions), 4),
    },
  }
}

function toolCharsTotal(toolChars) {
  let total = 0
  for (const chars of Object.values(toolChars)) total += chars
  return total
}

/**
 * Snapshot JSON with one session per line.
 *
 * The array form keeps a 300-session aggregate reviewable in a diff; the
 * numbers are byte-identical to `JSON.stringify(snapshot)` once parsed.
 */
function serialiseSnapshot(snapshot) {
  const head = JSON.stringify(
    {
      version: snapshot.version,
      asOf: snapshot.asOf,
      generatedBy: snapshot.generatedBy,
      selection: snapshot.selection,
    },
    null,
    2,
  )
  const open = head.slice(0, head.lastIndexOf('}')).replace(/\s+$/, '')
  const rows = snapshot.sessions.map((session) => `    ${JSON.stringify(session)}`).join(',\n')
  return `${open},\n  "sessions": [\n${rows}${rows === '' ? '' : '\n'}  ]\n}\n`
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

if (has('--help') || has('-h')) {
  process.stdout.write(`usage: node scripts/session-stats.mjs [--snapshot <path>]
       node scripts/session-stats.mjs --sessions <dir> [--as-of <ISO-8601>] [--out <path>] [--allow-empty]

Prints session statistics as one JSON document on stdout; diagnostics go to
stderr. This direct invocation is the quiet machine-readable form. \`npm run
stats\` prints npm's own banner on stdout first, so either use this command or
\`npm run --silent stats\` when piping into jq or another parser.\n`)
  process.exit(0)
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const snapshotPath = valueOf('--snapshot') ?? join(scriptDir, 'session-snapshot.json')

if (has('--sessions')) {
  const sessionsDir = valueOf('--sessions')
  if (sessionsDir === undefined) {
    console.error('usage: node scripts/session-stats.mjs --sessions <dir> [--as-of <ISO>] [--out <path>] [--allow-empty]')
    process.exit(2)
  }
  let asOf
  if (has('--as-of')) {
    const raw = valueOf('--as-of')
    asOf = raw === undefined ? NaN : Date.parse(raw)
    if (!Number.isFinite(asOf)) {
      console.error('--as-of must be an ISO-8601 timestamp')
      process.exit(2)
    }
  }

  const paths = listSessionFiles(sessionsDir)
  if (paths.length === 0 && !has('--allow-empty')) {
    console.error(`refusing to write an empty snapshot: no ${SESSION_FILE} under ${sessionsDir} (pass --allow-empty to override)`)
    process.exit(1)
  }
  let prefixed =
    asOf === undefined
      ? paths.map((path) => ({ path, size: statSize(path) }))
      : paths.map((path) => ({ path, ...(prefixInfo(path, asOf) ?? { prefixBytes: 0 }) }))
  prefixed.sort((a, b) => {
    const size = (asOf === undefined ? a.size : a.prefixBytes) -
      (asOf === undefined ? b.size : b.prefixBytes)
    return size === 0 ? a.path.localeCompare(b.path) : -size
  })
  prefixed = prefixed.slice(0, TOP_SESSIONS)

  const sessions = []
  let skipped = 0
  for (const entry of prefixed) {
    const analysed = analyseSession(entry.path, asOf)
    if (analysed === undefined) skipped += 1
    else sessions.push(analysed)
  }
  if (skipped > 0) console.error(`warning: skipped ${skipped} unreadable session file(s)`)
  if (sessions.length === 0 && prefixed.length > 0 && !has('--allow-empty')) {
    console.error('refusing to write an empty snapshot: every selected session file failed to decompress (pass --allow-empty to override)')
    process.exit(1)
  }

  const snapshot = {
    version: 1,
    asOf: asOf === undefined ? null : new Date(asOf).toISOString(),
    generatedBy: 'scripts/session-stats.mjs',
    selection: {
      count: sessions.length,
      skipped,
      top: TOP_SESSIONS,
      rule:
        asOf === undefined
          ? 'largest session.v4.jsonl.zstd by compressed size'
          : 'largest prefix by raw bytes up to asOf (compressed-prefix sizes are not retained)',
    },
    sessions,
  }

  const out = valueOf('--out')
  const serialised = serialiseSnapshot(snapshot)
  if (out === undefined) {
    process.stdout.write(serialised)
  } else {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, serialised)
    const totals = statsFromSnapshot(snapshot)
    process.stdout.write(
      `${JSON.stringify({
        written: out,
        sessions: totals.sessionCount,
        skipped,
        steps: totals.steps,
        toolCalls: totals.toolCalls,
        asOf: snapshot.asOf,
      })}\n`,
    )
  }
} else {
  let snapshot
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  } catch (error) {
    console.error(`cannot read snapshot ${snapshotPath}: ${error.message}`)
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(statsFromSnapshot(snapshot), null, 2)}\n`)
}

/** `statSync().size` with a zero fallback, so one unreadable file cannot abort ranking. */
function statSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}