import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshHarness } from '../src/harness.ts'
import {
  DEFAULT_LOGGING_SETTINGS,
  FileSink,
  LoggingManager,
  LoggingSettingsError,
  createLogging,
  mergeLoggingSettings,
  normalizeLoggingSettings,
  type LogEvent,
  type LogSink,
  type LoggingSettings,
  type LoggingSettingsStore,
} from '../src/logging/index.ts'
import { createChatServer, serverPort } from '../src/server.ts'
import { SessionStore } from '../src/store.ts'

class MemorySettingsStore implements LoggingSettingsStore {
  saved: LoggingSettings | undefined
  async load(): Promise<LoggingSettings> { return this.saved ?? { ...DEFAULT_LOGGING_SETTINGS } }
  async save(settings: LoggingSettings): Promise<LoggingSettings> {
    this.saved = { ...settings, updatedAt: new Date().toISOString() }
    return this.saved
  }
}

class MemorySink implements LogSink {
  readonly name = 'memory'
  readonly events: LogEvent[] = []
  write(batch: readonly LogEvent[]): void { this.events.push(...batch) }
}

function expectError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof LoggingSettingsError && error.code === code, `expected ${code}`)
}

test('settings defaults match the confirmed design', () => {
  assert.equal(DEFAULT_LOGGING_SETTINGS.level, null)
  assert.equal(DEFAULT_LOGGING_SETTINGS.postgres.enabled, false)
  assert.equal(DEFAULT_LOGGING_SETTINGS.postgres.retentionDays, 14)
  assert.equal(DEFAULT_LOGGING_SETTINGS.file.retentionDays, 7)
})

test('merges partial updates and validates every field', () => {
  const base = { ...DEFAULT_LOGGING_SETTINGS }
  const merged = mergeLoggingSettings(base, { level: 'debug', postgres: { enabled: true, retentionDays: 30 } })
  assert.equal(merged.level, 'debug')
  assert.equal(merged.postgres.enabled, true)
  assert.equal(merged.postgres.retentionDays, 30)
  assert.equal(merged.postgres.minLevel, 'info')
  assert.equal(merged.file.retentionDays, 7)
  assert.equal(mergeLoggingSettings(merged, { level: null }).level, null)
  assert.equal(base.postgres.enabled, false, 'input is not mutated')

  expectError(() => mergeLoggingSettings(base, null), 'INVALID_BODY')
  expectError(() => mergeLoggingSettings(base, []), 'INVALID_BODY')
  expectError(() => mergeLoggingSettings(base, {}), 'NO_FIELDS')
  expectError(() => mergeLoggingSettings(base, { nope: 1 }), 'UNKNOWN_FIELD')
  expectError(() => mergeLoggingSettings(base, { level: 'loud' }), 'INVALID_LOG_LEVEL')
  expectError(() => mergeLoggingSettings(base, { postgres: { enabled: 'yes' } }), 'INVALID_ENABLED')
  expectError(() => mergeLoggingSettings(base, { postgres: { minLevel: 'x' } }), 'INVALID_LOG_LEVEL')
  expectError(() => mergeLoggingSettings(base, { postgres: { retentionDays: 0 } }), 'INVALID_RETENTION')
  expectError(() => mergeLoggingSettings(base, { postgres: { retentionDays: 1.5 } }), 'INVALID_RETENTION')
  expectError(() => mergeLoggingSettings(base, { postgres: { retentionDays: 9999 } }), 'INVALID_RETENTION')
  expectError(() => mergeLoggingSettings(base, { postgres: { bogus: 1 } }), 'UNKNOWN_FIELD')
  expectError(() => mergeLoggingSettings(base, { file: { retentionDays: -1 } }), 'INVALID_RETENTION')
  expectError(() => mergeLoggingSettings(base, { file: 'x' }), 'INVALID_BODY')
  assert.equal(mergeLoggingSettings(base, { file: { retentionDays: 0 } }).file.retentionDays, 0)
})

test('corrupt stored settings fall back to defaults instead of failing startup', () => {
  assert.deepEqual(normalizeLoggingSettings('garbage', null).postgres, DEFAULT_LOGGING_SETTINGS.postgres)
  assert.equal(normalizeLoggingSettings({ level: 'loud' }, null).level, null)
  assert.equal(normalizeLoggingSettings({ level: 'warn', postgres: { enabled: true } }, 'now').level, 'warn')
})

test('manager hot-adds and removes the PostgreSQL sink and applies level changes', async () => {
  const sink = new MemorySink()
  const logging = createLogging({ service: 't', sinks: [sink] })
  const store = new MemorySettingsStore()
  const manager = new LoggingManager({
    logging,
    environmentLevel: 'info',
    settingsStore: store,
    databaseUrl: 'postgres://u:p@127.0.0.1:1/none',
  })
  await manager.init()
  assert.equal(manager.view().postgresActive, false)

  const enabled = await manager.update({ postgres: { enabled: true, minLevel: 'warn' }, level: 'debug' })
  assert.equal(enabled.postgres.enabled, true)
  assert.ok(logging.diagnostics().sinks.some((s) => s.name === 'postgres'))
  assert.equal(logging.levels.snapshot().level, 'debug')
  assert.equal(store.saved?.postgres.minLevel, 'warn')

  // Reconfigure replaces the sink without duplicating it.
  await manager.update({ postgres: { retentionDays: 3 } })
  assert.equal(logging.diagnostics().sinks.filter((s) => s.name === 'postgres').length, 1)

  const disabled = await manager.update({ postgres: { enabled: false }, level: null })
  assert.equal(disabled.postgres.enabled, false)
  assert.ok(!logging.diagnostics().sinks.some((s) => s.name === 'postgres'))
  assert.equal(logging.levels.snapshot().level, 'info', 'null level follows the environment default')
  await logging.shutdown()
})

test('manager rejects PostgreSQL storage when no database is configured', async () => {
  const logging = createLogging({ service: 't', sinks: [new MemorySink()] })
  const manager = new LoggingManager({ logging, environmentLevel: 'info' })
  await assert.rejects(
    () => manager.update({ postgres: { enabled: true } }),
    (error: unknown) => error instanceof LoggingSettingsError && error.code === 'POSTGRES_UNAVAILABLE' && error.status === 409,
  )
  assert.equal(manager.settings().postgres.enabled, false)
  await logging.shutdown()
})

test('persists settings and applies saved level on the next start', async () => {
  const store = new MemorySettingsStore()
  const first = createLogging({ service: 't', sinks: [new MemorySink()] })
  await new LoggingManager({ logging: first, environmentLevel: 'info', settingsStore: store }).update({ level: 'error', file: { retentionDays: 3 } })
  await first.shutdown()

  const second = createLogging({ service: 't', sinks: [new MemorySink()] })
  const restarted = new LoggingManager({ logging: second, environmentLevel: 'info', settingsStore: store })
  await restarted.init()
  assert.equal(second.levels.snapshot().level, 'error')
  assert.equal(restarted.settings().file.retentionDays, 3)
  await second.shutdown()
})

test('updates file retention on the live file sink', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aifactory-retention-'))
  const fileSink = new FileSink({ directory: dir, retentionDays: 7 })
  const logging = createLogging({ service: 't', sinks: [fileSink] })
  const manager = new LoggingManager({ logging, environmentLevel: 'info', settingsStore: new MemorySettingsStore(), fileSink })
  await manager.update({ file: { retentionDays: 2 } })
  assert.equal(manager.view().fileSink.active, true)
  assert.match(manager.view().fileSink.path ?? '', /aifactory-\d{4}-\d{2}-\d{2}\.jsonl$/)
  await logging.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

test('runtime level changes support TTL auto-revert, component overrides and validation', async () => {
  const sink = new MemorySink()
  const logging = createLogging({ service: 't', sinks: [sink] })
  const manager = new LoggingManager({ logging, environmentLevel: 'info' })

  const temp = manager.setRuntimeLevel({ level: 'trace', ttlSeconds: 1 })
  assert.equal(temp.level, 'trace')
  assert.ok(temp.revertAt)
  logging.logger.trace({ event: 'visible.now' })

  manager.setRuntimeLevel({ level: 'error', component: 'noisy' })
  logging.logger.child({ component: 'noisy' }).warn({ event: 'hidden' })
  assert.equal(manager.setRuntimeLevel({ level: null, component: 'noisy' }).override.noisy, undefined)

  expectError(() => manager.setRuntimeLevel({ level: 'loud' as never }), 'INVALID_LOG_LEVEL')
  expectError(() => manager.setRuntimeLevel({ level: 'debug', ttlSeconds: 0 }), 'INVALID_TTL')
  expectError(() => manager.setRuntimeLevel({ level: 'debug', ttlSeconds: 999_999 }), 'INVALID_TTL')
  expectError(() => manager.setRuntimeLevel({ level: 'debug', component: 'a b' }), 'INVALID_COMPONENT')
  expectError(() => manager.setRuntimeLevel({ level: 'debug', component: 'x', ttlSeconds: 5 }), 'TTL_NOT_SUPPORTED')

  await logging.flush()
  const events = sink.events.map((e) => e.record.event)
  assert.ok(events.includes('visible.now'))
  assert.ok(!events.includes('hidden'))
  assert.ok(events.includes('logging.level_changed'), 'level changes are audited as events')
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.equal(logging.levels.snapshot().level, 'info', 'TTL reverted the global level')
  await logging.shutdown()
})

async function withApi(
  run: (base: string) => Promise<void>,
  options: { apiToken?: string; withManager?: boolean } = {},
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-logapi-'))
  const logging = createLogging({ service: 't', sinks: [new MemorySink()] })
  const manager = new LoggingManager({ logging, environmentLevel: 'info', settingsStore: new MemorySettingsStore() })
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    logger: logging.logger,
    ...(options.withManager === false ? {} : { loggingManager: manager }),
    ...(options.apiToken !== undefined ? { apiToken: options.apiToken } : {}),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    await run(`http://127.0.0.1:${serverPort(server)}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await logging.shutdown()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

const json = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

test('logging settings, admin and level endpoints', async () => {
  await withApi(async (base) => {
    const got = await (await fetch(`${base}/api/settings/logging`)).json() as { settings: LoggingSettings; postgresAvailable: boolean }
    assert.equal(got.settings.postgres.enabled, false)
    assert.equal(got.postgresAvailable, false)

    const patched = await fetch(`${base}/api/settings/logging`, { method: 'PATCH', ...json({ level: 'debug', file: { retentionDays: 5 } }) })
    assert.equal(patched.status, 200)
    assert.equal(((await patched.json()) as { settings: LoggingSettings }).settings.level, 'debug')

    const bad = await fetch(`${base}/api/settings/logging`, { method: 'PATCH', ...json({ level: 'loud' }) })
    assert.equal(bad.status, 400)
    assert.equal(((await bad.json()) as { error: { code: string } }).error.code, 'INVALID_LOG_LEVEL')

    const noDb = await fetch(`${base}/api/settings/logging`, { method: 'PATCH', ...json({ postgres: { enabled: true } }) })
    assert.equal(noDb.status, 409)

    const admin = await (await fetch(`${base}/api/admin/logging`)).json() as { logging: { levels: { level: string }; diagnostics: { sinks: unknown[]; queue: unknown } } }
    assert.equal(admin.logging.levels.level, 'debug')
    assert.ok(Array.isArray(admin.logging.diagnostics.sinks))

    const level = await fetch(`${base}/api/admin/logging/level`, { method: 'PUT', ...json({ level: 'trace', ttlSeconds: 60 }) })
    assert.equal(level.status, 200)
    const { levels } = await level.json() as { levels: { level: string; revertAt: string | null } }
    assert.equal(levels.level, 'trace')
    assert.ok(levels.revertAt)

    assert.equal((await fetch(`${base}/api/admin/logging/level`, { method: 'PUT', ...json({ ttlSeconds: 5 }) })).status, 400)
    assert.equal((await fetch(`${base}/api/admin/logging/level`, { method: 'PUT', ...json({ level: 'debug', ttlSeconds: -1 }) })).status, 400)
  })
})

test('log query routes report 503 when log storage is not configured', async () => {
  await withApi(async (base) => {
    const logs = await fetch(`${base}/api/logs`)
    assert.equal(logs.status, 503)
    assert.equal(((await logs.json()) as { error: { code: string } }).error.code, 'LOG_STORE_NOT_CONFIGURED')
  })
})

test('logging control routes return 503 without a manager and honour the bearer token', async () => {
  await withApi(async (base) => {
    assert.equal((await fetch(`${base}/api/admin/logging`)).status, 503)
    assert.equal((await fetch(`${base}/api/settings/logging`)).status, 503)
  }, { withManager: false })

  await withApi(async (base) => {
    assert.equal((await fetch(`${base}/api/admin/logging`)).status, 401)
    const ok = await fetch(`${base}/api/admin/logging`, { headers: { Authorization: 'Bearer s3cret-token' } })
    assert.equal(ok.status, 200)
  }, { apiToken: 's3cret-token' })
})

test('CORS preflight allows PUT for the level endpoint', async () => {
  await withApi(async (base) => {
    const response = await fetch(`${base}/api/admin/logging/level`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } })
    assert.equal(response.status, 204)
    assert.match(response.headers.get('access-control-allow-methods') ?? '', /PUT/)
  })
})
