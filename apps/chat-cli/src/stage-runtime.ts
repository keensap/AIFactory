/**
 * Stage coordinator runtime.
 *
 * The first implemented stage is Planning & Feasibility. The controller below
 * owns the state machine; the model only produces analysis, the TELOS draft and
 * a structured review. A rejected draft is sent back to the author for a
 * bounded number of revisions before the run fails or waits for a human.
 */

import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { materialiseAgent } from './agent-patch.ts'
import { buildSourceRegister, loadBaselineEvidence, type BaselineEvidence, type SourceRecord } from './stage-evidence.ts'
import { STAGE_PROCESSES, type AgentComposition } from './agents.ts'
import type { StageDefinition } from './stage-definition.ts'
import type { RequirementsCoverageReport } from './stages/requirements-coverage.ts'
import { inspectRequirementsDocument } from './stages/requirements-checks.ts'
import { PLANNING_DEFINITION } from './stages/planning.ts'
import { ModelSettingsError } from './models/index.ts'
import type { DshHarness } from './harness.ts'
import { StageEventSink } from './stage-event-sink.ts'
import { attributeUsage, roleModel, type ModelPin } from './models/index.ts'
import { addLogContext, noopLogger, runWithLogContext, type Logger } from './logging/index.ts'
import { noopProvider, type TraceRecorder, type TraceSpan } from './observability/index.ts'
import type { Project, ProjectService } from './projects.ts'
import type { StageRunBindings } from './workspace.ts'
import type { ProjectStage } from './sdlc.ts'
import { SDLC_STAGES, STAGE_LABELS } from './sdlc.ts'
import { MAX_ATTACHMENTS_PER_RUN, PROMPT_CHARS_PER_ATTACHMENT, renderAttachmentPrompt, type ProjectAttachment } from './attachments.ts'
import { renderReportPdf } from './report/pdf.ts'
import {
  DEFAULT_PLANNING_STAGE_SETTINGS,
  settingsFromContext,
  type PlanningStageSettings,
} from './stage-settings.ts'
import { exportTarget, writeExport } from './report/export.ts'
import { TELOS_DOCUMENT_KIND, TELOS_TEMPLATE } from './telos.ts'
import {
  PostgresProjectWorkspace,
  WorkspaceError,
  type ProjectDocument,
  type ProjectWorkspaceSnapshot,
  type StageReview,
  type StageRun,
  type StageRunDetail,
  type StageReviewDecision,
  type PendingGate,
  type StageRunPatch,
} from './workspace.ts'

const PLANNING_STAGE: ProjectStage = 'planning'
const DEFAULT_MAX_REVIEW_CYCLES = 3
const TELOS_REPORT_TITLE = 'TELOS Feasibility Report'

export type HumanDecision = 'go' | 'conditional_go' | 'no_go' | 'approved' | 'rejected'

export interface StageRuntimeDeps {
  /**
   * What this engine drives. Defaults to planning, so existing callers and tests
   * keep working while the engine itself stays stage-independent (AR-15).
   */
  definition?: StageDefinition
  projects: ProjectService
  workspace: PostgresProjectWorkspace
  harnessFactory: (cwd?: string, timeoutMs?: number) => DshHarness
  /** Test seam: replace a harness role call with a deterministic response. */
  runPrompt?: (role: StageRole, prompt: string, cwd: string) => Promise<string>
  /** Resolves the named agent (if any) that runs a stage process. */
  agents?: { composition(input: { projectId: string; stage: string; process: string }): Promise<AgentComposition | undefined> }
  maxReviewCycles?: number
  /** Per-role harness timeout. Chat keeps its shorter timeout. */
  roleTimeoutMs?: number
  /** Stable-ish identity for the worker claiming the run. */
  workerId?: string
  leaseMs?: number
  heartbeatMs?: number
  /** Optional background indexing after an approved document is stored. */
  indexDocument?: (project: Project, document: ProjectDocument) => Promise<unknown>
  logger?: Logger
  traces?: TraceRecorder
  /**
   * Freeze the model target for one run. Every role of the run uses the pin, so
   * a settings change mid-run affects later runs only, and the pin supplies the
   * provider/model/price recorded with each role's usage. Omit to use
   * `harnessFactory` unchanged (no attribution).
   */
  pinModel?: () => ModelPin | undefined
  /** Test seam: replace PDF rendering (e.g. to simulate a failure). */
  renderPdf?: typeof renderReportPdf
  /** Resolves the project's planning-stage settings (gate, cycles, acceptance). */
  /**
   * Per-stage settings, keyed by stage. Any stage the engine drives must be here;
   * a stage absent falls back to the planning defaults as before.
   */
  stageSettings?: { [stage: string]: (projectId: string) => Promise<PlanningStageSettings> }
  /** The model target in force, snapshotted into a new run (AR-06). */
  currentTarget?: () => { provider: string; model: string; fallback: Array<{ provider: string; model: string }> } | null
  /** Pin an explicit target instead of the current one (AR-06). */
  pinTarget?: (target: { provider: string; model: string; fallback: Array<{ provider: string; model: string }> }) => Promise<ModelPin>
  /** Digest of the model catalogue at start, for provenance. */
  catalogDigest?: () => string | null
  /** Provider health (the shared circuit breaker), so a run can fail over (AR-03). */
  modelHealth?: (provider: string) => Promise<{
    tryAcquire(): boolean
    recordSuccess(): void
    recordFailure(error: unknown): void
  } | null>
  /** The profile's `tool-*` rows, so an allowlist can be verified (AR-05). */
  profileToolRows?: readonly string[]
  /** Refuses to start a run when the stage's prerequisites are not met. */
  prerequisites?: {
    ensureReady(
      projectId: string,
      stage: ProjectStage,
      options?: { incomingBrief?: boolean },
    ): Promise<{ ready: boolean; evaluatedAt: string; prerequisites: Array<{ key: string; satisfied: boolean; evidence: unknown }> }>
  }
}

export type StageRole = 'analyzer' | 'author' | 'reviewer'

/** A stage input with its extracted text, as it travels to the model. */
export interface ContextAttachment {
  id: string
  title: string
  filename: string
  pages: number
  characters: number
  truncated: boolean
  text: string
}

export interface StageContextPacket {
  schemaVersion: 1
  project: {
    id: string
    name: string
    rootPath: string
    organization: string | null
    ownerEmail: string | null
    status: string
    currentStage: ProjectStage
  }
  stage: {
    key: ProjectStage
    checklist: ProjectWorkspaceSnapshot['checklist']
    documents: ProjectWorkspaceSnapshot['documents']
  }
  priorStages: Array<{ stage: ProjectStage; summary: string; completedAt: string | null }>
  documents: ProjectWorkspaceSnapshot['documents']
  /** Missing on legacy runs; never backfill mutable evidence during execution. */
  baselineEvidence?: BaselineEvidence[]
  /** Provenance of every input (FR-201), for stages that trace to sources. Missing on runs before R9. */
  sources?: SourceRecord[]
  /** Requester-supplied PDFs and their extracted text. */
  attachments: ContextAttachment[]
  input: string | null
  constraints: {
    maxReviewCycles: number
    /** Acceptance criteria for stopping the revision loop early. */
    minRating: number
    maxBlockers: number
    maxMajor: number
    documentKind: string
    cardinality: 'one'
  }
  /**
   * The readiness evaluation the run was allowed to start on, so the gate can be
   * audited against the evidence that existed then (AR-07).
   */
  readiness?: { evaluatedAt: string; prerequisites: Array<{ key: string; satisfied: boolean; evidence: unknown }> }
}

export interface StageReviewResult {
  decision: StageReviewDecision
  findings: unknown[]
  /** Overall document rating 0–100, when the reviewer provided one. */
  rating?: number | null
}

export interface ReviewAcceptance {
  rating: number | null
  counts: { blockers: number; major: number; minor: number }
  accepted: boolean
  criteria: { minRating: number; maxBlockers: number; maxMajor: number }
}

/**
 * Decide whether a review is good enough to stop revising.
 *
 * Findings are counted by severity (`blocker`/`critical`, `major`, everything
 * else). When the reviewer supplies a rating, the numeric criteria decide. When
 * it does not (an older or simpler reviewer), the reviewer's own `approved`
 * decision still has to satisfy the issue counts, which keeps existing behaviour
 * working.
 */
export function reviewAcceptance(review: StageReviewResult, settings: PlanningStageSettings): ReviewAcceptance {
  const counts = { blockers: 0, major: 0, minor: 0 }
  for (const finding of review.findings) {
    const severity = finding !== null && typeof finding === 'object'
      ? String((finding as Record<string, unknown>).severity ?? '').toLowerCase()
      : ''
    if (severity === 'blocker' || severity === 'critical' || severity === 'blocking') counts.blockers += 1
    else if (severity === 'major') counts.major += 1
    else counts.minor += 1
  }
  const rating = typeof review.rating === 'number' && Number.isFinite(review.rating)
    ? Math.round(Math.min(100, Math.max(0, review.rating)))
    : null
  const issuesOk = counts.blockers <= settings.maxBlockers && counts.major <= settings.maxMajor
  const accepted = issuesOk && (rating === null ? review.decision === 'approved' : rating >= settings.minRating)
  return {
    rating,
    counts,
    accepted,
    criteria: { minRating: settings.minRating, maxBlockers: settings.maxBlockers, maxMajor: settings.maxMajor },
  }
}

function acceptanceLine(acceptance: ReviewAcceptance): string {
  const { rating, counts, criteria } = acceptance
  return `rating ${rating === null ? 'not rated' : `${rating}/100`} (min ${criteria.minRating}), ${counts.blockers} blocker(s) (max ${criteria.maxBlockers}), ${counts.major} major (max ${criteria.maxMajor})`
}

export class StageRuntimeError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'StageRuntimeError'
    this.status = status
    this.code = code
  }
}

/**
 * Drives one stage run: lease, the analyze -> author -> review -> gate loop, the
 * acceptance rule, completion and export.
 *
 * Stage identity, prompts and artifact come from `StageDefinition`, so the engine
 * itself names no stage (AR-15). `PlanningStageRuntime` remains as an alias for
 * callers that drive planning, and for the tests written against it.
 */
export class StageEngine {
  private readonly projects: ProjectService
  private readonly workspace: PostgresProjectWorkspace
  private readonly harnessFactory: (cwd?: string, timeoutMs?: number) => DshHarness
  private readonly runPrompt?: (role: StageRole, prompt: string, cwd: string) => Promise<string>
  private readonly agents?: { composition(input: { projectId: string; stage: string; process: string }): Promise<AgentComposition | undefined> }
  /** Frozen bindings per active run, so roles never re-resolve mid-run (AR-06). */
  private readonly runBindings = new Map<string, StageRunBindings | null>()
  /** The harness currently running a role, so a cancel request can abort it. */
  private activeHarness: DshHarness | null = null
  /** Cleanup for agent patch files, so a run removes exactly what it wrote. */
  private readonly agentCleanup = new Map<string, () => Promise<void>>()
  private readonly maxReviewCycles: number
  private readonly roleTimeoutMs: number
  private readonly workerId: string
  private readonly leaseMs: number
  private readonly heartbeatMs: number
  private readonly indexDocument?: (project: Project, document: ProjectDocument) => Promise<unknown>
  private readonly log: Logger
  private readonly traces: TraceRecorder
  private readonly activeRuns = new Set<string>()
  private readonly pinModel?: () => ModelPin | undefined
  private readonly renderPdf: typeof renderReportPdf
  private readonly stageSettings?: { [stage: string]: (projectId: string) => Promise<PlanningStageSettings> }
  private readonly currentTarget?: () => { provider: string; model: string; fallback: Array<{ provider: string; model: string }> } | null
  private readonly pinTarget?: (target: { provider: string; model: string; fallback: Array<{ provider: string; model: string }> }) => Promise<ModelPin>
  private readonly catalogDigest?: () => string | null
  private readonly modelHealth?: (provider: string) => Promise<{
    tryAcquire(): boolean
    recordSuccess(): void
    recordFailure(error: unknown): void
  } | null>
  private readonly profileToolRows?: readonly string[]
  private readonly definition: StageDefinition
  private readonly prerequisites?: {
    ensureReady(
      projectId: string,
      stage: ProjectStage,
      options?: { incomingBrief?: boolean },
    ): Promise<{ ready: boolean; evaluatedAt: string; prerequisites: Array<{ key: string; satisfied: boolean; evidence: unknown }> }>
  }
  /** Model pins of runs currently executing, by run id. */
  private readonly pins = new Map<string, ModelPin>()

  constructor(deps: StageRuntimeDeps) {
    if (deps.pinModel !== undefined) this.pinModel = deps.pinModel
    this.renderPdf = deps.renderPdf ?? renderReportPdf
    if (deps.stageSettings !== undefined) this.stageSettings = deps.stageSettings
    if (deps.prerequisites !== undefined) this.prerequisites = deps.prerequisites
    if (deps.profileToolRows !== undefined) this.profileToolRows = deps.profileToolRows
    if (deps.currentTarget !== undefined) this.currentTarget = deps.currentTarget
    if (deps.pinTarget !== undefined) this.pinTarget = deps.pinTarget
    if (deps.catalogDigest !== undefined) this.catalogDigest = deps.catalogDigest
    if (deps.modelHealth !== undefined) this.modelHealth = deps.modelHealth
    this.projects = deps.projects
    this.workspace = deps.workspace
    this.harnessFactory = deps.harnessFactory
    this.runPrompt = deps.runPrompt
    if (deps.agents !== undefined) this.agents = deps.agents
    this.definition = deps.definition ?? PLANNING_DEFINITION
    this.maxReviewCycles = deps.maxReviewCycles ?? DEFAULT_MAX_REVIEW_CYCLES
    this.roleTimeoutMs = deps.roleTimeoutMs ?? 900_000
    this.workerId = deps.workerId ?? `${process.pid}-${randomUUID().slice(0, 8)}`
    this.leaseMs = deps.leaseMs ?? 120_000
    this.heartbeatMs = deps.heartbeatMs ?? 30_000
    this.indexDocument = deps.indexDocument
    this.log = (deps.logger ?? noopLogger).child({ component: 'stage-runtime' })
    this.traces = deps.traces ?? noopProvider.recorder
  }

  async start(input: {
    projectId: string
    stage: string
    brief?: string | null
    /** Requester-supplied PDFs to analyse alongside the brief. */
    attachmentIds?: string[]
  }): Promise<StageRunDetail> {
    this.assertExecutable(input.stage)
    const project = await this.projects.get(input.projectId)
    await assertProjectRoot(project)
    // Prerequisites are evidence, not "the previous stage ran", so a project can
    // start here when the inputs exist (or were waived).
    // What the run was allowed to start on, recorded in its context so the gate
    // can always be audited against the evidence that existed at the time (AR-07).
    let readiness: { ready: boolean; evaluatedAt: string; prerequisites: Array<{ key: string; satisfied: boolean; evidence: unknown }> } | undefined
    if (this.prerequisites !== undefined) {
      readiness = await this.prerequisites.ensureReady(project.id, this.definition.stage, {
        incomingBrief: (input.brief ?? '').trim() !== '',
      })
    }
    const snapshot = await this.workspace.getSnapshot(project.id)
    const priorStages = await this.workspace.getPriorStageSummaries(project.id, this.definition.stage)
    const provenance = new Map<string, { createdAt: string; sha256: string }>()
    const attachments = await this.loadAttachments(project, input.attachmentIds ?? [], provenance)
    const settings = await this.resolveSettings(project.id)
    const context = buildContextPacket(
      project,
      snapshot,
      priorStages,
      input.brief ?? null,
      settings.maxReviewCycles,
      attachments,
      { minRating: settings.minRating, maxBlockers: settings.maxBlockers, maxMajor: settings.maxMajor },
      readiness === undefined
        ? undefined
        : { evaluatedAt: readiness.evaluatedAt, prerequisites: readiness.prerequisites },
      this.definition,
    )
    if (this.definition.baselineDocumentKinds !== undefined) {
      context.baselineEvidence = await loadBaselineEvidence(project.rootPath, project.id, snapshot.documents, this.definition.baselineDocumentKinds)
      context.sources = buildSourceRegister({
        brief: input.brief ?? null,
        briefAt: new Date().toISOString(),
        attachments: attachments.map((attachment) => ({ ...attachment, ...provenance.get(attachment.id) })),
        baseline: context.baselineEvidence,
      })
    }
    // Freeze what this run uses, so a resume days later is the same run (AR-06).
    const bindings = await this.snapshotBindings(project.id)
    const run = await this.workspace.createStageRun({
      projectId: project.id,
      stage: this.definition.stage,
      inputText: input.brief ?? null,
      context,
      contextHash: hashContext(context),
    })
    if (bindings !== null) {
      await this.workspace.updateStageRun(run.id, { bindings })
    }
    if (attachments.length > 0) {
      await this.workspace.linkRunAttachments(run.id, attachments.map((attachment) => attachment.id))
    }
    return (await this.workspace.getStageRunDetail(run.id))!
  }

  /**
   * Load and validate the run's inputs. Attachments belong to the project, so an
   * id from another project is rejected rather than silently ignored.
   */
  private async loadAttachments(
    project: Project,
    ids: string[],
    provenance?: Map<string, { createdAt: string; sha256: string }>,
  ): Promise<ContextAttachment[]> {
    const unique = [...new Set(ids.filter((id) => id.trim() !== ''))]
    if (unique.length === 0) return []
    if (unique.length > MAX_ATTACHMENTS_PER_RUN) {
      throw new StageRuntimeError(400, 'TOO_MANY_ATTACHMENTS', `a stage run accepts at most ${MAX_ATTACHMENTS_PER_RUN} input documents`)
    }
    const attachments: ContextAttachment[] = []
    for (const id of unique) {
      const attachment = await this.workspace.getAttachment(project.id, id)
      if (attachment === undefined) {
        throw new StageRuntimeError(404, 'ATTACHMENT_NOT_FOUND', `input document ${id} was not found for this project`)
      }
      const text = await this.workspace.readAttachmentText(attachment, project.rootPath)
      provenance?.set(attachment.id, { createdAt: new Date(attachment.createdAt).toISOString(), sha256: attachment.sha256 })
      attachments.push({
        id: attachment.id,
        title: attachment.title,
        filename: attachment.filename,
        pages: attachment.pages,
        characters: attachment.characters,
        truncated: attachment.truncated,
        text: text.slice(0, PROMPT_CHARS_PER_ATTACHMENT),
      })
    }
    return attachments
  }

  /** The settings a run starts with: project override, else Factory default. */
  private async resolveSettings(projectId: string): Promise<PlanningStageSettings> {
    if (this.stageSettings === undefined) {
      return { ...DEFAULT_PLANNING_STAGE_SETTINGS, maxReviewCycles: this.maxReviewCycles }
    }
    try {
      const resolve = this.stageSettings[this.definition.stage] ?? this.stageSettings.planning
      if (resolve === undefined) {
        return { ...DEFAULT_PLANNING_STAGE_SETTINGS, maxReviewCycles: this.maxReviewCycles }
      }
      const resolved = await resolve(projectId)
      return {
        maxReviewCycles: resolved.maxReviewCycles,
        minRating: resolved.minRating,
        maxBlockers: resolved.maxBlockers,
        maxMajor: resolved.maxMajor,
        gateReminderHours: resolved.gateReminderHours ?? DEFAULT_PLANNING_STAGE_SETTINGS.gateReminderHours,
      }
    } catch (error) {
      // Settings must never stop a run; fall back to the built-in defaults.
      this.log.warn({ event: 'stage.settings.unavailable', err: error })
      return { ...DEFAULT_PLANNING_STAGE_SETTINGS }
    }
  }

  /** The stage this engine drives. */
  get stage(): ProjectStage {
    return this.definition.stage
  }

  async list(projectId: string, stage: string): Promise<StageRun[]> {
    this.assertExecutable(stage)
    await this.projects.get(projectId)
    return this.workspace.listStageRuns(projectId, this.definition.stage)
  }

  async get(runId: string): Promise<StageRunDetail> {
    const run = await this.workspace.getStageRunDetail(runId)
    if (run === undefined) throw new StageRuntimeError(404, 'STAGE_RUN_NOT_FOUND', 'stage run not found')
    return run
  }

  async execute(runId: string): Promise<StageRunDetail> {
    const run = await this.requireRun(runId)
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      throw new StageRuntimeError(409, 'STAGE_RUN_TERMINAL', `stage run is already ${run.status}`)
    }
    if (run.status === 'awaiting_human') {
      throw new StageRuntimeError(409, 'STAGE_RUN_AWAITING_HUMAN', 'stage run is waiting for a human answer')
    }
    return runWithLogContext(
      { projectId: run.projectId, stageRunId: run.id, stage: run.stage },
      () => this.withLease(run.id, (ctx) => this.advance(ctx)),
    )
  }

  /**
   * The final gate: stop refining and complete the stage (with the go /
   * conditional-go / no-go decision), or ask for one more refinement pass.
   * Completion is the only point where the document and its PDF are produced.
   */
  async decide(runId: string, input: {
    decision?: HumanDecision | 'approved'
    refine?: boolean
    note?: string
    coverageWaiverReason?: string
  }): Promise<StageRunDetail> {
    const run = await this.requireRun(runId)
    const gate = run.pendingGate
    if (run.status !== 'awaiting_human' || gate === null || gate.kind !== 'final') {
      throw new StageRuntimeError(409, 'STAGE_RUN_NOT_AWAITING_DECISION', 'this run is not waiting on a final decision')
    }
    const refine = input.refine === true
    // Planning records a feasibility decision. A stage that only approves still
    // requires an explicit answer: an empty body must never approve by default.
    const feasibility = this.definition.humanDecision === 'feasibility'
    if (!refine) {
      if (input.decision === undefined) {
        throw new StageRuntimeError(
          400,
          'INVALID_HUMAN_DECISION',
          feasibility
            ? 'decision must be go, conditional_go or no_go'
            : 'decision must be approved or rejected',
        )
      }
      const allowed: readonly string[] = feasibility
        ? ['go', 'conditional_go', 'no_go']
        // `go`/`conditional_go` stay accepted for API compatibility; `no_go`
        // means reject here, never "complete with a negative decision".
        : ['approved', 'rejected', 'go', 'conditional_go', 'no_go']
      if (!allowed.includes(input.decision)) {
        throw new StageRuntimeError(
          400,
          'INVALID_HUMAN_DECISION',
          feasibility
            ? 'decision must be go, conditional_go or no_go'
            : 'decision must be approved or rejected',
        )
      }
    }

    const waiverReason = input.coverageWaiverReason?.trim()
    if (input.coverageWaiverReason !== undefined && (
      run.stage !== 'requirements' || refine || input.decision !== 'approved'
      || !waiverReason || waiverReason.length > 2000
    )) {
      throw new StageRuntimeError(400, 'INVALID_COVERAGE_WAIVER', 'provide a nonblank coverageWaiverReason of at most 2000 characters with explicit requirements approval')
    }

    return runWithLogContext(
      { projectId: run.projectId, stageRunId: run.id, stage: run.stage },
      () => this.withLease(run.id, async (ctx) => {
        const gate = ctx.run.pendingGate
        if (ctx.run.status !== 'awaiting_human' || gate === null) {
          throw new StageRuntimeError(409, 'STAGE_RUN_NOT_AWAITING_DECISION', 'this run is not waiting on a final decision')
        }
        const settings = settingsFromContext(ctx.context)
        const review: StageReviewResult = { decision: gate.reviewDecision as StageReviewDecision, findings: gate.findings }
        if (refine) {
          await this.appendRunEvent(ctx.project.id, ctx.run.id, 'gate_decision', { gate: 'final', refine: true }, 'info')
          return this.refineOnce(ctx, review, settings)
        }
        // A rejection is a decision, not a completion: the gate stays open and
        // nothing is published, so the operator can refine or approve later.
        const decision = input.decision as HumanDecision
        if (!feasibility && (decision === 'rejected' || decision === 'no_go')) {
          return this.rejectAtFinalGate(ctx, decision, input.note, review)
        }
        // A plain approval stage records what the human chose; planning records
        // its own feasibility outcome.
        // Recompute under the lease against the exact draft being published,
        // including runs created before coverage was stored on the gate.
        const coverage = this.requirementsCoverage(ctx.run.draftMarkdown ?? '', ctx.context)
        const blocking = coverage?.findings.filter((finding) => finding.severity === 'blocking') ?? []
        if (blocking.length > 0 && waiverReason === undefined) {
          throw new StageRuntimeError(409, 'REQUIREMENTS_COVERAGE_BLOCKED', `approval blocked by ${blocking.length} requirements coverage finding(s); refine or explicitly approve with coverageWaiverReason`)
        }
        return this.completeRun(ctx, decision, input.note, review, coverage, blocking.length > 0 ? waiverReason : undefined)
      }, { resumeAtGate: true }),
    )
  }

  /**
   * Record a rejection without completing: no document, no PDF, no checklist
   * evidence. The run stays at the same final gate so it can be refined or
   * approved later, and the reason is kept in the audit log and the summary.
   */
  private async rejectAtFinalGate(
    ctx: LeaseContext,
    decision: HumanDecision,
    note: string | undefined,
    review: StageReviewResult,
  ): Promise<StageRunDetail> {
    const trimmed = note?.trim() ?? ''
    const previous = (ctx.run.summaryMarkdown ?? '').split('\n## Human decision')[0]!.trimEnd()
    const summary = [
      previous,
      '',
      '## Human decision',
      '',
      `Decision: **${decision.replace('_', '-')}** — the stage was not completed.`,
      trimmed === '' ? '' : `\n${trimmed}\n`,
      'The run is still at the final gate: refine it, or approve it when it is ready.',
      '',
    ].join('\n')

    ctx.assertLease()
    await this.appendRunEvent(ctx.project.id, ctx.run.id, 'gate_decision', {
      gate: 'final',
      decision,
      rejected: true,
      note: trimmed === '' ? null : trimmed,
    }, 'info')
    await this.workspace.updateStageRun(ctx.run.id, { summaryMarkdown: summary })
    ctx.run = { ...ctx.run, summaryMarkdown: summary }
    this.log.info({ event: 'stage.gate.rejected', decision, hasNote: trimmed !== '' })
    return (await this.workspace.getStageRunDetail(ctx.run.id))!
  }

  /**
   * The model target and per-process agents a new run will use (AR-06).
   *
   * Only what is configured is recorded: an unconfigured model leaves the
   * harness profile default in force, exactly as before.
   */
  private async snapshotBindings(projectId: string): Promise<StageRunBindings | null> {
    const target = this.currentTarget?.() ?? null
    const processes = STAGE_PROCESSES[this.definition.stage] ?? this.definition.processes
    const agents: StageRunBindings['agents'] = {}
    for (const process of processes) {
      const composition = this.agents === undefined
        ? undefined
        : await this.agents.composition({ projectId, stage: this.definition.stage, process })
      agents[process] = composition === undefined ? null : { ...composition }
    }
    if (target === null && Object.values(agents).every((entry) => entry === null)) return null
    return {
      // null, not an empty string: "no target configured" is not a provider.
      model: target === null
        ? null
        : {
            provider: target.provider,
            model: target.model,
            fallback: target.fallback,
            catalogDigest: this.catalogDigest?.() ?? null,
          },
      agents,
    }
  }

  /**
   * Adopt the current model and agents on a paused run (AR-06).
   *
   * The only way a run's bindings change: explicit, admin-only, and recorded with
   * the before and after values so the review history stays explainable.
   */
  async rebind(runId: string): Promise<{ before: StageRunBindings | null; after: StageRunBindings | null; run: StageRunDetail }> {
    const run = await this.requireRun(runId)
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      throw new StageRuntimeError(409, 'STAGE_RUN_TERMINAL', `stage run is already ${run.status}`)
    }
    const before = run.bindings ?? null
    const after = await this.snapshotBindings(run.projectId)
    await this.workspace.updateStageRun(run.id, { bindings: after })
    await this.appendRunEvent(run.projectId, run.id, 'run_rebound', { before, after }, 'warn')
    this.log.info({ event: 'stage.run.rebound', runId: run.id })
    return { before, after, run: (await this.workspace.getStageRunDetail(run.id))! }
  }

  /**
   * Runs waiting for a human, with staleness (AR-16).
   *
   * A gate older than the run's own `gateReminderHours` snapshot is reported stale
   * and gets one `gate_stale` event. Nothing is approved, rejected or cancelled
   * automatically: completion stays a human decision.
   */
  async awaiting(options: { staleOnly?: boolean } = {}): Promise<Array<{
    run: StageRunDetail
    stale: boolean
    waitingHours: number
    reminderAfterHours: number
  }>> {
    const runs = await this.workspace.listAwaitingStageRuns()
    const out: Array<{ run: StageRunDetail; stale: boolean; waitingHours: number; reminderAfterHours: number }> = []
    for (const run of runs) {
      const settings = settingsFromContext(run.context)
      const since = run.pendingGate?.waitingSince ?? run.updatedAt
      const waitingHours = Math.max(0, (Date.now() - Date.parse(since)) / 3_600_000)
      const stale = waitingHours >= settings.gateReminderHours
      if (stale && !(await this.workspace.hasStageRunEvent(run.id, 'gate_stale'))) {
        await this.appendRunEvent(run.projectId, run.id, 'gate_stale', {
          waitingHours: Math.round(waitingHours),
          reminderAfterHours: settings.gateReminderHours,
          gate: run.pendingGate?.kind ?? null,
        }, 'warn')
      }
      if (options.staleOnly === true && !stale) continue
      out.push({
        run: (await this.workspace.getStageRunDetail(run.id))!,
        stale,
        waitingHours: Math.round(waitingHours * 10) / 10,
        reminderAfterHours: settings.gateReminderHours,
      })
    }
    return out
  }

  /**
   * Ask a run to stop (AR-11).
   *
   * A run that is not being executed is cancelled at once. A leased run gets the
   * request recorded; its owner aborts at the next heartbeat and ends it
   * `cancelled`. Nothing is left paused: a gate is cleared either way.
   */
  async cancel(runId: string, reason?: string): Promise<StageRunDetail> {
    const run = await this.requireRun(runId)
    const updated = await this.workspace.requestCancel(run.id, reason?.trim() === '' ? null : reason?.trim() ?? null)
    if (updated.status === 'cancelled') {
      await this.appendRunEvent(run.projectId, run.id, 'run_cancelled', { reason: reason ?? null }, 'info')
      this.log.info({ event: 'stage.run.cancelled', runId: run.id, reason: reason ?? null })
    }
    return this.get(run.id)
  }

  /**
   * Retry a failed run (AR-04). The stored analysis and draft are kept, so the
   * runtime resumes from the last completed phase instead of paying for it again.
   * Explicit and audited: never automatic.
   */
  async retry(runId: string): Promise<StageRunDetail> {
    const run = await this.requireRun(runId)
    if (run.status !== 'failed') {
      throw new StageRuntimeError(409, 'STAGE_RUN_NOT_FAILED', `only a failed run can be retried; this run is ${run.status}`)
    }
    await this.appendRunEvent(run.projectId, run.id, 'run_retried', {
      attempt: run.attempt,
      hadAnalysis: (run.analysisMarkdown ?? '').trim() !== '',
      hadDraft: (run.draftMarkdown ?? '').trim() !== '',
    }, 'info')
    await this.workspace.updateStageRun(run.id, {
      status: 'pending',
      pendingGate: null,
      summaryMarkdown: null,
    } as StageRunPatch)
    this.log.info({ event: 'stage.run.retried', runId: run.id, attempt: run.attempt })
    return this.get(run.id)
  }

  private async requireRun(runId: string): Promise<StageRun> {
    const run = await this.workspace.getStageRun(runId)
    if (run === undefined) throw new StageRuntimeError(404, 'STAGE_RUN_NOT_FOUND', 'stage run not found')
    if (run.stage !== this.definition.stage) {
      throw new StageRuntimeError(501, 'STAGE_RUNTIME_NOT_IMPLEMENTED', `this run belongs to the ${run.stage} stage, which this engine (${this.definition.stage}) does not execute`)
    }
    return run
  }

  // ---- lease, tracing and failure handling ------------------------------

  /**
   * Run `fn` under a lease.
   *
   * `resumeAtGate` is set when the work continues a run that is already paused at
   * a gate: it had reached a safe state, so a failure must return it to that state
   * instead of destroying it (AR-04).
   */
  private async withLease<T>(
    runId: string,
    fn: (ctx: LeaseContext) => Promise<T>,
    options: { resumeAtGate?: boolean } = {},
  ): Promise<T> {
    const run = await this.requireRun(runId)
    if (this.activeRuns.has(run.id)) {
      throw new StageRuntimeError(409, 'STAGE_RUN_RUNNING', 'stage run is already executing')
    }
    this.activeRuns.add(run.id)
    let claimed: StageRun | undefined
    try {
      claimed = await this.workspace.claimStageRun(run.id, this.workerId, this.leaseMs)
    } catch (error) {
      this.activeRuns.delete(run.id)
      throw error
    }
    if (claimed === undefined) {
      this.activeRuns.delete(run.id)
      throw new StageRuntimeError(409, 'STAGE_RUN_LEASED', 'stage run is leased by another worker')
    }

    this.log.info({ event: 'stage.run.claimed', workerId: this.workerId, executionAttempt: claimed.executionAttempts })
    let leaseLost = false
    let cancelRequested = false
    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          const renewed = await this.workspace.heartbeatStageRun(run.id, this.workerId, this.leaseMs)
          if (!renewed) {
            leaseLost = true
            this.log.warn({ event: 'stage.run.lease_lost', workerId: this.workerId })
          }
          // A stop was requested (AR-11). Abort the role in flight rather than
          // waiting for it: the operator asked for it to end now.
          if (!cancelRequested && await this.workspace.isCancelRequested(run.id)) {
            cancelRequested = true
            this.log.info({ event: 'stage.run.cancel_requested', workerId: this.workerId })
            this.activeHarness?.cancel()
          }
        } catch (error) {
          leaseLost = true
          this.log.warn({ event: 'stage.run.heartbeat_failed', workerId: this.workerId, err: error })
        }
      })()
    }, this.heartbeatMs)
    heartbeat.unref()

    let runSpan: TraceSpan | undefined
    // The run's safe state, restored if a resume fails (declared outside the try so
    // the catch can reach it).
    let checkpoint: {
      status: StageRun['status']
      pendingGate: StageRun['pendingGate']
      draftMarkdown: string | null
      reviewCycles: number
      summaryMarkdown: string | null
    } | null = null
    try {
      const project = await this.projects.get(run.projectId)
      await assertProjectRoot(project)
      const bound = claimed.bindings ?? null
      this.runBindings.set(claimed.id, bound)
      // A resume uses the model the run started with, not today's target (AR-06).
      const target = bound?.model ?? null
      const pin = target !== null && this.pinTarget !== undefined
        ? await this.pinTarget({ provider: target.provider, model: target.model, fallback: target.fallback })
        : this.pinModel?.()
      if (pin !== undefined) {
        this.pins.set(run.id, pin)
        this.log.info({
          event: 'stage.run.model_pinned',
          provider: pin.attribution?.provider ?? null,
          model: pin.attribution?.model ?? null,
          source: pin.attribution?.source ?? 'harness-default',
        })
      }
      runSpan = this.traces.startRun({
        projectId: project.id,
        projectName: project.name,
        runId: run.id,
        stage: run.stage,
        attempt: run.attempt,
        contextHash: run.contextHash,
        workerId: run.lockedBy,
        status: run.status,
      })
      if (runSpan !== undefined) addLogContext({ traceId: runSpan.traceId, spanId: runSpan.spanId })
      this.log.info({ event: 'stage.run.started', attempt: run.attempt, contextHash: run.contextHash })

      const context = (claimed.context ?? {}) as StageContextPacket
      const ctx: LeaseContext = {
        run: claimed,
        project,
        context,
        ...(runSpan !== undefined ? { span: runSpan } : {}),
        assertLease: () => {
          if (leaseLost) {
            throw new StageRuntimeError(409, 'STAGE_RUN_LEASE_LOST', 'worker lease was lost; another worker may own the run')
          }
          if (cancelRequested) {
            throw new StageRuntimeError(409, 'STAGE_RUN_CANCELLED', 'the run was cancelled while it was executing')
          }
        },
        update: async (patch: StageRunPatch) => {
          const next = await this.workspace.updateStageRun(run.id, patch)
          ctx.run = next
          return next
        },
      }
      // Captured before the work starts, so a failure can put it back.
      checkpoint = options.resumeAtGate === true
        ? {
            status: claimed.status,
            pendingGate: claimed.pendingGate,
            draftMarkdown: claimed.draftMarkdown,
            reviewCycles: claimed.reviewCycles,
            summaryMarkdown: claimed.summaryMarkdown,
          }
        : null
      return await fn(ctx)
    } catch (error) {
      if (leaseLost) {
        runSpan?.recordException(error instanceof Error ? error : new Error(String(error)))
        runSpan?.setStatus('error', 'lease lost')
        this.log.warn({ event: 'stage.run.stopped_lease_lost', workerId: this.workerId, err: error })
        throw error
      }
      runSpan?.recordException(error instanceof Error ? error : new Error(String(error)))
      runSpan?.setStatus('error', error instanceof Error ? error.message : String(error))
      const message = error instanceof Error ? error.message : String(error)
      if (cancelRequested) {
        // A cancellation is not a failure: the operator asked for it.
        await this.workspace.updateStageRun(run.id, {
          status: 'cancelled',
          pendingGate: null,
        }).catch(() => {})
        await this.appendRunEvent(run.projectId, run.id, 'run_cancelled', { reason: message }, 'info').catch(() => {})
        this.log.info({ event: 'stage.run.cancelled', runId: run.id })
        throw new StageRuntimeError(409, 'STAGE_RUN_CANCELLED', 'the run was cancelled')
      }
      if (error instanceof ModelSettingsError && error.code === 'MODEL_BINDING_UNAVAILABLE') {
        if (checkpoint !== null) {
          await this.workspace.updateStageRun(run.id, {
            status: checkpoint.status,
            pendingGate: checkpoint.pendingGate,
            draftMarkdown: checkpoint.draftMarkdown,
            reviewCycles: checkpoint.reviewCycles,
            summaryMarkdown: checkpoint.summaryMarkdown,
          } as StageRunPatch).catch(() => {})
        }
        this.log.error({ event: 'stage.run.binding_unavailable', runId: run.id, err: error })
        throw error
      }
      if (error instanceof StageRuntimeError && ['REQUIREMENTS_COVERAGE_BLOCKED', 'STAGE_RUN_NOT_AWAITING_DECISION'].includes(error.code)) {
        // Read-only gate validation failed; there is no mutation to restore.
        throw error
      }
      if (checkpoint !== null) {
        // Put the run back where the operator left it: same gate, same draft.
        // Losing an approvable draft to a transient error is the most expensive
        // failure this system can produce.
        await this.workspace.updateStageRun(run.id, {
          status: checkpoint.status,
          pendingGate: checkpoint.pendingGate,
          draftMarkdown: checkpoint.draftMarkdown,
          reviewCycles: checkpoint.reviewCycles,
          summaryMarkdown: checkpoint.summaryMarkdown,
        } as StageRunPatch).catch(() => {})
        await this.appendRunEvent(run.projectId, run.id, 'gate_resume_failed', { message }, 'error').catch(() => {})
        this.log.error({ event: 'stage.run.resume_failed', err: error }, 'the resume failed; the run was restored to its gate')
        throw new StageRuntimeError(502, 'STAGE_RESUME_FAILED', `the run is still waiting at its gate; retry: ${message}`)
      }
      this.log.error({ event: 'stage.run.failed', err: error })
      await this.workspace.updateStageRun(run.id, {
        status: 'failed',
        summaryMarkdown: `# ${STAGE_LABELS[run.stage]} run failed\n\n${message}\n`,
      }).catch(() => {})
      throw error
    } finally {
      this.runBindings.delete(run.id)
      this.pins.get(run.id)?.release()
      this.pins.delete(run.id)
      runSpan?.end()
      clearInterval(heartbeat)
      await this.workspace.releaseStageRun(run.id, this.workerId).catch((error: unknown) => {
        this.log.warn({ event: 'stage.run.lease_release_failed', workerId: this.workerId, err: error })
      })
      this.activeRuns.delete(run.id)
    }
  }

  // ---- the review loop --------------------------------------------------

  private async advance(ctx: LeaseContext): Promise<StageRunDetail> {
    const settings = settingsFromContext(ctx.context)
    let analysis = ctx.run.analysisMarkdown ?? ''
    let draft = ctx.run.draftMarkdown ?? ''

    if (analysis.trim() === '') {
      await ctx.update({ status: 'analyzing' })
      ctx.assertLease()
      analysis = await this.runRole('analyzer', this.definition.prompts.analyzer(ctx.project, ctx.context), ctx.project.rootPath, ctx.run.id, ctx.project.id, ctx.span)
      await ctx.update({ analysisMarkdown: analysis })
    }
    if (draft.trim() === '') {
      await ctx.update({ status: 'drafting' })
      ctx.assertLease()
      draft = cleanMarkdown(await this.runRole('author', this.definition.prompts.author(ctx.project, ctx.context, analysis), ctx.project.rootPath, ctx.run.id, ctx.project.id, ctx.span))
      await ctx.update({ draftMarkdown: draft })
    }
    return this.reviewAndContinue(ctx, draft, analysis, safeCycle(ctx.run.reviewCycles), settings)
  }

  private async reviewAndContinue(
    ctx: LeaseContext,
    draft: string,
    analysis: string,
    cycle: number,
    settings: PlanningStageSettings,
    options: { finalOnly?: boolean } = {},
  ): Promise<StageRunDetail> {
    const review = await this.reviewOnce(ctx, draft, settings)
    if (options.finalOnly === true) {
      // A refine pass is one review and one revision; it always hands the result
      // to the human rather than starting another automatic round.
      return this.pauseAtFinalGate(ctx, draft, cycle, review, settings)
    }
    return this.afterReview(ctx, draft, analysis, cycle, settings, review)
  }

  private requirementsCoverage(draft: string, context?: StageContextPacket): RequirementsCoverageReport | undefined {
    return this.definition.stage === 'requirements'
      ? inspectRequirementsDocument(draft, context?.sources === undefined ? {} : { sources: context.sources })
      : undefined
  }

  private coverageReview(review: StageReviewResult, coverage: RequirementsCoverageReport | undefined, settings: PlanningStageSettings): ReviewAcceptance {
    const acceptance = reviewAcceptance(review, settings)
    return { ...acceptance, accepted: acceptance.accepted && !coverage?.findings.some((finding) => finding.severity === 'blocking') }
  }

  private revisionFindings(review: StageReviewResult, coverage: RequirementsCoverageReport | undefined): unknown[] {
    return [...review.findings, ...(coverage?.findings.map((finding) => ({
      id: finding.code,
      section: 'Requirements coverage',
      severity: finding.severity === 'blocking' ? 'blocker' : 'minor',
      finding: finding.message,
      required_change: 'Fix the reported traceability or coverage gap.',
    })) ?? [])]
  }

  private async afterReview(
    ctx: LeaseContext,
    draft: string,
    analysis: string,
    cycle: number,
    settings: PlanningStageSettings,
    review: StageReviewResult,
  ): Promise<StageRunDetail> {
    const coverage = this.requirementsCoverage(draft, ctx.context)
    const acceptance = this.coverageReview(review, coverage, settings)
    if (acceptance.accepted) {
      // The document meets the bar: stop revising and ask the human.
      return this.pauseAtFinalGate(ctx, draft, cycle, review, settings)
    }
    if (cycle >= settings.maxReviewCycles) {
      // The automatic budget is spent; the operator decides whether to continue.
      return this.pauseAtFinalGate(ctx, draft, cycle, review, settings)
    }
    const next = cycle + 1
    const revised = await this.reviseOnce(ctx, draft, analysis, this.revisionFindings(review, coverage))
    await ctx.update({ reviewCycles: next, draftMarkdown: revised })
    return this.reviewAndContinue(ctx, revised, analysis, next, settings)
  }

  /**
   * One more pass after the operator asked to refine: review, revise once, then
   * review the *revised* candidate before the gate.
   *
   * The second review is not optional. Without it the gate showed one draft and
   * the findings of another — the operator approved (or waived) a document no
   * reviewer had seen.
   */
  private async refineOnce(ctx: LeaseContext, _previous: StageReviewResult, settings: PlanningStageSettings): Promise<StageRunDetail> {
    let draft = ctx.run.draftMarkdown ?? ''
    let cycle = safeCycle(ctx.run.reviewCycles)
    const review = await this.reviewOnce(ctx, draft, settings)
    const coverage = this.requirementsCoverage(draft, ctx.context)
    const acceptance = this.coverageReview(review, coverage, settings)
    if (!acceptance.accepted) {
      cycle += 1
      draft = await this.reviseOnce(ctx, draft, ctx.run.analysisMarkdown ?? '', this.revisionFindings(review, coverage))
      await ctx.update({ reviewCycles: cycle, draftMarkdown: draft })
      return this.reviewAndContinue(ctx, draft, ctx.run.analysisMarkdown ?? '', cycle, settings, { finalOnly: true })
    }
    return this.pauseAtFinalGate(ctx, draft, cycle, review, settings)
  }

  private async reviewOnce(ctx: LeaseContext, draft: string, settings: PlanningStageSettings): Promise<StageReviewResult> {
    await ctx.update({ status: 'reviewing' })
    ctx.assertLease()
    const rawReview = await this.runRole('reviewer', this.definition.prompts.reviewer(ctx.project, ctx.context, draft, settings, ctx.run.analysisMarkdown ?? ''), ctx.project.rootPath, ctx.run.id, ctx.project.id, ctx.span)
    const review = (this.definition.parseReview ?? parseStageReview)(rawReview)
    await this.workspace.addStageReview({
      stageRunId: ctx.run.id,
      // Planning keeps its historical role name; other stages name their own.
      reviewerRole: `${this.definition.stage}_reviewer`,
      decision: review.decision,
      findings: review.findings,
    })
    const coverage = this.requirementsCoverage(draft, ctx.context)
    const acceptance = this.coverageReview(review, coverage, settings)
    await this.appendRunEvent(ctx.project.id, ctx.run.id, 'review_decision', {
      decision: review.decision,
      rating: acceptance.rating,
      counts: acceptance.counts,
      accepted: acceptance.accepted,
      // Which version was judged. Without it a gate that shows a different draft
      // is impossible to spot after the fact.
      reviewedDraft: describeDraft(draft),
      findings: review.findings,
      ...(coverage === undefined ? {} : { coverage }),
    }, acceptance.accepted ? 'info' : 'warn')
    this.traces.recordReview(ctx.span, review.decision, review.findings.length)
    return review
  }

  private async reviseOnce(ctx: LeaseContext, draft: string, analysis: string, findings: unknown[]): Promise<string> {
    await ctx.update({ status: 'revising' })
    ctx.assertLease()
    const revised = cleanMarkdown(await this.runRole(
      'author',
      this.definition.prompts.revision(ctx.project, ctx.context, analysis, draft, findings),
      ctx.project.rootPath,
      ctx.run.id,
      ctx.project.id,
      ctx.span,
    ))
    await ctx.update({ draftMarkdown: revised })
    return revised
  }

  // ---- gates ------------------------------------------------------------

  private async pauseAtFinalGate(
    ctx: LeaseContext,
    draft: string,
    cycle: number,
    review: StageReviewResult,
    settings: PlanningStageSettings,
  ): Promise<StageRunDetail> {
    const coverage = this.requirementsCoverage(draft, ctx.context)
    const acceptance = this.coverageReview(review, coverage, settings)
    const gate: PendingGate = {
      kind: 'final',
      question: 'Complete the stage with this document, or refine it further?',
      cycle,
      maxReviewCycles: settings.maxReviewCycles,
      reviewDecision: review.decision,
      findings: review.findings,
      rating: acceptance.rating,
      counts: acceptance.counts,
      accepted: acceptance.accepted,
      criteria: acceptance.criteria,
      reviewedDraft: describeDraft(draft),
      ...(coverage === undefined ? {} : { coverage }),
      waitingSince: new Date().toISOString(),
    }
    await this.workspace.updateStageRun(ctx.run.id, {
      status: 'awaiting_human',
      pendingGate: gate,
      summaryMarkdown: buildGateSummary(ctx.run.analysisMarkdown ?? '', review, cycle, settings.maxReviewCycles, 'final', acceptance, STAGE_LABELS[ctx.run.stage]) + renderCoverageSummary(coverage),
    })
    await this.appendRunEvent(ctx.project.id, ctx.run.id, 'final_gate', {
      cycle,
      decision: review.decision,
      reviewedDraft: gate.reviewedDraft,
      ...(coverage === undefined ? {} : { coverage }),
    })
    this.log.info({ event: 'stage.gate.final', cycle, decision: review.decision })
    return (await this.workspace.getStageRunDetail(ctx.run.id))!
  }

  // ---- completion -------------------------------------------------------

  /**
   * The only place a stage document and its PDF are produced: on approval.
   * A PDF failure never fails the run (the Markdown artifact is kept).
   */
  private async completeRun(
    ctx: LeaseContext,
    decision: HumanDecision,
    note: string | undefined,
    review: StageReviewResult,
    coverage?: RequirementsCoverageReport,
    coverageWaiverReason?: string,
  ): Promise<StageRunDetail> {
    const project = ctx.project
    const draft = ctx.run.draftMarkdown ?? ''
    if (draft.trim() === '') {
      throw new StageRuntimeError(409, 'DOCUMENT_EMPTY', 'the stage document is empty; nothing to complete with')
    }

    // One transaction: document (approved) + checklist evidence + run completed,
    // so a failure cannot leave half a completion behind (AR-04).
    const summary = this.buildSummary(ctx.run, decision, note, review) + renderCoverageSummary(coverage, coverageWaiverReason)
    ctx.assertLease()
    let document: ProjectDocument
    try {
      document = await this.workspace.addDocument({
        project,
        stage: this.definition.stage,
        kind: this.definition.artifact.kind,
        title: this.definition.artifact.title,
        filename: `${this.definition.artifact.fileStem}-${ctx.run.id}.md`,
        mimeType: 'text/markdown',
        buffer: Buffer.from(draft, 'utf8'),
        stageRunId: ctx.run.id,
        completeRun: {
          summaryMarkdown: summary,
          checklistKeys: this.definition.artifact.checklistKeys,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new StageRuntimeError(
        409,
        'DOCUMENT_WRITE_FAILED',
        `could not store the stage document under ${project.rootPath}: ${message}`,
      )
    }
    await this.appendRunEvent(project.id, ctx.run.id, 'document_created', {
      documentId: document.id,
      kind: document.kind,
      storagePath: document.storagePath,
    })
    this.traces.recordDocument(ctx.span, document.kind, document.storagePath)

    try {
      const exported = await this.exportDocument(project, ctx.run.stage, project.name, document, draft, `Approved — ${decision.replace('_', '-')}`)
      await this.appendRunEvent(project.id, ctx.run.id, 'document_exported', exported)
      this.log.info({ event: 'stage.document.exported', ...exported })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log.warn({ event: 'stage.document.export_failed', err: error })
      await this.appendRunEvent(project.id, ctx.run.id, 'document_export_failed', { message }, 'warn')
    }

    if (this.indexDocument !== undefined) {
      void this.indexDocument(project, document).catch((error: unknown) => {
        this.log.warn({ event: 'stage.run.document_index_failed', documentId: document.id, err: error })
      })
    }

    const decisionLine = decision.replace('_', '-')
    const trimmedNote = note?.trim()
    ctx.run = { ...ctx.run, status: 'completed', pendingGate: null, summaryMarkdown: summary }
    await this.appendRunEvent(project.id, ctx.run.id, 'human_decision', {
      decision,
      note: trimmedNote ?? null,
      ...(coverageWaiverReason === undefined ? {} : { coverageWaiver: { reason: coverageWaiverReason, findings: coverage?.findings.filter((finding) => finding.severity === 'blocking') } }),
    })
    this.traces.recordHumanDecision(project.id, ctx.run.id, decision)
    this.log.info({ event: 'stage.run.completed', decision, documentId: document.id })
    return (await this.workspace.getStageRunDetail(ctx.run.id))!
  }

  private async runRole(
    role: StageRole,
    prompt: string,
    cwd: string,
    runId: string,
    projectId: string,
    parentSpan?: TraceSpan,
  ): Promise<string> {
    const started = Date.now()
    const roleSpan = this.traces.startRole({
      ...(parentSpan !== undefined ? { parent: parentSpan } : {}),
      projectId,
      runId,
      role,
      prompt,
      timeoutMs: this.roleTimeoutMs,
    })
    const sink = new StageEventSink({
      workspace: this.workspace,
      projectId,
      stageRunId: runId,
      role,
      logger: this.log.child({ component: 'stage-event-sink' }),
    })
    const pin = this.pins.get(runId)
    // A bound run uses exactly what it started with: an agent assigned later must
    // not join a run mid-flight, and an agent removed later must not vanish.
    const bound = this.runBindings.get(runId)
    const composition = bound !== undefined && bound !== null
      ? (bound.agents[role] ?? undefined)
      : this.agents === undefined
        ? undefined
        : await this.agents.composition({ projectId, stage: this.definition.stage, process: role })
    // An agent may run a different model from the Factory target. Price and
    // measure this role as the model that actually ran (AR-02), never as another's.
    const attribution = pin === undefined
      ? null
      : (pin.attributionFor?.(composition?.model ?? undefined) ?? pin.attribution)
    await sink.append('role_start', {
      role,
      timeoutMs: this.roleTimeoutMs,
      model: roleModel(attribution),
      ...(composition === undefined ? {} : { agent: composition.name, agentId: composition.id }),
    })
    if (attribution !== null && attribution.price === null) {
      // Unknown cost must be visible, not silently billed at another model's price.
      await sink.append('model_unpriced', { role, model: attribution.model, provider: attribution.provider }, 'warn')
      this.log.warn({
        event: 'stage.role.model_unpriced',
        role,
        provider: attribution.provider,
        model: attribution.model,
      }, 'this model has no price in the catalogue; its cost will be reported as unknown')
    }
    this.log.info({ event: 'stage.role.started', role, timeoutMs: this.roleTimeoutMs, agent: composition?.name })
    let agentPatch: string | null = null
    try {
      if (this.runPrompt !== undefined) {
        const text = await this.runPrompt(role, prompt, cwd)
        await sink.append('role_end', { role, durationMs: Date.now() - started })
        this.traces.completeRole(roleSpan, text)
        return text
      }

      // The primary attempt uses the run's pin; a fallback gets its own (AR-03).
      const candidates = this.candidatesFor(runId)
      let lastError: unknown = null
      for (const [index, candidate] of candidates.entries()) {
        const isPrimary = index === 0
        let attemptPin: ModelPin | undefined = isPrimary ? pin : undefined
        let temporaryPin: ModelPin | undefined
        const health = this.modelHealth === undefined ? null : await this.modelHealth(candidate.provider)
        if (health !== null && !health.tryAcquire()) {
          await sink.append('role_fallback_skipped', {
            role,
            provider: candidate.provider,
            model: candidate.model,
            reason: 'breaker_open',
          }, 'warn')
          this.log.warn({ event: 'stage.role.fallback_skipped', role, provider: candidate.provider })
          continue
        }

        try {
          if (!isPrimary) {
            temporaryPin = await this.pinTargetFor(candidate)
            attemptPin = temporaryPin
          }
          const attemptAttribution = attemptPin === undefined
            ? null
            : (attemptPin.attributionFor?.(composition?.model ?? undefined) ?? attemptPin.attribution)
          if (agentPatch === null && composition !== undefined) {
            agentPatch = await this.writeAgentPatch(cwd, composition, attemptPin)
          }
          const harness = attemptPin !== undefined
            ? attemptPin.harness(cwd, this.roleTimeoutMs, agentPatch)
            : this.harnessFactory(cwd, this.roleTimeoutMs)
          this.activeHarness = harness
          const result = await harness.run(prompt, {
            onEvent: (event) => {
              const phase = 'phase' in event && typeof event.phase === 'string' ? event.phase : null
              // Usage is stamped with the model that actually ran and the price in
              // force for it, so a fallback is never billed as the primary.
              void sink.append(event.type, attributeUsage(event, attemptAttribution), phase)
              this.traces.recordHarnessEvent(roleSpan, event)
            },
          })
          health?.recordSuccess()
          await sink.append('role_end', {
            role,
            durationMs: Date.now() - started,
            textLength: result.text.length,
            ...(result.stderr === '' ? {} : { stderr: result.stderr.slice(0, 8_000) }),
            ...(isPrimary ? {} : { model: roleModel(attemptAttribution), fallback: true }),
          })
          this.log.info({
            event: 'stage.role.completed',
            role,
            durationMs: Date.now() - started,
            textLength: result.text.length,
            fallback: !isPrimary,
          })
          this.traces.completeRole(roleSpan, result.text)
          return result.text
        } catch (error) {
          lastError = error
          const message = error instanceof Error ? error.message : String(error)
          const classified = classifyHarnessError(message)
          health?.recordFailure(error)
          const next = candidates[index + 1]
          if (!classified.retryable || next === undefined) {
            throw error
          }
          await sink.append('role_fallback', {
            role,
            from: { provider: candidate.provider, model: candidate.model },
            to: { provider: next.provider, model: next.model },
            kind: classified.kind,
            message: message.slice(0, 500),
          }, 'warn')
          this.log.warn({
            event: 'stage.role.fallback',
            role,
            from: candidate.provider,
            to: next.provider,
            kind: classified.kind,
          })
        } finally {
          temporaryPin?.release()
        }
      }
      throw lastError ?? new Error('no model candidate was available')
    } catch (error) {
      this.traces.failRole(roleSpan, error)
      const message = error instanceof Error ? error.message : String(error)
      await sink.append('role_error', {
        role,
        durationMs: Date.now() - started,
        message,
      })
      this.log.error({ event: 'stage.role.failed', role, durationMs: Date.now() - started, err: error })
      throw new StageRuntimeError(502, 'STAGE_ROLE_FAILED', `${role} failed: ${message}`)
    } finally {
      this.activeHarness = null
      if (agentPatch !== null) {
        const cleanup = this.agentCleanup.get(agentPatch)
        this.agentCleanup.delete(agentPatch)
        if (cleanup !== undefined) await cleanup()
        else await rm(agentPatch, { force: true }).catch(() => {})
      }
}
  }

  /**
   * The model candidates for a run, primary first (AR-03).
   *
   * A bound run has its own chain; without a target there is one implicit
   * candidate (the harness profile default) and nothing to fall back to.
   */
  private candidatesFor(runId: string): Array<{ provider: string; model: string }> {
    const bound = this.runBindings.get(runId)
    const target = bound?.model ?? null
    if (target === null) {
      const current = this.currentTarget?.() ?? null
      if (current === null) return [{ provider: '', model: '' }]
      return [{ provider: current.provider, model: current.model }, ...current.fallback]
    }
    return [{ provider: target.provider, model: target.model }, ...target.fallback]
  }

  /** Pin a fallback candidate for one attempt. */
  private async pinTargetFor(candidate: { provider: string; model: string }): Promise<ModelPin | undefined> {
    if (candidate.provider === '' || this.pinTarget === undefined) return undefined
    return this.pinTarget({ provider: candidate.provider, model: candidate.model, fallback: [] })
  }

  /** Materialise an agent's composition for one role run. */
  private async writeAgentPatch(cwd: string, composition: AgentComposition, pin: ModelPin | undefined): Promise<string> {
    const materialised = await materialiseAgent(cwd, composition, {
      ...(pin?.attribution !== null && pin?.attribution !== undefined
        ? { provider: pin.attribution.provider, model: pin.attribution.model }
        : {}),
      ...(pin?.routes !== null && pin?.routes !== undefined ? { routes: pin.routes } : {}),
      ...(this.profileToolRows !== undefined ? { profileToolRows: this.profileToolRows } : {}),
    })
    this.agentCleanup.set(materialised.patchPath, materialised.cleanup)
    return materialised.patchPath
  }

  /**
   * Render the stage document to PDF and write it into the project's documents
   * tree. Throws on failure; callers decide whether that is fatal.
   */
  private async exportDocument(
    project: Project,
    stage: ProjectStage,
    projectName: string,
    document: ProjectDocument,
    markdown: string,
    statusNote?: string,
  ): Promise<{ path: string; bytes: number; documentId: string }> {
    if (markdown.trim() === '') {
      throw new StageRuntimeError(409, 'DOCUMENT_EMPTY', 'the stage document is empty; nothing to export')
    }
    // Planning keeps its established deliverable name; every other stage is
    // titled by its own artifact, so a requirements PDF is not a "TELOS" report.
    const title = stage === 'planning' ? TELOS_REPORT_TITLE : this.definition.artifact.title
    const target = exportTarget({ projectRoot: project.rootPath, stage, title, projectName })
    const bytes = await this.renderPdf({
      title,
      projectName,
      stageLabel: STAGE_LABELS[stage],
      generatedAt: new Date().toISOString(),
      markdown,
      ...(statusNote !== undefined ? { statusNote } : {}),
    })
    const written = await writeExport(target, bytes)
    await this.workspace.recordDocumentExport({
      documentId: document.id,
      projectId: project.id,
      path: written.relativePath,
      bytes: written.bytes,
    })
    return { path: written.relativePath, bytes: written.bytes, documentId: document.id }
  }

  /** Re-render and overwrite the exported PDF for a finished stage run. */
  async exportRun(runId: string): Promise<{ path: string; bytes: number; documentId: string }> {
    const detail = await this.get(runId)
    const project = await this.projects.get(detail.projectId)
    const document = detail.documents.find((item) => item.kind === this.definition.artifact.kind)
    if (document === undefined) {
      throw new StageRuntimeError(409, 'DOCUMENT_NOT_READY', 'the stage has not produced its document yet')
    }
    const markdown = detail.draftMarkdown ?? ''
    if (markdown.trim() === '') {
      throw new StageRuntimeError(409, 'DOCUMENT_NOT_READY', 'the stage document is empty; nothing to export')
    }
    try {
      return await this.exportDocument(project, detail.stage, project.name, document, markdown)
    } catch (error) {
      if (error instanceof StageRuntimeError) throw error
      throw new StageRuntimeError(
        500,
        'PDF_EXPORT_FAILED',
        `could not produce the PDF: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async appendRunEvent(
    projectId: string,
    runId: string,
    type: string,
    payload: unknown,
    level?: 'debug' | 'info' | 'warn' | 'error',
  ): Promise<void> {
    try {
      await this.workspace.appendStageRunEvent({
        projectId,
        stageRunId: runId,
        type,
        ...(level !== undefined ? { level } : {}),
        payload,
      })
    } catch (error) {
      this.log.warn({ event: 'stage.event.write_failed', eventType: type, err: error })
    }
  }

  /** The run summary written in the completion transaction. */
  private buildSummary(
    run: StageRun,
    decision: HumanDecision,
    note: string | undefined,
    review: StageReviewResult,
  ): string {
    const decisionLine = decision.replace('_', '-')
    const trimmedNote = note?.trim()
    const findings = review.findings.length === 0
      ? '- none'
      : review.findings.map((item) => `- ${JSON.stringify(item)}`).join('\n')
    return [
      `# ${STAGE_LABELS[run.stage]} — stage summary`,
      '',
      'Status: completed',
      '',
      '## Analysis',
      '',
      (run.analysisMarkdown ?? '').trim(),
      '',
      '## Review',
      '',
      `Decision: ${review.decision}`,
      '',
      'Findings:',
      findings,
      '',
      '## Human decision',
      '',
      `Decision: **${decisionLine}**`,
      trimmedNote !== undefined && trimmedNote !== '' ? `\n${trimmedNote}\n` : '',
      '',
    ].join('\n')
  }

  private async markPlanningEvidence(projectId: string, document: ProjectDocument): Promise<void> {
    for (const key of this.definition.artifact.checklistKeys) {
      // The decision item is set by the completion transaction, not here.
      if (key === 'feasibility_decision') continue
      await this.workspace.updateChecklistItem(projectId, this.definition.stage, key, 'done', document.id)
    }
  }

  /**
   * Each engine drives exactly one stage. Asking it for another is a programming
   * error, not an empty result, so it says which stage it does drive.
   */
  private assertExecutable(stage: string): asserts stage is ProjectStage {
    if (stage !== this.definition.stage) {
      throw new StageRuntimeError(
        501,
        'STAGE_NOT_IMPLEMENTED',
        `this engine drives the ${this.definition.stage} stage, not ${stage}`,
      )
    }
  }
}

async function assertProjectRoot(project: Project): Promise<void> {
  try {
    const info = await stat(project.rootPath)
    if (!info.isDirectory()) throw new Error('not a directory')
    await access(project.rootPath, 2)
  } catch {
    throw new StageRuntimeError(
      409,
      'PROJECT_ROOT_NOT_WRITABLE',
      `project root is not writable: ${project.rootPath}`,
    )
  }
}

export function buildContextPacket(
  project: Project,
  snapshot: ProjectWorkspaceSnapshot,
  priorStages: Array<{ stage: ProjectStage; summary: string; completedAt: string | null }>,
  input: string | null,
  maxReviewCycles = DEFAULT_MAX_REVIEW_CYCLES,
  attachments: ContextAttachment[] = [],
  acceptance: { minRating: number; maxBlockers: number; maxMajor: number } = { minRating: 0, maxBlockers: 0, maxMajor: 0 },
  readiness?: { evaluatedAt: string; prerequisites: Array<{ key: string; satisfied: boolean; evidence: unknown }> },
  definition: StageDefinition = PLANNING_DEFINITION,
): StageContextPacket {
  return {
    schemaVersion: 1,
    project: {
      id: project.id,
      name: project.name,
      rootPath: project.rootPath,
      organization: project.organization,
      ownerEmail: project.ownerEmail,
      status: project.status,
      currentStage: project.currentStage,
    },
    stage: {
      key: definition.stage,
      checklist: snapshot.checklist.filter((item) => item.stage === definition.stage),
      documents: snapshot.documents.filter((item) => item.stage === definition.stage),
    },
    priorStages,
    documents: snapshot.documents,
    attachments,
    input,
    ...(readiness === undefined
      ? {}
      : { readiness: { evaluatedAt: readiness.evaluatedAt, prerequisites: readiness.prerequisites } }),
    constraints: {
      maxReviewCycles,
      minRating: acceptance.minRating,
      maxBlockers: acceptance.maxBlockers,
      maxMajor: acceptance.maxMajor,
      documentKind: definition.artifact.kind,
      cardinality: 'one',
    },
  }
}

export function hashContext(context: StageContextPacket): string {
  return createHash('sha256').update(JSON.stringify(context)).digest('hex')
}

/**
 * The context with attachment text removed, for prompts that carry the documents
 * in a readable section instead. Avoids sending the same text twice.
 */
export function contextWithoutAttachmentText(context: StageContextPacket): Omit<StageContextPacket, 'attachments'> & {
  attachments: Array<Omit<ContextAttachment, 'text'>>
} {
  return {
    ...context,
    attachments: context.attachments.map(({ text: _text, ...meta }) => meta),
  }
}

/** The stage inputs, or an explicit note when there are none. */
export function attachmentSection(context: StageContextPacket): string {
  const rendered = renderAttachmentPrompt(context.attachments)
  return rendered === '' ? 'INPUT DOCUMENTS\nThe requester attached no documents for this stage.' : rendered
}

export function buildAnalyzerPrompt(project: Project, context: StageContextPacket): string {
  return `STAGE_ROLE: analyzer
You are the Planning & Feasibility analyzer for an AI software delivery factory.

Analyze the project facts and the requester's input for a single TELOS feasibility report. Do not write the report itself. Identify:
1. the high-level business idea, problem and proposed product;
2. stakeholder goals, success measures and constraints;
3. available evidence for Technical, Economic, Legal, Operational and Schedule feasibility;
4. gaps, ambiguities and questions that must be resolved before a go/no-go recommendation.

Use only the facts below. Mark missing evidence as a gap; do not invent budgets, dates or approvals.
Return concise Markdown with headings for the five TELOS dimensions.

PROJECT: ${project.name}

${attachmentSection(context)}

CONTEXT:
${JSON.stringify(contextWithoutAttachmentText(context), null, 2)}`
}

export function buildAuthorPrompt(
  project: Project,
  context: StageContextPacket,
  analysis: string,
): string {
  return `STAGE_ROLE: author
You are the Planning & Feasibility author for ${project.name}.

Write the ONE TELOS feasibility report. Follow the template exactly. Use the analysis and facts below; do not invent evidence. Where evidence is missing, state the gap and the question that must be answered. End with a clear Go, Conditional go or No-go recommendation and conditions.

Return only the Markdown report, without a code fence and without an SRS or functional specification.

ANALYSIS:
${analysis}

TEMPLATE:
${TELOS_TEMPLATE}

${attachmentSection(context)}

CONTEXT:
${JSON.stringify(contextWithoutAttachmentText(context), null, 2)}`
}

export function buildReviewerPrompt(
  project: Project,
  context: StageContextPacket,
  draft: string,
  settings?: PlanningStageSettings,
): string {
  const criteria = settings ?? { ...DEFAULT_PLANNING_STAGE_SETTINGS, ...settingsFromContext(context) }
  const ratingRule = `Rate the document 0-100 for whether it is ready to send to the sponsor. The run stops revising as soon as ALL of these hold:
- overall rating >= ${criteria.minRating}
- blocker findings <= ${criteria.maxBlockers}
- major findings <= ${criteria.maxMajor}`
  const reviewContext = {
    project: {
      name: project.name,
      organization: project.organization,
      ownerEmail: project.ownerEmail,
    },
    stage: {
      key: context.stage.key,
      checklist: context.stage.checklist,
      input: context.input,
      constraints: context.constraints,
    },
    priorStages: context.priorStages,
    documents: context.documents.map((document) => ({
      kind: document.kind,
      title: document.title,
      storagePath: document.storagePath,
      status: document.status,
    })),
    attachments: context.attachments.map(({ text: _text, ...meta }) => meta),
  }

  return `STAGE_ROLE: reviewer
You are the independent Planning & Feasibility reviewer for ${project.name}. You did not write this draft.

Evaluate the single TELOS report against the template and evidence. Check that:
- business idea, stakeholder goals and success measures are explicit;
- each of Technical, Economic, Legal, Operational and Schedule feasibility is addressed;
- assumptions, risks and missing evidence are not hidden;
- the recommendation is justified by the evidence;
- no SRS/functional specification has been substituted for the feasibility report.

${ratingRule}

Return ONLY JSON:
{
  "decision": "approved" | "needs_revision" | "rejected",
  "rating": <integer 0-100>,
  "findings": [
    {
      "id": "F-001",
      "severity": "blocker" | "major" | "minor",
      "section": "...",
      "finding": "...",
      "required_change": "..."
    }
  ]
}

Approve only if there are no blocker or major findings. If not approved, include actionable required changes.

DRAFT:
${draft}

${attachmentSection(context)}

REVIEW CONTEXT:
${JSON.stringify(reviewContext, null, 2)}`
}

export function buildRevisionPrompt(
  project: Project,
  context: StageContextPacket,
  analysis: string,
  draft: string,
  findings: unknown[],
): string {
  return `STAGE_ROLE: author
Revise the one TELOS feasibility report for ${project.name} using the reviewer findings below.

Address every blocker and major finding. Keep the template structure. Do not add evidence that does not exist. Return only the complete revised Markdown report, without a code fence.

FINDINGS:
${JSON.stringify(findings, null, 2)}

CURRENT DRAFT:
${draft}

ANALYSIS:
${analysis}

${attachmentSection(context)}

CONTEXT:
${JSON.stringify(contextWithoutAttachmentText(context), null, 2)}`
}

export function parseStageReview(raw: string): StageReviewResult {
  const text = raw.trim()
  if (text === '') throw new StageRuntimeError(502, 'EMPTY_REVIEW', 'reviewer returned an empty response')
  const candidates = [text]
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim())
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))

  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      if (!['approved', 'needs_revision', 'rejected'].includes(String(record.decision))) continue
      const findings = Array.isArray(record.findings) ? record.findings : []
      const rawRating = record.rating
      const rating = typeof rawRating === 'number' && Number.isFinite(rawRating)
        ? Math.round(Math.min(100, Math.max(0, rawRating)))
        : null
      return {
        decision: record.decision as StageReviewDecision,
        findings,
        rating,
      }
    } catch {
      // Try the next candidate.
    }
  }
  throw new StageRuntimeError(502, 'INVALID_REVIEW', 'reviewer response was not valid JSON')
}

export function cleanMarkdown(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i)
  return (fenced?.[1] ?? trimmed).trim()
}

function safeCycle(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

export interface LeaseContext {
  run: StageRun
  project: Project
  context: StageContextPacket
  span?: TraceSpan
  assertLease(): void
  update(patch: StageRunPatch): Promise<StageRun>
}

/** Summary shown while a run waits at a gate. */
/** Size and digest of a draft, so every record names the version it describes. */
export function describeDraft(draft: string): { chars: number; sha256: string } {
  return { chars: draft.length, sha256: createHash('sha256').update(draft, 'utf8').digest('hex') }
}

function renderCoverageSummary(coverage?: RequirementsCoverageReport, waiverReason?: string): string {
  if (coverage === undefined) return ''
  const blocking = coverage.findings.filter((finding) => finding.severity === 'blocking').length
  return [
    '', '## Requirements coverage', '',
    `${coverage.counts.totalRequirements} requirements; ${coverage.counts.withAcceptanceCriteria} with acceptance criteria, ${coverage.counts.withSource} with a source, ${coverage.counts.withGoal} with a goal.`,
    ...(coverage.counts.priorities === undefined ? [] : [
      `Priorities (MoSCoW): ${coverage.counts.priorities.must} must, ${coverage.counts.priorities.should} should, ${coverage.counts.priorities.could} could, ${coverage.counts.priorities.wont} won't; ${coverage.counts.businessRules ?? 0} business rule(s).`,
    ]),
    `${blocking} blocking, ${coverage.findings.length - blocking} advisory.`,
    ...coverage.findings.map((finding) => `- **${finding.severity}:** ${finding.message}`),
    ...(waiverReason === undefined ? [] : ['', `Coverage waiver reason: ${waiverReason}`]),
    '',
  ].join('\n')
}

export function buildGateSummary(
  analysis: string,
  review: StageReviewResult | undefined,
  cycle: number,
  maxCycles: number,
  kind: 'review' | 'final',
  acceptance?: ReviewAcceptance,
  stageLabel: string = STAGE_LABELS.planning,
): string {
  const findings = review === undefined || review.findings.length === 0
    ? '- none'
    : review.findings.map((item) => `- ${JSON.stringify(item)}`).join('\n')
  return `# ${stageLabel} — awaiting human

${kind === 'review'
  ? `The reviewer requested changes (cycle ${cycle} of up to ${maxCycles}). Apply them or accept the draft as it is.`
  : `The draft is ready. Complete the stage, or refine it further.`}

## Analysis

${analysis.trim()}

## Review

Decision: ${review?.decision ?? 'unknown'}${acceptance === undefined ? '' : `\n${acceptanceLine(acceptance)}${acceptance.accepted ? '\nAcceptance criteria: **met**' : '\nAcceptance criteria: not met'}`}

Findings:
${findings}
`
}

export function buildStageSummary(
  analysis: string,
  review: StageReviewResult | undefined,
  document: ProjectDocument,
  stageLabel: string = STAGE_LABELS.planning,
): string {
  return `# ${stageLabel} — stage summary

Status: awaiting human decision

## Analysis

${analysis.trim()}

## Review

Decision: ${review?.decision ?? 'unknown'}

Findings:
${review === undefined ? '- none' : review.findings.length === 0 ? '- none' : review.findings.map((item) => `- ${JSON.stringify(item)}`).join('\n')}

## Artifact

- ${document.title}: \`${document.storagePath}\`
`
}

/** Re-exported for route validation and tests. */
export { SDLC_STAGES }

/**
 * Classify a harness failure for failover (AR-03).
 *
 * The harness reports a structured code for its own errors but a plain message
 * for transport and provider failures, so this reads what is available. Only
 * failures another model could plausibly avoid are retryable: an abort or a
 * content filter is a decision, not an outage.
 */
export function classifyHarnessError(message: string): { kind: string; retryable: boolean } {
  if (/cancel|abort/i.test(message)) return { kind: 'aborted', retryable: false }
  if (/content.?filter|refus/i.test(message)) return { kind: 'content_filter', retryable: false }
  if (/MISSING_CREDENTIAL|no API key|cannot start/i.test(message)) return { kind: 'unconfigured', retryable: true }
  if (/RATE_LIMIT|429|quota/i.test(message)) return { kind: 'rate_limited', retryable: true }
  if (/TIMEOUT|timed out/i.test(message)) return { kind: 'timeout', retryable: true }
  if (/TRANSPORT|ECONN|ENOTFOUND|EAI_AGAIN|socket|connection|HTTP 5\d\d/i.test(message)) {
    return { kind: 'unavailable', retryable: true }
  }
  return { kind: 'unknown', retryable: true }
}

/**
 * A {@link StageEngine} that drives the planning stage.
 *
 * Kept so existing callers and tests read naturally; it is the same engine with
 * the planning definition supplied by default.
 */
export class PlanningStageRuntime extends StageEngine {}
