import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelError } from '../src/models/index.ts'
import { kindFromErrorType, parseRetryAfter, parseSse, redact, type SseMessage } from '../src/models/engines/shared.ts'
import { sseResponse } from './support/fake-fetch.ts'

const ctx = { provider: 'test', model: 'm' }

async function collect(response: Response, signal?: AbortSignal): Promise<SseMessage[]> {
  const out: SseMessage[] = []
  for await (const message of parseSse(response.body, ctx, signal)) out.push(message)
  return out
}

test('parses events, multi-line data, comments and the event field', async () => {
  const messages = await collect(sseResponse([
    ': keep-alive\n\n',
    'event: greeting\ndata: hello\n\n',
    'data: line one\ndata: line two\n\n',
    'data:no-space\n\n',
  ]))
  assert.deepEqual(messages, [
    { event: 'greeting', data: 'hello' },
    { event: undefined, data: 'line one\nline two' },
    { event: undefined, data: 'no-space' },
  ])
})

test('is independent of chunk boundaries, including 1-byte chunks and multi-byte text', async () => {
  const frames = ['data: {"t":"héllo ✓ 世界"}\n\n', 'data: [DONE]\n\n']
  for (const chunkSize of [1, 2, 3, 7, 1000]) {
    const messages = await collect(sseResponse(frames, { chunkSize }))
    assert.deepEqual(messages.map((message) => message.data), ['{"t":"héllo ✓ 世界"}', '[DONE]'], `chunkSize ${chunkSize}`)
  }
})

test('handles CRLF and bare CR line endings, even when CR and LF are split across chunks', async () => {
  const crlf = 'event: a\r\ndata: one\r\n\r\ndata: two\r\n\r\n'
  const cr = 'data: three\r\r'
  for (const chunkSize of [1, 5, 100]) {
    assert.deepEqual((await collect(sseResponse([crlf], { chunkSize }))).map((m) => m.data), ['one', 'two'], `crlf ${chunkSize}`)
    assert.deepEqual((await collect(sseResponse([cr], { chunkSize }))).map((m) => m.data), ['three'], `cr ${chunkSize}`)
  }
})

test('an unterminated final event is still delivered', async () => {
  const messages = await collect(sseResponse(['data: last']))
  assert.deepEqual(messages, [{ event: undefined, data: 'last' }])
})

test('events without data are dropped and fields reset between events', async () => {
  const messages = await collect(sseResponse(['event: ping\n\n', 'data: x\n\n']))
  assert.deepEqual(messages, [{ event: undefined, data: 'x' }])
})

test('an oversized line is rejected instead of buffered without bound', async () => {
  const huge = `data: ${'x'.repeat(5 * 1024 * 1024)}`
  await assert.rejects(
    () => collect(sseResponse([huge], { chunkSize: 1024 * 1024 })),
    (error: unknown) => error instanceof ModelError && /oversized/.test(error.message),
  )
})

test('aborting stops the stream with an aborted error', async () => {
  const controller = new AbortController()
  const response = sseResponse(['data: first\n\n'], { endWith: 'hang' })
  const seen: string[] = []
  await assert.rejects(async () => {
    for await (const message of parseSse(response.body, ctx, controller.signal)) {
      seen.push(message.data)
      controller.abort()
    }
  }, (error: unknown) => error instanceof ModelError && error.kind === 'aborted')
  assert.deepEqual(seen, ['first'])
})

test('a missing body is a normalized error', async () => {
  await assert.rejects(async () => { for await (const _ of parseSse(null, ctx)) void _ }, (error: unknown) => error instanceof ModelError)
})

test('Retry-After accepts seconds and dates and is bounded', () => {
  assert.equal(parseRetryAfter('7'), 7000)
  assert.equal(parseRetryAfter('0'), 0)
  assert.equal(parseRetryAfter('1.5'), 1500)
  assert.equal(parseRetryAfter(null), undefined)
  assert.equal(parseRetryAfter(''), undefined)
  assert.equal(parseRetryAfter('soon'), undefined)
  assert.equal(parseRetryAfter('999999'), 5 * 60 * 1000, 'capped at five minutes')
  const now = Date.parse('2026-01-01T00:00:00Z')
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now), 30_000)
  assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now), 0, 'a past date means retry now')
})

test('redaction scrubs credentials and bounds length', () => {
  const out = redact('failed: Authorization: Bearer sk-abcdefghijklmnopqrstuvwx and api_key=SECRETVALUE123 ' + 'x'.repeat(2000))
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwx'))
  assert.ok(!out.includes('SECRETVALUE123'))
  assert.ok(out.length <= 700)
  assert.equal(redact('a\n\n  b\t c'), 'a b c')
})

test('provider error types map to normalized kinds', () => {
  assert.equal(kindFromErrorType('overloaded_error'), 'overloaded')
  assert.equal(kindFromErrorType('api_error'), 'overloaded')
  assert.equal(kindFromErrorType('rate_limit_error'), 'rate_limit')
  assert.equal(kindFromErrorType('rate_limit_exceeded'), 'rate_limit')
  assert.equal(kindFromErrorType('authentication_error'), 'auth')
  assert.equal(kindFromErrorType('permission_error'), 'auth')
  assert.equal(kindFromErrorType('invalid_request_error'), 'invalid_request')
  assert.equal(kindFromErrorType('insufficient_quota'), 'quota')
  assert.equal(kindFromErrorType('invalid_request_error', 'prompt is too long: 250000 tokens'), 'context_overflow')
  assert.equal(kindFromErrorType('something_new'), 'unknown')
})
