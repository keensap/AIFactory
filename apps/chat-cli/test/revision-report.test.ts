import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectRevision } from '../src/processes/revision.ts'

test('revision dispositions are stripped from the artifact and omissions stay visible', () => {
  const document = '# Revised specification'
  const raw = `<revision-plan>[{"id":"R-1","status":"unaddressed","note":"Missing evidence"}]</revision-plan>\n${document}`
  const result = inspectRevision(raw, '# Draft', [{}, {}])
  assert.equal(result.document, document)
  assert.equal(result.report.planValid, false)
  assert.deepEqual(result.report.missing, ['R-2'])
  assert.equal(result.report.dispositions[0]?.status, 'unaddressed')
  assert.equal(result.report.grewOverBudget, true)
  assert.equal(inspectRevision(raw, '# Draft', [{}]).report.planValid, true)
})

test('legacy Markdown output remains usable but does not count as a valid plan', () => {
  const document = '# Revised specification'
  const result = inspectRevision(document, '# Draft', [{}])
  assert.equal(result.document, document)
  assert.equal(result.report.planValid, false)
  assert.deepEqual(result.report.missing, ['R-1'])
})
