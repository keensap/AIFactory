/**
 * Numbered SQL migrations.
 *
 * The application used to create its schema from a `migrate()` method in each
 * store: eleven of them, in no enforced order, no record of what had run, and a
 * race when two instances started together. One of them took an exclusive lock on
 * every boot. This runner replaces that:
 *
 *  - `migrations/NNNN_name.sql`, applied in filename order, each in its own
 *    transaction;
 *  - every applied migration is recorded in `schema_migrations` with a checksum,
 *    so editing one after the fact fails boot instead of silently diverging;
 *  - a PostgreSQL advisory lock makes concurrent starts apply each migration once;
 *  - every migration is idempotent, so the baseline also runs harmlessly on a
 *    database that predates the runner (it creates only what is missing).
 *
 * Rule for new migrations: never edit a file that has shipped. A destructive
 * change is two migrations in two releases (add and backfill, then drop), so the
 * previous release still runs against the new schema.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'

export interface Migration {
  /** `0001`, from the filename. */
  version: string
  name: string
  sql: string
  checksum: string
}

export class MigrationError extends Error {
  readonly code = 'MIGRATION_FAILED'

  constructor(message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

const MIGRATION_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))
/** Stable key so every instance competes for the same lock. */
const ADVISORY_LOCK_KEY = 7_164_202_602

function checksum(sql: string): string {
  // Normalise line endings so a checkout on another platform is not a "change".
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

export function loadMigrations(dir: string = MIGRATION_DIR): Migration[] {
  const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()
  return files.map((file) => {
    const match = /^(\d{4})_(.+)\.sql$/.exec(file)
    if (match === null) {
      throw new MigrationError(`migration "${file}" must be named NNNN_name.sql`)
    }
    const sql = readFileSync(join(dir, file), 'utf8')
    return { version: match[1]!, name: match[2]!, sql, checksum: checksum(sql) }
  })
}

interface AppliedRow {
  version: string
  name: string
  checksum: string
}

/** Applied migrations, oldest first. Reads an empty list when the table is absent. */
async function readApplied(client: PoolClient | Pool): Promise<AppliedRow[]> {
  const exists = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'schema_migrations'
     ) AS present`,
  )
  if (exists.rows[0]?.present !== true) return []
  const result = await client.query<AppliedRow>(`SELECT version, name, checksum FROM schema_migrations ORDER BY version`)
  return result.rows
}

async function ensureTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
  `)
}

/** Pools whose schema is already at head in this process; avoids re-locking per store. */
const migrated = new WeakSet<Pool>()

export interface MigrationResult {
  applied: string[]
  alreadyUpToDate: boolean
}

/**
 * Apply every pending migration. Safe to call from several processes at once:
 * the advisory lock serialises them and the recorded versions make it idempotent.
 */
export async function runMigrations(pool: Pool, options: { migrations?: Migration[]; force?: boolean } = {}): Promise<MigrationResult> {
  if (options.force !== true && migrated.has(pool)) return { applied: [], alreadyUpToDate: true }
  const migrations = options.migrations ?? loadMigrations()
  if (migrations.length === 0) return { applied: [], alreadyUpToDate: true }

  const client = await pool.connect()
  let locked = false
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY])
    locked = true

    await ensureTable(client)

    const applied = new Map((await readApplied(client)).map((row) => [row.version, row]))
    const done: string[] = []

    for (const migration of migrations) {
      const previous = applied.get(migration.version)
      if (previous !== undefined) {
        if (previous.checksum !== migration.checksum) {
          throw new MigrationError(
            `migration ${migration.version}_${migration.name} changed after it was applied `
            + `(recorded ${previous.checksum.slice(0, 12)}, found ${migration.checksum.slice(0, 12)}). `
            + 'Add a new migration instead of editing an applied one.',
          )
        }
        continue
      }

      const started = Date.now()
      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)`,
          [migration.version, migration.name, migration.checksum, Date.now() - started],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        const message = error instanceof Error ? error.message : String(error)
        throw new MigrationError(`migration ${migration.version}_${migration.name} failed: ${message}`)
      }
      done.push(`${migration.version}_${migration.name}`)
    }

    migrated.add(pool)
    return { applied: done, alreadyUpToDate: done.length === 0 }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {})
    client.release()
  }
}

/** The head recorded in the database, for health output and tests. */
export async function schemaVersion(pool: Pool): Promise<{ version: string | null; applied: number }> {
  const applied = await readApplied(pool)
  return { version: applied.at(-1)?.version ?? null, applied: applied.length }
}