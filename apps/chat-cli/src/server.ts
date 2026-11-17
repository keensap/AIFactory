/**
 * Basic HTTP/JSON + SSE API over the same harness transport as the CLI.
 *
 * The API is intentionally a thin adapter: one request is one harness turn.
 * Session history is mirrored in `SessionStore` for UI listing, while the
 * harness Session remains the source of truth for conversation state.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, resolve, sep } from 'node:path'
import type { AddressInfo } from 'node:net'
import { DshHarness, HarnessError } from './harness.ts'
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

export interface ChatApiOptions {
  /** Builds a harness; `cwd` is the project root when a chat is scoped to a project. */
  harnessFactory: (cwd?: string) => DshHarness
  store: SessionStore
  version: string
  /** When set, every /api route except /api/health requires this bearer token. */
  apiToken?: string
  /** `*` or an explicit origin allowlist. */
  corsOrigins?: string[] | '*'
  /** Forward committed reasoning events to SSE clients. Off by default. */
  includeThinking?: boolean
  /** Project registry. When omitted, project routes return 503. */
  projects?: ProjectService
  /** Chat settings. When omitted, settings routes return 503. */
  settings?: SettingsService
  /** Planning-stage review settings. When omitted, the settings routes return 503. */
  stageSettings?: StageSettingsService
  /** PDF requirement review. When omitted, the PDF route returns 503. */
  pdfReview?: PdfReviewService
  /** SDLC stage, documents and checklist storage. */
  workspace?: PostgresProjectWorkspace
  /** Cached AI project briefing. */
  briefing?: ProjectBriefingService
  /** Stage coordinator runtime. When omitted, stage-run routes return 503. */
  stageRuntime?: PlanningStageRuntime
  /** Project-scoped semantic indexing. When omitted, retrieval routes return 503. */
  semanticIndex?: SemanticIndexService
  /** Provider-neutral observability reader (Phoenix today). */
  observability?: ObservabilityReader
  /** Recorder, used to release per-project resources when a project is deleted. */
  observabilityRecorder?: TraceRecorder
  harnessInfo?: { command: string; profile: string }
  logger?: Logger
  /** Logging control plane (settings, diagnostics, runtime level). */
  loggingManager?: LoggingManager
  /** Query access to the PostgreSQL application-log table. */
  logStore?: PostgresLogStore
  /** Global model target, provider catalogue and discovery. */
  models?: ModelService
  /** Applies the global target to harness runs. */
  modelRuntime?: ModelRuntimeLike
}

export interface ModelRuntimeLike {
  status(): {
    provider?: string | null
    model?: string | null
    contextWindow?: number | null
    [key: string]: unknown
  }
}

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
      requireToken(request, options.apiToken)
    }
    await route(request, response, url, options)
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

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: ChatApiOptions,
): Promise<void> {
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/docs' || url.pathname === '/docs/')) {
    sendHtml(response, DOCS_HTML)
    return
  }

  if (request.method === 'GET' && url.pathname === '/openapi.yaml') {
    sendText(response, OPENAPI_YAML, 'application/yaml; charset=utf-8')
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/tools') {
    if (options.projects === undefined) {
      throw new HttpError(503, 'project tools are disabled; set DATABASE_URL', 'DATABASE_NOT_CONFIGURED')
    }
    const tools = createProjectTools(options.projects).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }))
    sendJson(response, 200, { tools })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api') {
    sendJson(response, 200, {
      name: 'AI Factory Chat API',
      version: options.version,
      docs: '/docs',
      openapi: '/openapi.yaml',
      health: '/api/health',
      endpoints: {
        chat: 'POST /api/chat',
        stream: 'POST /api/chat/stream',
        sessions: 'GET /api/sessions',
        projects: 'GET/POST /api/projects',
        tools: 'GET /api/tools',
        settings: 'GET/PATCH /api/settings',
        directories: 'GET /api/fs/directories?path=',
        pdfReview: 'POST /api/projects/:projectId/sessions/:sessionId/pdf-review',
        sdlcStages: 'GET /api/sdlc/stages',
        stageRuns: 'GET/POST /api/projects/:id/stages/:stage/runs',
        stageRun: 'GET /api/stage-runs/:runId',
        executeStageRun: 'POST /api/stage-runs/:runId/execute',
        stageDecision: 'POST /api/stage-runs/:runId/decision',
        stageEvents: 'GET /api/stage-runs/:runId/events',
        stageEventStream: 'GET /api/stage-runs/:runId/events/stream',
        stageTelemetry: 'GET /api/stage-runs/:runId/telemetry',
        stageExport: 'POST /api/stage-runs/:runId/export',
        stageGate: 'POST /api/stage-runs/:runId/gate',
        stageSettings: 'GET/POST/PATCH/DELETE /api/projects/:id/stages/planning/settings',
        stageDefaults: 'GET/POST/PATCH /api/settings/stage-defaults',
        attachments: 'GET/POST /api/projects/:id/attachments',
        documentExport: 'GET /api/projects/:id/documents/:documentId/export',
        semanticIndex: 'POST /api/projects/:id/index',
        semanticSearch: 'GET /api/projects/:id/search?q=...',
        observability: 'GET /api/projects/:id/observability?hours=24',
        projectLogs: 'GET /api/projects/:id/logs?source=events|app|all&level=error&limit=100',
        projectStats: 'GET /api/projects/:id/stats?from=&to=&stage=&role=',
        appLogs: 'GET /api/logs?level=error&projectId=&requestId=&q=',
        loggingSettings: 'GET/PATCH /api/settings/logging',
        loggingAdmin: 'GET /api/admin/logging',
        loggingLevel: 'PUT /api/admin/logging/level',
        observabilityAdmin: 'GET /api/admin/observability',
        modelProviders: 'GET /api/models/providers',
        models: 'GET /api/models?provider=',
        modelDiscover: 'POST /api/models/providers/:id/discover',
        modelHealth: 'POST /api/models/providers/:id/health',
        modelTarget: 'GET/PATCH/DELETE /api/settings/models',
        modelTest: 'POST /api/models/test',
        modelUsage: 'GET /api/models/usage?days=&from=&to=',
        modelPrice: 'PUT /api/models/price',
        modelRuntime: 'GET /api/admin/models',
      },
    })
    return
  }

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] !== 'api') throw new HttpError(404, 'not found', 'NOT_FOUND')
  const [, resource, ...rest] = segments

  if (resource === 'health' && rest.length === 0 && request.method === 'GET') {
    sendJson(response, 200, {
      ok: true,
      version: options.version,
      uptimeSeconds: Math.round(process.uptime()),
      harness: options.harnessInfo ?? null,
      database: options.projects === undefined ? 'disabled' : 'postgres',
    })
    return
  }

  // Cross-project spend report: admin only, and independent of the model catalogue.
  if (resource === 'models' && rest.length === 1 && rest[0] === 'usage' && request.method === 'GET') {
    requireAdmin(request, options)
    sendJson(response, 200, { usage: await requireWorkspace(options).modelUsage(statsRangeFromQuery(url.searchParams)) })
    return
  }

  if (resource === 'models') {
    const models = options.models
    if (models === undefined) {
      throw new HttpError(503, 'model providers are disabled; set DATABASE_URL', 'MODELS_NOT_CONFIGURED')
    }
    if (rest.length === 0 && request.method === 'GET') {
      const provider = url.searchParams.get('provider') ?? undefined
      sendJson(response, 200, { models: await models.models(provider) })
      return
    }
    if (rest.length === 1 && rest[0] === 'providers' && request.method === 'GET') {
      sendJson(response, 200, { providers: await models.providers() })
      return
    }
    if (rest.length === 3 && rest[0] === 'providers' && rest[2] === 'discover' && request.method === 'POST') {
      requireAdmin(request, options)
      sendJson(response, 200, { discovery: await models.discover(decodeURIComponent(rest[1]!)) })
      return
    }
    if (rest.length === 3 && rest[0] === 'providers' && rest[2] === 'health' && request.method === 'POST') {
      requireAdmin(request, options)
      sendJson(response, 200, { health: await models.health(decodeURIComponent(rest[1]!)) })
      return
    }
    if (rest.length === 1 && rest[0] === 'test' && request.method === 'POST') {
      requireAdmin(request, options)
      sendJson(response, 200, { test: await models.test(await readJson(request)) })
      return
    }
    if (rest.length === 1 && rest[0] === 'price' && request.method === 'PUT') {
      requireAdmin(request, options)
      const body = await readJson(request)
      const record = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
      if (typeof record.provider !== 'string' || typeof record.model !== 'string') {
        throw new HttpError(400, 'provider and model are required', 'INVALID_PRICE')
      }
      const { provider, model, ...price } = record
      sendJson(response, 200, { model: await models.setPrice(provider, model, price) })
      return
    }
    throw new HttpError(404, 'not found', 'NOT_FOUND')
  }

  if (resource === 'settings' && rest.length === 1 && rest[0] === 'models') {
    const models = options.models
    if (models === undefined) {
      throw new HttpError(503, 'model providers are disabled; set DATABASE_URL', 'MODELS_NOT_CONFIGURED')
    }
    if (request.method === 'GET') {
      sendJson(response, 200, await models.target())
      return
    }
    if (request.method === 'PATCH') {
      sendJson(response, 200, await models.updateTarget(await readJson(request)))
      return
    }
    if (request.method === 'DELETE') {
      sendJson(response, 200, await models.clearTarget())
      return
    }
    throw new HttpError(405, 'method not allowed', 'METHOD_NOT_ALLOWED')
  }

  if (resource === 'settings' && rest.length === 1 && rest[0] === 'logging') {
    const manager = requireLoggingManager(options)
    if (request.method === 'GET') {
      sendJson(response, 200, { settings: manager.settings(), postgresAvailable: manager.postgresAvailable })
      return
    }
    if (request.method === 'PATCH') {
      sendJson(response, 200, { settings: await manager.update(await readJson(request)), postgresAvailable: manager.postgresAvailable })
      return
    }
    throw new HttpError(405, 'method not allowed', 'METHOD_NOT_ALLOWED')
  }

  if (resource === 'admin' && rest[0] === 'models') {
    requireAdmin(request, options)
    if (rest.length === 4 && rest[1] === 'providers' && rest[3] === 'reset' && request.method === 'POST') {
      if (options.models === undefined) {
        throw new HttpError(503, 'model providers are disabled; set DATABASE_URL', 'MODELS_NOT_CONFIGURED')
      }
      sendJson(response, 200, await options.models.resetBreaker(decodeURIComponent(rest[2]!)))
      return
    }
    if (rest.length !== 1 || request.method !== 'GET') throw new HttpError(404, 'not found', 'NOT_FOUND')
    if (options.modelRuntime === undefined) {
      throw new HttpError(503, 'model runtime is disabled; set DATABASE_URL', 'MODELS_NOT_CONFIGURED')
    }
    sendJson(response, 200, { models: options.modelRuntime.status() })
    return
  }

  if (resource === 'admin' && rest[0] === 'observability') {
    requireAdmin(request, options)
    if (rest.length !== 1 || request.method !== 'GET') throw new HttpError(404, 'not found', 'NOT_FOUND')
    const reader = options.observability
    if (reader === undefined) throw new HttpError(503, 'observability is disabled', 'OBSERVABILITY_DISABLED')
    sendJson(response, 200, { observability: reader.health() })
    return
  }

  if (resource === 'admin' && rest[0] === 'logging') {
    requireAdmin(request, options)
    const manager = requireLoggingManager(options)
    if (rest.length === 1 && request.method === 'GET') {
      sendJson(response, 200, { logging: manager.view() })
      return
    }
    if (rest.length === 2 && rest[1] === 'level' && request.method === 'PUT') {
      const body = await readJson(request)
      const record = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined
      if (record === undefined) throw new HttpError(400, 'request body must be a JSON object', 'INVALID_BODY')
      if (!('level' in record)) throw new HttpError(400, '"level" is required (use null to clear)', 'INVALID_LOG_LEVEL')
      const levels = manager.setRuntimeLevel({
        level: record.level as Level | null,
        ...(record.ttlSeconds !== undefined ? { ttlSeconds: record.ttlSeconds as number } : {}),
        ...(record.component !== undefined ? { component: String(record.component) } : {}),
      })
      sendJson(response, 200, { levels })
      return
    }
    throw new HttpError(404, 'not found', 'NOT_FOUND')
  }

  if (resource === 'logs' && rest.length === 0 && request.method === 'GET') {
    const store = requireLogStore(options)
    const q = url.searchParams
    const limit = Number.parseInt(q.get('limit') ?? '100', 10)
    sendJson(response, 200, {
      ...(await store.list({
        limit: Number.isSafeInteger(limit) ? limit : 100,
        ...optionalParams(q, ['before', 'level', 'minLevel', 'event', 'component', 'projectId', 'stageRunId', 'requestId', 'role', 'q', 'from', 'to']),
      })),
      postgresEnabled: options.loggingManager?.view().postgresActive ?? false,
    })
    return
  }

  if (resource === 'settings' && rest.length === 1 && rest[0] === 'stage-defaults') {
    const stageSettings = options.stageSettings
    if (stageSettings === undefined) {
      throw new HttpError(503, 'stage settings are disabled; set DATABASE_URL', 'STAGE_SETTINGS_NOT_CONFIGURED')
    }
    if (request.method === 'GET') {
      sendJson(response, 200, { stageDefaults: await stageSettings.factoryDefaults() })
      return
    }
    if (request.method === 'PATCH' || request.method === 'POST') {
      sendJson(response, 200, { stageDefaults: await stageSettings.updateFactoryDefaults(await readJson(request)) })
      return
    }
    throw new HttpError(405, 'method not allowed', 'METHOD_NOT_ALLOWED')
  }

  if (resource === 'settings') {
    if (options.settings === undefined) {
      throw new HttpError(503, 'settings are disabled; set DATABASE_URL', 'SETTINGS_NOT_CONFIGURED')
    }
    if (request.method === 'GET' && rest.length === 0) {
      sendJson(response, 200, { settings: await options.settings.get() })
      return
    }
    if (request.method === 'PATCH' && rest.length === 0) {
      if (options.projects === undefined) {
        throw new HttpError(503, 'project registry is disabled; set DATABASE_URL', 'DATABASE_NOT_CONFIGURED')
      }
      const activeProjects = await options.projects.countActive()
      sendJson(response, 200, { settings: await options.settings.update(await readJson(request), activeProjects) })
      return
    }
    throw new HttpError(404, 'not found', 'NOT_FOUND')
  }

  if (resource === 'fs' && rest.length === 1 && rest[0] === 'directories' && request.method === 'GET') {
    const path = url.searchParams.get('path')
    sendJson(response, 200, await listDirectories(path ?? undefined, {
      showHidden: url.searchParams.get('hidden') === '1',
    }))
    return
  }

  if (resource === 'sdlc' && rest.length === 1 && rest[0] === 'stages' && request.method === 'GET') {
    const workspace = requireWorkspace(options)
    sendJson(response, 200, { stages: await workspace.listSdlcStages() })
    return
  }

  if (resource === 'stage-runs') {
    await handleStageRuns(request, response, url, rest, options)
    return
  }

  if (resource === 'projects') {
    await handleProjects(request, response, url, rest, options)
    return
  }

  if (resource === 'sessions') {
    await handleSessions(request, response, url, rest, options)
    return
  }

  if (resource === 'chat') {
    if (request.method === 'POST' && rest.length === 0) {
      await handleChat(request, response, options)
      return
    }
    if (request.method === 'POST' && rest.length === 1 && rest[0] === 'stream') {
      await handleChatStream(request, response, options)
      return
    }
  }

  throw new HttpError(404, 'not found', 'NOT_FOUND')
}

function requireLoggingManager(options: ChatApiOptions): LoggingManager {
  if (options.loggingManager === undefined) {
    throw new HttpError(503, 'logging control is disabled', 'LOGGING_NOT_CONFIGURED')
  }
  return options.loggingManager
}

function requireLogStore(options: ChatApiOptions): PostgresLogStore {
  if (options.logStore === undefined) {
    throw new HttpError(503, 'application log storage needs DATABASE_URL', 'LOG_STORE_NOT_CONFIGURED')
  }
  return options.logStore
}

/** Admin endpoints need the bearer token, or a loopback client when no token is configured. */
function requireAdmin(request: IncomingMessage, options: ChatApiOptions): void {
  if (options.apiToken !== undefined) return
  const address = request.socket.remoteAddress ?? ''
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopback) {
    throw new HttpError(403, 'admin endpoints require a bearer token or a loopback client', 'ADMIN_FORBIDDEN')
  }
}

function optionalParams(params: URLSearchParams, names: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = params.get(name)
    if (value !== null && value !== '') out[name] = value
  }
  return out
}

interface UnifiedLog {
  source: 'events' | 'app'
  id: string
  projectId: string | null
  stageRunId: string | null
  stage: string | null
  attempt: number | null
  role: string | null
  agentId: string | null
  type: string
  phase: string | null
  level: string
  message: string
  preview: string | null
  component: string | null
  requestId: string | null
  traceId: string | null
  payload: unknown
  createdAt: string
}

function appToUnified(log: AppLog): UnifiedLog {
  return {
    source: 'app',
    id: log.id,
    projectId: log.projectId,
    stageRunId: log.stageRunId,
    stage: log.stage,
    attempt: null,
    role: log.role,
    agentId: null,
    type: log.event ?? 'log',
    phase: null,
    level: log.level,
    message: log.message,
    preview: null,
    component: log.component,
    requestId: log.requestId,
    traceId: log.traceId,
    payload: log.record,
    createdAt: log.ts,
  }
}

/**
 * Project log view. `source=events` (default) is the stage event log with an
 * id cursor; `app` reads application logs for the project with an id cursor;
 * `all` merges both newest-first and pages by an ISO timestamp cursor.
 */
async function projectLogs(projectId: string, url: URL, options: ChatApiOptions): Promise<Record<string, unknown>> {
  const q = url.searchParams
  const source = q.get('source') ?? 'events'
  if (!['events', 'app', 'all'].includes(source)) {
    throw new HttpError(400, 'source must be events, app or all', 'INVALID_SOURCE')
  }
  const limitRaw = Number.parseInt(q.get('limit') ?? '100', 10)
  const limit = Math.min(Math.max(Number.isSafeInteger(limitRaw) ? limitRaw : 100, 1), 500)
  const before = q.get('before') ?? undefined

  const eventLogs = async (cursor: { before?: string; beforeTs?: string }): Promise<{ logs: UnifiedLog[]; nextBefore: string | null }> => {
    const result = await requireWorkspace(options).listProjectLogs({
      projectId,
      limit,
      ...cursor,
      ...(q.get('level') !== null ? { level: q.get('level')! } : {}),
      ...(q.get('type') !== null ? { type: q.get('type')! } : {}),
      ...(q.get('role') !== null ? { role: q.get('role')! } : {}),
      ...(q.get('runId') !== null ? { runId: q.get('runId')! } : {}),
      ...(q.get('stage') !== null ? { stage: q.get('stage')! } : {}),
      ...(q.get('q') !== null ? { query: q.get('q')! } : {}),
    })
    return {
      nextBefore: result.nextBefore,
      logs: result.logs.map((log) => ({
        source: 'events' as const,
        id: log.id,
        projectId: log.projectId,
        stageRunId: log.stageRunId,
        stage: log.stage,
        attempt: log.attempt,
        role: log.role,
        agentId: log.agentId,
        type: log.type,
        phase: log.phase,
        level: log.level,
        message: log.message,
        preview: log.preview,
        component: null,
        requestId: null,
        traceId: null,
        payload: log.payload,
        createdAt: log.createdAt,
      })),
    }
  }
  const appFilter = (cursor: { before?: string; beforeTs?: string }) => ({
    limit,
    projectId,
    ...cursor,
    ...(q.get('level') !== null ? { level: q.get('level')! } : {}),
    ...(q.get('type') !== null ? { event: q.get('type')! } : {}),
    ...(q.get('role') !== null ? { role: q.get('role')! } : {}),
    ...(q.get('runId') !== null ? { stageRunId: q.get('runId')! } : {}),
    ...(q.get('q') !== null ? { q: q.get('q')! } : {}),
  })

  if (source === 'events') {
    const result = await eventLogs(before === undefined ? {} : { before })
    return { source, ...result }
  }
  const store = requireLogStore(options)
  const postgresEnabled = options.loggingManager?.view().postgresActive ?? false
  if (source === 'app') {
    const result = await store.list(appFilter(before === undefined ? {} : { before }))
    return { source, logs: result.logs.map(appToUnified), nextBefore: result.nextBefore, postgresEnabled }
  }
  const cursor = before === undefined ? {} : { beforeTs: before }
  const [events, app] = await Promise.all([eventLogs(cursor), store.list(appFilter(cursor))])
  const merged = [...events.logs, ...app.logs.map(appToUnified)]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, limit)
  return {
    source,
    logs: merged,
    nextBefore: merged.length === limit ? merged.at(-1)?.createdAt ?? null : null,
    postgresEnabled,
  }
}

/** Seed for a chat run: the model the harness will use, and its window. */
function telemetrySeed(runtime?: ModelRuntimeLike): { model?: TelemetryModel; contextWindow?: number } {
  const status = runtime?.status()
  if (status === undefined) return {}
  const provider = typeof status.provider === 'string' ? status.provider : null
  const model = typeof status.model === 'string' ? status.model : null
  return {
    ...(provider !== null && model !== null ? { model: { provider, model } } : {}),
    ...(typeof status.contextWindow === 'number' && status.contextWindow > 0 ? { contextWindow: status.contextWindow } : {}),
  }
}

/**
 * Page through a run's stored events.
 *
 * `upTo` stops at an id (used to seed a reconnecting stream with exactly the
 * events it has already seen); `maxEvents` bounds memory for very long runs.
 */
async function readRunEvents(
  workspace: PostgresProjectWorkspace,
  runId: string,
  options: { upTo?: string; maxEvents?: number } = {},
): Promise<StageRunEvent[]> {
  const maxEvents = options.maxEvents ?? 20_000
  const upTo = options.upTo === undefined || options.upTo === '0' ? undefined : Number(options.upTo)
  const events: StageRunEvent[] = []
  let cursor = '0'
  while (events.length < maxEvents) {
    const page = await workspace.listStageRunEvents(runId, cursor, 1000)
    if (page.length === 0) break
    for (const event of page) {
      if (upTo !== undefined && Number(event.id) > upTo) return events
      events.push(event)
    }
    cursor = page[page.length - 1]!.id
    if (page.length < 1000) break
  }
  return events
}

async function streamStageEvents(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runId: string,
  workspace: PostgresProjectWorkspace,
): Promise<void> {
  if (await workspace.getStageRun(runId) === undefined) {
    throw new HttpError(404, 'stage run not found', 'STAGE_RUN_NOT_FOUND')
  }

  const header = request.headers['last-event-id']
  const headerValue = Array.isArray(header) ? header[0] : header
  let after = headerValue ?? url.searchParams.get('after') ?? '0'
  let closed = false
  let polling = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined

  const cleanup = (): void => {
    if (closed) return
    closed = true
    if (pollTimer !== undefined) clearInterval(pollTimer)
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders?.()
  response.on('close', cleanup)

  const writeEvent = (event: Awaited<ReturnType<PostgresProjectWorkspace['listStageRunEvents']>>[number]): void => {
    response.write(`id: ${event.id}\nevent: stage\ndata: ${JSON.stringify(event)}\n\n`)
    after = event.id
  }

  // Telemetry is folded from the same events the client receives, seeded with
  // whatever it has already seen, so live and reloaded numbers always agree.
  const folder = new RunTelemetryFolder()
  try {
    for (const event of await readRunEvents(workspace, runId, { upTo: after })) {
      folder.add(event.payload, Date.parse(event.createdAt) || undefined)
    }
  } catch {
    // A seed failure only means the bar starts from zero; streaming continues.
  }
  const sendTelemetry = (): void => {
    if (closed) return
    response.write(`event: telemetry\ndata: ${JSON.stringify(folder.snapshot())}\n\n`)
  }
  sendTelemetry()

  const poll = async (): Promise<void> => {
    if (closed || polling) return
    polling = true
    let changed = false
    try {
      const events = await workspace.listStageRunEvents(runId, after, 1000)
      for (const event of events) {
        if (closed) return
        writeEvent(event)
        if (folder.add(event.payload, Date.parse(event.createdAt) || undefined)) changed = true
      }
      if (changed) sendTelemetry()
      const run = await workspace.getStageRun(runId)
      if (run !== undefined && ['completed', 'failed', 'cancelled'].includes(run.status) && events.length === 0) {
        if (!closed) {
          response.write('event: end\ndata: {}\n\n')
          cleanup()
          response.end()
        }
      }
    } catch {
      if (!closed) {
        response.write('event: error\ndata: {"message":"event stream failed"}\n\n')
        cleanup()
        response.end()
      }
    } finally {
      polling = false
    }
  }

  pollTimer = setInterval(() => { void poll() }, 500)
  heartbeatTimer = setInterval(() => {
    if (!closed) response.write(': keepalive\n\n')
  }, 15_000)
  void poll()
}

async function handleStageRuns(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  rest: string[],
  options: ChatApiOptions,
): Promise<void> {
  const runtime = options.stageRuntime
  if (runtime === undefined) {
    throw new HttpError(503, 'stage runtime is disabled', 'STAGE_RUNTIME_DISABLED')
  }
  const runId = rest[0] === undefined ? undefined : decodeURIComponent(rest[0])
  if (runId === undefined) throw new HttpError(404, 'not found', 'NOT_FOUND')

  if (rest.length === 1 && request.method === 'GET') {
    sendJson(response, 200, { run: await runtime.get(runId) })
    return
  }
  if (rest.length === 2 && rest[1] === 'reviews' && request.method === 'GET') {
    if (options.workspace === undefined) {
      throw new HttpError(503, 'project workspace is disabled', 'WORKSPACE_NOT_CONFIGURED')
    }
    sendJson(response, 200, { reviews: await options.workspace.listStageReviews(runId) })
    return
  }
  if (rest.length === 2 && rest[1] === 'events' && request.method === 'GET') {
    if (options.workspace === undefined) {
      throw new HttpError(503, 'project workspace is disabled', 'WORKSPACE_NOT_CONFIGURED')
    }
    if (await options.workspace.getStageRun(runId) === undefined) {
      throw new HttpError(404, 'stage run not found', 'STAGE_RUN_NOT_FOUND')
    }
    const after = url.searchParams.get('after') ?? '0'
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10) || 200
    const events = await options.workspace.listStageRunEvents(runId, after, limit)
    sendJson(response, 200, {
      events,
      nextAfter: events.at(-1)?.id ?? after,
    })
    return
  }
  if (rest.length === 2 && rest[1] === 'telemetry' && request.method === 'GET') {
    if (options.workspace === undefined) {
      throw new HttpError(503, 'project workspace is disabled', 'WORKSPACE_NOT_CONFIGURED')
    }
    if (await options.workspace.getStageRun(runId) === undefined) {
      throw new HttpError(404, 'stage run not found', 'STAGE_RUN_NOT_FOUND')
    }
    const events = await readRunEvents(options.workspace, runId)
    sendJson(response, 200, { telemetry: telemetryFromEvents(events) })
    return
  }
  if (rest.length === 3 && rest[1] === 'events' && rest[2] === 'stream' && request.method === 'GET') {
    if (options.workspace === undefined) {
      throw new HttpError(503, 'project workspace is disabled', 'WORKSPACE_NOT_CONFIGURED')
    }
    await streamStageEvents(request, response, url, runId, options.workspace)
    return
  }
  if (rest.length === 2 && rest[1] === 'export' && request.method === 'POST') {
    sendJson(response, 200, { export: await runtime.exportRun(runId) })
    return
  }
  if (rest.length === 2 && rest[1] === 'execute' && request.method === 'POST') {
    if (url.searchParams.get('wait') === '1') {
      sendJson(response, 200, { run: await runtime.execute(runId) })
      return
    }
    void runtime.execute(runId).catch(() => {})
    sendJson(response, 202, { run: await runtime.get(runId) })
    return
  }
  if (rest.length === 2 && rest[1] === 'gate' && request.method === 'POST') {
    const body = await readJson(request)
    const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
    if (record.action !== 'apply' && record.action !== 'accept') {
      throw new HttpError(400, 'action must be "apply" or "accept"', 'INVALID_GATE_ACTION')
    }
    sendJson(response, 200, { run: await runtime.answerGate(runId, record.action) })
    return
  }
  if (rest.length === 2 && rest[1] === 'decision' && request.method === 'POST') {
    const body = await readJson(request)
    const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
    const refine = record.refine === true
    if (!refine) {
      const decision = record.decision
      if (decision !== 'go' && decision !== 'conditional_go' && decision !== 'no_go') {
        throw new HttpError(400, 'decision must be go, conditional_go or no_go when refine is false', 'INVALID_HUMAN_DECISION')
      }
      sendJson(response, 200, {
        run: await runtime.decide(runId, {
          decision,
          ...(typeof record.note === 'string' ? { note: record.note } : {}),
        }),
      })
      return
    }
    sendJson(response, 200, { run: await runtime.decide(runId, { refine: true }) })
    return
  }
  throw new HttpError(404, 'not found', 'NOT_FOUND')
}

async function handleProjects(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  rest: string[],
  options: ChatApiOptions,
): Promise<void> {
  const projects = options.projects
  if (projects === undefined) {
    throw new HttpError(503, 'project registry is disabled; set DATABASE_URL', 'DATABASE_NOT_CONFIGURED')
  }

  const id = rest[0] === undefined ? undefined : decodeURIComponent(rest[0])

  if (rest.length === 0) {
    if (request.method === 'GET') {
      const status = url.searchParams.get('status') ?? undefined
      const organization = url.searchParams.get('organization') ?? undefined
      const list = await projects.list({
        ...(status !== undefined ? { status: status as ProjectStatus } : {}),
        ...(organization !== undefined ? { organization } : {}),
      })
      sendJson(response, 200, { projects: list })
      return
    }
    if (request.method === 'POST') {
      const project = await projects.create(await readJson(request))
      await options.workspace?.ensureProject(project.id)
      sendJson(response, 201, await projectView(project.id, options))
      return
    }
  }

  if (rest.length === 4 && rest[1] === 'sessions' && rest[3] === 'pdf-review' && request.method === 'POST') {
    if (options.pdfReview === undefined) {
      throw new HttpError(503, 'PDF review is disabled', 'PDF_REVIEW_DISABLED')
    }
    const projectId = decodeURIComponent(rest[0]!)
    const sessionId = decodeURIComponent(rest[2]!)
    const upload = await readMultipart(request)
    sendJson(response, 200, await options.pdfReview.review({
      projectId,
      sessionId,
      message: upload.fields.message ?? '',
      filename: upload.filename,
      pdf: upload.buffer,
    }))
    return
  }

  if (id !== undefined && rest.length === 2 && rest[1] === 'stats' && request.method === 'GET') {
    await projects.get(id)
    const workspace = requireWorkspace(options)
    const q = url.searchParams
    sendJson(response, 200, {
      stats: await workspace.projectStats({
        projectId: id,
        ...statsRangeFromQuery(q),
        ...(q.get('stage') !== null ? { stage: q.get('stage')! } : {}),
        ...(q.get('role') !== null ? { role: q.get('role')! } : {}),
      }),
    })
    return
  }

  if (id !== undefined && rest.length === 2 && rest[1] === 'logs' && request.method === 'GET') {
    await projects.get(id)
    sendJson(response, 200, await projectLogs(id, url, options))
    return
  }

  if (id !== undefined && rest.length === 2 && rest[1] === 'observability' && request.method === 'GET') {
    if (options.observability === undefined) {
      throw new HttpError(503, 'observability is disabled', 'OBSERVABILITY_DISABLED')
    }
    const hours = Number.parseInt(url.searchParams.get('hours') ?? '24', 10)
    sendJson(response, 200, {
      observability: await options.observability.summary(id, Number.isSafeInteger(hours) ? hours : 24),
    })
    return
  }

  if (id !== undefined && rest.length === 2 && rest[1] === 'index' && request.method === 'POST') {
    if (options.semanticIndex === undefined) {
      throw new HttpError(503, 'semantic indexing is disabled', 'SEMANTIC_INDEX_DISABLED')
    }
    const body = await readJson(request).catch(() => ({}))
    const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
    const documentId = typeof record.documentId === 'string' ? record.documentId : undefined
    if (documentId !== undefined) {
      const project = await projects.get(id)
      const document = await requireWorkspace(options).getDocument(id, documentId)
      if (document === undefined) throw new HttpError(404, 'document not found', 'DOCUMENT_NOT_FOUND')
      sendJson(response, 200, { document: await options.semanticIndex.indexDocument(project, document) })
      return
    }
    sendJson(response, 200, await options.semanticIndex.indexProject(id))
    return
  }

  if (id !== undefined && rest.length === 2 && rest[1] === 'search' && request.method === 'GET') {
    if (options.semanticIndex === undefined) {
      throw new HttpError(503, 'semantic search is disabled', 'SEMANTIC_INDEX_DISABLED')
    }
    const query = url.searchParams.get('q') ?? ''
    const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '8', 10)
    const limit = Number.isSafeInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 8
    const sourceType = url.searchParams.get('sourceType') ?? undefined
    sendJson(response, 200, await options.semanticIndex.search({
      projectId: id,
      query,
      limit,
      ...(sourceType !== undefined ? { sourceType } : {}),
    }))
    return
  }

  if (id !== undefined && rest.length === 4 && rest[1] === 'stages' && rest[3] === 'runs') {
    if (options.stageRuntime === undefined) {
      throw new HttpError(503, 'stage runtime is disabled', 'STAGE_RUNTIME_DISABLED')
    }
    const stage = decodeURIComponent(rest[2]!)
    if (request.method === 'GET') {
      sendJson(response, 200, { runs: await options.stageRuntime.list(id, stage) })
      return
    }
    if (request.method === 'POST') {
      const body = await readJson(request).catch(() => ({}))
      const attachmentIds = body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>).attachmentIds
        : undefined
      if (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || attachmentIds.some((entry) => typeof entry !== 'string'))) {
        throw new HttpError(400, '"attachmentIds" must be an array of attachment ids', 'INVALID_ATTACHMENTS')
      }
      const brief = body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>).brief
        : undefined
      if (brief !== undefined && typeof brief !== 'string') {
        throw new HttpError(400, '"brief" must be a string', 'INVALID_BRIEF')
      }
      sendJson(response, 201, {
        run: await options.stageRuntime.start({
          projectId: id,
          stage,
          brief,
          ...(attachmentIds !== undefined ? { attachmentIds: attachmentIds as string[] } : {}),
        }),
      })
      return
    }
  }

  // The generated PDF lives in the project tree; this streams it for the UI.
  if (id !== undefined && rest.length === 4 && rest[1] === 'documents' && rest[3] === 'export' && request.method === 'GET') {
    const workspace = requireWorkspace(options)
    const project = await projects.get(id)
    const documentId = decodeURIComponent(rest[2]!)
    const document = await workspace.getDocument(id, documentId)
    if (document === undefined) throw new HttpError(404, 'document not found', 'DOCUMENT_NOT_FOUND')

    const exported = (await workspace.listDocumentExports([documentId])).get(documentId)
    if (exported === undefined) {
      throw new HttpError(404, 'this document has no exported PDF yet; complete the stage or POST /api/stage-runs/:id/export', 'DOCUMENT_NOT_EXPORTED')
    }

    // The recorded path is written by the server, but never trust it: resolve and
    // confirm it stays inside <root>/documents before reading anything.
    const documentsRoot = resolve(project.rootPath, EXPORT_ROOT)
    const absolute = resolve(project.rootPath, exported.path)
    if (!absolute.startsWith(`${documentsRoot}${sep}`)) {
      throw new HttpError(500, 'the recorded export path is outside the project documents directory', 'EXPORT_PATH_INVALID')
    }

    let bytes: Buffer
    try {
      bytes = await readFile(absolute)
    } catch {
      throw new HttpError(410, 'the exported PDF is no longer on disk; re-export it', 'EXPORT_FILE_MISSING')
    }

    const name = basename(absolute)
    const asciiName = name.replace(/[^\x20-\x7e]/g, '-').replace(/["\\]/g, '_')
    response.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    })
    response.end(bytes)
    return
  }

  if (id !== undefined && rest.length === 4 && rest[1] === 'documents' && rest[3] === 'content' && request.method === 'GET') {
    await sendProjectDocument(request, response, id, decodeURIComponent(rest[2]!), options)
    return
  }

  if (id !== undefined && rest.length === 4 && rest[1] === 'checklist' && request.method === 'PATCH') {
    const workspace = requireWorkspace(options)
    const body = await readJson(request)
    const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
    const item = await workspace.updateChecklistItem(
      id,
      decodeURIComponent(rest[2]!),
      decodeURIComponent(rest[3]!),
      record.status,
      typeof record.evidenceDocumentId === 'string' ? record.evidenceDocumentId : undefined,
    )
    sendJson(response, 200, { item })
    return
  }

  if (id !== undefined && rest.length === 3 && rest[1] === 'documents') {
    const workspace = requireWorkspace(options)
    const documentId = decodeURIComponent(rest[2]!)
    if (request.method === 'GET') {
      const document = await workspace.getDocument(id, documentId)
      if (document === undefined) throw new HttpError(404, 'document not found', 'DOCUMENT_NOT_FOUND')
      sendJson(response, 200, { document })
      return
    }
    if (request.method === 'PATCH') {
      const body = await readJson(request)
      const status = body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>).status
        : undefined
      sendJson(response, 200, { document: await workspace.updateDocumentStatus(id, documentId, status) })
      return
    }
  }

  if (id !== undefined && rest.length === 4 && rest[1] === 'stages' && rest[3] === 'settings') {
    const stageSettings = options.stageSettings
    if (stageSettings === undefined) {
      throw new HttpError(503, 'stage settings are disabled; set DATABASE_URL', 'STAGE_SETTINGS_NOT_CONFIGURED')
    }
    const stage = decodeURIComponent(rest[2]!)
    if (stage !== 'planning') {
      throw new HttpError(501, 'settings exist only for the planning stage so far', 'STAGE_SETTINGS_NOT_IMPLEMENTED')
    }
    await projects.get(id)
    if (request.method === 'GET') {
      sendJson(response, 200, { settings: await stageSettings.resolve(id) })
      return
    }
    if (request.method === 'PATCH' || request.method === 'POST') {
      sendJson(response, 200, { settings: await stageSettings.setProject(id, await readJson(request)) })
      return
    }
    if (request.method === 'DELETE') {
      sendJson(response, 200, { settings: await stageSettings.setProject(id, null) })
      return
    }
    throw new HttpError(405, 'method not allowed', 'METHOD_NOT_ALLOWED')
  }

  if (id !== undefined && rest.length === 2 && rest[1] === 'documents') {
    const workspace = requireWorkspace(options)
    if (request.method === 'GET') {
      sendJson(response, 200, { documents: await workspace.listDocuments(id) })
      return
    }
    if (request.method === 'POST') {
      const project = await projects.get(id)
      const upload = await readMultipart(request)
      const stage = upload.fields.stage ?? project.currentStage
      const document = await workspace.addDocument({
        project,
        stage: stage as ProjectStage,
        kind: upload.fields.kind ?? 'other',
        title: upload.fields.title ?? upload.filename,
        filename: upload.filename,
        mimeType: upload.mimeType,
        buffer: upload.buffer,
      })
      sendJson(response, 201, { document })
      return
    }
  }

  if (id !== undefined && rest[1] === 'attachments') {
    const workspace = requireWorkspace(options)
    const project = await projects.get(id)

    // POST /api/projects/:id/attachments — one or more PDFs in a single request.
    if (rest.length === 2 && request.method === 'POST') {
      const upload = await readMultipartFiles(request, { maxFiles: MAX_ATTACHMENTS_PER_UPLOAD })
      const stage = upload.fields.stage
      if (stage !== undefined && !SDLC_STAGES.includes(stage as never)) {
        throw new HttpError(400, `unknown SDLC stage ${stage}`, 'INVALID_STAGE')
      }
      const created = []
      for (const file of upload.files) {
        assertSupportedUpload({ filename: file.filename, mimeType: file.mimeType, size: file.buffer.length })
        created.push(await workspace.addAttachment({
          project,
          stage: (stage ?? project.currentStage) as ProjectStage,
          ...(upload.fields.title !== undefined && upload.files.length === 1 ? { title: upload.fields.title } : {}),
          filename: file.filename,
          mimeType: file.mimeType,
          buffer: file.buffer,
        }))
      }
      sendJson(response, 201, { attachments: created })
      return
    }

    if (rest.length === 2 && request.method === 'GET') {
      const stage = url.searchParams.get('stage')
      if (stage !== null && !SDLC_STAGES.includes(stage as never)) {
        throw new HttpError(400, `unknown SDLC stage ${stage}`, 'INVALID_STAGE')
      }
      sendJson(response, 200, {
        attachments: await workspace.listAttachments(id, stage === null ? undefined : stage as ProjectStage),
      })
      return
    }

    // rest includes the project id, so the attachment id is rest[2].
    if (rest.length === 4 && rest[3] === 'content' && request.method === 'GET') {
      const attachment = await workspace.getAttachment(id, decodeURIComponent(rest[2]!))
      if (attachment === undefined) throw new HttpError(404, 'attachment not found', 'ATTACHMENT_NOT_FOUND')
      const stored = resolve(project.rootPath, attachment.storagePath)
      let bytes: Buffer
      try {
        bytes = await readFile(stored)
      } catch {
        throw new HttpError(410, 'the stored attachment file is missing', 'ATTACHMENT_CONTENT_MISSING')
      }
      response.writeHead(200, {
        'Content-Type': attachment.mimeType,
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `inline; filename="${basename(attachment.filename).replace(/[^\w.-]/g, '_')}"`,
      })
      response.end(bytes)
      return
    }

    if (rest.length === 3 && request.method === 'DELETE') {
      const removed = await workspace.deleteAttachment(id, decodeURIComponent(rest[2]!), project.rootPath)
      if (!removed) throw new HttpError(404, 'attachment not found', 'ATTACHMENT_NOT_FOUND')
      response.writeHead(204).end()
      return
    }

    throw new HttpError(404, 'not found', 'NOT_FOUND')
  }

  if (id !== undefined && rest.length === 2 && rest[1] === 'briefing') {
    if (options.briefing === undefined) {
      throw new HttpError(503, 'project briefing is disabled', 'BRIEFING_DISABLED')
    }
    if (request.method === 'GET') {
      const briefing = await options.briefing.get(id)
      if (briefing === undefined) {
        throw new HttpError(404, 'no briefing has been generated for this project', 'BRIEFING_NOT_FOUND')
      }
      sendJson(response, 200, { briefing })
      return
    }
    if (request.method === 'POST') {
      const body = await readJson(request).catch(() => ({}))
      const refresh = body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>).refresh === true
        : false
      sendJson(response, 200, { briefing: await options.briefing.generate(id, { refresh }) })
      return
    }
  }

  if (id !== undefined && rest.length === 2 && rest[1] === 'stage' && request.method === 'PATCH') {
    const workspace = requireWorkspace(options)
    const body = await readJson(request)
    const stage = body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>).stage
      : undefined
    if (typeof stage !== 'string') throw new HttpError(400, '"stage" is required', 'INVALID_STAGE')
    await workspace.advanceStage(id, stage)
    sendJson(response, 200, await projectView(id, options))
    return
  }

  if (id !== undefined && rest.length === 1) {
    if (request.method === 'GET') {
      sendJson(response, 200, await projectView(id, options))
      return
    }
    if (request.method === 'PATCH') {
      sendJson(response, 200, { project: await projects.update(id, await readJson(request)) })
      return
    }
    if (request.method === 'DELETE') {
      await projects.remove(id)
      if (options.logStore !== undefined) {
        await options.logStore.deleteProject(id).catch((error: unknown) => {
          (options.logger ?? noopLogger).child({ component: 'logging' })
            .warn({ event: 'logging.project_cleanup_failed', projectId: id, err: error })
        })
      }
      if (options.observability !== undefined) {
        // Best-effort and non-blocking: a slow or dead monitor must not delay project deletion.
        void options.observability.deleteProject(id).catch((error: unknown) => {
          (options.logger ?? noopLogger).child({ component: 'observability' })
            .warn({ event: 'observability.project_cleanup_failed', projectId: id, err: error })
        })
      }
      if (options.observabilityRecorder !== undefined) {
        // Release the project's tracer provider/exporters (bounded, never throws).
        void options.observabilityRecorder.forgetProject(id).catch(() => {})
      }
      response.writeHead(204)
      response.end()
      return
    }
  }

  if (id !== undefined && rest.length === 2 && rest[1] === 'status' && request.method === 'PATCH') {
    const body = await readJson(request)
    const status = body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>).status
      : undefined
    sendJson(response, 200, { project: await projects.changeStatus(id, status) })
    return
  }

  throw new HttpError(404, 'not found', 'NOT_FOUND')
}

async function projectView(projectId: string, options: ChatApiOptions): Promise<Record<string, unknown>> {
  const projects = options.projects!
  const project = await projects.get(projectId)
  if (options.workspace === undefined) return { project }
  const snapshot = await options.workspace.getSnapshot(projectId)
  const { documents, ...sdlc } = snapshot
  return { project, sdlc, documents }
}

function requireWorkspace(options: ChatApiOptions): PostgresProjectWorkspace {
  if (options.workspace === undefined) {
    throw new HttpError(503, 'project workspace is disabled; set DATABASE_URL', 'WORKSPACE_NOT_CONFIGURED')
  }
  return options.workspace
}

async function sendProjectDocument(
  request: IncomingMessage,
  response: ServerResponse,
  projectId: string,
  documentId: string,
  options: ChatApiOptions,
): Promise<void> {
  const workspace = requireWorkspace(options)
  const project = await options.projects!.get(projectId)
  const document = await workspace.getDocument(projectId, documentId)
  if (document === undefined) throw new HttpError(404, 'document not found', 'DOCUMENT_NOT_FOUND')
  const root = resolve(project.rootPath)
  const absolute = resolve(root, document.storagePath)
  if (!absolute.startsWith(`${root}/`)) {
    throw new HttpError(400, 'invalid document path', 'INVALID_DOCUMENT_PATH')
  }
  let data: Buffer
  try {
    data = await readFile(absolute)
  } catch {
    throw new HttpError(404, 'document file is missing', 'DOCUMENT_FILE_MISSING')
  }
  const filename = basename(document.title).replace(/["\r\n]/g, '_')
  response.writeHead(200, {
    'Content-Type': document.mimeType || 'application/octet-stream',
    'Content-Length': data.byteLength,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(data)
}

async function handleSessions(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  rest: string[],
  options: ChatApiOptions,
): Promise<void> {
  const id = rest[0] === undefined ? undefined : decodeURIComponent(rest[0])

  if (request.method === 'GET' && id === undefined) {
    const projectId = url.searchParams.get('projectId')
    sendJson(response, 200, {
      sessions: options.store.list(projectId === null || projectId === '' ? {} : { projectId }),
    })
    return
  }

  if (request.method === 'GET' && id !== undefined) {
    const session = options.store.get(id)
    if (session === undefined) throw new HttpError(404, 'session not found', 'SESSION_NOT_FOUND')
    if (rest.length === 2 && rest[1] === 'messages') {
      sendJson(response, 200, { messages: session.messages })
    } else if (rest.length === 1) {
      sendJson(response, 200, { session: { ...session, messageCount: session.messages.length } })
    } else {
      throw new HttpError(404, 'not found', 'NOT_FOUND')
    }
    return
  }

  if (request.method === 'DELETE' && id !== undefined && rest.length === 1) {
    try {
      const removed = options.store.delete(id)
      if (!removed) throw new HttpError(404, 'session not found', 'SESSION_NOT_FOUND')
    } catch (error) {
      if (error instanceof SessionBusyError) throw new HttpError(409, error.message, 'SESSION_BUSY')
      throw error
    }
    response.writeHead(204)
    response.end()
    return
  }

  throw new HttpError(404, 'not found', 'NOT_FOUND')
}

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

async function handleChatStream(
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

interface ChatInput {
  message: string
  sessionId?: string
  projectId?: string
}

interface ChatScope {
  cwd?: string
  meta: { projectId?: string }
}

/**
 * Decide where a turn runs. A session is bound to the project of its first
 * turn: continuing it reuses that project's root, and asking for a different
 * project is a conflict (the harness session lives in the original workspace).
 */
async function resolveChatScope(input: ChatInput, options: ChatApiOptions): Promise<ChatScope> {
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

function parseChatInput(body: unknown): ChatInput {
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

function acquire(store: SessionStore, sessionId: string | undefined): () => void {
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

async function readJson(request: IncomingMessage): Promise<unknown> {
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

function requireToken(request: IncomingMessage, token: string | undefined): void {
  if (token === undefined || token === '') return
  const header = request.headers.authorization
  if (header !== `Bearer ${token}`) {
    throw new HttpError(401, 'missing or invalid bearer token', 'UNAUTHORIZED')
  }
}

function applyCors(
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

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(html)
}

function sendText(response: ServerResponse, text: string, contentType: string): void {
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(text)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  })
  response.end(text)
}

function sendError(response: ServerResponse, error: HttpError): void {
  if (error.status === 401) response.setHeader('WWW-Authenticate', 'Bearer')
  sendJson(response, error.status, {
    error: {
      message: error.message,
      code: error.code,
      status: error.status,
    },
  })
}

class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, message: string, code: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** `days`, `from` and `to` query parameters shared by the stats endpoints. */
function statsRangeFromQuery(q: URLSearchParams): { from?: string; to?: string; days?: number } {
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
function modelErrorStatus(error: ModelError): number {
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

function toHttpError(error: unknown): HttpError {
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

/** Convenience for tests: the actual bound port after `listen(0)`. */
export function serverPort(server: Server): number {
  const address = server.address() as AddressInfo | null
  if (address === null) throw new Error('server is not listening')
  return address.port
}

export type { ChatSession }
