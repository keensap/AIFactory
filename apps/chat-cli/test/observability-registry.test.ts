import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createObservabilityProvider,
  listObservabilityProviders,
  registerObservabilityProvider,
} from '../src/observability/index.ts'
import { phoenixConfigFromEnv } from '../src/observability/phoenix/index.ts'

test('Phoenix is enabled only with an explicit on value', () => {
  assert.equal(phoenixConfigFromEnv({}), undefined)
  assert.equal(phoenixConfigFromEnv({ AIFACTORY_PHOENIX_ENABLED: '0' }), undefined)
  const config = phoenixConfigFromEnv({ AIFACTORY_PHOENIX_ENABLED: 'true' })
  assert.ok(config)
  assert.equal(config.baseUrl, 'http://127.0.0.1:6006')
  assert.equal(config.otlpEndpoint, 'http://127.0.0.1:4317')
  assert.equal(config.projectPrefix, 'aifactory-')
  assert.equal(config.retentionHours, 24)
  assert.equal(config.captureContent, false)
  assert.equal(config.requestTimeoutMs, 5000)
})

test('Phoenix config honours every environment override and ignores bad numbers', () => {
  const config = phoenixConfigFromEnv({
    AIFACTORY_PHOENIX_ENABLED: 'ON',
    AIFACTORY_PHOENIX_URL: 'http://phoenix:6006/',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4317',
    AIFACTORY_PHOENIX_PROJECT_PREFIX: 'pfx-',
    OTEL_SERVICE_NAME: 'svc',
    AIFACTORY_PHOENIX_ENVIRONMENT: 'prod',
    AIFACTORY_PHOENIX_CAPTURE_CONTENT: '1',
    AIFACTORY_PHOENIX_CAPTURE_MAX_CHARS: '50',
    AIFACTORY_PHOENIX_RETENTION_HOURS: '48',
    AIFACTORY_PHOENIX_OTLP_TIMEOUT_MS: 'not-a-number',
    AIFACTORY_PHOENIX_BREAKER_THRESHOLD: '5',
    AIFACTORY_PHOENIX_BREAKER_COOLDOWN_MS: '1000',
    AIFACTORY_PHOENIX_SHUTDOWN_TIMEOUT_MS: '2000',
    AIFACTORY_PHOENIX_REQUEST_TIMEOUT_MS: '0',
    AIFACTORY_PHOENIX_API_KEY: 'secret',
  })
  assert.ok(config)
  assert.equal(config.baseUrl, 'http://phoenix:6006/')
  assert.equal(config.otlpEndpoint, 'http://collector:4317')
  assert.equal(config.projectPrefix, 'pfx-')
  assert.equal(config.serviceName, 'svc')
  assert.equal(config.environment, 'prod')
  assert.equal(config.captureContent, true)
  assert.equal(config.captureMaxChars, 50)
  assert.equal(config.retentionHours, 48)
  assert.equal(config.otlpTimeoutMs, 5000, 'invalid numbers fall back to the default')
  assert.equal(config.otlpBreakerThreshold, 5)
  assert.equal(config.otlpBreakerCooldownMs, 1000)
  assert.equal(config.shutdownTimeoutMs, 2000)
  assert.equal(config.requestTimeoutMs, 5000, 'zero is not a valid timeout')
  assert.equal(config.apiKey, 'secret')
})

test('the registry selects phoenix, noop and unknown providers safely', () => {
  assert.ok(listObservabilityProviders().includes('phoenix'))
  assert.ok(listObservabilityProviders().includes('noop'))

  assert.equal(createObservabilityProvider({ AIFACTORY_PHOENIX_ENABLED: '1' }).name, 'phoenix')
  assert.equal(createObservabilityProvider({}).name, 'noop', 'phoenix disabled by default')
  assert.equal(createObservabilityProvider({ AIFACTORY_OBSERVABILITY_PROVIDER: 'noop', AIFACTORY_PHOENIX_ENABLED: '1' }).name, 'noop')
  assert.equal(createObservabilityProvider({ AIFACTORY_OBSERVABILITY_PROVIDER: 'nope' }).name, 'noop', 'unknown provider falls back')
  assert.equal(createObservabilityProvider({ AIFACTORY_OBSERVABILITY_PROVIDER: 'PHOENIX', AIFACTORY_PHOENIX_ENABLED: '1' }).name, 'phoenix', 'names are case-insensitive')
})

test('a custom provider can be registered without touching the core', async () => {
  registerObservabilityProvider('test-only', () => ({
    name: 'test-only',
    recorder: {
      startRun: () => undefined,
      startRole: () => undefined,
      recordHarnessEvent: () => {},
      completeRole: () => {},
      failRole: () => {},
      recordReview: () => {},
      recordDocument: () => {},
      recordHumanDecision: () => {},
      forgetProject: async () => {},
      currentTraceContext: () => undefined,
    },
    reader: {
      summary: async (projectId: string) => ({
        available: true, projectName: projectId, windowHours: 1, traces: 0, spans: 0,
        errors: 0, tools: 0, tokens: 0,
        latencyMs: { count: 0, avg: 0, p50: 0, p95: 0, max: 0 },
        roles: [], lastSpanAt: null, truncated: false,
      }),
      deleteProject: async () => {},
      health: () => ({
        provider: 'test-only', enabled: true, state: 'healthy', projects: 0,
        exports: 0, failures: 0, droppedSpans: 0, lastError: null, openUntil: null,
      }),
    },
    shutdown: async () => {},
  }))
  const provider = createObservabilityProvider({ AIFACTORY_OBSERVABILITY_PROVIDER: 'test-only' })
  assert.equal(provider.name, 'test-only')
  assert.equal((await provider.reader.summary('p1', 1)).available, true)
})

test('a throwing provider factory falls back to noop instead of failing startup', () => {
  registerObservabilityProvider('explodes', () => { throw new Error('boom') })
  const provider = createObservabilityProvider({ AIFACTORY_OBSERVABILITY_PROVIDER: 'explodes' })
  assert.equal(provider.name, 'noop')
})
