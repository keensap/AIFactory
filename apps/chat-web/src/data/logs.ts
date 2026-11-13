/**
 * Pure view logic for the project log viewer.
 *
 * Logs come from `GET /api/projects/:id/logs` (newest first, project-scoped).
 * `message`, `preview` and `payload` are untrusted model/tool output: this
 * module only produces plain strings, redacted with `redactSecrets`, that the
 * UI renders as text (never HTML).
 */

import type { LogLevel, ProjectLog, ProjectLogQuery } from '../api/types.ts'
import { LOG_LEVELS } from '../api/types.ts'
import { compareEventIds } from '../api/stageEvents.ts'
import { redactSecrets } from './activity.ts'
import { routeHref } from '../lib/router.ts'

/** Most rows kept in memory; older ones are dropped (newest win). */
export const MAX_LOGS = 2000
export const PAGE_SIZE = 100
export const LIVE_POLL_MS = 3000

export const LOG_ROLES = ['analyzer', 'author', 'reviewer'] as const
export const LOG_TYPES = [
  'role_start', 'role_end', 'role_error', 'thinking', 'text', 'tool_call', 'tool_result',
  'status', 'final', 'review_decision', 'document_created', 'human_decision', 'run_recovered',
] as const

export interface LogFilters {
  /** '' = all levels (the API filters on exactly one level). */
  level: LogLevel | ''
  role: string
  stage: string
  runId: string
  type: string
  search: string
}

export const DEFAULT_LOG_FILTERS: LogFilters = { level: '', role: '', stage: '', runId: '', type: '', search: '' }

export function filtersActive(filters: LogFilters): boolean {
  return JSON.stringify(filters) !== JSON.stringify(DEFAULT_LOG_FILTERS)
}

export function activeFilterCount(filters: LogFilters): number {
  return [filters.level, filters.role, filters.stage, filters.runId, filters.type, filters.search.trim()].filter((value) => value !== '').length
}

// ---------------------------------------------------------------------------
// URL <-> filters (shareable links)

export function filtersToSearch(filters: LogFilters): string {
  const params = new URLSearchParams()
  if (filters.level !== '') params.set('level', filters.level)
  if (filters.role !== '') params.set('role', filters.role)
  if (filters.stage !== '') params.set('stage', filters.stage)
  if (filters.runId !== '') params.set('run', filters.runId)
  if (filters.type !== '') params.set('type', filters.type)
  if (filters.search.trim() !== '') params.set('q', filters.search.trim())
  return params.toString()
}

export function filtersFromSearch(search: string): LogFilters {
  const params = new URLSearchParams(search)
  const level = params.get('level') ?? ''
  return {
    level: (LOG_LEVELS as readonly string[]).includes(level) ? level as LogLevel : '',
    role: params.get('role') ?? '',
    stage: params.get('stage') ?? '',
    runId: params.get('run') ?? '',
    type: params.get('type') ?? '',
    search: params.get('q') ?? '',
  }
}

/** Query for the API; `extra` carries paging. */
export function filtersToQuery(filters: LogFilters, extra: Pick<ProjectLogQuery, 'limit' | 'before'> = {}): ProjectLogQuery {
  const query: ProjectLogQuery = { ...extra }
  if (filters.level !== '') query.level = filters.level
  if (filters.role !== '') query.role = filters.role
  if (filters.stage !== '') query.stage = filters.stage
  if (filters.runId !== '') query.runId = filters.runId
  if (filters.type !== '') query.type = filters.type
  if (filters.search.trim() !== '') query.q = filters.search.trim()
  return query
}

// ---------------------------------------------------------------------------
// Merging (newest first)

/** Newest-first comparator on numeric ids. */
export function compareNewestFirst(a: Pick<ProjectLog, 'id'>, b: Pick<ProjectLog, 'id'>): number {
  return compareEventIds(b.id, a.id)
}

/**
 * Merge incoming logs into a newest-first list: dedupe by id, keep numeric
 * order, keep the newest `cap`. `trimmed` is true when older rows were cut.
 */
export function mergeLogs(
  existing: readonly ProjectLog[],
  incoming: readonly ProjectLog[],
  cap = MAX_LOGS,
): { logs: ProjectLog[]; trimmed: boolean } {
  if (incoming.length === 0) return { logs: existing as ProjectLog[], trimmed: false }
  const byId = new Map<string, ProjectLog>()
  for (const log of existing) byId.set(log.id, log)
  for (const log of incoming) byId.set(log.id, log)
  const merged = [...byId.values()].sort(compareNewestFirst)
  if (merged.length <= cap) return { logs: merged, trimmed: false }
  return { logs: merged.slice(0, cap), trimmed: true }
}

/** Largest (newest) id in a list, or '0'. */
export function newestId(logs: readonly ProjectLog[]): string {
  return logs.reduce((max, log) => (compareEventIds(log.id, max) > 0 ? log.id : max), '0')
}

// ---------------------------------------------------------------------------
// Display

export const LEVEL_LABEL: Record<LogLevel, string> = { error: 'Error', warn: 'Warn', info: 'Info', debug: 'Debug' }

export function redacted(text: string | null | undefined): string {
  return text === null || text === undefined ? '' : redactSecrets(text)
}

/** Pretty JSON of the payload, redacted; `{}` payloads return ''. */
export function payloadText(payload: Record<string, unknown>, redact = true): string {
  if (Object.keys(payload).length === 0) return ''
  let text: string
  try {
    text = JSON.stringify(payload, null, 2)
  } catch {
    text = String(payload)
  }
  return redact ? redactSecrets(text) : text
}

/** "Planning · run 2" style label. */
export function runLabel(log: Pick<ProjectLog, 'stage' | 'attempt'>): string {
  const stage = log.stage === '' ? 'run' : log.stage.charAt(0).toUpperCase() + log.stage.slice(1)
  return log.attempt > 0 ? `${stage} · attempt ${log.attempt}` : stage
}

/** Local "17:31:28" or "Nov 11 17:31:28" when not today. */
export function logTimestamp(iso: string, now = new Date()): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return ''
  const date = new Date(timestamp)
  const sameDay = date.toDateString() === now.toDateString()
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
}

export function fullTimestamp(iso: string): string {
  const timestamp = Date.parse(iso)
  return Number.isNaN(timestamp) ? iso : new Date(timestamp).toISOString()
}

// ---------------------------------------------------------------------------
// Export

function exportRecord(log: ProjectLog, redact: boolean): Record<string, unknown> {
  const clean = (text: string | null): string | null => (text === null ? null : redact ? redactSecrets(text) : text)
  return {
    id: log.id,
    time: log.createdAt,
    level: log.level,
    stage: log.stage,
    attempt: log.attempt,
    runId: log.stageRunId,
    role: log.role,
    type: log.type,
    message: clean(log.message),
    preview: clean(log.preview),
    payload: JSON.parse(payloadText(log.payload, redact) || '{}') as unknown,
  }
}

/** JSON Lines, oldest first, redacted unless `redact` is false. */
export function toJsonl(logs: readonly ProjectLog[], redact = true): string {
  return [...logs].sort((a, b) => compareEventIds(a.id, b.id)).map((log) => JSON.stringify(exportRecord(log, redact))).join('\n') + '\n'
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  // Neutralize spreadsheet formula injection from untrusted log text.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(logs: readonly ProjectLog[], redact = true): string {
  const columns = ['id', 'time', 'level', 'stage', 'attempt', 'runId', 'role', 'type', 'message', 'preview'] as const
  const rows = [...logs].sort((a, b) => compareEventIds(a.id, b.id)).map((log) => {
    const record = exportRecord(log, redact)
    return columns.map((column) => csvCell(record[column])).join(',')
  })
  return [columns.join(','), ...rows].join('\n') + '\n'
}

/**
 * Log viewer link for one run. Carries the run id and, when the Activity
 * drawer filters on a role or errors, the matching log filters.
 */
export function runLogsHref(
  projectId: string,
  runId: string,
  activity: { role: string; errorsOnly: boolean } = { role: 'all', errorsOnly: false },
): string {
  const role = (LOG_ROLES as readonly string[]).includes(activity.role) ? activity.role : ''
  const search = filtersToSearch({ ...DEFAULT_LOG_FILTERS, runId, role, level: activity.errorsOnly ? 'error' : '' })
  return routeHref({ name: 'logs', projectId, search })
}
