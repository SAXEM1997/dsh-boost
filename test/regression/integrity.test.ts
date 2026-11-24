import test from 'node:test'
import assert from 'node:assert/strict'
import { checkIntegrity, projectingConfig, receipt, recordingSpill, footer } from './integrity.ts'
import { projectApply } from '../../src/projection/apply.ts'

test('每个配置了投影的族：落库的是完整原文、页脚点名返回的 locator、字节账闭合', async () => {
  for (const family of ['read', 'grep', 'glob', 'bash', 'ssh'] as const) {
    const report = await checkIntegrity(family)
    assert.equal(report.applied, true, `${family}: expected a projection`)
    assert.equal(report.storedBytes, report.originalBytes, `${family}: stored bytes equal the original`)
  }
})

test('投影一定变短，且被省掉的字节等于两个窗口之外的部分', async () => {
  const report = await checkIntegrity('bash')
  assert.ok(report.omittedBytes > 0)
  assert.ok(report.omittedBytes < report.originalBytes)
})

test('这条检查真的能失败：把投影换成「只落头段」的实现，checkIntegrity 立刻拒绝', async () => {
  // Drive the real check against a broken projection through its seam. The
  // earlier version of this test hand-truncated the saved string and asserted
  // that `assert.equal` throws — which proves the assertion works, not that the
  // check catches a regression.
  await assert.rejects(
    checkIntegrity('bash', receipt(), async (input) => {
      // One artifact, but the wrong bytes: wrap the backend so the recorded
      // save carries a window instead of the receipt.
      const spill = input.spill
      return projectApply({
        ...input,
        spill: {
          saveText: async (ask) => {
            assert.ok(spill !== undefined, 'the fixture always provides a backend')
            return spill.saveText({ ...ask, content: ask.content.slice(0, 100) })
          },
        },
      })
    }),
    /the spilled artifact must be the whole original/,
  )
})

test('低于触发阈值时不落库，也不假装落过', async () => {
  const small = 'tiny output\n'
  const report = await checkIntegrity('bash', small)
  assert.equal(report.applied, false)
  assert.equal(report.storedBytes, 0)
})

test('错误回执不投影：不落库、不改写', async () => {
  const { backend, saved } = recordingSpill()
  const text = receipt()
  const { content, outcome } = await projectApply({
    text,
    isError: true,
    family: 'bash',
    cfg: projectingConfig('bash'),
    sessionId: 'regression',
    toolName: 'bash',
    spill: backend,
    formatFooter: footer,
  })
  assert.equal(outcome.kind, 'skipped')
  assert.equal(outcome.reason, 'error-receipt')
  assert.equal(content, text)
  assert.equal(saved.length, 0)
})
