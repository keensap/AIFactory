import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cycleLabel, gateOf, normalizeGate, normalizeRequirementsCoverage, normalizeStageSettings, parseCoverageWaiver, parseSettingField, requirementsDecisionInput, requirementsRejectionRecorded, sameSettings, sortFindings, STALE_GATE_CODES } from '../src/data/gates.ts'
import { describeStageError } from '../src/data/stageErrors.ts'
import { ApiError, ChatApi } from '../src/api/client.ts'
import { RequirementsFinalGatePanel } from '../src/components/stage/GatePanels.tsx'

const gate = {
  kind: 'final', cycle: 1, maxReviewCycles: 3, reviewDecision: 'needs_revision',
  findings: [{ id: 'F-2', severity: 'minor' }, { id: 'F-1', severity: 'blocker' }, { id: 'F-3', severity: 'major' }, 'junk'],
  question: 'Apply?', waitingSince: '2026-11-16T17:00:00.000Z',
}

const coverage = {
  counts: { totalRequirements: 4, withAcceptanceCriteria: 3, withSource: 2, withGoal: 1 },
  findings: [
    { code: 'MISSING_GOAL', severity: 'advisory', message: 'Goal missing' },
    { code: 'CONTRACT_EXAMPLE', severity: 'blocking', message: 'Missing <requirement> verification', requirementId: 'NFR-001' },
  ],
} as const

function markup(report: unknown, rejectionRecorded = false): string {
  return renderToStaticMarkup(createElement(RequirementsFinalGatePanel, {
    gate: normalizeGate({ ...gate, coverage: report })!,
    draftMarkdown: '# My draft', busy: false, error: null, rejectionRecorded,
    onDecide: () => {}, onRefine: () => {},
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe('gates', () => {
  it('normalizes a final gate and rejects obsolete and unknown kinds', () => {
    const g = normalizeGate(gate)!
    expect(g.kind).toBe('final')
    expect(normalizeGate({ ...gate, kind: 'review_changes' })).toBeNull()
    expect(g.findings).toHaveLength(3)
    expect(normalizeGate({ kind: 'other' })).toBeNull()
    expect(normalizeGate(null)).toBeNull()
    expect(normalizeGate({ kind: 'final', cycle: 'x' })!.cycle).toBeNull()
  })

  it('only reads the gate while the run is awaiting_human', () => {
    expect(gateOf({ status: 'awaiting_human', pendingGate: gate as never })?.kind).toBe('final')
    expect(gateOf({ status: 'reviewing', pendingGate: gate as never })).toBeNull()
    expect(gateOf({ status: 'awaiting_human', pendingGate: null })).toBeNull()
  })

  it('orders blockers first and labels the cycle', () => {
    expect(sortFindings(normalizeGate(gate)!.findings).map((f) => f.id)).toEqual(['F-1', 'F-3', 'F-2'])
    expect(cycleLabel({ cycle: 1, maxReviewCycles: 3 })).toBe('cycle 1 of 3')
    expect(cycleLabel({ cycle: null, maxReviewCycles: 3 })).toBe('')
  })

  it('validates each setting against its limits', () => {
    expect(parseSettingField('maxReviewCycles', ' 10 ')).toEqual({ value: 10 })
    for (const bad of ['0', '11', '', '2.5', 'a', '-1']) expect(parseSettingField('maxReviewCycles', bad)).toHaveProperty('error')
    expect(parseSettingField('minRating', '100')).toEqual({ value: 100 })
    expect(parseSettingField('minRating', '101')).toHaveProperty('error')
    expect(parseSettingField('maxBlockers', '0')).toEqual({ value: 0 })
    expect(parseSettingField('maxBlockers', '21')).toHaveProperty('error')
    expect(parseSettingField('maxMajor', '50')).toEqual({ value: 50 })
    expect(parseSettingField('maxMajor', '51')).toHaveProperty('error')
  })

  it('coerces settings and compares them', () => {
    const full = { maxReviewCycles: 5, minRating: 95, maxBlockers: 0, maxMajor: 1 }
    expect(normalizeStageSettings({ ...full, source: 'project' })).toEqual({ ...full, source: 'project' })
    expect(normalizeStageSettings({ maxReviewCycles: 99, minRating: 101, source: 'x' }))
      .toEqual({ maxReviewCycles: 4, minRating: 94, maxBlockers: 0, maxMajor: 0, source: null })
    expect(sameSettings(full, { ...full })).toBe(true)
    expect(sameSettings(full, { ...full, minRating: 90 })).toBe(false)
  })

  it('reads the review outcome from the final gate', () => {
    const outcome = normalizeGate({ kind: 'final', accepted: true, rating: 96, counts: { blockers: 0, major: 1, minor: 2 }, criteria: { minRating: 95, maxBlockers: 0, maxMajor: 1 } })!.outcome
    expect(outcome).toEqual({ accepted: true, rating: 96, counts: { blockers: 0, major: 1, minor: 2 }, criteria: { minRating: 95, maxBlockers: 0, maxMajor: 1 } })
    expect(normalizeGate({ kind: 'final' })!.outcome).toBeNull()
  })

  it('maps stale gates to a quiet state, without swallowing coverage errors', () => {
    expect(STALE_GATE_CODES.has('STAGE_RUN_NOT_AWAITING_DECISION')).toBe(true)
    expect(describeStageError(new ApiError(409, 'STAGE_RUN_NOT_AWAITING_DECISION', 'x')).kind).toBe('gate-stale')
    expect(STALE_GATE_CODES.has('REQUIREMENTS_COVERAGE_BLOCKED')).toBe(false)
    expect(describeStageError(new ApiError(409, 'REQUIREMENTS_COVERAGE_BLOCKED', 'x')).title).toBe('Approval blocked by coverage findings')
  })

  it('preserves server coverage separately from model review and rejects malformed reports', () => {
    expect(normalizeGate({ ...gate, accepted: true, coverage })?.coverage).toEqual(coverage)
    expect(normalizeGate(gate)?.coverage).toBeNull()
    expect(normalizeRequirementsCoverage({ ...coverage, findings: [{ ...coverage.findings[0], severity: 'unknown' }] })).toBeNull()
    expect(normalizeRequirementsCoverage({ ...coverage, counts: { ...coverage.counts, withGoal: 99 } })).toBeNull()
  })

  it('keeps the newer priority and business-rule counts only when they are valid', () => {
    const priorities = { must: 3, should: 1, could: 0, wont: 1 }
    const full = normalizeRequirementsCoverage({ ...coverage, counts: { ...coverage.counts, priorities, businessRules: 2 } })
    expect(full?.counts.priorities).toEqual(priorities)
    expect(full?.counts.businessRules).toBe(2)
    const partial = normalizeRequirementsCoverage({ ...coverage, counts: { ...coverage.counts, priorities: { must: 1 }, businessRules: 'x' } })
    expect(partial?.counts.priorities).toBeUndefined()
    expect(partial?.counts.businessRules).toBeUndefined()
    expect(normalizeRequirementsCoverage(coverage)?.counts.priorities).toBeUndefined()
  })

  it('allows plain approval only without known blockers and keeps a waiver separate from the note', () => {
    const blocked = normalizeRequirementsCoverage(coverage)
    const advisoryOnly = normalizeRequirementsCoverage({ ...coverage, findings: [coverage.findings[0]] })
    expect(requirementsDecisionInput('approve', blocked, 'even with a note')).toBeNull()
    expect(requirementsDecisionInput('approve', advisoryOnly, '  approved note  ')).toEqual({ decision: 'approved', note: 'approved note' })
    expect(requirementsDecisionInput('reject', blocked, '  needs work  ', 'ignored')).toEqual({ decision: 'rejected', note: 'needs work' })
    expect(requirementsDecisionInput('waive', blocked, '', '  ')).toBeNull()
    expect(requirementsDecisionInput('waive', advisoryOnly, '', 'No blockers')).toBeNull()
    expect(requirementsDecisionInput('waive', blocked, '  note  ', '  legacy exception  ')).toEqual({ decision: 'approved', note: 'note', coverageWaiverReason: 'legacy exception' })
    expect(parseCoverageWaiver(` ${'x'.repeat(2000)} `)).toHaveLength(2000)
    expect(parseCoverageWaiver('x'.repeat(2001))).toBeNull()
  })

  it('renders coverage counts, findings and explicit waiver affordance only when blocked', () => {
    const blocked = markup(coverage, true)
    expect(blocked).toContain('Deterministic coverage')
    expect(blocked).toContain('Ordinary approval is blocked')
    expect(blocked).toMatch(/Acceptance criteria:[\s\S]*3[\s\S]*\/4[\s\S]*Sources:[\s\S]*2[\s\S]*\/4[\s\S]*Goals:[\s\S]*1[\s\S]*\/4/)
    expect(blocked.indexOf('CONTRACT_EXAMPLE')).toBeLessThan(blocked.indexOf('MISSING_GOAL'))
    expect(blocked).toContain('Missing &lt;requirement&gt; verification')
    expect(blocked).toMatch(/disabled="">Approve requirements</)
    expect(blocked).toMatch(/disabled="">Approve with coverage waiver</)
    expect(blocked).toContain('Rejection recorded')
    expect(blocked).toContain('Refine further')
    expect(blocked).not.toContain('Conditional go')
    const advisoryOnly = markup({ ...coverage, findings: [coverage.findings[0]] })
    expect(advisoryOnly).not.toContain('Request a coverage waiver')
    expect(advisoryOnly).not.toMatch(/disabled="">Approve requirements</)
    expect(markup(null)).toContain('The server will check coverage before approving')
  })

  it('recognizes a recorded rejection on a still-open Requirements run', () => {
    const summaryMarkdown = '## Human decision\n\nDecision: **rejected** — the stage was not completed.\n\nReason.'
    expect(requirementsRejectionRecorded({ stage: 'requirements', status: 'awaiting_human', summaryMarkdown })).toBe(true)
    expect(requirementsRejectionRecorded({ stage: 'planning', status: 'awaiting_human', summaryMarkdown })).toBe(false)
    expect(requirementsRejectionRecorded({ stage: 'requirements', status: 'completed', summaryMarkdown })).toBe(false)
  })

  it('sends explicit Requirements decisions, waivers and refinement to the final decision route', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ run: { status: 'awaiting_human' } })))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ChatApi({ baseUrl: 'http://api.test' })
    const inputs = [{ decision: 'approved', coverageWaiverReason: 'why' }, { decision: 'rejected', note: 'not ready' }, { refine: true }] as const
    for (const input of inputs) expect(await api.decideStageRun('run/id', input)).toEqual({ status: 'awaiting_human' })
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method, JSON.parse(String(init.body))])).toEqual(
      inputs.map((input) => ['http://api.test/api/stage-runs/run%2Fid/decision', 'POST', input]),
    )
  })

  it('uses stage-generic settings endpoints and preserves the server settings source', async () => {
    const settings = { maxReviewCycles: 3, minRating: 94, maxBlockers: 0, maxMajor: 0 }
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ settings, source: 'defaults' })))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ChatApi({ baseUrl: 'http://api.test' })
    expect(await api.getProjectStageSettings('p-1', 'requirements')).toEqual({ ...settings, source: 'defaults' })
    await api.updateProjectStageSettings('p-1', 'requirements', settings)
    await api.resetProjectStageSettings('p-1', 'requirements')
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.method])).toEqual(
      ['GET', 'PATCH', 'DELETE'].map((method) => ['http://api.test/api/projects/p-1/stages/requirements/settings', method]),
    )
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1].body))).toEqual(settings)
  })
})
