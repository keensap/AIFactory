/**
 * Conversations: session history, and the chat / streaming chat turn.
 *
 * A chat turn is one harness turn; `POST /api/chat/stream` forwards the same
 * events as Server-Sent Events.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChatApiOptions } from '../api-options.ts'
import { HttpError, readJson, sendJson } from '../http.ts'
import { SessionBusyError, type SessionStore } from '../store.ts'
import { toHttpError } from '../http.ts'
import { RunTelemetryFolder } from '../telemetry.ts'
import type { HarnessEvent } from '../protocol.ts'
import { telemetrySeed } from './shared.ts'

const MAX_MESSAGE_BYTES = 64 * 1024

/** A chat request body. */
interface ChatInput {
  message: string
  sessionId?: string
  projectId?: string
}

/** Where a chat turn runs, and what it belongs to. */
interface ChatScope {
  cwd?: string
  meta: { projectId?: string }
}
import { requiredParam, route, type RouteDef } from './router.ts'

export const sessionRoutes: RouteDef[] = [
  route('GET', '/api/sessions', 'operator', ({ url, response, options }) => {
    const projectId = url.searchParams.get('projectId')
    sendJson(response, 200, {
      sessions: options.store.list(projectId === null || projectId === '' ? {} : { projectId }),
    })
  }, 'listSessions'),

  route('GET', '/api/sessions/:id', 'operator', ({ params, response, options }) => {
    const session = options.store.get(requiredParam(params, 'id'))
    if (session === undefined) throw new HttpError(404, 'session not found', 'SESSION_NOT_FOUND')
    sendJson(response, 200, { session: { ...session, messageCount: session.messages.length } })
  }, 'getSession'),

  route('GET', '/api/sessions/:id/messages', 'operator', ({ params, response, options }) => {
    const session = options.store.get(requiredParam(params, 'id'))
    if (session === undefined) throw new HttpError(404, 'session not found', 'SESSION_NOT_FOUND')
    sendJson(response, 200, { messages: session.messages })
  }, 'listSessionMessages'),

  route('DELETE', '/api/sessions/:id', 'operator', ({ params, response, options }) => {
    const id = requiredParam(params, 'id')
    try {
      if (!options.store.delete(id)) throw new HttpError(404, 'session not found', 'SESSION_NOT_FOUND')
    } catch (error) {
      if (error instanceof SessionBusyError) throw new HttpError(409, error.message, 'SESSION_BUSY')
      throw error
    }
    response.writeHead(204)
    response.end()
  }, 'deleteSession'),

  route('POST', '/api/chat', 'operator', async ({ request, response, options }) => {
    await handleChat(request, response, options)
  }, 'chat'),

  route('POST', '/api/chat/stream', 'operator', async ({ request, response, options }) => {
    await handleChatStream(request, response, options)
  }, 'chatStream'),
]

async function handleChat(
  request: IncomingMessage,
  response: ServerResponse,
  options: ChatApiOptions,
): Promise<void> {
  const input = parseChatInput(await readJson(request))
  const scope = await resolveChatScope(input, options)
  const release = acquire(options.store, input.sessionId)
  const harness = options.harnessFactory(scope.cwd)
  const started = Date.now()
  const controller = new AbortController()

  response.on('close', () => {
    if (!response.writableEnded) controller.abort()
  })

  try {
    const result = await harness.run(input.message, {
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      signal: controller.signal,
    })
    options.store.recordTurn(result.sessionId, input.message, result.text, scope.meta)
    sendJson(response, 200, {
      sessionId: result.sessionId,
      reply: result.text,
      reason: result.reason,
      durationMs: Date.now() - started,
    })
  } finally {
    release()
  }
}

export async function handleChatStream(
  request: IncomingMessage,
  response: ServerResponse,
  options: ChatApiOptions,
): Promise<void> {
  const input = parseChatInput(await readJson(request))
  const scope = await resolveChatScope(input, options)
  const release = acquire(options.store, input.sessionId)
  const harness = options.harnessFactory(scope.cwd)
  const telemetry = new RunTelemetryFolder(telemetrySeed(options.modelRuntime))
  const started = Date.now()
  let clientGone = false

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders?.()

  const send = (event: string, data: unknown): void => {
    if (clientGone || response.writableEnded || response.destroyed) return
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  response.on('close', () => {
    if (!response.writableEnded) {
      clientGone = true
      harness.cancel()
    }
  })

  try {
    const result = await harness.run(input.message, {
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      onEvent: (event: HarnessEvent) => {
        switch (event.type) {
          case 'session':
            send('session', { sessionId: event.sessionId, cwd: event.cwd })
            break
          case 'status':
            send('status', {
              phase: event.phase,
              ...(event.turn !== undefined ? { turn: event.turn } : {}),
              ...(event.step !== undefined ? { step: event.step } : {}),
              ...(event.usage !== undefined ? { usage: event.usage } : {}),
            })
            if (telemetry.add(event)) send('telemetry', telemetry.snapshot())
            break
          case 'text':
            if (typeof event.text === 'string' && event.text !== '') send('text', { text: event.text })
            break
          case 'thinking':
            if (options.includeThinking === true && typeof event.text === 'string' && event.text !== '') {
              send('thinking', { text: event.text })
            }
            break
          case 'tool_call':
            send('tool_call', {
              ...(event.name !== undefined ? { name: event.name } : {}),
              ...(event.callId !== undefined ? { callId: event.callId } : {}),
            })
            break
          case 'tool_result':
            send('tool_result', {
              ...(event.name !== undefined ? { name: event.name } : {}),
              ...(event.status !== undefined ? { status: event.status } : {}),
              ...(event.error !== undefined ? { error: event.error } : {}),
            })
            break
          case 'final':
            send('final', {
              sessionId: event.sessionId,
              text: event.text,
              reason: event.reason,
            })
            break
          default:
            break
        }
      },
    })

    options.store.recordTurn(result.sessionId, input.message, result.text, scope.meta)
    send('done', {
      sessionId: result.sessionId,
      text: result.text,
      durationMs: Date.now() - started,
    })
  } catch (error) {
    const httpError = toHttpError(error)
    send('error', {
      message: httpError.message,
      code: httpError.code,
      status: httpError.status,
    })
  } finally {
    release()
    if (!response.writableEnded) response.end()
  }
}

/**
 * Decide where a turn runs. A session is bound to the project of its first
 * turn: continuing it reuses that project's root, and asking for a different
 * project is a conflict (the harness session lives in the original workspace).
 */
export async function resolveChatScope(input: ChatInput, options: ChatApiOptions): Promise<ChatScope> {
  const existing = input.sessionId === undefined ? undefined : options.store.get(input.sessionId)
  const boundProject = existing?.projectId
  if (existing !== undefined && input.projectId !== undefined && input.projectId !== boundProject) {
    throw new HttpError(
      409,
      boundProject === undefined
        ? 'session was started without a project and cannot be moved into one'
        : `session belongs to project ${boundProject}`,
      'SESSION_PROJECT_MISMATCH',
    )
  }
  const projectId = boundProject ?? input.projectId
  if (projectId === undefined) return { meta: {} }

  if (options.projects === undefined) {
    throw new HttpError(503, 'project registry is disabled; set DATABASE_URL', 'DATABASE_NOT_CONFIGURED')
  }
  const project = await options.projects.get(projectId)
  if (project.status === 'archived' && existing === undefined) {
    throw new HttpError(409, 'archived projects cannot start new chats', 'PROJECT_ARCHIVED')
  }
  return { cwd: project.rootPath, meta: { projectId: project.id } }
}

export function parseChatInput(body: unknown): ChatInput {
  if (body === null || typeof body !== 'object') {
    throw new HttpError(400, 'request body must be a JSON object', 'INVALID_BODY')
  }
  const record = body as Record<string, unknown>
  const message = record.message
  if (typeof message !== 'string' || message.trim() === '') {
    throw new HttpError(400, '"message" must be a non-empty string', 'INVALID_MESSAGE')
  }
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new HttpError(413, `message exceeds ${MAX_MESSAGE_BYTES} bytes`, 'MESSAGE_TOO_LARGE')
  }

  const sessionId = record.sessionId
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.trim() === '')) {
    throw new HttpError(400, '"sessionId" must be a non-empty string', 'INVALID_SESSION_ID')
  }

  const projectId = record.projectId
  if (projectId !== undefined && projectId !== null
    && (typeof projectId !== 'string' || projectId.trim() === '')) {
    throw new HttpError(400, '"projectId" must be a non-empty string', 'INVALID_PROJECT_ID')
  }

  return {
    message,
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof projectId === 'string' ? { projectId } : {}),
  }
}

export function acquire(store: SessionStore, sessionId: string | undefined): () => void {
  if (sessionId === undefined) return () => {}
  try {
    return store.acquire(sessionId)
  } catch (error) {
    if (error instanceof SessionBusyError) {
      throw new HttpError(409, error.message, 'SESSION_BUSY')
    }
    throw error
  }
}
