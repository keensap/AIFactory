/**
 * Projects: the registry itself, plus the artifacts and views that hang off one —
 * documents, attachments, checklists, logs, telemetry, indexing and the PDF
 * download.
 *
 * Stage runs, stage settings and readiness live in their own modules: they are
 * addressed under a project but are run and configuration concerns.
 */

import { readFile } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import type { ChatApiOptions } from '../api-options.ts'
import {
  HttpError,
  readJson,
  sendJson,
  statsRangeFromQuery,
} from '../http.ts'
import type { ProjectStatus } from '../projects.ts'
import type { ProjectStage } from '../sdlc.ts'
import { SDLC_STAGES } from '../sdlc.ts'
import { assertSupportedUpload, MAX_ATTACHMENTS_PER_UPLOAD } from '../attachments.ts'
import { EXPORT_ROOT } from '../report/export.ts'
import { readMultipart, readMultipartFiles } from '../multipart.ts'
import { noopLogger } from '../logging/index.ts'
import { appToUnified, projectView, requireLogStore, requireWorkspace, type UnifiedLog } from './shared.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { requiredParam, route, type RouteDef } from './router.ts'

function requireProjects(options: ChatApiOptions) {
  const projects = options.projects
  if (projects === undefined) {
    throw new HttpError(503, 'project registry is disabled; set DATABASE_URL', 'DATABASE_NOT_CONFIGURED')
  }
  return projects
}

export const projectRoutes: RouteDef[] = [
  // ---- registry -------------------------------------------------------
  route('GET', '/api/projects', 'operator', async ({ url, response, options }) => {
    const projects = requireProjects(options)
    const status = url.searchParams.get('status') ?? undefined
    const organization = url.searchParams.get('organization') ?? undefined
    sendJson(response, 200, {
      projects: await projects.list({
        ...(status !== undefined ? { status: status as ProjectStatus } : {}),
        ...(organization !== undefined ? { organization } : {}),
      }),
    })
  }, 'listProjects'),

  route('POST', '/api/projects', 'operator', async ({ request, response, options }) => {
    const projects = requireProjects(options)
    const project = await projects.create(await readJson(request))
    await options.workspace?.ensureProject(project.id)
    sendJson(response, 201, await projectView(project.id, options))
  }, 'createProject'),

  route('GET', '/api/projects/:id', 'operator', async ({ params, response, options }) => {
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    sendJson(response, 200, await projectView(id, options))
  }, 'getProject'),

  route('PATCH', '/api/projects/:id', 'operator', async ({ request, params, response, options }) => {
    const projects = requireProjects(options)
    sendJson(response, 200, { project: await projects.update(requiredParam(params, 'id'), await readJson(request)) })
  }, 'updateProject'),

  route('DELETE', '/api/projects/:id', 'operator', async ({ params, response, options }) => {
    const id = requiredParam(params, 'id')
    await requireProjects(options).remove(id)
    if (options.logStore !== undefined) {
      await options.logStore.deleteProject(id).catch((error: unknown) => {
        (options.logger ?? noopLogger).child({ component: 'logging' })
          .warn({ event: 'logging.project_cleanup_failed', projectId: id, err: error })
      })
    }
    if (options.observability !== undefined) {
      // Best-effort and non-blocking: a slow or dead monitor must not delay deletion.
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
  }, 'deleteProject'),

  route('PATCH', '/api/projects/:id/status', 'operator', async ({ request, params, response, options }) => {
    const projects = requireProjects(options)
    const body = await readJson(request)
    const status = body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>).status
      : undefined
    sendJson(response, 200, { project: await projects.changeStatus(requiredParam(params, 'id'), status) })
  }, 'changeProjectStatus'),

  route('PATCH', '/api/projects/:id/stage', 'operator', async ({ request, params, response, options }) => {
    const workspace = requireWorkspace(options)
    const id = requiredParam(params, 'id')
    const body = await readJson(request)
    const stage = body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>).stage
      : undefined
    if (typeof stage !== 'string') throw new HttpError(400, '"stage" is required', 'INVALID_STAGE')
    await workspace.advanceStage(id, stage)
    sendJson(response, 200, await projectView(id, options))
  }, 'advanceProjectStage'),

  // ---- metrics, logs, observability -----------------------------------
  route('GET', '/api/projects/:id/stats', 'operator', async ({ params, url, response, options }) => {
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    const workspace = requireWorkspace(options)
    const query = url.searchParams
    sendJson(response, 200, {
      stats: await workspace.projectStats({
        projectId: id,
        ...statsRangeFromQuery(query),
        ...(query.get('stage') !== null ? { stage: query.get('stage')! } : {}),
        ...(query.get('role') !== null ? { role: query.get('role')! } : {}),
      }),
    })
  }, 'projectStats'),

  route('GET', '/api/projects/:id/logs', 'operator', async ({ params, url, response, options }) => {
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    sendJson(response, 200, await projectLogs(id, url, options))
  }, 'projectLogs'),

  route('GET', '/api/projects/:id/observability', 'operator', async ({ params, url, response, options }) => {
    const reader = options.observability
    if (reader === undefined) {
      throw new HttpError(503, 'observability is disabled', 'OBSERVABILITY_DISABLED')
    }
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    const hours = Number.parseInt(url.searchParams.get('hours') ?? '24', 10)
    sendJson(response, 200, {
      observability: await reader.summary(id, Number.isSafeInteger(hours) ? hours : 24),
    })
  }, 'projectObservability'),

  // ---- semantic index and search --------------------------------------
  route('POST', '/api/projects/:id/index', 'operator', async ({ request, params, response, options }) => {
    const index = options.semanticIndex
    if (index === undefined) {
      throw new HttpError(503, 'semantic indexing is disabled', 'SEMANTIC_INDEX_DISABLED')
    }
    const projects = requireProjects(options)
    const id = requiredParam(params, 'id')
    // A body is optional here: an absent one means "index the whole project".
    const body = await readJson(request).catch(() => ({}))
    const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
    const documentId = typeof record.documentId === 'string' ? record.documentId : undefined
    if (documentId !== undefined) {
      const project = await projects.get(id)
      const document = await requireWorkspace(options).getDocument(id, documentId)
      if (document === undefined) throw new HttpError(404, 'document not found', 'DOCUMENT_NOT_FOUND')
      sendJson(response, 200, { document: await index.indexDocument(project, document) })
      return
    }
    sendJson(response, 200, await index.indexProject(id))
  }, 'indexProject'),

  route('GET', '/api/projects/:id/search', 'operator', async ({ params, url, response, options }) => {
    const index = options.semanticIndex
    if (index === undefined) {
      throw new HttpError(503, 'semantic search is disabled', 'SEMANTIC_INDEX_DISABLED')
    }
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    const query = url.searchParams.get('q') ?? ''
    const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '8', 10)
    const limit = Number.isSafeInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 8
    const sourceType = url.searchParams.get('sourceType') ?? undefined
    sendJson(response, 200, await index.search({
      projectId: id,
      query,
      limit,
      ...(sourceType !== undefined ? { sourceType } : {}),
    }))
  }, 'searchProject'),

  // ---- briefing --------------------------------------------------------
  route('GET', '/api/projects/:id/briefing', 'operator', async ({ params, response, options }) => {
    const briefing = options.briefing
    if (briefing === undefined) {
      throw new HttpError(503, 'project briefing is disabled', 'BRIEFING_DISABLED')
    }
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    const current = await briefing.get(id)
    if (current === undefined) {
      throw new HttpError(404, 'no briefing has been generated for this project', 'BRIEFING_NOT_FOUND')
    }
    sendJson(response, 200, { briefing: current })
  }, 'getProjectBriefing'),

  route('POST', '/api/projects/:id/briefing', 'operator', async ({ request, params, response, options }) => {
    const briefing = options.briefing
    if (briefing === undefined) {
      throw new HttpError(503, 'project briefing is disabled', 'BRIEFING_DISABLED')
    }
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    const body = await readJson(request).catch(() => ({}))
    const refresh = body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>).refresh === true
      : false
    sendJson(response, 200, { briefing: await briefing.generate(id, { refresh }) })
  }, 'generateProjectBriefing'),

  // ---- documents -------------------------------------------------------
  route('GET', '/api/projects/:id/documents', 'operator', async ({ params, response, options }) => {
    sendJson(response, 200, { documents: await requireWorkspace(options).listDocuments(requiredParam(params, 'id')) })
  }, 'listDocuments'),

  route('POST', '/api/projects/:id/documents', 'operator', async ({ request, params, response, options }) => {
    const workspace = requireWorkspace(options)
    const id = requiredParam(params, 'id')
    const project = await requireProjects(options).get(id)
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
  }, 'uploadDocument'),

  route('GET', '/api/projects/:id/documents/:documentId', 'operator', async ({ params, response, options }) => {
    const documentId = requiredParam(params, 'documentId')
    const document = await requireWorkspace(options).getDocument(requiredParam(params, 'id'), documentId)
    if (document === undefined) throw new HttpError(404, 'document not found', 'DOCUMENT_NOT_FOUND')
    sendJson(response, 200, { document })
  }, 'getDocument'),

  route('PATCH', '/api/projects/:id/documents/:documentId', 'operator', async ({ request, params, response, options }) => {
    const workspace = requireWorkspace(options)
    const body = await readJson(request)
    const status = body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>).status
      : undefined
    sendJson(response, 200, {
      document: await workspace.updateDocumentStatus(requiredParam(params, 'id'), requiredParam(params, 'documentId'), status),
    })
  }, 'updateDocumentStatus'),

  route('GET', '/api/projects/:id/documents/:documentId/content', 'operator', async ({ request, params, response, options }) => {
    await sendProjectDocument(request, response, requiredParam(params, 'id'), requiredParam(params, 'documentId'), options)
  }, 'downloadDocument'),

  route('GET', '/api/projects/:id/documents/:documentId/export', 'operator', async ({ params, response, options }) => {
    const projects = requireProjects(options)
    const workspace = requireWorkspace(options)
    const id = requiredParam(params, 'id')
    const documentId = requiredParam(params, 'documentId')
    const project = await projects.get(id)
    const document = await workspace.getDocument(id, documentId)
    if (document === undefined) throw new HttpError(404, 'document not found', 'DOCUMENT_NOT_FOUND')

    const exported = (await workspace.listDocumentExports([documentId])).get(documentId)
    if (exported === undefined) {
      throw new HttpError(
        404,
        'this document has no exported PDF yet; complete the stage or POST /api/stage-runs/:id/export',
        'DOCUMENT_NOT_EXPORTED',
      )
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

    sendFile(response, bytes, 'application/pdf', basename(absolute), {
      'Cache-Control': 'no-store',
    })
  }, 'downloadDocumentExport'),

  // ---- checklist -------------------------------------------------------
  route('PATCH', '/api/projects/:id/checklist/:stage/:key', 'operator', async ({ request, params, response, options }) => {
    const workspace = requireWorkspace(options)
    const body = await readJson(request)
    const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
    const item = await workspace.updateChecklistItem(
      requiredParam(params, 'id'),
      requiredParam(params, 'stage'),
      requiredParam(params, 'key'),
      record.status,
      typeof record.evidenceDocumentId === 'string' ? record.evidenceDocumentId : undefined,
    )
    sendJson(response, 200, { item })
  }, 'updateChecklistItem'),

  // ---- attachments -----------------------------------------------------
  route('POST', '/api/projects/:id/attachments', 'operator', async ({ request, params, response, options }) => {
    const workspace = requireWorkspace(options)
    const id = requiredParam(params, 'id')
    const project = await requireProjects(options).get(id)
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
        // A single-file upload may carry a title; a batch has none per file.
        ...(upload.fields.title !== undefined && upload.files.length === 1 ? { title: upload.fields.title } : {}),
        filename: file.filename,
        mimeType: file.mimeType,
        buffer: file.buffer,
      }))
    }
    sendJson(response, 201, { attachments: created })
  }, 'uploadAttachments'),

  route('GET', '/api/projects/:id/attachments', 'operator', async ({ params, url, response, options }) => {
    const workspace = requireWorkspace(options)
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    const stage = url.searchParams.get('stage')
    if (stage !== null && !SDLC_STAGES.includes(stage as never)) {
      throw new HttpError(400, `unknown SDLC stage ${stage}`, 'INVALID_STAGE')
    }
    sendJson(response, 200, {
      attachments: await workspace.listAttachments(id, stage === null ? undefined : stage as ProjectStage),
    })
  }, 'listAttachments'),

  route('GET', '/api/projects/:id/attachments/:attachmentId/content', 'operator', async ({ params, response, options }) => {
    const workspace = requireWorkspace(options)
    const id = requiredParam(params, 'id')
    const project = await requireProjects(options).get(id)
    const attachment = await workspace.getAttachment(id, requiredParam(params, 'attachmentId'))
    if (attachment === undefined) throw new HttpError(404, 'attachment not found', 'ATTACHMENT_NOT_FOUND')
    let bytes: Buffer
    try {
      bytes = await readFile(resolve(project.rootPath, attachment.storagePath))
    } catch {
      throw new HttpError(410, 'the stored attachment file is missing', 'ATTACHMENT_CONTENT_MISSING')
    }
    sendFile(response, bytes, attachment.mimeType, basename(attachment.filename))
  }, 'downloadAttachment'),

  route('DELETE', '/api/projects/:id/attachments/:attachmentId', 'operator', async ({ params, response, options }) => {
    const workspace = requireWorkspace(options)
    const id = requiredParam(params, 'id')
    const project = await requireProjects(options).get(id)
    const removed = await workspace.deleteAttachment(id, requiredParam(params, 'attachmentId'), project.rootPath)
    if (!removed) throw new HttpError(404, 'attachment not found', 'ATTACHMENT_NOT_FOUND')
    response.writeHead(204).end()
  }, 'deleteAttachment'),

  // ---- PDF requirement review -----------------------------------------
  route('POST', '/api/projects/:projectId/sessions/:sessionId/pdf-review', 'operator', async ({ request, params, response, options }) => {
    const review = options.pdfReview
    if (review === undefined) {
      throw new HttpError(503, 'PDF review is disabled', 'PDF_REVIEW_DISABLED')
    }
    const projectId = requiredParam(params, 'projectId')
    await requireProjects(options).get(projectId)
    const upload = await readMultipart(request)
    sendJson(response, 200, await review.review({
      projectId,
      sessionId: requiredParam(params, 'sessionId'),
      message: upload.fields.message ?? '',
      filename: upload.filename,
      pdf: upload.buffer,
    }))
  }, 'pdfReview'),
]

/**
 * Send a file with an ASCII-safe filename plus an RFC 5987 `filename*`, so a name
 * containing an em dash survives in every client.
 */
function sendFile(
  response: Parameters<typeof sendJson>[0],
  bytes: Buffer,
  contentType: string,
  filename: string,
  headers: Record<string, string> = {},
): void {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '-').replace(/["\\]/g, '_')
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': String(bytes.byteLength),
    'Content-Disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    ...headers,
  })
  response.end(bytes)
}

/**
 * Project log view. `source=events` (default) is the stage event log with an
 * id cursor; `app` reads application logs for the project with an id cursor;
 * `all` merges both newest-first and pages by an ISO timestamp cursor.
 */
export async function projectLogs(projectId: string, url: URL, options: ChatApiOptions): Promise<Record<string, unknown>> {
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
