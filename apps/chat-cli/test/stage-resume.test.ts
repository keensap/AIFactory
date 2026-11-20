import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectService } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import { PlanningStageRuntime, type StageRole } from '../src/stage-runtime.ts'
import type { StageRunEvent } from '../src/workspace.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const APPROVED = '{"decision":"approved","rating":100,"findings":[]}'
const CHANGES = JSON.stringify({
  decision: 'needs_revision',
  rating: 50,
  findings: [{ id: 'F-1', severity: 'major', section: 'Economic', finding: 'Budget missing', required_change: 'Add it' }],
})

/**
 * A harness whose reviewer fails on demand, so a resume can be interrupted the
 * way a provider timeout would interrupt it.
 */
function harness(options: { reviewerFailsAfter?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-resume-'))
  const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
  const workspace = fakeWorkspace()
  const calls: StageRole[] = []
  let reviews = 0
  let authors = 0
  let failureArmed = false

  const runtime = new PlanningStageRuntime({
    projects,
    workspace,
    harnessFactory: () => { throw new Error('not used') },
    runPrompt: async (role) => {
      calls.push(role)
      if (role === 'analyzer') return '# Analysis\n\nFeasible.'
      if (role === 'author') {
        authors += 1
        return `# TELOS Feasibility Report\n\nDraft ${authors}\n`
      }
      if (failureArmed) {
        failureArmed = false
        throw new Error('synthetic reviewer failure')
      }
      reviews += 1
      return reviews === 1 ? CHANGES : APPROVED
    },
    stageSettings: {
      planning: async () => ({ maxReviewCycles: 3, minRating: 0, maxBlockers: 0, maxMajor: 0, gateReminderHours: 72 }),
    },
  })

  return {
    root, runtime, workspace, projects,
    counters: () => ({ reviews, authors, calls: [...calls] }),
    failNextReviewer: () => { failureArmed = true },
    events: () => (workspace as unknown as { events: StageRunEvent[] }).events,
    start: async () => {
      const project = await projects.create({ name: 'ABCClothing', rootPath: root, organization: null, ownerEmail: null, status: 'active' })
      const run = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'Build a portal' })
      return { project, run }
    },
  }
}

async function withHarness(fn: (h: ReturnType<typeof harness>) => Promise<void>, options: { reviewerFailsAfter?: number } = {}): Promise<void> {
  const h = harness(options)
  try {
    await fn(h)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
}

// ---- autonomous review failures -------------------------------------

test('a reviewer failure during autonomous iteration fails the run for retry', async () => {
  await withHarness(async (h) => {
    const { run } = await h.start()
    h.failNextReviewer()
    await assert.rejects(() => h.runtime.execute(run.id))
    const after = await h.runtime.get(run.id)
    assert.equal(after.status, 'failed')
    assert.equal(after.pendingGate, null)
  })
})

test('a reviewer failure while refining leaves the final gate open', async () => {
  await withHarness(async (h) => {
    const { run } = await h.start()
    // Initial review requests changes, then the automatic revision succeeds.
    const accepted = await h.runtime.execute(run.id)
    assert.equal(accepted.pendingGate?.kind, 'final')
    const before = accepted.pendingGate

    h.failNextReviewer()
    await assert.rejects(
      () => h.runtime.decide(run.id, { refine: true }),
      (error: unknown) => (error as { code?: string }).code === 'STAGE_RESUME_FAILED',
    )

    const after = await h.runtime.get(run.id)
    assert.equal(after.status, 'awaiting_human')
    assert.equal(after.pendingGate?.kind, 'final')
    assert.deepEqual(after.pendingGate, before)
    assert.equal(after.documents.length, 0, 'no artifact appeared from a failed resume')
  })
})

test('a failure during first execution still fails the run', async () => {
  await withHarness(async (h) => {
    const { run } = await h.start()
    h.failNextReviewer()
    // The reviewer is the third role, so this fails during the initial execute.
    await assert.rejects(() => h.runtime.execute(run.id))
    const after = await h.runtime.get(run.id)
    assert.equal(after.status, 'failed', 'a first execution that fails is still a failed run')
  })
})

// ---- AR-04: completion is atomic ------------------------------------

test('completion approves the document and completes the run together', async () => {
  await withHarness(async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)
    const completed = await h.runtime.decide(run.id, { decision: 'go' })

    assert.equal(completed.status, 'completed')
    assert.equal(completed.documents.length, 1)
    assert.equal(completed.documents[0]?.status, 'approved', 'the document is approved in the same step')
    assert.equal(completed.pendingGate, null)
    const updates = (h.workspace as unknown as { checklistUpdates: Array<{ key: string; status: unknown }> }).checklistUpdates
    assert.ok(updates.some((entry) => entry.key === 'feasibility_decision' && entry.status === 'done'))
  })
})

test('a completion that cannot write the document leaves the run at its gate', async () => {
  await withHarness(async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)

    // Make the document write fail the way a full disk or bad path would.
    const workspace = h.workspace as unknown as { addDocument: (input: unknown) => Promise<unknown> }
    const original = workspace.addDocument.bind(h.workspace)
    let failed = false
    workspace.addDocument = async () => {
      failed = true
      throw new Error('disk full')
    }
    try {
      await assert.rejects(
        () => h.runtime.decide(run.id, { decision: 'go' }),
        (error: unknown) => (error as { code?: string }).code === 'STAGE_RESUME_FAILED',
      )
    } finally {
      workspace.addDocument = original
    }
    assert.equal(failed, true)

    const after = await h.runtime.get(run.id)
    assert.equal(after.status, 'awaiting_human', 'the gate is still open, so the decision can be retried')
    assert.equal(after.documents.length, 0, 'no orphan document was left behind')

    const completed = await h.runtime.decide(run.id, { decision: 'go' })
    assert.equal(completed.status, 'completed')
  })
})

// ---- AR-04: retry a failed run --------------------------------------

test('retry resumes a failed run without repeating the completed phases', async () => {
  await withHarness(async (h) => {
    const { run } = await h.start()
    h.failNextReviewer()
    await assert.rejects(() => h.runtime.execute(run.id))
    assert.equal((await h.runtime.get(run.id)).status, 'failed')

    const before = h.counters()
    assert.equal(before.calls.filter((role) => role === 'analyzer').length, 1)
    assert.equal(before.calls.filter((role) => role === 'author').length, 1)

    const retried = await h.runtime.retry(run.id)
    assert.equal(retried.status, 'pending')

    const gated = await h.runtime.execute(run.id)
    assert.equal(gated.pendingGate?.kind, 'final')
    const after = h.counters()
    assert.equal(after.calls.filter((role) => role === 'analyzer').length, 1, 'the analyzer was not run again')
    assert.equal(after.calls.filter((role) => role === 'author').length, 2, 'the existing draft was reused, followed by one automatic revision')
    assert.equal(after.reviews, 2, 'the retry reviews the draft and then its revision')

    const events = h.events().filter((event) => event.type === 'run_retried')
    assert.equal(events.length, 1)
    assert.equal((events[0]!.payload as { hadDraft: boolean }).hadDraft, true)
  })
})

test('only a failed run can be retried', async () => {
  await withHarness(async (h) => {
    const { run } = await h.start()
    await assert.rejects(
      () => h.runtime.retry(run.id),
      (error: unknown) => (error as { code?: string }).code === 'STAGE_RUN_NOT_FAILED',
    )
    await h.runtime.execute(run.id)
    await assert.rejects(
      () => h.runtime.retry(run.id),
      (error: unknown) => (error as { code?: string }).code === 'STAGE_RUN_NOT_FAILED',
    )
    await assert.rejects(
      () => h.runtime.retry('00000000-0000-4000-8000-000000000000'),
      (error: unknown) => (error as { code?: string }).code === 'STAGE_RUN_NOT_FOUND',
    )
  })
})
