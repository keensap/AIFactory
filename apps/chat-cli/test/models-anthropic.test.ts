import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelError, defaultCapabilities, type ModelEvent, type ProviderRecord } from '../src/models/index.ts'
import { AnthropicEngine, mapAnthropicStop, mapAnthropicUsage, toAnthropicMessages } from '../src/models/engines/anthropic.ts'
import { baseRequest, defineModelEngineContract } from './support/model-engine-contract.ts'
import { frame, jsonResponse, recordingFetch, sseResponse, type Handler } from './support/fake-fetch.ts'

const provider = (overrides: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id: 'test', kind: 'anthropic', displayName: 'Anthropic', baseUrl: null, apiKeyEnv: 'ANTHROPIC_API_KEY',
  headers: {}, defaults: {}, enabled: true, local: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
})

const message = (extra: Record<string, unknown> = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant',
  content: [{ type: 'text', text: 'hello world' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 4 },
  ...extra,
})

/** The documented stream sequence: start, ping, text, tool_use via input_json_delta, deltas, stop. */
const documentedStream = (): string[] => [
  frame({ type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', content: [], model: 'claude', stop_reason: null, usage: { input_tokens: 25, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 1 } } }, 'message_start'),
  frame({ type: 'ping' }, 'ping'),
  frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, 'content_block_start'),
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I should check' } }, 'content_block_delta'),
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQB...' } }, 'content_block_delta'),
  frame({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
  frame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, 'content_block_start'),
  frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Okay, let’s' } }, 'content_block_delta'),
  frame({ type: 'ping' }, 'ping'),
  frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' check ✓' } }, 'content_block_delta'),
  frame({ type: 'content_block_stop', index: 1 }, 'content_block_stop'),
  frame({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } }, 'content_block_start'),
  frame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '' } }, 'content_block_delta'),
  frame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"location":' } }, 'content_block_delta'),
  frame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ' "San Francisco, CA"}' } }, 'content_block_delta'),
  frame({ type: 'content_block_stop', index: 2 }, 'content_block_stop'),
  frame({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 89 } }, 'message_delta'),
  frame({ type: 'message_stop' }, 'message_stop'),
]

const simpleStream = (): string[] => [
  frame({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 10, output_tokens: 1 } } }),
  frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } }),
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
  frame({ type: 'content_block_stop', index: 0 }),
  frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
  frame({ type: 'message_stop' }),
]

const standard: Handler = (call) => (
  (call.body as { stream?: boolean }).stream === true ? sseResponse(simpleStream(), { chunkSize: 11 }) : jsonResponse(message())
)

/** `key: null` means no credential at all (an `undefined` default would mask it). */
function engineWith(handler: Handler = standard, record: Partial<ProviderRecord> = {}, key: string | null = 'sk-ant-test') {
  const { fetch, calls } = recordingFetch(handler)
  return { engine: new AnthropicEngine({ provider: provider(record), fetch, apiKey: () => key ?? undefined }), calls }
}

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

// ---- shared contract ---------------------------------------------------

defineModelEngineContract('anthropic', () => engineWith().engine, {
  withoutTools: () => new AnthropicEngine({
    provider: provider(), apiKey: () => 'k', fetch: recordingFetch(standard).fetch,
    capabilities: () => ({ ...defaultCapabilities(), tools: false }),
  }),
  failing: () => engineWith(() => jsonResponse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529)).engine,
})

// ---- request bodies (golden) ------------------------------------------

test('the system prompt is top-level and max_tokens is always present', () => {
  const { engine } = engineWith()
  const body = engine.buildBody(baseRequest({ model: 'claude-sonnet-4-5', system: 'be brief', temperature: 0.2, stop: ['END'] }), false)
  assert.equal(body.system, 'be brief')
  assert.equal(body.max_tokens, 4096, 'required by the API, so a default is always supplied')
  assert.equal(body.temperature, 0.2)
  assert.deepEqual(body.stop_sequences, ['END'])
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  assert.equal('stream' in body, false)
  assert.equal(engine.buildBody(baseRequest({ maxTokens: 777 }), true).max_tokens, 777)
  assert.equal(engine.buildBody(baseRequest(), true).stream, true)
})

test('tools use input_schema and system-role messages join the system prompt', () => {
  const { engine } = engineWith()
  const body = engine.buildBody(baseRequest({
    system: 'base',
    tools: [{ name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }, { name: 'noop' }],
    messages: [{ role: 'system', content: 'extra rule' }, { role: 'user', content: 'hi' }],
  }), false)
  assert.equal(body.system, 'base\n\nextra rule')
  assert.deepEqual(body.tools, [
    { name: 'get_weather', description: 'Weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
    { name: 'noop', input_schema: { type: 'object', properties: {} } },
  ])
})

test('thinking uses an enabled budget bounded by max_tokens and drops temperature', () => {
  const { engine } = engineWith()
  const high = engine.buildBody(baseRequest({ thinking: true, reasoningEffort: 'high', maxTokens: 20000, temperature: 0.5 }), false)
  assert.deepEqual(high.thinking, { type: 'enabled', budget_tokens: 8192 })
  assert.equal('temperature' in high, false, 'temperature must not be set with thinking')
  assert.deepEqual(engine.buildBody(baseRequest({ thinking: true, maxTokens: 20000 }), false).thinking, { type: 'enabled', budget_tokens: 4096 })
  assert.deepEqual(engine.buildBody(baseRequest({ thinking: true, reasoningEffort: 'high', maxTokens: 3000 }), false).thinking, { type: 'enabled', budget_tokens: 2999 })
  assert.throws(
    () => engine.buildBody(baseRequest({ thinking: true, maxTokens: 1024 }), false),
    (error: unknown) => error instanceof ModelError && error.kind === 'invalid_request' && /exceed 1024/.test(error.message),
  )
  assert.equal('thinking' in engine.buildBody(baseRequest(), false), false)
})

test('JSON mode is expressed as a system instruction, optionally with the schema', () => {
  const { engine } = engineWith()
  const plain = engine.buildBody(baseRequest({ responseFormat: { type: 'json' } }), false)
  assert.match(String(plain.system), /single valid JSON value/)
  const withSchema = engine.buildBody(baseRequest({ system: 'base', responseFormat: { type: 'json', schema: { type: 'object' } } }), false)
  assert.match(String(withSchema.system), /^base\n\nRespond with/)
  assert.match(String(withSchema.system), /"type":"object"/)
})

test('messages: tool results become one user message, tool_result first; roles alternate', () => {
  const { messages } = toAnthropicMessages(baseRequest({
    messages: [
      { role: 'user', content: 'weather in two places?' },
      { role: 'assistant', content: 'checking', toolCalls: [
        { id: 'toolu_1', name: 'get_weather', arguments: { city: 'Oslo' } },
        { id: 'toolu_2', name: 'get_weather', arguments: { city: 'Rome' } },
      ] },
      { role: 'user', content: 'also be quick' },
      { role: 'tool', content: '3C', toolCallId: 'toolu_1' },
      { role: 'tool', content: '21C', toolCallId: 'toolu_2' },
    ],
  }))
  assert.deepEqual(messages.map((entry) => entry.role), ['user', 'assistant', 'user'])
  assert.deepEqual(messages[1]?.content, [
    { type: 'text', text: 'checking' },
    { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Oslo' } },
    { type: 'tool_use', id: 'toolu_2', name: 'get_weather', input: { city: 'Rome' } },
  ])
  assert.deepEqual(messages[2]?.content, [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: '3C' },
    { type: 'tool_result', tool_use_id: 'toolu_2', content: '21C' },
    { type: 'text', text: 'also be quick' },
  ])
})

test('empty text is never sent and consecutive same-role messages are merged', () => {
  const { messages } = toAnthropicMessages(baseRequest({
    messages: [
      { role: 'user', content: '' },
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: '' },
    ],
  }))
  assert.deepEqual(messages, [{ role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }])
})

// ---- transport ---------------------------------------------------------

test('headers use x-api-key and the API version, never a bearer token', async () => {
  const { engine, calls } = engineWith()
  await engine.complete(baseRequest({ model: 'claude-sonnet-4-5' }))
  assert.equal(calls[0]?.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(calls[0]?.headers.get('x-api-key'), 'sk-ant-test')
  assert.equal(calls[0]?.headers.get('anthropic-version'), '2023-06-01')
  assert.equal(calls[0]?.headers.get('authorization'), null)
  assert.equal(calls[0]?.headers.get('content-type'), 'application/json')
})

test('a custom base URL gets /v1 exactly once and provider headers may override the version', async () => {
  for (const baseUrl of ['https://gw.example.com', 'https://gw.example.com/', 'https://gw.example.com/v1']) {
    const { engine, calls } = engineWith(standard, { baseUrl, headers: { 'anthropic-version': '2024-01-01' } })
    await engine.complete(baseRequest())
    assert.equal(calls[0]?.url, 'https://gw.example.com/v1/messages', baseUrl)
    assert.equal(calls[0]?.headers.get('anthropic-version'), '2024-01-01')
  }
})

test('a missing key fails before any network call and is reported as unconfigured', async () => {
  const { engine, calls } = engineWith(standard, {}, null)
  await assert.rejects(
    () => engine.complete(baseRequest()),
    (error: unknown) => error instanceof ModelError && error.kind === 'auth' && /ANTHROPIC_API_KEY/.test(error.message),
  )
  assert.equal(calls.length, 0)
  assert.equal((await engine.health()).state, 'unconfigured')
})

// ---- responses ---------------------------------------------------------

test('usage keeps cache tokens separate and totals include them', () => {
  assert.deepEqual(mapAnthropicUsage({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 }), {
    inputTokens: 100, outputTokens: 20, totalTokens: 155, cacheReadTokens: 30, cacheWriteTokens: 5,
  })
  assert.deepEqual(mapAnthropicUsage(undefined), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
})

test('stop reasons map to the neutral finish reasons', () => {
  assert.equal(mapAnthropicStop('end_turn'), 'stop')
  assert.equal(mapAnthropicStop('stop_sequence'), 'stop')
  assert.equal(mapAnthropicStop('pause_turn'), 'stop')
  assert.equal(mapAnthropicStop('max_tokens'), 'length')
  assert.equal(mapAnthropicStop('model_context_window_exceeded'), 'length')
  assert.equal(mapAnthropicStop('tool_use'), 'tool_calls')
  assert.equal(mapAnthropicStop('refusal'), 'content_filter')
  assert.equal(mapAnthropicStop(undefined), 'stop')
})

test('complete parses text, thinking and tool_use blocks', async () => {
  const { engine } = engineWith(() => jsonResponse(message({
    content: [
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'text', text: 'Let me check. ' },
      { type: 'text', text: 'Done.' },
      { type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: { city: 'Oslo' } },
      { type: 'redacted_thinking', data: 'xx' },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 },
  })))
  const response = await engine.complete(baseRequest())
  assert.equal(response.text, 'Let me check. Done.')
  assert.equal(response.thinking, 'hmm')
  assert.deepEqual(response.toolCalls, [{ id: 'toolu_9', name: 'get_weather', arguments: { city: 'Oslo' } }])
  assert.equal(response.finishReason, 'tool_calls')
  assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 7, totalTokens: 22, cacheReadTokens: 3, cacheWriteTokens: 0 })
  assert.equal(response.providerRequestId, 'msg_1')
})

// ---- errors ------------------------------------------------------------

const failing = (status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) =>
  engineWith(() => jsonResponse({ type: 'error', error, request_id: 'req_1' }, status, headers)).engine

test('HTTP errors map to normalized kinds with Retry-After', async () => {
  const cases: Array<[number, Record<string, unknown>, string]> = [
    [401, { type: 'authentication_error', message: 'invalid x-api-key' }, 'auth'],
    [403, { type: 'permission_error', message: 'no access' }, 'auth'],
    [429, { type: 'rate_limit_error', message: 'slow down' }, 'rate_limit'],
    [529, { type: 'overloaded_error', message: 'Overloaded' }, 'overloaded'],
    [500, { type: 'api_error', message: 'oops' }, 'overloaded'],
    [413, { type: 'request_too_large', message: 'too large' }, 'context_overflow'],
    [400, { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' }, 'context_overflow'],
    [400, { type: 'invalid_request_error', message: 'max_tokens: field required' }, 'invalid_request'],
  ]
  for (const [status, error, kind] of cases) {
    await assert.rejects(
      () => failing(status, error).complete(baseRequest()),
      (thrown: unknown) => thrown instanceof ModelError && thrown.kind === kind && thrown.status === status,
      `${status} → ${kind}`,
    )
  }
  await assert.rejects(
    () => failing(429, { type: 'rate_limit_error', message: 'x' }, { 'retry-after': '12' }).complete(baseRequest()),
    (thrown: unknown) => thrown instanceof ModelError && thrown.retryAfterMs === 12000 && thrown.retryable,
  )
  await assert.rejects(
    () => failing(401, { type: 'authentication_error', message: 'invalid x-api-key sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }).complete(baseRequest()),
    (thrown: unknown) => thrown instanceof ModelError && !thrown.message.includes('abcdefghijklmnopqrstuvwxyz'),
  )
})

// ---- streaming ---------------------------------------------------------

test('the documented stream sequence is assembled for any chunking', async () => {
  for (const chunkSize of [1, 13, 4096]) {
    const { engine } = engineWith(() => sseResponse(documentedStream(), { chunkSize }))
    const events = await collect(engine.stream(baseRequest({ tools: [{ name: 'get_weather' }], thinking: true, maxTokens: 20000 })))
    assert.deepEqual(events.filter((e) => e.type === 'thinking').map((e) => (e as { text: string }).text), ['I should check'], `chunk ${chunkSize}`)
    assert.equal(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join(''), 'Okay, let’s check ✓')
    const calls = events.filter((e) => e.type === 'tool_call').map((e) => (e as { call: unknown }).call)
    assert.deepEqual(calls, [{ id: 'toolu_1', name: 'get_weather', arguments: { location: 'San Francisco, CA' } }])
    const done = events.at(-1)
    assert.equal(done?.type, 'done')
    if (done?.type === 'done') {
      assert.equal(done.response.finishReason, 'tool_calls')
      // message_start carries input + cache usage; message_delta's output usage is cumulative.
      assert.deepEqual(done.response.usage, { inputTokens: 25, outputTokens: 89, totalTokens: 121, cacheReadTokens: 5, cacheWriteTokens: 2 })
      assert.equal(done.response.thinking, 'I should check')
      assert.equal(done.response.providerRequestId, 'msg_s')
    }
  }
})

test('an in-stream error event becomes a normalized error after text already sent', async () => {
  const frames = [
    frame({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1, output_tokens: 1 } } }),
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }),
    frame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error'),
  ]
  const seen: string[] = []
  await assert.rejects(async () => {
    for await (const event of engineWith(() => sseResponse(frames)).engine.stream(baseRequest())) if (event.type === 'text') seen.push(event.text)
  }, (error: unknown) => error instanceof ModelError && error.kind === 'overloaded' && error.retryable)
  assert.deepEqual(seen, ['partial'])
})

test('a stream cut off before message_stop is a retryable network error, not a silent truncation', async () => {
  const frames = simpleStream().slice(0, -2)
  await assert.rejects(
    () => collect(engineWith(() => sseResponse(frames)).engine.stream(baseRequest())),
    (error: unknown) => error instanceof ModelError && error.kind === 'network' && /message_stop/.test(error.message),
  )
})

test('invalid tool input JSON is kept as raw text and does not fail the stream', async () => {
  const frames = [
    frame({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1, output_tokens: 1 } } }),
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'f', input: {} } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"oops' } }),
    frame({ type: 'content_block_stop', index: 0 }),
    frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }),
    frame({ type: 'message_stop' }),
  ]
  const events = await collect(engineWith(() => sseResponse(frames)).engine.stream(baseRequest({ tools: [{ name: 'f' }] })))
  assert.equal((events.find((event) => event.type === 'tool_call') as { call: { arguments: unknown } }).call.arguments, '{"oops')
})

test('streaming HTTP errors are raised before any event', async () => {
  const engine = failing(529, { type: 'overloaded_error', message: 'Overloaded' })
  await assert.rejects(() => collect(engine.stream(baseRequest())), (error: unknown) => error instanceof ModelError && error.kind === 'overloaded')
})
