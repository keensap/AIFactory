import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BoundedQueue,
  ConsoleSink,
  LevelController,
  createLogging,
  noopLogger,
  runWithLogContext,
  type LogEvent,
  type LogSink,
  type Logging,
} from '../src/logging/index.ts'
import { scrubString } from '../src/logging/sanitize.ts'

class MemorySink implements LogSink {
  readonly name: string
  readonly events: LogEvent[] = []
  constructor(name = 'memory') { this.name = name }
  write(batch: readonly LogEvent[]): void { this.events.push(...batch) }
  get records() { return this.events.map((event) => event.record) }
}

function setup(options: { level?: 'debug' | 'info'; override?: Record<string, 'debug' | 'info' | 'warn'>; sinks?: LogSink[]; sinkTimeoutMs?: number; queue?: { maxRecords?: number; maxBytes?: number } } = {}) {
  const sink = new MemorySink()
  const emergency: string[] = []
  const logging = createLogging({
    service: 'test',
    version: '1.0.0',
    level: options.level ?? 'info',
    ...(options.override !== undefined ? { override: options.override } : {}),
    ...(options.queue !== undefined ? { queue: options.queue } : {}),
    sinks: [sink, ...(options.sinks ?? [])],
    emergency: { write: (line) => emergency.push(line), ratePerSecond: 1000 },
    sinkTimeoutMs: options.sinkTimeoutMs ?? 200,
    sinkRetry: { retries: 0 },
  })
  return { logging, sink, emergency }
}

test('writes structured records with core fields', async () => {
  const { logging, sink } = setup()
  logging.logger.child({ component: 'stage-runtime' }).info({ event: 'stage.run.claimed', stageRunId: 'r1', attempt: 2 }, 'claimed')
  await logging.flush()
  const [record] = sink.records
  assert.equal(record?.level, 'info')
  assert.equal(record?.event, 'stage.run.claimed')
  assert.equal(record?.component, 'stage-runtime')
  assert.equal(record?.msg, 'claimed')
  assert.equal(record?.service, 'test')
  assert.equal(record?.schema, 1)
  assert.equal(record?.attempt, 2)
  assert.match(String(record?.ts), /^\d{4}-\d\d-\d\dT/)
  await logging.shutdown()
})

test('honours minimum level, per-component override and runtime switch', async () => {
  const { logging, sink } = setup({ level: 'info', override: { http: 'warn', 'stage.runtime': 'debug' } })
  const root = logging.logger
  root.debug({ event: 'root.debug' })
  root.child({ component: 'http' }).info({ event: 'http.info' })
  root.child({ component: 'http' }).warn({ event: 'http.warn' })
  root.child({ component: 'stage.runtime.lease' }).debug({ event: 'lease.debug' })
  await logging.flush()
  assert.deepEqual(sink.records.map((r) => r.event), ['http.warn', 'lease.debug'])

  logging.levels.setLevel('debug')
  root.debug({ event: 'now.visible' })
  await logging.flush()
  assert.equal(sink.records.at(-1)?.event, 'now.visible')
  await logging.shutdown()
})

test('temporary level switch reverts after its TTL', async () => {
  const levels = new LevelController('info')
  levels.setLevel('debug', { ttlMs: 30 })
  assert.equal(levels.isEnabled('debug'), true)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(levels.isEnabled('debug'), false)
  assert.equal(levels.snapshot().revertAt, null)
  levels.dispose()
})

test('enriches records from ambient async context', async () => {
  const { logging, sink } = setup()
  await runWithLogContext({ requestId: 'req-1', projectId: 'p1' }, async () => {
    await Promise.resolve()
    logging.logger.info({ event: 'inside' })
    await runWithLogContext({ stageRunId: 'run-9' }, async () => {
      logging.logger.info({ event: 'nested' })
    })
  })
  logging.logger.info({ event: 'outside' })
  await logging.flush()
  const byEvent = Object.fromEntries(sink.records.map((r) => [r.event, r]))
  assert.equal(byEvent.inside?.requestId, 'req-1')
  assert.equal(byEvent.nested?.stageRunId, 'run-9')
  assert.equal(byEvent.nested?.projectId, 'p1')
  assert.equal(byEvent.outside?.requestId, undefined)
  await logging.shutdown()
})

test('normalizes errors and protects reserved keys', async () => {
  const { logging, sink } = setup()
  const cause = new Error('root cause')
  const error = Object.assign(new Error('boom'), { code: 'E_BOOM', cause })
  logging.logger.error({ event: 'x.failed', err: error, level: 'hacked', pid: 1 })
  await logging.flush()
  const record = sink.records[0]!
  assert.equal(record.level, 'error')
  assert.equal(record.field_level, 'hacked')
  const err = record.err as Record<string, unknown>
  assert.equal(err.message, 'boom')
  assert.equal(err.code, 'E_BOOM')
  assert.equal((err.cause as Record<string, unknown>).message, 'root cause')
  assert.equal(typeof err.stack, 'string')
  await logging.shutdown()
})

test('redacts secrets by path and by pattern', async () => {
  const { logging, sink } = setup()
  logging.logger.info(
    { event: 'secrets', password: 'hunter2', headers: { authorization: 'Bearer abcdefghijklmnop' }, nested: { token: 't0ken' }, note: 'url postgres://aifactory:s3cr3t@db/x and api_key=ABC123 and sk-abcdefghijklmnopqrstuv' },
    'Authorization: Bearer zzzzzzzzzzzzzzzz',
  )
  await logging.flush()
  const text = sink.events[0]!.line
  for (const secret of ['hunter2', 'abcdefghijklmnop', 't0ken', 's3cr3t', 'ABC123', 'abcdefghijklmnopqrstuv', 'zzzzzzzzzzzzzzzz']) {
    assert.ok(!text.includes(secret), `leaked ${secret}: ${text}`)
  }
  assert.match(text, /\[redacted\]/)
  await logging.shutdown()
})

test('a log call never throws, whatever the caller passes', async () => {
  const { logging, sink } = setup()
  const log = logging.logger
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const hostile = [
    { bad: { get boom(): never { throw new Error('getter') } } },
    { p: new Proxy({}, { ownKeys() { throw new Error('proxy') }, get() { throw new Error('proxy') } }) },
    { o: { toJSON() { throw new Error('toJSON') } } },
    { n: 10n, s: Symbol('x'), f: () => 1, d: new Date(NaN), nan: Number.NaN },
    { circular },
    { big: 'x'.repeat(5_000_000) },
    { deep: JSON.parse('{"a":'.repeat(40) + '1' + '}'.repeat(40)) },
    { many: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i])) },
  ]
  for (const fields of hostile) assert.doesNotThrow(() => log.info({ event: 'hostile', ...fields }, 'm'))
  assert.doesNotThrow(() => log.info(undefined as unknown as string))
  assert.doesNotThrow(() => log.child(undefined as unknown as Record<string, unknown>).info('x'))
  await logging.flush()
  assert.ok(sink.events.length >= hostile.length)
  for (const event of sink.events) assert.ok(event.line.length <= 64 * 1024, `record too large: ${event.line.length}`)
  assert.equal(logging.diagnostics().facadeErrors, 0)
  await logging.shutdown()
})

test('a throwing sink does not affect the app or other sinks', async () => {
  const bad: LogSink = { name: 'bad', write() { throw new Error('sink exploded') } }
  const { logging, sink, emergency } = setup({ sinks: [bad] })
  for (let i = 0; i < 20; i++) logging.logger.info({ event: 'e', i })
  await logging.flush()
  assert.equal(sink.events.length, 20)
  const stats = logging.diagnostics().sinks.find((s) => s.name === 'bad')!
  assert.equal(stats.state, 'degraded')
  assert.ok(stats.failed >= 1)
  assert.match(stats.lastError ?? '', /exploded/)
  assert.ok(emergency.some((line) => line.includes('logging.sink_failed')))
  await logging.shutdown()
})

test('a hanging sink times out and does not block other sinks or shutdown', async () => {
  const hang: LogSink = { name: 'hang', write: () => new Promise<void>(() => {}) }
  const { logging, sink } = setup({ sinks: [hang], sinkTimeoutMs: 50 })
  logging.logger.info({ event: 'first' })
  logging.logger.info({ event: 'second' })
  await logging.flush({ timeoutMs: 500 })
  assert.equal(sink.events.length, 2)
  const started = Date.now()
  const result = await logging.shutdown({ timeoutMs: 400 })
  assert.ok(Date.now() - started < 1500)
  assert.equal(typeof result.lost, 'number')
})

test('queue is bounded and drops low priority first while keeping errors', () => {
  const queue = new BoundedQueue(5, 1_000_000)
  for (let i = 0; i < 3; i++) queue.push({ levelValue: 20, line: `debug-${i}` })
  queue.push({ levelValue: 50, line: 'error-a' })
  queue.push({ levelValue: 30, line: 'info-a' })
  assert.equal(queue.size, 5)
  queue.push({ levelValue: 50, line: 'error-b' })
  queue.push({ levelValue: 50, line: 'error-c' })
  assert.equal(queue.size, 5)
  const stats = queue.stats()
  assert.equal(stats.dropped.debug, 2)
  const lines = queue.drain(10).map((r) => r.line)
  assert.deepEqual(lines, ['debug-2', 'error-a', 'info-a', 'error-b', 'error-c'])
  // Incoming debug cannot evict higher-priority records.
  const full = new BoundedQueue(2, 1_000_000)
  full.push({ levelValue: 50, line: 'e1' })
  full.push({ levelValue: 50, line: 'e2' })
  assert.equal(full.push({ levelValue: 20, line: 'd' }), false)
  assert.equal(full.stats().dropped.debug, 1)
})

test('memory stays bounded against a slow sink', async () => {
  const slow: LogSink = { name: 'slow', write: () => new Promise((resolve) => setTimeout(resolve, 20)) }
  const { logging } = setup({ sinks: [slow], queue: { maxRecords: 500, maxBytes: 1_000_000 } })
  for (let i = 0; i < 20_000; i++) logging.logger.debug({ event: 'bulk', i })
  const stats = logging.diagnostics().queue
  assert.ok(stats.size <= 500)
  logging.logger.error({ event: 'important' })
  await logging.shutdown({ timeoutMs: 300 })
})

test('shutdown resolves, later calls do not throw, errors go to the emergency sink', async () => {
  const { logging, emergency } = setup()
  logging.logger.info({ event: 'before' })
  const result = await logging.shutdown()
  assert.equal(result.flushed, true)
  assert.doesNotThrow(() => logging.logger.info({ event: 'late.info' }))
  assert.doesNotThrow(() => logging.logger.error({ event: 'late.error' }, 'after close'))
  assert.ok(emergency.some((line) => line.includes('late.error')))
  assert.ok(!emergency.some((line) => line.includes('late.info')))
})

test('emergency sink is rate limited and reports suppression', async () => {
  const lines: string[] = []
  let now = 1_000
  const { EmergencySink } = await import('../src/logging/index.ts')
  const sink = new EmergencySink({ write: (line) => lines.push(line), ratePerSecond: 3, now: () => now })
  for (let i = 0; i < 10; i++) sink.write({ level: 'error', event: 'x', i })
  assert.equal(lines.length, 3)
  assert.equal(sink.suppressed, 7)
  now += 2_000
  sink.write({ level: 'error', event: 'after' })
  assert.ok(lines.some((line) => line.includes('logging.emergency.suppressed')))
})

test('console sink renders json and pretty output', async () => {
  const written: string[] = []
  const json = createLogging({ service: 't', sinks: [new ConsoleSink({ format: 'json', write: (t) => written.push(t) })] })
  json.logger.info({ event: 'a.b', n: 1 })
  await json.shutdown()
  assert.equal(JSON.parse(written.join('').trim()).event, 'a.b')

  const pretty: string[] = []
  const logging = createLogging({ service: 't', sinks: [new ConsoleSink({ format: 'pretty', write: (t) => pretty.push(t) })] })
  logging.logger.child({ component: 'http' }).warn({ event: 'http.request', status: 500, err: new Error('bad') }, 'failed')
  await logging.shutdown()
  const line = pretty.join('')
  assert.match(line, /WARN/)
  assert.match(line, /\[http\]/)
  assert.match(line, /http\.request/)
  assert.match(line, /status=500/)
  assert.match(line, /err=Error: bad/)
})

test('records are single lines without trailing newlines', async () => {
  const { logging, sink } = setup()
  logging.logger.info({ event: 'a', text: 'line1\nline2' })
  await logging.flush()
  const line = sink.events[0]!.line
  assert.ok(!line.endsWith('\n'))
  assert.ok(!line.includes('\n'))
  assert.equal(sink.records[0]!.text, 'line1\nline2')
  await logging.shutdown()
})

test('noop logger is safe and silent', () => {
  assert.doesNotThrow(() => {
    noopLogger.info({ event: 'x' })
    noopLogger.child({ component: 'y' }).error('z')
  })
  assert.equal(noopLogger.isEnabled('fatal'), false)
})

// Keep an unused-import guard so a refactor that drops exports fails loudly.
void (null as unknown as Logging)

test('retries a transient sink failure with backoff and then succeeds', async () => {
  let attempts = 0
  const written: string[] = []
  const flaky: LogSink = {
    name: 'flaky',
    write(batch) {
      attempts += 1
      if (attempts < 3) throw new Error(`transient ${attempts}`)
      written.push(...batch.map((e) => e.line))
    },
  }
  const logging = createLogging({
    service: 't',
    sinks: [flaky],
    sinkRetry: { retries: 3, baseMs: 5 },
    emergency: { write: () => {}, ratePerSecond: 100 },
  })
  logging.logger.info({ event: 'retry.me' })
  await logging.flush()
  assert.equal(attempts, 3)
  assert.equal(written.length, 1)
  const stats = logging.diagnostics().sinks[0]!
  assert.equal(stats.retries, 2)
  assert.equal(stats.state, 'healthy')
  assert.equal(stats.written, 1)
  await logging.shutdown()
})

test('circuit breaker opens, drops while open, probes after cool-down and closes on recovery', async () => {
  let failing = true
  let calls = 0
  const events: string[] = []
  const sink: LogSink = {
    name: 'db',
    write() {
      calls += 1
      if (failing) throw new Error('db down')
    },
  }
  const logging = createLogging({
    service: 't',
    sinks: [sink],
    sinkRetry: { retries: 0 },
    breaker: { threshold: 3, cooldownMs: 120, maxCooldownMs: 1000 },
    batchSize: 1,
    emergency: { write: (line) => events.push(line), ratePerSecond: 1000 },
  })
  const log = logging.logger
  for (let i = 0; i < 3; i++) { log.info({ event: 'f', i }); await logging.flush() }
  assert.equal(logging.diagnostics().sinks[0]!.state, 'open')
  assert.equal(calls, 3)

  // While open: no calls reach the sink, batches are dropped and counted.
  for (let i = 0; i < 5; i++) { log.info({ event: 'dropped', i }); await logging.flush() }
  assert.equal(calls, 3)
  const open = logging.diagnostics().sinks[0]!
  assert.equal(open.droppedByBreaker, 5)
  assert.ok(open.openUntil !== null)
  assert.equal(open.breakerOpens, 1)

  // After cool-down the next batch is a probe; a failed probe re-opens longer.
  await new Promise((resolve) => setTimeout(resolve, 150))
  log.info({ event: 'probe.fail' }); await logging.flush()
  assert.equal(calls, 4)
  assert.equal(logging.diagnostics().sinks[0]!.state, 'open')
  assert.equal(logging.diagnostics().sinks[0]!.breakerOpens, 2)

  // Recover: wait out the longer cool-down, probe succeeds and closes the breaker.
  failing = false
  await new Promise((resolve) => setTimeout(resolve, 300))
  log.info({ event: 'probe.ok' }); await logging.flush()
  const closed = logging.diagnostics().sinks[0]!
  assert.equal(closed.state, 'healthy')
  assert.equal(closed.consecutiveFailures, 0)
  assert.equal(closed.written, 1)
  log.info({ event: 'normal' }); await logging.flush()
  assert.equal(logging.diagnostics().sinks[0]!.written, 2)
  assert.ok(events.some((line) => line.includes('"state":"open"')))
  assert.ok(events.some((line) => line.includes('"state":"healthy"')))
  await logging.shutdown()
})

test('provider credential shapes are redacted in free text and JSON-quoted headers', () => {
  const secrets = [
    'sk-ant-api03-AbCdEf_GhIjKlMnOpQrStUvWxYz0123456789-abcdefghij',
    'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_abcdef',
    'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    'AKIAIOSFODNN7EXAMPLE',
    'supersecretvalue123',
    'anothersecret456',
  ]
  const text = [
    `key ${secrets[0]} end`,
    `key ${secrets[1]} end`,
    `key ${secrets[2]} end`,
    `key ${secrets[3]} end`,
    `aws ${secrets[4]}`,
    `{"x-api-key":"${secrets[5]}","api-key": "${secrets[6]}","model":"gpt-4o","inputTokens":42}`,
  ].join('\n')
  const out = scrubString(text)
  for (const secret of secrets) assert.ok(!out.includes(secret), `leaked: ${secret}`)
  assert.match(out, /"model":"gpt-4o"/, 'ordinary fields survive')
  assert.match(out, /"inputTokens":42/, 'numeric token counts are not mistaken for secrets')
})
