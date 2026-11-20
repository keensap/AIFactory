import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { normalizeRevisionFindings } from '../src/processes/revision.ts'
import { ProjectService } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import { StageEngine, type StageRole } from '../src/stage-runtime.ts'
import { STAGE_DEFINITIONS, stageDefinition } from '../src/stages/index.ts'
import { STAGE_PROCESSES } from '../src/agents.ts'
import { STAGE_SETTINGS_DEFINITIONS } from '../src/stage-settings.ts'
import type { StageRunEvent } from '../src/workspace.ts'
import { createHash } from 'node:crypto'
import { COVERED_REQUIREMENTS } from './support/requirements-fixture.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const SETTINGS = {
  maxReviewCycles: 2, minRating: 0, maxBlockers: 0, maxMajor: 0, gateReminderHours: 72,
}
const REVIEW_OK = '{"decision":"approved","rating":95,"findings":[]}'
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

function harness(
  definition = stageDefinition('requirements')!,
  draft: string | string[] = COVERED_REQUIREMENTS,
  reviews: string[] = [REVIEW_OK],
  settings = SETTINGS,
) {
  const drafts = typeof draft === 'string' ? [draft] : [...draft]
  const answers = [...reviews]
  const root = mkdtempSync(join(tmpdir(), 'aifactory-req-'))
  const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
  const workspace = fakeWorkspace()
  const prompts: Array<{ role: StageRole; prompt: string }> = []

  const runtime = new StageEngine({
    definition,
    projects,
    workspace,
    harnessFactory: () => { throw new Error('not used') },
    runPrompt: async (role, prompt) => {
      prompts.push({ role, prompt })
      if (role === 'analyzer') return '# Analysis\n\n## Actors\n- Customer'
      if (role === 'author') return (drafts.length > 1 ? drafts.shift() : drafts[0])!
      return (answers.length > 1 ? answers.shift() : answers[0])!
    },
    stageSettings: { planning: async () => settings, requirements: async () => settings },
  })

  return {
    root, runtime, workspace, projects, prompts,
    events: () => (workspace as unknown as { events: StageRunEvent[] }).events,
    start: async () => {
      const projectRoot = mkdtempSync(join(root, 'project-'))
      const project = await projects.create({ name: 'Reqs', rootPath: projectRoot, organization: null, ownerEmail: null, status: 'active' })
      const run = await runtime.start({ projectId: project.id, stage: 'requirements', brief: 'build a portal' })
      return { project, run }
    },
  }
}

async function withHarness(fn: (h: ReturnType<typeof harness>) => Promise<void>): Promise<void> {
  const h = harness()
  try {
    await fn(h)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
}

// ---- the registry -------------------------------------------------------

test('the registry knows which stages can run, and which cannot', () => {
  assert.deepEqual(STAGE_DEFINITIONS.map((definition) => definition.stage), ['planning', 'requirements'])
  assert.equal(stageDefinition('design'), undefined, 'a stage without a runtime is not pretended')
  assert.equal(stageDefinition('planning')?.artifact.kind, 'telos_report')
  assert.equal(stageDefinition('requirements')?.artifact.kind, 'requirements_spec')
})

test('the stage registry and the process map agree', () => {
  // `agents.ts` declares this map by hand to avoid an import cycle; this is the
  // guard that a new stage cannot be added without its processes.
  for (const definition of STAGE_DEFINITIONS) {
    assert.deepEqual(
      STAGE_PROCESSES[definition.stage],
      [...definition.processes],
      `${definition.stage}: STAGE_PROCESSES must match the definition`,
    )
  }
  const declared = Object.keys(STAGE_PROCESSES).sort()
  assert.deepEqual(declared, STAGE_DEFINITIONS.map((entry) => entry.stage).sort())
})

test('processes and settings follow the definitions, not a hard-coded list', () => {
  assert.deepEqual(STAGE_PROCESSES.requirements, ['analyzer', 'author', 'reviewer'])
  assert.ok(STAGE_SETTINGS_DEFINITIONS.requirements !== undefined, 'requirements has settings')
  // Every executable stage must be configurable and assignable, or it cannot run.
  for (const definition of STAGE_DEFINITIONS) {
    assert.ok(STAGE_PROCESSES[definition.stage] !== undefined, `${definition.stage} has processes`)
    assert.ok(STAGE_SETTINGS_DEFINITIONS[definition.stage] !== undefined, `${definition.stage} has settings`)
    assert.ok(definition.artifact.checklistKeys.length > 0, `${definition.stage} evidences a checklist`)
  }
})

// ---- explicit human decisions ------------------------------------------

/** Pause a fresh requirements run at the final gate. */
async function paused(h: ReturnType<typeof harness>) {
  const { run } = await h.start()
  const gated = await h.runtime.execute(run.id)
  assert.equal(gated.pendingGate?.kind, 'final')
  return { run, gated }
}

/** The requirements checklist as the workspace now holds it. */
async function checklistDone(h: ReturnType<typeof harness>): Promise<string[]> {
  const snapshot = await h.workspace.getSnapshot('p')
  return snapshot.checklist
    .filter((item) => item.stage === 'requirements' && item.status === 'done')
    .map((item) => item.key)
    .sort()
}

test('an empty decision never approves a requirements run', async () => {
  await withHarness(async (h) => {
    const { run } = await paused(h)
    for (const body of [{}, { note: 'looks fine' }, { decision: 'maybe' }, { decision: 'no_go ' }]) {
      await assert.rejects(
        () => h.runtime.decide(run.id, body as never),
        (error: unknown) => (error as { code?: string }).code === 'INVALID_HUMAN_DECISION',
        `${JSON.stringify(body)} must be refused`,
      )
    }
    const after = await h.runtime.get(run.id)
    assert.equal(after.status, 'awaiting_human')
    assert.equal(after.documents.length, 0)
    assert.deepEqual(await checklistDone(h), [])
  })
})

test('a rejection keeps the gate open and publishes nothing', async () => {
  await withHarness(async (h) => {
    const { run, gated } = await paused(h)
    const rejected = await h.runtime.decide(run.id, { decision: 'rejected', note: 'Missing payment NFRs' })

    assert.equal(rejected.status, 'awaiting_human', 'the stage is not completed')
    assert.equal(rejected.pendingGate?.kind, 'final', 'the same gate stays open')
    assert.equal(rejected.pendingGate?.reviewDecision, gated.pendingGate?.reviewDecision)
    assert.equal(rejected.documents.length, 0, 'no document is published')
    assert.equal(rejected.draftMarkdown, gated.draftMarkdown, 'the draft is kept')
    assert.deepEqual(await checklistDone(h), [], 'no checklist evidence is written')
    assert.match(rejected.summaryMarkdown ?? '', /Decision: \*\*rejected\*\*/)
    assert.match(rejected.summaryMarkdown ?? '', /Missing payment NFRs/)
    const event = h.events().find((entry) => entry.type === 'gate_decision')
    assert.deepEqual(event?.payload, { gate: 'final', decision: 'rejected', rejected: true, note: 'Missing payment NFRs' })
  })
})

test('no_go on an approval stage is a rejection, not a negative completion', async () => {
  await withHarness(async (h) => {
    const { run } = await paused(h)
    const rejected = await h.runtime.decide(run.id, { decision: 'no_go' })
    assert.equal(rejected.status, 'awaiting_human')
    assert.equal(rejected.documents.length, 0)
    assert.deepEqual(await checklistDone(h), [])
  })
})

test('rejecting twice keeps one decision record and still publishes nothing', async () => {
  await withHarness(async (h) => {
    const { run } = await paused(h)
    await h.runtime.decide(run.id, { decision: 'rejected', note: 'first' })
    const second = await h.runtime.decide(run.id, { decision: 'rejected', note: 'second' })
    const decisions = (second.summaryMarkdown ?? '').match(/## Human decision/g) ?? []
    assert.equal(decisions.length, 1, 'the record is replaced, not appended twice')
    assert.doesNotMatch(second.summaryMarkdown ?? '', /first/)
    assert.match(second.summaryMarkdown ?? '', /second/)
  })
})

test('a rejected run can still be approved later', async () => {
  await withHarness(async (h) => {
    const { run } = await paused(h)
    await h.runtime.decide(run.id, { decision: 'rejected', note: 'not yet' })
    const approved = await h.runtime.decide(run.id, { decision: 'approved', note: 'now it is fine' })
    assert.equal(approved.status, 'completed')
    assert.equal(approved.documents.length, 1)
    assert.equal(approved.documents[0]?.kind, 'requirements_spec')
    assert.deepEqual(await checklistDone(h), ['acceptance_criteria', 'requirement_document', 'requirements_review'])
    assert.match(approved.summaryMarkdown ?? '', /Decision: \*\*approved\*\*/)
    assert.match(approved.summaryMarkdown ?? '', /now it is fine/)
  })
})

test('refine still runs one more pass and returns to the same gate', async () => {
  await withHarness(async (h) => {
    const { run } = await paused(h)
    const refined = await h.runtime.decide(run.id, { refine: true })
    assert.equal(refined.status, 'awaiting_human')
    assert.equal(refined.pendingGate?.kind, 'final')
    assert.equal(refined.documents.length, 0)
    assert.deepEqual(await checklistDone(h), [])
  })
})

// ---- the second stage actually runs ------------------------------------

test('the requirements stage runs end to end on the same engine', async () => {
  await withHarness(async (h) => {
    const { run } = await h.start()
    assert.equal(run.stage, 'requirements', 'the run is a requirements run')

    const gated = await h.runtime.execute(run.id)
    assert.equal(gated.status, 'awaiting_human')
    assert.equal(gated.pendingGate?.kind, 'final', 'it stops at the final gate like planning')

    // The draft is the requirements artifact, and no document exists yet.
    assert.match(gated.draftMarkdown ?? '', /Requirements Specification/)
    assert.equal(gated.documents.length, 0, 'nothing is published before approval')
    assert.ok(gated.reviews.length > 0)
    assert.ok(gated.reviews.every((review) => review.reviewerRole === 'requirements_reviewer'), 'reviews name the requirements reviewer, not planning')

    const done = await h.runtime.decide(run.id, { decision: 'approved' })
    assert.equal(done.status, 'completed')
    const document = done.documents[0]!
    assert.equal(document.kind, 'requirements_spec')
    assert.equal(document.title, 'Requirements specification')
    assert.equal(document.stage, 'requirements')

    // The checklist this artifact evidences is the requirements one.
    const checklist = (await h.workspace.getSnapshot(run.projectId)).checklist
      .filter((item) => item.stage === 'requirements')
    const done_ = checklist.filter((item) => item.status === 'done').map((item) => item.key).sort()
    assert.deepEqual(done_, ['acceptance_criteria', 'requirement_document', 'requirements_review'])
  })
})

test('requirements prompts are its own, not planning\u2019s', async () => {
  await withHarness(async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)

    const analyzer = h.prompts.find((entry) => entry.role === 'analyzer')!.prompt
    assert.match(analyzer, /requirements/i)
    assert.doesNotMatch(analyzer, /TELOS/i, 'the planning template does not leak in')
    assert.match(analyzer, /Actors/, 'the requirements analysis asks for actors')
    // A live run showed an analyzer that drafted the whole specification and
    // created files until the role timed out; the prompt must forbid both.
    assert.match(analyzer, /Do not write the specification itself/)
    assert.match(analyzer, /Do not create, edit or delete files/)
    assert.match(h.prompts.find((entry) => entry.role === 'author')!.prompt, /Do not create, edit or delete files/)

    const author = h.prompts.find((entry) => entry.role === 'author')!.prompt
    assert.match(author, /FR-001/, 'functional requirements are numbered')
    assert.match(author, /Acceptance criteria/)
    assert.doesNotMatch(author, /TELOS/i)

    const reviewer = h.prompts.find((entry) => entry.role === 'reviewer')!.prompt
    assert.match(reviewer, /acceptance criteria/i)
  })
})

test('a long draft reaches the revision prompt whole, with a reply-only instruction', () => {
  // A live draft grew past 60,000 characters; the old prompt cut its tail.
  const tail = 'TAIL-MARKER-LAST-SECTION'
  const draft = `${COVERED_REQUIREMENTS}\n\n${'x'.repeat(80_000)}\n${tail}`
  const definition = stageDefinition('requirements')!
  const project = { name: 'Long' } as Parameters<typeof definition.prompts.revision>[0]
  const context = { input: 'brief', priorStages: [], documents: [], attachments: [], baselineEvidence: [] } as unknown as Parameters<typeof definition.prompts.revision>[1]
  const prompt = definition.prompts.revision(project, context, 'analysis', draft, [])
  assert.ok(prompt.includes(tail), 'the end of the document is in the prompt')
  assert.doesNotMatch(prompt, /truncated: document continues/)
  assert.match(prompt, /Do not create, edit or delete files/)
})

test('coverage blockers survive model approval and require an explicit audited waiver', async () => {
  const h = harness(undefined, COVERED_REQUIREMENTS.replace('| AC-002 | NFR-001 |', '| AC-002 | NFR-999 |'))
  try {
    const { run, gated } = await paused(h)
    assert.equal(gated.reviewCycles, SETTINGS.maxReviewCycles)
    assert.equal(gated.pendingGate?.accepted, false)
    const coverage = gated.pendingGate?.coverage
    assert.equal(coverage?.counts.withAcceptanceCriteria, 1)
    assert.ok(coverage?.findings.some((finding) => finding.code === 'DANGLING_REQUIREMENT_ID'))
    assert.match(gated.summaryMarkdown ?? '', /Requirements coverage/)
    const review = h.events().find((entry) => entry.type === 'review_decision')
    assert.deepEqual((review?.payload as { coverage: unknown }).coverage, coverage)
    assert.match(h.prompts.find(({ role, prompt }) => role === 'author' && prompt.includes('NFR-999'))?.prompt ?? '', /undeclared requirement NFR-999/)
    await assert.rejects(() => h.runtime.decide(run.id, { decision: 'approved', note: 'not a waiver' }), { code: 'REQUIREMENTS_COVERAGE_BLOCKED' })
    await assert.rejects(() => h.runtime.decide(run.id, { decision: 'approved', coverageWaiverReason: '  ' }), { code: 'INVALID_COVERAGE_WAIVER' })
    await assert.rejects(() => h.runtime.decide(run.id, { decision: 'go', coverageWaiverReason: 'exception' }), { code: 'INVALID_COVERAGE_WAIVER' })
    const stillGated = await h.runtime.get(run.id)
    assert.equal(stillGated.status, 'awaiting_human')
    assert.equal(stillGated.documents.length, 0)
    const done = await h.runtime.decide(run.id, { decision: 'approved', coverageWaiverReason: 'Verification tracked separately' })
    assert.equal(done.status, 'completed')
    assert.match(done.summaryMarkdown ?? '', /Coverage waiver reason: Verification tracked separately/)
    const decision = h.events().find((entry) => entry.type === 'human_decision')
    assert.equal((decision?.payload as { coverageWaiver: { reason: string } }).coverageWaiver.reason, 'Verification tracked separately')
  } finally { rmSync(h.root, { recursive: true, force: true }) }
})

test('a contract omission triggers revision even when the model approves', async () => {
  const incomplete = COVERED_REQUIREMENTS.replace('Read own orders', '')
  const h = harness(undefined, [incomplete, COVERED_REQUIREMENTS])
  try {
    const { gated } = await paused(h)
    const decisions = h.events().filter(({ type }) => type === 'review_decision')
    const first = decisions[0]?.payload as { accepted: boolean; coverage: { findings: Array<{ code: string }> } }
    assert.equal(first.accepted, false)
    assert.ok(first.coverage.findings.some(({ code }) => code.startsWith('CONTRACT_')))
    assert.equal(gated.reviewCycles, 1)
    assert.equal(gated.pendingGate?.accepted, true)
    // The fixture cites no SRC ids, so only advisory UNCITED_SOURCE may remain (FR-201).
    assert.deepEqual(gated.pendingGate?.coverage?.findings.filter(({ code }) => code !== 'UNCITED_SOURCE'), [])
  } finally { rmSync(h.root, { recursive: true, force: true }) }
})

test('unresolved contract blockers stay visible at the gate after the budget runs out', async () => {
  const incomplete = COVERED_REQUIREMENTS.replace('Sign-in flow must be added', '')
  const h = harness(undefined, incomplete)
  try {
    const { run, gated } = await paused(h)
    assert.equal(gated.reviewCycles, SETTINGS.maxReviewCycles)
    assert.equal(gated.pendingGate?.accepted, false)
    assert.ok(gated.pendingGate?.coverage?.findings.some(({ code, message }) => code.startsWith('CONTRACT_') && message.includes('impact if wrong')))
    await assert.rejects(() => h.runtime.decide(run.id, { decision: 'approved' }), { code: 'REQUIREMENTS_COVERAGE_BLOCKED' })
    assert.equal((await h.runtime.get(run.id)).documents.length, 0)
  } finally { rmSync(h.root, { recursive: true, force: true }) }
})

test('semantic reviewer findings prompt correction and the next clean review reaches the gate', async () => {
  const conflicting = COVERED_REQUIREMENTS.replace('Shows orders', 'Shows all orders despite the own-orders permission')
  const review = JSON.stringify({ decision: 'needs_revision', rating: 45, findings: [{ id: 'F-001', severity: 'blocker', section: 'Functional requirements', finding: 'FR-001 contradicts own-orders permissions', required_change: 'Restrict orders to the customer' }] })
  const h = harness(undefined, [conflicting, COVERED_REQUIREMENTS], [review, REVIEW_OK])
  try {
    const { gated } = await paused(h)
    const reviewer = h.prompts.find(({ role }) => role === 'reviewer')!.prompt
    assert.match(reviewer, /Analyzer output/)
    assert.match(reviewer, /## Actors\n- Customer/)
    assert.match(reviewer, /build a portal/)
    assert.match(reviewer, /Severity rubric/)
    assert.match(h.prompts.filter(({ role }) => role === 'author')[1]!.prompt, /Restrict orders to the customer/)
    assert.equal(gated.reviewCycles, 1)
    assert.equal(gated.pendingGate?.accepted, true)
  } finally { rmSync(h.root, { recursive: true, force: true }) }
})

test('source and goal gaps are advisory and do not block approval', async () => {
  const h = harness(undefined, COVERED_REQUIREMENTS.replace('| FR-001 | Brief | Customers can see orders |', '| FR-001 | — | — |'))
  try {
    const { run, gated } = await paused(h)
    assert.equal(gated.pendingGate?.accepted, true)
    assert.deepEqual(gated.pendingGate?.coverage?.findings.map(({ code }) => code).filter((code) => code !== 'UNCITED_SOURCE'), ['MISSING_SOURCE', 'MISSING_GOAL'])
    assert.equal((await h.runtime.decide(run.id, { decision: 'approved' })).status, 'completed')
  } finally { rmSync(h.root, { recursive: true, force: true }) }
})

test('a requirements run is listed and fetched as its own stage', async () => {
  await withHarness(async (h) => {
    const { project, run } = await h.start()
    const listed = await h.runtime.list(project.id, 'requirements')
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.id, run.id)

    // Asking a requirements engine for planning runs is a mistake, not a silent empty list.
    await assert.rejects(
      () => h.runtime.list(project.id, 'planning'),
      (error: unknown) => (error as { code?: string }).code === 'STAGE_NOT_IMPLEMENTED',
    )
  })
})

test('a planning engine refuses a requirements run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-mixed-'))
  try {
    const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
    const workspace = fakeWorkspace()
    const planning = new StageEngine({
      definition: stageDefinition('planning')!,
      projects,
      workspace,
      harnessFactory: () => { throw new Error('not used') },
      runPrompt: async () => '# x',
      stageSettings: { planning: async () => SETTINGS },
    })
    const reqs = new StageEngine({
      definition: stageDefinition('requirements')!,
      projects,
      workspace,
      harnessFactory: () => { throw new Error('not used') },
      runPrompt: async () => '# x',
      stageSettings: { requirements: async () => SETTINGS },
    })

    const projectRoot = mkdtempSync(join(tmpdir(), 'aifactory-mixed-project-'))
    const project = await projects.create({ name: 'Mixed', rootPath: projectRoot, organization: null, ownerEmail: null, status: 'active' })
    await reqs.start({ projectId: project.id, stage: 'requirements', brief: 'x' })

    await assert.rejects(
      () => planning.start({ projectId: project.id, stage: 'requirements', brief: 'x' }),
      (error: unknown) => (error as { code?: string }).code === 'STAGE_NOT_IMPLEMENTED',
      'each engine drives exactly one stage',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- review provenance and the refine pass --------------------------------

test('a refine pass reviews the revised draft before the gate, never an unreviewed one', async () => {
  const first = COVERED_REQUIREMENTS.replace('Shows orders', 'Shows orders and account history')
  const second = COVERED_REQUIREMENTS.replace('Shows orders', 'Shows orders for the customer')
  const third = COVERED_REQUIREMENTS.replace('Shows orders', 'Shows orders for the signed-in customer')
  const marginal = JSON.stringify({
    decision: 'needs_revision',
    rating: 60,
    findings: [{ id: 'F-001', severity: 'major', section: '3. Functional requirements', finding: 'FR-001 behaviour is imprecise', required_change: 'state the actor scope' }],
  })
  // cycle 1: review(first) -> revise(second) -> review(second) -> gate
  // refine:   review(second) -> revise(third) -> review(third) -> gate
  const h = harness(undefined, [first, second, third], [marginal, marginal, marginal, REVIEW_OK], { ...SETTINGS, maxReviewCycles: 1 })
  try {
    const { run } = await h.start()
    const gated = await h.runtime.execute(run.id)
    assert.equal(gated.status, 'awaiting_human')
    assert.equal(gated.reviewCycles, 1)
    assert.equal(gated.pendingGate?.reviewedDraft?.sha256, digest(gated.draftMarkdown ?? ''), 'the gate describes the draft it shows')
    assert.equal(gated.pendingGate?.accepted, false)

    const refined = await h.runtime.decide(run.id, { refine: true })
    const reviewers = h.prompts.filter(({ role }) => role === 'reviewer')
    assert.equal(reviewers.length, 4, 'the refine pass reviews the stored draft and then the revision')

    assert.equal(refined.reviewCycles, 2)
    assert.equal(refined.pendingGate?.reviewedDraft?.sha256, digest(refined.draftMarkdown ?? ''), 'the gate describes the revised draft')
    assert.notEqual(refined.draftMarkdown, gated.draftMarkdown, 'the refine pass actually revised the document')
    assert.notEqual(refined.pendingGate?.reviewedDraft?.sha256, gated.pendingGate?.reviewedDraft?.sha256)
    assert.equal(refined.pendingGate?.accepted, true, 'acceptance comes from the review of the revised draft')
    assert.deepEqual(refined.pendingGate?.findings, [])

    const decisions = h.events().filter(({ type }) => type === 'review_decision')
    const digests = decisions.map((event) => (event.payload as { reviewedDraft: { sha256: string } }).reviewedDraft.sha256)
    assert.equal(digests.length, 4)
    assert.deepEqual(digests.slice(2, 3), [gated.pendingGate?.reviewedDraft?.sha256], 'refine re-reviews exactly the stored draft first')
    assert.equal(digests[3], refined.pendingGate?.reviewedDraft?.sha256, 'the last review judged the draft at the gate')
    assert.notEqual(digests[0], digests[1], 'the revision changed what the reviewer saw')
  } finally { rmSync(h.root, { recursive: true, force: true }) }
})

test('the revision prompt puts the findings first and forbids scope growth', () => {
  const definition = stageDefinition('requirements')!
  type RevisionArgs = Parameters<typeof definition.prompts.revision>
  const context = { input: 'brief', priorStages: [], documents: [], attachments: [], baselineEvidence: [] } as unknown as RevisionArgs[1]
  const project = { name: 'Shop' } as RevisionArgs[0]
  const findings = [{ id: 'F-001', severity: 'major', section: '3. Functional requirements', finding: 'FR-001 is ambiguous', required_change: 'name the customer' }]
  const prompt = definition.prompts.revision(project, context, 'analysis', COVERED_REQUIREMENTS, normalizeRevisionFindings(findings))

  const findingsAt = prompt.indexOf('## Reviewer findings to fix')
  const documentAt = prompt.indexOf('## Current document')
  assert.ok(findingsAt >= 0 && documentAt > findingsAt, 'findings are read before a very long document')
  assert.match(prompt, /FR-001 is ambiguous/, 'the finding text reaches the author')
  assert.match(prompt, /smallest edit/)
  assert.match(prompt, /Do NOT add requirements, NFRs, business rules, actors or sections/)
  assert.match(prompt, /Do NOT renumber or delete existing ids/)
  assert.match(prompt, /open question instead of inventing a requirement/)
  assert.match(prompt, /roughly stable/)
})

test('the reviewer prompt keeps severity steady and refuses to invent scope', () => {
  const definition = stageDefinition('requirements')!
  const context = { input: 'brief', priorStages: [], documents: [], attachments: [], baselineEvidence: [] } as unknown as Parameters<typeof definition.prompts.reviewer>[1]
  const project = { name: 'Shop' } as Parameters<typeof definition.prompts.reviewer>[0]
  const prompt = definition.prompts.reviewer(project, context, COVERED_REQUIREMENTS, SETTINGS)
  assert.match(prompt, /At most 12 findings/)
  assert.match(prompt, /Do not ask for functionality the brief and baseline do not require/)
  assert.match(prompt, /scores 85 or more/)
  assert.match(prompt, /applied the same way on every pass/)
})
