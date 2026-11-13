import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ModelError,
  defaultCapabilities,
  type ModelEvent,
  type ProviderRecord,
} from '../src/models/index.ts'
import { OpenAICompatibleEngine, mapOpenAIUsage } from '../src/models/engines/openai-compatible.ts'
import { baseRequest, defineModelEngineContract } from './support/model-engine-contract.ts'
import { frame, jsonResponse, recordingFetch, sseResponse, type Handler } from './support/fake-fetch.ts'

const provider = (overrides: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id: 'test', kind: 'openai-compatible', displayName: 'Test', baseUrl: 'http://127.0.0.1:8080/v1',
  apiKeyEnv: null, headers: {}, defaults: {}, enabled: true, local: true,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
})

const openai = (overrides: Partial<ProviderRecord> = {}) =>
  provider({ id: 'openai', kind: 'openai', baseUrl: null, apiKeyEnv: 'OPENAI_API_KEY', local: false, ...overrides })

const completion = (extra: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  ...extra,
})

const streamFrames = (): string[] => [
  frame({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' } }] }),
  frame({ id: 'c1', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] }),
  frame({ id: 'c1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }),
  'data: [DONE]\n\n',
]

const standard: Handler = (call) => (
  (call.body as { stream?: boolean }).stream === true ? sseResponse(streamFrames(), { chunkSize: 7 }) : jsonResponse(completion())
)

function engineWith(handler: Handler = standard, record: Partial<ProviderRecord> = {}, key: string | undefined = undefined) {
  const { fetch, calls } = recordingFetch(handler)
  const engine = new OpenAICompatibleEngine({ provider: provider(record), fetch, ...(key !== undefined ? { apiKey: () => key } : {}) })
  return { engine, calls }
}

// ---- shared contract ---------------------------------------------------

defineModelEngineContract('openai-compatible', () => engineWith().engine, {
  withoutTools: () => new OpenAICompatibleEngine({
    provider: provider(),
    fetch: recordingFetch(standard).fetch,
    capabilities: () => ({ ...defaultCapabilities(), tools: false }),
  }),
  failing: () => engineWith(() => jsonResponse({ error: { message: 'busy' } }, 503)).engine,
})

// ---- request bodies (golden) ------------------------------------------

test('reasoning models use max_completion_tokens and omit temperature', () => {
  const engine = new OpenAICompatibleEngine({ provider: openai(), apiKey: () => 'k', fetch: recordingFetch(standard).fetch })
  const body = engine.buildBody(baseRequest({ model: 'gpt-5', temperature: 0.3, maxTokens: 500, reasoningEffort: 'high' }), false)
  assert.equal(body.max_completion_tokens, 500)
  assert.equal('max_tokens' in body, false)
  assert.equal('temperature' in body, false)
  assert.equal(body.reasoning_effort, 'high')
  for (const model of ['o3', 'o4-mini', 'gpt-5.4-mini']) {
    assert.equal('temperature' in engine.buildBody(baseRequest({ model, temperature: 1 }), false), false, model)
  }
})

test('classic OpenAI models keep max_tokens and temperature', () => {
  const engine = new OpenAICompatibleEngine({ provider: openai(), apiKey: () => 'k', fetch: recordingFetch(standard).fetch })
  const body = engine.buildBody(baseRequest({ model: 'gpt-4o', temperature: 0.3, maxTokens: 500, reasoningEffort: 'high' }), false)
  assert.equal(body.max_tokens, 500)
  assert.equal(body.temperature, 0.3)
  assert.equal('max_completion_tokens' in body, false)
  assert.equal('reasoning_effort' in body, false, 'not sent to non-reasoning OpenAI models')
})

test('compatible servers get max_tokens, temperature and reasoning only when asked', () => {
  const { engine } = engineWith()
  const plain = engine.buildBody(baseRequest({ temperature: 0.2, maxTokens: 256 }), false)
  assert.equal(plain.max_tokens, 256)
  assert.equal(plain.temperature, 0.2)
  assert.equal('reasoning_effort' in plain, false)
  assert.equal(engine.buildBody(baseRequest({ reasoningEffort: 'low' }), false).reasoning_effort, 'low')
})

test('provider defaults fill in what the request leaves out, and the request wins', () => {
  const { fetch } = recordingFetch(standard)
  const engine = new OpenAICompatibleEngine({ provider: provider({ defaults: { temperature: 0.7, maxTokens: 999 } }), fetch })
  const body = engine.buildBody(baseRequest(), false)
  assert.equal(body.temperature, 0.7)
  assert.equal(body.max_tokens, 999)
  assert.equal(engine.buildBody(baseRequest({ temperature: 0, maxTokens: 5 }), false).temperature, 0)
})

test('tools, stop, json mode and streaming options are serialized', () => {
  const { engine } = engineWith(standard, { local: false })
  const body = engine.buildBody(baseRequest({
    tools: [{ name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }, { name: 'noop' }],
    stop: ['END'],
    responseFormat: { type: 'json', schema: { type: 'object' } },
  }), true)
  assert.deepEqual(body.tools, [
    { type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
    { type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } },
  ])
  assert.deepEqual(body.stop, ['END'])
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'response', schema: { type: 'object' } } })
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.deepEqual(engine.buildBody(baseRequest({ responseFormat: { type: 'json' } }), false).response_format, { type: 'json_object' })
  assert.equal('stream' in engine.buildBody(baseRequest(), false), false)
})

test('messages map system prompts, tool calls and tool results', () => {
  const { engine } = engineWith(standard, { local: false })
  const body = engine.buildBody(baseRequest({
    system: 'be brief',
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Oslo' } }] },
      { role: 'tool', content: '3C', toolCallId: 'call_1' },
    ],
  }), false)
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '3C' },
  ])
})

// ---- transport ---------------------------------------------------------

test('urls and authentication follow the provider kind', async () => {
  const cloud = recordingFetch(() => jsonResponse(completion()))
  await new OpenAICompatibleEngine({ provider: openai(), apiKey: () => 'sk-test-key', fetch: cloud.fetch }).complete(baseRequest({ model: 'gpt-4o' }))
  assert.equal(cloud.calls[0]?.url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(cloud.calls[0]?.headers.get('authorization'), 'Bearer sk-test-key')

  const local = recordingFetch(() => jsonResponse(completion()))
  await new OpenAICompatibleEngine({ provider: provider({ baseUrl: 'http://127.0.0.1:8080/v1/' }), fetch: local.fetch }).complete(baseRequest())
  assert.equal(local.calls[0]?.url, 'http://127.0.0.1:8080/v1/chat/completions', 'trailing slash trimmed')
  assert.equal(local.calls[0]?.headers.get('authorization'), null, 'local servers need no key')

  const gateway = recordingFetch(() => jsonResponse(completion()))
  await new OpenAICompatibleEngine({
    provider: provider({ baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', local: false, headers: { 'X-Title': 'AI Factory' } }),
    apiKey: () => 'or-key', fetch: gateway.fetch,
  }).complete(baseRequest())
  assert.equal(gateway.calls[0]?.headers.get('x-title'), 'AI Factory')
  assert.equal(gateway.calls[0]?.headers.get('authorization'), 'Bearer or-key')
})

test('a missing cloud credential fails before any network call', async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse(completion()))
  const engine = new OpenAICompatibleEngine({ provider: openai(), apiKey: () => undefined, fetch })
  await assert.rejects(
    () => engine.complete(baseRequest({ model: 'gpt-4o' })),
    (error: unknown) => error instanceof ModelError && error.kind === 'auth' && /OPENAI_API_KEY/.test(error.message),
  )
  assert.equal(calls.length, 0)
  assert.equal((await engine.health()).state, 'unconfigured')
})

test('the API key is read at call time so rotation needs no restart', async () => {
  let key = 'first'
  const { fetch, calls } = recordingFetch(() => jsonResponse(completion()))
  const engine = new OpenAICompatibleEngine({ provider: openai(), apiKey: () => key, fetch })
  await engine.complete(baseRequest({ model: 'gpt-4o' }))
  key = 'second'
  await engine.complete(baseRequest({ model: 'gpt-4o' }))
  assert.deepEqual(calls.map((call) => call.headers.get('authorization')), ['Bearer first', 'Bearer second'])
})

// ---- responses ---------------------------------------------------------

test('usage excludes cached tokens, matching the harness convention', () => {
  assert.deepEqual(mapOpenAIUsage({
    prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 30 },
  }), { inputTokens: 70, outputTokens: 20, totalTokens: 120, cacheReadTokens: 30, cacheWriteTokens: 0 })
  assert.deepEqual(mapOpenAIUsage({ prompt_tokens: 5, completion_tokens: 3 }), {
    inputTokens: 5, outputTokens: 3, totalTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
  assert.equal(mapOpenAIUsage({ prompt_tokens: 5, prompt_tokens_details: { cached_tokens: 50 } }).inputTokens, 0, 'never negative')
  assert.deepEqual(mapOpenAIUsage(undefined), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
})

test('complete parses text, reasoning, tool calls and finish reasons', async () => {
  const { engine } = engineWith(() => jsonResponse({
    id: 'x',
    choices: [{
      message: {
        content: null, reasoning_content: 'thinking…',
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }))
  const response = await engine.complete(baseRequest())
  assert.equal(response.text, '')
  assert.equal(response.thinking, 'thinking…')
  assert.deepEqual(response.toolCalls, [{ id: 'call_9', name: 'get_weather', arguments: { city: 'Oslo' } }])
  assert.equal(response.finishReason, 'tool_calls')

  const length = engineWith(() => jsonResponse(completion({ choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] })))
  assert.equal((await length.engine.complete(baseRequest())).finishReason, 'length')
  const filtered = engineWith(() => jsonResponse(completion({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] })))
  assert.equal((await filtered.engine.complete(baseRequest())).finishReason, 'content_filter')
})

test('invalid tool-call JSON is kept as raw text instead of failing the call', async () => {
  const { engine } = engineWith(() => jsonResponse({
    choices: [{ message: { content: '', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{"broken' } }] }, finish_reason: 'tool_calls' }],
  }))
  assert.equal((await engine.complete(baseRequest())).toolCalls[0]?.arguments, '{"broken')
})

test('a response without choices is a normalized error', async () => {
  const { engine } = engineWith(() => jsonResponse({ id: 'x' }))
  await assert.rejects(() => engine.complete(baseRequest()), (error: unknown) => error instanceof ModelError && error.kind === 'unknown')
})

// ---- errors ------------------------------------------------------------

const failing = (status: number, body: unknown, headers: Record<string, string> = {}) => engineWith(() => jsonResponse(body, status, headers)).engine

test('HTTP errors map to kinds, keep status and Retry-After, and never leak secrets', async () => {
  const cases: Array<[number, unknown, string, Record<string, string>]> = [
    [401, { error: { message: 'bad key', type: 'invalid_request_error', code: 'invalid_api_key' } }, 'auth', {}],
    [429, { error: { message: 'slow down', type: 'rate_limit_error' } }, 'rate_limit', { 'retry-after': '7' }],
    [429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }, 'quota', {}],
    [400, { error: { message: "This model's maximum context length is 8192 tokens", code: 'context_length_exceeded' } }, 'context_overflow', {}],
    [400, { error: { message: 'bad parameter' } }, 'invalid_request', {}],
    [503, { error: { message: 'overloaded' } }, 'overloaded', {}],
    [504, { error: { message: 'gateway timeout' } }, 'timeout', {}],
  ]
  for (const [status, body, kind, headers] of cases) {
    await assert.rejects(
      () => failing(status, body, headers).complete(baseRequest()),
      (error: unknown) => error instanceof ModelError && error.kind === kind && error.status === status,
      `${status} → ${kind}`,
    )
  }
  await assert.rejects(
    () => failing(429, { error: { message: 'x' } }, { 'retry-after': '7' }).complete(baseRequest()),
    (error: unknown) => error instanceof ModelError && error.retryAfterMs === 7000 && error.retryable,
  )
  await assert.rejects(
    () => failing(401, { error: { message: 'Incorrect API key provided: sk-abcdefghijklmnopqrstuvwxyz and Bearer sk-abcdefghijklmnopqrstuvwxyz' } }).complete(baseRequest()),
    (error: unknown) => error instanceof ModelError && !error.message.includes('abcdefghijklmnopqrstuvwxyz'),
  )
})

test('non-JSON error bodies still produce a clean error', async () => {
  const { engine } = engineWith(() => new Response('<html>Bad gateway</html>', { status: 502 }))
  await assert.rejects(() => engine.complete(baseRequest()), (error: unknown) => error instanceof ModelError && error.kind === 'overloaded' && error.status === 502)
})

test('network failures become retryable network errors with the cause code', async () => {
  const { engine } = engineWith(() => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
  })
  await assert.rejects(
    () => engine.complete(baseRequest()),
    (error: unknown) => error instanceof ModelError && error.kind === 'network' && error.retryable && /ECONNREFUSED/.test(error.message),
  )
  assert.equal((await engine.health()).state, 'degraded')
})

// ---- streaming ---------------------------------------------------------

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

test('streams text, reasoning and usage for any chunking', async () => {
  const frames = [
    frame({ id: 'c', choices: [{ delta: { reasoning_content: 'hm' } }] }),
    frame({ id: 'c', choices: [{ delta: { content: 'héllo ' } }] }),
    frame({ id: 'c', choices: [{ delta: { content: '✓' }, finish_reason: 'stop' }] }),
    frame({ id: 'c', choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 8 } } }),
    'data: [DONE]\n\n',
  ]
  for (const chunkSize of [1, 3, 64, 100000]) {
    const { engine } = engineWith(() => sseResponse(frames, { chunkSize }))
    const events = await collect(engine.stream(baseRequest()))
    assert.deepEqual(events.filter((e) => e.type === 'thinking').map((e) => (e as { text: string }).text), ['hm'], `chunk ${chunkSize}`)
    const done = events.at(-1)
    assert.equal(done?.type, 'done')
    if (done?.type === 'done') {
      assert.equal(done.response.text, 'héllo ✓')
      assert.equal(done.response.thinking, 'hm')
      assert.deepEqual(done.response.usage, { inputTokens: 12, outputTokens: 5, totalTokens: 25, cacheReadTokens: 8, cacheWriteTokens: 0 })
      assert.equal(done.response.finishReason, 'stop')
    }
  }
})

test('streamed tool calls are assembled from fragments, in index order', async () => {
  const frames = [
    frame({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'second', arguments: '{"b":' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'first', arguments: '{"a"' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ': 1}' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] }, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ]
  const { engine } = engineWith(() => sseResponse(frames, { chunkSize: 5 }), { local: false })
  const events = await collect(engine.stream(baseRequest({ tools: [{ name: 'first' }] })))
  const calls = events.filter((event) => event.type === 'tool_call').map((event) => (event as { call: unknown }).call)
  assert.deepEqual(calls, [
    { id: 'call_a', name: 'first', arguments: { a: 1 } },
    { id: 'call_b', name: 'second', arguments: { b: 2 } },
  ])
  const done = events.at(-1)
  assert.equal(done?.type === 'done' && done.response.finishReason, 'tool_calls')
})

test('an error chunk mid-stream surfaces as a normalized error after the text already sent', async () => {
  const frames = [
    frame({ choices: [{ delta: { content: 'par' } }] }),
    frame({ error: { message: 'server is overloaded', type: 'server_error' } }),
  ]
  const { engine } = engineWith(() => sseResponse(frames))
  const seen: string[] = []
  await assert.rejects(async () => {
    for await (const event of engine.stream(baseRequest())) if (event.type === 'text') seen.push(event.text)
  }, (error: unknown) => error instanceof ModelError && error.kind === 'overloaded')
  assert.deepEqual(seen, ['par'])
})

test('streaming HTTP errors are raised before any event', async () => {
  const { engine } = engineWith(() => jsonResponse({ error: { message: 'nope' } }, 401))
  await assert.rejects(() => collect(engine.stream(baseRequest())), (error: unknown) => error instanceof ModelError && error.kind === 'auth')
})

test('malformed stream frames are skipped, not fatal', async () => {
  const frames = ['data: {not json}\n\n', frame({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']
  const events = await collect(engineWith(() => sseResponse(frames)).engine.stream(baseRequest()))
  const done = events.at(-1)
  assert.equal(done?.type === 'done' && done.response.text, 'ok')
})

test('aborting mid-stream stops with an aborted error and no done event', async () => {
  const controller = new AbortController()
  const { engine } = engineWith(() => sseResponse([frame({ choices: [{ delta: { content: 'a' } }] })], { endWith: 'hang' }))
  const events: ModelEvent[] = []
  await assert.rejects(async () => {
    for await (const event of engine.stream(baseRequest(), controller.signal)) {
      events.push(event)
      controller.abort()
    }
  }, (error: unknown) => error instanceof ModelError && error.kind === 'aborted')
  assert.equal(events.some((event) => event.type === 'done'), false)
})

test('a local route refuses tools until it is enabled for them (llama-server --jinja)', async () => {
  const { engine, calls } = engineWith()
  await assert.rejects(
    () => engine.complete(baseRequest({ tools: [{ name: 'bash' }] })),
    (error: unknown) => error instanceof ModelError && error.kind === 'unsupported' && /tools/.test(error.message),
  )
  assert.equal(calls.length, 0, 'rejected before any network call')

  // Once the catalogue says the model supports tools, the same request is sent.
  const enabled = recordingFetch(() => jsonResponse(completion()))
  const engineWithTools = new OpenAICompatibleEngine({
    provider: provider(),
    fetch: enabled.fetch,
    capabilities: () => ({ ...defaultCapabilities(), tools: true }),
  })
  await engineWithTools.complete(baseRequest({ tools: [{ name: 'bash' }] }))
  assert.equal(enabled.calls.length, 1)
})
