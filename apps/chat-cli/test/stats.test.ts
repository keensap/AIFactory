import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProjectStats, durationStats } from '../src/stats.ts'

const runs = [
  { id: 'r1', stage: 'planning', attempt: 1, status: 'completed', createdAt: '2026-01-01T10:00:00.000Z', startedAt: '2026-01-01T10:00:01.000Z', completedAt: '2026-01-01T10:05:01.000Z', updatedAt: '2026-01-01T10:05:01.000Z' },
  { id: 'r2', stage: 'planning', attempt: 1, status: 'failed', createdAt: '2026-01-02T09:00:00.000Z', startedAt: '2026-01-02T09:00:00.000Z', completedAt: null, updatedAt: '2026-01-02T09:01:00.000Z' },
]
const tokens = [
  { stageRunId: 'r1', stage: 'planning', role: 'analyzer', input: 1000, output: 200, total: 1200, cacheRead: 50, cacheWrite: 0 },
  { stageRunId: 'r1', stage: 'planning', role: 'author', input: 2000, output: 500, total: 2500, cacheRead: 100, cacheWrite: 10 },
  { stageRunId: 'r1', stage: 'planning', role: 'reviewer', input: 500, output: 100, total: 0, cacheRead: 0, cacheWrite: 0 },
  { stageRunId: 'r2', stage: 'planning', role: 'analyzer', input: 300, output: 50, total: 350, cacheRead: 0, cacheWrite: 0 },
]
const roles = [
  { stageRunId: 'r1', stage: 'planning', role: 'analyzer', attempts: 1, durationMs: 1000 },
  { stageRunId: 'r1', stage: 'planning', role: 'author', attempts: 1, durationMs: 2000 },
  { stageRunId: 'r1', stage: 'planning', role: 'reviewer', attempts: 2, durationMs: 3000 },
  { stageRunId: 'r2', stage: 'planning', role: 'analyzer', attempts: 1, durationMs: 500 },
]

test('aggregates tokens, run/role durations, stages, roles and days', () => {
  const stats = buildProjectStats({ projectId: 'p1', from: '2026-01-01T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z', runs, tokens, roles })
  assert.equal(stats.runs.total, 2)
  assert.deepEqual(stats.runs.byStatus, { completed: 1, failed: 1 })
  assert.deepEqual(stats.runs.byStage, { planning: 2 })
  assert.deepEqual(stats.tokens, { input: 3800, output: 850, total: 4650, cacheRead: 150, cacheWrite: 10 })
  // reviewer's missing totalTokens falls back to input + output (600).
  assert.equal(stats.byRole.find((entry) => entry.role === 'reviewer')?.tokens.total, 600)
  assert.equal(stats.byRole.find((entry) => entry.role === 'reviewer')?.attempts, 2)
  assert.equal(stats.byRole.find((entry) => entry.role === 'analyzer')?.runs, 2)
  // Run durations: 300s (completed) and 60s (failed -> updated_at).
  assert.equal(stats.runDurationMs.count, 2)
  assert.equal(stats.runDurationMs.totalMs, 360_000)
  assert.equal(stats.runDurationMs.maxMs, 300_000)
  // Active durations per run: 6000ms and 500ms.
  assert.equal(stats.activeDurationMs.totalMs, 6500)
  assert.equal(stats.byStage[0]?.stage, 'planning')
  assert.equal(stats.byStage[0]?.activeDurationMs.totalMs, 6500)
  assert.equal(stats.daily.length, 2)
  assert.equal(stats.daily[0]?.date, '2026-01-01')
  assert.equal(stats.daily[0]?.tokens.total, 4300)
  assert.equal(stats.daily[1]?.tokens.total, 350)
  assert.equal(stats.recentRuns[0]?.id, 'r2')
  assert.equal(stats.recentRuns[0]?.activeDurationMs, 500)
  assert.deepEqual(stats.recentRuns[1]?.roles, ['analyzer', 'author', 'reviewer'])
  assert.equal(stats.recentRuns[1]?.durationMs, 300_000)
})

test('duration percentiles use interpolation and handle empty input', () => {
  assert.deepEqual(durationStats([]), { count: 0, totalMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 })
  const summary = durationStats([10, 20, 30, 40])
  assert.equal(summary.count, 4)
  assert.equal(summary.totalMs, 100)
  assert.equal(summary.avgMs, 25)
  assert.equal(summary.p50Ms, 25)
  assert.equal(summary.p95Ms, 39)
  assert.equal(summary.maxMs, 40)
})

test('handles runs with no usage or role events', () => {
  const stats = buildProjectStats({ projectId: 'p1', from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', runs: [runs[0]!], tokens: [], roles: [] })
  assert.deepEqual(stats.tokens, { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(stats.byRole, [])
  assert.equal(stats.byStage.length, 1)
  assert.equal(stats.byStage[0]?.stage, 'planning')
  assert.equal(stats.byStage[0]?.activeDurationMs.count, 0)
  assert.equal(stats.runDurationMs.count, 1)
  assert.equal(stats.activeDurationMs.count, 0)
  assert.equal(stats.recentRuns[0]?.activeDurationMs, 0)
})
