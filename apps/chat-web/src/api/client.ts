/**
 * Typed client for the AI Factory Chat API.
 *
 * Everything here is transport only: JSON requests for history and health, and
 * a fetch-based SSE reader for turns. React state lives in the app hooks.
 */

import type {
  ApiErrorBody,
  ApiProject,
  ApiProjectInput,
  ApiProjectPatch,
  ChatRecord,
  ProjectStatus,
  ChatStreamEvent,
  DirectoryListing,
  PdfReviewResult,
  HealthResponse,
  StageDecisionInput,
  ProjectDetail,
  ProjectDocument,
  ProjectLog,
  ProjectLogPage,
  ProjectLogQuery,
  ObservabilitySummary,
  ModelCatalogEntry,
  ModelTarget,
  ProjectUsage,
  RunTelemetry,
  PlanningStageSettings,
  ResolvedStageSettings,
  StageAttachment,
  LogLevel,
  SdlcStage,
  SessionDetail,
  StageKey,
  StageReview,
  StageRun,
  StageRunDetail,
  StageRunEvent,
  StageRunEventPage,
  SessionSummary,
} from './types.ts'
import { normalizeAttachment } from '../data/attachments.ts'
import { normalizeStageSettings } from '../data/gates.ts'
import { normalizeTelemetry } from '../data/telemetry.ts'
import { SseParser, type SseFrame } from './sse.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export interface StreamChatInput {
  message: string
  sessionId?: string
  /** Registry project to run a new session in (its rootPath becomes the cwd). */
  projectId?: string
  signal?: AbortSignal
  onEvent: (event: ChatStreamEvent) => void
}

export interface ChatApiOptions {
  baseUrl: string
  token?: string
}

export class ChatApi {
  readonly baseUrl: string
  private readonly token: string

  constructor(options: ChatApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token?.trim() ?? ''
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  async health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.request<HealthResponse>('/api/health', { method: 'GET', signal }, false)
  }

  async listSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
    const body = await this.request<{ sessions: SessionSummary[] }>(
      '/api/sessions',
      { method: 'GET', signal },
    )
    return Array.isArray(body.sessions) ? body.sessions : []
  }

  async getSession(id: string, signal?: AbortSignal): Promise<SessionDetail> {
    const body = await this.request<{ session: SessionDetail }>(
      `/api/sessions/${encodeURIComponent(id)}`,
      { method: 'GET', signal },
    )
    return body.session
  }

  async getMessages(id: string, signal?: AbortSignal): Promise<ChatRecord[]> {
    const body = await this.request<{ messages: ChatRecord[] }>(
      `/api/sessions/${encodeURIComponent(id)}/messages`,
      { method: 'GET', signal },
    )
    return Array.isArray(body.messages) ? body.messages : []
  }

  async deleteSession(id: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(
      `/api/sessions/${encodeURIComponent(id)}`,
      { method: 'DELETE', signal },
    )
  }

  async listProjects(signal?: AbortSignal): Promise<ApiProject[]> {
    const body = await this.request<{ projects: ApiProject[] }>(
      '/api/projects',
      { method: 'GET', signal },
    )
    return Array.isArray(body.projects) ? body.projects : []
  }

  async createProject(input: ApiProjectInput, signal?: AbortSignal): Promise<ApiProject> {
    const body = await this.request<{ project: ApiProject }>(
      '/api/projects',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      },
    )
    return body.project
  }

  async updateProject(
    id: string,
    patch: ApiProjectPatch,
    signal?: AbortSignal,
  ): Promise<ApiProject> {
    const body = await this.request<{ project: ApiProject }>(
      `/api/projects/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        ...(signal === undefined ? {} : { signal }),
      },
    )
    return body.project
  }

  /** Browse directories on the API host for the project root picker. */
  async listDirectories(
    path?: string,
    options: { showHidden?: boolean; signal?: AbortSignal } = {},
  ): Promise<DirectoryListing> {
    const query = new URLSearchParams()
    if (path !== undefined && path !== '') query.set('path', path)
    if (options.showHidden === true) query.set('hidden', '1')
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    return this.request<DirectoryListing>(
      `/api/fs/directories${suffix}`,
      { method: 'GET', signal: options.signal },
    )
  }

  /**
   * Send a requirement PDF for review inside an existing session. The API
   * extracts the text, runs the review in the project root and records the
   * turn on the session.
   */
  async reviewPdf(input: {
    projectId: string
    sessionId: string
    file: Blob
    filename: string
    message: string
    signal?: AbortSignal
  }): Promise<PdfReviewResult> {
    const form = new FormData()
    form.append('message', input.message)
    form.append('file', input.file, input.filename)
    return this.request<PdfReviewResult>(
      `/api/projects/${encodeURIComponent(input.projectId)}/sessions/${encodeURIComponent(input.sessionId)}/pdf-review`,
      { method: 'POST', body: form, ...(input.signal === undefined ? {} : { signal: input.signal }) },
    )
  }

  async setProjectStatus(
    id: string,
    status: ProjectStatus,
    signal?: AbortSignal,
  ): Promise<ApiProject> {
    const body = await this.request<{ project: ApiProject }>(
      `/api/projects/${encodeURIComponent(id)}/status`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
        ...(signal === undefined ? {} : { signal }),
      },
    )
    return body.project
  }

  async deleteProject(id: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(
      `/api/projects/${encodeURIComponent(id)}`,
      { method: 'DELETE', signal },
    )
  }

  // -------------------------------------------------------------------------
  // SDLC stages and stage runs

  async listSdlcStages(signal?: AbortSignal): Promise<SdlcStage[]> {
    const body = await this.request<{ stages: SdlcStage[] }>('/api/sdlc/stages', { method: 'GET', signal })
    return Array.isArray(body.stages) ? body.stages : []
  }

  /** Project with SDLC state (stages, checklist) and documents. */
  async getProjectDetail(id: string, signal?: AbortSignal): Promise<ProjectDetail> {
    return this.request<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`, { method: 'GET', signal })
  }

  /** Advance to the next stage. 409 `STAGE_CHECKLIST_INCOMPLETE` lists the open items. */
  async advanceStage(id: string, stage: StageKey, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(`/api/projects/${encodeURIComponent(id)}/stage`, json('PATCH', { stage }, signal))
  }

  async listStageRuns(projectId: string, stage: StageKey, signal?: AbortSignal): Promise<StageRun[]> {
    const body = await this.request<{ runs: StageRun[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/stages/${encodeURIComponent(stage)}/runs`,
      { method: 'GET', signal },
    )
    return Array.isArray(body.runs) ? body.runs : []
  }

  async createStageRun(
    projectId: string,
    stage: StageKey,
    input: { brief: string; attachmentIds?: string[] },
    signal?: AbortSignal,
  ): Promise<StageRunDetail> {
    const body = await this.request<{ run: StageRunDetail }>(
      `/api/projects/${encodeURIComponent(projectId)}/stages/${encodeURIComponent(stage)}/runs`,
      json('POST', input, signal),
    )
    return body.run
  }

  /** Stage input PDFs of a project, newest first. */
  async listAttachments(projectId: string, stage: StageKey, signal?: AbortSignal): Promise<StageAttachment[]> {
    const body = await this.request<{ attachments?: unknown }>(
      `/api/projects/${encodeURIComponent(projectId)}/attachments?stage=${encodeURIComponent(stage)}`,
      { method: 'GET', signal },
    )
    return (Array.isArray(body.attachments) ? body.attachments : [])
      .map(normalizeAttachment)
      .filter((entry): entry is StageAttachment => entry !== null)
  }

  /** Upload every file in ONE multipart request (field `files`); the API rejects the whole request if any file breaks a limit. */
  async uploadAttachments(projectId: string, files: readonly File[], stage: StageKey, signal?: AbortSignal): Promise<StageAttachment[]> {
    const form = new FormData()
    for (const file of files) form.append('files', file, file.name)
    form.append('stage', stage)
    const body = await this.request<{ attachments?: unknown }>(
      `/api/projects/${encodeURIComponent(projectId)}/attachments`,
      { method: 'POST', body: form, ...(signal === undefined ? {} : { signal }) },
    )
    return (Array.isArray(body.attachments) ? body.attachments : [])
      .map(normalizeAttachment)
      .filter((entry): entry is StageAttachment => entry !== null)
  }

  async deleteAttachment(projectId: string, attachmentId: string, signal?: AbortSignal): Promise<void> {
    await this.request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: 'DELETE', signal },
    )
  }

  /** The original uploaded PDF (bearer auth, so not a plain link). */
  async getAttachmentContent(projectId: string, attachmentId: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.fetch(
      `/api/projects/${encodeURIComponent(projectId)}/attachments/${encodeURIComponent(attachmentId)}/content`,
      { method: 'GET', headers: { Accept: 'application/pdf', ...this.authHeaders() }, ...(signal === undefined ? {} : { signal }) },
    )
    if (!response.ok) throw await this.errorFromResponse(response)
    return response.blob()
  }

  /**
   * The deliverable PDF of a document: `GET /api/projects/:id/documents/:documentId/export`.
   * Serves the PDF in `documents/<stage>/` and writes it first when it is missing.
   */
  async getExportedPdf(projectId: string, documentId: string, signal?: AbortSignal): Promise<{ blob: Blob; filename: string | null }> {
    const response = await this.fetch(
      `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/export`,
      { method: 'GET', headers: { Accept: 'application/pdf', ...this.authHeaders() }, ...(signal === undefined ? {} : { signal }) },
    )
    if (!response.ok) throw await this.errorFromResponse(response)
    const disposition = response.headers.get('Content-Disposition') ?? ''
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
    const plain = /filename="?([^";]+)"?/i.exec(disposition)
    let filename: string | null = null
    try { filename = star?.[1] !== undefined ? decodeURIComponent(star[1]) : (plain?.[1] ?? null) } catch { filename = plain?.[1] ?? null }
    return { blob: await response.blob(), filename }
  }

  async getStageRun(runId: string, signal?: AbortSignal): Promise<StageRunDetail> {
    const body = await this.request<{ run: StageRunDetail }>(
      `/api/stage-runs/${encodeURIComponent(runId)}`,
      { method: 'GET', signal },
    )
    return body.run
  }

  async listStageReviews(runId: string, signal?: AbortSignal): Promise<StageReview[]> {
    const body = await this.request<{ reviews: StageReview[] }>(
      `/api/stage-runs/${encodeURIComponent(runId)}/reviews`,
      { method: 'GET', signal },
    )
    return Array.isArray(body.reviews) ? body.reviews : []
  }

  /** Start background execution (202). Never uses `?wait=1`: poll `getStageRun` instead. */
  async executeStageRun(runId: string, signal?: AbortSignal): Promise<StageRunDetail> {
    const body = await this.request<{ run: StageRunDetail }>(
      `/api/stage-runs/${encodeURIComponent(runId)}/execute`,
      { method: 'POST', signal },
    )
    return body.run
  }

  /** Re-render the stage PDF (`POST /export`). Resolves to the path relative to the project root and its size. */
  async exportStageRun(runId: string, signal?: AbortSignal): Promise<{ path: string; bytes: number | null }> {
    const body = await this.request<{ export?: { path?: unknown; bytes?: unknown } }>(
      `/api/stage-runs/${encodeURIComponent(runId)}/export`,
      { method: 'POST', signal },
    )
    return {
      path: typeof body.export?.path === 'string' ? body.export.path : '',
      bytes: typeof body.export?.bytes === 'number' ? body.export.bytes : null,
    }
  }

  async getStageDefaults(signal?: AbortSignal): Promise<ResolvedStageSettings> {
    const body = await this.request<{ stageDefaults?: unknown }>('/api/settings/stage-defaults', { method: 'GET', signal })
    return { ...normalizeStageSettings(body.stageDefaults), source: null }
  }

  async updateStageDefaults(settings: Partial<PlanningStageSettings>, signal?: AbortSignal): Promise<ResolvedStageSettings> {
    const body = await this.request<{ stageDefaults?: unknown }>('/api/settings/stage-defaults', json('PATCH', settings, signal))
    return { ...normalizeStageSettings(body.stageDefaults), source: null }
  }

  async getFactoryStageSettings(stage: StageKey, signal?: AbortSignal): Promise<ResolvedStageSettings> {
    if (stage === 'planning') return this.getStageDefaults(signal)
    const body = await this.request<{ settings?: unknown }>(`/api/settings/stages/${stage}`, { method: 'GET', signal })
    return { ...normalizeStageSettings(body.settings), source: null }
  }

  async updateFactoryStageSettings(stage: StageKey, settings: Partial<PlanningStageSettings>, signal?: AbortSignal): Promise<ResolvedStageSettings> {
    if (stage === 'planning') return this.updateStageDefaults(settings, signal)
    const body = await this.request<{ settings?: unknown }>(`/api/settings/stages/${stage}`, json('PATCH', settings, signal))
    return { ...normalizeStageSettings(body.settings), source: null }
  }

  async getProjectStageSettings(projectId: string, stage: StageKey, signal?: AbortSignal): Promise<ResolvedStageSettings> {
    const body = await this.request<{ settings?: unknown; source?: unknown }>(`/api/projects/${encodeURIComponent(projectId)}/stages/${stage}/settings`, { method: 'GET', signal })
    return normalizeProjectStageSettings(body)
  }

  async updateProjectStageSettings(projectId: string, stage: StageKey, settings: Partial<PlanningStageSettings>, signal?: AbortSignal): Promise<ResolvedStageSettings> {
    const body = await this.request<{ settings?: unknown; source?: unknown }>(`/api/projects/${encodeURIComponent(projectId)}/stages/${stage}/settings`, json('PATCH', settings, signal))
    return normalizeProjectStageSettings(body)
  }

  /** Clear the project override (falls back to the Factory or built-in default). */
  async resetProjectStageSettings(projectId: string, stage: StageKey, signal?: AbortSignal): Promise<ResolvedStageSettings> {
    const body = await this.request<{ settings?: unknown; source?: unknown }>(`/api/projects/${encodeURIComponent(projectId)}/stages/${stage}/settings`, { method: 'DELETE', signal })
    return normalizeProjectStageSettings(body)
  }

  getPlanningSettings(projectId: string, signal?: AbortSignal): Promise<ResolvedStageSettings> {
    return this.getProjectStageSettings(projectId, 'planning', signal)
  }

  updatePlanningSettings(projectId: string, settings: PlanningStageSettings, signal?: AbortSignal): Promise<ResolvedStageSettings> {
    return this.updateProjectStageSettings(projectId, 'planning', settings, signal)
  }

  resetPlanningSettings(projectId: string, signal?: AbortSignal): Promise<ResolvedStageSettings> {
    return this.resetProjectStageSettings(projectId, 'planning', signal)
  }

  async decideStageRun(
    runId: string,
    input: StageDecisionInput,
    signal?: AbortSignal,
  ): Promise<StageRunDetail> {
    const body = await this.request<{ run: StageRunDetail }>(
      `/api/stage-runs/${encodeURIComponent(runId)}/decision`,
      json('POST', input, signal),
    )
    return body.run
  }

  /** One page of persisted run events with id > `after` (numeric order). */
  async listStageRunEvents(
    runId: string,
    options: { after?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<StageRunEventPage> {
    const query = new URLSearchParams()
    query.set('after', options.after ?? '0')
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    const body = await this.request<Partial<StageRunEventPage>>(
      `/api/stage-runs/${encodeURIComponent(runId)}/events?${query.toString()}`,
      { method: 'GET', signal },
    )
    const events = (Array.isArray(body.events) ? body.events : [])
      .map(normalizeStageRunEvent)
      .filter((event): event is StageRunEvent => event !== null)
    return { events, nextAfter: typeof body.nextAfter === 'string' ? body.nextAfter : events.at(-1)?.id ?? options.after ?? '0' }
  }

  /** Current telemetry folded from the run's stored events; null when the payload is unusable. */
  async getStageRunTelemetry(runId: string, signal?: AbortSignal): Promise<RunTelemetry | null> {
    const body = await this.request<{ telemetry?: unknown }>(
      `/api/stage-runs/${encodeURIComponent(runId)}/telemetry`,
      { method: 'GET', signal },
    )
    return normalizeTelemetry(body.telemetry)
  }

  /** The model new runs use (`target` is null when unconfigured). */
  async getModelTarget(signal?: AbortSignal): Promise<ModelTarget | null> {
    const body = await this.request<{ target?: unknown }>('/api/settings/models', { method: 'GET', signal })
    const target = typeof body.target === 'object' && body.target !== null ? body.target as Record<string, unknown> : null
    return target !== null && typeof target.provider === 'string' && typeof target.model === 'string'
      ? { provider: target.provider, model: target.model }
      : null
  }

  async listModels(signal?: AbortSignal): Promise<ModelCatalogEntry[]> {
    const body = await this.request<{ models?: unknown }>('/api/models', { method: 'GET', signal })
    return (Array.isArray(body.models) ? body.models : []).flatMap((entry): ModelCatalogEntry[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const item = entry as Record<string, unknown>
      if (typeof item.provider !== 'string' || typeof item.model !== 'string') return []
      return [{
        provider: item.provider,
        model: item.model,
        displayName: typeof item.displayName === 'string' ? item.displayName : null,
        contextWindow: typeof item.contextWindow === 'number' && item.contextWindow > 0 ? item.contextWindow : null,
      }]
    })
  }

  /** Token usage and cost of one project over the last `days`. */
  async getProjectUsage(projectId: string, days: number, signal?: AbortSignal): Promise<ProjectUsage> {
    const body = await this.request<{ stats?: unknown }>(
      `/api/projects/${encodeURIComponent(projectId)}/stats?days=${encodeURIComponent(String(days))}`,
      { method: 'GET', signal },
    )
    return normalizeProjectUsage(body.stats)
  }

  /** Phoenix trace summary for one project over the last `hours` (1–168). */
  async getObservability(projectId: string, hours: number, signal?: AbortSignal): Promise<ObservabilitySummary> {
    const body = await this.request<{ observability?: unknown }>(
      `/api/projects/${encodeURIComponent(projectId)}/observability?hours=${encodeURIComponent(String(hours))}`,
      { method: 'GET', signal },
    )
    return normalizeObservability(body.observability, hours)
  }

  /**
   * One page of project logs, newest first. Always scoped to `projectId` by the
   * URL; entries that claim another project are dropped (defense in depth).
   */
  async listProjectLogs(projectId: string, query: ProjectLogQuery = {}, signal?: AbortSignal): Promise<ProjectLogPage> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : ''
    const body = await this.request<{ logs?: unknown; nextBefore?: unknown }>(
      `/api/projects/${encodeURIComponent(projectId)}/logs${suffix}`,
      { method: 'GET', signal },
    )
    const logs = (Array.isArray(body.logs) ? body.logs : [])
      .map(normalizeProjectLog)
      .filter((log): log is ProjectLog => log !== null && (log.projectId === '' || log.projectId === projectId))
    return { logs, nextBefore: typeof body.nextBefore === 'string' && body.nextBefore !== '' ? body.nextBefore : null }
  }

  /**
   * Read the run's SSE event stream (replay after `after`, then live tail).
   * Uses fetch so the bearer token goes in the header, never the URL.
   *
   * Resolves `'end'` on `event: end` (terminal run, nothing left) or `'closed'`
   * when the connection drops first. Rejects with `ApiError` for HTTP errors
   * and `event: error` (`STREAM_ERROR`); an abort rejects with `AbortError`.
   */
  async streamStageRunEvents(
    runId: string,
    options: {
      after?: string
      signal: AbortSignal
      onEvent: (event: StageRunEvent) => void
      onOpen?: () => void
      onMalformed?: () => void
      /** `event: telemetry`: the payload replaces (never adds to) the last snapshot. */
      onTelemetry?: (telemetry: RunTelemetry) => void
    },
  ): Promise<'end' | 'closed'> {
    const query = new URLSearchParams({ after: options.after ?? '0' })
    const response = await this.fetch(`/api/stage-runs/${encodeURIComponent(runId)}/events/stream?${query.toString()}`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...this.authHeaders() },
      signal: options.signal,
    })
    if (!response.ok) throw await this.errorFromResponse(response)
    if (response.body === null) throw new ApiError(502, 'STREAM_UNAVAILABLE', 'The API returned an empty response body.')
    options.onOpen?.()

    const parser = new SseParser()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const handle = (frames: SseFrame[]): 'end' | null => {
      for (const frame of frames) {
        if (frame.event === 'end') return 'end'
        if (frame.event === 'error') {
          let message = 'The live detail stream failed.'
          try {
            const data = JSON.parse(frame.data) as { message?: unknown }
            if (typeof data.message === 'string' && data.message !== '') message = data.message
          } catch {
            // keep the default message
          }
          throw new ApiError(502, 'STREAM_ERROR', message)
        }
        if (frame.event === 'telemetry') {
          try {
            const telemetry = normalizeTelemetry(JSON.parse(frame.data))
            if (telemetry !== null) options.onTelemetry?.(telemetry)
          } catch {
            // a bad snapshot is skipped; the next one replaces it anyway
          }
          continue
        }
        if (frame.event !== 'stage') continue
        const event = parseStageRunEvent(frame.data)
        if (event === null) options.onMalformed?.()
        else options.onEvent(event)
      }
      return null
    }
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (handle(parser.push(decoder.decode(value, { stream: true }))) === 'end') return 'end'
      }
      return handle(parser.flush()) ?? 'closed'
    } catch (error) {
      if (isAbortError(error) || error instanceof ApiError) throw error
      return 'closed'
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  /**
   * Fetch a stored document body with the bearer token (a plain `<a href>`
   * can't send it). Callers turn the Blob into an object URL and revoke it.
   */
  async getDocumentContent(
    document: Pick<ProjectDocument, 'projectId' | 'id'>,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const response = await this.fetch(
      `/api/projects/${encodeURIComponent(document.projectId)}/documents/${encodeURIComponent(document.id)}/content`,
      { method: 'GET', headers: { Accept: '*/*', ...this.authHeaders() }, ...(signal === undefined ? {} : { signal }) },
    )
    if (!response.ok) throw await this.errorFromResponse(response)
    return response.blob()
  }

  /**
   * Send one turn and dispatch SSE events until `done`.
   *
   * Rejects with `ApiError` for API-level failures. A user abort rejects with
   * the platform's `AbortError`, which callers should treat as a stop, not an
   * error.
   */
  async streamChat(input: StreamChatInput): Promise<void> {
    const body: Record<string, string> = { message: input.message }
    if (input.sessionId !== undefined) body.sessionId = input.sessionId
    if (input.projectId !== undefined) body.projectId = input.projectId

    const response = await this.fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })

    if (!response.ok) throw await this.errorFromResponse(response)
    if (response.body === null) {
      throw new ApiError(502, 'STREAM_UNAVAILABLE', 'The API returned an empty response body.')
    }

    const parser = new SseParser()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let completed = false
    let streamError: ApiError | undefined

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const frames = parser.push(decoder.decode(value, { stream: true }))
        for (const frame of frames) {
          const event = parseEvent(frame.event, frame.data)
          if (event === null) continue
          if (event.event === 'error') {
            streamError = new ApiError(event.data.status, event.data.code, event.data.message)
            continue
          }
          if (event.event === 'done') completed = true
          input.onEvent(event)
        }
      }
      for (const frame of parser.flush()) {
        const event = parseEvent(frame.event, frame.data)
        if (event === null) continue
        if (event.event === 'error') {
          streamError = new ApiError(event.data.status, event.data.code, event.data.message)
        } else {
          if (event.event === 'done') completed = true
          input.onEvent(event)
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new ApiError(502, 'STREAM_FAILED', errorMessage(error))
    } finally {
      reader.releaseLock()
    }

    if (streamError !== undefined) throw streamError
    if (!completed) {
      throw new ApiError(
        502,
        'STREAM_INCOMPLETE',
        'The connection ended before the response finished. Try sending the message again.',
      )
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    authenticated = true,
  ): Promise<T> {
    const response = await this.fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(authenticated ? this.authHeaders() : {}),
        ...init.headers,
      },
    })
    if (!response.ok) throw await this.errorFromResponse(response)
    if (response.status === 204) return undefined as T
    try {
      return (await response.json()) as T
    } catch {
      throw new ApiError(
        response.status,
        'INVALID_RESPONSE',
        'The API returned a response that was not valid JSON.',
      )
    }
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(this.url(path), init)
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new ApiError(
        0,
        'NETWORK',
        `Could not reach the Chat API at ${this.baseUrl}. Is the server running?`,
      )
    }
  }

  private authHeaders(): Record<string, string> {
    return this.token === '' ? {} : { Authorization: `Bearer ${this.token}` }
  }

  private async errorFromResponse(response: Response): Promise<ApiError> {
    let body: ApiErrorBody | null = null
    try {
      body = (await response.json()) as ApiErrorBody
    } catch {
      body = null
    }
    const message = body?.error?.message
      ?? (response.status === 401
        ? 'The API requires a bearer token. Add one in Settings.'
        : `The API returned HTTP ${response.status}.`)
    const code = body?.error?.code ?? `HTTP_${response.status}`
    return new ApiError(response.status, code, message)
  }
}

function parseEvent(event: string, raw: string): ChatStreamEvent | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object') return null
  const record = data as Record<string, unknown>

  switch (event) {
    case 'session':
      return typeof record.sessionId === 'string'
        ? {
            event: 'session',
            data: {
              sessionId: record.sessionId,
              ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
            },
          }
        : null
    case 'status':
      return typeof record.phase === 'string'
        ? {
            event: 'status',
            data: {
              phase: record.phase,
              ...(typeof record.turn === 'number' ? { turn: record.turn } : {}),
              ...(typeof record.step === 'number' ? { step: record.step } : {}),
            },
          }
        : null
    case 'telemetry': {
      const telemetry = normalizeTelemetry(record)
      return telemetry === null ? null : { event: 'telemetry', data: telemetry }
    }
    case 'text':
      return typeof record.text === 'string'
        ? { event: 'text', data: { text: record.text } }
        : null
    case 'thinking':
      return typeof record.text === 'string'
        ? { event: 'thinking', data: { text: record.text } }
        : null
    case 'tool_call':
      return {
        event: 'tool_call',
        data: {
          ...(typeof record.name === 'string' ? { name: record.name } : {}),
          ...(typeof record.callId === 'string' ? { callId: record.callId } : {}),
        },
      }
    case 'tool_result':
      return {
        event: 'tool_result',
        data: {
          ...(typeof record.name === 'string' ? { name: record.name } : {}),
          ...(typeof record.status === 'string' ? { status: record.status } : {}),
          ...(typeof record.error === 'string' ? { error: record.error } : {}),
        },
      }
    case 'final':
      return typeof record.sessionId === 'string' && typeof record.text === 'string'
        ? {
            event: 'final',
            data: {
              sessionId: record.sessionId,
              text: record.text,
              reason: typeof record.reason === 'object' && record.reason !== null
                ? (record.reason as { kind: string; error?: unknown })
                : { kind: 'completed' },
            },
          }
        : null
    case 'done':
      return typeof record.sessionId === 'string' && typeof record.text === 'string'
        ? {
            event: 'done',
            data: {
              sessionId: record.sessionId,
              text: record.text,
              durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
            },
          }
        : null
    case 'error':
      return typeof record.message === 'string'
        ? {
            event: 'error',
            data: {
              message: record.message,
              code: typeof record.code === 'string' ? record.code : 'STREAM_ERROR',
              status: typeof record.status === 'number' ? record.status : 502,
            },
          }
        : null
    default:
      return null
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}

function normalizeProjectStageSettings(body: { settings?: unknown; source?: unknown }): ResolvedStageSettings {
  const settings = normalizeStageSettings(body.settings)
  if (body.source === 'project' || body.source === 'factory' || body.source === 'defaults') {
    return { ...settings, source: body.source }
  }
  return settings
}

function json(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Parse one `event: stage` payload; null when it isn't a usable event. */
export function parseStageRunEvent(data: string): StageRunEvent | null {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }
  return normalizeStageRunEvent(value)
}

/** Validate one event object from the API; null when it isn't usable. */
export function normalizeStageRunEvent(value: unknown): StageRunEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'number' ? String(record.id) : record.id
  if (typeof id !== 'string' || !/^\d+$/.test(id) || typeof record.type !== 'string') return null
  const payload = typeof record.payload === 'object' && record.payload !== null && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : {}
  const text = (key: string): string | null => (typeof record[key] === 'string' ? record[key] as string : null)
  return {
    id,
    projectId: text('projectId') ?? '',
    stageRunId: text('stageRunId') ?? '',
    role: text('role'),
    agentId: text('agentId'),
    type: record.type,
    phase: text('phase'),
    payload,
    createdAt: text('createdAt') ?? '',
  }
}

const LOG_LEVEL_SET: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error'])

/** Validate one log entry from the API; null when it isn't usable. */
export function normalizeProjectLog(value: unknown): ProjectLog | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'number' ? String(record.id) : record.id
  if (typeof id !== 'string' || !/^\d+$/.test(id) || typeof record.type !== 'string') return null
  const text = (key: string): string | null => (typeof record[key] === 'string' ? record[key] as string : null)
  const payload = typeof record.payload === 'object' && record.payload !== null && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : {}
  const level = text('level')
  return {
    id,
    projectId: text('projectId') ?? '',
    stageRunId: text('stageRunId') ?? '',
    stage: text('stage') ?? '',
    attempt: typeof record.attempt === 'number' ? record.attempt : 0,
    role: text('role'),
    agentId: text('agentId'),
    type: record.type,
    phase: text('phase'),
    level: level !== null && LOG_LEVEL_SET.has(level) ? level as LogLevel : 'info',
    message: text('message') ?? record.type,
    preview: text('preview'),
    payload,
    createdAt: text('createdAt') ?? '',
  }
}

/** Coerce the Phoenix summary: every field may be missing or the wrong type. */
export function normalizeObservability(value: unknown, hours: number): ObservabilitySummary {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const count = (key: string): number => {
    const raw = record[key]
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0
  }
  const latency = typeof record.latencyMs === 'object' && record.latencyMs !== null ? record.latencyMs as Record<string, unknown> : null
  const lat = (key: string): number => (typeof latency?.[key] === 'number' && Number.isFinite(latency[key] as number) ? latency[key] as number : 0)
  const roles = (Array.isArray(record.roles) ? record.roles : []).flatMap((entry): ObservabilitySummary['roles'] => {
    if (typeof entry !== 'object' || entry === null) return []
    const item = entry as Record<string, unknown>
    if (typeof item.role !== 'string') return []
    const n = (key: string): number => (typeof item[key] === 'number' && Number.isFinite(item[key] as number) ? item[key] as number : 0)
    return [{ role: item.role, spans: n('spans'), errors: n('errors'), durationMs: n('durationMs'), tokens: n('tokens') }]
  })
  return {
    available: record.available === true,
    reason: typeof record.reason === 'string' ? record.reason : null,
    projectName: typeof record.projectName === 'string' ? record.projectName : '',
    windowHours: count('windowHours') || hours,
    traces: count('traces'),
    spans: count('spans'),
    errors: count('errors'),
    tools: count('tools'),
    tokens: count('tokens'),
    latencyMs: latency === null ? null : { count: lat('count'), avg: lat('avg'), p50: lat('p50'), p95: lat('p95'), max: lat('max') },
    roles,
    lastSpanAt: typeof record.lastSpanAt === 'string' ? record.lastSpanAt : null,
    truncated: record.truncated === true,
  }
}

export function normalizeProjectUsage(value: unknown): ProjectUsage {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const tokens = typeof record.tokens === 'object' && record.tokens !== null ? record.tokens as Record<string, unknown> : {}
  const n = (key: string): number => (typeof tokens[key] === 'number' && Number.isFinite(tokens[key] as number) && (tokens[key] as number) >= 0 ? tokens[key] as number : 0)
  const cost = typeof record.cost === 'object' && record.cost !== null ? record.cost as Record<string, unknown> : {}
  return {
    tokens: { input: n('input'), output: n('output'), total: n('total'), cacheRead: n('cacheRead'), cacheWrite: n('cacheWrite') },
    costUsd: typeof cost.usd === 'number' && Number.isFinite(cost.usd) ? cost.usd : null,
    costPartial: typeof cost.unpricedTokens === 'number' && cost.unpricedTokens > 0,
  }
}
