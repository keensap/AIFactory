/**
 * Persisted logging settings (`settings` table, key `logging`).
 *
 * Defaults match the confirmed design: console + rolling file always on,
 * PostgreSQL storage opt-in. `level: null` means "follow AIFACTORY_LOG_LEVEL".
 */

import { Pool } from 'pg'
import { LEVEL_NAMES, isLevel, type Level } from './levels.ts'

export interface LoggingSettings {
  /** Global minimum level, or null to follow the environment default. */
  level: Level | null
  postgres: { enabled: boolean; minLevel: Level; retentionDays: number }
  file: { retentionDays: number }
  updatedAt: string | null
}

export const DEFAULT_LOGGING_SETTINGS: LoggingSettings = {
  level: null,
  postgres: { enabled: false, minLevel: 'info', retentionDays: 14 },
  file: { retentionDays: 7 },
  updatedAt: null,
}

export const MAX_RETENTION_DAYS = 365

export class LoggingSettingsError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LoggingSettingsError'
    this.status = status
    this.code = code
  }
}

export interface LoggingSettingsStore {
  load(): Promise<LoggingSettings>
  save(settings: LoggingSettings): Promise<LoggingSettings>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readRetention(value: unknown, name: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > MAX_RETENTION_DAYS) {
    throw new LoggingSettingsError(400, 'INVALID_RETENTION', `${name} must be an integer between ${min} and ${MAX_RETENTION_DAYS}`)
  }
  return value
}

function readLevel(value: unknown, name: string): Level {
  if (!isLevel(value)) {
    throw new LoggingSettingsError(400, 'INVALID_LOG_LEVEL', `${name} must be one of ${LEVEL_NAMES.join(', ')}`)
  }
  return value
}

/** Validate a partial update and merge it over the current settings. */
export function mergeLoggingSettings(current: LoggingSettings, input: unknown): LoggingSettings {
  if (!isPlainObject(input)) throw new LoggingSettingsError(400, 'INVALID_BODY', 'request body must be a JSON object')
  const known = new Set(['level', 'postgres', 'file'])
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new LoggingSettingsError(400, 'UNKNOWN_FIELD', `unknown field "${key}"`)
  }
  if (Object.keys(input).length === 0) throw new LoggingSettingsError(400, 'NO_FIELDS', 'no settings were provided')
  const next: LoggingSettings = {
    level: current.level,
    postgres: { ...current.postgres },
    file: { ...current.file },
    updatedAt: current.updatedAt,
  }
  if ('level' in input) next.level = input.level === null ? null : readLevel(input.level, 'level')
  if ('postgres' in input) {
    const pg = input.postgres
    if (!isPlainObject(pg)) throw new LoggingSettingsError(400, 'INVALID_BODY', 'postgres must be an object')
    for (const key of Object.keys(pg)) {
      if (!['enabled', 'minLevel', 'retentionDays'].includes(key)) {
        throw new LoggingSettingsError(400, 'UNKNOWN_FIELD', `unknown field "postgres.${key}"`)
      }
    }
    if ('enabled' in pg) {
      if (typeof pg.enabled !== 'boolean') throw new LoggingSettingsError(400, 'INVALID_ENABLED', 'postgres.enabled must be a boolean')
      next.postgres.enabled = pg.enabled
    }
    if ('minLevel' in pg) next.postgres.minLevel = readLevel(pg.minLevel, 'postgres.minLevel')
    if ('retentionDays' in pg) next.postgres.retentionDays = readRetention(pg.retentionDays, 'postgres.retentionDays', 1)
  }
  if ('file' in input) {
    const file = input.file
    if (!isPlainObject(file)) throw new LoggingSettingsError(400, 'INVALID_BODY', 'file must be an object')
    for (const key of Object.keys(file)) {
      if (key !== 'retentionDays') throw new LoggingSettingsError(400, 'UNKNOWN_FIELD', `unknown field "file.${key}"`)
    }
    if ('retentionDays' in file) next.file.retentionDays = readRetention(file.retentionDays, 'file.retentionDays', 0)
  }
  return next
}

/** Tolerant parse of a stored value; anything invalid falls back to defaults. */
export function normalizeLoggingSettings(value: unknown, updatedAt: string | null): LoggingSettings {
  const base: LoggingSettings = {
    level: DEFAULT_LOGGING_SETTINGS.level,
    postgres: { ...DEFAULT_LOGGING_SETTINGS.postgres },
    file: { ...DEFAULT_LOGGING_SETTINGS.file },
    updatedAt,
  }
  if (!isPlainObject(value)) return base
  try {
    const merged = mergeLoggingSettings(base, Object.keys(value).length === 0 ? { level: null } : value)
    merged.updatedAt = updatedAt
    return merged
  } catch {
    return base
  }
}

export class PostgresLoggingSettingsStore implements LoggingSettingsStore {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 })
    this.pool.on('error', () => {})
  }

  async load(): Promise<LoggingSettings> {
    const result = await this.pool.query<{ value: unknown; updatedAt: Date | string }>(
      `SELECT value, updated_at AS "updatedAt" FROM settings WHERE key = 'logging'`,
    )
    const row = result.rows[0]
    if (row === undefined) return { ...DEFAULT_LOGGING_SETTINGS, postgres: { ...DEFAULT_LOGGING_SETTINGS.postgres }, file: { ...DEFAULT_LOGGING_SETTINGS.file } }
    const at = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date(row.updatedAt).toISOString()
    return normalizeLoggingSettings(row.value, at)
  }

  async save(settings: LoggingSettings): Promise<LoggingSettings> {
    const value = { level: settings.level, postgres: settings.postgres, file: settings.file }
    const result = await this.pool.query<{ updatedAt: Date | string }>(
      `INSERT INTO settings (key, value, updated_at) VALUES ('logging', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING updated_at AS "updatedAt"`,
      [JSON.stringify(value)],
    )
    const at = result.rows[0]!.updatedAt
    return { ...settings, updatedAt: at instanceof Date ? at.toISOString() : new Date(at).toISOString() }
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {})
  }
}
