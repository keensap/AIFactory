import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshHarness } from '../src/harness.ts'
import { PostgresProjectStore } from '../src/projects.ts'
import { createChatServer, serverPort } from '../src/server.ts'
import { SettingsService } from '../src/settings.ts'
import { PostgresStageSettingsStore, StageSettingsError, StageSettingsService } from '../src/stage-settings.ts'
import { SessionStore } from '../src/store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const url = process.env.AIFACTORY_TEST_DATABASE_URL
const skip = url === undefined || url === '' ? 'AIFACTORY_TEST_DATABASE_URL is not set' : false

async function setup() {
  const projectStore = new PostgresProjectStore(url!)
  await projectStore.migrate()
  const service = new StageSettingsService(new PostgresStageSettingsStore(url!))
  await service.migrate()
  const root = mkdtempSync(join(tmpdir(), 'aifactory-stage-settings-'))
  const project = await projectStore.create({ name: `Settings ${Date.now()}`, rootPath: root, organization: null, ownerEmail: null, status: 'inactive' })
  return {
    projectStore, service, project, root,
    cleanup: async () => {
      await service.close()
      await projectStore.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('factory defaults apply until a project overrides them', { skip }, async () => {
  const t = await setup()
  try {
    const defaults = await t.service.factoryDefaults()
    assert.deepEqual(defaults.planning, { gateAfterEachReview: false, maxReviewCycles: 3, minRating: 0, maxBlockers: 0, maxMajor: 0 })
    assert.deepEqual(defaults.design, {}, 'stages without a runtime have no settings yet')
    assert.deepEqual(Object.keys(defaults).sort(), ['architecture', 'deployment', 'design', 'development', 'maintenance', 'planning', 'requirements', 'testing'])

    const updated = await t.service.updateFactoryDefaults('planning', { maxReviewCycles: 5 })
    assert.deepEqual(updated, { gateAfterEachReview: false, maxReviewCycles: 5, minRating: 0, maxBlockers: 0, maxMajor: 0 })
    const fromFactory = await t.service.resolve(t.project.id, 'planning')
    assert.equal(fromFactory.source, 'factory')
    assert.equal(fromFactory.settings.maxReviewCycles, 5)

    const overridden = await t.service.setProject(t.project.id, 'planning', { gateAfterEachReview: true })
    assert.equal(overridden.settings.gateAfterEachReview, true)
    assert.equal(overridden.source, 'project')
    assert.equal(overridden.settings.maxReviewCycles, 5, 'unspecified fields keep the Factory value')

    // Clearing the override falls back to the Factory default again.
    const cleared = await t.service.setProject(t.project.id, 'planning', null)
    assert.equal(cleared.source, 'factory')
    assert.equal(cleared.settings.gateAfterEachReview, false)
    await t.service.updateFactoryDefaults('planning', { gateAfterEachReview: false, maxReviewCycles: 3 })
  } finally {
    await t.cleanup()
  }
})

test('the acceptance criteria round-trip through Factory and project settings', { skip }, async () => {
  const t = await setup()
  try {
    const updated = await t.service.updateFactoryDefaults('planning', { minRating: 95, maxBlockers: 0, maxMajor: 1 })
    assert.deepEqual(updated, { gateAfterEachReview: false, maxReviewCycles: 3, minRating: 95, maxBlockers: 0, maxMajor: 1 })

    const project = await t.service.setProject(t.project.id, 'planning', { minRating: 90, maxMajor: 2 })
    assert.deepEqual(project.settings, { gateAfterEachReview: false, maxReviewCycles: 3, minRating: 90, maxBlockers: 0, maxMajor: 2 })
    assert.equal(project.source, 'project')

    await t.service.updateFactoryDefaults('planning', { minRating: 0, maxBlockers: 0, maxMajor: 0 })
  } finally {
    await t.cleanup()
  }
})

test('settings are validated', { skip }, async () => {
  const t = await setup()
  try {
    const expect = (code: string, fn: () => Promise<unknown>) => assert.rejects(fn, (error: unknown) => error instanceof StageSettingsError && error.code === code)
    await expect('INVALID_BODY', () => t.service.updateFactoryDefaults('planning', []))
    await expect('NO_FIELDS', () => t.service.updateFactoryDefaults('planning', {}))
    await expect('INVALID_GATE_SETTING', () => t.service.updateFactoryDefaults('planning', { gateAfterEachReview: 'yes' }))
    await expect('INVALID_REVIEW_CYCLES', () => t.service.updateFactoryDefaults('planning', { maxReviewCycles: 0 }))
    await expect('INVALID_REVIEW_CYCLES', () => t.service.updateFactoryDefaults('planning', { maxReviewCycles: 11 }))
    await expect('INVALID_REVIEW_CYCLES', () => t.service.updateFactoryDefaults('planning', { maxReviewCycles: 2.5 }))
    await expect('NO_FIELDS', () => t.service.setProject(t.project.id, 'planning', {}))
    await expect('INVALID_MIN_RATING', () => t.service.updateFactoryDefaults('planning', { minRating: -1 }))
    await expect('INVALID_MIN_RATING', () => t.service.updateFactoryDefaults('planning', { minRating: 101 }))
    await expect('INVALID_MIN_RATING', () => t.service.updateFactoryDefaults('planning', { minRating: 95.5 }))
    await expect('INVALID_MAX_BLOCKERS', () => t.service.updateFactoryDefaults('planning', { maxBlockers: -1 }))
    await expect('INVALID_MAX_BLOCKERS', () => t.service.updateFactoryDefaults('planning', { maxBlockers: 21 }))
    await expect('INVALID_MAX_MAJOR', () => t.service.updateFactoryDefaults('planning', { maxMajor: -1 }))
    await expect('INVALID_MAX_MAJOR', () => t.service.updateFactoryDefaults('planning', { maxMajor: 51 }))
    await expect('STAGE_SETTINGS_NOT_IMPLEMENTED', () => t.service.updateFactoryDefaults('design', { anything: true }))
    await expect('STAGE_SETTINGS_NOT_IMPLEMENTED', () => t.service.setProject(t.project.id, 'design', { anything: true }))
    await expect('INVALID_STAGE', () => t.service.updateFactoryDefaults('nonsense', { x: 1 }))
  } finally {
    await t.cleanup()
  }
})

test('corrupt stored defaults fall back instead of breaking every run', { skip }, async () => {
  const t = await setup()
  try {
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: url!, max: 1 })
    try {
      await pool.query(`INSERT INTO settings (key, value) VALUES ('stage_defaults', '"not an object"'::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`)
      assert.deepEqual((await t.service.factoryDefaults()).planning, {
        gateAfterEachReview: false, maxReviewCycles: 3, minRating: 0, maxBlockers: 0, maxMajor: 0,
      })
    } finally {
      await pool.end()
    }
  } finally {
    await t.cleanup()
  }
})

// ---- HTTP surface ------------------------------------------------------

async function withApi(run: (context: { base: string; projectId: string }) => Promise<void>): Promise<void> {
  const t = await setup()
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-settings-api-'))
  const projects = new (await import('../src/projects.ts')).ProjectService(t.projectStore, new SettingsService(new MemorySettingsStore()))
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    projects,
    stageSettings: t.service,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    await run({ base: `http://127.0.0.1:${serverPort(server)}`, projectId: t.project.id })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
    await t.cleanup()
  }
}

const json = (body: unknown): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('factory defaults are read and updated over HTTP', { skip }, async () => {
  await withApi(async ({ base }) => {
    const initial = await (await fetch(`${base}/api/settings/stage-defaults`)).json() as { stageDefaults: { gateAfterEachReview: boolean; maxReviewCycles: number } }
    assert.equal(initial.stageDefaults.gateAfterEachReview, false)
    assert.equal(initial.stageDefaults.maxReviewCycles, 3)

    const patched = await fetch(`${base}/api/settings/stage-defaults`, { method: 'POST', ...json({ gateAfterEachReview: true }) })
    assert.equal(patched.status, 200)
    assert.equal(((await patched.json()) as { stageDefaults: { gateAfterEachReview: boolean } }).stageDefaults.gateAfterEachReview, true, 'POST behaves like PATCH')

    const invalid = await fetch(`${base}/api/settings/stage-defaults`, { method: 'PATCH', ...json({ maxReviewCycles: 99 }) })
    assert.equal(invalid.status, 400)
    assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, 'INVALID_REVIEW_CYCLES')

    await fetch(`${base}/api/settings/stage-defaults`, { method: 'PATCH', ...json({ gateAfterEachReview: false }) })
  })
})

test('a project override is set, read and cleared over HTTP', { skip }, async () => {
  await withApi(async ({ base, projectId }) => {
    const path = `${base}/api/projects/${projectId}/stages/planning/settings`
    const initial = await (await fetch(path)).json() as { stage: string; settings: Record<string, unknown>; source: string }
    assert.equal(initial.stage, 'planning')
    assert.ok(['factory', 'defaults'].includes(initial.source), initial.source)
    assert.equal(initial.settings.maxReviewCycles, 3)

    const patched = await fetch(path, { method: 'POST', ...json({ gateAfterEachReview: true, maxReviewCycles: 2 }) })
    assert.equal(patched.status, 200)
    const patchedBody = await patched.json() as { settings: { gateAfterEachReview: boolean; maxReviewCycles: number }; source: string }
    assert.equal(patchedBody.source, 'project')
    assert.equal(patchedBody.settings.gateAfterEachReview, true)
    assert.equal(patchedBody.settings.maxReviewCycles, 2)

    const cleared = await fetch(path, { method: 'DELETE' })
    assert.equal(cleared.status, 200)
    assert.notEqual(((await cleared.json()) as { source: string }).source, 'project')

    const otherStage = await fetch(`${base}/api/projects/${projectId}/stages/design/settings`)
    assert.equal(otherStage.status, 200)
    assert.deepEqual(((await otherStage.json()) as { settings: unknown }).settings, {}, 'a stage without a runtime has no settings yet')

    const invalid = await fetch(path, { method: 'PATCH', ...json({ gateAfterEachReview: 1 }) })
    assert.equal(invalid.status, 400)
  })
})

test('per-stage Factory defaults are listed and edited one stage at a time', { skip }, async () => {
  await withApi(async ({ base }) => {
    const all = await (await fetch(`${base}/api/settings/stages`)).json() as { stages: Record<string, Record<string, unknown>> }
    assert.equal(all.stages.planning.maxReviewCycles, 3)
    assert.deepEqual(all.stages.design, {})

    const design = await (await fetch(`${base}/api/settings/stages/design`)).json() as { settings: unknown }
    assert.deepEqual(design.settings, {})

    const planning = await fetch(`${base}/api/settings/stages/planning`, { method: 'PATCH', ...json({ minRating: 90 }) })
    assert.equal(planning.status, 200)
    assert.equal(((await planning.json()) as { settings: { minRating: number } }).settings.minRating, 90)

    const designPatch = await fetch(`${base}/api/settings/stages/design`, { method: 'PATCH', ...json({ anything: 1 }) })
    assert.equal(designPatch.status, 501)
    assert.equal(((await designPatch.json()) as { error: { code: string } }).error.code, 'STAGE_SETTINGS_NOT_IMPLEMENTED')

    const unknown = await fetch(`${base}/api/settings/stages/nonsense`)
    assert.equal(unknown.status, 400)

    await fetch(`${base}/api/settings/stages/planning`, { method: 'PATCH', ...json({ minRating: 0 }) })
    await fetch(`${base}/api/settings/stage-defaults`, { method: 'PATCH', ...json({ minRating: 0, gateAfterEachReview: false, maxReviewCycles: 3 }) })
  })
})
