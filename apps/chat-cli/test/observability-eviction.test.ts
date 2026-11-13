import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshHarness } from '../src/harness.ts'
import { PhoenixObservabilityProvider, PhoenixTelemetry } from '../src/observability/phoenix/index.ts'
import type { PhoenixConfig } from '../src/observability/phoenix/index.ts'
import { createChatServer, serverPort } from '../src/server.ts'
import { SessionStore } from '../src/store.ts'

function config(overrides: Partial<PhoenixConfig> = {}): PhoenixConfig {
  return {
    baseUrl: 'http://127.0.0.1:6006',
    otlpEndpoint: 'http://127.0.0.1:1',
    projectPrefix: 'aifactory-',
    serviceName: 'aifactory',
    environment: 'test',
    captureContent: false,
    captureMaxChars: 100,
    retentionHours: 24,
    enabled: true,
    otlpTimeoutMs: 100,
    shutdownTimeoutMs: 200,
    ...overrides,
  }
}

const project = (id: string) => ({ id, name: `Project ${id}` }) as never
const run = (id: string) => ({ id, stage: 'planning', attempt: 1, contextHash: null, lockedBy: null, status: 'running' }) as never

test('the per-project provider count is capped', async () => {
  const telemetry = new PhoenixTelemetry(config({ maxProjectProviders: 3 }))
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    const span = telemetry.startRun(project(id), run(`r-${id}`))
    span?.end()
  }
  assert.ok(telemetry.projectCount <= 3, `expected at most 3 providers, got ${telemetry.projectCount}`)
  assert.ok(telemetry.evicted >= 2, 'evictions are counted')
  await telemetry.shutdown()
})

test('forgetProject releases one project and is idempotent', async () => {
  const telemetry = new PhoenixTelemetry(config())
  telemetry.startRun(project('a'), run('r1'))
  telemetry.startRun(project('b'), run('r2'))
  assert.equal(telemetry.projectCount, 2)
  await telemetry.forgetProject('a')
  assert.equal(telemetry.projectCount, 1)
  await telemetry.forgetProject('a')
  assert.equal(telemetry.projectCount, 1)
  await telemetry.shutdown()
  assert.equal(telemetry.projectCount, 0)
})

test('the provider health reports counts and never throws while the endpoint is dead', async () => {
  const provider = new PhoenixObservabilityProvider(config({ maxProjectProviders: 2 }))
  provider.recorder.startRun({ projectId: 'p1', projectName: 'One', runId: 'r1', stage: 'planning', attempt: 1, status: 'running' })
  provider.recorder.startRun({ projectId: 'p2', projectName: 'Two', runId: 'r2', stage: 'planning', attempt: 1, status: 'running' })
  const health = provider.reader.health()
  assert.equal(health.provider, 'phoenix')
  assert.equal(health.enabled, true)
  assert.ok(health.projects <= 2)
  assert.equal(typeof health.exports, 'number')
  await provider.recorder.forgetProject('p1')
  assert.ok(provider.reader.health().projects <= 1)
  await provider.shutdown()
})

test('deleting a project releases its tracer provider', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-obs-delete-'))
  const forgotten: string[] = []
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    projects: { remove: async () => {} } as never,
    observability: {
      summary: async (id: string) => ({
        available: false, reason: 'disabled', projectName: id, windowHours: 24,
        traces: 0, spans: 0, errors: 0, tools: 0, tokens: 0,
        latencyMs: { count: 0, avg: 0, p50: 0, p95: 0, max: 0 },
        roles: [], lastSpanAt: null, truncated: false,
      }),
      deleteProject: async () => {},
      health: () => ({
        provider: 'fake', enabled: true, state: 'healthy', projects: 0,
        exports: 0, failures: 0, droppedSpans: 0, lastError: null, openUntil: null,
      }),
    } as never,
    observabilityRecorder: {
      forgetProject: async (id: string) => { forgotten.push(id) },
    } as never,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const response = await fetch(`http://127.0.0.1:${serverPort(server)}/api/projects/p1`, { method: 'DELETE' })
    assert.equal(response.status, 204)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(forgotten, ['p1'])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('provider health reflects a failing REST endpoint', async () => {
  const provider = new PhoenixObservabilityProvider(config({
    baseUrl: 'http://127.0.0.1:1',
    requestTimeoutMs: 100,
  }))
  provider.recorder.startRun({ projectId: 'p1', projectName: 'One', runId: 'r1', stage: 'planning', attempt: 1, status: 'running' })
  const summary = await provider.reader.summary('p1', 24)
  assert.equal(summary.available, false)
  const health = provider.reader.health()
  assert.equal(health.state, 'degraded', `expected degraded after a failed REST read, got ${health.state}`)
  assert.ok(health.failures >= 1)
  assert.match(health.lastError ?? '', /fetch failed|ECONNREFUSED|connect/i)
  await provider.shutdown()
})

test('GET /api/admin/observability reports provider health', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-obs-admin-'))
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    observability: {
      summary: async () => { throw new Error('unused') },
      deleteProject: async () => {},
      health: () => ({
        provider: 'phoenix', enabled: true, state: 'open', projects: 2,
        exports: 10, failures: 3, droppedSpans: 4, lastError: 'connection refused',
        openUntil: '2026-11-13T10:00:00.000Z',
        cache: { entries: 1, hits: 5, misses: 2, timeouts: 0, ttlMs: 15000, deadlineMs: 3000 },
      }),
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const response = await fetch(`http://127.0.0.1:${serverPort(server)}/api/admin/observability`)
    assert.equal(response.status, 200)
    const body = await response.json() as { observability: { provider: string; state: string; droppedSpans: number; cache: { hits: number } } }
    assert.equal(body.observability.provider, 'phoenix')
    assert.equal(body.observability.state, 'open')
    assert.equal(body.observability.droppedSpans, 4)
    assert.equal(body.observability.cache.hits, 5)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('GET /api/admin/observability returns 503 when observability is off', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-obs-admin-off-'))
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const response = await fetch(`http://127.0.0.1:${serverPort(server)}/api/admin/observability`)
    assert.equal(response.status, 503)
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'OBSERVABILITY_DISABLED')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  }
})
