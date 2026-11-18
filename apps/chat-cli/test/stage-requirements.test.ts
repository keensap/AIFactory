import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectService } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import { StageEngine, type StageRole } from '../src/stage-runtime.ts'
import { STAGE_DEFINITIONS, stageDefinition } from '../src/stages/index.ts'
import { STAGE_PROCESSES } from '../src/agents.ts'
import { STAGE_SETTINGS_DEFINITIONS } from '../src/stage-settings.ts'
import type { StageRunEvent } from '../src/workspace.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const SETTINGS = {
  gateAfterEachReview: false, maxReviewCycles: 2, minRating: 0, maxBlockers: 0, maxMajor: 0, gateReminderHours: 72,
}
const REVIEW_OK = '{"decision":"approved","rating":95,"findings":[]}'

function harness(definition = stageDefinition('requirements')!) {
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
      if (role === 'author') return '# Requirements Specification — Test\n\n## 3. Functional requirements\n- FR-001 The system shall X.'
      return REVIEW_OK
    },
    stageSettings: { planning: async () => SETTINGS, requirements: async () => SETTINGS },
  })

  return {
    root, runtime, workspace, projects, prompts,
    events: () => (workspace as unknown as { events: StageRunEvent[] }).events,
    start: async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'aifactory-req-project-'))
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

    const author = h.prompts.find((entry) => entry.role === 'author')!.prompt
    assert.match(author, /FR-001/, 'functional requirements are numbered')
    assert.match(author, /Acceptance criteria/)
    assert.doesNotMatch(author, /TELOS/i)

    const reviewer = h.prompts.find((entry) => entry.role === 'reviewer')!.prompt
    assert.match(reviewer, /acceptance criteria/i)
  })
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
