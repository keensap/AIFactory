import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { ProjectService } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import { PlanningStageRuntime, buildAnalyzerPrompt, buildContextPacket, cleanMarkdown, parseStageReview } from '../src/stage-runtime.ts'
import type { ProjectWorkspaceSnapshot, ProjectDocument, StageReview, StageRun, StageRunDetail, StageRunEvent, StageRunEventInput } from '../src/workspace.ts'
import type { PostgresProjectWorkspace } from '../src/workspace.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

function fakeWorkspace(): PostgresProjectWorkspace {
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
    async updateChecklistItem(_projectId: string, _stage: string, key: string, status: unknown, evidence?: string | null) {
      checklistUpdates.push({ key, status, evidence })
      return snapshot().checklist[0]!
    },
    checklistUpdates,
    events,
  }
  return fake as unknown as PostgresProjectWorkspace
}

test('builds a planning context packet with prior outcomes and input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-stage-'))
  try {
    const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
    const project = await projects.create({ name: 'Portal', rootPath: root, organization: null, ownerEmail: null, status: 'active' })
    const workspace = fakeWorkspace()
    const snapshot = await workspace.getSnapshot(project.id)
    const packet = buildContextPacket(project, snapshot, [{ stage: 'planning', summary: 'prior', completedAt: null }], 'Build a portal')
    assert.equal(packet.stage.key, 'planning')
    assert.equal(packet.input, 'Build a portal')
    assert.equal(packet.priorStages.length, 1)
    assert.equal(packet.constraints.documentKind, 'telos_report')
    assert.match(buildAnalyzerPrompt(project, packet), /STAGE_ROLE: analyzer/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parses reviewer JSON and strips Markdown fences', () => {
  assert.deepEqual(parseStageReview('{"decision":"approved","findings":[]}'), { decision: 'approved', findings: [] })
  assert.equal(parseStageReview('```json\n{"decision":"needs_revision","findings":[{"id":"F-1"}]}\n```').decision, 'needs_revision')
  assert.equal(cleanMarkdown('```markdown\n# TELOS\n```'), '# TELOS')
  assert.throws(() => parseStageReview('not json'), /valid JSON/)
})

test('runs analyzer, author and reviewer, then waits for a human decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-stage-'))
  try {
    const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
    const project = await projects.create({ name: 'Portal', rootPath: root, organization: null, ownerEmail: null, status: 'active' })
    const workspace = fakeWorkspace()
    const calls: string[] = []
    const runtime = new PlanningStageRuntime({
      projects,
      workspace,
      harnessFactory: () => { throw new Error('not used') },
      runPrompt: async (role) => {
        calls.push(role)
        if (role === 'analyzer') return 'Business idea: portal. Gaps: none.'
        if (role === 'author') return '# TELOS feasibility report\n\nGo.'
        return '{"decision":"approved","findings":[]}'
      },
    })

    const started = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'Build a portal' })
    const executed = await runtime.execute(started.id)
    assert.equal(executed.status, 'awaiting_human')
    assert.equal(executed.reviews.length, 1)
    assert.equal(executed.documents.length, 1)
    assert.deepEqual(calls, ['analyzer', 'author', 'reviewer'])
    assert.match(executed.summaryMarkdown ?? '', /awaiting human decision/)
    const workspaceEvents = (workspace as unknown as { events: StageRunEvent[] }).events
    assert.ok(workspaceEvents.some((event) => event.type === 'role_start' && event.role === 'analyzer'))
    assert.ok(workspaceEvents.some((event) => event.type === 'role_end' && event.role === 'reviewer'))
    assert.ok(workspaceEvents.some((event) => event.type === 'review_decision'))
    assert.ok(workspaceEvents.some((event) => event.type === 'document_created'))

    const decided = await runtime.decide(started.id, { decision: 'go', note: 'Approved by sponsor' })
    assert.equal(decided.status, 'completed')
    assert.match(decided.summaryMarkdown ?? '', /Decision: \*\*go\*\*/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
