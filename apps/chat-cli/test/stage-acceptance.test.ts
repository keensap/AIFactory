import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectService } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import { PlanningStageRuntime, buildReviewerPrompt, parseStageReview, reviewAcceptance, type StageRole } from '../src/stage-runtime.ts'
import type { PlanningStageSettings } from '../src/stage-settings.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

/** The example from the request: 5 autonomous iterations, rating 95, 0 blockers, 1 major. */
const EXAMPLE: PlanningStageSettings = { gateAfterEachReview: false, maxReviewCycles: 5, minRating: 95, maxBlockers: 0, maxMajor: 1 }

const review = (rating: number, findings: Array<{ severity: string; id?: string }> = [], decision: 'approved' | 'needs_revision' = 'needs_revision') =>
  JSON.stringify({ decision, rating, findings: findings.map((finding) => ({ ...finding, section: 'Economic', finding: 'x', required_change: 'y' })) })

function harness(reviews: string[], settings: PlanningStageSettings) {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-accept-'))
  const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
  const workspace = fakeWorkspace()
  let reviewers = 0
  let authors = 0
  let index = 0
  const runtime = new PlanningStageRuntime({
    projects,
    workspace,
    harnessFactory: () => { throw new Error('not used') },
    runPrompt: async (role: StageRole) => {
      if (role === 'analyzer') return '# Analysis'
      if (role === 'author') {
        authors += 1
        return `# TELOS Feasibility Report\n\ndraft ${authors}\n`
      }
      reviewers += 1
      const next = reviews[Math.min(index, reviews.length - 1)]!
      index += 1
      return next
    },
    stageSettings: { planning: async () => settings },
  })
  return {
    root, runtime, workspace, projects,
    counters: () => ({ reviewers, authors }),
    start: async () => {
      const project = await projects.create({ name: 'ABCClothing', rootPath: root, organization: null, ownerEmail: null, status: 'active' })
      return runtime.start({ projectId: project.id, stage: 'planning', brief: 'portal' })
    },
  }
}

async function withHarness(reviews: string[], settings: PlanningStageSettings, fn: (h: ReturnType<typeof harness>) => Promise<void>): Promise<void> {
  const h = harness(reviews, settings)
  try {
    await fn(h)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
}

// ---- the acceptance rule itself ---------------------------------------

test('acceptance needs every criterion: rating, blockers and majors', () => {
  const accepted = reviewAcceptance({ decision: 'needs_revision', rating: 96, findings: [{ severity: 'major' }] }, EXAMPLE)
  assert.deepEqual(accepted.counts, { blockers: 0, major: 1, minor: 0 })
  assert.equal(accepted.accepted, true, 'rating 96 with one major meets 95/0/1')

  assert.equal(reviewAcceptance({ decision: 'approved', rating: 94, findings: [{ severity: 'major' }] }, EXAMPLE).accepted, false, 'rating below the threshold')
  assert.equal(reviewAcceptance({ decision: 'approved', rating: 100, findings: [] }, EXAMPLE).accepted, true)
  assert.equal(reviewAcceptance({ decision: 'approved', rating: 100, findings: [{ severity: 'blocker' }] }, EXAMPLE).accepted, false, 'a blocker blocks')
  assert.equal(reviewAcceptance({ decision: 'approved', rating: 100, findings: [{ severity: 'major' }, { severity: 'major' }] }, EXAMPLE).accepted, false, 'too many majors')
})

test('severity counting tolerates spellings and unknown values', () => {
  const result = reviewAcceptance({
    decision: 'approved',
    rating: 100,
    findings: [{ severity: 'BLOCKER' }, { severity: 'critical' }, { severity: 'major' }, { severity: 'minor' }, { severity: 'info' }, {}],
  }, { ...EXAMPLE, maxBlockers: 5, maxMajor: 5 })
  assert.deepEqual(result.counts, { blockers: 2, major: 1, minor: 3 })
})

test('a review without a rating falls back to the reviewer decision', () => {
  const settings = { ...EXAMPLE, maxMajor: 0 }
  assert.equal(reviewAcceptance({ decision: 'approved', findings: [] }, settings).accepted, true)
  assert.equal(reviewAcceptance({ decision: 'needs_revision', findings: [] }, settings).accepted, false)
  assert.equal(reviewAcceptance({ decision: 'approved', findings: [{ severity: 'major' }] }, settings).accepted, false, 'issue counts still apply')
})

// ---- the loop ---------------------------------------------------------

test('meeting the criteria stops the loop immediately, even before the budget', async () => {
  await withHarness([review(96, [{ severity: 'major' }])], EXAMPLE, async (h) => {
    const run = await h.start()
    const gated = await h.runtime.execute(run.id)
    assert.deepEqual(h.counters(), { reviewers: 1, authors: 1 }, 'no revision ran')
    assert.equal(gated.pendingGate?.kind, 'final', 'straight to human approval')
    assert.equal(gated.reviewCycles, 0)
    assert.equal(gated.pendingGate?.accepted, true)
    assert.equal(gated.pendingGate?.rating, 96)
    assert.deepEqual(gated.pendingGate?.counts, { blockers: 0, major: 1, minor: 0 })
    assert.deepEqual(gated.pendingGate?.criteria, { minRating: 95, maxBlockers: 0, maxMajor: 1 })
  })
})

test('below the threshold the run keeps revising until it passes', async () => {
  await withHarness([review(90), review(96)], EXAMPLE, async (h) => {
    const run = await h.start()
    const gated = await h.runtime.execute(run.id)
    assert.deepEqual(h.counters(), { reviewers: 2, authors: 2 }, 'one revision then accepted')
    assert.equal(gated.pendingGate?.kind, 'final')
    assert.equal(gated.pendingGate?.rating, 96)
    assert.equal(gated.pendingGate?.accepted, true)
  })
})

test('a high rating does not override too many major findings', async () => {
  await withHarness([review(100, [{ severity: 'major' }, { severity: 'major' }]), review(100, [{ severity: 'major' }])], EXAMPLE, async (h) => {
    const run = await h.start()
    const gated = await h.runtime.execute(run.id)
    assert.deepEqual(h.counters(), { reviewers: 2, authors: 2 }, 'the first review only had too many majors')
    assert.equal(gated.pendingGate?.accepted, true)
  })
})

test('the budget is honoured, then the operator is asked even though criteria are unmet', async () => {
  await withHarness([review(50, [{ severity: 'blocker' }])], { ...EXAMPLE, maxReviewCycles: 2 }, async (h) => {
    const run = await h.start()
    const gated = await h.runtime.execute(run.id)
    assert.deepEqual(h.counters(), { reviewers: 3, authors: 3 }, 'the first review plus two revision cycles')
    assert.equal(gated.pendingGate?.kind, 'final', 'still asks for approval')
    assert.equal(gated.pendingGate?.accepted, false)
    assert.equal(gated.pendingGate?.rating, 50)
  })
})

test('with gating on, meeting the criteria skips the review gate', async () => {
  await withHarness([review(96, [{ severity: 'major' }])], { ...EXAMPLE, gateAfterEachReview: true }, async (h) => {
    const run = await h.start()
    const gated = await h.runtime.execute(run.id)
    assert.equal(gated.pendingGate?.kind, 'final', 'no need to ask about applying changes')
    assert.deepEqual(h.counters(), { reviewers: 1, authors: 1 })
  })
})

test('the reviewer prompt states the criteria and asks for a rating', async () => {
  const h = harness([review(96)], EXAMPLE)
  try {
    const run = await h.start()
    const prompt = buildReviewerPrompt(
      { name: 'ABCClothing', organization: null, ownerEmail: null } as never,
      {
        schemaVersion: 1,
        stage: { key: 'planning', checklist: [], documents: [] },
        priorStages: [],
        documents: [],
        attachments: [],
        input: 'portal',
        constraints: { maxReviewCycles: 5, gateAfterEachReview: false, minRating: 95, maxBlockers: 0, maxMajor: 1, documentKind: 'telos_report', cardinality: 'one' },
      } as never,
      '# Draft',
      EXAMPLE,
    )
    assert.match(prompt, /rating >= 95/)
    assert.match(prompt, /blocker findings <= 0/)
    assert.match(prompt, /major findings <= 1/)
    assert.match(prompt, /"rating": <integer 0-100>/)
    assert.ok(run.id.length > 0)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('the review event records the rating, counts and acceptance', async () => {
  await withHarness([review(96, [{ severity: 'major' }])], EXAMPLE, async (h) => {
    const run = await h.start()
    await h.runtime.execute(run.id)
    const events = (h.workspace as unknown as { events: Array<{ type: string; payload: Record<string, unknown> }> }).events
    const decision = events.find((event) => event.type === 'review_decision')!
    assert.equal(decision.payload.rating, 96)
    assert.deepEqual(decision.payload.counts, { blockers: 0, major: 1, minor: 0 })
    assert.equal(decision.payload.accepted, true)
    assert.equal(decision.payload.decision, 'needs_revision', 'the reviewer may still ask for polish')
  })
})

test('the stored settings carry the criteria into the run context', async () => {
  await withHarness([review(96, [{ severity: 'major' }])], EXAMPLE, async (h) => {
    const run = await h.start()
    const context = (run.context ?? {}) as { constraints?: Record<string, unknown> }
    assert.equal(context.constraints?.minRating, 95)
    assert.equal(context.constraints?.maxBlockers, 0)
    assert.equal(context.constraints?.maxMajor, 1)
  })
})

test('parseStageReview exposes the rating', () => {
  assert.equal(parseStageReview(review(96)).rating, 96)
  assert.equal(parseStageReview('{"decision":"approved","findings":[]}').rating, null)
})
