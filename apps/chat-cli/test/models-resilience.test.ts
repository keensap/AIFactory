import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CircuitBreaker,
  FakeEngine,
  ModelError,
  ResilientEngine,
  backoffDelay,
  type ModelEvent,
} from '../src/models/index.ts'
import { baseRequest } from './support/model-engine-contract.ts'

const busy = (extra: { retryAfterMs?: number } = {}) => new ModelError('overloaded', 'provider busy', { provider: 'test', ...extra })
const bad = () => new ModelError('invalid_request', 'bad parameter', { provider: 'test', status: 400 })

function harness(options: ConstructorParameters<typeof FakeEngine>[0] = {}, resilience: Partial<ConstructorParameters<typeof ResilientEngine>[1]> = {}) {
  let now = 1_000_000
  const sleeps: number[] = []
  const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => now })
  const inner = new FakeEngine(options)
  const engine = new ResilientEngine(inner, {
    breaker,
    maxRetries: 2,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    random: () => 1,
    sleep: async (ms) => { sleeps.push(ms) },
    ...resilience,
  })
  return { engine, inner, breaker, sleeps, advance: (ms: number) => { now += ms } }
}

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

// ---- backoff -----------------------------------------------------------

test('backoff doubles, is jittered within [50%,100%], capped, and honours Retry-After', () => {
  const settings = { baseDelayMs: 100, maxDelayMs: 1000, random: () => 1 }
  assert.deepEqual([1, 2, 3, 4, 5].map((attempt) => backoffDelay(attempt, busy(), settings)), [100, 200, 400, 800, 1000])
  assert.equal(backoffDelay(1, busy(), { ...settings, random: () => 0 }), 50, 'minimum jitter is half the delay')
  assert.equal(backoffDelay(1, busy({ retryAfterMs: 700 }), settings), 700, 'Retry-After wins when larger')
  assert.equal(backoffDelay(1, busy({ retryAfterMs: 99_999 }), settings), 1000, 'but never exceeds the cap')
})

// ---- retry -------------------------------------------------------------

test('retryable failures are retried with growing delays, then succeed', async () => {
  const { engine, inner, sleeps } = harness({ outcomes: [busy(), busy(), 'ok'], responses: ['recovered'] })
  const response = await engine.complete(baseRequest())
  assert.equal(response.text, 'recovered')
  assert.equal(inner.callCount, 3)
  assert.deepEqual(sleeps, [100, 200])
})

test('retries are bounded: after maxRetries the last error is thrown', async () => {
  const { engine, inner, sleeps } = harness({ failWith: busy() })
  await assert.rejects(() => engine.complete(baseRequest()), (error: unknown) => error instanceof ModelError && error.kind === 'overloaded')
  assert.equal(inner.callCount, 3, '1 attempt + 2 retries')
  assert.equal(sleeps.length, 2)
})

test('non-retryable errors are thrown immediately and do not count against the breaker', async () => {
  const { engine, inner, breaker, sleeps } = harness({ failWith: bad() })
  for (let i = 0; i < 10; i++) {
    await assert.rejects(() => engine.complete(baseRequest()), (error: unknown) => error instanceof ModelError && error.kind === 'invalid_request')
  }
  assert.equal(inner.callCount, 10, 'no retries')
  assert.equal(sleeps.length, 0)
  assert.equal(breaker.snapshot().state, 'closed', 'bad requests say nothing about provider health')
})

test('onRetry reports each retry for logging', async () => {
  const seen: Array<{ attempt: number; delayMs: number; kind: string }> = []
  const { engine } = harness({ outcomes: [busy(), 'ok'] }, { onRetry: (info) => seen.push({ attempt: info.attempt, delayMs: info.delayMs, kind: info.error.kind }) })
  await engine.complete(baseRequest())
  assert.deepEqual(seen, [{ attempt: 1, delayMs: 100, kind: 'overloaded' }])
})

test('a caller abort is not retried and not counted as a provider failure', async () => {
  const controller = new AbortController()
  const { engine, breaker, inner } = harness({ latencyMs: 5000 })
  const pending = engine.complete(baseRequest(), controller.signal)
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(() => pending, (error: unknown) => error instanceof ModelError && error.kind === 'aborted')
  assert.equal(inner.callCount, 1)
  assert.equal(breaker.snapshot().consecutiveFailures, 0)
})

test('aborting while waiting to retry stops immediately', async () => {
  const controller = new AbortController()
  const { engine, inner } = harness({ failWith: busy() }, {
    sleep: async (_ms, signal) => {
      controller.abort()
      if (signal?.aborted === true) throw new ModelError('aborted', 'request aborted by the caller')
    },
  })
  await assert.rejects(() => engine.complete(baseRequest(), controller.signal), (error: unknown) => error instanceof ModelError && error.kind === 'aborted')
  assert.equal(inner.callCount, 1)
})

// ---- timeout -----------------------------------------------------------

test('an attempt that exceeds its deadline fails with a retryable timeout', async () => {
  const { engine, inner } = harness({ latencyMs: 200 }, { attemptTimeoutMs: 20, maxRetries: 1 })
  await assert.rejects(
    () => engine.complete(baseRequest()),
    (error: unknown) => error instanceof ModelError && error.kind === 'timeout' && error.retryable && /20ms/.test(error.message),
  )
  assert.equal(inner.callCount, 2, 'timeouts are retried')
})

// ---- breaker -----------------------------------------------------------

test('repeated failures open the breaker; calls then fail fast without touching the provider', async () => {
  const { engine, inner, breaker } = harness({ failWith: busy() }, { maxRetries: 0 })
  for (let i = 0; i < 3; i++) await assert.rejects(() => engine.complete(baseRequest()))
  assert.equal(breaker.snapshot().state, 'open')
  const calls = inner.callCount
  await assert.rejects(
    () => engine.complete(baseRequest()),
    (error: unknown) => error instanceof ModelError && error.kind === 'unavailable' && !error.retryable,
  )
  await assert.rejects(() => collect(engine.stream(baseRequest())), (error: unknown) => error instanceof ModelError && error.kind === 'unavailable')
  assert.equal(inner.callCount, calls, 'an open breaker never calls the provider')
  assert.equal((await engine.health()).state, 'degraded')
})

test('after the cool-down a single probe is admitted; success closes the breaker', async () => {
  const { engine, inner, breaker, advance } = harness({ outcomes: [busy(), busy(), busy(), 'ok'] }, { maxRetries: 0 })
  for (let i = 0; i < 3; i++) await assert.rejects(() => engine.complete(baseRequest()))
  assert.equal(breaker.snapshot().state, 'open')
  advance(999)
  await assert.rejects(() => engine.complete(baseRequest()), (error: unknown) => error instanceof ModelError && error.kind === 'unavailable')
  advance(2)
  assert.equal(breaker.snapshot().state, 'half_open')
  await engine.complete(baseRequest())
  assert.equal(breaker.snapshot().state, 'closed')
  assert.equal(inner.callCount, 4)
})

test('a failed probe re-opens the breaker for another full cool-down', async () => {
  const { engine, breaker, advance } = harness({ failWith: busy() }, { maxRetries: 0 })
  for (let i = 0; i < 3; i++) await assert.rejects(() => engine.complete(baseRequest()))
  advance(1001)
  await assert.rejects(() => engine.complete(baseRequest()), (error: unknown) => error instanceof ModelError && error.kind === 'overloaded')
  assert.equal(breaker.snapshot().state, 'open')
  await assert.rejects(() => engine.complete(baseRequest()), (error: unknown) => error instanceof ModelError && error.kind === 'unavailable')
})

test('half-open admits exactly one concurrent probe', () => {
  let now = 0
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => now })
  assert.equal(breaker.tryAcquire(), true)
  breaker.failure('boom')
  assert.equal(breaker.tryAcquire(), false)
  now = 101
  assert.equal(breaker.tryAcquire(), true, 'first probe')
  assert.equal(breaker.tryAcquire(), false, 'second concurrent call is rejected')
  breaker.success()
  assert.equal(breaker.tryAcquire(), true)
})

test('a success resets the consecutive-failure count', async () => {
  const { engine, breaker } = harness({ outcomes: [busy(), busy(), 'ok', busy(), busy(), 'ok'] }, { maxRetries: 0 })
  const results: string[] = []
  for (let i = 0; i < 6; i++) results.push(await engine.complete(baseRequest()).then(() => 'ok', () => 'fail'))
  assert.deepEqual(results, ['fail', 'fail', 'ok', 'fail', 'fail', 'ok'])
  assert.equal(breaker.snapshot().state, 'closed')
})

// ---- streaming ---------------------------------------------------------

test('a stream that fails before its first event is retried transparently', async () => {
  const { engine, inner, sleeps } = harness({ outcomes: [busy(), 'ok'], responses: ['streamed text'] })
  const events = await collect(engine.stream(baseRequest()))
  const done = events.at(-1)
  assert.equal(done?.type === 'done' && done.response.text, 'streamed text')
  assert.equal(inner.callCount, 2)
  assert.deepEqual(sleeps, [100])
})

test('a stream that fails after emitting text is never restarted', async () => {
  const { engine, inner, sleeps } = harness({ failMidStream: busy(), responses: ['partial answer that is long enough'], chunkSize: 4 })
  const text: string[] = []
  await assert.rejects(async () => {
    for await (const event of engine.stream(baseRequest())) if (event.type === 'text') text.push(event.text)
  }, (error: unknown) => error instanceof ModelError && error.kind === 'overloaded')
  assert.equal(text.length, 1, 'the consumer saw one chunk, then the error')
  assert.equal(inner.callCount, 1, 'no duplicate request')
  assert.equal(sleeps.length, 0)
})

test('a stream that never produces a first event times out and is retried', async () => {
  const { engine, inner } = harness({ latencyMs: 200 }, { attemptTimeoutMs: 20, maxRetries: 1 })
  await assert.rejects(() => collect(engine.stream(baseRequest())), (error: unknown) => error instanceof ModelError && error.kind === 'timeout')
  assert.equal(inner.callCount, 2)
})

test('the resilient engine itself satisfies the engine contract shape', async () => {
  const { engine } = harness()
  assert.equal(engine.kind, 'fake')
  const response = await engine.complete(baseRequest())
  assert.equal(typeof response.text, 'string')
  assert.equal((await engine.health()).state, 'healthy')
})

test('local errors give the breaker no evidence; HTTP errors prove the provider is up', async () => {
  // No tool support, so a tools request fails locally before any provider call.
  const local = harness({ outcomes: [busy(), busy(), busy(), 'ok'], capabilities: { tools: false } }, { maxRetries: 0 })
  for (let i = 0; i < 3; i++) await assert.rejects(() => local.engine.complete(baseRequest()))
  local.advance(1001)
  assert.equal(local.breaker.snapshot().state, 'half_open')

  await assert.rejects(
    () => local.engine.complete(baseRequest({ tools: [{ name: 'x' }] })),
    (error: unknown) => error instanceof ModelError && error.kind === 'unsupported' && error.status === undefined,
  )
  assert.equal(local.inner.callCount, 3, 'rejected locally: the provider was not called')
  assert.equal(local.breaker.snapshot().state, 'half_open', 'no evidence, so the breaker is not closed')

  // The probe slot was released, so a real request can still probe and close it.
  await local.engine.complete(baseRequest())
  assert.equal(local.breaker.snapshot().state, 'closed')

  // An HTTP 401 means the provider answered, so the probe closes the breaker.
  const http = harness({ outcomes: [busy(), busy(), busy(), new ModelError('auth', 'bad key', { status: 401 })] }, { maxRetries: 0 })
  for (let i = 0; i < 3; i++) await assert.rejects(() => http.engine.complete(baseRequest()))
  http.advance(1001)
  await assert.rejects(() => http.engine.complete(baseRequest()), (error: unknown) => error instanceof ModelError && error.kind === 'auth')
  assert.equal(http.breaker.snapshot().state, 'closed')
})

test('a failure that opens the breaker is thrown at once instead of sleeping before a doomed retry', async () => {
  // Threshold 3 with one failure per call from earlier calls: the third failure opens it mid-retry.
  const { engine, inner, breaker, sleeps } = harness({ failWith: busy() }, { maxRetries: 2 })
  await assert.rejects(() => engine.complete(baseRequest()))   // failures 1, 2, 3 -> opens on the 3rd attempt
  assert.equal(breaker.snapshot().state, 'open')
  assert.equal(inner.callCount, 3)
  assert.equal(sleeps.length, 2, 'two backoffs before the breaker opened, none after')

  // The error that opened the breaker is the one reported (more informative than "unavailable").
  const second = harness({ outcomes: [busy(), busy(), busy()] }, { maxRetries: 5 })
  await assert.rejects(() => second.engine.complete(baseRequest()), (error: unknown) => error instanceof ModelError && error.kind === 'overloaded')
  assert.equal(second.sleeps.length, 2)
})
