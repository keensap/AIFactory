/**
 * Helpers shared by the direct engines: request posting, SSE parsing and error
 * normalization. No provider SDKs; only `fetch`.
 *
 * Error messages are redacted before they leave this module, because provider
 * error bodies sometimes echo request headers or keys.
 */

import { capString, scrubString } from '../../logging/sanitize.ts'
import { ModelError, kindFromStatus, type ModelErrorKind } from '../ports.ts'

export interface CallContext {
  provider: string
  model: string
}

const MAX_ERROR_BODY_BYTES = 8 * 1024
const MAX_SSE_LINE_CHARS = 4 * 1024 * 1024
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000

/** Scrub secrets and cap length for anything derived from a provider response. */
export function redact(text: string, max = 500): string {
  return scrubString(capString(text.replace(/\s+/g, ' ').trim(), max))
}

export function abortedError(ctx: Partial<CallContext> = {}): ModelError {
  return new ModelError('aborted', 'request aborted by the caller', {
    ...(ctx.provider !== undefined ? { provider: ctx.provider } : {}),
    ...(ctx.model !== undefined ? { model: ctx.model } : {}),
  })
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS)
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS)
}

const CONTEXT_PATTERN = /context[_ ]length|context window|maximum context|too many tokens|prompt is too long|input is too long|request_too_large|exceeds the (?:model|context)/i
const QUOTA_PATTERN = /insufficient_quota|billing|credit balance|exceeded your current quota/i
const FILTER_PATTERN = /content_filter|content[_ ]policy|safety|refus/i

/** Map a provider's error `type`/`code` string (HTTP or in-stream) to a kind. */
export function kindFromErrorType(type: string, message = ''): ModelErrorKind {
  const text = `${type} ${message}`
  if (/overloaded|api_error|server_error|service_unavailable|unavailable/i.test(type)) return 'overloaded'
  if (/rate_limit|too_many_requests/i.test(type)) return 'rate_limit'
  if (/authentication|permission|invalid_api_key|unauthorized|forbidden/i.test(type)) return 'auth'
  if (QUOTA_PATTERN.test(text)) return 'quota'
  if (CONTEXT_PATTERN.test(text)) return 'context_overflow'
  if (FILTER_PATTERN.test(type)) return 'content_filter'
  if (/timeout/i.test(type)) return 'timeout'
  if (/invalid_request|not_found|unprocessable/i.test(type)) return 'invalid_request'
  return 'unknown'
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  try {
    const text = await response.text()
    return text.length <= maxBytes ? text : text.slice(0, maxBytes)
  } catch {
    return ''
  }
}

/** Convert a non-2xx response into a normalized `ModelError`. */
export async function errorFromResponse(response: Response, ctx: CallContext): Promise<ModelError> {
  const body = await readLimited(response, MAX_ERROR_BODY_BYTES)
  let message = body
  let type = ''
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const error = (parsed.error !== null && typeof parsed.error === 'object' ? parsed.error : parsed) as Record<string, unknown>
    if (typeof error.message === 'string') message = error.message
    const rawType = error.type ?? error.code
    if (typeof rawType === 'string') type = rawType
  } catch {
    // Non-JSON bodies are used as-is (after redaction).
  }

  let kind = kindFromStatus(response.status)
  const text = `${type} ${message}`
  if (response.status === 429 && QUOTA_PATTERN.test(text)) kind = 'quota'
  else if ([400, 413, 422].includes(response.status) && CONTEXT_PATTERN.test(text)) kind = 'context_overflow'
  else if (response.status === 400 && FILTER_PATTERN.test(type)) kind = 'content_filter'
  else if (response.status === 504) kind = 'timeout'

  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
  const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined
  return new ModelError(kind, `${ctx.provider} HTTP ${response.status}: ${redact(message === '' ? response.statusText : message)}`, {
    status: response.status,
    provider: ctx.provider,
    model: ctx.model,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(requestId !== undefined ? { providerRequestId: redact(requestId, 100) } : {}),
  })
}

/** Convert a thrown `fetch` failure into a `ModelError`. */
export function errorFromFetch(error: unknown, ctx: CallContext, signal?: AbortSignal): ModelError {
  if (error instanceof ModelError) return error
  if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) return abortedError(ctx)
  const cause = error instanceof Error && error.cause !== null && typeof error.cause === 'object'
    ? (error.cause as { code?: unknown; message?: unknown })
    : undefined
  const detail = typeof cause?.code === 'string'
    ? cause.code
    : error instanceof Error ? error.message : String(error)
  return new ModelError('network', `${ctx.provider} unreachable: ${redact(detail)}`, {
    provider: ctx.provider,
    model: ctx.model,
    cause: error,
  })
}

/** POST a JSON body; resolves only for 2xx responses, rejects with `ModelError`. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  ctx: CallContext,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted === true) throw abortedError(ctx)
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error) {
    throw errorFromFetch(error, ctx, signal)
  }
  if (!response.ok) throw await errorFromResponse(response, ctx)
  return response
}

/** Parse a successful JSON body. */
export async function readJson(response: Response, ctx: CallContext, signal?: AbortSignal): Promise<Record<string, unknown>> {
  try {
    const value = await response.json() as unknown
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch (error) {
    if (signal?.aborted === true) throw abortedError(ctx)
    throw new ModelError('unknown', `${ctx.provider} returned a body that is not JSON`, { provider: ctx.provider, model: ctx.model, cause: error })
  }
  throw new ModelError('unknown', `${ctx.provider} returned an unexpected response shape`, { provider: ctx.provider, model: ctx.model })
}

export interface SseMessage {
  event: string | undefined
  data: string
}

/**
 * Incremental Server-Sent Events parser.
 *
 * Handles `\n`, `\r\n` and `\r` line endings across chunk boundaries, multi-line
 * `data:` fields, comments and chunked UTF-8. Honours the abort signal and
 * bounds memory with a line-length cap.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array> | null,
  ctx: CallContext,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage> {
  if (body === null) throw new ModelError('unknown', `${ctx.provider} returned no response body`, { provider: ctx.provider, model: ctx.model })
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const onAbort = (): void => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })

  let buffer = ''
  let pendingCr = ''
  let event: string | undefined
  let data: string[] = []

  const dispatch = (): SseMessage | undefined => {
    if (data.length === 0) {
      event = undefined
      return undefined
    }
    const message: SseMessage = { event, data: data.join('\n') }
    event = undefined
    data = []
    return message
  }

  function* lines(text: string, flush: boolean): Generator<SseMessage> {
    buffer += text
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line === '') {
        const message = dispatch()
        if (message !== undefined) yield message
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
    }
    if (buffer.length > MAX_SSE_LINE_CHARS) {
      throw new ModelError('unknown', `${ctx.provider} sent an oversized stream line`, { provider: ctx.provider, model: ctx.model })
    }
    if (flush) {
      if (buffer !== '') {
        // Unterminated final line: treat as complete.
        const colon = buffer.indexOf(':')
        const field = colon < 0 ? buffer : buffer.slice(0, colon)
        const value = colon < 0 ? '' : buffer.slice(colon + 1).replace(/^ /, '')
        if (!buffer.startsWith(':')) {
          if (field === 'event') event = value
          else if (field === 'data') data.push(value)
        }
        buffer = ''
      }
      const message = dispatch()
      if (message !== undefined) yield message
    }
  }

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        if (signal?.aborted === true) throw abortedError(ctx)
        throw new ModelError('network', `${ctx.provider} stream interrupted: ${redact(error instanceof Error ? error.message : String(error))}`, {
          provider: ctx.provider,
          model: ctx.model,
          cause: error,
        })
      }
      if (chunk.done) break
      // A lone trailing CR may be the first half of CRLF; hold it for the next chunk.
      let text = pendingCr + decoder.decode(chunk.value, { stream: true })
      pendingCr = ''
      if (text.endsWith('\r')) {
        pendingCr = '\r'
        text = text.slice(0, -1)
      }
      yield* lines(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), false)
    }
    if (signal?.aborted === true) throw abortedError(ctx)
    yield* lines(`${pendingCr}${decoder.decode()}`.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), true)
  } finally {
    signal?.removeEventListener('abort', onAbort)
    void reader.cancel().catch(() => {})
  }
}

/** Parse a tool-call argument string; fall back to the raw text when invalid. */
export function parseToolArguments(raw: string): unknown {
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}
