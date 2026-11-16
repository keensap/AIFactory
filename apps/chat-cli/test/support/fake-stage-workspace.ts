import { randomUUID } from 'node:crypto'
import type {
  PostgresProjectWorkspace,
  ProjectDocument,
  ProjectWorkspaceSnapshot,
  StageReview,
  StageRun,
  StageRunDetail,
  StageRunEvent,
  StageRunEventInput,
} from '../../src/workspace.ts'

export function fakeWorkspace(): PostgresProjectWorkspace {
  const runs = new Map<string, StageRun>()
  const reviews: StageReview[] = []
  const documents: ProjectDocument[] = []
  const checklistUpdates: Array<{ key: string; status: unknown; evidence: string | null | undefined }> = []
  const events: StageRunEvent[] = []

  const snapshot = (): ProjectWorkspaceSnapshot => ({
    currentStage: 'planning',
    stages: [{ stage: 'planning', status: 'in_progress', startedAt: null, completedAt: null, notes: null }],
    documents: [...documents],
    checklist: [
      { id: 'c1', stage: 'planning', key: 'business_idea', label: 'Business idea', required: true, status: 'open', evidenceDocumentId: null, completedAt: null },
      { id: 'c2', stage: 'planning', key: 'stakeholder_goals', label: 'Stakeholder goals', required: true, status: 'open', evidenceDocumentId: null, completedAt: null },
      { id: 'c3', stage: 'planning', key: 'telos_report', label: 'TELOS report', required: true, status: 'open', evidenceDocumentId: null, completedAt: null },
      { id: 'c4', stage: 'planning', key: 'feasibility_decision', label: 'Decision', required: true, status: 'open', evidenceDocumentId: null, completedAt: null },
    ],
    nextActions: [],
    progress: { completedStages: 0, totalStages: 8, completedRequiredItems: 0, totalRequiredItems: 4 },
  })

  const detail = (run: StageRun): StageRunDetail => ({
    ...run,
    reviews: reviews.filter((review) => review.stageRunId === run.id),
    documents: documents.filter((document) => (document as ProjectDocument & { stageRunId?: string }).stageRunId === run.id),
  })

  const fake = {
    async getSnapshot() { return snapshot() },
    async getPriorStageSummaries() { return [] },
    async appendStageRunEvent(input: StageRunEventInput) {
      const event: StageRunEvent = {
        id: String(events.length + 1),
        projectId: input.projectId,
        stageRunId: input.stageRunId,
        role: input.role ?? null,
        agentId: input.agentId ?? null,
        type: input.type,
        phase: input.phase ?? null,
        level: input.level ?? 'info',
        payload: input.payload,
        createdAt: new Date().toISOString(),
      }
      events.push(event)
      return event
    },
    async createStageRun(input: { projectId: string; stage: StageRun['stage']; inputText?: string | null; context: unknown; contextHash: string }) {
      const now = new Date().toISOString()
      const run: StageRun = {
        id: randomUUID(), projectId: input.projectId, stage: input.stage, attempt: 1,
        sessionId: null, status: 'pending', contextHash: input.contextHash,
        context: input.context, inputText: input.inputText ?? null,
        analysisMarkdown: null, draftMarkdown: null, summaryMarkdown: null,
        startedAt: null, completedAt: null, lockedBy: null, leaseExpiresAt: null,
        executionAttempts: 0, createdAt: now, updatedAt: now,
      }
      runs.set(run.id, run)
      return run
    },
    async getStageRunDetail(runId: string) {
      const run = runs.get(runId)
      return run === undefined ? undefined : detail(run)
    },
    async getStageRun(runId: string) { return runs.get(runId) },
    async claimStageRun(runId: string, workerId: string) {
      const run = runs.get(runId)
      if (run === undefined) return undefined
      if (run.lockedBy !== null) return undefined
      const next = { ...run, lockedBy: workerId, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), executionAttempts: run.executionAttempts + 1 }
      runs.set(runId, next)
      return next
    },
    async heartbeatStageRun() { return true },
    async releaseStageRun(runId: string) {
      const run = runs.get(runId)
      if (run !== undefined) runs.set(runId, { ...run, lockedBy: null, leaseExpiresAt: null })
    },
    async updateStageRun(runId: string, patch: Partial<StageRun>) {
      const run = runs.get(runId)!
      const next = { ...run, ...patch, updatedAt: new Date().toISOString() }
      runs.set(runId, next)
      return next
    },
    async addStageReview(input: { stageRunId: string; reviewerRole: string; decision: StageReview['decision']; findings: unknown[] }) {
      const review: StageReview = { id: randomUUID(), ...input, createdAt: new Date().toISOString() }
      reviews.push(review)
      return review
    },
    async addDocument(input: { kind: string; title: string; stageRunId?: string | null }) {
      const doc: ProjectDocument & { stageRunId?: string | null } = {
        id: randomUUID(), projectId: 'p', stage: 'planning', kind: input.kind, title: input.title,
        storagePath: '.aifactory/documents/planning/telos.md', mimeType: 'text/markdown',
        sizeBytes: 10, sha256: 'abc', status: 'uploaded', version: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        stageRunId: input.stageRunId ?? null,
      }
      documents.push(doc)
      return doc
    },
    async updateDocumentStatus() { return documents[0]! },
    async listStageRunEvents(stageRunId: string, after = '0', limit = 200) {
      const cursor = Number.parseInt(after, 10) || 0
      return events
        .filter((event) => event.stageRunId === stageRunId && Number(event.id) > cursor)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(0, Math.min(Math.max(limit, 1), 1000))
    },
    async updateChecklistItem(_projectId: string, _stage: string, key: string, status: unknown, evidence?: string | null) {
      checklistUpdates.push({ key, status, evidence })
      return snapshot().checklist[0]!
    },
    checklistUpdates,
    events,
  }
  return fake as unknown as PostgresProjectWorkspace
}

