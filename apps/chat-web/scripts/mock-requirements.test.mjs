// Exercise the mock route handlers without DSH or a listening server.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'vitest'

process.env.MOCK_STAGE_STEP_MS = '1'
const { handleStageRoutes } = await import('./mock-stages.mjs')

function mockProject() {
  const id = randomUUID()
  const project = { id, name: 'Test project', rootPath: '/mock/project', status: 'active', createdAt: new Date().toISOString() }
  const projects = new Map([[id, project]])
  const path = `/api/projects/${id}`
  const request = async (method, path, body, expected = 200) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: {} })
    let result
    let status
    const res = { writeHead: (code) => { status = code }, end: (data) => { result = data } }
    const handled = await handleStageRoutes(req, res, new URL(path, 'http://mock.invalid'), projects, {
      sendJson: (_res, code, data) => { status = code; result = data },
      sendError: (_res, code, message, errorCode) => { status = code; result = { error: { message, code: errorCode } } },
    })
    assert.ok(handled, `${method} ${path} was not handled`)
    assert.equal(status, expected, `${method} ${path}: ${JSON.stringify(result?.error)}`)
    return result
  }
  const start = async (stage, brief) => {
    const { run } = await request('POST', `${path}/stages/${stage}/runs`, { brief }, 201)
    assert.equal(run.status, 'pending')
    const runPath = `/api/stage-runs/${run.id}`
    const execute = await request('POST', `${runPath}/execute`, undefined, 202)
    assert.equal(execute.run.status, 'analyzing')
    for (let i = 0; i < 250; i++) {
      const { run } = await request('GET', runPath)
      if (run.status === 'awaiting_human') return { run, runPath }
      assert.notEqual(run.status, 'failed', run.summaryMarkdown)
      await sleep(10)
    }
    assert.fail('The mock run did not reach its gate')
  }
  return { path, request, start }
}

test('Planning → Requirements: reject, refine, approve and advance', async () => {
  const { path, request, start } = mockProject()
  const { stages } = await request('GET', '/api/sdlc/stages')
  assert.deepEqual(stages.filter(({ executable }) => executable).map(({ key }) => key), ['planning', 'requirements'])
  assert.ok(stages.every(({ executable }) => typeof executable === 'boolean'))
  await request('GET', `${path}/stages/design/runs`, undefined, 501)
  const missing = await request('POST', `${path}/stages/requirements/runs`, {}, 409)
  assert.equal(missing.error.code, 'STAGE_PREREQUISITES_MISSING')

  const planning = await start('planning', 'Record requests.')
  assert.equal(planning.run.pendingGate.coverage, undefined)
  const planned = await request('POST', `${planning.runPath}/decision`, { decision: 'go' })
  assert.equal(planned.run.documents[0].kind, 'telos_report')
  await request('PATCH', `${path}/stage`, { stage: 'requirements' })

  const { run, runPath } = await start('requirements', 'COVERAGE Record requests.')
  assert.equal(run.context.constraints.documentKind, 'requirements_spec')
  assert.equal(run.context.readiness.prerequisites[0].evidence.documentId, planned.run.documents[0].id)
  assert.equal(run.pendingGate.coverage.findings[0].severity, 'blocking')
  assert.equal(run.pendingGate.accepted, false)
  assert.equal((await request('POST', `${runPath}/decision`, {}, 400)).error.code, 'INVALID_HUMAN_DECISION')
  assert.equal((await request('POST', `${runPath}/decision`, { decision: 'approved' }, 409)).error.code, 'REQUIREMENTS_COVERAGE_BLOCKED')
  const rejected = await request('POST', `${runPath}/decision`, { decision: 'rejected', note: 'Add an acceptance criterion.' })
  assert.equal(rejected.run.status, 'awaiting_human')
  assert.deepEqual(rejected.run.documents, [])
  assert.match(rejected.run.summaryMarkdown, /Add an acceptance criterion\./)
  const before = await request('GET', path)
  assert.ok(before.sdlc.checklist.filter(({ stage }) => stage === 'requirements').every(({ status }) => status === 'open'))

  const refined = await request('POST', `${runPath}/decision`, { refine: true })
  assert.equal(refined.run.pendingGate.cycle, run.pendingGate.cycle + 1)
  assert.equal(refined.run.pendingGate.coverage.counts.withAcceptanceCriteria, 2)
  assert.deepEqual(refined.run.pendingGate.coverage.findings, [])
  assert.notEqual(refined.run.draftMarkdown, run.draftMarkdown)
  const approved = await request('POST', `${runPath}/decision`, { decision: 'approved' })
  assert.equal(approved.run.status, 'completed')
  assert.equal(approved.run.pendingGate, null)
  assert.equal(approved.run.documents.length, 1)
  const [document] = approved.run.documents
  assert.equal(document.kind, 'requirements_spec')
  assert.equal(document.stage, 'requirements')
  assert.match(document.exportPath, /^documents\/requirements\/Requirements specification/)
  assert.equal(await request('GET', `${path}/documents/${document.id}/content`), refined.run.draftMarkdown)
  assert.ok((await request('GET', `${path}/documents/${document.id}/export`)).subarray(0, 5).equals(Buffer.from('%PDF-')))
  const advanced = await request('PATCH', `${path}/stage`, { stage: 'design' })
  assert.equal(advanced.sdlc.currentStage, 'design')
  assert.ok(advanced.sdlc.checklist.filter(({ stage }) => stage === 'requirements').every(({ status, evidenceDocumentId }) => status === 'done' && evidenceDocumentId === document.id))
})

test('Requirements can start with direct input and explicitly waive persistent blockers', async () => {
  const { request, start } = mockProject()
  const { run, runPath } = await start('requirements', 'COVERAGE_STICKY Record requests.')
  assert.equal(run.context.readiness.prerequisites[0].satisfied, true)
  const refined = await request('POST', `${runPath}/decision`, { refine: true })
  assert.equal(refined.run.pendingGate.coverage.findings[0].severity, 'blocking')
  assert.equal((await request('POST', `${runPath}/decision`, { decision: 'approved', coverageWaiverReason: '   ' }, 400)).error.code, 'INVALID_COVERAGE_WAIVER')
  const waived = await request('POST', `${runPath}/decision`, { decision: 'approved', coverageWaiverReason: '  Deferred to beta.  ' })
  assert.equal(waived.run.status, 'completed')
  assert.match(waived.run.summaryMarkdown, /Coverage waiver: Deferred to beta\./)
  const { events } = await request('GET', `${runPath}/events`)
  assert.equal(events.find(({ type }) => type === 'human_decision').payload.coverageWaiver.reason, 'Deferred to beta.')
})
