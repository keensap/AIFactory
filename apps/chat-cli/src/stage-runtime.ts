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
import { buildAgentPatch } from './agent-patch.ts'
import type { AgentComposition } from './agents.ts'
import type { DshHarness } from './harness.ts'
import { StageEventSink } from './stage-event-sink.ts'
import { attributeUsage, roleModel, type ModelPin } from './models/index.ts'
import { addLogContext, noopLogger, runWithLogContext, type Logger } from './logging/index.ts'
import { noopProvider, type TraceRecorder, type TraceSpan } from './observability/index.ts'
import type { Project, ProjectService } from './projects.ts'
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

export type HumanDecision = 'go' | 'conditional_go' | 'no_go'

export interface StageRuntimeDeps {
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
  stageSettings?: { planning(projectId: string): Promise<PlanningStageSettings> }
  /** Refuses to start a run when the stage's prerequisites are not met. */
  prerequisites?: { ensureReady(projectId: string, stage: ProjectStage, options?: { incomingBrief?: boolean }): Promise<unknown> }
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
  /** Requester-supplied PDFs and their extracted text. */
  attachments: ContextAttachment[]
  input: string | null
  constraints: {
    maxReviewCycles: number
    /** Pause after every review and ask before applying its changes. */
    gateAfterEachReview: boolean
    /** Acceptance criteria for stopping the revision loop early. */
    minRating: number
    maxBlockers: number
    maxMajor: number
    documentKind: string
    cardinality: 'one'
  }
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

export class PlanningStageRuntime {
  private readonly projects: ProjectService
  private readonly workspace: PostgresProjectWorkspace
  private readonly harnessFactory: (cwd?: string, timeoutMs?: number) => DshHarness
  private readonly runPrompt?: (role: StageRole, prompt: string, cwd: string) => Promise<string>
  private readonly agents?: { composition(input: { projectId: string; stage: string; process: string }): Promise<AgentComposition | undefined> }
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
  private readonly stageSettings?: { planning(projectId: string): Promise<PlanningStageSettings> }
  private readonly prerequisites?: { ensureReady(projectId: string, stage: ProjectStage, options?: { incomingBrief?: boolean }): Promise<unknown> }
  /** Model pins of runs currently executing, by run id. */
  private readonly pins = new Map<string, ModelPin>()

  constructor(deps: StageRuntimeDeps) {
    if (deps.pinModel !== undefined) this.pinModel = deps.pinModel
    this.renderPdf = deps.renderPdf ?? renderReportPdf
    if (deps.stageSettings !== undefined) this.stageSettings = deps.stageSettings
    if (deps.prerequisites !== undefined) this.prerequisites = deps.prerequisites
    this.projects = deps.projects
    this.workspace = deps.workspace
    this.harnessFactory = deps.harnessFactory
    this.runPrompt = deps.runPrompt
    if (deps.agents !== undefined) this.agents = deps.agents
    this.maxReviewCycles = deps.maxReviewCycles ?? DEFAULT_MAX_REVIEW_CYCLES
    this.roleTimeoutMs = deps.roleTimeoutMs ?? 300_000
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
    this.assertPlanning(input.stage)
    const project = await this.projects.get(input.projectId)
    await assertProjectRoot(project)
    // Prerequisites are evidence, not "the previous stage ran", so a project can
    // start here when the inputs exist (or were waived).
    if (this.prerequisites !== undefined) {
      await this.prerequisites.ensureReady(project.id, PLANNING_STAGE, {
        incomingBrief: (input.brief ?? '').trim() !== '',
      })
    }
    const snapshot = await this.workspace.getSnapshot(project.id)
    const priorStages = await this.workspace.getPriorStageSummaries(project.id, PLANNING_STAGE)
    const attachments = await this.loadAttachments(project, input.attachmentIds ?? [])
    const settings = await this.resolveSettings(project.id)
    const context = buildContextPacket(
      project,
      snapshot,
      priorStages,
      input.brief ?? null,
      settings.maxReviewCycles,
      attachments,
      settings.gateAfterEachReview,
      { minRating: settings.minRating, maxBlockers: settings.maxBlockers, maxMajor: settings.maxMajor },
    )
    const run = await this.workspace.createStageRun({
      projectId: project.id,
      stage: PLANNING_STAGE,
      inputText: input.brief ?? null,
      context,
      contextHash: hashContext(context),
    })
    if (attachments.length > 0) {
      await this.workspace.linkRunAttachments(run.id, attachments.map((attachment) => attachment.id))
    }
    return (await this.workspace.getStageRunDetail(run.id))!
  }

  /**
   * Load and validate the run's inputs. Attachments belong to the project, so an
   * id from another project is rejected rather than silently ignored.
   */
  private async loadAttachments(project: Project, ids: string[]): Promise<ContextAttachment[]> {
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
      const resolved = await this.stageSettings.planning(projectId)
      return {
        gateAfterEachReview: resolved.gateAfterEachReview,
        maxReviewCycles: resolved.maxReviewCycles,
        minRating: resolved.minRating,
        maxBlockers: resolved.maxBlockers,
        maxMajor: resolved.maxMajor,
      }
    } catch (error) {
      // Settings must never stop a run; fall back to the built-in defaults.
      this.log.warn({ event: 'stage.settings.unavailable', err: error })
      return { ...DEFAULT_PLANNING_STAGE_SETTINGS }
    }
  }

  async list(projectId: string, stage: string): Promise<StageRun[]> {
    this.assertPlanning(stage)
    await this.projects.get(projectId)
    return this.workspace.listStageRuns(projectId, PLANNING_STAGE)
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
   * Answer a review gate: apply its findings (revise, then review again) or
   * accept the draft as it is (skip to the final gate).
   */
  async answerGate(runId: string, action: 'apply' | 'accept'): Promise<StageRunDetail> {
    if (action !== 'apply' && action !== 'accept') {
      throw new StageRuntimeError(400, 'INVALID_GATE_ACTION', 'action must be "apply" or "accept"')
    }
    const run = await this.requireRun(runId)
    const gate = run.pendingGate
    if (run.status !== 'awaiting_human' || gate === null || gate.kind !== 'review_changes') {
      throw new StageRuntimeError(409, 'STAGE_RUN_NOT_AT_REVIEW_GATE', 'this run is not waiting on a review gate')
    }
    return runWithLogContext(
      { projectId: run.projectId, stageRunId: run.id, stage: run.stage },
      () => this.withLease(run.id, async (ctx) => {
        const settings = settingsFromContext(ctx.context)
        const review: StageReviewResult = { decision: gate.reviewDecision as StageReviewDecision, findings: gate.findings }
        await this.appendRunEvent(ctx.project.id, ctx.run.id, 'gate_decision', { gate: 'review_changes', action }, 'info')
        this.log.info({ event: 'stage.gate.answered', gate: 'review_changes', action })

        if (action === 'accept') {
          // The operator overrides the reviewer: skip straight to the final gate.
          return this.pauseAtFinalGate(ctx, ctx.run.draftMarkdown ?? '', safeCycle(ctx.run.reviewCycles), review, settings)
        }
        const cycle = safeCycle(ctx.run.reviewCycles) + 1
        const draft = await this.reviseOnce(ctx, ctx.run.draftMarkdown ?? '', ctx.run.analysisMarkdown ?? '', gate.findings)
        await ctx.update({ reviewCycles: cycle, draftMarkdown: draft, pendingGate: null })
        return this.reviewAndContinue(ctx, draft, ctx.run.analysisMarkdown ?? '', cycle, settings)
      }),
    )
  }

  /**
   * The final gate: stop refining and complete the stage (with the go /
   * conditional-go / no-go decision), or ask for one more refinement pass.
   * Completion is the only point where the document and its PDF are produced.
   */
  async decide(runId: string, input: {
    decision?: HumanDecision
    refine?: boolean
    note?: string
  }): Promise<StageRunDetail> {
    const run = await this.requireRun(runId)
    const gate = run.pendingGate
    if (run.status !== 'awaiting_human' || gate === null || gate.kind !== 'final') {
      throw new StageRuntimeError(409, 'STAGE_RUN_NOT_AWAITING_DECISION', 'this run is not waiting on a final decision')
    }
    const refine = input.refine === true
    if (!refine && !['go', 'conditional_go', 'no_go'].includes(input.decision ?? '')) {
      throw new StageRuntimeError(400, 'INVALID_HUMAN_DECISION', 'decision must be go, conditional_go or no_go')
    }

    return runWithLogContext(
      { projectId: run.projectId, stageRunId: run.id, stage: run.stage },
      () => this.withLease(run.id, async (ctx) => {
        const settings = settingsFromContext(ctx.context)
        const review: StageReviewResult = { decision: gate.reviewDecision as StageReviewDecision, findings: gate.findings }
        if (refine) {
          await this.appendRunEvent(ctx.project.id, ctx.run.id, 'gate_decision', { gate: 'final', refine: true }, 'info')
          return this.refineOnce(ctx, review, settings)
        }
        return this.completeRun(ctx, input.decision as HumanDecision, input.note, review)
      }),
    )
  }

  private async requireRun(runId: string): Promise<StageRun> {
    const run = await this.workspace.getStageRun(runId)
    if (run === undefined) throw new StageRuntimeError(404, 'STAGE_RUN_NOT_FOUND', 'stage run not found')
    if (run.stage !== PLANNING_STAGE) {
      throw new StageRuntimeError(501, 'STAGE_RUNTIME_NOT_IMPLEMENTED', 'only planning stage execution is implemented')
    }
    return run
  }

  // ---- lease, tracing and failure handling ------------------------------

  private async withLease<T>(runId: string, fn: (ctx: LeaseContext) => Promise<T>): Promise<T> {
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
    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          const renewed = await this.workspace.heartbeatStageRun(run.id, this.workerId, this.leaseMs)
          if (!renewed) {
            leaseLost = true
            this.log.warn({ event: 'stage.run.lease_lost', workerId: this.workerId })
          }
        } catch (error) {
          leaseLost = true
          this.log.warn({ event: 'stage.run.heartbeat_failed', workerId: this.workerId, err: error })
        }
      })()
    }, this.heartbeatMs)
    heartbeat.unref()

    let runSpan: TraceSpan | undefined
    try {
      const project = await this.projects.get(run.projectId)
      await assertProjectRoot(project)
      const pin = this.pinModel?.()
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
        },
        update: async (patch: StageRunPatch) => {
          const next = await this.workspace.updateStageRun(run.id, patch)
          ctx.run = next
          return next
        },
      }
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
      this.log.error({ event: 'stage.run.failed', err: error })
      const message = error instanceof Error ? error.message : String(error)
      await this.workspace.updateStageRun(run.id, {
        status: 'failed',
        summaryMarkdown: `# Planning & Feasibility run failed\n\n${message}\n`,
      }).catch(() => {})
      throw error
    } finally {
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
      analysis = await this.runRole('analyzer', buildAnalyzerPrompt(ctx.project, ctx.context), ctx.project.rootPath, ctx.run.id, ctx.project.id, ctx.span)
      await ctx.update({ analysisMarkdown: analysis })
    }
    if (draft.trim() === '') {
      await ctx.update({ status: 'drafting' })
      ctx.assertLease()
      draft = cleanMarkdown(await this.runRole('author', buildAuthorPrompt(ctx.project, ctx.context, analysis), ctx.project.rootPath, ctx.run.id, ctx.project.id, ctx.span))
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
  ): Promise<StageRunDetail> {
    const review = await this.reviewOnce(ctx, draft, settings)
    return this.afterReview(ctx, draft, analysis, cycle, settings, review)
  }

  private async afterReview(
    ctx: LeaseContext,
    draft: string,
    analysis: string,
    cycle: number,
    settings: PlanningStageSettings,
    review: StageReviewResult,
  ): Promise<StageRunDetail> {
    const acceptance = reviewAcceptance(review, settings)
    if (acceptance.accepted) {
      // The document meets the bar: stop revising and ask the human.
      return this.pauseAtFinalGate(ctx, draft, cycle, review, settings)
    }
    if (settings.gateAfterEachReview) {
      return this.pauseAtReviewGate(ctx, draft, cycle, review, settings)
    }
    if (cycle >= settings.maxReviewCycles) {
      // The automatic budget is spent; the operator decides whether to continue.
      return this.pauseAtFinalGate(ctx, draft, cycle, review, settings)
    }
    const next = cycle + 1
    const revised = await this.reviseOnce(ctx, draft, analysis, review.findings)
    await ctx.update({ reviewCycles: next, draftMarkdown: revised })
    return this.reviewAndContinue(ctx, revised, analysis, next, settings)
  }

  /** One more pass after the operator asked to refine: review, revise once, then the final gate. */
  private async refineOnce(ctx: LeaseContext, _previous: StageReviewResult, settings: PlanningStageSettings): Promise<StageRunDetail> {
    let draft = ctx.run.draftMarkdown ?? ''
    let cycle = safeCycle(ctx.run.reviewCycles)
    const review = await this.reviewOnce(ctx, draft, settings)
    const acceptance = reviewAcceptance(review, settings)
    if (!acceptance.accepted) {
      cycle += 1
      draft = await this.reviseOnce(ctx, draft, ctx.run.analysisMarkdown ?? '', review.findings)
      await ctx.update({ reviewCycles: cycle, draftMarkdown: draft })
    }
    return this.pauseAtFinalGate(ctx, draft, cycle, review, settings)
  }

  private async reviewOnce(ctx: LeaseContext, draft: string, settings: PlanningStageSettings): Promise<StageReviewResult> {
    await ctx.update({ status: 'reviewing' })
    ctx.assertLease()
    const rawReview = await this.runRole('reviewer', buildReviewerPrompt(ctx.project, ctx.context, draft, settings), ctx.project.rootPath, ctx.run.id, ctx.project.id, ctx.span)
    const review = parseStageReview(rawReview)
    await this.workspace.addStageReview({
      stageRunId: ctx.run.id,
      reviewerRole: 'planning_reviewer',
      decision: review.decision,
      findings: review.findings,
    })
    const acceptance = reviewAcceptance(review, settings)
    await this.appendRunEvent(ctx.project.id, ctx.run.id, 'review_decision', {
      decision: review.decision,
      rating: acceptance.rating,
      counts: acceptance.counts,
      accepted: acceptance.accepted,
      findings: review.findings,
    }, acceptance.accepted ? 'info' : 'warn')
    this.traces.recordReview(ctx.span, review.decision, review.findings.length)
    return review
  }

  private async reviseOnce(ctx: LeaseContext, draft: string, analysis: string, findings: unknown[]): Promise<string> {
    await ctx.update({ status: 'revising' })
    ctx.assertLease()
    const revised = cleanMarkdown(await this.runRole(
      'author',
      buildRevisionPrompt(ctx.project, ctx.context, analysis, draft, findings),
      ctx.project.rootPath,
      ctx.run.id,
      ctx.project.id,
      ctx.span,
    ))
    await ctx.update({ draftMarkdown: revised })
    return revised
  }

  // ---- gates ------------------------------------------------------------

  private async pauseAtReviewGate(
    ctx: LeaseContext,
    draft: string,
    cycle: number,
    review: StageReviewResult,
    settings: PlanningStageSettings,
  ): Promise<StageRunDetail> {
    const acceptance = reviewAcceptance(review, settings)
    const gate: PendingGate = {
      kind: 'review_changes',
      question: 'Apply the reviewer findings, or accept the draft as it is?',
      cycle,
      maxReviewCycles: settings.maxReviewCycles,
      gateAfterEachReview: settings.gateAfterEachReview,
      reviewDecision: review.decision,
      findings: review.findings,
      rating: acceptance.rating,
      counts: acceptance.counts,
      accepted: acceptance.accepted,
      criteria: acceptance.criteria,
      waitingSince: new Date().toISOString(),
    }
    await this.workspace.updateStageRun(ctx.run.id, {
      status: 'awaiting_human',
      pendingGate: gate,
      summaryMarkdown: buildGateSummary(ctx.run.analysisMarkdown ?? '', review, cycle, settings.maxReviewCycles, 'review', acceptance),
    })
    await this.appendRunEvent(ctx.project.id, ctx.run.id, 'review_gate', {
      cycle,
      decision: review.decision,
      findings: review.findings.length,
    })
    this.log.info({ event: 'stage.gate.review', cycle, decision: review.decision })
    return (await this.workspace.getStageRunDetail(ctx.run.id))!
  }

  private async pauseAtFinalGate(
    ctx: LeaseContext,
    draft: string,
    cycle: number,
    review: StageReviewResult,
    settings: PlanningStageSettings,
  ): Promise<StageRunDetail> {
    const acceptance = reviewAcceptance(review, settings)
    const gate: PendingGate = {
      kind: 'final',
      question: 'Complete the stage with this document, or refine it further?',
      cycle,
      maxReviewCycles: settings.maxReviewCycles,
      gateAfterEachReview: settings.gateAfterEachReview,
      reviewDecision: review.decision,
      findings: review.findings,
      rating: acceptance.rating,
      counts: acceptance.counts,
      accepted: acceptance.accepted,
      criteria: acceptance.criteria,
      waitingSince: new Date().toISOString(),
    }
    await this.workspace.updateStageRun(ctx.run.id, {
      status: 'awaiting_human',
      pendingGate: gate,
      summaryMarkdown: buildGateSummary(ctx.run.analysisMarkdown ?? '', review, cycle, settings.maxReviewCycles, 'final', acceptance),
    })
    await this.appendRunEvent(ctx.project.id, ctx.run.id, 'final_gate', { cycle, decision: review.decision })
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
  ): Promise<StageRunDetail> {
    const project = ctx.project
    const draft = ctx.run.draftMarkdown ?? ''
    if (draft.trim() === '') {
      throw new StageRuntimeError(409, 'DOCUMENT_EMPTY', 'the stage document is empty; nothing to complete with')
    }

    let document: ProjectDocument
    try {
      document = await this.workspace.addDocument({
        project,
        stage: PLANNING_STAGE,
        kind: TELOS_DOCUMENT_KIND,
        title: 'TELOS feasibility report',
        filename: `telos-${ctx.run.id}.md`,
        mimeType: 'text/markdown',
        buffer: Buffer.from(draft, 'utf8'),
        stageRunId: ctx.run.id,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new StageRuntimeError(
        409,
        'DOCUMENT_WRITE_FAILED',
        `could not store the TELOS document under ${project.rootPath}: ${message}`,
      )
    }
    await this.workspace.updateDocumentStatus(project.id, document.id, 'approved')
    await this.markPlanningEvidence(project.id, document)
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

    await this.workspace.updateChecklistItem(project.id, PLANNING_STAGE, 'feasibility_decision', 'done', document.id)
    const decisionLine = decision.replace('_', '-')
    const trimmedNote = note?.trim()
    const summary = `# Planning & Feasibility — stage summary

Status: completed

## Analysis

${(ctx.run.analysisMarkdown ?? '').trim()}

## Review

Decision: ${review.decision}

Findings:
${review.findings.length === 0 ? '- none' : review.findings.map((item) => `- ${JSON.stringify(item)}`).join('\n')}

## Artifact

- ${document.title}: \`${document.storagePath}\`

## Human decision

Decision: **${decisionLine}**
${trimmedNote !== undefined && trimmedNote !== '' ? `\n${trimmedNote}\n` : ''}
`
    ctx.assertLease()
    await ctx.update({ status: 'completed', pendingGate: null, summaryMarkdown: summary })
    await this.appendRunEvent(project.id, ctx.run.id, 'human_decision', {
      decision,
      note: trimmedNote ?? null,
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
    const composition = this.agents === undefined
      ? undefined
      : await this.agents.composition({ projectId, stage: PLANNING_STAGE, process: role })
    await sink.append('role_start', {
      role,
      timeoutMs: this.roleTimeoutMs,
      model: composition?.model ?? roleModel(pin?.attribution),
      ...(composition === undefined ? {} : { agent: composition.name, agentId: composition.id }),
    })
    this.log.info({ event: 'stage.role.started', role, timeoutMs: this.roleTimeoutMs, agent: composition?.name })
    let agentPatch: string | null = null
    try {
      if (this.runPrompt !== undefined) {
        const text = await this.runPrompt(role, prompt, cwd)
        await sink.append('role_end', { role, durationMs: Date.now() - started })
        this.traces.completeRole(roleSpan, text)
        return text
      }
      if (composition !== undefined) {
        agentPatch = await this.writeAgentPatch(cwd, composition, pin)
      }
      const harness = pin !== undefined
        ? pin.harness(cwd, this.roleTimeoutMs, agentPatch)
        : this.harnessFactory(cwd, this.roleTimeoutMs)
      const result = await harness.run(prompt, {
        onEvent: (event) => {
          const phase = 'phase' in event && typeof event.phase === 'string' ? event.phase : null
          // Usage events are stamped with the pinned model and the cost at the
          // price in force when the run started.
          void sink.append(event.type, attributeUsage(event, pin?.attribution ?? null), phase)
          this.traces.recordHarnessEvent(roleSpan, event)
        },
      })
      await sink.append('role_end', {
        role,
        durationMs: Date.now() - started,
        textLength: result.text.length,
        ...(result.stderr === '' ? {} : { stderr: result.stderr.slice(0, 8_000) }),
      })
      this.log.info({ event: 'stage.role.completed', role, durationMs: Date.now() - started, textLength: result.text.length })
      this.traces.completeRole(roleSpan, result.text)
      return result.text
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
      if (agentPatch !== null) await rm(agentPatch, { force: true }).catch(() => {})
      await sink.flush()
    }
  }

  /**
   * Materialise an agent's composition into a patch file for one role run, and
   * its skills as `SKILL.md` bundles the harness can discover.
   */
  private async writeAgentPatch(cwd: string, composition: AgentComposition, pin: ModelPin | undefined): Promise<string> {
    const base = join(cwd, '.aifactory', 'agents', composition.id)
    let skillsDir: string | undefined
    if (composition.skills.length > 0) {
      skillsDir = join(base, 'skills')
      for (const skill of composition.skills) {
        const dir = join(skillsDir, skill.name)
        await mkdir(dir, { recursive: true })
        const description = skill.description === '' ? skill.name : skill.description
        await writeFile(
          join(dir, 'SKILL.md'),
          `---\nname: ${skill.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${skill.instructions}\n`,
          'utf8',
        )
      }
    }
    const content = buildAgentPatch({
      composition,
      ...(pin?.attribution !== null && pin?.attribution !== undefined
        ? { provider: pin.attribution.provider, model: pin.attribution.model }
        : {}),
      ...(pin?.routes !== null && pin?.routes !== undefined ? { routes: pin.routes } : {}),
      ...(skillsDir !== undefined ? { skillsDir } : {}),
    })
    const dir = join(base, 'tmp')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `role-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
    await writeFile(path, content, 'utf8')
    return path
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
    const target = exportTarget({ projectRoot: project.rootPath, stage, title: TELOS_REPORT_TITLE, projectName })
    const bytes = await this.renderPdf({
      title: TELOS_REPORT_TITLE,
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
    const document = detail.documents.find((item) => item.kind === TELOS_DOCUMENT_KIND)
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

  private async markPlanningEvidence(projectId: string, document: ProjectDocument): Promise<void> {
    for (const key of ['business_idea', 'stakeholder_goals']) {
      await this.workspace.updateChecklistItem(projectId, PLANNING_STAGE, key, 'done', document.id)
    }
  }

  private assertPlanning(stage: string): asserts stage is typeof PLANNING_STAGE {
    if (stage !== PLANNING_STAGE) {
      throw new StageRuntimeError(501, 'STAGE_RUNTIME_NOT_IMPLEMENTED', 'only planning stage execution is implemented')
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
  gateAfterEachReview = false,
  acceptance: { minRating: number; maxBlockers: number; maxMajor: number } = { minRating: 0, maxBlockers: 0, maxMajor: 0 },
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
      key: PLANNING_STAGE,
      checklist: snapshot.checklist.filter((item) => item.stage === PLANNING_STAGE),
      documents: snapshot.documents.filter((item) => item.stage === PLANNING_STAGE),
    },
    priorStages,
    documents: snapshot.documents,
    attachments,
    input,
    constraints: {
      maxReviewCycles,
      gateAfterEachReview,
      minRating: acceptance.minRating,
      maxBlockers: acceptance.maxBlockers,
      maxMajor: acceptance.maxMajor,
      documentKind: TELOS_DOCUMENT_KIND,
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
export function buildGateSummary(
  analysis: string,
  review: StageReviewResult | undefined,
  cycle: number,
  maxCycles: number,
  kind: 'review' | 'final',
  acceptance?: ReviewAcceptance,
): string {
  const findings = review === undefined || review.findings.length === 0
    ? '- none'
    : review.findings.map((item) => `- ${JSON.stringify(item)}`).join('\n')
  return `# Planning & Feasibility — awaiting human

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
): string {
  return `# Planning & Feasibility — stage summary

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
