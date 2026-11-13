import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  FileSpool,
  OtlpLogsSink,
  createLogging,
  toOtlpPayload,
  type LogEvent,
  type LogSink,
} from '../src/logging/index.ts'

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'aifactory-spool-'))
}

class FakeSink implements LogSink {
  readonly name = 'flaky'
  readonly spool = true
  readonly events: LogEvent[] = []
  failing = true
  attempts = 0
  write(batch: readonly LogEvent[]): void {
    this.attempts += 1
    if (this.failing) throw new Error('backend down')
    this.events.push(...batch)
  }
}

test('spool appends, takes, commits and requeues segments', async () => {
  const directory = dir()
  const spool = new FileSpool({ directory })
  const logging = createLogging({ service: 't', sinks: [] })
  logging.logger.info({ event: 'one' })
  await logging.flush()
  await spool.append([{ levelValue: 30, line: '{"event":"one"}' } as never, { levelValue: 50, line: '{"event":"two"}' } as never])
  assert.equal(spool.stats().files, 1)
  const first = await spool.take()
  assert.ok(first)
  assert.equal(first.events.length, 2)
  assert.equal(first.events[0]!.record.event, 'one')
  await first.requeue()
  assert.equal(spool.stats().files, 1)
  const second = await spool.take()
  assert.ok(second)
  await second.commit()
  assert.equal(spool.stats().files, 0)
  assert.equal(spool.stats().replayed, 2)
  await logging.shutdown()
  rmSync(directory, { recursive: true, force: true })
})

test('spool skips torn lines and enforces its file cap', async () => {
  const directory = dir()
  const spool = new FileSpool({ directory, maxFiles: 4 })
  for (let i = 0; i < 8; i++) {
    await spool.append([{ levelValue: 30, line: `{"event":"e${i}"}` } as never])
  }
  const stats = spool.stats()
  assert.equal(stats.files, 4)
  assert.equal(stats.droppedFiles, 4)
  const taken = await spool.take()
  assert.ok(taken)
  // Oldest were dropped; the remaining segments are the newest four.
  assert.equal(taken.events[0]!.record.event, 'e4')
  await taken.commit()
  rmSync(directory, { recursive: true, force: true })
})

test('runner spools failed batches and replays them after recovery', async () => {
  const spoolDir = dir()
  const sink = new FakeSink()
  const logging = createLogging({
    service: 't',
    sinks: [sink],
    sinkRetry: { retries: 0 },
    breaker: { threshold: 1, cooldownMs: 50 },
    spool: { directory: spoolDir, maxFiles: 16 },
    emergency: { write: () => {}, ratePerSecond: 100 },
  })
  logging.logger.info({ event: 'during.outage', n: 1 })
  await logging.flush()
  let stats = logging.diagnostics().sinks[0]!
  assert.ok(stats.spooled >= 1)
  assert.equal(stats.spool?.files, 1)
  assert.equal(stats.dropped, 0)

  sink.failing = false
  sink.attempts = 0
  await new Promise((resolve) => setTimeout(resolve, 80))
  await logging.flush({ timeoutMs: 2000 })
  stats = logging.diagnostics().sinks[0]!
  assert.ok(stats.replayed >= 1)
  assert.equal(stats.spool?.files, 0)
  assert.ok(sink.events.some((event) => event.record.event === 'during.outage'))
  await logging.shutdown()
  rmSync(spoolDir, { recursive: true, force: true })
})

test('spool failures do not throw into the application', async () => {
  const notADir = join(dir(), 'file')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(notADir, 'x')
  const sink = new FakeSink()
  const logging = createLogging({
    service: 't',
    sinks: [sink],
    sinkRetry: { retries: 0 },
    spool: { directory: join(notADir, 'spool') },
    emergency: { write: () => {}, ratePerSecond: 100 },
  })
  assert.doesNotThrow(() => logging.logger.info({ event: 'still.safe' }))
  await logging.flush({ timeoutMs: 500 })
  const stats = logging.diagnostics().sinks[0]!
  assert.ok(stats.spoolFailures >= 1)
  await logging.shutdown()
})

test('OTLP payloads carry resource, severity, body, attributes and trace ids', async () => {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
  const sink = new OtlpLogsSink({
    endpoint: 'http://collector:4318',
    serviceName: 'aifactory-api',
    environment: 'test',
    headers: { Authorization: 'Bearer abc' },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
      return new Response('', { status: 200 })
    }) as typeof fetch,
  })
  const logging = createLogging({ service: 'aifactory-api', sinks: [sink], level: 'debug' })
  logging.logger.child({ component: 'stage-runtime' }).warn({
    event: 'stage.role.failed', projectId: 'p1', stageRunId: 'r1', role: 'reviewer',
    requestId: 'req1', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), durationMs: 12,
    err: new Error('boom'),
  }, 'reviewer failed')
  await logging.flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, 'http://collector:4318/v1/logs')
  assert.equal(calls[0]!.headers.get('authorization'), 'Bearer abc')
  const resourceLogs = calls[0]!.body.resourceLogs as Array<Record<string, unknown>>
  const scopeLogs = resourceLogs[0]!.scopeLogs as Array<Record<string, unknown>>
  const records = scopeLogs[0]!.logRecords as Array<Record<string, unknown>>
  const record = records[0]!
  assert.equal(record.severityText, 'WARN')
  assert.equal(record.severityNumber, 13)
  assert.deepEqual(record.body, { stringValue: 'reviewer failed' })
  assert.equal(record.traceId, 'a'.repeat(32))
  assert.equal(record.spanId, 'b'.repeat(16))
  const attrs = Object.fromEntries((record.attributes as Array<{ key: string; value: Record<string, unknown> }>).map((a) => [a.key, a.value]))
  assert.equal(attrs['projectId']?.stringValue, 'p1')
  assert.equal(attrs['event']?.stringValue, 'stage.role.failed')
  assert.equal(attrs['durationMs']?.doubleValue, 12)
  await logging.shutdown()
})

test('OTLP endpoint normalisation and failure propagation', async () => {
  let seen = ''
  const ok = new OtlpLogsSink({
    endpoint: 'http://collector:4318/v1',
    fetch: (async (url: string | URL | Request) => { seen = String(url); return new Response('', { status: 200 }) }) as typeof fetch,
  })
  const logging = createLogging({ service: 't', sinks: [ok] })
  logging.logger.info({ event: 'x' })
  await logging.flush()
  assert.equal(seen, 'http://collector:4318/v1/logs')
  await logging.shutdown()

  const bad = new OtlpLogsSink({
    endpoint: 'http://collector:4318/v1/logs',
    fetch: (async () => new Response('nope', { status: 503 })) as typeof fetch,
  })
  const failing = createLogging({ service: 't', sinks: [bad], sinkRetry: { retries: 0 } })
  failing.logger.info({ event: 'y' })
  await failing.flush({ timeoutMs: 500 })
  const stats = failing.diagnostics().sinks[0]!
  assert.ok(stats.failed >= 1)
  assert.match(stats.lastError ?? '', /503/)
  await failing.shutdown()
})

test('maxBytes caps total spool size by dropping oldest segments', async () => {
  const directory = dir()
  const maxBytes = 64 * 1024
  const spool = new FileSpool({ directory, maxBytes })
  const pad = 'x'.repeat(1500)
  for (let i = 0; i < 100; i++) {
    await spool.append([{ levelValue: 30, line: JSON.stringify({ event: `large-${i}`, pad }) } as never])
  }
  const stats = spool.stats()
  assert.ok(stats.bytes <= maxBytes, `spool exceeded maxBytes: ${stats.bytes}`)
  assert.ok(stats.droppedFiles > 0)
  rmSync(directory, { recursive: true, force: true })
})
