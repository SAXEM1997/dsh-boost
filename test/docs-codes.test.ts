import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every receipt code the plugin can write must appear in the authoritative
 * table in `docs/RELEASE.md`.
 *
 * `AGENTS.md` makes the code tables a contract: an operator reading a receipt
 * looks the code up there. The two tables drifted twice in this repo's history
 * (`substituted` and `substitute-settled` were produced but never listed), so
 * the convention is checked instead of remembered.
 *
 * The scan is deliberately literal: it reads `code: '…'` in `src/`, which is a
 * floor on coverage, not a proof. Codes assembled at runtime are out of reach —
 * that is why the check is a floor and says so.
 */
const SRC = new URL('../src/', import.meta.url).pathname
const RELEASE = new URL('../docs/RELEASE.md', import.meta.url).pathname

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

function producedCodes(): string[] {
  const codes = new Set<string>()
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8')
    // `code: '…'` — object-literal receipt fields.
    for (const match of text.matchAll(/\bcode:\s*'([A-Za-z_][A-Za-z0-9:._-]*)'/g)) {
      const code = match[1]
      if (code !== undefined) codes.add(code)
    }
    // `export const ERR_HTTP_UNAUTHORIZED = 'ERR_HTTP_UNAUTHORIZED'` — the HTTP
    // surface's codes are exported constants, not `code:` literals, so a code
    // added only there used to escape this scan entirely (review P3-5).
    for (const match of text.matchAll(/export const (ERR_HTTP_[A-Z_]+) = '[A-Z_]+'/g)) {
      const code = match[1]
      if (code !== undefined) codes.add(code)
    }
    // `ledgerEntry(ctx, 'skip', '…')` — the helper's third positional argument.
    // Over half the skip codes are written this way, so scanning only the
    // literal form left `not-admitted`, `steps-exhausted` and `no-candidate`
    // outside the check (review P3-21).
    for (const match of text.matchAll(/\bledgerEntry\(\s*[^,]+,\s*'[a-z]+'\s*,\s*'([A-Za-z_][A-Za-z0-9:._-]*)'/g)) {
      const code = match[1]
      if (code !== undefined) codes.add(code)
    }
  }
  return [...codes].sort()
}

test('每个会写出的收据码都在 docs/RELEASE.md 的码表里', () => {
  const release = readFileSync(RELEASE, 'utf8')
  const codes = producedCodes()
  assert.ok(codes.length >= 10, `expected the scan to find codes, found ${codes.length}`)
  const missing = codes.filter((code) => !release.includes(code))
  assert.deepEqual(missing, [], `these codes are produced but undocumented: ${missing.join(', ')}`)
})
