import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, ChatApi } from '../src/api/client.ts'
import type { ChatStreamEvent } from '../src/api/types.ts'

function sseResponse(frames: string, status = 200): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frames))
      controller.close()
    },
  }), {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch(handler: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(String(input), init)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ChatApi.streamChat', () => {
  it('dispatches session, text and done events', async () => {
    const mock = stubFetch(() => sseResponse([
      'event: session\ndata: {"sessionId":"session-1","cwd":"/work"}\n\n',
      'event: status\ndata: {"phase":"turn_start","turn":1}\n\n',
      'event: text\ndata: {"text":"hello"}\n\n',
      'event: done\ndata: {"sessionId":"session-1","text":"hello","durationMs":12}\n\n',
    ].join('')))

    const events: ChatStreamEvent[] = []
    const api = new ChatApi({ baseUrl: 'http://api.test/', token: 'secret' })
    await api.streamChat({
      message: 'hi',
      sessionId: 'session-1',
      onEvent: (event) => events.push(event),
    })

    expect(events.map((event) => event.event)).toEqual(['session', 'status', 'text', 'done'])
    const [, init] = mock.mock.calls[0]!
    expect(String(mock.mock.calls[0]![0])).toBe('http://api.test/api/chat/stream')
    expect(init?.headers).toMatchObject({
      Accept: 'text/event-stream',
      Authorization: 'Bearer secret',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      message: 'hi',
      sessionId: 'session-1',
    })
  })

  it('rejects API-level error events', async () => {
    stubFetch(() => sseResponse(
      'event: error\ndata: {"message":"harness exploded","code":"HARNESS_ERROR","status":502}\n\n',
    ))
    const api = new ChatApi({ baseUrl: 'http://api.test' })
    await expect(api.streamChat({ message: 'hi', onEvent: () => {} }))
      .rejects.toMatchObject({ code: 'HARNESS_ERROR', status: 502 })
  })

  it('rejects a stream that closes without done', async () => {
    stubFetch(() => sseResponse('event: text\ndata: {"text":"partial"}\n\n'))
    const api = new ChatApi({ baseUrl: 'http://api.test' })
    await expect(api.streamChat({ message: 'hi', onEvent: () => {} }))
      .rejects.toMatchObject({ code: 'STREAM_INCOMPLETE' })
  })

  it('turns non-2xx responses into ApiError using the envelope', async () => {
    stubFetch(() => jsonResponse({
      error: { message: 'bad request', code: 'INVALID_MESSAGE', status: 400 },
    }, 400))
    const api = new ChatApi({ baseUrl: 'http://api.test' })
    await expect(api.streamChat({ message: '', onEvent: () => {} }))
      .rejects.toMatchObject({ code: 'INVALID_MESSAGE', status: 400 })
  })

  it('wraps network failures', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed')
    })
    const api = new ChatApi({ baseUrl: 'http://api.test' })
    await expect(api.health()).rejects.toMatchObject({
      code: 'NETWORK',
      status: 0,
    })
  })
})

describe('ChatApi JSON surface', () => {
  it('posts a requirement PDF as multipart to the session review route', async () => {
    const mock = stubFetch(() => jsonResponse({
      sessionId: 's-1',
      document: { filename: 'spec.pdf', pages: 2, characters: 100, truncated: false },
      analysis: { type: 'review', decision: 'complete', markdown: '# Review', questions: [] },
      durationMs: 5,
    }))
    const api = new ChatApi({ baseUrl: 'http://api.test', token: 't' })
    const result = await api.reviewPdf({
      projectId: 'p 1',
      sessionId: 's-1',
      file: new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
      filename: 'spec.pdf',
      message: 'Review it',
    })
    expect(result.analysis.markdown).toBe('# Review')
    const [url, init] = mock.mock.calls[0]!
    expect(String(url)).toBe('http://api.test/api/projects/p%201/sessions/s-1/pdf-review')
    expect(init?.method).toBe('POST')
    const form = init?.body as FormData
    expect(form.get('message')).toBe('Review it')
    expect((form.get('file') as File).name).toBe('spec.pdf')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer t' })
    expect(init?.headers).not.toHaveProperty('Content-Type')
  })

  it('sends projectId for project-scoped turns', async () => {
    const mock = stubFetch(() => sseResponse(
      'event: done\ndata: {"sessionId":"s","text":"","durationMs":1}\n\n',
    ))
    const api = new ChatApi({ baseUrl: 'http://api.test' })
    await api.streamChat({ message: 'hi', projectId: 'p-1', onEvent: () => {} })
    expect(JSON.parse(String(mock.mock.calls[0]![1]?.body))).toEqual({ message: 'hi', projectId: 'p-1' })
  })

  it('changes project status through the status route', async () => {
    const project = {
      id: 'p-1', name: 'A', rootPath: '/a', organization: null, ownerEmail: null,
      status: 'archived', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }
    const mock = stubFetch(() => jsonResponse({ project }))
    const api = new ChatApi({ baseUrl: 'http://api.test' })
    const saved = await api.setProjectStatus('p-1', 'archived')
    expect(saved.status).toBe('archived')
    const [url, init] = mock.mock.calls[0]!
    expect(String(url)).toBe('http://api.test/api/projects/p-1/status')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({ status: 'archived' })
  })

  it('loads health without requiring a token', async () => {
    const mock = stubFetch(() => jsonResponse({
      ok: true,
      version: '0.1.0',
      uptimeSeconds: 1,
      harness: { command: 'dsh', profile: 'headless' },
    }))
    const api = new ChatApi({ baseUrl: 'http://api.test', token: 'secret' })
    await expect(api.health()).resolves.toMatchObject({ ok: true, version: '0.1.0' })
    const [, init] = mock.mock.calls[0]!
    expect(init?.headers).not.toHaveProperty('Authorization')
  })

  it('loads messages and sends the bearer token on protected routes', async () => {
    const mock = stubFetch(() => jsonResponse({
      messages: [{ role: 'user', content: 'hi', at: '2026-01-01T00:00:00.000Z' }],
    }))
    const api = new ChatApi({ baseUrl: 'http://api.test', token: 'secret' })
    await expect(api.getMessages('session/1')).resolves.toHaveLength(1)
    expect(String(mock.mock.calls[0]![0])).toBe('http://api.test/api/sessions/session%2F1/messages')
    expect(mock.mock.calls[0]![1]?.headers).toMatchObject({
      Authorization: 'Bearer secret',
    })
  })

  it('lists projects', async () => {
    const project = {
      id: '7e8fb883-4e1d-4c13-ab77-566bf4b2e178',
      name: 'portal',
      rootPath: '/srv/portal',
      organization: null,
      ownerEmail: null,
      status: 'active',
      createdAt: '2026-11-10T04:49:18.845Z',
      updatedAt: '2026-11-10T04:49:18.845Z',
    }
    const mock = stubFetch(() => jsonResponse({ projects: [project] }))
    const api = new ChatApi({ baseUrl: 'http://api.test' })
    await expect(api.listProjects()).resolves.toEqual([project])
    expect(mock.mock.calls[0]![1]?.method).toBe('GET')
  })

  it('creates, updates and deletes projects', async () => {
    const project = {
      id: '7e8fb883-4e1d-4c13-ab77-566bf4b2e178',
      name: 'portal',
      rootPath: '/srv/portal',
      organization: 'Acme',
      ownerEmail: null,
      status: 'inactive',
      createdAt: '2026-11-10T04:49:18.845Z',
      updatedAt: '2026-11-10T04:49:18.845Z',
    }
    const mock = stubFetch((_input, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return jsonResponse({ project: { ...project, name: init?.method === 'PATCH' ? 'portal-2' : 'portal' } })
    })
    const api = new ChatApi({ baseUrl: 'http://api.test', token: 'secret' })

    await expect(api.createProject({
      name: 'portal',
      rootPath: '/srv/portal',
      organization: 'Acme',
      status: 'inactive',
    })).resolves.toMatchObject({ name: 'portal' })
    await expect(api.updateProject(project.id, { name: 'portal-2' }))
      .resolves.toMatchObject({ name: 'portal-2' })
    await expect(api.deleteProject(project.id)).resolves.toBeUndefined()

    expect(String(mock.mock.calls[0]![0])).toBe('http://api.test/api/projects')
    expect(mock.mock.calls[0]![1]?.method).toBe('POST')
    expect(mock.mock.calls[0]![1]?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer secret',
    })
    expect(String(mock.mock.calls[1]![0])).toBe(`http://api.test/api/projects/${project.id}`)
    expect(mock.mock.calls[1]![1]?.method).toBe('PATCH')
    expect(mock.mock.calls[2]![1]?.method).toBe('DELETE')
  })

  it('exposes a structured ApiError', () => {
    const error = new ApiError(409, 'SESSION_BUSY', 'busy')
    expect(error.name).toBe('ApiError')
    expect(error.message).toBe('busy')
    expect(error.status).toBe(409)
  })
})
