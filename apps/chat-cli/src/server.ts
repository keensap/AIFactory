/**
 * Basic HTTP/JSON + SSE API over the same harness transport as the CLI.
 *
 * The API is intentionally a thin adapter: one request is one harness turn.
 * Session history is mirrored in `SessionStore` for UI listing, while the
 * harness Session remains the source of truth for conversation state.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, resolve, sep } from 'node:path'
import type { AddressInfo } from 'node:net'
import { DshHarness, HarnessError } from './harness.ts'
import type { ChatApiOptions, ModelRuntimeLike } from './api-options.ts'
import { routeTable as ROUTES, dispatchRoutes } from './routes/index.ts'
import {
  applyCors,
  HttpError,
  modelErrorStatus,
  optionalParams,
  readJson,
  requireAdmin,
  requireToken,
  sendError,
  sendHtml,
  sendJson,
  sendText,
  statsRangeFromQuery,
  toHttpError,
} from './http.ts'
import {
  LoggingSettingsError,
  LogStoreError,
  noopLogger,
  runWithLogContext,
  type AppLog,
  type Level,
  type Logger,
  type LoggingManager,
  type PostgresLogStore,
} from './logging/index.ts'
import { BriefingError, ProjectBriefingService } from './briefing.ts'
import { createProjectTools } from './project-tools.ts'
import { DirectoryError, listDirectories } from './directories.ts'
import { EmbeddingError } from './embeddings.ts'
import { readMultipart, readMultipartFiles, UploadError } from './multipart.ts'
import { AttachmentError, MAX_ATTACHMENTS_PER_UPLOAD, assertSupportedUpload } from './attachments.ts'
import { EXPORT_ROOT, ExportError } from './report/export.ts'
import { ReportPdfError } from './report/pdf.ts'
import { PdfError } from './pdf.ts'
import { PdfReviewError, type PdfReviewService } from './pdf-review.ts'
import { ObservabilityError, type ObservabilityReader, type TraceRecorder } from './observability/index.ts'
import { ModelError, ModelSettingsError, type ModelService } from './models/index.ts'
import type { HarnessEvent } from './protocol.ts'
import { ProjectError, type ProjectService, type ProjectStatus } from './projects.ts'
import { SDLC_STAGES, type ProjectStage } from './sdlc.ts'
import { SettingsError, type SettingsService } from './settings.ts'
import { StageSettingsError, type StageSettingsService } from './stage-settings.ts'
import { PrerequisiteError, type StagePrerequisiteService } from './stage-prerequisites.ts'
import { AgentError, type AgentRecord, type AgentService } from './agents.ts'
import { SemanticIndexError, type SemanticIndexService } from './semantic-index.ts'
import { VectorStoreError } from './vector-store.ts'
import { PlanningStageRuntime, StageRuntimeError } from './stage-runtime.ts'
import { SessionBusyError, SessionNotFoundError, SessionProjectMismatchError, type ChatSession, type SessionStore } from './store.ts'
import { PostgresProjectWorkspace, WorkspaceError, type StageRunEvent } from './workspace.ts'
import { RunTelemetryFolder, telemetryFromEvents, type TelemetryModel } from './telemetry.ts'

const MAX_BODY_BYTES = 1024 * 1024
const MAX_MESSAGE_BYTES = 64 * 1024

const DOCS_HTML = readFileSync(new URL('./docs.html', import.meta.url), 'utf8')
const OPENAPI_YAML = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')



export function createChatServer(options: ChatApiOptions): Server {
  return createServer((request, response) => {
    handleRequest(request, response, options).catch((error: unknown) => {
      // handleRequest guards its own work; this is the last line of defence so
      // an unexpected rejection can never become a process-level crash.
      try {
        (options.logger ?? noopLogger).child({ component: 'http' }).error({ event: 'http.unhandled', err: error })
        if (!response.headersSent) sendError(response, new HttpError(500, 'internal error', 'INTERNAL_ERROR'))
        else if (!response.writableEnded) response.end()
      } catch {
        // Nothing further can be done for this request.
      }
    })
  })
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/

function readRequestId(request: IncomingMessage): string {
  const header = request.headers['x-request-id']
  const value = Array.isArray(header) ? header[0] : header
  return value !== undefined && REQUEST_ID_PATTERN.test(value) ? value : randomUUID()
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ChatApiOptions,
): Promise<void> {
  const requestId = readRequestId(request)
  response.setHeader('X-Request-Id', requestId)
  return runWithLogContext({ requestId }, () => handleRequestScoped(request, response, options))
}

async function handleRequestScoped(
  request: IncomingMessage,
  response: ServerResponse,
  options: ChatApiOptions,
): Promise<void> {
  const started = Date.now()
  const log = (options.logger ?? noopLogger).child({ component: 'http' })
  const url = new URL(request.url ?? '/', 'http://localhost')
  applyCors(request, response, options.corsOrigins ?? '*')

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  try {
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
      requireToken(request, options)
    }
    const handled = await dispatchRoutes(ROUTES, request, response, url, options)
    if (!handled.matched) throw new HttpError(404, 'not found', 'NOT_FOUND')
  } catch (error) {
    const httpError = toHttpError(error)
    if (httpError.status >= 500) {
      log.error({ event: 'http.request_failed', method: request.method, path: url.pathname, code: httpError.code, err: error })
    }
    if (response.headersSent) {
      if (!response.writableEnded) response.end()
      return
    }
    sendError(response, httpError)
  } finally {
    const status = response.statusCode
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : url.pathname === '/api/health' ? 'debug' : 'info'
    log[level]({
      event: 'http.request',
      method: request.method ?? '?',
      path: url.pathname,
      status,
      durationMs: Date.now() - started,
    })
  }
}






































/** Convenience for tests: the actual bound port after `listen(0)`. */
export function serverPort(server: Server): number {
  const address = server.address() as AddressInfo | null
  if (address === null) throw new Error('server is not listening')
  return address.port
}

export type { ChatSession }
export type { ChatApiOptions, ModelRuntimeLike }
