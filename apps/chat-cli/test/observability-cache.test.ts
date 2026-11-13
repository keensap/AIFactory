import assert from 'node:assert/strict'
import test from 'node:test'
import { CachedObservabilityReader } from '../src/observability/index.ts'
import type { ObservabilityHealth, ObservabilityReader, ObservabilitySummary } from '../src/observability/index.ts'

function summary(projectId: string, spans: number): ObservabilitySummary {
  return {
    available: true, projectName: projectId, windowHours: 24,
    traces: 1, spans, errors: 0, tools: 0, tokens: 0,
    latencyMs: { count: 0, avg: 0, p50: 0, p95: 0, max: 0 },
    roles: [], lastSpanAt: null, truncated: false,
  }
}

function unavailableSummary(projectId: string, reason: string): ObservabilitySummary {
  return { ...summary(projectId, 0), available: false, reason }
}

class FakeReader implements ObservabilityReader {
  calls = 0
  deleted: string[] = []
  private readonly impl: (projectId: string) => Promise<ObservabilitySummary>

  constructor(impl: (projectId: string) => Promise<ObservabilitySummary>) {
    this.impl = impl
  }
  async summary(projectId: string): Promise<ObservabilitySummary> {
    this.calls += 1
    return this.impl(projectId)
  }
  async deleteProject(projectId: string): Promise<void> { this.deleted.push(projectId) }
  health(): ObservabilityHealth {
    return {
      provider: 'fake', enabled: true, state: 'healthy', projects: 0,
      exports: 0, failures: 0, droppedSpans: 0, lastError: null, openUntil: null,
    }
  }
}

test('caches within the TTL and refreshes after it', async () => {
  let now = 1000
  const reader = new FakeReader(async (projectId) => summary(projectId, 4))
  const cache = new CachedObservabilityReader(reader, { ttlMs: 100, now: () => now })
  assert.equal((await cache.summary('p1', 24)).spans, 4)
  assert.equal((await cache.summary('p1', 24)).spans, 4)
  assert.equal(reader.calls, 1, 'second read inside the TTL must be served from cache')
  now += 150
  await cache.summary('p1', 24)
  assert.equal(reader.calls, 2, 'expired entry is refreshed')
  const health = cache.health()
  assert.equal(health.cache?.hits, 1)
  assert.equal(health.cache?.misses, 2)
  assert.equal(health.cache?.ttlMs, 100)
})

test('single-flight collapses concurrent reads for the same key', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const reader = new FakeReader(async (projectId) => {
    await gate
    return summary(projectId, 2)
  })
  const cache = new CachedObservabilityReader(reader)
  const results = Promise.all([cache.summary('p1', 24), cache.summary('p1', 24), cache.summary('p1', 24)])
  release()
  const all = await results
  assert.equal(reader.calls, 1, 'three concurrent reads must share one backend call')
  for (const result of all) assert.equal(result.spans, 2)
})

test('different windows and projects are cached separately', async () => {
  const reader = new FakeReader(async (projectId) => summary(projectId, projectId === 'p1' ? 1 : 2))
  const cache = new CachedObservabilityReader(reader)
  assert.equal((await cache.summary('p1', 24)).spans, 1)
  assert.equal((await cache.summary('p1', 48)).spans, 1)
  assert.equal((await cache.summary('p2', 24)).spans, 2)
  assert.equal(reader.calls, 3)
})

test('an overall deadline bounds a hung backend and reports unavailable', async () => {
  const reader = new FakeReader(() => new Promise<ObservabilitySummary>(() => {}))
  const cache = new CachedObservabilityReader(reader, { deadlineMs: 60 })
  const started = Date.now()
  const result = await cache.summary('p1', 24)
  assert.ok(Date.now() - started < 1000)
  assert.equal(result.available, false)
  assert.match(result.reason ?? '', /timed out/)
  assert.equal(cache.health().cache?.timeouts, 1)
})

test('a failing refresh serves the previous summary flagged as stale', async () => {
  let now = 1000
  let failing = false
  const reader = new FakeReader(async (projectId) =>
    failing ? unavailableSummary(projectId, 'connection refused') : summary(projectId, 7))
  const cache = new CachedObservabilityReader(reader, { ttlMs: 50, now: () => now })
  assert.equal((await cache.summary('p1', 24)).spans, 7)
  now += 100
  failing = true
  const stale = await cache.summary('p1', 24)
  assert.equal(stale.available, true)
  assert.equal(stale.stale, true)
  assert.equal(stale.spans, 7)
  assert.ok(stale.cachedAt)
})

test('a failure with no cached value is reported as unavailable and is cached briefly', async () => {
  const reader = new FakeReader(async (projectId) => unavailableSummary(projectId, 'phoenix down'))
  const cache = new CachedObservabilityReader(reader)
  const first = await cache.summary('p1', 24)
  assert.equal(first.available, false)
  assert.match(first.reason ?? '', /phoenix down/)
  await cache.summary('p1', 24)
  assert.equal(reader.calls, 1, 'unavailable summaries are cached to avoid hammering a dead backend')
})

test('a throwing reader never escapes the cache layer', async () => {
  const reader = new FakeReader(async () => { throw new Error('boom') })
  const cache = new CachedObservabilityReader(reader)
  const result = await cache.summary('p1', 24)
  assert.equal(result.available, false)
  assert.match(result.reason ?? '', /boom/)
})

test('deleting a project invalidates its cached windows', async () => {
  const reader = new FakeReader(async (projectId) => summary(projectId, 1))
  const cache = new CachedObservabilityReader(reader)
  await cache.summary('p1', 24)
  await cache.summary('p1', 48)
  await cache.summary('p2', 24)
  assert.equal(cache.size, 3)
  await cache.deleteProject('p1')
  assert.equal(cache.size, 1, 'only p2 remains cached')
  assert.deepEqual(reader.deleted, ['p1'])
})

test('the cache is bounded by maxEntries, evicting the oldest entry', async () => {
  const reader = new FakeReader(async (projectId) => summary(projectId, 1))
  const cache = new CachedObservabilityReader(reader, { maxEntries: 2 })
  await cache.summary('p1', 24)
  await cache.summary('p2', 24)
  await cache.summary('p3', 24)
  assert.equal(cache.size, 2)
})
