import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PostgresProjectStore } from '../src/projects.ts'
import { PostgresProjectWorkspace } from '../src/workspace.ts'

const url = process.env.AIFACTORY_TEST_DATABASE_URL
const skip = url === undefined || url === '' ? 'AIFACTORY_TEST_DATABASE_URL is not set' : false

test('projectStats reads token usage and durations from the event log', { skip }, async () => {
  const store = new PostgresProjectStore(url!)
  const workspace = new PostgresProjectWorkspace(url!)
  const root = mkdtempSync(join(tmpdir(), 'aifactory-stats-db-'))
  try {
    await store.migrate()
    await workspace.migrate()
    const project = await store.create({ name: 'Stats DB', rootPath: root, organization: null, ownerEmail: null, status: 'inactive' })
    const run = await workspace.createStageRun({
      projectId: project.id,
      stage: 'planning',
      inputText: 'stats',
      context: {},
      contextHash: 'hash',
    })
    await workspace.updateStageRun(run.id, { status: 'analyzing' })
    await workspace.appendStageRunEvent({
      projectId: project.id, stageRunId: run.id, role: 'analyzer', type: 'role_start', level: 'info', payload: { role: 'analyzer' },
    })
    await workspace.appendStageRunEvent({
      projectId: project.id, stageRunId: run.id, role: 'analyzer', type: 'status', level: 'debug',
      payload: { phase: 'step_end', usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140, cacheReadTokens: 10, cacheWriteTokens: 2 } },
    })
    await workspace.appendStageRunEvent({
      projectId: project.id, stageRunId: run.id, role: 'analyzer', type: 'role_end', level: 'info', payload: { role: 'analyzer', durationMs: 1234 },
    })
    await workspace.appendStageRunEvent({
      projectId: project.id, stageRunId: run.id, role: 'reviewer', type: 'status', level: 'debug',
      payload: { phase: 'step_end', usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
    })
    await workspace.appendStageRunEvent({
      projectId: project.id, stageRunId: run.id, role: 'reviewer', type: 'role_end', level: 'info', payload: { role: 'reviewer', durationMs: 2000 },
    })
    await workspace.updateStageRun(run.id, { status: 'completed' })

    const stats = await workspace.projectStats({ projectId: project.id, days: 1 })
    assert.equal(stats.runs.total, 1)
    assert.deepEqual(stats.tokens, { input: 120, output: 45, total: 165, cacheRead: 10, cacheWrite: 2 })
    assert.equal(stats.activeDurationMs.totalMs, 3234)
    assert.equal(stats.byRole.find((entry) => entry.role === 'analyzer')?.tokens.total, 140)
    assert.equal(stats.byRole.find((entry) => entry.role === 'reviewer')?.durationMs.totalMs, 2000)
    assert.equal(stats.byStage[0]?.stage, 'planning')
    assert.equal(stats.byStage[0]?.activeDurationMs.totalMs, 3234)
    assert.equal(stats.recentRuns[0]?.status, 'completed')

    // Filters narrow tokens and roles without hiding the run count.
    const reviewer = await workspace.projectStats({ projectId: project.id, role: 'reviewer', days: 1 })
    assert.equal(reviewer.tokens.total, 25)
    assert.deepEqual(reviewer.byRole.map((entry) => entry.role), ['reviewer'])
    await assert.rejects(
      () => workspace.projectStats({ projectId: project.id, stage: 'bogus' } as never),
      /unknown stage/,
    )
  } finally {
    await store.close()
    await workspace.close()
    rmSync(root, { recursive: true, force: true })
  }
})
