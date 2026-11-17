import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DshHarness } from '../src/harness.ts'
import { ProjectService } from '../src/projects.ts'
import { createChatServer, serverPort, type ChatApiOptions } from '../src/server.ts'
import { SettingsService } from '../src/settings.ts'
import { SessionStore } from '../src/store.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Minimal stage-settings service: these tests only care about authorisation. */
function settingsStub(): import('../src/stage-settings.ts').StageSettingsService {
  let planning = { gateAfterEachReview: false, maxReviewCycles: 3, minRating: 0, maxBlockers: 0, maxMajor: 0 }
  const stub = {
    async migrate() {},
    async factoryDefaults() { return { planning } },
    async factoryDefaultFor() { return planning },
    async updateFactoryDefaults(_stage: string, input: unknown) {
      planning = { ...planning, ...(input as Record<string, number>) }
      return planning
    },
    async resolve() { return { stage: 'planning', settings: planning, source: 'factory' } },
    async setProject() { return { stage: 'planning', settings: planning, source: 'project' } },
    async planning() { return planning },
    async close() {},
  }
  return stub as unknown as import('../src/stage-settings.ts').StageSettingsService
}

async function withServer(
  options: Partial<ChatApiOptions>,
  fn: (base: string, projects: ProjectService) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-auth-'))
  const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    projects,
    stageSettings: settingsStub(),
    ...options,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    await fn(`http://127.0.0.1:${serverPort(server)}`, projects)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  }
}

const makeProject = async (projects: ProjectService): Promise<string> => {
  const created = await projects.create({
    name: 'Auth', rootPath: mkdtempSync(join(tmpdir(), 'aifactory-auth-root-')),
    organization: null, ownerEmail: null, status: 'inactive',
  })
  return created.id
}

// ---- AR-01: settings writes are admin-only ---------------------------

test('a settings write needs the admin token when one is configured', async () => {
  await withServer({ apiToken: 'operator-token', adminToken: 'admin-token' }, async (base, projects) => {
    const operator = { Authorization: 'Bearer operator-token', 'Content-Type': 'application/json' }
    const admin = { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' }

    // Reads are fine for the operator.
    assert.equal((await fetch(`${base}/api/settings/stages`, { headers: operator })).status, 200)

    const asOperator = await fetch(`${base}/api/settings/stages/planning`, {
      method: 'PATCH', headers: operator, body: JSON.stringify({ maxReviewCycles: 4 }),
    })
    assert.equal(asOperator.status, 403)
    assert.equal(((await asOperator.json()) as { error: { code: string } }).error.code, 'ADMIN_FORBIDDEN')

    const asAdmin = await fetch(`${base}/api/settings/stages/planning`, {
      method: 'PATCH', headers: admin, body: JSON.stringify({ maxReviewCycles: 4 }),
    })
    assert.equal(asAdmin.status, 200)

    // The deprecated planning alias is guarded too.
    const alias = await fetch(`${base}/api/settings/stage-defaults`, {
      method: 'PATCH', headers: operator, body: JSON.stringify({ maxReviewCycles: 2 }),
    })
    assert.equal(alias.status, 403)

    // Project overrides and clearing them are admin-only.
    const id = await makeProject(projects)
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const response = await fetch(`${base}/api/projects/${id}/stages/planning/settings`, {
        method,
        headers: operator,
        ...(method === 'DELETE' ? {} : { body: JSON.stringify({ minRating: 90 }) }),
      })
      assert.equal(response.status, 403, `${method} must be admin-only`)
    }
    const allowed = await fetch(`${base}/api/projects/${id}/stages/planning/settings`, {
      method: 'POST', headers: admin, body: JSON.stringify({ minRating: 90 }),
    })
    assert.equal(allowed.status, 200)
  })
})

test('without an admin token the operator token stays admin (backwards compatible)', async () => {
  await withServer({ apiToken: 'only-token' }, async (base) => {
    const headers = { Authorization: 'Bearer only-token', 'Content-Type': 'application/json' }
    const response = await fetch(`${base}/api/settings/stages/planning`, {
      method: 'PATCH', headers, body: JSON.stringify({ maxReviewCycles: 5 }),
    })
    assert.equal(response.status, 200)
  })
})

test('an admin token alone still requires that exact token', async () => {
  await withServer({ apiToken: 'operator-token', adminToken: 'admin-token' }, async (base) => {
    // With a token configured, an anonymous request is unauthenticated (401),
    // even from loopback; it never reaches the admin check.
    const anonymous = await fetch(`${base}/api/settings/stages/planning`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxReviewCycles: 4 }),
    })
    assert.equal(anonymous.status, 401)

    // A near-miss secret is unauthenticated rather than unauthorised: it never
    // reaches the admin check, so the response does not confirm the admin token exists.
    const wrong = await fetch(`${base}/api/settings/stages/planning`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer admin-tokeX', 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxReviewCycles: 4 }),
    })
    assert.equal(wrong.status, 401)

    // An authenticated operator that is not the admin gets 403.
    const operator = await fetch(`${base}/api/settings/stages/planning`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer operator-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxReviewCycles: 4 }),
    })
    assert.equal(operator.status, 403)
  })
})

test('a wrong bearer token is refused for ordinary requests too', async () => {
  await withServer({ apiToken: 'operator-token' }, async (base) => {
    const response = await fetch(`${base}/api/projects`, { headers: { Authorization: 'Bearer nope' } })
    assert.equal(response.status, 401)
    const shorter = await fetch(`${base}/api/projects`, { headers: { Authorization: 'Bearer operator-toke' } })
    assert.equal(shorter.status, 401, 'a prefix is not enough')
  })
})

// ---- AR-01: the inventory guard --------------------------------------

test('every settings write is guarded by requireAdmin', () => {
  // The guard has to survive refactors, so this reads the source and checks the
  // handlers themselves rather than relying on a single call site's shape.
  const source = readFileSync(join(ROOT, 'src/server.ts'), 'utf8')

  /** The handler block that contains `marker`, up to the next top-level guard. */
  const blockAround = (marker: string): string => {
    const index = source.indexOf(marker)
    assert.ok(index >= 0, `source is missing ${marker}`)
    const before = source.lastIndexOf('\n  if (', index)
    const after = source.indexOf('\n  }\n', index)
    return source.slice(before === -1 ? 0 : before, after === -1 ? source.length : after)
  }

  const settingsWrites: Array<[string, string]> = [
    ['factory defaults (stage)', 'stageSettings.updateFactoryDefaults(stage, await readJson(request))'],
    ['factory defaults (planning alias)', "stageSettings.updateFactoryDefaults('planning', await readJson(request))"],
    ['project override set', 'stageSettings.setProject(id, stage, await readJson(request))'],
    ['project override clear', 'stageSettings.setProject(id, stage, null)'],
  ]
  for (const [label, marker] of settingsWrites) {
    const block = blockAround(marker)
    assert.match(block, /requireAdmin\(request, options\)/, `${label} write must call requireAdmin`)
  }

  // Agent and waiver writes keep their guards too.
  for (const marker of [
    'await agents.create(await readJson(request))',
    'await agents.update(agentId, await readJson(request))',
    'await agents.remove(agentId)',
    'prerequisites.waive({',
    'prerequisites.unwaive(',
    'options.probeAgent(',
  ]) {
    assert.match(blockAround(marker), /requireAdmin\(request, options\)/, `${marker} must call requireAdmin`)
  }

  // And the guard is not a no-op: it rejects a non-admin credential.
  assert.match(source, /ADMIN_FORBIDDEN/)
})
