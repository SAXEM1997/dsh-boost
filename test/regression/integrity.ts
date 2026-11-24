/**
 * The retrieval-integrity check the release notes have been calling "owed".
 *
 * What this can and cannot see: `SpillBackend` is write-only, so the plugin
 * cannot prove the *host* returns the bytes it stored. What it can prove — and
 * what a regression here would actually break — is that it hands the backend the
 * complete original, that the footer names the locator the backend returned, and
 * that the byte arithmetic in that footer closes against the windows the model
 * is left with. A future edit that spilled `truncation.head` instead of `text`
 * would fail every assertion below.
 */
import assert from 'node:assert/strict'
import { projectApply } from '../../src/projection/apply.ts'
import type { FormatFooter, SpillBackend, SpillHandle } from '../../src/projection/apply.ts'
import { DEFAULT_CONFIG } from '../../src/config.ts'
import { truncate } from '../../src/projection/truncate.ts'
import type { BoostConfig, ToolFamily } from '../../src/types.ts'

/** A backend that records what it was asked to store. */
export function recordingSpill(handle: SpillHandle = { locator: '/spill/kept.txt', retrievalHint: 'read it' }) {
  const saved: { content: string; suggestedName: string }[] = []
  const backend: SpillBackend = {
    async saveText(input) {
      saved.push({ content: input.content, suggestedName: input.suggestedName })
      return handle
    },
  }
  return { backend, saved, handle }
}

export const footer: FormatFooter = (omitted, ref) =>
  `(Omitted ${omitted.count} bytes. Full result stored at: ${ref.locator}. ${ref.retrievalHint}.)`

/** Config with one family forced to project, everything else at its default. */
export function projectingConfig(family: ToolFamily, over: Partial<BoostConfig['projection'][ToolFamily]> = {}): BoostConfig {
  return {
    ...DEFAULT_CONFIG,
    projection: { ...DEFAULT_CONFIG.projection, [family]: { ...DEFAULT_CONFIG.projection[family], ...over } },
  }
}

/** A receipt comfortably over every family's trigger, with a line the windows cut. */
export function receipt(lines = 60): string {
  const row = (index: number) => `./step-${index}.sh: running checks (${'ok '.repeat(30)})\n`
  return Array.from({ length: lines }, (_, index) => row(index)).join('') + 'ERROR: build failed at src/x.ts:12\nexit code 1\n'
}

export interface IntegrityReport {
  family: ToolFamily
  originalBytes: number
  /** Bytes the model is left with, after the replacement. */
  viewBytes: number
  storedBytes: number
  omittedBytes: number
  locator: string
  applied: boolean
}

/**
 * Project one receipt and assert the three integrity properties.
 *
 * Returns the numbers so a caller (the smoke runner) can print them; throws on
 * the first violation.
 */
export async function checkIntegrity(family: ToolFamily, text = receipt()): Promise<IntegrityReport> {
  const { backend, saved, handle } = recordingSpill()
  const { content, outcome } = await projectApply({
    text,
    isError: false,
    family,
    cfg: projectingConfig(family),
    sessionId: 'regression',
    toolName: family,
    spill: backend,
    formatFooter: footer,
  })

  if (outcome.kind === 'skipped') {
    // A skip is legitimate (below the trigger, unconfigured family); it stores
    // nothing, so there is nothing to check beyond "it did not claim to store".
    assert.equal(saved.length, 0, 'a skipped projection must not spill anything')
    return {
      family,
      originalBytes: Buffer.byteLength(text, 'utf8'),
      viewBytes: Buffer.byteLength(text, 'utf8'),
      storedBytes: 0,
      omittedBytes: 0,
      locator: '',
      applied: false,
    }
  }

  assert.equal(outcome.kind, 'applied', `${family}: expected an applied projection`)
  assert.equal(saved.length, 1, `${family}: exactly one artifact per projection`)

  // 1. The backend was handed the complete original, byte for byte.
  assert.equal(saved[0]?.content, text, `${family}: the spilled artifact must be the whole original`)

  // 2. The footer names the locator the backend returned, so a model that reads
  //    it reaches the same artifact.
  assert.ok(content.includes(handle.locator), `${family}: the visible text must name the returned locator`)

  // 3. The footer's byte count closes against the windows the model still has.
  //    Recomputed from `truncate` rather than read back from the outcome, so
  //    the check and the code do not agree by construction.
  const originalBytes = Buffer.byteLength(text, 'utf8')
  const windows = truncate(text, projectingConfig(family).projection[family])
  assert.ok(windows !== null, `${family}: the fixture must be truncatable`)
  const visibleBytes = Buffer.byteLength(windows.head + windows.tail, 'utf8')
  assert.equal(
    outcome.omittedBytes,
    originalBytes - visibleBytes,
    `${family}: omitted bytes must be the part neither window shows`,
  )
  assert.ok(content.includes(`Omitted ${outcome.omittedBytes} bytes`), `${family}: the footer count must match`)

  // 4. The replacement is strictly shorter, or the projection would be a loss.
  assert.ok(Buffer.byteLength(content, 'utf8') < originalBytes, `${family}: a projection must shrink the receipt`)

  return {
    family,
    originalBytes,
    viewBytes: Buffer.byteLength(content, 'utf8'),
    storedBytes: Buffer.byteLength(saved[0]?.content ?? '', 'utf8'),
    omittedBytes: outcome.omittedBytes,
    locator: handle.locator,
    applied: true,
  }
}
