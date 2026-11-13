import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EngineRegistry,
  ModelError,
  ModelRouter,
  defaultCapabilities,
  shouldFallBack,
  type AttemptInfo,
  type ModelEvent,
  type ModelRecord,
  type ModelTarget,
  type ProviderRecord,
  type ResolvedTarget,
} from '../src/models/index.ts'
import { frame, jsonResponse, recordingFetch, sseResponse, type RecordedCall } from './support/fake-fetch.ts'

const provider = (id: string, overrides: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id, kind: 'openai', displayName: id, baseUrl: null, apiKeyEnv: null, headers: {}, defaults: {}, enabled: true, local: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
})

const model = (providerId: string, name: string, contextWindow = 128_000, price: ModelRecord['price'] = {}): ModelRecord => ({
  provider: providerId, model: name, displayName: name, contextWindow, maxOutput: 8192,
  capabilities: { ...defaultCapabilities(), contextWindow, tools: true }, price, discoveredAt: null,
})

const providers = (): ProviderRecord[] => [
  provider('openai', { kind: 'openai', apiKeyEnv: 'OPENAI_API_KEY' }),
  provider('anthropic', { kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' }),
  provider('llamacpp', { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', local: true }),
]

const catalog = (): ModelRecord[] => [
  model('openai', 'gpt-4o', 128_000, { input: 2.5, output: 10 }),
  model('anthropic', 'claude-sonnet-4-5', 200_000, { input: 3, output: 15, cacheRead: 0.3 }),
  model('llamacpp', 'qwen3-8b', 32_768, { input: 0, output: 0 }),
  model('openai', 'gpt-small', 8_000),
]

const ENV = { OPENAI_API_KEY: 'sk-openai-secret-value-1234567890', ANTHROPIC_API_KEY: 'sk-ant-secret-value-1234567890' }

const openaiOk = (text = 'from openai') => jsonResponse({
  id: 'chatcmpl-1', choices: [{ message: { content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
})
const anthropicOk = (text = 'from anthropic') => jsonResponse({
  id: 'msg_1', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 10_000 },
})
const localOk = (text = 'from llama') => jsonResponse({
  id: 'l1', choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 },
})
const down = (): Response => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }) }
const busy = (): Response => jsonResponse({ error: { message: 'overloaded', type: 'server_error' } }, 503)

type Routes = { openai?: (call: RecordedCall) => Response; anthropic?: (call: RecordedCall) => Response; llama?: (call: RecordedCall) => Response }

function setup(options: {
  routes?: Routes
  target?: Partial<ModelTarget> & { provider?: string; model?: string }
  env?: Record<string, string | undefined>
  providerList?: ProviderRecord[]
  models?: ModelRecord[]
  tuning?: ConstructorParameters<typeof EngineRegistry>[0]['tuning']
  onAttempt?: (info: AttemptInfo) => void
  unconfigured?: boolean
} = {}) {
  const routes: Routes = { openai: () => openaiOk(), anthropic: () => anthropicOk(), llama: () => localOk(), ...options.routes }
  const { fetch, calls } = recordingFetch((call) => {
    const url = new URL(call.url)
    if (url.host === 'api.openai.com') return routes.openai!(call)
    if (url.host === 'api.anthropic.com') return routes.anthropic!(call)
    if (url.host === '127.0.0.1:8080') return routes.llama!(call)
    return jsonResponse({ error: { message: `unexpected host ${url.host}` } }, 500)
  })
  let now = 5_000_000
  const env = options.env ?? ENV
  const state = {
    target: { provider: 'openai', model: 'gpt-4o', fallback: [], ...options.target } as ModelTarget,
    providers: options.providerList ?? providers(),
    models: options.models ?? catalog(),
  }
  const registry = new EngineRegistry({
    env, fetch,
    tuning: { cloudRetries: 0, localRetries: 0, breakerThreshold: 3, breakerCooldownMs: 1000, ...options.tuning },
    sleep: async () => {},
    random: () => 1,
    now: () => now,
  })
  const attempts: AttemptInfo[] = []
  const router = new ModelRouter({
    env, registry,
    source: {
      async resolve() {
        const resolved: ResolvedTarget = options.unconfigured === true
          ? { target: null, source: 'unconfigured', warnings: [], updatedAt: null }
          : { target: state.target, source: 'settings', warnings: [], updatedAt: null }
        return { ...resolved, providers: state.providers, models: state.models }
      },
    },
    onAttempt: options.onAttempt ?? ((info) => { attempts.push(info) }),
  })
  return { router, registry, calls, state, attempts, advance: (ms: number) => { now += ms } }
}

const ask = { messages: [{ role: 'user' as const, content: 'hi' }] }

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

// ---- happy path --------------------------------------------------------

test('routes to the primary target and computes cost from the catalogue price', async () => {
  const { router, calls, attempts } = setup()
  const response = await router.complete(ask)
  assert.equal(response.provider, 'openai')
  assert.equal(response.text, 'from openai')
  // 1M input at $2.5 + 0.5M output at $10 = $7.50
  assert.equal(response.costUsd, 7.5)
  assert.equal(calls.length, 1)
  assert.equal(attempts.length, 1)
  assert.deepEqual(
    { provider: attempts[0]?.provider, outcome: attempts[0]?.outcome, position: attempts[0]?.position, costUsd: attempts[0]?.costUsd },
    { provider: 'openai', outcome: 'ok', position: 0, costUsd: 7.5 },
  )
})

test('cache tokens are priced separately and a model without a price has no cost', async () => {
  const anthropic = setup({ target: { provider: 'anthropic', model: 'claude-sonnet-4-5' } })
  // 2000*3 + 1000*15 + 10000*0.3 = 6000 + 15000 + 3000 = 24000 per million = 0.024
  assert.equal((await anthropic.router.complete(ask)).costUsd, 0.024)
  const unpriced = setup({ target: { provider: 'openai', model: 'gpt-small' } })
  assert.equal((await unpriced.router.complete(ask)).costUsd, undefined)
  const free = setup({ target: { provider: 'llamacpp', model: 'qwen3-8b' } })
  assert.equal((await free.router.complete(ask)).costUsd, 0, 'a local model is free, not unknown')
})

test('target parameters fill in the request; reasoning effort applies to the primary only', async () => {
  const { router, calls } = setup({
    target: { provider: 'openai', model: 'gpt-4o', temperature: 0.2, maxTokens: 321, reasoningEffort: 'high', fallback: [{ provider: 'llamacpp', model: 'qwen3-8b' }] },
    routes: { openai: () => busy() },
  })
  await router.complete(ask)
  const [first, second] = calls.map((call) => call.body as Record<string, unknown>)
  assert.equal(first?.temperature, 0.2)
  assert.equal(first?.max_tokens, 321)
  assert.equal(second?.temperature, 0.2, 'sampling parameters follow the chain')
  assert.equal(second?.max_tokens, 321)
  assert.equal('reasoning_effort' in (second ?? {}), false, 'but reasoning effort does not leak to the fallback')
})

test('an explicit request value wins over the target default', async () => {
  const { router, calls } = setup({ target: { provider: 'openai', model: 'gpt-4o', temperature: 0.2, maxTokens: 100 } })
  await router.complete({ ...ask, temperature: 0.9, maxTokens: 7 })
  const body = calls[0]?.body as Record<string, unknown>
  assert.equal(body.temperature, 0.9)
  assert.equal(body.max_tokens, 7)
})

test('an unconfigured target is a clear, non-retryable error', async () => {
  const { router, calls } = setup({ unconfigured: true })
  await assert.rejects(
    () => router.complete(ask),
    (error: unknown) => error instanceof ModelError && error.kind === 'unconfigured' && !error.retryable,
  )
  assert.equal(calls.length, 0)
})

// ---- fallback ----------------------------------------------------------

const chain = (...refs: Array<[string, string]>) => ({ fallback: refs.map(([provider, model]) => ({ provider, model })) })

test('a provider that returns 503 falls back to the next target', async () => {
  const { router, attempts } = setup({ target: { ...chain(['anthropic', 'claude-sonnet-4-5']) }, routes: { openai: () => busy() } })
  const response = await router.complete(ask)
  assert.equal(response.provider, 'anthropic')
  assert.equal(response.text, 'from anthropic')
  assert.deepEqual(attempts.map((a) => [a.provider, a.outcome, a.position, a.kind]), [
    ['openai', 'error', 0, 'overloaded'],
    ['anthropic', 'ok', 1, undefined],
  ])
})

test('a provider that is completely unreachable falls back to the local model', async () => {
  const { router } = setup({ target: { ...chain(['llamacpp', 'qwen3-8b']) }, routes: { openai: () => down() } })
  assert.equal((await router.complete(ask)).text, 'from llama')
})

test('a missing credential on the primary falls through without any network call to it', async () => {
  const { router, calls } = setup({ target: { ...chain(['llamacpp', 'qwen3-8b']) }, env: { ANTHROPIC_API_KEY: 'k' } })
  const response = await router.complete(ask)
  assert.equal(response.provider, 'llamacpp')
  assert.deepEqual(calls.map((call) => new URL(call.url).host), ['127.0.0.1:8080'])
})

test('a primary without a needed capability falls through to one that has it', async () => {
  const models = [...catalog().filter((entry) => entry.provider !== 'llamacpp'), { ...model('llamacpp', 'qwen3-8b', 32_768), capabilities: { ...defaultCapabilities(), contextWindow: 32_768, tools: false } }]
  const { router } = setup({ target: { provider: 'llamacpp', model: 'qwen3-8b', ...chain(['openai', 'gpt-4o']) }, models })
  const response = await router.complete({ ...ask, tools: [{ name: 'bash' }] })
  assert.equal(response.provider, 'openai')
})

test('content filtering and caller aborts never fall back', async () => {
  const filtered = setup({
    target: { ...chain(['anthropic', 'claude-sonnet-4-5']) },
    routes: { openai: () => jsonResponse({ error: { message: 'blocked', type: 'content_policy_violation' } }, 400) },
  })
  await assert.rejects(() => filtered.router.complete(ask), (error: unknown) => error instanceof ModelError && error.kind === 'content_filter')
  assert.equal(filtered.calls.length, 1, 'the fallback was not tried')

  const controller = new AbortController()
  controller.abort()
  const aborted = setup({ target: { ...chain(['anthropic', 'claude-sonnet-4-5']) } })
  await assert.rejects(() => aborted.router.complete(ask, { signal: controller.signal }), (error: unknown) => error instanceof ModelError && error.kind === 'aborted')
  assert.equal(aborted.calls.length, 0)
})

test('shouldFallBack: context overflow only moves to a larger window', () => {
  const overflow = new ModelError('context_overflow', 'too long')
  assert.equal(shouldFallBack(overflow, { contextWindow: 8000 }, { contextWindow: 128_000 }), true)
  assert.equal(shouldFallBack(overflow, { contextWindow: 128_000 }, { contextWindow: 8000 }), false)
  assert.equal(shouldFallBack(overflow, { contextWindow: 8000 }, { contextWindow: 8000 }), false)
  for (const kind of ['rate_limit', 'overloaded', 'timeout', 'network', 'auth', 'quota', 'invalid_request', 'unsupported', 'unavailable'] as const) {
    assert.equal(shouldFallBack(new ModelError(kind, 'x'), { contextWindow: 1 }, { contextWindow: 1 }), true, kind)
  }
  assert.equal(shouldFallBack(new ModelError('content_filter', 'x'), { contextWindow: 1 }, { contextWindow: 2 }), false)
  assert.equal(shouldFallBack(new ModelError('aborted', 'x'), { contextWindow: 1 }, { contextWindow: 2 }), false)
})

test('a context overflow falls back to a larger model but not to a smaller one', async () => {
  const overflow = () => jsonResponse({ error: { message: "This model's maximum context length is 8000 tokens", code: 'context_length_exceeded' } }, 400)
  const larger = setup({ target: { provider: 'openai', model: 'gpt-small', ...chain(['anthropic', 'claude-sonnet-4-5']) }, routes: { openai: overflow } })
  assert.equal((await larger.router.complete(ask)).provider, 'anthropic')
  const smaller = setup({ target: { provider: 'openai', model: 'gpt-4o', ...chain(['openai', 'gpt-small']) }, routes: { openai: overflow } })
  await assert.rejects(() => smaller.router.complete(ask), (error: unknown) => error instanceof ModelError && error.kind === 'unavailable')
  assert.equal(smaller.calls.length, 1, 'the smaller model was never tried')
})

// ---- total failure -----------------------------------------------------

test('a single target rethrows its own error unchanged', async () => {
  const { router } = setup({ routes: { openai: () => jsonResponse({ error: { message: 'bad key' } }, 401) } })
  await assert.rejects(() => router.complete(ask), (error: unknown) => error instanceof ModelError && error.kind === 'auth' && error.status === 401)
})

test('when every target fails the error is "unavailable" with a per-target summary and no secrets', async () => {
  const { router } = setup({
    target: { ...chain(['anthropic', 'claude-sonnet-4-5'], ['llamacpp', 'qwen3-8b']) },
    routes: {
      openai: () => busy(),
      anthropic: () => jsonResponse({ type: 'error', error: { type: 'overloaded_error', message: `Overloaded for ${ENV.ANTHROPIC_API_KEY}` } }, 529),
      llama: () => down(),
    },
  })
  await assert.rejects(() => router.complete(ask), (error: unknown) => {
    assert.ok(error instanceof ModelError)
    assert.equal(error.kind, 'unavailable')
    assert.equal(error.retryable, false)
    assert.match(error.message, /all 3 model target\(s\) failed/)
    assert.match(error.message, /openai\/gpt-4o: overloaded/)
    assert.match(error.message, /anthropic\/claude-sonnet-4-5: overloaded/)
    assert.match(error.message, /llamacpp\/qwen3-8b: network/)
    const everything = JSON.stringify({ message: error.message, cause: error.cause })
    assert.ok(!everything.includes('secret-value'), 'no credential in the error or its causes')
    return true
  })
})

// ---- policy ------------------------------------------------------------

test('local-only egress skips cloud providers and uses the local route', async () => {
  const { router, calls, attempts } = setup({
    target: { ...chain(['llamacpp', 'qwen3-8b']) },
    env: { ...ENV, AIFACTORY_MODEL_EGRESS: 'local-only' },
  })
  const response = await router.complete(ask)
  assert.equal(response.provider, 'llamacpp')
  assert.deepEqual(calls.map((call) => new URL(call.url).host), ['127.0.0.1:8080'], 'nothing left the host')
  assert.deepEqual(attempts.map((a) => [a.provider, a.outcome]), [['openai', 'skipped'], ['llamacpp', 'ok']])
})

test('local-only egress with only cloud targets fails without any network call', async () => {
  const { router, calls } = setup({ env: { ...ENV, AIFACTORY_MODEL_EGRESS: 'local-only' } })
  await assert.rejects(() => router.complete(ask), (error: unknown) => error instanceof ModelError && /local-only/.test(error.message))
  assert.equal(calls.length, 0)
})

test('disabled and deleted providers are skipped', async () => {
  const disabled = providers().map((entry) => (entry.id === 'openai' ? { ...entry, enabled: false } : entry))
  const a = setup({ target: { ...chain(['llamacpp', 'qwen3-8b']) }, providerList: disabled })
  assert.equal((await a.router.complete(ask)).provider, 'llamacpp')
  const removed = providers().filter((entry) => entry.id !== 'openai')
  const b = setup({ target: { ...chain(['llamacpp', 'qwen3-8b']) }, providerList: removed })
  assert.equal((await b.router.complete(ask)).provider, 'llamacpp')
})

test('the base URL override from the environment is honoured', async () => {
  const { router, calls } = setup({
    target: { provider: 'llamacpp', model: 'qwen3-8b' },
    env: { ...ENV, AIFACTORY_LLAMACPP_BASE_URL: 'http://10.0.0.5:9000/v1' },
  })
  await assert.rejects(() => router.complete(ask)) // unexpected host in the scripted fetch
  assert.equal(calls[0]?.url, 'http://10.0.0.5:9000/v1/chat/completions')
})

// ---- snapshot semantics ------------------------------------------------

test('a plan is a snapshot: changing the target does not affect a run already planned', async () => {
  const { router, state, calls } = setup()
  const plan = await router.plan()
  state.target = { provider: 'anthropic', model: 'claude-sonnet-4-5', fallback: [] }
  assert.equal((await router.complete(ask, { plan })).provider, 'openai', 'the in-flight run keeps its target')
  assert.equal((await router.complete(ask)).provider, 'anthropic', 'the next run sees the change')
  assert.equal(calls.length, 2)
})

// ---- breaker integration ----------------------------------------------

test('a dead provider is quarantined: calls skip it without network I/O, and it recovers after the cool-down', async () => {
  let healthy = false
  const { router, calls, advance } = setup({
    target: { ...chain(['llamacpp', 'qwen3-8b']) },
    routes: { openai: () => (healthy ? openaiOk('back') : down()) },
  })
  for (let i = 0; i < 3; i++) assert.equal((await router.complete(ask)).provider, 'llamacpp')
  const openaiCalls = () => calls.filter((call) => new URL(call.url).host === 'api.openai.com').length
  assert.equal(openaiCalls(), 3, 'three failures opened the breaker')

  for (let i = 0; i < 5; i++) assert.equal((await router.complete(ask)).provider, 'llamacpp')
  assert.equal(openaiCalls(), 3, 'quarantined: no more calls to the dead provider')

  healthy = true
  advance(1001)
  const recovered = await router.complete(ask)
  assert.equal(recovered.provider, 'openai', 'the probe succeeded and the primary is back')
  assert.equal(recovered.text, 'back')
})

test('provider config changes get a fresh breaker, but target changes keep the history', async () => {
  const { router, registry, state } = setup({ routes: { openai: () => down() } })
  for (let i = 0; i < 3; i++) await assert.rejects(() => router.complete(ask))
  assert.equal(registry.runtime().find((entry) => entry.provider === 'openai')?.breaker.state, 'open')
  state.target = { provider: 'openai', model: 'gpt-small', fallback: [] }
  await assert.rejects(() => router.complete(ask), (error: unknown) => error instanceof ModelError && error.kind === 'unavailable')
  state.providers = providers().map((entry) => (entry.id === 'openai' ? { ...entry, baseUrl: 'https://api.openai.com/v1' } : entry))
  await router.plan()
  await assert.rejects(() => router.complete(ask), (error: unknown) => error instanceof ModelError && error.kind !== 'unavailable')
})

// ---- streaming ---------------------------------------------------------

const chatStream = (...parts: string[]): Response => sseResponse([
  ...parts.map((part) => frame({ id: 's', choices: [{ delta: { content: part } }] })),
  frame({ id: 's', choices: [{ delta: {}, finish_reason: 'stop' }] }),
  frame({ id: 's', choices: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }),
  'data: [DONE]\n\n',
], { chunkSize: 9 })

test('a stream that fails before its first event falls back, and the done event carries the cost', async () => {
  const { router } = setup({
    target: { ...chain(['llamacpp', 'qwen3-8b']) },
    routes: { openai: () => busy(), llama: () => chatStream('lo', 'cal') },
  })
  const events = await collect(router.stream(ask))
  const done = events.at(-1)
  assert.equal(done?.type === 'done' && done.response.text, 'local')
  assert.equal(done?.type === 'done' && done.response.provider, 'llamacpp')
  assert.equal(done?.type === 'done' && done.response.costUsd, 0)

  const priced = setup({ routes: { openai: () => chatStream('hi') } })
  const pricedDone = (await collect(priced.router.stream(ask))).at(-1)
  assert.equal(pricedDone?.type === 'done' && pricedDone.response.costUsd, 2.5)
})

test('a stream that fails after emitting text is not restarted on the fallback', async () => {
  const cut = (): Response => sseResponse([frame({ id: 's', choices: [{ delta: { content: 'partial' } }] }), frame({ error: { message: 'overloaded', type: 'server_error' } })])
  const { router, calls } = setup({ target: { ...chain(['llamacpp', 'qwen3-8b']) }, routes: { openai: cut } })
  const seen: string[] = []
  await assert.rejects(async () => {
    for await (const event of router.stream(ask)) if (event.type === 'text') seen.push(event.text)
  }, (error: unknown) => error instanceof ModelError && error.kind === 'overloaded')
  assert.deepEqual(seen, ['partial'])
  assert.equal(calls.some((call) => new URL(call.url).host === '127.0.0.1:8080'), false, 'the fallback was not asked')
})

// ---- observers ---------------------------------------------------------

test('a throwing observer never affects the call', async () => {
  const { router } = setup({ onAttempt: () => { throw new Error('observer bug') } })
  assert.equal((await router.complete(ask)).text, 'from openai')
})

test('attempt reports carry correlation ids and never include prompts or keys', async () => {
  const { router, attempts } = setup({ target: { ...chain(['anthropic', 'claude-sonnet-4-5']) }, routes: { openai: () => busy() } })
  await router.complete({ ...ask, messages: [{ role: 'user', content: 'TOP-SECRET-PROMPT' }], projectId: 'p1', stageRunId: 'r1', role: 'author' })
  assert.ok(attempts.every((a) => a.projectId === 'p1' && a.stageRunId === 'r1' && a.role === 'author'))
  const serialized = JSON.stringify(attempts)
  assert.ok(!serialized.includes('TOP-SECRET-PROMPT'))
  assert.ok(!serialized.includes('secret-value'))
})
