/**
 * Chat-level settings.
 *
 * The only setting today is the maximum number of simultaneously active
 * projects. The default is 3. Settings are stored in PostgreSQL so every API
 * instance sees the same limit.
 */

import { Pool } from 'pg'
import { sharedPool } from './db.ts'
import { runMigrations } from './migrations.ts'

export const DEFAULT_MAX_ACTIVE_PROJECTS = 3
export const MIN_MAX_ACTIVE_PROJECTS = 1
export const MAX_MAX_ACTIVE_PROJECTS = 1000

export interface ChatSettings {
  maxActiveProjects: number
  updatedAt: string
}

export interface SettingsReader {
  get(): Promise<ChatSettings>
}

export interface SettingsStore {
  get(): Promise<ChatSettings>
  update(maxActiveProjects: number, activeProjects: number): Promise<ChatSettings>
  close?(): Promise<void>
}

export class SettingsError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'SettingsError'
    this.status = status
    this.code = code
  }
}

export class SettingsService implements SettingsReader {
  private readonly store: SettingsStore

  constructor(store: SettingsStore) {
    this.store = store
  }

  async get(): Promise<ChatSettings> {
    return this.store.get()
  }

  async update(input: unknown, activeProjects: number): Promise<ChatSettings> {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new SettingsError(400, 'INVALID_BODY', 'request body must be a JSON object')
    }
    const record = input as Record<string, unknown>
    if (record.maxActiveProjects === undefined) {
      throw new SettingsError(400, 'NO_FIELDS', 'maxActiveProjects is required')
    }

    const value = record.maxActiveProjects
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new SettingsError(400, 'INVALID_MAX_ACTIVE_PROJECTS', 'maxActiveProjects must be an integer')
    }
    if (value < MIN_MAX_ACTIVE_PROJECTS || value > MAX_MAX_ACTIVE_PROJECTS) {
      throw new SettingsError(
        400,
        'INVALID_MAX_ACTIVE_PROJECTS',
        `maxActiveProjects must be between ${MIN_MAX_ACTIVE_PROJECTS} and ${MAX_MAX_ACTIVE_PROJECTS}`,
      )
    }
    if (activeProjects > value) {
      throw new SettingsError(
        409,
        'ACTIVE_LIMIT_BELOW_ACTIVE',
        `${activeProjects} projects are active; deactivate or archive some before lowering the limit to ${value}`,
      )
    }

    return this.store.update(value, activeProjects)
  }
}

export class PostgresSettingsStore implements SettingsStore {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = sharedPool(connectionString)
  }

  async migrate(): Promise<void> {
    await runMigrations(this.pool)
    // Reference data that must exist for the API to behave; not schema.
    await this.pool.query(
      `INSERT INTO settings (key, value) VALUES ('max_active_projects', '3'::jsonb)
       ON CONFLICT (key) DO NOTHING`,
    )
  }


  async get(): Promise<ChatSettings> {
    const result = await this.pool.query<{ value: unknown; updatedAt: Date | string }>(
      `SELECT value, updated_at AS "updatedAt" FROM settings WHERE key = 'max_active_projects'`,
    )
    const row = result.rows[0]
    if (row === undefined) {
      return { maxActiveProjects: DEFAULT_MAX_ACTIVE_PROJECTS, updatedAt: new Date().toISOString() }
    }
    return {
      maxActiveProjects: normalizeMax(row.value),
      updatedAt: toIso(row.updatedAt),
    }
  }

  async update(maxActiveProjects: number, _activeProjects: number): Promise<ChatSettings> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtext('aifactory:active-projects'))")
      const count = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM projects WHERE status = 'active'",
      )
      if (count.rows[0]!.count > maxActiveProjects) {
        throw new SettingsError(
          409,
          'ACTIVE_LIMIT_BELOW_ACTIVE',
          `${count.rows[0]!.count} projects are active; deactivate or archive some before lowering the limit to ${maxActiveProjects}`,
        )
      }
      const result = await client.query<{ value: unknown; updatedAt: Date | string }>(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ('max_active_projects', $1::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
         RETURNING value, updated_at AS "updatedAt"`,
        [String(maxActiveProjects)],
      )
      await client.query('COMMIT')
      return {
        maxActiveProjects: normalizeMax(result.rows[0]!.value),
        updatedAt: toIso(result.rows[0]!.updatedAt),
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    // The pool is shared and closed once at shutdown (db.closeSharedPools).
  }
}

function normalizeMax(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed >= MIN_MAX_ACTIVE_PROJECTS && parsed <= MAX_MAX_ACTIVE_PROJECTS
    ? parsed
    : DEFAULT_MAX_ACTIVE_PROJECTS
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
