import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelError, ModelService, ModelSettingsError, type AttemptInfo } from '../src/models/index.ts'
import { jsonResponse, recordingFetch, type RecordedCall } from './support/fake-fetch.ts'
import { MemoryCatalog, MemorySettings, model, provider } from './support/memory-models.ts'

const ENV = { OPENAI_API_KEY: 'sk-openai-secret-value-1234567890' }

const okBody = (text: string) => jsonResponse({
  id: 'c1', choices: [{ message: { content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
})

function build(options: {
  handler?: (call: RecordedCall, signal: AbortSignal | undefined) => Response | Promise<Response>
  target?: ConstructorParameters<typeof MemorySettings>[0]
  env?: Record<string, string | undefined>
  onAttempt?: (info: AttemptInfo) => void
} = {}) {
  const catalog = new MemoryCatalog(
    [provider('openai', { kind: 'openai', apiKeyEnv: 'OPENAI_API_KEY' }), provider('llamacpp', { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', local: true })],
    [model('openai', 'gpt-4o', 128_000, { input: 2.5, output: 10 }), model('llamacpp', 'qwen3-8b', 32_768)],
  )
  const settings = new MemorySettings(options.target === undefined ? { provider: 'openai', model: 'gpt-4o', fallback: [] } : options.target)
  const { fetch, calls } = recordingFetch(options.handler ?? ((call) => okBody(new URL(call.url).host === '127.0.0.1:8080' ? 'local ok' : 'cloud ok')))
  const service = new ModelService({
    catalog, store: settings, env: options.env ?? ENV, fetch,
    tuning: { cloudRetries: 0, localRetries: 0, breakerThreshold: 2, breakerCooldownMs: 60_000 },
    sleep: async () => {}, random: () => 1,
    ...(options.onAttempt !== undefined ? { onAttempt: options.onAttempt } : {}),
  })
  return { service, catalog, settings, calls }
}

const settingsError = (code: string) => (error: unknown) => error instanceof ModelSettingsError && error.code === code

// ---- test() ------------------------------------------------------------

test('test() runs a bounded completion through the routed target and reports cost and attempts', async () => {
  const { service, calls } = build()
  const result = await service.test({})
  assert.equal(result.provider, 'openai')
  assert.equal(result.text, 'cloud ok')
  assert.equal(result.costUsd, 2.5)
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.truncated, false)
  assert.equal(result.attempts.length, 1)
  const body = calls[0]?.body as { messages: Array<{ content: string }>; max_tokens: number }
  assert.equal(body.messages[0]?.content, 'Reply with the single word: ok')
  assert.equal(body.max_tokens, 32)
})

test('test() exercises the fallback chain and lists every attempt', async () => {
  const { service } = build({
    target: { provider: 'openai', model: 'gpt-4o', fallback: [{ provider: 'llamacpp', model: 'qwen3-8b' }] },
    handler: (call) => (new URL(call.url).host === 'api.openai.com'
      ? jsonResponse({ error: { message: 'overloaded' } }, 503)
      : okBody('local ok')),
  })
  const result = await service.test({ prompt: 'ping' })
  assert.equal(result.provider, 'llamacpp')
  assert.deepEqual(result.attempts.map((a) => [a.provider, a.outcome]), [['openai', 'error'], ['llamacpp', 'ok']])
})

test('test() long output is truncated and the prompt/limits are validated', async () => {
  const long = build({ handler: () => okBody('x'.repeat(2000)) })
  const result = await long.service.test({})
  assert.equal(result.text.length, 500)
  assert.equal(result.truncated, true)

  const { service, calls } = build()
  await assert.rejects(() => service.test({ prompt: '' }), settingsError('INVALID_TEST'))
  await assert.rejects(() => service.test({ prompt: 'x'.repeat(2001) }), settingsError('INVALID_TEST'))
  await assert.rejects(() => service.test({ prompt: 5 }), settingsError('INVALID_TEST'))
  await assert.rejects(() => service.test({ maxTokens: 0 }), settingsError('INVALID_TEST'))
  await assert.rejects(() => service.test({ maxTokens: 257 }), settingsError('INVALID_TEST'))
  await assert.rejects(() => service.test({ maxTokens: 1.5 }), settingsError('INVALID_TEST'))
  await assert.rejects(() => service.test({ timeoutMs: 10 }), settingsError('INVALID_TEST'))
  await assert.rejects(() => service.test({ timeoutMs: 999_999 }), settingsError('INVALID_TEST'))
  await assert.rejects(() => service.test([]), settingsError('INVALID_BODY'))
  assert.equal(calls.length, 0, 'invalid input never reaches a provider')
})

test('test() with no configured target is an "unconfigured" error', async () => {
  const { service, calls } = build({ target: null })
  await assert.rejects(() => service.test({}), (error: unknown) => error instanceof ModelError && error.kind === 'unconfigured')
  assert.equal(calls.length, 0)
})

test('test() gives up at its own deadline with a timeout error', async () => {
  const { service } = build({
    handler: (_call, signal) => new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }),
  })
  const started = Date.now()
  await assert.rejects(
    () => service.test({ timeoutMs: 1000 }),
    (error: unknown) => error instanceof ModelError && error.kind === 'timeout' && /1000ms/.test(error.message),
  )
  assert.ok(Date.now() - started < 4000)
})

test('concurrent test() calls do not see each other’s attempts', async () => {
  const { service } = build()
  const [a, b, c] = await Promise.all([service.test({ prompt: 'a' }), service.test({ prompt: 'b' }), service.test({ prompt: 'c' })])
  for (const result of [a, b, c]) assert.equal(result.attempts.length, 1)
})

// ---- observers ---------------------------------------------------------

test('service-wide observers receive attempts; a throwing observer is ignored', async () => {
  const seen: AttemptInfo[] = []
  const { service } = build({ onAttempt: (info) => seen.push(info) })
  service.observe(() => { throw new Error('observer bug') })
  assert.equal((await service.router.complete({ messages: [{ role: 'user', content: 'x' }], projectId: 'p1' })).text, 'cloud ok')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.projectId, 'p1')
})

// ---- prices ------------------------------------------------------------

test('setPrice validates input, updates the catalogue and affects later costs', async () => {
  const { service } = build()
  assert.equal((await service.test({})).costUsd, 2.5)
  const updated = await service.setPrice('openai', 'gpt-4o', { input: 5, output: 20 })
  assert.deepEqual(updated.price, { input: 5, output: 20 })
  assert.equal((await service.test({})).costUsd, 5)

  await assert.rejects(() => service.setPrice('openai', 'gpt-4o', {}), settingsError('INVALID_PRICE'))
  await assert.rejects(() => service.setPrice('openai', 'gpt-4o', { input: -1 }), settingsError('INVALID_PRICE'))
  await assert.rejects(() => service.setPrice('openai', 'gpt-4o', { input: '5' }), settingsError('INVALID_PRICE'))
  await assert.rejects(() => service.setPrice('openai', 'gpt-4o', { input: Number.NaN }), settingsError('INVALID_PRICE'))
  await assert.rejects(() => service.setPrice('openai', 'gpt-4o', { input: 1e9 }), settingsError('INVALID_PRICE'))
  await assert.rejects(() => service.setPrice('openai', 'gpt-4o', null), settingsError('INVALID_BODY'))
  await assert.rejects(() => service.setPrice('openai', 'nope', { input: 1 }), settingsError('MODEL_NOT_FOUND'))
  await assert.rejects(() => service.setPrice('nope', 'gpt-4o', { input: 1 }), settingsError('PROVIDER_NOT_FOUND'))
  // Unknown keys are ignored rather than stored.
  const clean = await service.setPrice('openai', 'gpt-4o', { input: 1, output: 2, secret: 'x' })
  assert.deepEqual(clean.price, { input: 1, output: 2 })
})

// ---- breaker admin -----------------------------------------------------

test('a tripped breaker is visible in runtime() and can be reset by an admin', async () => {
  const { service, calls } = build({ handler: () => jsonResponse({ error: { message: 'down' } }, 503) })
  for (let i = 0; i < 2; i++) await assert.rejects(() => service.test({}))
  assert.equal(service.runtime().find((entry) => entry.provider === 'openai')?.breaker.state, 'open')
  const before = calls.length
  await assert.rejects(() => service.test({}), (error: unknown) => error instanceof ModelError && error.kind === 'unavailable')
  assert.equal(calls.length, before, 'quarantined: no provider call')

  assert.deepEqual(await service.resetBreaker('openai'), { provider: 'openai', reset: true })
  assert.equal(service.runtime().find((entry) => entry.provider === 'openai')?.breaker.state, 'closed')
  await assert.rejects(() => service.resetBreaker('nope'), settingsError('PROVIDER_NOT_FOUND'))
})

// ---- egress ------------------------------------------------------------

test('local-only egress rejects a cloud target when it is saved', async () => {
  const { service, settings } = build({ env: { ...ENV, AIFACTORY_MODEL_EGRESS: 'local-only' }, target: null })
  await assert.rejects(() => service.updateTarget({ provider: 'openai', model: 'gpt-4o' }), settingsError('EGRESS_BLOCKED'))
  await assert.rejects(
    () => service.updateTarget({ provider: 'llamacpp', model: 'qwen3-8b', fallback: [{ provider: 'openai', model: 'gpt-4o' }] }),
    settingsError('EGRESS_BLOCKED'),
    'a cloud fallback is also blocked',
  )
  assert.equal(settings.target, null)
  const saved = await service.updateTarget({ provider: 'llamacpp', model: 'qwen3-8b' })
  assert.equal(saved.target?.provider, 'llamacpp')
})

// ---- overrides ---------------------------------------------------------

test('AIFACTORY_<ID>_BASE_URL reaches views and calls', async () => {
  const { service, calls } = build({
    target: { provider: 'llamacpp', model: 'qwen3-8b', fallback: [] },
    env: { ...ENV, AIFACTORY_LLAMACPP_BASE_URL: 'http://10.1.2.3:9000/v1/' },
  })
  const view = (await service.providers()).find((entry) => entry.id === 'llamacpp')
  assert.equal(view?.baseUrl, 'http://10.1.2.3:9000/v1')
  await service.test({})
  assert.equal(calls[0]?.url, 'http://10.1.2.3:9000/v1/chat/completions')
})
