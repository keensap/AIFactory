/**
 * Project usage statistics derived from the durable stage event log.
 *
 * Token counts come from harness `status` events (`payload.usage`), and role
 * durations from `role_end` events (`payload.durationMs`). This is independent
 * of Phoenix: Phoenix may be down, or its trace retention may be shorter.
 */

import { SDLC_STAGES } from './sdlc.ts'

export interface StatsRunRow {
  id: string
  stage: string
  attempt: number
  status: string
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  updatedAt: string
}

export interface StatsTokenRow {
  stageRunId: string
  stage: string
  role: string
  input: number
  output: number
  total: number
  cacheRead: number
  cacheWrite: number
  /** Model that produced the usage; null/absent for events recorded before attribution existed. */
  provider?: string | null
  model?: string | null
  /** True when the usage events carried a `costUsd` computed at record time. */
  priced?: boolean
  /** Number of usage events aggregated in this row. */
  calls?: number
  /** Sum of the recorded `costUsd` (priced rows only). */
  costUsd?: number
}

export interface StatsRoleRow {
  stageRunId: string
  stage: string
  role: string
  attempts: number
  durationMs: number
}

export interface TokenTotals {
  input: number
  output: number
  total: number
  cacheRead: number
  cacheWrite: number
}

/**
 * Cost with its coverage. `usd` is null when nothing in scope was priced (as
 * opposed to 0, which means priced and free). `unpricedTokens` shows how much
 * usage is *not* in `usd`, so a partial total is never mistaken for a full one.
 */
export interface CostSummary {
  usd: number | null
  pricedTokens: number
  unpricedTokens: number
}

export interface ModelUsage {
  /** Null for usage recorded before model attribution existed ("unattributed"). */
  provider: string | null
  model: string | null
  tokens: TokenTotals
  calls: number
  pricedCalls: number
  costUsd: number | null
  unpricedTokens: number
  runs: number
}

export interface DurationStats {
  count: number
  totalMs: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

export interface ProjectStats {
  projectId: string
  from: string
  to: string
  runs: {
    total: number
    byStatus: Record<string, number>
    byStage: Record<string, number>
  }
  tokens: TokenTotals
  cost: CostSummary
  /** Usage per provider/model, largest first. Unattributed usage has null provider/model. */
  byModel: ModelUsage[]
  /** Wall-clock time from run start to completion/update (may include human wait). */
  runDurationMs: DurationStats
  /** Sum of actual role execution times (analyzer/author/reviewer). */
  activeDurationMs: DurationStats
  byRole: Array<{
    role: string
    runs: number
    attempts: number
    tokens: TokenTotals
    costUsd: number | null
    durationMs: DurationStats
  }>
  byStage: Array<{
    stage: string
    runs: number
    tokens: TokenTotals
    costUsd: number | null
    activeDurationMs: DurationStats
  }>
  daily: Array<{
    date: string
    runs: number
    tokens: TokenTotals
    costUsd: number | null
    activeDurationMs: number
  }>
  recentRuns: Array<{
    id: string
    stage: string
    attempt: number
    status: string
    startedAt: string | null
    endedAt: string | null
    durationMs: number | null
    activeDurationMs: number
    tokens: TokenTotals
    costUsd: number | null
    models: Array<{ provider: string | null; model: string | null }>
    roles: string[]
  }>
}

export function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 }
}

function addTokens(target: TokenTotals, source: TokenTotals): void {
  target.input += source.input
  target.output += source.output
  target.total += source.total
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
}

const COST_DECIMALS = 1e9

/** Sums recorded costs for one scope and remembers how much usage was not priced. */
export class CostAccumulator {
  private usd = 0
  private any = false
  pricedTokens = 0
  unpricedTokens = 0
  pricedCalls = 0
  calls = 0

  add(row: Pick<StatsTokenRow, 'priced' | 'costUsd' | 'calls'>, totalTokens: number): void {
    const calls = row.calls ?? 1
    this.calls += calls
    if (row.priced === true) {
      this.any = true
      this.usd += row.costUsd ?? 0
      this.pricedTokens += totalTokens
      this.pricedCalls += calls
    } else {
      this.unpricedTokens += totalTokens
    }
  }

  merge(other: CostAccumulator): void {
    this.usd += other.usd
    this.any = this.any || other.any
    this.pricedTokens += other.pricedTokens
    this.unpricedTokens += other.unpricedTokens
    this.pricedCalls += other.pricedCalls
    this.calls += other.calls
  }

  /** null when no usage in this scope was priced. */
  get value(): number | null {
    return this.any ? Math.round(this.usd * COST_DECIMALS) / COST_DECIMALS : null
  }

  summary(): CostSummary {
    return { usd: this.value, pricedTokens: this.pricedTokens, unpricedTokens: this.unpricedTokens }
  }
}

function rowTokens(row: StatsTokenRow): TokenTotals {
  return {
    input: row.input,
    output: row.output,
    total: row.total > 0 ? row.total : row.input + row.output + row.cacheRead + row.cacheWrite,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
  }
}

interface ModelBucket {
  provider: string | null
  model: string | null
  tokens: TokenTotals
  cost: CostAccumulator
  runs: Set<string>
}

function modelKey(provider: string | null | undefined, model: string | null | undefined): string {
  return `${provider ?? ''}\u0000${model ?? ''}`
}

function toModelUsage(bucket: ModelBucket): ModelUsage {
  return {
    provider: bucket.provider,
    model: bucket.model,
    tokens: bucket.tokens,
    calls: bucket.cost.calls,
    pricedCalls: bucket.cost.pricedCalls,
    costUsd: bucket.cost.value,
    unpricedTokens: bucket.cost.unpricedTokens,
    runs: bucket.runs.size,
  }
}

/** Largest usage first; unattributed usage sorts last among equals. */
function byUsageDesc(a: ModelUsage, b: ModelUsage): number {
  return b.tokens.total - a.tokens.total
    || (b.costUsd ?? 0) - (a.costUsd ?? 0)
    || `${a.provider ?? '~'}/${a.model ?? '~'}`.localeCompare(`${b.provider ?? '~'}/${b.model ?? '~'}`)
}

export function durationStats(values: number[]): DurationStats {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
  if (clean.length === 0) return { count: 0, totalMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 }
  const total = clean.reduce((sum, value) => sum + value, 0)
  const percentile = (p: number): number => {
    const index = (clean.length - 1) * p
    const lower = Math.floor(index)
    const upper = Math.ceil(index)
    if (lower === upper) return clean[lower]!
    return clean[lower]! + (clean[upper]! - clean[lower]!) * (index - lower)
  }
  return {
    count: clean.length,
    totalMs: Math.round(total),
    avgMs: Math.round(total / clean.length),
    p50Ms: Math.round(percentile(0.5)),
    p95Ms: Math.round(percentile(0.95)),
    maxMs: Math.round(clean[clean.length - 1]!),
  }
}

function dateOf(iso: string): string {
  return iso.slice(0, 10)
}

function durationBetween(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null
}

export function buildProjectStats(input: {
  projectId: string
  from: string
  to: string
  runs: StatsRunRow[]
  tokens: StatsTokenRow[]
  roles: StatsRoleRow[]
}): ProjectStats {
  const tokenByRun = new Map<string, TokenTotals>()
  const roleTotals = new Map<string, {
    role: string
    runs: Set<string>
    attempts: number
    tokens: TokenTotals
    cost: CostAccumulator
    durations: number[]
  }>()
  const stageTotals = new Map<string, {
    stage: string
    runs: Set<string>
    tokens: TokenTotals
    cost: CostAccumulator
    durations: number[]
  }>()
  const daily = new Map<string, { date: string; runs: Set<string>; tokens: TokenTotals; cost: CostAccumulator; activeDurationMs: number }>()
  const modelTotals = new Map<string, ModelBucket>()
  const runCost = new Map<string, CostAccumulator>()
  const runModels = new Map<string, Map<string, { provider: string | null; model: string | null }>>()
  const totalCost = new CostAccumulator()
  const totals = emptyTokens()
  const runTokens = new Map<string, TokenTotals>()
  const runRoles = new Map<string, Set<string>>()
  const runActive = new Map<string, number>()

  for (const row of input.tokens) {
    const tokens = rowTokens(row)
    addTokens(totals, tokens)
    totalCost.add(row, tokens.total)
    const existing = tokenByRun.get(row.stageRunId) ?? emptyTokens()
    addTokens(existing, tokens)
    tokenByRun.set(row.stageRunId, existing)
    const role = roleTotals.get(row.role) ?? { role: row.role, runs: new Set<string>(), attempts: 0, tokens: emptyTokens(), cost: new CostAccumulator(), durations: [] }
    addTokens(role.tokens, tokens)
    role.cost.add(row, tokens.total)
    role.runs.add(row.stageRunId)
    roleTotals.set(row.role, role)
    const stage = stageTotals.get(row.stage) ?? { stage: row.stage, runs: new Set<string>(), tokens: emptyTokens(), cost: new CostAccumulator(), durations: [] }
    addTokens(stage.tokens, tokens)
    stage.cost.add(row, tokens.total)
    stage.runs.add(row.stageRunId)
    stageTotals.set(row.stage, stage)
    const runToken = runTokens.get(row.stageRunId) ?? emptyTokens()
    addTokens(runToken, tokens)
    runTokens.set(row.stageRunId, runToken)
    const cost = runCost.get(row.stageRunId) ?? new CostAccumulator()
    cost.add(row, tokens.total)
    runCost.set(row.stageRunId, cost)
    const key = modelKey(row.provider, row.model)
    const bucket = modelTotals.get(key) ?? {
      provider: row.provider ?? null,
      model: row.model ?? null,
      tokens: emptyTokens(),
      cost: new CostAccumulator(),
      runs: new Set<string>(),
    }
    addTokens(bucket.tokens, tokens)
    bucket.cost.add(row, tokens.total)
    bucket.runs.add(row.stageRunId)
    modelTotals.set(key, bucket)
    const models = runModels.get(row.stageRunId) ?? new Map()
    models.set(key, { provider: row.provider ?? null, model: row.model ?? null })
    runModels.set(row.stageRunId, models)
    const roles = runRoles.get(row.stageRunId) ?? new Set<string>()
    roles.add(row.role)
    runRoles.set(row.stageRunId, roles)
  }

  for (const row of input.roles) {
    const role = roleTotals.get(row.role) ?? { role: row.role, runs: new Set<string>(), attempts: 0, tokens: emptyTokens(), cost: new CostAccumulator(), durations: [] }
    role.attempts += row.attempts
    if (row.durationMs > 0) role.durations.push(row.durationMs)
    role.runs.add(row.stageRunId)
    roleTotals.set(row.role, role)
    const stage = stageTotals.get(row.stage) ?? { stage: row.stage, runs: new Set<string>(), tokens: emptyTokens(), cost: new CostAccumulator(), durations: [] }
    stage.runs.add(row.stageRunId)
    stageTotals.set(row.stage, stage)
    runActive.set(row.stageRunId, (runActive.get(row.stageRunId) ?? 0) + row.durationMs)
    const roles = runRoles.get(row.stageRunId) ?? new Set<string>()
    roles.add(row.role)
    runRoles.set(row.stageRunId, roles)
  }

  const byStatus: Record<string, number> = {}
  const byStage: Record<string, number> = {}
  const runDurations: number[] = []
  const activeDurations: number[] = []
  for (const run of input.runs) {
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1
    byStage[run.stage] = (byStage[run.stage] ?? 0) + 1
    const duration = durationBetween(run.startedAt ?? run.createdAt, run.completedAt ?? run.updatedAt)
    if (duration !== null) runDurations.push(duration)
    const active = runActive.get(run.id) ?? 0
    if (active > 0) activeDurations.push(active)
    const stage = stageTotals.get(run.stage) ?? { stage: run.stage, runs: new Set<string>(), tokens: emptyTokens(), cost: new CostAccumulator(), durations: [] }
    stage.runs.add(run.id)
    if (active > 0) stage.durations.push(active)
    stageTotals.set(run.stage, stage)
    const day = dateOf(run.startedAt ?? run.createdAt)
    const entry = daily.get(day) ?? { date: day, runs: new Set<string>(), tokens: emptyTokens(), cost: new CostAccumulator(), activeDurationMs: 0 }
    entry.runs.add(run.id)
    entry.activeDurationMs += active
    daily.set(day, entry)
  }
  for (const [runId, tokens] of tokenByRun) {
    const run = input.runs.find((candidate) => candidate.id === runId)
    if (run === undefined) continue
    const entry = daily.get(dateOf(run.startedAt ?? run.createdAt))
    if (entry === undefined) continue
    addTokens(entry.tokens, tokens)
    const cost = runCost.get(runId)
    if (cost !== undefined) entry.cost.merge(cost)
  }

  const recentRuns = [...input.runs]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, 20)
    .map((run) => ({
      id: run.id,
      stage: run.stage,
      attempt: run.attempt,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.completedAt ?? run.updatedAt,
      durationMs: durationBetween(run.startedAt ?? run.createdAt, run.completedAt ?? run.updatedAt),
      activeDurationMs: runActive.get(run.id) ?? 0,
      tokens: tokenByRun.get(run.id) ?? emptyTokens(),
      costUsd: runCost.get(run.id)?.value ?? null,
      models: [...(runModels.get(run.id)?.values() ?? [])].sort((a, b) =>
        `${a.provider ?? '~'}/${a.model ?? '~'}`.localeCompare(`${b.provider ?? '~'}/${b.model ?? '~'}`)),
      roles: [...(runRoles.get(run.id) ?? new Set<string>())].sort(),
    }))

  const stageOrder = (stage: string): number => {
    const index = SDLC_STAGES.indexOf(stage as never)
    return index < 0 ? SDLC_STAGES.length : index
  }

  return {
    projectId: input.projectId,
    from: input.from,
    to: input.to,
    runs: { total: input.runs.length, byStatus, byStage },
    tokens: totals,
    cost: totalCost.summary(),
    byModel: [...modelTotals.values()].map(toModelUsage).sort(byUsageDesc),
    runDurationMs: durationStats(runDurations),
    activeDurationMs: durationStats(activeDurations),
    byRole: [...roleTotals.values()]
      .map((entry) => ({
        role: entry.role,
        runs: entry.runs.size,
        attempts: entry.attempts,
        tokens: entry.tokens,
        costUsd: entry.cost.value,
        durationMs: durationStats(entry.durations),
      }))
      .sort((a, b) => a.role.localeCompare(b.role)),
    byStage: [...stageTotals.values()]
      .map((entry) => ({
        stage: entry.stage as never,
        runs: entry.runs.size,
        tokens: entry.tokens,
        costUsd: entry.cost.value,
        activeDurationMs: durationStats(entry.durations),
      }))
      .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage)),
    daily: [...daily.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((entry) => ({ date: entry.date, runs: entry.runs.size, tokens: entry.tokens, costUsd: entry.cost.value, activeDurationMs: entry.activeDurationMs })),
    recentRuns,
  }
}

// ---------------------------------------------------------------------------
// Factory-wide usage report (all projects)
// ---------------------------------------------------------------------------

/** One pre-aggregated SQL row: usage events grouped by a single dimension. */
export interface UsageAggRow {
  input: number
  output: number
  total: number
  cacheRead: number
  cacheWrite: number
  calls: number
  runs: number
  pricedCalls: number
  /** Sum of recorded costs over the priced events; null when none were priced. */
  costUsd: number | null
  unpricedTokens: number
}

export interface ModelAggRow extends UsageAggRow {
  provider: string | null
  model: string | null
}

export interface ProjectAggRow extends UsageAggRow {
  projectId: string
}

export interface DayAggRow extends UsageAggRow {
  date: string
}

export interface FactoryUsage {
  from: string
  to: string
  tokens: TokenTotals
  cost: CostSummary
  byModel: ModelUsage[]
  byProject: Array<{
    projectId: string
    name: string | null
    tokens: TokenTotals
    calls: number
    runs: number
    costUsd: number | null
    unpricedTokens: number
  }>
  daily: Array<{
    date: string
    tokens: TokenTotals
    calls: number
    costUsd: number | null
    unpricedTokens: number
  }>
}

function aggTokens(row: UsageAggRow): TokenTotals {
  return {
    input: row.input,
    output: row.output,
    total: row.total > 0 ? row.total : row.input + row.output + row.cacheRead + row.cacheWrite,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
  }
}

function aggCost(row: UsageAggRow): number | null {
  return row.pricedCalls > 0 && row.costUsd !== null ? Math.round(row.costUsd * COST_DECIMALS) / COST_DECIMALS : null
}

export function buildFactoryUsage(input: {
  from: string
  to: string
  byModel: ModelAggRow[]
  byProject: ProjectAggRow[]
  daily: DayAggRow[]
  projectNames: Map<string, string>
}): FactoryUsage {
  const tokens = emptyTokens()
  let usd = 0
  let anyPriced = false
  let pricedTokens = 0
  let unpricedTokens = 0
  const byModel: ModelUsage[] = input.byModel.map((row) => {
    const rowTokensTotal = aggTokens(row)
    addTokens(tokens, rowTokensTotal)
    const cost = aggCost(row)
    if (cost !== null) {
      usd += cost
      anyPriced = true
    }
    unpricedTokens += row.unpricedTokens
    pricedTokens += Math.max(0, rowTokensTotal.total - row.unpricedTokens)
    return {
      provider: row.provider,
      model: row.model,
      tokens: rowTokensTotal,
      calls: row.calls,
      pricedCalls: row.pricedCalls,
      costUsd: cost,
      unpricedTokens: row.unpricedTokens,
      runs: row.runs,
    }
  }).sort(byUsageDesc)

  return {
    from: input.from,
    to: input.to,
    tokens,
    cost: {
      usd: anyPriced ? Math.round(usd * COST_DECIMALS) / COST_DECIMALS : null,
      pricedTokens,
      unpricedTokens,
    },
    byModel,
    byProject: input.byProject
      .map((row) => ({
        projectId: row.projectId,
        name: input.projectNames.get(row.projectId) ?? null,
        tokens: aggTokens(row),
        calls: row.calls,
        runs: row.runs,
        costUsd: aggCost(row),
        unpricedTokens: row.unpricedTokens,
      }))
      .sort((a, b) => b.tokens.total - a.tokens.total || a.projectId.localeCompare(b.projectId)),
    daily: input.daily
      .map((row) => ({
        date: row.date,
        tokens: aggTokens(row),
        calls: row.calls,
        costUsd: aggCost(row),
        unpricedTokens: row.unpricedTokens,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  }
}
