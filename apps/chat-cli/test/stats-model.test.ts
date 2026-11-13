import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CostAccumulator,
  buildFactoryUsage,
  buildProjectStats,
  type ModelAggRow,
  type StatsTokenRow,
} from '../src/stats.ts'

const range = { projectId: 'p1', from: '2026-01-01T00:00:00.000Z', to: '2026-01-04T00:00:00.000Z' }
const runs = [
  { id: 'r1', stage: 'planning', attempt: 1, status: 'completed', createdAt: '2026-01-01T10:00:00.000Z', startedAt: '2026-01-01T10:00:00.000Z', completedAt: '2026-01-01T10:05:00.000Z', updatedAt: '2026-01-01T10:05:00.000Z' },
  { id: 'r2', stage: 'planning', attempt: 2, status: 'completed', createdAt: '2026-01-02T10:00:00.000Z', startedAt: '2026-01-02T10:00:00.000Z', completedAt: '2026-01-02T10:05:00.000Z', updatedAt: '2026-01-02T10:05:00.000Z' },
]

const row = (overrides: Partial<StatsTokenRow>): StatsTokenRow => ({
  stageRunId: 'r1', stage: 'planning', role: 'analyzer',
  input: 1000, output: 500, total: 1500, cacheRead: 0, cacheWrite: 0,
  provider: 'anthropic', model: 'claude-sonnet-4-5', priced: true, calls: 1, costUsd: 0.0105,
  ...overrides,
})

// ---- cost accumulator --------------------------------------------------

test('cost is null when nothing was priced, and 0 when priced and free', () => {
  const none = new CostAccumulator()
  none.add({ priced: false, calls: 2 }, 500)
  assert.equal(none.value, null)
  assert.deepEqual(none.summary(), { usd: null, pricedTokens: 0, unpricedTokens: 500 })

  const free = new CostAccumulator()
  free.add({ priced: true, costUsd: 0, calls: 1 }, 800)
  assert.equal(free.value, 0, 'priced at zero is not the same as unknown')
  assert.deepEqual(free.summary(), { usd: 0, pricedTokens: 800, unpricedTokens: 0 })
})

test('a partly priced scope reports its cost and how much usage the cost leaves out', () => {
  const acc = new CostAccumulator()
  acc.add({ priced: true, costUsd: 0.25, calls: 2 }, 1000)
  acc.add({ priced: false, calls: 1 }, 400)
  acc.add({ priced: true, costUsd: 0.5, calls: 1 }, 600)
  assert.deepEqual(acc.summary(), { usd: 0.75, pricedTokens: 1600, unpricedTokens: 400 })
  assert.equal(acc.calls, 4)
  assert.equal(acc.pricedCalls, 3)
})

test('floating point noise is rounded away', () => {
  const acc = new CostAccumulator()
  for (let i = 0; i < 10; i++) acc.add({ priced: true, costUsd: 0.1, calls: 1 }, 1)
  assert.equal(acc.value, 1)
})

// ---- project stats -----------------------------------------------------

test('usage is grouped by provider/model with calls, runs and cost', () => {
  const stats = buildProjectStats({
    ...range, runs, roles: [],
    tokens: [
      row({ stageRunId: 'r1', role: 'analyzer' }),
      row({ stageRunId: 'r1', role: 'author', input: 2000, output: 1000, total: 3000, costUsd: 0.021, calls: 2 }),
      row({ stageRunId: 'r2', role: 'analyzer', provider: 'openai', model: 'gpt-4o', input: 500, output: 100, total: 600, costUsd: 0.00225 }),
    ],
  })
  assert.equal(stats.byModel.length, 2)
  const claude = stats.byModel.find((entry) => entry.model === 'claude-sonnet-4-5')!
  assert.deepEqual(
    { provider: claude.provider, calls: claude.calls, runs: claude.runs, cost: claude.costUsd, tokens: claude.tokens.total },
    { provider: 'anthropic', calls: 3, runs: 1, cost: 0.0315, tokens: 4500 },
  )
  assert.equal(stats.byModel[0]?.model, 'claude-sonnet-4-5', 'largest usage first')
  assert.equal(stats.cost.usd, 0.03375)
  assert.equal(stats.tokens.total, 5100)
  assert.equal(stats.cost.unpricedTokens, 0)
})

test('legacy events without a model are reported as unattributed, never guessed', () => {
  const stats = buildProjectStats({
    ...range, runs, roles: [],
    tokens: [
      { stageRunId: 'r1', stage: 'planning', role: 'analyzer', input: 100, output: 40, total: 140, cacheRead: 10, cacheWrite: 2 },
      row({ stageRunId: 'r2' }),
    ],
  })
  const unattributed = stats.byModel.find((entry) => entry.provider === null)!
  assert.equal(unattributed.model, null)
  assert.equal(unattributed.tokens.total, 140)
  assert.equal(unattributed.costUsd, null)
  assert.equal(unattributed.unpricedTokens, 140)
  assert.equal(stats.cost.usd, 0.0105, 'only the priced usage is in the total')
  assert.equal(stats.cost.unpricedTokens, 140, 'and the gap is stated')
})

test('a model that is attributed but has no price has tokens and no cost', () => {
  const stats = buildProjectStats({
    ...range, runs, roles: [],
    tokens: [row({ provider: 'llamacpp', model: 'qwen3-8b', priced: false, costUsd: 0 })],
  })
  assert.equal(stats.byModel[0]?.model, 'qwen3-8b')
  assert.equal(stats.byModel[0]?.costUsd, null)
  assert.equal(stats.byModel[0]?.pricedCalls, 0)
  assert.equal(stats.cost.usd, null)
})

test('the same model split into priced and unpriced rows is one entry', () => {
  const stats = buildProjectStats({
    ...range, runs, roles: [],
    tokens: [
      row({ priced: true, costUsd: 0.01, total: 1500 }),
      row({ priced: false, costUsd: 0, total: 700, input: 500, output: 200 }),
    ],
  })
  assert.equal(stats.byModel.length, 1)
  assert.deepEqual(
    { calls: stats.byModel[0]?.calls, priced: stats.byModel[0]?.pricedCalls, cost: stats.byModel[0]?.costUsd, unpriced: stats.byModel[0]?.unpricedTokens },
    { calls: 2, priced: 1, cost: 0.01, unpriced: 700 },
  )
})

test('cost is carried through roles, stages, days and runs', () => {
  const stats = buildProjectStats({
    ...range, runs, roles: [],
    tokens: [
      row({ stageRunId: 'r1', role: 'analyzer', costUsd: 0.01 }),
      row({ stageRunId: 'r1', role: 'author', costUsd: 0.02, provider: 'openai', model: 'gpt-4o' }),
      row({ stageRunId: 'r2', role: 'analyzer', costUsd: 0.04 }),
    ],
  })
  assert.equal(stats.byRole.find((entry) => entry.role === 'analyzer')?.costUsd, 0.05)
  assert.equal(stats.byRole.find((entry) => entry.role === 'author')?.costUsd, 0.02)
  assert.equal(stats.byStage[0]?.costUsd, 0.07)
  assert.deepEqual(stats.daily.map((entry) => [entry.date, entry.costUsd]), [['2026-01-01', 0.03], ['2026-01-02', 0.04]])
  const r1 = stats.recentRuns.find((entry) => entry.id === 'r1')!
  assert.equal(r1.costUsd, 0.03)
  assert.deepEqual(r1.models, [{ provider: 'anthropic', model: 'claude-sonnet-4-5' }, { provider: 'openai', model: 'gpt-4o' }])
})

test('runs and roles without usage have null cost, not zero', () => {
  const stats = buildProjectStats({ ...range, runs: [runs[0]!], tokens: [], roles: [] })
  assert.equal(stats.cost.usd, null)
  assert.deepEqual(stats.byModel, [])
  assert.equal(stats.recentRuns[0]?.costUsd, null)
  assert.equal(stats.byStage[0]?.costUsd, null)
  assert.deepEqual(stats.recentRuns[0]?.models, [])
})

test('model usage ordering is deterministic and puts unattributed after equals', () => {
  const stats = buildProjectStats({
    ...range, runs, roles: [],
    tokens: [
      row({ provider: 'b', model: 'm', input: 100, output: 0, total: 100, costUsd: 1 }),
      row({ provider: 'a', model: 'm', input: 100, output: 0, total: 100, costUsd: 1 }),
      { stageRunId: 'r1', stage: 'planning', role: 'analyzer', input: 100, output: 0, total: 100, cacheRead: 0, cacheWrite: 0 },
    ],
  })
  assert.deepEqual(stats.byModel.map((entry) => entry.provider), ['a', 'b', null])
})

// ---- factory usage -----------------------------------------------------

const agg = (overrides: Partial<ModelAggRow>): ModelAggRow => ({
  provider: 'anthropic', model: 'claude-sonnet-4-5',
  input: 1000, output: 500, total: 1500, cacheRead: 0, cacheWrite: 0,
  calls: 3, runs: 2, pricedCalls: 3, costUsd: 0.03, unpricedTokens: 0,
  ...overrides,
})

test('factory usage totals come from the per-model rows and state coverage', () => {
  const usage = buildFactoryUsage({
    from: 'a', to: 'b',
    byModel: [
      agg({}),
      agg({ provider: 'llamacpp', model: 'qwen3-8b', total: 4000, input: 3000, output: 1000, pricedCalls: 0, costUsd: null, unpricedTokens: 4000, calls: 4 }),
      agg({ provider: null, model: null, total: 200, input: 150, output: 50, pricedCalls: 0, costUsd: null, unpricedTokens: 200, calls: 1 }),
    ],
    byProject: [
      { projectId: 'p1', input: 1, output: 1, total: 2, cacheRead: 0, cacheWrite: 0, calls: 1, runs: 1, pricedCalls: 1, costUsd: 0.01, unpricedTokens: 0 },
      { projectId: 'p2', input: 5, output: 5, total: 10, cacheRead: 0, cacheWrite: 0, calls: 1, runs: 1, pricedCalls: 0, costUsd: null, unpricedTokens: 10 },
    ],
    daily: [
      { date: '2026-01-02', input: 1, output: 1, total: 2, cacheRead: 0, cacheWrite: 0, calls: 1, runs: 1, pricedCalls: 1, costUsd: 0.5, unpricedTokens: 0 },
      { date: '2026-01-01', input: 1, output: 1, total: 2, cacheRead: 0, cacheWrite: 0, calls: 1, runs: 1, pricedCalls: 0, costUsd: null, unpricedTokens: 2 },
    ],
    projectNames: new Map([['p1', 'Portal']]),
  })
  assert.equal(usage.tokens.total, 5700)
  assert.equal(usage.cost.usd, 0.03, 'only priced usage is summed')
  assert.equal(usage.cost.unpricedTokens, 4200, 'and the unpriced usage is stated')
  assert.equal(usage.cost.pricedTokens, 1500)
  assert.deepEqual(usage.byModel.map((entry) => entry.model), ['qwen3-8b', 'claude-sonnet-4-5', null], 'largest usage first')
  assert.deepEqual(usage.byProject.map((entry) => [entry.projectId, entry.name, entry.costUsd]), [['p2', null, null], ['p1', 'Portal', 0.01]])
  assert.deepEqual(usage.daily.map((entry) => [entry.date, entry.costUsd]), [['2026-01-01', null], ['2026-01-02', 0.5]])
})

test('an empty factory report is all zeros with a null cost', () => {
  const usage = buildFactoryUsage({ from: 'a', to: 'b', byModel: [], byProject: [], daily: [], projectNames: new Map() })
  assert.deepEqual(usage.tokens, { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(usage.cost, { usd: null, pricedTokens: 0, unpricedTokens: 0 })
  assert.deepEqual([usage.byModel, usage.byProject, usage.daily], [[], [], []])
})
