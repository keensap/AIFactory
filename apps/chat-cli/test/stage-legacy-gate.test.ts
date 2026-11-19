import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { PostgresProjectStore } from '../src/projects.ts'
import { PostgresProjectWorkspace } from '../src/workspace.ts'

const url = process.env.AIFACTORY_TEST_DATABASE_URL
const skip = url === undefined || url === '' ? 'AIFACTORY_TEST_DATABASE_URL is not set' : false

test('a persisted legacy review gate is exposed for explicit final human decision', { skip }, async () => {
  const store = new PostgresProjectStore(url!)
  const workspace = new PostgresProjectWorkspace(url!)
  const pool = new Pool({ connectionString: url!, max: 1 })
  const root = mkdtempSync(join(tmpdir(), 'aifactory-legacy-gate-'))
  try {
    await store.migrate()
    await workspace.migrate()
    const project = await store.create({ name: 'Legacy gate', rootPath: root, organization: null, ownerEmail: null, status: 'inactive' })
    const run = await workspace.createStageRun({ projectId: project.id, stage: 'planning', inputText: 'brief', context: {}, contextHash: 'hash' })
    const gate = { kind: 'review_changes', question: 'Apply changes?', cycle: 0, maxReviewCycles: 3, reviewDecision: 'needs_revision', findings: [{ id: 'F-1' }], waitingSince: '2026-01-01T00:00:00.000Z' }
    await pool.query("UPDATE project_stage_runs SET status = 'awaiting_human', pending_gate = $2::jsonb WHERE id = $1", [run.id, JSON.stringify(gate)])
    const restored = await workspace.getStageRunDetail(run.id)
    assert.equal(restored?.pendingGate?.kind, 'final')
    assert.match(restored!.pendingGate!.question, /legacy review gate/)
    assert.deepEqual(restored!.pendingGate!.findings, gate.findings)
    assert.equal(restored!.pendingGate!.waitingSince, gate.waitingSince)
    assert.equal((restored!.pendingGate as unknown as { legacyQuestion: string }).legacyQuestion, gate.question)
    assert.equal(restored!.status, 'awaiting_human')
  } finally {
    await pool.end()
    await workspace.close()
    await store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
