import { Pool } from 'pg'
import { logSinkPool } from '../../db.ts'
import type { LogEvent, LogRecord } from '../event.ts'
import { LEVEL_VALUE, type Level } from '../levels.ts'
import type { LogSink } from '../sink.ts'

/** Idempotent DDL shared by the sink and the query store. */
export const APP_LOGS_DDL = `
  CREATE TABLE IF NOT EXISTS app_logs (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL,
    level TEXT NOT NULL,
    level_value SMALLINT NOT NULL,
    event TEXT,
    component TEXT,
    message TEXT,
    request_id TEXT,
    trace_id TEXT,
    project_id TEXT,
    stage_run_id TEXT,
    stage TEXT,
    role TEXT,
    service TEXT,
    record JSONB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS app_logs_ts_idx ON app_logs (ts DESC);
  CREATE INDEX IF NOT EXISTS app_logs_project_idx ON app_logs (project_id, id DESC);
  CREATE INDEX IF NOT EXISTS app_logs_level_idx ON app_logs (level_value, id DESC);
  CREATE INDEX IF NOT EXISTS app_logs_event_idx ON app_logs (event);
  CREATE INDEX IF NOT EXISTS app_logs_request_idx ON app_logs (request_id);
  CREATE INDEX IF NOT EXISTS app_logs_run_idx ON app_logs (stage_run_id);
`

export interface PostgresSinkOptions {
  connectionString: string
  minLevel?: Level
  /** Delete rows older than this many days (default 14). 0 disables deletion. */
  retentionDays?: number
  /** Rows per INSERT statement (default 200). */
  batchRows?: number
  /** Injectable pool for tests. */
  pool?: Pool
}

const COLUMNS = 14

/** Postgres rejects NUL characters in text and JSONB, so strip them. */
function noNul(value: string | null | undefined): string | null {
  return typeof value === 'string' ? value.replace(/\u0000/g, '') : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? noNul(value) : null
}

function recordJson(record: LogRecord): string {
  return JSON.stringify(record, (_key, value: unknown) => (typeof value === 'string' ? value.replace(/\u0000/g, '') : value))
}

/**
 * Batched PostgreSQL sink. It owns a small private pool so logging can never
 * exhaust the application's connection pool, and it is opt-in (enabled from
 * settings). Outages are handled by the sink runner's retry and circuit breaker.
 */
export class PostgresSink implements LogSink {
  readonly name = 'postgres'
  readonly spool = true
  readonly minLevel?: Level
  private readonly pool: Pool
  private readonly ownsPool: boolean
  private readonly retentionDays: number
  private readonly batchRows: number
  private schema: Promise<void> | undefined
  private lastCleanup = 0

  constructor(options: PostgresSinkOptions) {
    if (options.minLevel !== undefined) this.minLevel = options.minLevel
    this.retentionDays = options.retentionDays ?? 14
    this.batchRows = Math.max(1, Math.min(options.batchRows ?? 200, 1000))
    this.ownsPool = false
    // The log sink keeps its own small pool so a slow or blocked log write can
    // never take a connection away from a request (AR-12).
    this.pool = options.pool ?? logSinkPool(options.connectionString)
    // An idle-client error (e.g. server restart) must not become an unhandled 'error' event.
    this.pool.on('error', () => {})
  }

  async write(batch: readonly LogEvent[], signal: AbortSignal): Promise<void> {
    await this.ensureSchema()
    for (let start = 0; start < batch.length; start += this.batchRows) {
      if (signal.aborted) throw new Error('aborted')
      await this.insert(batch.slice(start, start + this.batchRows))
    }
    void this.maybeCleanup()
  }

  async close(): Promise<void> {
    // The pool is shared and closed once at shutdown; nothing per sink.
    if (this.ownsPool) await this.pool.end().catch(() => {})
  }

  private ensureSchema(): Promise<void> {
    this.schema ??= this.pool.query(APP_LOGS_DDL).then(() => undefined).catch((error: unknown) => {
      this.schema = undefined
      throw error
    })
    return this.schema
  }

  private async insert(events: readonly LogEvent[]): Promise<void> {
    const values: unknown[] = []
    const groups: string[] = []
    for (const event of events) {
      const record = event.record
      const ts = typeof record.ts === 'string' && !Number.isNaN(Date.parse(record.ts)) ? record.ts : new Date().toISOString()
      values.push(
        ts,
        event.level,
        LEVEL_VALUE[event.level],
        str(record.event),
        str(record.component),
        str(record.msg),
        str(record.requestId),
        str(record.traceId),
        str(record.projectId),
        str(record.stageRunId),
        str(record.stage),
        str(record.role),
        str(record.service),
        recordJson(record),
      )
      const base = values.length - COLUMNS
      const placeholders: string[] = []
      for (let i = 1; i <= COLUMNS; i++) placeholders.push(i === COLUMNS ? `$${base + i}::jsonb` : `$${base + i}`)
      groups.push(`(${placeholders.join(',')})`)
    }
    await this.pool.query(
      `INSERT INTO app_logs
         (ts, level, level_value, event, component, message, request_id, trace_id,
          project_id, stage_run_id, stage, role, service, record)
       VALUES ${groups.join(',')}`,
      values,
    )
  }

  private async maybeCleanup(): Promise<void> {
    if (this.retentionDays <= 0) return
    const now = Date.now()
    if (now - this.lastCleanup < 60 * 60 * 1000) return
    this.lastCleanup = now
    try {
      for (let i = 0; i < 20; i++) {
        const result = await this.pool.query(
          `DELETE FROM app_logs WHERE id IN (
             SELECT id FROM app_logs WHERE ts < now() - ($1::int * interval '1 day') LIMIT 5000)`,
          [this.retentionDays],
        )
        if ((result.rowCount ?? 0) < 5000) break
      }
    } catch {
      // Retention is best-effort.
    }
  }
}
