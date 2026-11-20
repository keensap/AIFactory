/**
 * Replaceability proof.
 *
 * Runs the *real* stage runtime and workspace against the in-memory provider,
 * selected only through configuration. If this passes, swapping Phoenix for
 * another monitor requires no core changes.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshHarness } from '../src/harness.ts'
import { noopLogger } from '../src/logging/index.ts'
import { createObservabilityProvider } from '../src/observability/index.ts'
import { PostgresProjectStore, ProjectService } from '../src/projects.ts'
import { PlanningStageRuntime } from '../src/stage-runtime.ts'
import { PostgresProjectWorkspace } from '../src/workspace.ts'

const url = process.env.AIFACTORY_TEST_DATABASE_URL
const skip = url === undefined || url === '' ? 'AIFACTORY_TEST_DATABASE_URL is not set' : false

const ANALYZER = '# Planning analysis\n\n- Business idea: portal\n- TELOS evidence available\n'
const TELOS = '# TELOS Feasibility Report\n\n## 10. Recommendation\n\nDecision: **Go**\n'
const REVIEW = JSON.stringify({ decision: 'approved', rating: 100, findings: [] })

test('the real stage runtime records through whatever provider configuration selects', { skip }, async () => {
  const store = new PostgresProjectStore(url!)
  const workspace = new PostgresProjectWorkspace(url!)
  const root = mkdtempSync(join(tmpdir(), 'aifactory-swap-'))
  const provider = createObservabilityProvider({ AIFACTORY_OBSERVABILITY_PROVIDER: 'memory' })
  assert.equal(provider.name, 'memory', 'provider comes from configuration alone')

  try {
    await store.migrate()
    await workspace.migrate()
    // PostgresProjectStore.create bypasses the active-project limit for the test.
    const project = await store.create({
      name: 'Swap Proof', rootPath: root, organization: null, ownerEmail: null, status: 'inactive',
    })
    const settings = { get: async () => ({ maxActiveProjects: 3, updatedAt: new Date().toISOString() }) }
    const projects = new ProjectService(store, settings)
    const runtime = new PlanningStageRuntime({
      projects,
      workspace,
      harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
      runPrompt: async (role) => (role === 'analyzer' ? ANALYZER : role === 'author' ? TELOS : REVIEW),
      traces: provider.recorder,
      logger: noopLogger,
    })

    const started = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'swap' })
    const executed = await runtime.execute(started.id)
    assert.equal(executed.status, 'awaiting_human')

    const summary = await provider.reader.summary(project.id, 24)
    assert.equal(summary.available, true)
    assert.equal(summary.traces, 1, 'one run trace')
    assert.ok(summary.spans >= 4, `expected run + 3 role spans, got ${summary.spans}`)
    const roles = summary.roles.map((entry) => entry.role).sort()
    assert.deepEqual(roles, ['analyzer', 'author', 'reviewer'])
    assert.ok(summary.spans > 0)

    const health = provider.reader.health()
    assert.equal(health.provider, 'memory')
    assert.ok(health.projects >= 1)

    // Deleting the project through the recorder drops its spans.
    await provider.recorder.forgetProject(project.id)
    const afterDelete = await provider.reader.summary(project.id, 24)
    assert.equal(afterDelete.available, true)
    assert.equal(afterDelete.spans, 0)
  } finally {
    await provider.shutdown()
    await store.close()
    await workspace.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the same runtime works with the noop provider (observability disabled)', { skip }, async () => {
  const store = new PostgresProjectStore(url!)
  const workspace = new PostgresProjectWorkspace(url!)
  const root = mkdtempSync(join(tmpdir(), 'aifactory-noop-'))
  const provider = createObservabilityProvider({ AIFACTORY_OBSERVABILITY_PROVIDER: 'noop' })
  assert.equal(provider.name, 'noop')

  try {
    await store.migrate()
    await workspace.migrate()
    const project = await store.create({
      name: 'Noop Proof', rootPath: root, organization: null, ownerEmail: null, status: 'inactive',
    })
    const settings = { get: async () => ({ maxActiveProjects: 3, updatedAt: new Date().toISOString() }) }
    const runtime = new PlanningStageRuntime({
      projects: new ProjectService(store, settings),
      workspace,
      harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
      runPrompt: async (role) => (role === 'analyzer' ? ANALYZER : role === 'author' ? TELOS : REVIEW),
      traces: provider.recorder,
      logger: noopLogger,
    })
    const started = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'noop' })
    const executed = await runtime.execute(started.id)
    assert.equal(executed.status, 'awaiting_human', 'a run without observability completes normally')
    const summary = await provider.reader.summary(project.id, 24)
    assert.equal(summary.available, false)
    assert.equal(summary.spans, 0)
  } finally {
    await provider.shutdown()
    await store.close()
    await workspace.close()
    rmSync(root, { recursive: true, force: true })
  }
})
