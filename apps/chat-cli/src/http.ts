/**
 * HTTP plumbing shared by the route table: responses, JSON bodies, CORS,
 * bearer-token authentication and error mapping.
 *
 * Kept apart from the server so route modules can import it without importing
 * the server that registers them.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChatApiOptions } from './api-options.ts'
import { HarnessError } from './harness.ts'
import { ProjectError } from './projects.ts'
import { WorkspaceError } from './workspace.ts'
import { BriefingError } from './briefing.ts'
import { StageRuntimeError } from './stage-runtime.ts'
import { EmbeddingError } from './embeddings.ts'
import { SemanticIndexError } from './semantic-index.ts'
import { VectorStoreError } from './vector-store.ts'
import { ObservabilityError } from './observability/index.ts'
import { AttachmentError } from './attachments.ts'
import { ExportError } from './report/export.ts'
import { ReportPdfError } from './report/pdf.ts'
import { AgentError } from './agents.ts'
import { PrerequisiteError } from './stage-prerequisites.ts'
import { StageSettingsError } from './stage-settings.ts'
import { ModelError, ModelSettingsError } from './models/index.ts'
import { LogStoreError, LoggingSettingsError } from './logging/index.ts'
import { DirectoryError } from './directories.ts'
import { SettingsError } from './settings.ts'
import { SessionBusyError } from './store.ts'

const MAX_BODY_BYTES = 1024 * 1024
const MAX_MESSAGE_BYTES = 64 * 1024

export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  })
  response.end(text)
}

export function sendError(response: ServerResponse, error: HttpError): void {
  if (error.status === 401) response.setHeader('WWW-Authenticate', 'Bearer')
  sendJson(response, error.status, {
    error: {
      message: error.message,
      code: error.code,
      status: error.status,
    },
  })
}

export function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(html)
}

export function sendText(response: ServerResponse, text: string, contentType: string): void {
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(text)
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`, 'BODY_TOO_LARGE')
    }
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'request body is not valid JSON', 'INVALID_JSON')
  }
}

export function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowed: string[] | '*',
): void {
  const origin = request.headers.origin
  if (origin === undefined) return
  if (allowed === '*' || allowed.includes(origin)) {
    response.setHeader('Access-Control-Allow-Origin', allowed === '*' ? '*' : origin)
    if (allowed !== '*') response.setHeader('Vary', 'Origin')
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id')
  response.setHeader('Access-Control-Expose-Headers', 'X-Request-Id')
  response.setHeader('Access-Control-Max-Age', '600')
}

/**
 * Compare a presented token with the configured one in constant time.
 *
 * A plain `!==` leaks the length and prefix of the secret through timing. Hashing
 * both sides to a fixed length first also hides the secret's length from the
 * comparison itself.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/**
 * Authenticate an ordinary request.
 *
 * Either configured credential is accepted here: the admin token is a superset of
 * the operator token, and `requireAdmin` narrows it further where it matters.
 */
export function requireToken(request: IncomingMessage, options: ChatApiOptions): void {
  const accepted = [options.apiToken, options.adminToken]
    .filter((value): value is string => value !== undefined && value !== '')
  if (accepted.length === 0) return
  const header = request.headers.authorization ?? ''
  const prefix = 'Bearer '
  const presented = header.startsWith(prefix) ? header.slice(prefix.length) : null
  const ok = presented !== null && accepted.some((token) => tokensMatch(presented, token))
  if (!ok) throw new HttpError(401, 'missing or invalid bearer token', 'UNAUTHORIZED')
}

/** Whether the request carries the admin bearer token, when one is configured. */
export function hasAdminToken(request: IncomingMessage, options: ChatApiOptions): boolean {
  const configured = options.adminToken
  if (configured === undefined || configured === '') return false
  const header = request.headers.authorization ?? ''
  const prefix = 'Bearer '
  return header.startsWith(prefix) && tokensMatch(header.slice(prefix.length), configured)
}

/**
 * Admin endpoints need the admin credential.
 *
 * With `AIFACTORY_ADMIN_TOKEN` set, only that token is admin: an operator token
 * can run the factory but not reconfigure it. Without it, the operator token
 * remains admin (backwards compatible), and with no token at all a loopback
 * client is trusted.
 */
export function requireAdmin(request: IncomingMessage, options: ChatApiOptions): void {
  if (options.adminToken !== undefined && options.adminToken !== '') {
    if (!hasAdminToken(request, options)) {
      throw new HttpError(
        403,
        'admin endpoints require the admin bearer token (AIFACTORY_ADMIN_TOKEN)',
        'ADMIN_FORBIDDEN',
      )
    }
    return
  }
  if (options.apiToken !== undefined && options.apiToken !== '') return
  const address = request.socket.remoteAddress ?? ''
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopback) {
    throw new HttpError(403, 'admin endpoints require a bearer token or a loopback client', 'ADMIN_FORBIDDEN')
  }
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof ProjectError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof WorkspaceError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof BriefingError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof StageRuntimeError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof EmbeddingError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof SemanticIndexError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof VectorStoreError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof ObservabilityError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof AttachmentError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof ExportError) return new HttpError(500, error.message, error.code)
  if (error instanceof ReportPdfError) return new HttpError(500, error.message, error.code)
  if (error instanceof AgentError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof PrerequisiteError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof StageSettingsError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof ModelSettingsError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof ModelError) return new HttpError(modelErrorStatus(error), error.message, `MODEL_${error.kind.toUpperCase()}`)
  if (error instanceof LogStoreError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof LoggingSettingsError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof DirectoryError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof SettingsError) return new HttpError(error.status, error.message, error.code)
  if (error instanceof SessionBusyError) return new HttpError(409, error.message, 'SESSION_BUSY')
  if (error instanceof HarnessError) {
    if (/timed out/i.test(error.message)) return new HttpError(504, error.message, 'HARNESS_TIMEOUT')
    if (/cannot start/i.test(error.message)) {
      return new HttpError(503, error.message, 'HARNESS_UNAVAILABLE')
    }
    if (error.code === 'MISSING_CREDENTIAL') {
      return new HttpError(502, error.message, 'HARNESS_AUTH')
    }
    if (/cancelled/i.test(error.message)) {
      return new HttpError(502, error.message, 'HARNESS_CANCELLED')
    }
    return new HttpError(
      502,
      error.message,
      error.code ?? 'HARNESS_ERROR',
    )
  }
  return new HttpError(500, 'internal server error', 'INTERNAL_ERROR')
}

export function optionalParams(params: URLSearchParams, names: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = params.get(name)
    if (value !== null && value !== '') out[name] = value
  }
  return out
}

/** `days`, `from` and `to` query parameters shared by the stats endpoints. */
export function statsRangeFromQuery(q: URLSearchParams): { from?: string; to?: string; days?: number } {
  const daysRaw = q.get('days')
  let days: number | undefined
  if (daysRaw !== null) {
    // Digits only: parseInt would quietly accept "1.5" as 1 and "7abc" as 7.
    days = /^[0-9]{1,6}$/.test(daysRaw) ? Number.parseInt(daysRaw, 10) : Number.NaN
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
      throw new HttpError(400, 'days must be an integer between 1 and 365', 'INVALID_DAYS')
    }
  }
  return {
    ...(q.get('from') !== null ? { from: q.get('from')! } : {}),
    ...(q.get('to') !== null ? { to: q.get('to')! } : {}),
    ...(days !== undefined ? { days } : {}),
  }
}

/**
 * HTTP status for a model failure. Caller mistakes are 4xx; anything the
 * upstream provider or our own configuration caused is 5xx so clients can tell
 * "fix your request" from "the model layer is unhealthy".
 */
export function modelErrorStatus(error: ModelError): number {
  switch (error.kind) {
    case 'invalid_request':
    case 'unsupported':
    case 'context_overflow':
      return 400
    case 'content_filter':
      return 422
    case 'unconfigured':
      return 503
    case 'timeout':
      return 504
    default:
      return 502
  }
}
