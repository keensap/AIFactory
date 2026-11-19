/**
 * Stage workspace view logic: stage names, run status labels, the agent
 * pipeline, review summaries, the advance gate and polling cadence.
 *
 * Everything here is derived from what the API returns. Nothing is marked
 * done locally and no run status is set optimistically.
 */

import type {
  ChecklistItem,
  Finding,
  FindingSeverity,
  HumanDecision,
  ProjectDocument,
  RunStatus,
  SdlcStage,
  StageKey,
  StageReview,
  StageRun,
  StageRunDetail,
  StageStatus,
} from '../api/types.ts'

/** Used only when `GET /api/sdlc/stages` fails. */
export const FALLBACK_STAGES: readonly SdlcStage[] = [
  { key: 'planning', name: 'Planning & Feasibility', position: 0 },
  { key: 'requirements', name: 'Requirements', position: 1 },
  { key: 'design', name: 'Design', position: 2 },
  { key: 'architecture', name: 'Architecture', position: 3 },
  { key: 'development', name: 'Development', position: 4 },
  { key: 'testing', name: 'Testing', position: 5 },
  { key: 'deployment', name: 'Deployment', position: 6 },
  { key: 'maintenance', name: 'Maintenance', position: 7 },
]

export const TELOS_KIND = 'telos_report'
export const MAX_BRIEF_CHARS = 20_000

type StageCapability = SdlcStage & { executable?: boolean }

/** Older APIs don't advertise capabilities; only Planning can be assumed. */
export function isExecutableStage(stages: readonly StageCapability[], key: string): boolean {
  if (!stages.some((stage) => typeof stage.executable === 'boolean')) return key === 'planning'
  return stages.find((stage) => stage.key === key)?.executable === true
}

const ARTIFACTS = {
  planning: { kind: TELOS_KIND, title: 'TELOS feasibility report', shortName: 'TELOS' },
  requirements: { kind: 'requirements_spec', title: 'Requirements specification', shortName: 'requirements' },
} as const

function artifactForStage(stage: string) {
  if (stage === 'planning' || stage === 'requirements') return ARTIFACTS[stage]
  return undefined
}

export function stageArtifactKind(stage: string): string | undefined {
  return artifactForStage(stage)?.kind
}

export function stageArtifactTitle(stage: string): string {
  return artifactForStage(stage)?.title ?? 'Output document'
}

export function sortStages(stages: readonly SdlcStage[]): SdlcStage[] {
  const list = stages.length > 0 ? [...stages] : [...FALLBACK_STAGES]
  return list.sort((a, b) => a.position - b.position)
}

export function stageName(stages: readonly SdlcStage[], key: string): string {
  return stages.find((stage) => stage.key === key)?.name
    ?? FALLBACK_STAGES.find((stage) => stage.key === key)?.name
    ?? key
}

export function isStageKey(stages: readonly SdlcStage[], key: string): boolean {
  return stages.some((stage) => stage.key === key)
}

export function nextStageKey(stages: readonly SdlcStage[], key: string): StageKey | null {
  const sorted = sortStages(stages)
  const index = sorted.findIndex((stage) => stage.key === key)
  const next = index === -1 ? undefined : sorted[index + 1]
  return next === undefined ? null : (next.key as StageKey)
}

export const STAGE_STATUS_LABEL: Record<StageStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
  blocked: 'Blocked',
  skipped: 'Skipped',
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  pending: 'Queued',
  analyzing: 'Analyzing',
  drafting: 'Drafting TELOS',
  reviewing: 'Under review',
  revising: 'Revising',
  awaiting_human: 'Awaiting your decision',
  completed: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export function runStatusLabel(status: string, stage = 'planning'): string {
  if (status === 'drafting' && stage !== 'planning') {
    return `Drafting ${artifactForStage(stage)?.shortName ?? 'document'}`
  }
  return RUN_STATUS_LABEL[status as RunStatus] ?? status
}

const EXECUTING: ReadonlySet<string> = new Set(['analyzing', 'drafting', 'reviewing', 'revising'])
/** Polling stops on these. */
const SETTLED: ReadonlySet<string> = new Set(['awaiting_human', 'completed', 'failed', 'cancelled'])

/** The model loop is working on the run. */
export function isExecuting(status: string): boolean {
  return EXECUTING.has(status)
}

/** Worth polling: queued or executing. */
export function isPollable(status: string): boolean {
  return !SETTLED.has(status)
}

export function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

// ---------------------------------------------------------------------------
// Pipeline

export type PipelineStepKey = 'analyzer' | 'author' | 'reviewer'
export type PipelineStepState = 'waiting' | 'active' | 'done' | 'failed'

export interface PipelineStep {
  key: PipelineStepKey
  label: string
  state: PipelineStepState
}

function stepLabel(key: PipelineStepKey, stage: string): string {
  if (key === 'analyzer') return 'Analyzer'
  if (key === 'reviewer') return 'Reviewer'
  if (stage === 'planning') return 'TELOS author'
  if (stage === 'requirements') return 'Requirements author'
  return 'Author'
}
const STEP_ORDER: PipelineStepKey[] = ['analyzer', 'author', 'reviewer']

/** Step a status maps to, if any. */
export function stepForStatus(status: string): PipelineStepKey | null {
  switch (status) {
    case 'analyzing':
      return 'analyzer'
    case 'drafting':
    case 'revising':
      return 'author'
    case 'reviewing':
      return 'reviewer'
    default:
      return null
  }
}

/**
 * Step a failed run stopped at, best evidence first:
 * 1. the role named in the stored error (`STAGE_ROLE_FAILED`: "author failed: …");
 * 2. the last step this browser saw active;
 * 3. what was persisted: reviews → reviewer, a draft → reviewer, an analysis → author.
 * The cycle limit always ends at the reviewer.
 */
export function failedStep(
  run: Pick<StageRunDetail, 'status' | 'summaryMarkdown' | 'reviews' | 'analysisMarkdown' | 'draftMarkdown'>,
  lastSeenStep: PipelineStepKey | null = null,
): PipelineStepKey | null {
  if (isCycleLimit(run)) return 'reviewer'
  const role = failedRole(run)
  if (role !== null) return role.role
  if (lastSeenStep !== null) return lastSeenStep
  if (run.reviews.length > 0 || hasText(run.draftMarkdown)) return 'reviewer'
  if (hasText(run.analysisMarkdown)) return 'author'
  return null
}

/**
 * Three-step pipeline derived only from the run status. For a failed run the
 * failed step comes from `failedStep`.
 */
export function pipelineSteps(
  run: Pick<StageRunDetail, 'status' | 'summaryMarkdown' | 'reviews' | 'analysisMarkdown' | 'draftMarkdown'>,
  lastSeenStep: PipelineStepKey | null = null,
  stage = 'planning',
): PipelineStep[] {
  const build = (stateFor: (key: PipelineStepKey, index: number) => PipelineStepState): PipelineStep[] =>
    STEP_ORDER.map((key, index) => ({ key, label: stepLabel(key, stage), state: stateFor(key, index) }))

  if (run.status === 'awaiting_human' || run.status === 'completed') return build(() => 'done')

  if (run.status === 'failed' || run.status === 'cancelled') {
    const step = failedStep(run, lastSeenStep)
    if (step === null) return build(() => 'waiting')
    const failedIndex = STEP_ORDER.indexOf(step)
    return build((_key, index) => (index < failedIndex ? 'done' : index === failedIndex ? 'failed' : 'waiting'))
  }

  const active = stepForStatus(run.status)
  if (active === null) return build(() => 'waiting')
  const activeIndex = STEP_ORDER.indexOf(active)
  // While revising, the reviewer already ran once; show it as done behind the author.
  return build((key, index) => {
    if (index === activeIndex) return 'active'
    if (index < activeIndex) return 'done'
    return run.status === 'revising' && key === 'reviewer' ? 'done' : 'waiting'
  })
}

// ---------------------------------------------------------------------------
// Reviews

export type SeverityCounts = Record<FindingSeverity, number> & { other: number }

export function severityCounts(findings: readonly Finding[]): SeverityCounts {
  const counts: SeverityCounts = { blocker: 0, major: 0, minor: 0, other: 0 }
  for (const finding of findings) {
    const severity = typeof finding.severity === 'string' ? finding.severity.toLowerCase() : ''
    if (severity === 'blocker' || severity === 'major' || severity === 'minor') counts[severity] += 1
    else counts.other += 1
  }
  return counts
}

/** Number of revisions requested: one per `needs_revision` review. */
export function revisionCount(reviews: readonly StageReview[]): number {
  return reviews.filter((review) => review.decision === 'needs_revision').length
}

/** Reviews oldest first. */
export function sortReviews(reviews: readonly StageReview[]): StageReview[] {
  return [...reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Field as display text; reviewer output is untrusted and may be any shape. */
export function findingText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// Run outcome

/**
 * Failure reason the API stored in `summaryMarkdown` (`# … failed\n\n<message>`).
 * The execute call is backgrounded, so this is the only place the error shows up.
 */
export function failureMessage(run: Pick<StageRun, 'status' | 'summaryMarkdown'>): string | null {
  if (run.status !== 'failed') return null
  const summary = run.summaryMarkdown?.trim() ?? ''
  const body = summary.replace(/^#[^\n]*\n+/, '').trim()
  return body === '' ? null : body
}

/** The run failed because the reviewer never approved (`REVIEW_CYCLE_LIMIT`). */
export function isCycleLimit(run: Pick<StageRun, 'status' | 'summaryMarkdown'>): boolean {
  const message = failureMessage(run)
  return message !== null && /REVIEW_CYCLE_LIMIT|did not approve after \d+ revision cycles/i.test(message)
}

const ROLE_FAILED = /^(analyzer|author|reviewer) failed:\s*([\s\S]*)$/i

/**
 * Role named by a `STAGE_ROLE_FAILED` error ("author failed: <message>"), with
 * the message minus the prefix. Null for other failures.
 */
export function failedRole(run: Pick<StageRun, 'status' | 'summaryMarkdown'>, stage = 'planning'): { role: PipelineStepKey; label: string; message: string } | null {
  const message = failureMessage(run)
  const match = message === null ? null : ROLE_FAILED.exec(message)
  if (match === null) return null
  const role = match[1]!.toLowerCase() as PipelineStepKey
  return { role, label: stepLabel(role, stage), message: match[2]!.trim() || 'No details were given.' }
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Work saved before a run stopped, for read-only display. Empty when none. */
export function partialOutputs(run: Pick<StageRun, 'analysisMarkdown' | 'draftMarkdown'>, stage = 'planning'): { key: 'analysis' | 'draft'; title: string; markdown: string }[] {
  const out: { key: 'analysis' | 'draft'; title: string; markdown: string }[] = []
  if (hasText(run.analysisMarkdown)) out.push({ key: 'analysis', title: 'Analysis', markdown: run.analysisMarkdown })
  const shortName = artifactForStage(stage)?.shortName
  if (hasText(run.draftMarkdown)) out.push({ key: 'draft', title: shortName === undefined ? 'Latest draft' : `Latest ${shortName} draft`, markdown: run.draftMarkdown })
  return out
}

export const DECISION_LABEL: Record<HumanDecision, string> = {
  go: 'Go',
  conditional_go: 'Conditional go',
  no_go: 'No-go',
}

/** Human decision recorded in the summary (`Decision: **no-go**`). */
export function recordedDecision(run: Pick<StageRun, 'status' | 'summaryMarkdown'>): HumanDecision | null {
  if (run.status !== 'completed') return null
  const summary = run.summaryMarkdown ?? ''
  const section = summary.split(/^## Human decision\s*$/m)[1]
  if (section === undefined) return null
  const match = /Decision:\s*\**\s*(go|conditional[-_ ]go|no[-_ ]go)\b/i.exec(section)
  if (match === null) return null
  const value = match[1]!.toLowerCase().replace(/[- ]/g, '_')
  return value === 'go' || value === 'conditional_go' || value === 'no_go' ? value : null
}

/** Prefer the current output of the requested stage over a superseded version. */
export function stageArtifact(documents: readonly ProjectDocument[], stage: string): ProjectDocument | undefined {
  const kind = stageArtifactKind(stage)
  if (kind === undefined) return undefined
  const matches = (document: ProjectDocument): boolean => document.stage === stage && document.kind === kind
  return documents.find((document) => matches(document) && document.status !== 'superseded')
    ?? documents.find(matches)
}

/** The stage artifact kind first, then newest first. */
export function sortDocuments(documents: readonly ProjectDocument[], stage = 'planning'): ProjectDocument[] {
  const kind = stageArtifactKind(stage)
  const isPrimary = (document: ProjectDocument): boolean => document.stage === stage && document.kind === kind
  return [...documents].sort((a, b) => {
    const primary = Number(isPrimary(b)) - Number(isPrimary(a))
    return primary !== 0 ? primary : b.createdAt.localeCompare(a.createdAt)
  })
}

// ---------------------------------------------------------------------------
// Checklist and the advance gate

export function stageChecklist(checklist: readonly ChecklistItem[], stage: string): ChecklistItem[] {
  return checklist.filter((item) => item.stage === stage)
}

export interface Progress {
  done: number
  total: number
}

/** Required items that no longer block the stage (done or waived). */
export function requiredProgress(items: readonly ChecklistItem[]): Progress {
  const required = items.filter((item) => item.required)
  return { done: required.filter((item) => item.status !== 'open').length, total: required.length }
}

export function openRequiredItems(items: readonly ChecklistItem[]): ChecklistItem[] {
  return items.filter((item) => item.required && item.status === 'open')
}

export type AdvanceBlock =
  | 'not-current-stage'
  | 'run-not-completed'
  | 'no-go'
  | 'checklist-open'
  | 'last-stage'

/** Why "Advance" is disabled, or null when it can be offered. */
export function advanceBlock(input: {
  currentStage: string
  viewedStage: string
  run: Pick<StageRun, 'status' | 'summaryMarkdown'> | null
  checklist: readonly ChecklistItem[]
  nextStage: string | null
}): AdvanceBlock | null {
  if (input.viewedStage !== input.currentStage) return 'not-current-stage'
  if (input.nextStage === null) return 'last-stage'
  if (input.run === null || input.run.status !== 'completed') return 'run-not-completed'
  if (recordedDecision(input.run) === 'no_go') return 'no-go'
  if (openRequiredItems(stageChecklist(input.checklist, input.viewedStage)).length > 0) return 'checklist-open'
  return null
}

/** Labels from `STAGE_CHECKLIST_INCOMPLETE` ("complete required items for planning: A; B"). */
export function checklistLabelsFromError(message: string): string[] {
  const index = message.indexOf(':')
  if (index === -1) return []
  return message
    .slice(index + 1)
    .split(';')
    .map((label) => label.trim())
    .filter((label) => label !== '')
}

// ---------------------------------------------------------------------------
// Polling

export const POLL_FAST_MS = 1500
export const POLL_SLOW_MS = 3000
export const POLL_BACKOFF_AFTER_MS = 30_000
export const POLL_MAX_MS = 30 * 60_000

/** Delay before the next poll, or null once the 30-minute cap is reached. */
export function pollDelay(elapsedMs: number): number | null {
  if (elapsedMs >= POLL_MAX_MS) return null
  return elapsedMs < POLL_BACKOFF_AFTER_MS ? POLL_FAST_MS : POLL_SLOW_MS
}

// ---------------------------------------------------------------------------
// Context packet

export interface PriorStageSummary {
  stage: string
  summary: string
  completedAt: string | null
}

/** `context.priorStages`, tolerating any shape. */
export function priorStageSummaries(context: unknown): PriorStageSummary[] {
  if (context === null || typeof context !== 'object') return []
  const prior = (context as { priorStages?: unknown }).priorStages
  if (!Array.isArray(prior)) return []
  return prior.flatMap((entry): PriorStageSummary[] => {
    if (entry === null || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    if (typeof record.stage !== 'string' || typeof record.summary !== 'string') return []
    return [{
      stage: record.stage,
      summary: record.summary,
      completedAt: typeof record.completedAt === 'string' ? record.completedAt : null,
    }]
  })
}

export function shortHash(hash: string | null): string {
  return hash === null ? '' : hash.slice(0, 12)
}
