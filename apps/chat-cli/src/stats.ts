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
  /** Wall-clock time from run start to completion/update (may include human wait). */
  runDurationMs: DurationStats
  /** Sum of actual role execution times (analyzer/author/reviewer). */
  activeDurationMs: DurationStats
  byRole: Array<{
    role: string
    runs: number
    attempts: number
    tokens: TokenTotals
    durationMs: DurationStats
  }>
  byStage: Array<{
    stage: string
    runs: number
    tokens: TokenTotals
    activeDurationMs: DurationStats
  }>
  daily: Array<{
    date: string
    runs: number
    tokens: TokenTotals
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
    durations: number[]
  }>()
  const stageTotals = new Map<string, {
    stage: string
    runs: Set<string>
    tokens: TokenTotals
    durations: number[]
  }>()
  const daily = new Map<string, { date: string; runs: Set<string>; tokens: TokenTotals; activeDurationMs: number }>()
  const totals = emptyTokens()
  const runTokens = new Map<string, TokenTotals>()
  const runRoles = new Map<string, Set<string>>()
  const runActive = new Map<string, number>()

  for (const row of input.tokens) {
    const tokens: TokenTotals = {
      input: row.input,
      output: row.output,
      total: row.total > 0 ? row.total : row.input + row.output + row.cacheRead + row.cacheWrite,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
    }
    addTokens(totals, tokens)
    const existing = tokenByRun.get(row.stageRunId) ?? emptyTokens()
    addTokens(existing, tokens)
    tokenByRun.set(row.stageRunId, existing)
    const role = roleTotals.get(row.role) ?? { role: row.role, runs: new Set<string>(), attempts: 0, tokens: emptyTokens(), durations: [] }
    addTokens(role.tokens, tokens)
    role.runs.add(row.stageRunId)
    roleTotals.set(row.role, role)
    const stage = stageTotals.get(row.stage) ?? { stage: row.stage, runs: new Set<string>(), tokens: emptyTokens(), durations: [] }
    addTokens(stage.tokens, tokens)
    stage.runs.add(row.stageRunId)
    stageTotals.set(row.stage, stage)
    const runToken = runTokens.get(row.stageRunId) ?? emptyTokens()
    addTokens(runToken, tokens)
    runTokens.set(row.stageRunId, runToken)
    const roles = runRoles.get(row.stageRunId) ?? new Set<string>()
    roles.add(row.role)
    runRoles.set(row.stageRunId, roles)
  }

  for (const row of input.roles) {
    const role = roleTotals.get(row.role) ?? { role: row.role, runs: new Set<string>(), attempts: 0, tokens: emptyTokens(), durations: [] }
    role.attempts += row.attempts
    if (row.durationMs > 0) role.durations.push(row.durationMs)
    role.runs.add(row.stageRunId)
    roleTotals.set(row.role, role)
    const stage = stageTotals.get(row.stage) ?? { stage: row.stage, runs: new Set<string>(), tokens: emptyTokens(), durations: [] }
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
    const stage = stageTotals.get(run.stage) ?? { stage: run.stage, runs: new Set<string>(), tokens: emptyTokens(), durations: [] }
    stage.runs.add(run.id)
    if (active > 0) stage.durations.push(active)
    stageTotals.set(run.stage, stage)
    const day = dateOf(run.startedAt ?? run.createdAt)
    const entry = daily.get(day) ?? { date: day, runs: new Set<string>(), tokens: emptyTokens(), activeDurationMs: 0 }
    entry.runs.add(run.id)
    entry.activeDurationMs += active
    daily.set(day, entry)
  }
  for (const [runId, tokens] of tokenByRun) {
    const run = input.runs.find((candidate) => candidate.id === runId)
    if (run === undefined) continue
    const entry = daily.get(dateOf(run.startedAt ?? run.createdAt))
    if (entry !== undefined) addTokens(entry.tokens, tokens)
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
    runDurationMs: durationStats(runDurations),
    activeDurationMs: durationStats(activeDurations),
    byRole: [...roleTotals.values()]
      .map((entry) => ({
        role: entry.role,
        runs: entry.runs.size,
        attempts: entry.attempts,
        tokens: entry.tokens,
        durationMs: durationStats(entry.durations),
      }))
      .sort((a, b) => a.role.localeCompare(b.role)),
    byStage: [...stageTotals.values()]
      .map((entry) => ({
        stage: entry.stage as never,
        runs: entry.runs.size,
        tokens: entry.tokens,
        activeDurationMs: durationStats(entry.durations),
      }))
      .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage)),
    daily: [...daily.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((entry) => ({ date: entry.date, runs: entry.runs.size, tokens: entry.tokens, activeDurationMs: entry.activeDurationMs })),
    recentRuns,
  }
}
