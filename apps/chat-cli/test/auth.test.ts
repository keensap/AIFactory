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
  let planning = { maxReviewCycles: 3, minRating: 0, maxBlockers: 0, maxMajor: 0 }
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

test('every mutating route declares a role, and admin writes are admin', async () => {
  // The route table is the source of truth now, so this reads declarations rather
  // than string-matching handlers (AR-14 completes AR-01's fourth part).
  const { routeTable, isReadOnly } = await import('../src/routes/index.ts')
  assert.ok(routeTable.length > 40, `expected a populated route table, got ${routeTable.length}`)

  const undeclared = routeTable.filter((entry) => !['public', 'operator', 'admin'].includes(entry.auth))
  assert.deepEqual(undeclared, [], 'every route states who may call it')

  // A public route must be deliberate: docs, the API index, a probe target.
  const publicRoutes = routeTable.filter((entry) => entry.auth === 'public').map((entry) => `${entry.method} ${entry.pattern}`)
  assert.deepEqual(publicRoutes.sort(), [
    'GET /',
    'GET /api',
    'GET /api/health',
    'GET /docs',
    'GET /docs/',
    'GET /openapi.yaml',
  ].sort(), 'only the documented public routes are unauthenticated')

  // Reconfiguration is admin-only. This is the list that must not silently gain a
  // member with a weaker role.
  const mustBeAdmin = [
    'POST /api/agents',
    'PATCH /api/agents/:agentId',
    'DELETE /api/agents/:agentId',
    'POST /api/agents/:agentId/test',
    'PUT /api/stages/:stage/assignments/:process',
    'DELETE /api/stages/:stage/assignments/:process',
    'PATCH /api/settings',
    'PATCH /api/settings/models',
    'DELETE /api/settings/models',
    'PATCH /api/settings/logging',
    'PATCH /api/settings/stages/:stage',
    'POST /api/settings/stages/:stage',
    'PATCH /api/settings/stage-defaults',
    'POST /api/stages/:stage/assignments/:process',
    'PATCH /api/projects/:id/stages/:stage/settings',
    'POST /api/projects/:id/stages/:stage/settings',
    'DELETE /api/projects/:id/stages/:stage/settings',
    'POST /api/projects/:id/stages/:stage/waivers',
    'DELETE /api/projects/:id/stages/:stage/waivers/:key',
    'POST /api/stage-runs/:runId/retry',
    'PUT /api/admin/logging/level',
  ]
  for (const key of mustBeAdmin) {
    const entry = routeTable.find((candidate) => `${candidate.method} ${candidate.pattern}` === key)
    assert.ok(entry !== undefined, `route ${key} is missing from the table`)
    assert.equal(entry.auth, 'admin', `${key} must be admin-only`)
  }

  // No route may be both read-only and declared as a write, and every route has a
  // unique method+pattern (compileRoutes enforces it, this states why).
  const seen = new Set<string>()
  for (const entry of routeTable) {
    const key = `${entry.method} ${entry.pattern}`
    assert.equal(seen.has(key), false, `duplicate route ${key}`)
    seen.add(key)
    assert.ok(isReadOnly(entry.method) || entry.auth !== 'public', `${key}: a write cannot be public`)
  }
})

test('every served route is documented, and every documented path is served', async () => {
  const { routeTable } = await import('../src/routes/index.ts')
  const { readFileSync } = await import('node:fs')
  // `js-yaml` is not a dependency of this package; load it through a tiny wrapper
  // so the type annotation stays local instead of naming an absolute path.
  type YamlModule = { load: (text: string) => unknown }
  const jsYaml = await import('/fs22/deepseek-harness/node_modules/js-yaml/index.js' as string) as YamlModule
  const load = jsYaml.load
  const spec = load(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>
  }

  /** `/api/agents/{agentId}` → `/api/agents/:agentId`, so the two can be compared. */
  const normalise = (path: string): string => path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1')

  const documented = new Set<string>()
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const method of Object.keys(operations)) {
      if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) {
        documented.add(`${method.toUpperCase()} ${normalise(path)}`)
      }
    }
  }
  const served = new Set(routeTable.map((entry) => `${entry.method} ${entry.pattern}`))

  // The API index and the docs assets are not part of the machine contract.
  const notInSpec = new Set(['GET /', 'GET /docs', 'GET /docs/', 'GET /api'])

  const servedNotDocumented = [...served].filter((key) => !documented.has(key) && !notInSpec.has(key)).sort()
  const documentedNotServed = [...documented].filter((key) => !served.has(key)).sort()

  assert.deepEqual(servedNotDocumented, [], 'these routes are served but missing from openapi.yaml')
  assert.deepEqual(documentedNotServed, [], 'openapi.yaml documents routes that are not served')
})
