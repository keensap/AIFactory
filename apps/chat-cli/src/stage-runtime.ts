/**
 * Stage coordinator runtime.
 *
 * The first implemented stage is Planning & Feasibility. The controller below
 * owns the state machine; the model only produces analysis, the TELOS draft and
 * a structured review. A rejected draft is sent back to the author for a
 * bounded number of revisions before the run fails or waits for a human.
 */

import { createHash, randomUUID } from 'node:crypto'
import { access, stat } from 'node:fs/promises'
import type { DshHarness } from './harness.ts'
import { StageEventSink } from './stage-event-sink.ts'
import { attributeUsage, roleModel, type ModelPin } from './models/index.ts'
import { addLogContext, noopLogger, runWithLogContext, type Logger } from './logging/index.ts'
import { noopProvider, type TraceRecorder, type TraceSpan } from './observability/index.ts'
import type { Project, ProjectService } from './projects.ts'
import type { ProjectStage } from './sdlc.ts'
import { SDLC_STAGES } from './sdlc.ts'
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
} from './workspace.ts'

const PLANNING_STAGE: ProjectStage = 'planning'
const DEFAULT_MAX_REVIEW_CYCLES = 3

export type HumanDecision = 'go' | 'conditional_go' | 'no_go'

export interface StageRuntimeDeps {
  projects: ProjectService
  workspace: PostgresProjectWorkspace
  harnessFactory: (cwd?: string, timeoutMs?: number) => DshHarness
  /** Test seam: replace a harness role call with a deterministic response. */
  runPrompt?: (role: StageRole, prompt: string, cwd: string) => Promise<string>
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
}

export type StageRole = 'analyzer' | 'author' | 'reviewer'

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
  input: string | null
  constraints: {
    maxReviewCycles: number
    documentKind: string
    cardinality: 'one'
  }
}

export interface StageReviewResult {
  decision: StageReviewDecision
  findings: unknown[]
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
  /** Model pins of runs currently executing, by run id. */
  private readonly pins = new Map<string, ModelPin>()

  constructor(deps: StageRuntimeDeps) {
    if (deps.pinModel !== undefined) this.pinModel = deps.pinModel
    this.projects = deps.projects
    this.workspace = deps.workspace
    this.harnessFactory = deps.harnessFactory
    this.runPrompt = deps.runPrompt
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
  }): Promise<StageRunDetail> {
    this.assertPlanning(input.stage)
    const project = await this.projects.get(input.projectId)
    await assertProjectRoot(project)
    const snapshot = await this.workspace.getSnapshot(project.id)
    const priorStages = await this.workspace.getPriorStageSummaries(project.id, PLANNING_STAGE)
    const context = buildContextPacket(project, snapshot, priorStages, input.brief ?? null)
    const run = await this.workspace.createStageRun({
      projectId: project.id,
      stage: PLANNING_STAGE,
      inputText: input.brief ?? null,
      context,
      contextHash: hashContext(context),
    })
    return (await this.workspace.getStageRunDetail(run.id))!
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
    const run = await this.workspace.getStageRun(runId)
    if (run === undefined) throw new StageRuntimeError(404, 'STAGE_RUN_NOT_FOUND', 'stage run not found')
    return runWithLogContext(
      { projectId: run.projectId, stageRunId: run.id, stage: run.stage },
      () => this.executeRun(run),
    )
  }

  private async executeRun(run: StageRun): Promise<StageRunDetail> {
    if (run.stage !== PLANNING_STAGE) {
      throw new StageRuntimeError(501, 'STAGE_RUNTIME_NOT_IMPLEMENTED', 'only planning stage execution is implemented')
    }
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      throw new StageRuntimeError(409, 'STAGE_RUN_TERMINAL', `stage run is already ${run.status}`)
    }
    if (run.status === 'awaiting_human') {
      throw new StageRuntimeError(409, 'STAGE_RUN_AWAITING_HUMAN', 'stage run is waiting for a human decision')
    }
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

    const assertLease = (): void => {
      if (leaseLost) {
        throw new StageRuntimeError(409, 'STAGE_RUN_LEASE_LOST', 'worker lease was lost; another worker may own the run')
      }
    }

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
      const context = (run.context ?? {}) as StageContextPacket
      let analysis = ''
      let draft = ''
      let review: StageReviewResult | undefined

      await this.workspace.updateStageRun(run.id, { status: 'analyzing' })
      assertLease()
      analysis = await this.runRole('analyzer', buildAnalyzerPrompt(project, context), project.rootPath, run.id, project.id, runSpan)
      await this.workspace.updateStageRun(run.id, { analysisMarkdown: analysis })

      await this.workspace.updateStageRun(run.id, { status: 'drafting' })
      assertLease()
      draft = cleanMarkdown(await this.runRole('author', buildAuthorPrompt(project, context, analysis), project.rootPath, run.id, project.id, runSpan))
      await this.workspace.updateStageRun(run.id, { draftMarkdown: draft })

      let cycle = 0
      for (;;) {
        assertLease()
        await this.workspace.updateStageRun(run.id, { status: 'reviewing' })
        const rawReview = await this.runRole('reviewer', buildReviewerPrompt(project, context, draft), project.rootPath, run.id, project.id, runSpan)
        review = parseStageReview(rawReview)
        await this.workspace.addStageReview({
          stageRunId: run.id,
          reviewerRole: 'planning_reviewer',
          decision: review.decision,
          findings: review.findings,
        })
        await this.appendRunEvent(project.id, run.id, 'review_decision', {
          decision: review.decision,
          findings: review.findings,
        }, review.decision === 'approved' ? 'info' : 'warn')
        this.traces.recordReview(runSpan, review.decision, review.findings.length)

        if (review.decision === 'approved') break
        if (cycle >= this.maxReviewCycles) {
          throw new StageRuntimeError(
            409,
            'REVIEW_CYCLE_LIMIT',
            `review did not approve after ${this.maxReviewCycles} revision cycles`,
          )
        }

        cycle += 1
        assertLease()
        await this.workspace.updateStageRun(run.id, { status: 'revising' })
        draft = cleanMarkdown(await this.runRole(
          'author',
          buildRevisionPrompt(project, context, analysis, draft, review.findings),
          project.rootPath,
          run.id,
          project.id,
          runSpan,
        ))
        await this.workspace.updateStageRun(run.id, { draftMarkdown: draft })
      }

      assertLease()
      let document: ProjectDocument
      try {
        document = await this.workspace.addDocument({
          project,
          stage: PLANNING_STAGE,
          kind: TELOS_DOCUMENT_KIND,
          title: 'TELOS feasibility report',
          filename: `telos-${run.id}.md`,
          mimeType: 'text/markdown',
          buffer: Buffer.from(draft, 'utf8'),
          stageRunId: run.id,
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
      await this.appendRunEvent(project.id, run.id, 'document_created', {
        documentId: document.id,
        kind: document.kind,
        storagePath: document.storagePath,
      })
      this.traces.recordDocument(runSpan, document.kind, document.storagePath)
      if (this.indexDocument !== undefined) {
        void this.indexDocument(project, document).catch((error: unknown) => {
          this.log.warn({ event: 'stage.run.document_index_failed', documentId: document.id, err: error })
        })
      }

      const summary = buildStageSummary(analysis, review, document)
      assertLease()
      await this.workspace.updateStageRun(run.id, {
        status: 'awaiting_human',
        summaryMarkdown: summary,
      })
      runSpan?.setAttribute('status', 'awaiting_human')
      this.log.info({ event: 'stage.run.awaiting_human', documentId: document.id })
      return (await this.workspace.getStageRunDetail(run.id))!
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

  async decide(runId: string, input: {
    decision: HumanDecision
    note?: string
  }): Promise<StageRunDetail> {
    const detail = await this.get(runId)
    if (detail.status !== 'awaiting_human') {
      throw new StageRuntimeError(409, 'STAGE_RUN_NOT_AWAITING_HUMAN', 'stage run is not awaiting a human decision')
    }
    if (!['go', 'conditional_go', 'no_go'].includes(input.decision)) {
      throw new StageRuntimeError(400, 'INVALID_HUMAN_DECISION', 'decision must be go, conditional_go or no_go')
    }

    const document = detail.documents.find((item) => item.kind === TELOS_DOCUMENT_KIND)
    await this.workspace.updateChecklistItem(
      detail.projectId,
      PLANNING_STAGE,
      'feasibility_decision',
      'done',
      document?.id ?? null,
    )
    const decisionLine = input.decision.replace('_', '-')
    const note = input.note?.trim()
    const summary = `${detail.summaryMarkdown ?? ''}\n\n## Human decision\n\nDecision: **${decisionLine}**\n${note ? `\n${note}\n` : ''}`
    await this.workspace.updateStageRun(runId, {
      status: 'completed',
      summaryMarkdown: summary,
    })
    await this.appendRunEvent(detail.projectId, runId, 'human_decision', {
      decision: input.decision,
      note: note ?? null,
    })
    this.traces.recordHumanDecision(detail.projectId, runId, input.decision)
    return (await this.workspace.getStageRunDetail(runId))!
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
    await sink.append('role_start', { role, timeoutMs: this.roleTimeoutMs, model: roleModel(pin?.attribution) })
    this.log.info({ event: 'stage.role.started', role, timeoutMs: this.roleTimeoutMs })
    try {
      if (this.runPrompt !== undefined) {
        const text = await this.runPrompt(role, prompt, cwd)
        await sink.append('role_end', { role, durationMs: Date.now() - started })
        this.traces.completeRole(roleSpan, text)
        return text
      }
      const harness = pin !== undefined
        ? pin.harness(cwd, this.roleTimeoutMs)
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
      await sink.flush()
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
    input,
    constraints: {
      maxReviewCycles,
      documentKind: TELOS_DOCUMENT_KIND,
      cardinality: 'one',
    },
  }
}

export function hashContext(context: StageContextPacket): string {
  return createHash('sha256').update(JSON.stringify(context)).digest('hex')
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
CONTEXT:
${JSON.stringify(context, null, 2)}`
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

CONTEXT:
${JSON.stringify(context, null, 2)}`
}

export function buildReviewerPrompt(
  project: Project,
  context: StageContextPacket,
  draft: string,
): string {
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
  }

  return `STAGE_ROLE: reviewer
You are the independent Planning & Feasibility reviewer for ${project.name}. You did not write this draft.

Evaluate the single TELOS report against the template and evidence. Check that:
- business idea, stakeholder goals and success measures are explicit;
- each of Technical, Economic, Legal, Operational and Schedule feasibility is addressed;
- assumptions, risks and missing evidence are not hidden;
- the recommendation is justified by the evidence;
- no SRS/functional specification has been substituted for the feasibility report.

Return ONLY JSON:
{
  "decision": "approved" | "needs_revision" | "rejected",
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

CONTEXT:
${JSON.stringify(context, null, 2)}`
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
      return {
        decision: record.decision as StageReviewDecision,
        findings,
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
