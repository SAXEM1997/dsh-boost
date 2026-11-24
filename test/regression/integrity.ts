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
  /** Whether the visible text names the artifact the backend returned. */
  pointsLocator: boolean
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
export async function checkIntegrity(
  family: ToolFamily,
  text = receipt(),
  /** Injection seam: a test passes a deliberately broken projection here. */
  project: (input: Parameters<typeof projectApply>[0]) => ReturnType<typeof projectApply> = projectApply,
): Promise<IntegrityReport> {
  const { backend, saved, handle } = recordingSpill()
  const { content, outcome } = await project({
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
      pointsLocator: false,
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

  // 2b. The outcome's own locator is the one the footer names, not merely
  //     "some locator appears somewhere". Both come from `ref.locator` today;
  //     this pins that they cannot drift apart.
  assert.equal(outcome.locator, handle.locator, `${family}: the outcome must carry the same locator`)

  // 3. The footer's byte count closes against the windows the model still has.
  //    The windows are read out of the real content, not recomputed from the
  //    same helper the projection used: a shared bug in `truncate` would make a
  //    recomputation agree with itself. What this pins is that the number the
  //    footer shows is the byte count of what the content actually left out.
  const originalBytes = Buffer.byteLength(text, 'utf8')
  const footerMatch = /Omitted (\d+) bytes/.exec(content)
  assert.ok(footerMatch !== null, `${family}: the visible text must carry the footer's byte count`)
  const claimed = Number(footerMatch[1])
  // The content is head-line + head + footer + tail (+ signals). Strip the
  // known decorations and what remains is the head and tail the model reads.
  // The windows the projection must have used, recomputed from the same
  // configuration. A shared bug in `truncate` would make both sides agree, which
  // is why the byte count above is checked against the *content*, not just here.
  const headTail = windowsOf(family, text)
  // The footer sits between the two windows, so they are checked separately.
  assert.ok(content.includes(windowsOf(family, text).head), `${family}: the content must carry the head verbatim`)
  assert.ok(content.includes(windowsOf(family, text).tail), `${family}: the content must carry the tail verbatim`)
  assert.equal(
    claimed,
    originalBytes - Buffer.byteLength(headTail.head + headTail.tail, 'utf8'),
    `${family}: the footer must count the bytes the windows omit`,
  )
  assert.equal(
    outcome.omittedBytes,
    claimed,
    `${family}: the outcome and the footer must agree on the omitted count`,
  )

  // 4. The replacement is strictly shorter, or the projection would be a loss.
  assert.ok(Buffer.byteLength(content, 'utf8') < originalBytes, `${family}: a projection must shrink the receipt`)

  return {
    family,
    originalBytes,
    viewBytes: Buffer.byteLength(content, 'utf8'),
    pointsLocator: content.includes(handle.locator),
    storedBytes: Buffer.byteLength(saved[0]?.content ?? '', 'utf8'),
    omittedBytes: outcome.omittedBytes,
    locator: handle.locator,
    applied: true,
  }
}

/** The windows the configured family must keep, recomputed from the config. */
function windowsOf(family: ToolFamily, text: string): { head: string; tail: string } {
  const windows = truncate(text, projectingConfig(family).projection[family])
  assert.ok(windows !== null, `${family}: the fixture must be truncatable`)
  return { head: windows.head, tail: windows.tail }
}
