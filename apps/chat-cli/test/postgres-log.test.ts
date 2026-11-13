import assert from 'node:assert/strict'
import test from 'node:test'
import { Pool } from 'pg'
import { PostgresLogStore, PostgresSink, createLogging, runWithLogContext } from '../src/logging/index.ts'

// Integration test: set AIFACTORY_TEST_DATABASE_URL to a scratch database
// (e.g. postgres://aifactory:<pw>@127.0.0.1:5432/aifactory_test) to run it.
const url = process.env.AIFACTORY_TEST_DATABASE_URL
const skip = url === undefined || url === '' ? 'AIFACTORY_TEST_DATABASE_URL is not set' : false

async function fresh(): Promise<{ pool: Pool; store: PostgresLogStore }> {
  const pool = new Pool({ connectionString: url, max: 2 })
  await pool.query('DROP TABLE IF EXISTS app_logs')
  return { pool, store: new PostgresLogStore(url!) }
}

test('writes batches to app_logs and the store filters and pages them', { skip }, async () => {
  const { pool, store } = await fresh()
  const logging = createLogging({ service: 'itest', sinks: [new PostgresSink({ connectionString: url! })], batchSize: 50 })
  const log = logging.logger.child({ component: 'itest' })
  await runWithLogContext({ requestId: 'req-pg-1', projectId: 'proj-a', stageRunId: 'run-1', stage: 'planning' }, async () => {
    log.info({ event: 'stage.run.claimed' }, 'claimed')
    log.warn({ event: 'stage.run.lease_lost' }, 'lost')
    log.error({ event: 'stage.role.failed', role: 'reviewer', err: new Error('boom') }, 'reviewer failed')
  })
  await runWithLogContext({ projectId: 'proj-b' }, async () => { log.info({ event: 'other.project', text: 'needle%_here' }) })
  for (let i = 0; i < 30; i++) log.info({ event: 'bulk.item', i })
  assert.equal(await logging.flush({ timeoutMs: 5000 }), true)

  assert.equal(await store.count(), 34)
  const a = await store.list({ projectId: 'proj-a' })
  assert.equal(a.logs.length, 3)
  assert.equal(a.logs[0]!.event, 'stage.role.failed')
  assert.equal(a.logs[0]!.level, 'error')
  assert.equal(a.logs[0]!.requestId, 'req-pg-1')
  assert.equal(a.logs[0]!.role, 'reviewer')
  assert.equal((a.logs[0]!.record.err as Record<string, unknown>).message, 'boom')

  assert.equal((await store.list({ projectId: 'proj-a', level: 'warn' })).logs.length, 1)
  assert.equal((await store.list({ projectId: 'proj-a', minLevel: 'warn' })).logs.length, 2)
  assert.equal((await store.list({ requestId: 'req-pg-1' })).logs.length, 3)
  assert.equal((await store.list({ event: 'stage.*' })).logs.length, 3)
  assert.equal((await store.list({ event: 'bulk.item' })).logs.length, 30)
  // LIKE wildcards in user input are escaped, not interpreted.
  assert.equal((await store.list({ q: 'needle%_here' })).logs.length, 1)
  assert.equal((await store.list({ q: '%' })).logs.length, 1)

  // `id` is selected as text; ordering must still be numeric (9 before 10 before 11).
  const all = await store.list({ limit: 100 })
  const ids = all.logs.map((row) => BigInt(row.id))
  assert.ok(ids.length >= 12, 'need ids crossing a digit boundary to catch text ordering')
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i - 1]! > ids[i]!, `ids not strictly descending at ${i}: ${ids.join(',')}`)

  const page1 = await store.list({ limit: 10 })
  assert.equal(page1.logs.length, 10)
  assert.ok(page1.nextBefore)
  const page2 = await store.list({ limit: 10, before: page1.nextBefore! })
  assert.ok(BigInt(page2.logs[0]!.id) < BigInt(page1.logs.at(-1)!.id))

  await assert.rejects(() => store.list({ level: 'loud' }), /level must be one of/)
  await assert.rejects(() => store.list({ before: 'x; DROP TABLE app_logs' }), /numeric id/)
  await assert.rejects(() => store.list({ from: 'not-a-date' }), /ISO-8601/)

  assert.equal(await store.deleteProject('proj-a'), 3)
  assert.equal((await store.list({ projectId: 'proj-a' })).logs.length, 0)
  await logging.shutdown()
  await store.close()
  await pool.end()
})

test('NUL characters and huge values do not break inserts', { skip }, async () => {
  const { pool, store } = await fresh()
  const logging = createLogging({ service: 'itest', sinks: [new PostgresSink({ connectionString: url! })] })
  logging.logger.info({ event: 'nul', text: 'a\u0000b', nested: { x: 'c\u0000d' } }, 'msg\u0000end')
  logging.logger.info({ event: 'big', text: 'x'.repeat(2_000_000) })
  assert.equal(await logging.flush({ timeoutMs: 5000 }), true)
  const rows = await store.list({})
  assert.equal(rows.logs.length, 2)
  assert.equal(logging.diagnostics().sinks[0]!.failed, 0)
  await logging.shutdown()
  await store.close()
  await pool.end()
})

test('a database outage opens the breaker and the app keeps logging to other sinks', { skip }, async () => {
  const { pool, store } = await fresh()
  const memory: string[] = []
  const logging = createLogging({
    service: 'itest',
    sinks: [
      new PostgresSink({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none' }),
      { name: 'memory', write: (batch) => { memory.push(...batch.map((e) => e.line)) } },
    ],
    sinkRetry: { retries: 0 },
    breaker: { threshold: 2, cooldownMs: 60_000 },
    batchSize: 1,
    sinkTimeoutMs: 1500,
    emergency: { write: () => {}, ratePerSecond: 100 },
  })
  for (let i = 0; i < 4; i++) { logging.logger.info({ event: 'during.outage', i }); await logging.flush({ timeoutMs: 5000 }) }
  assert.equal(memory.length, 4)
  const pg = logging.diagnostics().sinks.find((s) => s.name === 'postgres')!
  assert.equal(pg.state, 'open')
  assert.ok(pg.droppedByBreaker >= 1)
  await logging.shutdown()
  await store.close()
  await pool.end()
})
