#!/usr/bin/env node
/**
 * Extract candidate verification steps from session logs.
 *
 * The quality question this feeds is not "did the command succeed" — the
 * projection never touches what `bash` prints. It is "did the agent reach the
 * same *answer* with the intervention on". Answering that needs an agent run,
 * which this repository cannot drive; what it can do is hand the operator the
 * half of the experiment that is mechanical: a list of sessions that ended on
 * a **machine-checkable** command, so a re-run has something to compare.
 *
 * A candidate is a session whose tool calls include a verification command —
 * `npm test`, `npm run ci`, `npx tsc`, `pytest`, `cargo test`, `go test`,
 * `make test` — recorded with the step it ran in and whether it was the last
 * call of the session.
 *
 * Usage:
 *   node scripts/quality-tasks.mjs --sessions <dir> [--out <path>]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** How much of the opening user message to keep as the task statement. */
const TASK_CHARS = 400

/** Commands whose success or failure a re-run can compare without a model. */
const VERIFICATION = /^(?:npm\s+(?:test|run\s+(?:ci|verify:package|test:regression|typecheck))|npx\s+tsc|pytest|cargo\s+test|go\s+test|make\s+test)\b/

function usage() {
  process.stderr.write(
    'usage: node scripts/quality-tasks.mjs --sessions <dir> [--out <path>]\n' +
      '  --sessions <dir>  directory of <workspace>/<session>/session.v4.jsonl.zstd\n' +
      '  --out <path>      write the JSON there instead of stdout\n' +
      '  --help, -h        show this message and exit 0\n',
  )
}

function parseArgs(raw) {
  const args = { sessions: undefined, out: undefined }
  for (let index = 0; index < raw.length; index += 1) {
    const flag = raw[index]
    if (flag === '--help' || flag === '-h') return { help: true }
    const value = raw[index + 1]
    if (flag === '--sessions' && value !== undefined) {
      args.sessions = value
      index += 1
    } else if (flag === '--out' && value !== undefined) {
      args.out = value
      index += 1
    } else {
      throw new Error(`unknown argument: ${flag}`)
    }
  }
  return args
}

function sessionFiles(root) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      const stats = statSync(path)
      if (stats.isDirectory()) walk(path)
      else if (entry === 'session.v4.jsonl.zstd') files.push(path)
    }
  }
  walk(root)
  return files.sort()
}

/** One candidate per session: its last verification call. */
function candidatesOf(path) {
  let text
  try {
    text = zstdDecompressSync(readFileSync(path)).toString('utf8')
  } catch {
    return undefined
  }
  let sessionId = dirname(path).split(/[\\/]/).pop() ?? path
  let firstUserText
  const calls = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.type === 'session' && typeof record.id === 'string') {
      sessionId = record.id
      continue
    }
    if (record.type === 'user/message') {
      // The operator's own opening instruction is the closest thing the log has
      // to a task statement; without it a candidate is just a command.
      if (firstUserText === undefined) {
        const content = record.data?.content
        const text = Array.isArray(content)
          ? content
              .filter((part) => part?.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text)
              .join('\n')
          : typeof record.data?.text === 'string'
            ? record.data.text
            : ''
        if (text.trim() !== '') firstUserText = text.trim()
      }
      continue
    }
    if (record.type !== 'tool/call') continue
    const data = record.data ?? {}
    let parsed
    try {
      parsed = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}')
    } catch {
      parsed = {}
    }
    const command = typeof parsed?.command === 'string' ? parsed.command.trim() : ''
    if (command === '') continue
    calls.push({ step: data.step, turn: data.turn, name: data.name, command, index: calls.length })
  }
  const verdicts = calls.filter((call) => VERIFICATION.test(call.command))
  if (verdicts.length === 0) return undefined
  const last = verdicts[verdicts.length - 1]
  return {
    sessionId,
    // Truncated: the runbook pastes this as the task prompt, and a 40k-character
    // session opener would not survive that hand-off.
    task: firstUserText === undefined ? undefined : firstUserText.slice(0, TASK_CHARS),
    turn: last.turn,
    step: last.step,
    tool: last.name,
    command: last.command,
    // "Final" means no tool call happened after it: the session stopped on
    // this verdict, which is what makes it replayable as a whole task.
    isFinal: last.index === calls.length - 1,
    totalCalls: calls.length,
  }
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
  if (args.sessions === undefined) {
    usage()
    process.exit(2)
  }
  let files
  try {
    files = sessionFiles(args.sessions)
  } catch {
    process.stderr.write(`cannot read --sessions ${args.sessions}\n`)
    process.exit(2)
  }
  const tasks = []
  for (const path of files) {
    const candidate = candidatesOf(path)
    if (candidate !== undefined) tasks.push(candidate)
  }
  if (tasks.length === 0) {
    process.stderr.write('no session ended on a verification command; nothing to replay\n')
  }
  const document = {
    version: 1,
    generatedBy: 'scripts/quality-tasks.mjs',
    sessions: files.length,
    tasks,
  }
  const json = `${JSON.stringify(document, null, 2)}\n`
  if (args.out === undefined) process.stdout.write(json)
  else writeFileSync(args.out, json)
}

main()
