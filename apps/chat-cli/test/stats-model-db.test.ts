import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { PostgresProjectStore } from '../src/projects.ts'
import { PostgresProjectWorkspace } from '../src/workspace.ts'
import { telemetryFromEvents } from '../src/telemetry.ts'

const url = process.env.AIFACTORY_TEST_DATABASE_URL
const skip = url === undefined || url === '' ? 'AIFACTORY_TEST_DATABASE_URL is not set' : false

const usage = (input: number, output: number, extra: Record<string, number> = {}) => ({
  inputTokens: input, outputTokens: output, totalTokens: input + output + (extra.cacheReadTokens ?? 0), ...extra,
})

async function setup() {
  const store = new PostgresProjectStore(url!)
  const workspace = new PostgresProjectWorkspace(url!)
  const pool = new Pool({ connectionString: url!, max: 2 })
  await store.migrate()
  await workspace.migrate()
  const roots: string[] = []
  const makeProject = async (name: string) => {
    const root = mkdtempSync(join(tmpdir(), 'aifactory-stats-model-'))
    roots.push(root)
    const project = await store.create({ name, rootPath: root, organization: null, ownerEmail: null, status: 'inactive' })
    const run = await workspace.createStageRun({ projectId: project.id, stage: 'planning', inputText: 'x', context: {}, contextHash: 'h' })
    return { project, run }
  }
  const status = async (ids: { project: { id: string }; run: { id: string } }, role: string, payload: Record<string, unknown>) => {
    const event = await workspace.appendStageRunEvent({
      // The sink stores the whole harness event, so the payload carries `type` too.
      projectId: ids.project.id, stageRunId: ids.run.id, role, type: 'status', level: 'debug', payload: { type: 'status', phase: 'step_end', ...payload },
    })
    return event.id
  }
  return {
    store, workspace, pool, makeProject, status,
    cleanup: async () => {
      await pool.end()
      await store.close()
      await workspace.close()
      for (const root of roots) rmSync(root, { recursive: true, force: true })
    },
  }
}

test('project stats group by model and separate priced, unpriced and legacy usage', { skip }, async () => {
  const t = await setup()
  try {
    const a = await t.makeProject(`Stats model ${randomUUID().slice(0, 8)}`)
    const tag = randomUUID().slice(0, 8)
    const priced = { provider: `anth-${tag}`, model: 'claude' }
    const local = { provider: `llama-${tag}`, model: 'qwen' }

    // priced, with cache tokens
    await t.status(a, 'analyzer', { usage: usage(1000, 500, { cacheReadTokens: 200 }), model: priced, costUsd: 0.0105 })
    await t.status(a, 'author', { usage: usage(2000, 1000), model: priced, costUsd: 0.021 })
    // attributed but no price
    await t.status(a, 'reviewer', { usage: usage(300, 100), model: local })
    // zero-priced (free) local model
    await t.status(a, 'reviewer', { usage: usage(50, 50), model: local, costUsd: 0 })
    // legacy: no model, no cost
    await t.status(a, 'analyzer', { usage: usage(100, 40) })
    // malformed cost must be treated as unpriced and must not break the query
    await t.status(a, 'analyzer', { usage: usage(10, 5), model: priced, costUsd: 'not-a-number' })

    const stats = await t.workspace.projectStats({ projectId: a.project.id, days: 1 })
    const by = (p: string | null, m: string | null) => stats.byModel.find((entry) => entry.provider === p && entry.model === m)

    const claude = by(priced.provider, 'claude')!
    assert.equal(claude.calls, 3)
    assert.equal(claude.pricedCalls, 2)
    assert.equal(claude.costUsd, 0.0315)
    assert.equal(claude.unpricedTokens, 15, 'the malformed-cost event is counted as unpriced usage')
    assert.equal(claude.tokens.cacheRead, 200)

    const qwen = by(local.provider, 'qwen')!
    assert.equal(qwen.costUsd, 0, 'one event priced at zero, one unpriced: the priced part is free')
    assert.equal(qwen.pricedCalls, 1)
    assert.equal(qwen.unpricedTokens, 400)

    const legacy = by(null, null)!
    assert.equal(legacy.costUsd, null)
    assert.equal(legacy.tokens.total, 140)

    assert.equal(stats.cost.usd, 0.0315)
    assert.equal(stats.cost.unpricedTokens, 15 + 400 + 140)
    assert.equal(stats.tokens.total, 1700 + 3000 + 400 + 100 + 140 + 15)
    assert.equal(stats.byRole.find((entry) => entry.role === 'author')?.costUsd, 0.021)
    assert.equal(stats.byRole.find((entry) => entry.role === 'reviewer')?.costUsd, 0)
    assert.equal(stats.recentRuns[0]?.costUsd, 0.0315)
    assert.equal(stats.recentRuns[0]?.models.length, 3)

    // The role filter narrows models and cost the same way it narrows tokens.
    const author = await t.workspace.projectStats({ projectId: a.project.id, role: 'author', days: 1 })
    assert.deepEqual(author.byModel.map((entry) => entry.model), ['claude'])
    assert.equal(author.cost.usd, 0.021)
  } finally {
    await t.cleanup()
  }
})

test('events written before attribution existed still produce valid stats', { skip }, async () => {
  const t = await setup()
  try {
    const a = await t.makeProject(`Stats legacy ${randomUUID().slice(0, 8)}`)
    await t.status(a, 'analyzer', { usage: usage(100, 40, { cacheReadTokens: 10, cacheWriteTokens: 2 }) })
    const stats = await t.workspace.projectStats({ projectId: a.project.id, days: 1 })
    assert.deepEqual(stats.byModel.map((entry) => [entry.provider, entry.model, entry.costUsd]), [[null, null, null]])
    assert.equal(stats.cost.usd, null)
    assert.equal(stats.cost.unpricedTokens, stats.tokens.total)
  } finally {
    await t.cleanup()
  }
})

test('factory usage aggregates across projects with names, days and coverage', { skip }, async () => {
  const t = await setup()
  try {
    const tag = randomUUID().slice(0, 8)
    const p1 = await t.makeProject(`Alpha ${tag}`)
    const p2 = await t.makeProject(`Beta ${tag}`)
    const cloud = { provider: `cloud-${tag}`, model: 'big' }
    const local = { provider: `local-${tag}`, model: 'small' }

    const ids = [
      await t.status(p1, 'analyzer', { usage: usage(1000, 500), model: cloud, costUsd: 0.01 }),
      await t.status(p1, 'author', { usage: usage(2000, 1000), model: cloud, costUsd: 0.02 }),
      await t.status(p2, 'analyzer', { usage: usage(400, 100), model: local }),
    ]
    // Move my events into a private window so neither other tests nor earlier
    // runs of this file can interfere. The offset differs on every run.
    const offsetMs = (40 + Math.floor(Math.random() * 300)) * 24 * 60 * 60 * 1000 + Math.floor(Math.random() * 3_600_000)
    const moment = new Date(Date.now() - offsetMs)
    await t.pool.query('UPDATE stage_run_events SET created_at = $2 WHERE id = ANY($1::bigint[])', [ids, moment.toISOString()])
    const window = { from: new Date(moment.getTime() - 60_000).toISOString(), to: new Date(moment.getTime() + 60_000).toISOString() }

    const report = await t.workspace.modelUsage(window)
    assert.equal(report.tokens.total, 1500 + 3000 + 500)
    assert.equal(report.cost.usd, 0.03)
    assert.equal(report.cost.unpricedTokens, 500)
    assert.equal(report.cost.pricedTokens, 4500)

    assert.deepEqual(report.byModel.map((entry) => [entry.provider, entry.model, entry.calls, entry.runs, entry.costUsd]), [
      [cloud.provider, 'big', 2, 1, 0.03],
      [local.provider, 'small', 1, 1, null],
    ])
    assert.deepEqual(report.byProject.map((entry) => [entry.name, entry.tokens.total, entry.costUsd]), [
      [`Alpha ${tag}`, 4500, 0.03],
      [`Beta ${tag}`, 500, null],
    ])
    assert.equal(report.daily.length, 1)
    assert.equal(report.daily[0]?.date, moment.toISOString().slice(0, 10))
    assert.equal(report.daily[0]?.tokens.total, 5000)
    assert.equal(report.daily[0]?.costUsd, 0.03)

    // Outside the window nothing of mine is visible.
    const later = await t.workspace.modelUsage({ from: new Date(moment.getTime() + 120_000).toISOString(), to: new Date(moment.getTime() + 180_000).toISOString() })
    assert.ok(!later.byModel.some((entry) => entry.provider === cloud.provider))
  } finally {
    await t.cleanup()
  }
})

test('factory usage validates its range like project stats does', { skip }, async () => {
  const t = await setup()
  try {
    await assert.rejects(() => t.workspace.modelUsage({ days: 0 }), /days must be an integer between 1 and 365/)
    await assert.rejects(() => t.workspace.modelUsage({ days: 366 }), /days must be an integer/)
    await assert.rejects(() => t.workspace.modelUsage({ from: 'nope' }), /from must be an ISO-8601/)
    await assert.rejects(() => t.workspace.modelUsage({ to: 'nope' }), /to must be an ISO-8601/)
    await assert.rejects(() => t.workspace.modelUsage({ from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' }), /from must be before to/)
    const fine = await t.workspace.modelUsage({ days: 1 })
    assert.equal(typeof fine.cost.pricedTokens, 'number')
    // The project endpoint keeps the same rules after sharing the helper.
    const a = await t.makeProject(`Range ${randomUUID().slice(0, 8)}`)
    await assert.rejects(() => t.workspace.projectStats({ projectId: a.project.id, days: 0 }), /days must be an integer/)
  } finally {
    await t.cleanup()
  }
})

test('stored events fold into run telemetry', { skip }, async () => {
  const t = await setup()
  try {
    const a = await t.makeProject(`Telemetry ${randomUUID().slice(0, 8)}`)
    const start = await t.status(a, 'analyzer', { phase: 'step_start', turn: 1, step: 1 })
    const end = await t.status(a, 'analyzer', {
      turn: 1, step: 1,
      usage: { inputTokens: 2_000, outputTokens: 1_000, totalTokens: 3_000, cacheReadTokens: 8_000, cacheWriteTokens: 0 },
      model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      contextWindow: 20_000,
    })
    // Exactly 4 seconds apart, so throughput is exactly 250 tok/s.
    const endAt = new Date('2026-01-01T10:00:04.000Z')
    const startAt = new Date(endAt.getTime() - 4_000)
    await t.pool.query('UPDATE stage_run_events SET created_at = $2 WHERE id = $1', [start, startAt.toISOString()])
    await t.pool.query('UPDATE stage_run_events SET created_at = $2 WHERE id = $1', [end, endAt.toISOString()])

    const events = await t.workspace.listStageRunEvents(a.run.id, '0', 1000)
    const snapshot = telemetryFromEvents(events)
    assert.equal(snapshot.steps, 1)
    assert.equal(snapshot.turns, 1)
    assert.equal(snapshot.tokensPerSecond, 250, '1000 output tokens over 4s')
    assert.equal(snapshot.cacheHitPercent, 80)
    assert.equal(snapshot.contextUsedTokens, 10_000)
    assert.equal(snapshot.contextUsedPercent, 50)
    assert.deepEqual(snapshot.model, { provider: 'anthropic', model: 'claude-sonnet-4-5' })
    assert.equal(snapshot.usage.total, 3_000)
  } finally {
    await t.cleanup()
  }
})
