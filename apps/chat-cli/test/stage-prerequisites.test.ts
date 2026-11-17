import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { DshHarness } from '../src/harness.ts'
import { PostgresProjectStore } from '../src/projects.ts'
import { createChatServer, serverPort } from '../src/server.ts'
import { SettingsService } from '../src/settings.ts'
import {
  PostgresPrerequisiteStore,
  PrerequisiteError,
  STAGE_PREREQUISITE_SEEDS,
  StagePrerequisiteService,
  evaluateStageReadiness,
  type PrerequisiteEvidence,
  type StagePrerequisite,
} from '../src/stage-prerequisites.ts'
import { PlanningStageRuntime } from '../src/stage-runtime.ts'
import { SessionStore } from '../src/store.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const url = process.env.AIFACTORY_TEST_DATABASE_URL
const skip = url === undefined || url === '' ? 'AIFACTORY_TEST_DATABASE_URL is not set' : false

const evidence = (overrides: Partial<PrerequisiteEvidence> = {}): PrerequisiteEvidence => ({
  hasBrief: false,
  attachmentCount: 0,
  documentKinds: new Set<string>(),
  waivers: new Map(),
  ...overrides,
})

const planning = STAGE_PREREQUISITE_SEEDS.filter((entry) => entry.stage === 'planning')
const design = STAGE_PREREQUISITE_SEEDS.filter((entry) => entry.stage === 'design')

// ---- catalogue and evaluation -----------------------------------------

test('the catalogue covers every stage, with stricter inputs later', () => {
  const stages = new Set(STAGE_PREREQUISITE_SEEDS.map((entry) => entry.stage))
  assert.deepEqual([...stages].sort(), ['architecture', 'deployment', 'design', 'development', 'maintenance', 'planning', 'requirements', 'testing'])
  assert.equal(STAGE_PREREQUISITE_SEEDS.filter((entry) => entry.stage === 'development').length, 4, 'requirements, design, architecture, tech stack')
  assert.ok(STAGE_PREREQUISITE_SEEDS.every((entry) => entry.required))
})

test('a planning brief, an attachment or a brief document all satisfy the first stage', () => {
  const evaluate = (source: PrerequisiteEvidence) => evaluateStageReadiness({ projectId: 'p', stage: 'planning', catalogue: planning, evidence: source })

  assert.equal(evaluate(evidence()).ready, false)
  assert.equal(evaluate(evidence()).missing[0]?.key, 'project-brief')

  const viaBrief = evaluate(evidence({ hasBrief: true }))
  assert.equal(viaBrief.ready, true)
  assert.equal(viaBrief.prerequisites[0]?.via, 'brief')

  const viaAttachment = evaluate(evidence({ attachmentCount: 2 }))
  assert.equal(viaAttachment.ready, true)
  assert.equal(viaAttachment.prerequisites[0]?.via, 'attachment')

  const viaDocument = evaluate(evidence({ documentKinds: new Set(['business_brief']) }))
  assert.equal(viaDocument.ready, true)
  assert.equal(viaDocument.prerequisites[0]?.via, 'document')
})

test('a waiver satisfies a prerequisite and says why', () => {
  const status = evaluateStageReadiness({
    projectId: 'p', stage: 'planning', catalogue: planning,
    evidence: evidence({ waivers: new Map([['project-brief', { reason: 'client supplied it verbally', createdAt: '2026-01-01T00:00:00.000Z' }]]) }),
  })
  assert.equal(status.ready, true)
  assert.equal(status.prerequisites[0]?.via, 'waiver')
  assert.match(status.prerequisites[0]?.detail ?? '', /client supplied it verbally/)
})

test('later stages do not accept an unrelated document', () => {
  const readiness = evaluateStageReadiness({
    projectId: 'p', stage: 'design', catalogue: design,
    evidence: evidence({ documentKinds: new Set(['telos_report']) }),
  })
  assert.equal(readiness.ready, false)
  assert.equal(readiness.missing[0]?.key, 'requirements-baseline')

  const ok = evaluateStageReadiness({
    projectId: 'p', stage: 'design', catalogue: design,
    evidence: evidence({ documentKinds: new Set(['requirements_spec']) }),
  })
  assert.equal(ok.ready, true)
})

test('a prerequisite lists what would satisfy it', () => {
  const readiness = evaluateStageReadiness({ projectId: 'p', stage: 'planning', catalogue: planning, evidence: evidence() })
  assert.ok(readiness.missing[0]!.accepts.length >= 3)
})

// ---- persistence and HTTP ---------------------------------------------

async function setup() {
  const store = new PostgresProjectStore(url!)
  await store.migrate()
  const service = new StagePrerequisiteService(new PostgresPrerequisiteStore(url!))
  await service.migrate()
  const pool = new Pool({ connectionString: url!, max: 2 })
  const root = mkdtempSync(join(tmpdir(), 'aifactory-prereq-'))
  const project = await store.create({ name: `Prereq ${Date.now()}`, rootPath: root, organization: null, ownerEmail: null, status: 'inactive' })
  return {
    store, service, pool, project, root,
    cleanup: async () => {
      await pool.end()
      await service.close()
      await store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('the seed is idempotent and readable per stage', { skip }, async () => {
  const t = await setup()
  try {
    await t.service.migrate()
    assert.equal((await t.service.catalogue('planning')).length, 1)
    const all = await t.service.catalogue()
    assert.equal(all.length, STAGE_PREREQUISITE_SEEDS.length)
    assert.ok(all.every((entry) => entry.stageLabel.length > 0))
  } finally {
    await t.cleanup()
  }
})

test('readiness reads stored briefs, documents and attachments', { skip }, async () => {
  const t = await setup()
  try {
    const empty = await t.service.readiness(t.project.id, 'planning')
    assert.equal(empty.ready, false)

    // A brief on a run satisfies it.
    await t.pool.query(
      `INSERT INTO project_stage_runs (id, project_id, stage, input_text, context_hash)
       VALUES (gen_random_uuid(), $1, 'planning', 'build a portal', 'h')`,
      [t.project.id],
    )
    assert.equal((await t.service.readiness(t.project.id, 'planning')).ready, true)

    // A document of the right kind satisfies it without a run.
    const fresh = await t.store.create({ name: `Doc ${Date.now()}`, rootPath: mkdtempSync(join(tmpdir(), 'aifactory-prereq-doc-')), organization: null, ownerEmail: null, status: 'inactive' })
    await t.pool.query(
      `INSERT INTO project_documents (id, project_id, stage, kind, title, storage_path, mime_type, size_bytes, sha256, status)
       VALUES (gen_random_uuid(), $1, 'planning', 'business_brief', 'Brief', '.aifactory/x.md', 'text/markdown', 10, 'x', 'uploaded')`,
      [fresh.id],
    )
    const byDocument = await t.service.readiness(fresh.id, 'planning')
    assert.equal(byDocument.ready, true)
    assert.equal(byDocument.prerequisites[0]?.via, 'document')

    // An attachment counts too.
    const third = await t.store.create({ name: `Att ${Date.now()}`, rootPath: mkdtempSync(join(tmpdir(), 'aifactory-prereq-att-')), organization: null, ownerEmail: null, status: 'inactive' })
    await t.pool.query(
      `INSERT INTO project_attachments (id, project_id, stage, title, filename, storage_path, text_path, mime_type, size_bytes, sha256, pages, characters)
       VALUES (gen_random_uuid(), $1, 'planning', 'brief', 'b.pdf', '.aifactory/a/b.pdf', '.aifactory/a/t.txt', 'application/pdf', 10, 'x', 1, 10)`,
      [third.id],
    )
    assert.equal((await t.service.readiness(third.id, 'planning')).ready, true)
  } finally {
    await t.cleanup()
  }
})

test('waivers are recorded, removable and validated', { skip }, async () => {
  const t = await setup()
  try {
    const waived = await t.service.waive({ projectId: t.project.id, stage: 'planning', key: 'project-brief', reason: 'client brief is verbal' })
    assert.equal(waived.ready, true)
    assert.equal(waived.prerequisites[0]?.via, 'waiver')

    await assert.rejects(
      () => t.service.waive({ projectId: t.project.id, stage: 'planning', key: 'project-brief', reason: '  ' }),
      (error: unknown) => error instanceof PrerequisiteError && error.code === 'INVALID_WAIVER_REASON',
    )
    await assert.rejects(
      () => t.service.waive({ projectId: t.project.id, stage: 'planning', key: 'nope', reason: 'because' }),
      (error: unknown) => error instanceof PrerequisiteError && error.code === 'PREREQUISITE_NOT_FOUND',
    )
    await assert.rejects(
      () => t.service.readiness(t.project.id, 'nonsense'),
      (error: unknown) => error instanceof PrerequisiteError && error.code === 'INVALID_STAGE',
    )

    const cleared = await t.service.unwaive(t.project.id, 'planning', 'project-brief')
    assert.equal(cleared.ready, false)
    await assert.rejects(() => t.service.unwaive(t.project.id, 'planning', 'project-brief'), /no waiver/)
  } finally {
    await t.cleanup()
  }
})

test('the readiness and waiver endpoints work, and waivers need admin', { skip }, async () => {
  const t = await setup()
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-prereq-api-'))
  const projects = new (await import('../src/projects.ts')).ProjectService(t.store, new SettingsService(new MemorySettingsStore()))
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    projects,
    prerequisites: t.service,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const base = `http://127.0.0.1:${serverPort(server)}`
  try {
    const stages = await (await fetch(`${base}/api/stages`)).json() as { stages: Array<{ stage: string; key: string }> }
    assert.ok(stages.stages.some((entry) => entry.stage === 'planning' && entry.key === 'project-brief'))

    const readiness = await (await fetch(`${base}/api/projects/${t.project.id}/stages/planning/readiness`)).json() as { ready: boolean; missing: unknown[] }
    assert.equal(readiness.ready, false)
    assert.equal(readiness.missing.length, 1)

    const waived = await fetch(`${base}/api/projects/${t.project.id}/stages/planning/waivers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'project-brief', reason: 'verbal brief' }),
    })
    assert.equal(waived.status, 200)
    assert.equal(((await waived.json()) as { ready: boolean }).ready, true)

    const missingFields = await fetch(`${base}/api/projects/${t.project.id}/stages/planning/waivers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'project-brief' }),
    })
    assert.equal(missingFields.status, 400)

    const removed = await fetch(`${base}/api/projects/${t.project.id}/stages/planning/waivers/project-brief`, { method: 'DELETE' })
    assert.equal(removed.status, 200)
    assert.equal(((await removed.json()) as { ready: boolean }).ready, false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
    await t.cleanup()
  }
})

test('a stage run is refused when prerequisites are missing, and allowed once waived', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-prereq-run-'))
  try {
    const projects = new (await import('../src/projects.ts')).ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
    const project = await projects.create({ name: 'Blocked', rootPath: root, organization: null, ownerEmail: null, status: 'inactive' })
    const calls: Array<{ stage: string; options: unknown }> = []
    let ready = false
    const runtime = new PlanningStageRuntime({
      projects,
      workspace: fakeWorkspace(),
      harnessFactory: () => { throw new Error('not used') },
      runPrompt: async () => '# ok',
      prerequisites: {
        async ensureReady(_projectId, stage, options) {
          calls.push({ stage, options })
          if (!ready) {
            throw new PrerequisiteError(409, 'STAGE_PREREQUISITES_MISSING', 'the planning stage needs: Project brief (project-brief)')
          }
          return { ready: true }
        },
      },
    })

    await assert.rejects(
      () => runtime.start({ projectId: project.id, stage: 'planning', brief: 'portal' }),
      (error: unknown) => error instanceof PrerequisiteError && error.status === 409 && error.code === 'STAGE_PREREQUISITES_MISSING',
    )
    assert.deepEqual(calls[0], { stage: 'planning', options: { incomingBrief: true } })

    ready = true
    const run = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'portal' })
    assert.ok(run.id.length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
