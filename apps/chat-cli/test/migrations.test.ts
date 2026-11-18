import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { MigrationError, loadMigrations, runMigrations, schemaVersion } from '../src/migrations.ts'

const url = process.env.AIFACTORY_TEST_DATABASE_URL
const skip = url === undefined || url === '' ? 'AIFACTORY_TEST_DATABASE_URL is not set' : false

function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'aifactory-migrations-'))
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql, 'utf8')
  return dir
}

test('the shipped migrations are numbered and ordered', () => {
  const migrations = loadMigrations()
  assert.ok(migrations.length >= 3)
  assert.deepEqual(migrations.map((migration) => migration.version), ['0001', '0002', '0003'])
  assert.equal(migrations[0]?.name, 'baseline')
  for (const migration of migrations) {
    assert.match(migration.checksum, /^[0-9a-f]{64}$/)
    assert.ok(migration.sql.length > 0)
  }
})

test('a badly named migration is refused', () => {
  const dir = scratch({ 'baseline.sql': 'SELECT 1;' })
  try {
    assert.throws(() => loadMigrations(dir), (error: unknown) => error instanceof MigrationError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the baseline is idempotent, so it can run on a database that already has it', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 2 })
  try {
    // Twice in a row must not throw: re-running the baseline is the pre-runner path.
    await runMigrations(pool, { force: true })
    const second = await runMigrations(pool, { force: true })
    assert.deepEqual(second.applied, [], 'nothing is re-applied')
    assert.equal(second.alreadyUpToDate, true)
    const head = await schemaVersion(pool)
    assert.ok(head.applied >= 3)
    assert.equal(head.version, '0003')
  } finally {
    await pool.end()
  }
})

test('editing an applied migration is refused instead of silently diverging', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 2 })
  const dir = mkdtempSync(join(tmpdir(), 'aifactory-changed-'))
  try {
    writeFileSync(join(dir, '0001_baseline.sql'), '-- edited after being applied\nSELECT 1;\n', 'utf8')
    // A brand-new pool with a database that already recorded the real 0001.
    await assert.rejects(
      () => runMigrations(pool, { migrations: loadMigrations(dir) }),
      (error: unknown) => error instanceof MigrationError && /changed after it was applied/.test(error.message),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await pool.end()
  }
})

test('a failing migration rolls back and records nothing', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 2 })
  const dir = scratch({
    '9999_broken.sql': 'CREATE TABLE aifactory_migration_probe (id int); SELECT no_such_column FROM nothing;\n',
  })
  try {
    const migrations = [...loadMigrations(), ...loadMigrations(dir)]
    await assert.rejects(
      () => runMigrations(pool, { migrations }),
      (error: unknown) => error instanceof MigrationError && /9999_broken failed/.test(error.message),
    )
    const exists = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'aifactory_migration_probe') AS present`,
    )
    assert.equal(exists.rows[0]?.present, false, 'the partial work was rolled back')
    const recorded = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '9999'`)
    assert.equal(recorded.rowCount, 0, 'a failed migration is not recorded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await pool.end()
  }
})

test('two instances starting together apply each migration once', { skip }, async () => {
  // A scratch schema with one pending migration, so the advisory lock actually
  // matters: without it both instances would try to create the same table.
  const setup = new Pool({ connectionString: url, max: 1 })
  const schema = `mig_${Date.now().toString(36)}`
  const dir = scratch({
    '0001_probe.sql': 'CREATE TABLE lock_probe (id int);\n',
  })
  const forSchema = () => new Pool({
    connectionString: url,
    max: 2,
    options: `-c search_path=${schema}`,
  })
  const a = forSchema()
  const b = forSchema()
  try {
    await setup.query(`CREATE SCHEMA ${schema}`)
    await setup.query(`GRANT ALL ON SCHEMA ${schema} TO CURRENT_USER`)
    const migrations = loadMigrations(dir)
    const results = await Promise.allSettled([
      runMigrations(a, { migrations, force: true }),
      runMigrations(b, { migrations, force: true }),
    ])
    for (const result of results) {
      assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '')
    }
    const applied = results
      .flatMap((result) => (result.status === 'fulfilled' ? result.value.applied : []))
    assert.deepEqual(applied, ['0001_probe'], 'exactly one instance applied it')
    const recorded = await a.query(`SELECT count(*)::int AS n FROM schema_migrations`)
    assert.equal(recorded.rows[0]?.n, 1, 'recorded once')
  } finally {
    await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
    await Promise.all([a.end(), b.end(), setup.end()])
    rmSync(dir, { recursive: true, force: true })
  }
})
