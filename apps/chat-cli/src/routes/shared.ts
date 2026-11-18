/**
 * Helpers shared by several route modules.
 *
 * These are the "resolve the optional service or fail clearly" wrappers, plus the
 * two projections (project view, telemetry seed) that more than one resource
 * returns.
 */

import type { ChatApiOptions } from '../api-options.ts'
import { HttpError } from '../http.ts'
import type { LoggingManager, PostgresLogStore } from '../logging/index.ts'
import type { PostgresProjectWorkspace } from '../workspace.ts'
import type { AppLog } from '../logging/index.ts'
import type { ModelRuntimeLike } from '../api-options.ts'
import type { TelemetryModel } from '../telemetry.ts'

/** One log row from either source, as the logs API returns it. */
export interface UnifiedLog {
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

export function requireLoggingManager(options: ChatApiOptions): LoggingManager {
  if (options.loggingManager === undefined) {
    throw new HttpError(503, 'logging control is disabled', 'LOGGING_NOT_CONFIGURED')
  }
  return options.loggingManager
}

export function requireLogStore(options: ChatApiOptions): PostgresLogStore {
  if (options.logStore === undefined) {
    throw new HttpError(503, 'application log storage needs DATABASE_URL', 'LOG_STORE_NOT_CONFIGURED')
  }
  return options.logStore
}

export async function projectView(projectId: string, options: ChatApiOptions): Promise<Record<string, unknown>> {
  const projects = options.projects!
  const project = await projects.get(projectId)
  if (options.workspace === undefined) return { project }
  const snapshot = await options.workspace.getSnapshot(projectId)
  const { documents, ...sdlc } = snapshot
  return { project, sdlc, documents }
}

export function requireWorkspace(options: ChatApiOptions): PostgresProjectWorkspace {
  if (options.workspace === undefined) {
    throw new HttpError(503, 'project workspace is disabled; set DATABASE_URL', 'WORKSPACE_NOT_CONFIGURED')
  }
  return options.workspace
}

export function appToUnified(log: AppLog): UnifiedLog {
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

/** Seed for a chat run: the model the harness will use, and its window. */
export function telemetrySeed(runtime?: ModelRuntimeLike): { model?: TelemetryModel; contextWindow?: number } {
  const status = runtime?.status()
  if (status === undefined) return {}
  const provider = typeof status.provider === 'string' ? status.provider : null
  const model = typeof status.model === 'string' ? status.model : null
  return {
    ...(provider !== null && model !== null ? { model: { provider, model } } : {}),
    ...(typeof status.contextWindow === 'number' && status.contextWindow > 0 ? { contextWindow: status.contextWindow } : {}),
  }
}
