import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, ChatApi } from '../src/api/client.ts'
import type { ChecklistItem, ProjectDocument, StageReview, StageRunDetail } from '../src/api/types.ts'
import { loadBrief, saveBrief } from '../src/data/briefs.ts'
import { describeStageError } from '../src/data/stageErrors.ts'
import {
  advanceBlock,
  checklistLabelsFromError,
  failedRole,
  failedStep,
  failureMessage,
  partialOutputs,
  FALLBACK_STAGES,
  isCycleLimit,
  isExecutableStage,
  isPollable,
  nextStageKey,
  pipelineSteps,
  pollDelay,
  priorStageSummaries,
  recordedDecision,
  requiredProgress,
  revisionCount,
  runStatusLabel,
  severityCounts,
  sortDocuments,
  sortStages,
  stageArtifact,
  stageArtifactTitle,
  stageName,
} from '../src/data/stages.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

function review(decision: StageReview['decision'], at: string, findings: StageReview['findings'] = []): StageReview {
  return { id: at, stageRunId: 'r', reviewerRole: 'planning_reviewer', decision, findings, createdAt: at }
}

function run(patch: Partial<StageRunDetail> = {}): StageRunDetail {
  return {
    id: 'r1', projectId: 'p1', stage: 'planning', attempt: 1, sessionId: null, status: 'pending',
    contextHash: 'a'.repeat(64), context: {}, inputText: 'brief', summaryMarkdown: null,
    startedAt: null, completedAt: null, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
    reviews: [], documents: [], ...patch,
  }
}

function item(key: string, status: ChecklistItem['status'], required = true, stage: ChecklistItem['stage'] = 'planning'): ChecklistItem {
  return { id: key, stage, key, label: key, required, status, evidenceDocumentId: null, completedAt: null }
}

describe('stage names', () => {
  it('sorts API stages and falls back to the local map', () => {
    expect(sortStages([]).map((stage) => stage.key)).toEqual(FALLBACK_STAGES.map((stage) => stage.key))
    expect(sortStages([{ key: 'b', name: 'B', position: 1 }, { key: 'a', name: 'A', position: 0 }])[0]!.key).toBe('a')
    expect(stageName([], 'planning')).toBe('Planning & Feasibility')
    expect(stageName([], 'mystery')).toBe('mystery')
    expect(nextStageKey(FALLBACK_STAGES, 'planning')).toBe('requirements')
    expect(nextStageKey(FALLBACK_STAGES, 'maintenance')).toBeNull()
  })

  it('uses capability flags when present and falls back to Planning for older APIs', () => {
    expect(isExecutableStage([], 'planning')).toBe(true)
    expect(isExecutableStage(FALLBACK_STAGES, 'planning')).toBe(true)
    expect(isExecutableStage(FALLBACK_STAGES, 'requirements')).toBe(false)
    const stages = FALLBACK_STAGES.map((stage) => ({ ...stage, executable: stage.key === 'planning' || stage.key === 'requirements' }))
    expect(isExecutableStage(stages, 'planning')).toBe(true)
    expect(isExecutableStage(stages, 'requirements')).toBe(true)
    expect(isExecutableStage(stages, 'design')).toBe(false)
    expect(isExecutableStage(stages, 'unknown')).toBe(false)
    expect(isExecutableStage([{ ...FALLBACK_STAGES[0]!, executable: false }], 'planning')).toBe(false)
    expect(isExecutableStage([FALLBACK_STAGES[0]!, { ...FALLBACK_STAGES[1]!, executable: true }], 'planning')).toBe(false)
  })

  it('labels drafting for the requested stage', () => {
    expect(runStatusLabel('drafting')).toBe('Drafting TELOS')
    expect(runStatusLabel('drafting', 'requirements')).toBe('Drafting requirements')
    expect(runStatusLabel('drafting', 'design')).toBe('Drafting document')
    expect(runStatusLabel('reviewing', 'requirements')).toBe('Under review')
  })
})

describe('pipeline', () => {
  const states = (patch: Partial<StageRunDetail>, last: Parameters<typeof pipelineSteps>[1] = null) =>
    pipelineSteps(run(patch), last).map((step) => step.state)

  it('maps run status to the active step', () => {
    expect(states({ status: 'pending' })).toEqual(['waiting', 'waiting', 'waiting'])
    expect(states({ status: 'analyzing' })).toEqual(['active', 'waiting', 'waiting'])
    expect(states({ status: 'drafting' })).toEqual(['done', 'active', 'waiting'])
    expect(states({ status: 'reviewing' })).toEqual(['done', 'done', 'active'])
    expect(states({ status: 'revising' })).toEqual(['done', 'active', 'done'])
    expect(states({ status: 'awaiting_human' })).toEqual(['done', 'done', 'done'])
    expect(states({ status: 'completed' })).toEqual(['done', 'done', 'done'])
  })

  it('marks the last known step as failed', () => {
    expect(states({ status: 'failed' }, 'author')).toEqual(['done', 'failed', 'waiting'])
    expect(states({ status: 'failed', reviews: [review('needs_revision', '1')] })).toEqual(['done', 'done', 'failed'])
    expect(states({ status: 'failed' })).toEqual(['waiting', 'waiting', 'waiting'])
  })

  it('only changes the author label for Requirements', () => {
    const drafting = run({ status: 'drafting', stage: 'requirements' })
    const planning = pipelineSteps(drafting)
    expect(pipelineSteps(drafting, null, 'requirements')).toEqual([
      planning[0], { key: 'author', label: 'Requirements author', state: 'active' }, planning[2],
    ])
  })

  it('only polls queued or executing runs', () => {
    expect(['pending', 'analyzing', 'revising'].every(isPollable)).toBe(true)
    expect(['awaiting_human', 'completed', 'failed', 'cancelled'].some(isPollable)).toBe(false)
  })
})

describe('failed-run partial output', () => {
  const failedWith = (message: string, extra: Partial<StageRunDetail> = {}) =>
    run({ status: 'failed', summaryMarkdown: `# Planning & Feasibility run failed\n\n${message}\n`, ...extra })

  it('reads the failed role from STAGE_ROLE_FAILED text', () => {
    const failed = failedWith('author failed: harness exited 1')
    expect(failedRole(failed)).toEqual({ role: 'author', label: 'TELOS author', message: 'harness exited 1' })
    expect(failedRole(failed, 'requirements')).toEqual({ role: 'author', label: 'Requirements author', message: 'harness exited 1' })
    expect(failedRole(failedWith('Reviewer failed: timed out'))?.role).toBe('reviewer')
    expect(failedRole(failedWith('review did not approve after 3 revision cycles'))).toBeNull()
    expect(failedRole(run({ status: 'completed', summaryMarkdown: 'analyzer failed: x' }))).toBeNull()
  })

  it('places the failure on the right pipeline step', () => {
    expect(failedStep(failedWith('analyzer failed: x'), 'reviewer')).toBe('analyzer')
    expect(failedStep(failedWith('something broke'), 'author')).toBe('author')
    expect(failedStep(failedWith('something broke', { analysisMarkdown: '# a' }))).toBe('author')
    expect(failedStep(failedWith('something broke', { analysisMarkdown: '# a', draftMarkdown: '# d' }))).toBe('reviewer')
    expect(failedStep(failedWith('something broke'))).toBeNull()
    expect(failedStep(failedWith('review did not approve after 3 revision cycles'), 'author')).toBe('reviewer')
    expect(pipelineSteps(failedWith('author failed: x', { analysisMarkdown: '# a' })).map((step) => step.state)).toEqual(['done', 'failed', 'waiting'])
  })

  it('lists saved analysis and draft, skipping blanks and older APIs', () => {
    expect(partialOutputs({ analysisMarkdown: '# a', draftMarkdown: '  ' }).map((o) => o.key)).toEqual(['analysis'])
    expect(partialOutputs({ analysisMarkdown: '# a', draftMarkdown: '# d' }).map((o) => o.title)).toEqual(['Analysis', 'Latest TELOS draft'])
    expect(partialOutputs({ draftMarkdown: '# requirements' }, 'requirements')).toEqual([
      { key: 'draft', title: 'Latest requirements draft', markdown: '# requirements' },
    ])
    expect(partialOutputs({})).toEqual([])
  })

  it('titles STAGE_ROLE_FAILED errors by role', () => {
    const view = describeStageError(new ApiError(502, 'STAGE_ROLE_FAILED', 'reviewer failed: timed out'))
    expect(view).toMatchObject({ kind: 'harness', title: 'Reviewer failed', message: 'timed out', retryable: false })
  })
})

describe('reviews and outcome', () => {
  it('counts severities and revisions', () => {
    const findings = [{ severity: 'major' }, { severity: 'MINOR' }, { severity: 'major' }, { severity: 'weird' }, {}]
    expect(severityCounts(findings)).toEqual({ blocker: 0, major: 2, minor: 1, other: 2 })
    expect(revisionCount([review('needs_revision', '1'), review('needs_revision', '2'), review('approved', '3')])).toBe(2)
  })

  it('reads failure, cycle limit and the human decision from the summary', () => {
    const failed = run({ status: 'failed', summaryMarkdown: '# Planning & Feasibility run failed\n\nreview did not approve after 3 revision cycles\n' })
    expect(failureMessage(failed)).toBe('review did not approve after 3 revision cycles')
    expect(isCycleLimit(failed)).toBe(true)
    expect(isCycleLimit(run({ status: 'failed', summaryMarkdown: '# x failed\n\nharness timed out' }))).toBe(false)
    expect(failureMessage(run({ status: 'completed', summaryMarkdown: 'x' }))).toBeNull()

    const done = (line: string) => run({ status: 'completed', summaryMarkdown: `# Summary\n\nDecision: approved\n\n## Human decision\n\n${line}\n` })
    expect(recordedDecision(done('Decision: **no-go**'))).toBe('no_go')
    expect(recordedDecision(done('Decision: **conditional-go**\n\nIf budget'))).toBe('conditional_go')
    expect(recordedDecision(done('Decision: **go**'))).toBe('go')
    // The reviewer's "Decision: approved" line before the section is ignored.
    expect(recordedDecision(run({ status: 'completed', summaryMarkdown: 'Decision: approved' }))).toBeNull()
  })

  const doc = (id: string, stage: ProjectDocument['stage'], kind: string, patch: Partial<ProjectDocument> = {}): ProjectDocument => ({
    id, projectId: 'p', stage, kind, title: id, storagePath: `x/${id}.md`, mimeType: 'text/markdown',
    status: 'approved', version: 1, createdAt: '2026-11-01', updatedAt: '2026-11-01', ...patch,
  })

  it('finds the artifact by stage and kind, preferring non-superseded output', () => {
    const upload = doc('upload', 'requirements', 'upload')
    const telos = doc('telos', 'planning', 'telos_report')
    const superseded = doc('old-spec', 'requirements', 'requirements_spec', { status: 'superseded' })
    const spec = doc('spec', 'requirements', 'requirements_spec')
    const wrongStage = doc('wrong-stage', 'planning', 'requirements_spec')
    const docs = [upload, telos, superseded, wrongStage, spec]
    expect(stageArtifact(docs, 'planning')).toBe(telos)
    expect(stageArtifact(docs, 'requirements')).toBe(spec)
    expect(stageArtifact([superseded], 'requirements')).toBe(superseded)
    expect(stageArtifact([upload, telos, wrongStage], 'requirements')).toBeUndefined()
    expect(stageArtifact(docs, 'design')).toBeUndefined()
    expect(stageArtifactTitle('planning')).toBe('TELOS feasibility report')
    expect(stageArtifactTitle('requirements')).toBe('Requirements specification')
  })

  it('sorts the stage artifact kind ahead of newer attachments', () => {
    const spec = doc('spec', 'requirements', 'requirements_spec')
    const older = doc('older', 'requirements', 'upload', { createdAt: '2026-11-02' })
    const newer = doc('newer', 'requirements', 'upload', { createdAt: '2026-11-03' })
    expect(sortDocuments([older, newer, spec], 'requirements')).toEqual([spec, newer, older])
    expect(sortDocuments([older, newer, spec], 'design')).toEqual([newer, older, spec])
  })
})

describe('advance gate', () => {
  const completed = run({ status: 'completed', summaryMarkdown: '## Human decision\n\nDecision: **go**' })
  const doneList = [item('business_idea', 'done'), item('telos_report', 'waived'), item('ux', 'open', false)]
  const base = { currentStage: 'planning', viewedStage: 'planning', run: completed, checklist: doneList, nextStage: 'requirements' }

  it('allows advancing only when the run is complete and required items are done', () => {
    expect(advanceBlock(base)).toBeNull()
    expect(advanceBlock({ ...base, currentStage: 'requirements' })).toBe('not-current-stage')
    expect(advanceBlock({ ...base, run: run({ status: 'awaiting_human' }) })).toBe('run-not-completed')
    expect(advanceBlock({ ...base, run: null })).toBe('run-not-completed')
    expect(advanceBlock({ ...base, checklist: [...doneList, item('feasibility_decision', 'open')] })).toBe('checklist-open')
    expect(advanceBlock({ ...base, run: run({ status: 'completed', summaryMarkdown: '## Human decision\n\nDecision: **no-go**' }) })).toBe('no-go')
    // Items of other stages don't block.
    expect(advanceBlock({ ...base, checklist: [...doneList, item('design_document', 'open', true, 'design')] })).toBeNull()
  })

  it('counts done and waived required items', () => {
    expect(requiredProgress(doneList)).toEqual({ done: 2, total: 2 })
  })

  it('parses missing labels from STAGE_CHECKLIST_INCOMPLETE', () => {
    expect(checklistLabelsFromError('complete required items for planning: Single TELOS feasibility report is provided; Go decision')).toEqual([
      'Single TELOS feasibility report is provided',
      'Go decision',
    ])
    expect(checklistLabelsFromError('no colon')).toEqual([])
  })
})

describe('polling cadence', () => {
  it('backs off after 30 s and stops at 30 min', () => {
    expect(pollDelay(0)).toBe(1500)
    expect(pollDelay(29_999)).toBe(1500)
    expect(pollDelay(30_000)).toBe(3000)
    expect(pollDelay(30 * 60_000)).toBeNull()
  })
})

describe('context packet', () => {
  it('reads prior stage summaries defensively', () => {
    expect(priorStageSummaries(null)).toEqual([])
    expect(priorStageSummaries({ priorStages: 'x' })).toEqual([])
    expect(priorStageSummaries({ priorStages: [{ stage: 'planning', summary: 's', completedAt: null }, { stage: 1 }] })).toEqual([
      { stage: 'planning', summary: 's', completedAt: null },
    ])
  })
})

describe('stage errors', () => {
  it('maps API codes to UI states', () => {
    const kind = (status: number, code: string) => describeStageError(new ApiError(status, code, 'm')).kind
    expect(kind(409, 'STAGE_RUN_RUNNING')).toBe('running')
    expect(kind(409, 'STAGE_RUN_TERMINAL')).toBe('terminal')
    expect(kind(409, 'REVIEW_CYCLE_LIMIT')).toBe('cycle-limit')
    expect(kind(409, 'PROJECT_ROOT_UNAVAILABLE')).toBe('root-unavailable')
    expect(kind(409, 'STAGE_CHECKLIST_INCOMPLETE')).toBe('checklist-incomplete')
    expect(kind(501, 'STAGE_RUNTIME_NOT_IMPLEMENTED')).toBe('not-implemented')
    expect(kind(503, 'STAGE_RUNTIME_DISABLED')).toBe('disabled')
    expect(kind(502, 'HARNESS_ERROR')).toBe('harness')
    expect(kind(401, 'UNAUTHORIZED')).toBe('unauthorized')
    expect(kind(404, 'STAGE_RUN_NOT_FOUND')).toBe('not-found')
    expect(kind(0, 'NETWORK')).toBe('offline')
  })

  it('strips stack frames', () => {
    const view = describeStageError(new ApiError(500, 'INTERNAL_ERROR', 'boom\n    at x (y.ts:1)\n    at z'))
    expect(view.message).toBe('boom')
  })
})

describe('brief drafts', () => {
  it('stores and clears per project', () => {
    const storage = createMemoryStorage()
    expect(loadBrief(storage, 'p1')).toBeNull()
    saveBrief(storage, 'p1', 'idea')
    saveBrief(storage, 'p2', 'other')
    expect(loadBrief(storage, 'p1')).toBe('idea')
    saveBrief(storage, 'p1', '')
    expect(loadBrief(storage, 'p1')).toBeNull()
    expect(loadBrief(storage, 'p2')).toBe('other')
  })
})

describe('ChatApi stage endpoints', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('creates, executes, decides and advances with the right requests', async () => {
    const calls: { url: string; method: string; body: unknown; auth: string | undefined }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), auth: headers.Authorization })
      const status = String(input).endsWith('/execute') ? 202 : String(input).endsWith('/runs') && init?.method === 'POST' ? 201 : 200
      return new Response(JSON.stringify({ run: run() }), { status, headers: { 'Content-Type': 'application/json' } })
    }))
    const api = new ChatApi({ baseUrl: 'http://api.test', token: 't0k' })
    await api.createStageRun('p 1', 'planning', { brief: 'idea' })
    await api.executeStageRun('r1')
    await api.decideStageRun('r1', { decision: 'conditional_go', note: 'n' })
    await api.advanceStage('p 1', 'requirements')
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST http://api.test/api/projects/p%201/stages/planning/runs',
      'POST http://api.test/api/stage-runs/r1/execute',
      'POST http://api.test/api/stage-runs/r1/decision',
      'PATCH http://api.test/api/projects/p%201/stage',
    ])
    expect(calls.map((call) => call.body)).toEqual([{ brief: 'idea' }, undefined, { decision: 'conditional_go', note: 'n' }, { stage: 'requirements' }])
    expect(calls.every((call) => call.auth === 'Bearer t0k')).toBe(true)
    expect(calls.some((call) => call.url.includes('wait='))).toBe(false)
  })

  it('downloads document content with auth and maps error envelopes', async () => {
    let auth: string | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      auth = ((init?.headers ?? {}) as Record<string, string>).Authorization
      if (String(input).includes('missing')) {
        return new Response(JSON.stringify({ error: { message: 'gone', code: 'DOCUMENT_FILE_MISSING', status: 404 } }), { status: 404 })
      }
      return new Response('# TELOS', { status: 200, headers: { 'Content-Type': 'text/markdown' } })
    }))
    const api = new ChatApi({ baseUrl: 'http://api.test', token: 'abc' })
    const blob = await api.getDocumentContent({ projectId: 'p', id: 'd' })
    expect(await blob.text()).toBe('# TELOS')
    expect(auth).toBe('Bearer abc')
    await expect(api.getDocumentContent({ projectId: 'p', id: 'missing' })).rejects.toMatchObject({ status: 404, code: 'DOCUMENT_FILE_MISSING' })
  })
})
