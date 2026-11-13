import assert from 'node:assert/strict'
import test from 'node:test'
import { PhoenixClient, PhoenixTelemetry, ResilientSpanExporter, summarizeSpans, type PhoenixSpan } from '../src/observability/phoenix/index.ts'

const spans: PhoenixSpan[] = [
  {
    name: 'stage.run', context: { trace_id: 't1', span_id: 's1' }, span_kind: 'CHAIN',
    start_time: '2026-11-11T10:00:00.000Z', end_time: '2026-11-11T10:00:10.000Z',
    status_code: 'OK', attributes: { 'project.id': 'p1' },
  },
  {
    name: 'stage.role.analyzer', context: { trace_id: 't1', span_id: 's2' }, span_kind: 'LLM',
    start_time: '2026-11-11T10:00:01.000Z', end_time: '2026-11-11T10:00:05.000Z',
    status_code: 'OK', attributes: { role: 'analyzer', 'llm.token_count.total': 120 },
  },
  {
    name: 'stage.role.reviewer', context: { trace_id: 't1', span_id: 's3' }, span_kind: 'LLM',
    start_time: '2026-11-11T10:00:05.000Z', end_time: '2026-11-11T10:00:09.000Z',
    status_code: 'ERROR', attributes: { role: 'reviewer', 'llm.token_count.total': 80 },
  },
]

test('summarizes traces, roles, errors, latency and tokens', () => {
  const summary = summarizeSpans('aifactory-p1', 24, spans)
  assert.equal(summary.available, true)
  assert.equal(summary.traces, 1)
  assert.equal(summary.spans, 3)
  assert.equal(summary.errors, 1)
  assert.equal(summary.tokens, 200)
  assert.equal(summary.roles.length, 2)
  assert.equal(summary.roles.find((role) => role.role === 'reviewer')?.errors, 1)
  assert.equal(summary.latencyMs.max, 10_000)
  assert.ok(summary.latencyMs.avg > 0)
})

test('reads spans from the Phoenix project API and scopes the window', async () => {
  let requested = ''
  const client = new PhoenixClient({
    baseUrl: 'http://phoenix.local:6006',
    projectPrefix: 'aifactory-',
    serviceName: 'aifactory',
    environment: 'test',
    captureContent: false,
    captureMaxChars: 100,
    retentionHours: 24,
    enabled: true,
    fetch: (async (input: string | URL | Request) => {
      requested = String(input)
      return new Response(JSON.stringify({ data: spans, next_cursor: null }), { status: 200 })
    }) as typeof fetch,
  })
  const summary = await client.summary('p1', 24)
  assert.equal(summary.available, true)
  assert.equal(summary.traces, 1)
  assert.match(requested, /\/v1\/projects\/aifactory-p1\/spans/)
  assert.match(requested, /start_time=/)
  assert.match(requested, /end_time=/)
})

test('treats a missing Phoenix project as an empty summary', async () => {
  const client = new PhoenixClient({
    baseUrl: 'http://phoenix.local:6006',
    projectPrefix: 'aifactory-',
    serviceName: 'aifactory',
    environment: 'test',
    captureContent: false,
    captureMaxChars: 100,
    retentionHours: 24,
    enabled: true,
    fetch: (async () => new Response('not found', { status: 404 })) as typeof fetch,
  })
  const summary = await client.summary('p1')
  assert.equal(summary.available, true)
  assert.equal(summary.spans, 0)
})

test('returns unavailable instead of throwing when Phoenix is down', async () => {
  const client = new PhoenixClient({
    baseUrl: 'http://phoenix.local:6006',
    projectPrefix: 'aifactory-',
    serviceName: 'aifactory',
    environment: 'test',
    captureContent: false,
    captureMaxChars: 100,
    retentionHours: 24,
    enabled: true,
    fetch: (async () => { throw new Error('connection refused') }) as typeof fetch,
  })
  const summary = await client.summary('p1')
  assert.equal(summary.available, false)
  assert.match(summary.reason ?? '', /connection refused/)
})

test('resilient exporter opens its breaker and drops spans instead of retrying Phoenix forever', () => {
  let calls = 0
  const delegate = {
    export(_spans: never[], callback: (result: { code: number; error?: Error }) => void) {
      calls += 1
      callback({ code: 1, error: new Error('connection refused') })
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  }
  const exporter = new ResilientSpanExporter(delegate, { threshold: 2, cooldownMs: 60_000, now: () => 1000 })
  const results: number[] = []
  for (let i = 0; i < 4; i++) exporter.export([], (result) => results.push(result.code))
  assert.equal(calls, 2, 'open breaker must stop calling the delegate')
  assert.deepEqual(results, [1, 1, 1, 1])
  const health = exporter.health()
  assert.equal(health.state, 'open')
  assert.equal(health.failures, 2)
  assert.equal(health.droppedSpans, 0, 'the two failed exports were attempted, not dropped by the breaker')
})

test('resilient exporter times out a hung export and never throws', async () => {
  const delegate = {
    export() { /* never invokes the callback */ },
    forceFlush: async () => {},
    shutdown: async () => {},
  }
  const exporter = new ResilientSpanExporter(delegate as never, { timeoutMs: 50, threshold: 99 })
  const result = await new Promise<{ code: number; error?: Error }>((resolve) => exporter.export([], resolve))
  assert.equal(result.code, 1)
  assert.match(result.error?.message ?? '', /timed out/)
  assert.doesNotThrow(() => exporter.export([], () => {}))
  await exporter.shutdown()
})

test('resilient exporter recovers after a successful export', () => {
  let fail = true
  let now = 1000
  const exporter = new ResilientSpanExporter({
    export(_spans: never[], callback: (result: { code: number; error?: Error }) => void) {
      callback(fail ? { code: 1, error: new Error('down') } : { code: 0 })
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  }, { threshold: 2, cooldownMs: 1000, now: () => now })
  exporter.export([], () => {})
  exporter.export([], () => {})
  assert.equal(exporter.health().state, 'open')
  now += 2000
  fail = false
  exporter.export([], () => {})
  assert.equal(exporter.health().state, 'healthy')
  assert.equal(exporter.health().consecutiveFailures, 0)
})

test('Phoenix client opens a breaker after repeated network failures', async () => {
  let calls = 0
  const client = new PhoenixClient({
    baseUrl: 'http://phoenix.local:6006',
    projectPrefix: 'aifactory-',
    serviceName: 'aifactory',
    environment: 'test',
    captureContent: false,
    captureMaxChars: 100,
    retentionHours: 24,
    enabled: true,
    requestTimeoutMs: 50,
    fetch: (async () => { calls += 1; throw new Error('connection refused') }) as typeof fetch,
  })
  assert.equal((await client.summary('p1')).available, false)
  assert.equal((await client.summary('p1')).available, false)
  assert.equal((await client.summary('p1')).available, false)
  const fourth = await client.summary('p1')
  assert.equal(fourth.available, false)
  assert.match(fourth.reason ?? '', /circuit open/)
  assert.equal(calls, 3, 'the open breaker must answer without calling Phoenix')
})

test('Phoenix telemetry never throws and shutdown is bounded when the endpoint is dead', async () => {
  const telemetry = new PhoenixTelemetry({
    baseUrl: 'http://127.0.0.1:6006',
    otlpEndpoint: 'http://127.0.0.1:1',
    projectPrefix: 'aifactory-',
    serviceName: 'aifactory',
    environment: 'test',
    captureContent: false,
    captureMaxChars: 100,
    retentionHours: 24,
    enabled: true,
    otlpTimeoutMs: 100,
    shutdownTimeoutMs: 250,
  })
  const project = { id: 'p1', name: 'Project' } as never
  const run = { id: 'r1', stage: 'planning', attempt: 1, contextHash: null, lockedBy: null, status: 'pending' } as never
  let span: ReturnType<PhoenixTelemetry['startRun']>
  assert.doesNotThrow(() => { span = telemetry.startRun(project, run) })
  assert.doesNotThrow(() => telemetry.recordReview(span, 'approved', 0))
  assert.doesNotThrow(() => telemetry.recordDocument(span, 'telos_report', '/tmp/x'))
  assert.doesNotThrow(() => telemetry.completeRole(span, 'output'))
  assert.doesNotThrow(() => telemetry.recordHumanDecision('p1', 'r1', 'go'))
  const started = Date.now()
  await telemetry.shutdown()
  assert.ok(Date.now() - started < 2000, 'shutdown must not wait for an unreachable OTLP endpoint')
})
