/** Wire types for the AI Factory Chat API (`apps/chat-cli`, port 8787). */

export interface HarnessInfo {
  command: string
  profile: string
}

export interface HealthResponse {
  ok: boolean
  version: string
  uptimeSeconds: number
  harness: HarnessInfo | null
  /** `postgres` when the project registry is configured, absent on older APIs. */
  database?: 'postgres' | 'disabled'
}

export type ProjectStatus = 'active' | 'inactive' | 'archived'

/** Wire shape of `GET /api/projects` entries. */
export interface ApiProject {
  id: string
  name: string
  rootPath: string
  organization: string | null
  ownerEmail: string | null
  status: ProjectStatus
  /** SDLC stage key (stage-runtime APIs only). */
  currentStage?: StageKey
  stageUpdatedAt?: string
  createdAt: string
  updatedAt: string
}

export interface ApiProjectInput {
  name: string
  rootPath: string
  organization?: string | null
  ownerEmail?: string | null
  status?: ProjectStatus
}

export type ApiProjectPatch = Partial<ApiProjectInput>

export interface SessionSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  /** Registry project the session is bound to (newer APIs only). */
  projectId?: string
}

export type ChatRole = 'user' | 'assistant'

export interface ChatRecord {
  role: ChatRole
  content: string
  at: string
}

export interface SessionDetail extends SessionSummary {
  messages: ChatRecord[]
}

/** `GET /api/fs/directories` — subdirectories on the API host. */
export interface DirectoryListing {
  path: string
  parent: string | null
  home: string
  entries: { name: string; path: string }[]
  truncated: boolean
}

/** `POST /api/projects/:projectId/sessions/:sessionId/pdf-review` response. */
export interface PdfReviewResult {
  project: ApiProject
  sessionId: string
  document: { filename: string; pages: number; characters: number; truncated: boolean }
  analysis: {
    type: 'review' | 'questions'
    decision: 'complete' | 'needs_revision' | 'questions_required'
    markdown: string
    questions: string[]
  }
  durationMs: number
}

export interface ApiErrorBody {
  error: {
    message: string
    code: string
    status: number
  }
}

/** Events emitted by `POST /api/chat/stream`. */
export type ChatStreamEvent =
  | { event: 'session'; data: { sessionId: string; cwd?: string } }
  | {
      event: 'status'
      data: { phase: string; turn?: number; step?: number }
    }
  | { event: 'telemetry'; data: RunTelemetry }
  | { event: 'text'; data: { text: string } }
  | { event: 'thinking'; data: { text: string } }
  | { event: 'tool_call'; data: { name?: string; callId?: string } }
  | {
      event: 'tool_result'
      data: { name?: string; status?: string; error?: string }
    }
  | {
      event: 'final'
      data: {
        sessionId: string
        text: string
        reason: { kind: string; error?: unknown }
      }
    }
  | {
      event: 'done'
      data: { sessionId: string; text: string; durationMs: number }
    }
  | {
      event: 'error'
      data: { message: string; code: string; status: number }
    }

/** Token counts of one telemetry window. Every field is null when absent. */
export interface TelemetryUsage {
  input: number | null
  output: number | null
  /** Includes cache reads and writes. */
  total: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

/**
 * Snapshot of everything the run status bar shows (`telemetry` SSE event and
 * `GET /api/stage-runs/:id/telemetry`). `null` = "cannot be computed", never 0.
 */
export interface RunTelemetry {
  turns: number | null
  steps: number | null
  phase: string | null
  usage: TelemetryUsage
  lastStep: (TelemetryUsage & { durationMs: number | null; tokensPerSecond: number | null }) | null
  tokensPerSecond: number | null
  averageTokensPerSecond: number | null
  cacheHitPercent: number | null
  contextUsedTokens: number | null
  contextWindow: number | null
  contextUsedPercent: number | null
  model: { provider: string; model: string } | null
  startedAt: string | null
  updatedAt: string | null
}

// ---------------------------------------------------------------------------
// SDLC stages and stage runs (`/api/sdlc/stages`, `/api/projects/:id`,
// `/api/stage-runs/*`). Source of truth: `/openapi.yaml`.

export type StageKey =
  | 'planning'
  | 'requirements'
  | 'design'
  | 'architecture'
  | 'development'
  | 'testing'
  | 'deployment'
  | 'maintenance'

export interface SdlcStage {
  key: string
  name: string
  position: number
  executable?: boolean
}

export type StageStatus = 'not_started' | 'in_progress' | 'completed' | 'blocked' | 'skipped'

export interface StageState {
  stage: StageKey
  status: StageStatus
  startedAt: string | null
  completedAt: string | null
  notes: string | null
}

export type ChecklistStatus = 'open' | 'done' | 'waived'

export interface ChecklistItem {
  id: string
  stage: StageKey
  key: string
  label: string
  required: boolean
  status: ChecklistStatus
  evidenceDocumentId: string | null
  completedAt: string | null
}

export type DocumentStatus = 'uploaded' | 'in_review' | 'approved' | 'rejected' | 'superseded'

export interface ProjectDocument {
  id: string
  projectId: string
  stage: StageKey
  kind: string
  title: string
  storagePath: string
  mimeType: string
  sizeBytes?: number
  sha256?: string
  /** Where the PDF deliverable was written (relative to the project root); set once the stage completes. */
  exportPath?: string | null
  status: DocumentStatus
  version: number
  createdAt: string
  updatedAt: string
}

export interface SdlcStatus {
  currentStage: StageKey
  stages: StageState[]
  checklist: ChecklistItem[]
}

/** `GET /api/projects/:id` */
export interface ProjectDetail {
  project: ApiProject
  sdlc?: SdlcStatus
  documents?: ProjectDocument[]
}

export type RunStatus =
  | 'pending'
  | 'analyzing'
  | 'drafting'
  | 'reviewing'
  | 'revising'
  | 'awaiting_human'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface StageRun {
  id: string
  projectId: string
  stage: StageKey
  attempt: number
  sessionId: string | null
  status: RunStatus
  contextHash: string | null
  context: Record<string, unknown> | null
  inputText: string | null
  /** Analyzer output, saved as soon as the analyzer finishes (older APIs omit it). */
  analysisMarkdown?: string | null
  /** Latest author draft (initial or revised), saved before each review. */
  draftMarkdown?: string | null
  /** The question a paused (`awaiting_human`) run waits on; null when not paused. */
  pendingGate?: PendingGate | null
  summaryMarkdown: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

/** A requester-supplied PDF attached to a stage run (`/api/projects/:id/attachments`). */
export interface StageAttachment {
  id: string
  projectId?: string
  stage?: StageKey
  title: string
  filename: string
  pages: number | null
  characters: number | null
  /** Text was cut at the per-document limit before analysis. */
  truncated: boolean
  sizeBytes: number | null
  createdAt: string | null
}

export type GateKind = 'final'

/** Coerced `pendingGate` (see `data/gates.ts`). The draft itself is `run.draftMarkdown`. */
export interface PendingGate {
  kind: GateKind
  question: string
  /** Revision cycles completed when the gate was raised. */
  cycle: number | null
  maxReviewCycles: number | null
  reviewDecision: string | null
  findings: Finding[]
  waitingSince: string | null
  /** Why the run stopped revising; null from older APIs. */
  outcome: GateOutcome | null
  /** Deterministic Requirements checks, distinct from the model's review. */
  coverage: RequirementsCoverageReport | null
}

export interface RequirementsCoverageFinding {
  code: string
  requirementId?: string
  message: string
  severity: 'blocking' | 'advisory'
}

export interface RequirementsCoverageReport {
  counts: {
    totalRequirements: number
    withAcceptanceCriteria: number
    withSource: number
    withGoal: number
    /** MoSCoW tally of functional requirements (FR-210); absent from older APIs. */
    priorities?: { must: number; should: number; could: number; wont: number }
    /** Declared `BR-###` business rules (FR-206); absent from older APIs. */
    businessRules?: number
  }
  findings: RequirementsCoverageFinding[]
}

export interface GateOutcome {
  accepted: boolean
  rating: number | null
  counts: { blockers: number; major: number; minor: number } | null
  criteria: { minRating: number; maxBlockers: number; maxMajor: number } | null
}

/** Planning-stage review settings (project override or Factory default). */
export interface PlanningStageSettings {
  maxReviewCycles: number
  /** Minimum overall rating (0–100) to stop revising early. */
  minRating: number
  /** Blockers / major findings tolerated before the run keeps revising. */
  maxBlockers: number
  maxMajor: number
}

export interface ResolvedStageSettings extends PlanningStageSettings {
  source: 'project' | 'factory' | 'defaults' | null
}

export type FindingSeverity = 'blocker' | 'major' | 'minor'

/** Reviewer output: data, never instructions. Fields may be missing. */
export interface Finding {
  id?: string
  severity?: FindingSeverity | string
  section?: string
  finding?: string
  required_change?: string
  [extra: string]: unknown
}

export type ReviewDecision = 'approved' | 'needs_revision' | 'rejected'

export interface StageReview {
  id: string
  stageRunId: string
  reviewerRole: string
  decision: ReviewDecision
  findings: Finding[]
  createdAt: string
}

export interface StageRunDetail extends StageRun {
  reviews: StageReview[]
  documents: ProjectDocument[]
}

export type HumanDecision = 'go' | 'conditional_go' | 'no_go'

export type RequirementsDecisionInput =
  | { decision: 'approved'; note?: string; coverageWaiverReason?: string }
  | { decision: 'rejected'; note?: string }

export type StageDecisionInput = { decision: HumanDecision; note?: string } | RequirementsDecisionInput | { refine: true }

// ---------------------------------------------------------------------------
// Stage-run activity events (GET /api/stage-runs/:id/events[/stream])

/**
 * One persisted event. `id` is a numeric database id serialized as a string;
 * order by its numeric value. `payload` depends on `type` and is untrusted
 * model/tool output: render as text, never as HTML.
 */
export interface StageRunEvent {
  id: string
  projectId: string
  stageRunId: string
  /** analyzer | author | reviewer; null for run-level events. */
  role: string | null
  agentId: string | null
  type: string
  phase: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface StageRunEventPage {
  events: StageRunEvent[]
  nextAfter: string
}

// ---------------------------------------------------------------------------
// Project logs (`GET /api/projects/:id/logs`): a newest-first, project-scoped
// view over stage_run_events. `payload` and `preview` are untrusted output.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug']

export interface ProjectLog {
  /** Numeric event id serialized as a string; order by numeric value. */
  id: string
  projectId: string
  stageRunId: string
  stage: string
  attempt: number
  role: string | null
  agentId: string | null
  type: string
  phase: string | null
  level: LogLevel
  message: string
  preview: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface ProjectLogQuery {
  /** 1–500. */
  limit?: number
  /** Event id cursor: only older events. */
  before?: string
  level?: LogLevel
  type?: string
  role?: string
  runId?: string
  stage?: string
  q?: string
}

export interface ProjectLogPage {
  logs: ProjectLog[]
  /** Pass as `before` for the next older page; null when exhausted. */
  nextBefore: string | null
}

// ---------------------------------------------------------------------------
// Phoenix observability summary (`GET /api/projects/:id/observability?hours=`).
// Optional integration: 503 PHOENIX_DISABLED when off, 200 `available:false`
// (with `reason`) when Phoenix is unreachable. Every metric may be missing.

export interface ObservabilityRole {
  role: string
  spans: number
  errors: number
  durationMs: number
  tokens: number
}

export interface ObservabilityLatency {
  count: number
  avg: number
  p50: number
  p95: number
  max: number
}

export interface ObservabilitySummary {
  available: boolean
  reason: string | null
  projectName: string
  windowHours: number
  traces: number
  spans: number
  errors: number
  tools: number
  tokens: number
  latencyMs: ObservabilityLatency | null
  roles: ObservabilityRole[]
  lastSpanAt: string | null
  /** The span sample was capped; totals may be low. */
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Status bar data: model target (`GET /api/settings/models`), catalogue
// (`GET /api/models`) and project usage (`GET /api/projects/:id/stats`).
// Only the fields the UI uses; every one may be missing on older APIs.

export interface ModelTarget {
  provider: string
  model: string
}

export interface ModelCatalogEntry {
  provider: string
  model: string
  displayName: string | null
  contextWindow: number | null
}

export interface TokenTotals {
  input: number
  output: number
  total: number
  cacheRead: number
  cacheWrite: number
}

export interface ProjectUsage {
  tokens: TokenTotals
  /** null = nothing priced. */
  costUsd: number | null
  /** Some usage had no price, so `costUsd` is partial. */
  costPartial: boolean
}
