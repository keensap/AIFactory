import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectService } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import { PlanningStageRuntime, type StageRole } from '../src/stage-runtime.ts'
import type { PlanningStageSettings } from '../src/stage-settings.ts'
import type { StageRunEvent } from '../src/workspace.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const REVIEWS = {
  approved: '{"decision":"approved","rating":100,"findings":[]}',
  revise: (id: string) => JSON.stringify({
    decision: 'needs_revision',
    rating: 50,
    findings: [{ id, severity: 'major', section: 'Economic', finding: 'Budget not evidenced', required_change: 'Add the budget' }],
  }),
}

/** Settings with every field filled; the tests only vary the gating knobs. */
const withSettings = (overrides: Partial<PlanningStageSettings>): PlanningStageSettings => ({
  maxReviewCycles: 3, minRating: 0, maxBlockers: 0, maxMajor: 0, gateReminderHours: 72, ...overrides,
})

interface Script {
  /** Reviewer decisions, consumed in order; the last repeats. */
  reviews: string[]
  settings?: PlanningStageSettings
}

function harness(script: Script) {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-gate-'))
  const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
  const workspace = fakeWorkspace()
  const calls: StageRole[] = []
  let reviews = 0
  let authors = 0
  let reviewIndex = 0
  let settings = script.settings ?? withSettings({})

  const runtime = new PlanningStageRuntime({
    projects,
    workspace,
    harnessFactory: () => { throw new Error('not used') },
    runPrompt: async (role) => {
      calls.push(role)
      if (role === 'analyzer') return '# Analysis\n\nFeasible.'
      if (role === 'author') {
        authors += 1
        return `# TELOS Feasibility Report\n\n## 10. Recommendation\n\nDecision: **Go** (draft ${authors})\n`
      }
      reviews += 1
      const decision = script.reviews[Math.min(reviewIndex, script.reviews.length - 1)]!
      reviewIndex += 1
      return decision
    },
    stageSettings: { planning: async () => settings },
  })

  return {
    root, runtime, workspace, projects, calls,
    counters: () => ({ reviews, authors }),
    setSettings: (next: PlanningStageSettings) => { settings = next },
    events: () => (workspace as unknown as { events: StageRunEvent[] }).events,
    start: async () => {
      const project = await projects.create({ name: 'ABCClothing', rootPath: root, organization: null, ownerEmail: null, status: 'active' })
      const run = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'Build a portal' })
      return { project, run }
    },
  }
}

async function withHarness(script: Script, fn: (h: ReturnType<typeof harness>) => Promise<void>): Promise<void> {
  const h = harness(script)
  try {
    await fn(h)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
}

// ---- automatic cycles and final human gate --------------------------

test('failed reviews revise automatically until accepted, then ask at the final gate', async () => {
  await withHarness({ reviews: [REVIEWS.revise('F-1'), REVIEWS.revise('F-2'), REVIEWS.approved], settings: withSettings({ maxReviewCycles: 3 }) }, async (h) => {
    const { run } = await h.start()
    const gated = await h.runtime.execute(run.id)

    // The third review passes before the three-cycle budget is exhausted.
    assert.deepEqual(h.counters(), { reviews: 3, authors: 3 }, 'one draft plus two revisions')
    assert.equal(gated.pendingGate?.kind, 'final')
    assert.equal(gated.reviewCycles, 2)
    assert.equal(gated.status, 'awaiting_human')
    assert.equal(gated.pendingGate?.reviewDecision, 'approved')
  })
})

test('automatic review stops after the cycle budget and keeps the last findings', async () => {
  await withHarness({ reviews: [REVIEWS.revise('F-1')], settings: withSettings({ maxReviewCycles: 2 }) }, async (h) => {
    const { run } = await h.start()
    const gated = await h.runtime.execute(run.id)
    assert.deepEqual(h.counters(), { reviews: 3, authors: 3 }, 'first review plus two revision cycles')
    assert.equal(gated.pendingGate?.kind, 'final')
    assert.equal(gated.pendingGate?.reviewDecision, 'needs_revision')
    assert.equal(gated.reviewCycles, 2)
    assert.equal(gated.pendingGate?.findings.length, 1)
  })
})

test('a failed review never creates an intermediate review gate', async () => {
  await withHarness({ reviews: [REVIEWS.revise('F-1'), REVIEWS.approved], settings: withSettings({ maxReviewCycles: 3 }) }, async (h) => {
    const { run } = await h.start()
    const result = await h.runtime.execute(run.id)
    assert.equal(result.pendingGate?.kind, 'final')
    assert.deepEqual(h.counters(), { reviews: 2, authors: 2 })
    assert.equal(result.reviewCycles, 1)
  })
})

test('an approved review goes straight to the final gate', async () => {
  await withHarness({ reviews: [REVIEWS.approved], settings: withSettings({ maxReviewCycles: 3 }) }, async (h) => {
    const { run } = await h.start()
    const gated = await h.runtime.execute(run.id)
    assert.equal(gated.pendingGate?.kind, 'final')
    assert.deepEqual(h.counters(), { reviews: 1, authors: 1 })
  })
})

// ---- final gate ------------------------------------------------------

test('refining once runs another review and revision, then asks again', async () => {
  await withHarness({ reviews: [REVIEWS.approved, REVIEWS.revise('F-9')], settings: withSettings({ maxReviewCycles: 3 }) }, async (h) => {
    const { run } = await h.start()
    const gated = await h.runtime.execute(run.id)
    assert.equal(gated.pendingGate?.kind, 'final')

    const refined = await h.runtime.decide(run.id, { refine: true })
    assert.equal(refined.pendingGate?.kind, 'final', 'the operator is asked again')
    // The refined pass reviews, revises, then reviews the revision: the gate must
    // describe the document it hands over, not the one before the revision.
    assert.equal(h.counters().reviews, 3, 'the re-review of the revision is not skipped')
    assert.equal(h.counters().authors, 2, 'one extra revision')
    assert.equal(refined.status, 'awaiting_human')
    assert.equal(refined.documents.length, 0, 'still no artifact before approval')
  })
})

test('refining when the review approves changes nothing but asks again', async () => {
  await withHarness({ reviews: [REVIEWS.approved], settings: withSettings({ maxReviewCycles: 3 }) }, async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)
    const refined = await h.runtime.decide(run.id, { refine: true })
    assert.equal(refined.pendingGate?.kind, 'final')
    assert.equal(h.counters().authors, 1, 'no needless revision')
    assert.equal(refined.reviewCycles, 0)
  })
})

test('only approval completes the stage and produces the document and PDF', async () => {
  await withHarness({ reviews: [REVIEWS.revise('F-1'), REVIEWS.approved], settings: withSettings({ maxReviewCycles: 3 }) }, async (h) => {
    const { run } = await h.start()
    const gated = await h.runtime.execute(run.id)
    assert.equal(gated.pendingGate?.kind, 'final')
    const decided = await h.runtime.decide(run.id, { decision: 'conditional_go', note: 'Proceed after budget confirmation' })

    assert.equal(decided.status, 'completed')
    assert.equal(decided.pendingGate, null)
    assert.equal(decided.documents.length, 1)
    assert.match(decided.summaryMarkdown ?? '', /Decision: \*\*conditional-go\*\*/)
    assert.match(decided.summaryMarkdown ?? '', /Proceed after budget confirmation/)
    assert.ok(existsSync(join(h.root, 'documents', 'planning', 'TELOS Feasibility Report — ABCClothing.pdf')))
    assert.ok(h.events().some((event) => event.type === 'document_exported'))
  })
})

test('a decision needs go, conditional_go or no_go unless refining', async () => {
  await withHarness({ reviews: [REVIEWS.approved], settings: withSettings({ maxReviewCycles: 3 }) }, async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)
    await assert.rejects(
      () => h.runtime.decide(run.id, {}),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_HUMAN_DECISION',
    )
    await assert.rejects(
      () => h.runtime.decide(run.id, { decision: 'maybe' as never }),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_HUMAN_DECISION',
    )
  })
})

// ---- settings snapshot ----------------------------------------------

test('a run keeps its review budget snapshot when settings change after start', async () => {
  await withHarness({ reviews: [REVIEWS.revise('F-1')], settings: withSettings({ maxReviewCycles: 3 }) }, async (h) => {
    const { run } = await h.start()
    h.setSettings(withSettings({ maxReviewCycles: 1 }))
    const result = await h.runtime.execute(run.id)
    assert.equal(result.pendingGate?.kind, 'final')
    assert.equal(result.pendingGate?.maxReviewCycles, 3)
    assert.deepEqual(h.counters(), { reviews: 4, authors: 4 }, 'the run uses the original three-cycle snapshot')
  })
})

test('the cycle budget comes from settings, not the constructor default', async () => {
  await withHarness({ reviews: [REVIEWS.revise('F-1')], settings: withSettings({ maxReviewCycles: 1 }) }, async (h) => {
    const { run } = await h.start()
    const gated = await h.runtime.execute(run.id)
    assert.deepEqual(h.counters(), { reviews: 2, authors: 2 }, 'one revision cycle as configured')
    assert.equal(gated.pendingGate?.maxReviewCycles, 1)
  })
})

// ---- HTTP surface ------------------------------------------------------

test('automatic review and decision endpoints drive the pause/resume lifecycle', async () => {
  const h = harness({ reviews: [REVIEWS.revise('F-1'), REVIEWS.approved], settings: withSettings({ maxReviewCycles: 3 }) })
  const { createChatServer, serverPort } = await import('../src/server.ts')
  const { DshHarness } = await import('../src/harness.ts')
  const { SessionStore } = await import('../src/store.ts')
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-gate-api-'))
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    projects: h.projects,
    workspace: h.workspace,
    stageRuntime: h.runtime,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const base = `http://127.0.0.1:${serverPort(server)}`
  h.workspace.listSdlcStages = async () => [
    { key: 'planning', name: 'Planning', position: 1 },
    { key: 'requirements', name: 'Requirements', position: 2 },
  ]
  try {
    const catalogue = await (await fetch(`${base}/api/sdlc/stages`)).json() as { stages: Array<{ key: string; executable: boolean }> }
    assert.deepEqual(catalogue.stages.map(({ key, executable }) => [key, executable]), [['planning', true], ['requirements', false]])
    const project = await h.projects.create({ name: 'Gated', rootPath: h.root, organization: null, ownerEmail: null, status: 'inactive' })
    const created = await (await fetch(`${base}/api/projects/${project.id}/stages/planning/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief: 'gated run' }),
    })).json() as { run: { id: string } }
    const runId = created.run.id

    const executed = await (await fetch(`${base}/api/stage-runs/${runId}/execute?wait=1`, { method: 'POST' })).json() as { run: { status: string; pendingGate: { kind: string } | null } }
    assert.equal(executed.run.status, 'awaiting_human')
    assert.equal(executed.run.pendingGate?.kind, 'final', 'failed review was revised automatically before pausing')

    // Refining over HTTP returns to the final gate.
    const refined = await (await fetch(`${base}/api/stage-runs/${runId}/decision`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refine: true }),
    })).json() as { run: { status: string; pendingGate: { kind: string } | null } }
    assert.equal(refined.run.status, 'awaiting_human')
    assert.equal(refined.run.pendingGate?.kind, 'final')

    const decided = await (await fetch(`${base}/api/stage-runs/${runId}/decision`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'go' }),
    })).json() as { run: { status: string; documents: unknown[] } }
    assert.equal(decided.run.status, 'completed')
    assert.equal(decided.run.documents.length, 1)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(h.root, { recursive: true, force: true })
  }
})
