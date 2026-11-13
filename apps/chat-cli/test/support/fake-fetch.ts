/** Scripted `fetch` helpers for provider tests. No network, no timers. */

export interface RecordedCall {
  url: string
  method: string
  headers: Headers
  body: unknown
}

export type Handler = (call: RecordedCall, signal: AbortSignal | undefined) => Response | Promise<Response>

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

/**
 * An SSE response. `chunkSize` splits the encoded bytes, which also splits
 * multi-byte characters and line endings across reads, as real networks do.
 */
export function sseResponse(frames: string[], options: { chunkSize?: number; status?: number; endWith?: 'close' | 'hang' } = {}): Response {
  const bytes = new TextEncoder().encode(frames.join(''))
  const size = Math.max(1, options.chunkSize ?? bytes.length)
  let offset = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        if (options.endWith === 'hang') return new Promise<void>(() => {})
        controller.close()
        return undefined
      }
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
      return undefined
    },
  })
  return new Response(stream, { status: options.status ?? 200, headers: { 'Content-Type': 'text/event-stream' } })
}

export function frame(data: unknown, event?: string): string {
  return `${event !== undefined ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
}

export function recordingFetch(handler: Handler): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined
    if (signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
    let body: unknown
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = init.body }
    }
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body,
    }
    calls.push(call)
    return handler(call, signal)
  }
  return { fetch: impl as typeof fetch, calls }
}
