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
    assert.deepEqual(await t.service.factoryDefaults(), { gateAfterEachReview: false, maxReviewCycles: 3 })

    const updated = await t.service.updateFactoryDefaults({ maxReviewCycles: 5 })
    assert.deepEqual(updated, { gateAfterEachReview: false, maxReviewCycles: 5 })
    assert.deepEqual(await t.service.resolve(t.project.id), { gateAfterEachReview: false, maxReviewCycles: 5, source: 'factory' })

    const overridden = await t.service.setProject(t.project.id, { gateAfterEachReview: true })
    assert.deepEqual(overridden, { gateAfterEachReview: true, maxReviewCycles: 5, source: 'project' })
    assert.deepEqual(await t.service.resolve(t.project.id), { gateAfterEachReview: true, maxReviewCycles: 5, source: 'project' })

    // Clearing the override falls back to the Factory default again.
    const cleared = await t.service.setProject(t.project.id, null)
    assert.deepEqual(cleared, { gateAfterEachReview: false, maxReviewCycles: 5, source: 'factory' })
    await t.service.updateFactoryDefaults({ gateAfterEachReview: false, maxReviewCycles: 3 })
  } finally {
    await t.cleanup()
  }
})

test('settings are validated', { skip }, async () => {
  const t = await setup()
  try {
    const expect = (code: string, fn: () => Promise<unknown>) => assert.rejects(fn, (error: unknown) => error instanceof StageSettingsError && error.code === code)
    await expect('INVALID_BODY', () => t.service.updateFactoryDefaults([]))
    await expect('NO_FIELDS', () => t.service.updateFactoryDefaults({}))
    await expect('INVALID_GATE_SETTING', () => t.service.updateFactoryDefaults({ gateAfterEachReview: 'yes' }))
    await expect('INVALID_REVIEW_CYCLES', () => t.service.updateFactoryDefaults({ maxReviewCycles: 0 }))
    await expect('INVALID_REVIEW_CYCLES', () => t.service.updateFactoryDefaults({ maxReviewCycles: 11 }))
    await expect('INVALID_REVIEW_CYCLES', () => t.service.updateFactoryDefaults({ maxReviewCycles: 2.5 }))
    await expect('NO_FIELDS', () => t.service.setProject(t.project.id, {}))
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
      assert.deepEqual(await t.service.factoryDefaults(), { gateAfterEachReview: false, maxReviewCycles: 3 })
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
    assert.deepEqual(initial.stageDefaults, { gateAfterEachReview: false, maxReviewCycles: 3 })

    const patched = await fetch(`${base}/api/settings/stage-defaults`, { method: 'PATCH', ...json({ gateAfterEachReview: true }) })
    assert.equal(patched.status, 200)
    assert.deepEqual(((await patched.json()) as { stageDefaults: unknown }).stageDefaults, { gateAfterEachReview: true, maxReviewCycles: 3 })

    const invalid = await fetch(`${base}/api/settings/stage-defaults`, { method: 'PATCH', ...json({ maxReviewCycles: 99 }) })
    assert.equal(invalid.status, 400)
    assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, 'INVALID_REVIEW_CYCLES')

    await fetch(`${base}/api/settings/stage-defaults`, { method: 'PATCH', ...json({ gateAfterEachReview: false }) })
  })
})

test('a project override is set, read and cleared over HTTP', { skip }, async () => {
  await withApi(async ({ base, projectId }) => {
    const path = `${base}/api/projects/${projectId}/stages/planning/settings`
    const initial = await (await fetch(path)).json() as { settings: { source: string } }
    assert.equal(initial.settings.source, 'factory')

    const patched = await fetch(path, { method: 'PATCH', ...json({ gateAfterEachReview: true, maxReviewCycles: 2 }) })
    assert.equal(patched.status, 200)
    assert.deepEqual(((await patched.json()) as { settings: unknown }).settings, { gateAfterEachReview: true, maxReviewCycles: 2, source: 'project' })

    const cleared = await fetch(path, { method: 'DELETE' })
    assert.equal(cleared.status, 200)
    assert.equal(((await cleared.json()) as { settings: { source: string } }).settings.source, 'factory')

    const unknownStage = await fetch(`${base}/api/projects/${projectId}/stages/design/settings`)
    assert.equal(unknownStage.status, 501)
    const invalid = await fetch(path, { method: 'PATCH', ...json({ gateAfterEachReview: 1 }) })
    assert.equal(invalid.status, 400)
  })
})
