/**
 * What the HTTP layer is given to serve requests.
 *
 * Lives apart from the server so route modules can type their handlers without
 * importing the server that registers them (which would be a cycle).
 */

import type { DshHarness } from './harness.ts'
import type { SessionStore } from './store.ts'
import type { ProjectService, ProjectStatus } from './projects.ts'
import type { SettingsService } from './settings.ts'
import type { StageSettingsService } from './stage-settings.ts'
import type { StagePrerequisiteService } from './stage-prerequisites.ts'
import type { AgentService, AgentRecord } from './agents.ts'
import type { PdfReviewService } from './pdf-review.ts'
import type { PostgresProjectWorkspace } from './workspace.ts'
import type { ProjectBriefingService } from './briefing.ts'
import type { PlanningStageRuntime, StageEngine } from './stage-runtime.ts'
import type { SemanticIndexService } from './semantic-index.ts'
import type { ObservabilityReader, TraceRecorder } from './observability/index.ts'
import type { Logger, LoggingManager, PostgresLogStore } from './logging/index.ts'
import type { ModelService } from './models/index.ts'

export interface ChatApiOptions {
  /** Builds a harness; `cwd` is the project root when a chat is scoped to a project. */
  harnessFactory: (cwd?: string) => DshHarness
  store: SessionStore
  version: string
  /** When set, every /api route except /api/health requires this bearer token. */
  apiToken?: string
  /** Separate admin credential; when set, `apiToken` is an operator token only. */
  adminToken?: string
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
  /** Stage prerequisite catalogue and readiness. */
  prerequisites?: StagePrerequisiteService
  /** Named agents and their stage-process assignments. */
  agents?: AgentService
  /** Live pool statistics for diagnostics (connections in use). */
  poolSnapshot?: () => unknown
  /** Applied migration version, so a stale schema is visible. */
  schemaVersion?: { version: string | null; applied: number }
  /** Boots a harness with an agent's composition; set when a model target exists. */
  probeAgent?: (agent: AgentRecord, options?: { mode?: 'offline' | 'online' }) => Promise<unknown>
  /** PDF requirement review. When omitted, the PDF route returns 503. */
  pdfReview?: PdfReviewService
  /** SDLC stage, documents and checklist storage. */
  workspace?: PostgresProjectWorkspace
  /** Cached AI project briefing. */
  briefing?: ProjectBriefingService
  /** Stage coordinator runtime. When omitted, stage-run routes return 503. */
  stageRuntime?: PlanningStageRuntime
  /**
   * Query an engine per stage (AR-15).
   *
   * `stageRuntime` remains the planning engine; this adds the others. Run routes
   * resolve by the run's own stage, so one API serves every executable stage.
   */
  stageEngines?: {
    for(stage: string): StageEngine | undefined
    forRun(runId: string): Promise<StageEngine | undefined>
  }
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
