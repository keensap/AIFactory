/**
 * Read/admin access to the `app_logs` table for the log viewer API.
 *
 * Independent of the sink's lifecycle: existing rows stay queryable after the
 * PostgreSQL sink is switched off in settings.
 */

import { Pool } from 'pg'
import { LEVEL_NAMES, LEVEL_VALUE, isLevel, type Level } from './levels.ts'
import { APP_LOGS_DDL } from './sinks/postgres.ts'

export interface AppLog {
  id: string
  ts: string
  level: Level
  event: string | null
  component: string | null
  message: string
  requestId: string | null
  traceId: string | null
  projectId: string | null
  stageRunId: string | null
  stage: string | null
  role: string | null
  record: Record<string, unknown>
}

export interface AppLogFilter {
  limit?: number
  /** Numeric id cursor: return rows with a smaller id. */
  before?: string
  /** ISO timestamp cursor: return rows older than this instant. */
  beforeTs?: string
  level?: string
  minLevel?: string
  /** Exact event, or a prefix when it ends with `*`. */
  event?: string
  component?: string
  projectId?: string
  stageRunId?: string
  requestId?: string
  role?: string
  q?: string
  from?: string
  to?: string
}

export class LogStoreError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LogStoreError'
    this.status = status
    this.code = code
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function isoOrThrow(value: string, name: string): string {
  const time = Date.parse(value)
  if (Number.isNaN(time)) throw new LogStoreError(400, 'INVALID_TIME', `${name} must be an ISO-8601 timestamp`)
  return new Date(time).toISOString()
}

export class PostgresLogStore {
  private readonly pool: Pool
  private ready: Promise<void> | undefined

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 3 })
    this.pool.on('error', () => {})
  }

  async ensureSchema(): Promise<void> {
    this.ready ??= this.pool.query(APP_LOGS_DDL).then(() => undefined).catch((error: unknown) => {
      this.ready = undefined
      throw error
    })
    await this.ready
  }

  async list(filter: AppLogFilter): Promise<{ logs: AppLog[]; nextBefore: string | null }> {
    await this.ensureSchema()
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
    const where: string[] = []
    const values: unknown[] = []
    const add = (clause: string, value: unknown): void => {
      values.push(value)
      where.push(clause.replaceAll('?', `$${values.length}`))
    }
    if (filter.before !== undefined) {
      if (!/^\d{1,18}$/.test(filter.before)) throw new LogStoreError(400, 'INVALID_CURSOR', 'before must be a numeric id')
      add('id < ?::bigint', filter.before)
    }
    if (filter.beforeTs !== undefined) add('ts < ?::timestamptz', isoOrThrow(filter.beforeTs, 'before'))
    if (filter.level !== undefined) {
      if (!isLevel(filter.level)) throw new LogStoreError(400, 'INVALID_LOG_LEVEL', `level must be one of ${LEVEL_NAMES.join(', ')}`)
      add('level = ?', filter.level)
    }
    if (filter.minLevel !== undefined) {
      if (!isLevel(filter.minLevel)) throw new LogStoreError(400, 'INVALID_LOG_LEVEL', `minLevel must be one of ${LEVEL_NAMES.join(', ')}`)
      add('level_value >= ?', LEVEL_VALUE[filter.minLevel])
    }
    if (filter.event !== undefined && filter.event !== '') {
      if (filter.event.endsWith('*')) add(`event LIKE ? ESCAPE '\\'`, `${escapeLike(filter.event.slice(0, -1))}%`)
      else add('event = ?', filter.event)
    }
    if (filter.component) add('component = ?', filter.component)
    if (filter.projectId) add('project_id = ?', filter.projectId)
    if (filter.stageRunId) add('stage_run_id = ?', filter.stageRunId)
    if (filter.requestId) add('request_id = ?', filter.requestId)
    if (filter.role) add('role = ?', filter.role)
    if (filter.from) add('ts >= ?::timestamptz', isoOrThrow(filter.from, 'from'))
    if (filter.to) add('ts < ?::timestamptz', isoOrThrow(filter.to, 'to'))
    if (filter.q !== undefined && filter.q.trim() !== '') {
      values.push(`%${escapeLike(filter.q.trim())}%`)
      const index = values.length
      where.push(`(message ILIKE $${index} ESCAPE '\\' OR event ILIKE $${index} ESCAPE '\\' OR record::text ILIKE $${index} ESCAPE '\\')`)
    }
    values.push(limit)
    const result = await this.pool.query<{
      id: string
      ts: Date | string
      level: Level
      event: string | null
      component: string | null
      message: string | null
      requestId: string | null
      traceId: string | null
      projectId: string | null
      stageRunId: string | null
      stage: string | null
      role: string | null
      record: Record<string, unknown>
    }>(
      `SELECT id::text AS id, ts, level, event, component, message,
              request_id AS "requestId", trace_id AS "traceId", project_id AS "projectId",
              stage_run_id AS "stageRunId", stage, role, record
       FROM app_logs
       ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
       ORDER BY app_logs.id DESC
       LIMIT $${values.length}`,
      values,
    )
    const logs: AppLog[] = result.rows.map((row) => ({
      id: row.id,
      ts: row.ts instanceof Date ? row.ts.toISOString() : new Date(row.ts).toISOString(),
      level: row.level,
      event: row.event,
      component: row.component,
      message: row.message ?? row.event ?? '',
      requestId: row.requestId,
      traceId: row.traceId,
      projectId: row.projectId,
      stageRunId: row.stageRunId,
      stage: row.stage,
      role: row.role,
      record: row.record,
    }))
    return { logs, nextBefore: logs.length === limit ? logs.at(-1)?.id ?? null : null }
  }

  async count(): Promise<number> {
    await this.ensureSchema()
    const result = await this.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM app_logs')
    return Number(result.rows[0]?.count ?? 0)
  }

  /** Remove every row for a project (called when the project is deleted). */
  async deleteProject(projectId: string): Promise<number> {
    await this.ensureSchema()
    const result = await this.pool.query('DELETE FROM app_logs WHERE project_id = $1', [projectId])
    return result.rowCount ?? 0
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {})
  }
}
