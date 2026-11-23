/**
 * Prefix stability: projection must be a pure function of its inputs.
 *
 * Prompt caching matches an exact prefix, so a projection that renders the same
 * receipt differently on a second run invalidates every byte that follows it.
 * These tests pin the two properties that keep that from happening silently:
 * the entry point is byte-identically repeatable for identical inputs, and the
 * projection path never reaches for a clock or a random source.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { projectApply } from '../src/projection/apply.ts'
import type { FormatFooter, ProjectApplyInput, SpillBackend } from '../src/projection/apply.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** A receipt comfortably above the `read` trigger (3000 code points). */
const RECEIPT = '0123456789\n'.repeat(600)

/** A deterministic footer: the locator it names is the only variable. */
const formatFooter: FormatFooter = (omitted, ref) =>
  `[projected: ${omitted.count} bytes omitted; full text at ${ref.locator}]`

/** A spill backend whose only answer is the locator the test handed it. */
function spillAt(locator: string): SpillBackend {
  return {
    async saveText() {
      return { locator, retrievalHint: `read ${locator}` }
    },
  }
}

/** One complete apply input; only the locator varies between calls. */
function inputFor(locator: string): ProjectApplyInput {
  return {
    text: RECEIPT,
    isError: false,
    family: 'read',
    cfg: DEFAULT_CONFIG,
    sessionId: 'session-a',
    toolName: 'read',
    callId: 'call-1',
    label: 'read',
    spill: spillAt(locator),
    formatFooter,
  }
}

test('projection is byte-identically repeatable for identical inputs', async () => {
  const locator = 'spill://session-a/read/call-1.txt'
  const first = await projectApply(inputFor(locator))
  const second = await projectApply(inputFor(locator))

  assert.equal(first.outcome.kind, 'applied')
  // The output is a string; `===` is the property the cache needs.
  assert.ok(first.content === second.content, 'same inputs must render the same bytes')
  assert.deepEqual(first.outcome, second.outcome)
  assert.ok(first.content.includes(locator), 'the footer must name the locator')

  // The locator is an input, so a different one must change the output. This
  // proves the repeatability above is not "the function ignores its input".
  const otherLocator = 'spill://session-a/read/call-2.txt'
  const other = await projectApply(inputFor(otherLocator))
  assert.equal(other.outcome.kind, 'applied')
  assert.ok(other.content !== first.content, 'a different locator must change the rendered bytes')
  assert.ok(other.content.includes(otherLocator))
  assert.ok(!other.content.includes(locator))
})

/**
 * Strip `//` and block comments while leaving string literals intact.
 *
 * A scan that did not strip comments would flag the very comment that documents
 * "do not use `Date.now` here"; a scanner that strips too much could hide a
 * real call inside a string. This is a small state machine, not a parser, which
 * is enough for the source shape this test scans.
 */
function stripComments(source: string): string {
  let out = ''
  let state: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' = 'code'
  let i = 0
  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line'
        i += 2
        continue
      }
      if (char === '/' && next === '*') {
        state = 'block'
        i += 2
        continue
      }
      if (char === "'") state = 'single'
      else if (char === '"') state = 'double'
      else if (char === '`') state = 'template'
      out += char
      i += 1
    } else if (state === 'line') {
      if (char === '\n') {
        state = 'code'
        out += char
      }
      i += 1
    } else if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code'
        i += 2
      } else {
        i += 1
      }
    } else {
      // String or template literal: copied verbatim so a token inside it is
      // still visible to the scan.
      out += char
      if (char === '\\') {
        out += source[i + 1] ?? ''
        i += 2
        continue
      }
      if (
        (state === 'single' && char === "'") ||
        (state === 'double' && char === '"') ||
        (state === 'template' && char === '`')
      ) {
        state = 'code'
      }
      i += 1
    }
  }
  return out
}

/** Tokens that make a render depend on something other than its inputs. */
const AMBIENT = ['Date.now', 'new Date', 'Math.random', 'randomUUID', 'randomBytes'] as const

/** Every ambient token in comment-stripped source, in a stable order. */
function ambientHits(source: string): string[] {
  const code = stripComments(source)
  return AMBIENT.filter(token => code.includes(token))
}

/** The source of one top-level function, found by brace matching. */
function functionSource(source: string, signature: string): string {
  const start = source.indexOf(signature)
  if (start < 0) throw new Error(`function not found: ${signature}`)
  let depth = 0
  let seenBrace = false
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1
      seenBrace = true
    } else if (source[i] === '}') {
      depth -= 1
      if (seenBrace && depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unterminated function: ${signature}`)
}

test('comment stripper ignores commented-out ambient calls but keeps live ones', () => {
  const fake = [
    'const a = 1',
    '// Math.random() in a comment must not trip the scan',
    '/* Date.now() in a block comment likewise */',
    'const b = Math.random()',
  ].join('\n')
  assert.deepEqual(ambientHits(fake), ['Math.random'])

  // The scan itself must not be inert: live clock use is reported.
  assert.deepEqual(ambientHits('const now = Date.now()\nconst d = new Date()'), [
    'Date.now',
    'new Date',
  ])
  assert.deepEqual(ambientHits('const id = randomUUID()\nconst bytes = randomBytes(8)'), [
    'randomUUID',
    'randomBytes',
  ])
})

test('projection path must not read clocks or randomness (prefix stability)', async () => {
  const projectionDir = join(ROOT, 'src/projection')
  const files = (await readdir(projectionDir))
    .filter(name => name.endsWith('.ts'))
    .sort()
  assert.deepEqual(files, ['apply.ts', 'canonicalise.ts', 'counters.ts', 'truncate.ts'])

  const sources: Array<{ label: string; source: string }> = []
  for (const file of files) {
    sources.push({ label: `src/projection/${file}`, source: await readFile(join(projectionDir, file), 'utf8') })
  }

  // The projection call site, not the whole hook: `post-execute` legitimately
  // stamps receipt timestamps with the wall clock elsewhere.
  const postExecute = await readFile(join(ROOT, 'src/hooks/post-execute.ts'), 'utf8')
  const callSite = functionSource(stripComments(postExecute), 'async function projectDecision(')
  sources.push({ label: 'src/hooks/post-execute.ts#projectDecision', source: callSite })

  const hits = sources.flatMap(({ label, source }) =>
    ambientHits(source).map(token => `${label}: ${token}`),
  )
  assert.deepEqual(
    hits,
    [],
    `the projection path must be reproducible from its inputs alone; found: ${hits.join(', ')}`,
  )
})