/**
 * In-memory stage runtime for the mock Chat API: SDLC stages, checklist,
 * documents and Planning & Feasibility / Requirements runs (analyzer → author →
 * reviewer → human decision). Mirrors `apps/chat-cli` routes and error codes.
 *
 * Execution is simulated on a timer (MOCK_STAGE_STEP_MS, default 1200 ms per
 * step). The brief steers the outcome for testing:
 *   - contains "FAIL"  → author fails while drafting (STAGE_ROLE_FAILED; analysis kept)
 *   - contains "REVIEWERFAIL" → reviewer fails after the draft is saved (analysis + draft kept)
 *   - contains "CYCLE" → reviewer never approves (REVIEW_CYCLE_LIMIT)
 *   - contains "DROP"  → the first event stream connection drops after 4 events
 *   - otherwise        → one needs_revision review, then approved
 * Requirements-only: "COVERAGE" leaves a blocking gap until human refinement;
 * "COVERAGE_STICKY" keeps it after refinement to exercise explicit waivers.
 * Every role turn writes stage_run_events (role_start … role_end) served by
 * GET /api/stage-runs/:id/events and /events/stream (SSE).
 * A project whose rootPath contains "missing" → 409 PROJECT_ROOT_UNAVAILABLE.
 */

import { createHash, randomUUID } from 'node:crypto'

const STEP_MS = Number(process.env.MOCK_STAGE_STEP_MS ?? 1200)
const MAX_REVIEW_CYCLES = 3

const RUNTIMES = {
  planning: { kind: 'telos_report', title: 'TELOS feasibility report', stem: 'telos' },
  requirements: { kind: 'requirements_spec', title: 'Requirements specification', stem: 'requirements-specification' },
}

export const SDLC_STAGES = [
  ['planning', 'Planning & Feasibility'],
  ['requirements', 'Requirements'],
  ['design', 'Design'],
  ['architecture', 'Architecture'],
  ['development', 'Development'],
  ['testing', 'Testing'],
  ['deployment', 'Deployment'],
  ['maintenance', 'Maintenance'],
].map(([key, name], position) => ({ key, name, position, executable: Object.hasOwn(RUNTIMES, key) }))
const STAGE_KEYS = SDLC_STAGES.map((stage) => stage.key)
const stageLabel = (stage) => SDLC_STAGES.find(({ key }) => key === stage).name
const exportPathFor = (document, project) => `documents/${document.stage}/${document.title} — ${project.name}.pdf`

const CHECKLISTS = {
  planning: [
    ['business_idea', 'High-level business idea and problem statement are captured', true],
    ['stakeholder_goals', 'Stakeholder goals, success measures and constraints are captured', true],
    ['telos_report', 'Single TELOS feasibility report is provided', true],
    ['feasibility_decision', 'Go, conditional-go or no-go decision and conditions are recorded', true],
  ],
  requirements: [
    ['requirement_document', 'Requirement document is provided', true],
    ['acceptance_criteria', 'Acceptance criteria are defined', true],
    ['requirements_review', 'Requirements have been reviewed and baselined', true],
  ],
  design: [
    ['design_document', 'Design or wireframe document is provided', true],
    ['ux_review', 'UX review is complete', false],
  ],
  architecture: [
    ['architecture_document', 'Architecture document is provided', true],
    ['technology_decisions', 'Technology and data decisions are recorded', true],
  ],
  development: [
    ['implementation_plan', 'Implementation plan and task breakdown exist', true],
    ['code_review_setup', 'Repository and code-review process are ready', true],
  ],
  testing: [
    ['test_plan', 'Test plan is provided', true],
    ['test_results', 'Test results meet the agreed threshold', true],
  ],
  deployment: [
    ['deployment_plan', 'Deployment and rollback plan are provided', true],
    ['release_approval', 'Release approval is recorded', true],
  ],
  maintenance: [
    ['monitoring_plan', 'Monitoring and support plan are provided', true],
    ['support_owner', 'A support owner is assigned', true],
  ],
}

class StageError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** projectId → { stages, checklist, documents, contents } */
const workspaces = new Map()
const builtInDefaults = { maxReviewCycles: 4, minRating: 94, maxBlockers: 0, maxMajor: 0 }
const factorySettings = new Map()
const factoryFor = (stage) => factorySettings.get(stage) ?? builtInDefaults
const projectSettings = new Map()
/** runId → run (with reviews) */
const runs = new Map()

function workspace(project) {
  let entry = workspaces.get(project.id)
  if (entry === undefined) {
    const startedAt = project.createdAt
    entry = {
      stages: STAGE_KEYS.map((stage) => ({
        stage,
        status: stage === 'planning' ? 'in_progress' : 'not_started',
        startedAt: stage === 'planning' ? startedAt : null,
        completedAt: null,
        notes: null,
      })),
      checklist: Object.entries(CHECKLISTS).flatMap(([stage, items]) => items.map(([key, label, required]) => ({
        id: randomUUID(),
        stage,
        key,
        label,
        required,
        status: 'open',
        evidenceDocumentId: null,
        completedAt: null,
      }))),
      documents: [],
      contents: new Map(),
    }
    workspaces.set(project.id, entry)
  }
  return entry
}

/** Projects need `currentStage`; call when a project is created or listed. */
export function withStage(project) {
  if (project.currentStage === undefined) {
    project.currentStage = 'planning'
    project.stageUpdatedAt = project.createdAt
  }
  return project
}

function snapshot(project) {
  const entry = workspace(withStage(project))
  return {
    project,
    sdlc: {
      currentStage: project.currentStage,
      stages: entry.stages,
      checklist: entry.checklist,
    },
    documents: entry.documents,
  }
}

function checkItem(entry, stage, key, documentId = null) {
  const item = entry.checklist.find((candidate) => candidate.stage === stage && candidate.key === key)
  if (item === undefined) return
  item.status = 'done'
  item.completedAt = new Date().toISOString()
  if (documentId !== null) item.evidenceDocumentId = documentId
}

function detail(run) {
  const { reviews, gating: _gating, ...rest } = run
  const project = { id: run.projectId }
  const entry = workspaces.get(project.id)
  return {
    ...rest,
    reviews,
    documents: entry === undefined ? [] : entry.documents.filter((document) => document.stageRunId === run.id).map(stripPrivate),
  }
}

function stripPrivate(document) {
  const { stageRunId: _ignored, ...rest } = document
  return rest
}

function summaryOf(run) {
  const { reviews: _reviews, ...rest } = run
  return rest
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function telosMarkdown(project, brief) {
  return `# TELOS feasibility report — ${project.name}

## 1. Executive summary

${brief.trim() === '' ? 'No business brief was provided; this assessment uses project metadata only.' : brief.trim().split('\n')[0]}

## 2. Technical feasibility

The proposed solution uses mainstream web technology. **Risk: low.**

## 3. Economic feasibility

| Item | Estimate |
| --- | --- |
| Build (3 engineers × 4 months) | $180k |
| Run cost per year | $24k |

## 4. Legal feasibility

Customer data requires GDPR-compliant processing agreements.

## 5. Operational feasibility

Support can be absorbed by the existing operations team.

## 6. Schedule feasibility

An MVP in 16 weeks is realistic with a fixed scope.

## 10. Recommendation

**Conditional go**: proceed if a data-processing agreement is signed before development.

<script>alert('this must never run')</script>
`
}

function requirementsDraft(project, run, refinement = 0) {
  const brief = run.inputText ?? ''
  const blocked = brief.includes('COVERAGE_STICKY') || (brief.includes('COVERAGE') && refinement === 0)
  const source = run.context.readiness.prerequisites[0].evidence
  const sourceLabel = source?.kind === 'document' ? 'Approved TELOS report' : source?.kind === 'attachment' ? 'Input PDF' : 'Project brief'
  const coverage = {
    counts: { totalRequirements: 2, withAcceptanceCriteria: blocked ? 1 : 2, withSource: 2, withGoal: 2 },
    findings: blocked ? [{ code: 'UNCOVERED_REQUIREMENT', requirementId: 'FR-001', message: 'FR-001 has no acceptance criterion.', severity: 'blocking' }] : [],
  }
  const notApplicable = ['scalability', 'availability', 'security', 'privacy', 'accessibility', 'localisation', 'observability', 'maintainability', 'portability', 'compliance']
    .map((domain) => `| ${domain} | — | Not applicable — covered by the host platform for this mock. | — |`).join('\n')
  const markdown = `# Requirements specification — ${project.name}

## 1. Purpose and scope

${brief.trim().split('\n')[0] || 'Generate a specification from the baseline evidence.'}

| Boundary | Items |
| --- | --- |
| In scope | Record requests |
| Out of scope | Billing |
| Deferred | Export history |

## 2. Actors and permissions

| Actor | Goal | Permissions |
| --- | --- | --- |
| Operator | Track requests | Submit requests |

## 3. Functional requirements

| id | actor | trigger | behaviour | inputs | outputs | error cases | priority | acceptance criteria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FR-001 | Operator | Submit request | Record a valid request | Request text | Reference number | Reject missing text | must | ${blocked ? '—' : 'AC-001'} |

## 4. Non-functional requirements

| domain | id | target | verification |
| --- | --- | --- | --- |
| performance | NFR-001 | p95 latency under 500 ms | Measure over 100 requests |
${notApplicable}

## 5. Acceptance criteria

| id | requirement | Given | When | Then |
| --- | --- | --- | --- | --- |
${blocked ? '' : '| AC-001 | FR-001 | Valid text | Operator submits | Show a reference number |\n'}| ${blocked ? 'AC-001' : 'AC-002'} | NFR-001 | 100 requests | Load test completes | p95 is below 500 ms |

## 6. Assumptions, constraints and open questions

| id | statement | owner | impact if wrong | status |
| --- | --- | --- | --- | --- |
| A-001 | Existing platform supplies authentication | Product owner | Add sign-in to scope | open |

## 7. Traceability

| requirement | source | goal |
| --- | --- | --- |
| FR-001 | ${sourceLabel} | Track requests |
| NFR-001 | ${sourceLabel} | Make request submission responsive |
${refinement === 0 ? '' : `\n_Refinement ${refinement}: incorporated review feedback._\n`}`
  return { markdown, coverage }
}

function coverageSummary(coverage, waiver) {
  return [
    '', '## Requirements coverage', '',
    `${coverage.counts.totalRequirements} requirements; ${coverage.counts.withAcceptanceCriteria} with acceptance criteria, ${coverage.counts.withSource} with a source, ${coverage.counts.withGoal} with a goal.`,
    ...coverage.findings.map(({ severity, message }) => `- **${severity}:** ${message}`),
    ...(waiver === undefined ? [] : ['', `Coverage waiver: ${waiver}`]),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Event log (mirrors stage_run_events: numeric ids serialized as strings)

let nextEventId = 1
/** runId → events (ordered) */
const runEvents = new Map()

function emit(run, role, type, payload = {}, phase = null) {
  const list = runEvents.get(run.id) ?? []
  runEvents.set(run.id, list)
  const event = {
    id: String(nextEventId++),
    projectId: run.projectId,
    stageRunId: run.id,
    role,
    agentId: role,
    type,
    phase,
    payload,
    createdAt: new Date().toISOString(),
  }
  list.push(event)
  return event
}

function logLevelOf(type, payload) {
  if (type === 'role_error' || type === 'error') return 'error'
  if (type === 'tool_result' && payload?.status === 'error') return 'error'
  if (type === 'run_recovered') return 'warn'
  if (type === 'review_decision') return payload?.decision === 'needs_revision' ? 'warn' : 'info'
  if (type === 'thinking' || type === 'status') return 'debug'
  return 'info'
}

function logMessageOf(type, payload, role) {
  const who = role ?? 'run'
  switch (type) {
    case 'role_start': return `${who} started`
    case 'role_end': return `${who} finished in ${payload?.durationMs ?? 0} ms`
    case 'role_error': return `${who} failed: ${payload?.message ?? 'unknown error'}`
    case 'tool_call': return `tool call: ${payload?.name ?? payload?.tool ?? 'tool'}`
    case 'tool_result': return `tool result: ${payload?.status ?? 'ok'}`
    case 'status': return `status: ${payload?.phase ?? 'update'}`
    case 'review_decision': return `review decision: ${payload?.decision ?? ''}`
    case 'human_decision': return `human decision: ${payload?.decision ?? ''}`
    case 'document_created': return `document created (${payload?.kind ?? 'document'})`
    default: return type.replace(/_/g, ' ')
  }
}

/** Project logs: newest first, filtered, cursor = `before` event id. */
function projectLogs(projectId, params) {
  const limit = Math.min(500, Math.max(1, Number(params.get('limit') ?? 100) || 100))
  const before = /^\d+$/.test(params.get('before') ?? '') ? BigInt(params.get('before')) : null
  const q = (params.get('q') ?? '').toLowerCase()
  const all = []
  for (const run of runs.values()) {
    if (run.projectId !== projectId) continue
    for (const event of runEvents.get(run.id) ?? []) {
      const level = logLevelOf(event.type, event.payload)
      const message = logMessageOf(event.type, event.payload, event.role)
      const text = event.payload?.text ?? event.payload?.message ?? null
      const entry = {
        ...event,
        stage: run.stage,
        attempt: run.attempt,
        level,
        message,
        preview: typeof text === 'string' ? text.slice(0, 240) : null,
      }
      if (before !== null && BigInt(entry.id) >= before) continue
      if (params.get('level') && params.get('level') !== level) continue
      if (params.get('type') && params.get('type') !== entry.type) continue
      if (params.get('role') && params.get('role') !== entry.role) continue
      if (params.get('runId') && params.get('runId') !== entry.stageRunId) continue
      if (params.get('stage') && params.get('stage') !== entry.stage) continue
      if (q && !`${entry.type} ${entry.role ?? ''} ${message} ${JSON.stringify(entry.payload)}`.toLowerCase().includes(q)) continue
      all.push(entry)
    }
  }
  all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1))
  const logs = all.slice(0, limit)
  return { logs, nextBefore: all.length > limit ? logs.at(-1).id : null }
}

/**
 * Phoenix summary derived from the event store. MOCK_PHOENIX=off → 503
 * PHOENIX_DISABLED; the Forge project (3333…) answers `available:false`.
 */
function observability(projectId, hours) {
  const DOWN_PROJECT = '33333333-3333-4333-8333-333333333333'
  const base = { projectName: `aifactory-${projectId}`, windowHours: hours }
  if (projectId === DOWN_PROJECT) return { ...base, available: false, reason: 'connect ECONNREFUSED 127.0.0.1:6006' }
  const roles = new Map()
  const durations = []
  let traces = 0, errors = 0, tools = 0, tokens = 0, lastSpanAt = null
  const since = Date.now() - hours * 3_600_000
  for (const run of runs.values()) {
    if (run.projectId !== projectId) continue
    const events = (runEvents.get(run.id) ?? []).filter((event) => Date.parse(event.createdAt) >= since)
    if (events.length === 0) continue
    traces += 1
    for (const event of events) {
      const role = event.role
      if (event.type === 'tool_call') tools += 1
      const usage = event.payload?.usage
      const used = usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : 0
      tokens += used
      if (role === null) continue
      const entry = roles.get(role) ?? { role, spans: 0, errors: 0, durationMs: 0, tokens: 0 }
      roles.set(role, entry)
      entry.tokens += used
      if (event.type === 'role_end' || event.type === 'role_error') {
        entry.spans += 1
        entry.durationMs += event.payload?.durationMs ?? 0
        durations.push(event.payload?.durationMs ?? 0)
        if (event.type === 'role_error') { entry.errors += 1; errors += 1 }
        lastSpanAt = event.createdAt
      }
    }
  }
  durations.sort((a, b) => a - b)
  const at = (q) => durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.floor(q * durations.length))]
  const spans = durations.length
  return {
    ...base, available: true, traces, spans, errors, tools, tokens,
    latencyMs: { count: spans, avg: spans === 0 ? 0 : Math.round(durations.reduce((a, b) => a + b, 0) / spans), p50: at(0.5), p95: at(0.95), max: durations.at(-1) ?? 0 },
    roles: [...roles.values()].filter((role) => role.spans > 0), lastSpanAt, truncated: false,
  }
}

/** Token usage per project from the recorded `status` usage events. */
function projectStats(projectId) {
  const tokens = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 }
  for (const run of runs.values()) {
    if (run.projectId !== projectId) continue
    for (const event of runEvents.get(run.id) ?? []) {
      const usage = event.type === 'status' ? event.payload?.usage : null
      if (!usage) continue
      tokens.input += usage.inputTokens ?? 0
      tokens.output += usage.outputTokens ?? 0
    }
  }
  tokens.total = tokens.input + tokens.output
  return { projectId, tokens, cost: { usd: Math.round(tokens.total * 0.0000028 * 100) / 100, pricedTokens: tokens.total, unpricedTokens: 0 } }
}

function eventsAfter(runId, after, limit = 1000) {
  const cursor = BigInt(/^\d+$/.test(after ?? '') ? after : '0')
  return (runEvents.get(runId) ?? []).filter((event) => BigInt(event.id) > cursor).slice(0, limit)
}

/**
 * One simulated DSH role turn: role_start, session, status, thinking, a tool
 * call + result, text, final, role_end. Spread over STEP_MS so the UI sees
 * events arrive while the run status shows the role.
 */
async function roleTurn(run, role, { thinking, command, output, text, failWith, legacyTool = false }) {
  const started = Date.now()
  const tick = () => sleep(Math.max(40, Math.round(STEP_MS / 6)))
  emit(run, role, 'role_start', { role, timeoutMs: 300000 })
  emit(run, role, 'session', { type: 'session', sessionId: `mock-${role}-${run.id.slice(0, 8)}`, cwd: '/srv/projects/mock' })
  emit(run, role, 'status', { type: 'status', phase: 'turn_start', turn: 1 }, 'turn_start')
  await tick()
  emit(run, role, 'thinking', { type: 'thinking', text: thinking })
  emit(run, role, 'status', { type: 'status', phase: 'step_start', turn: 1, step: 1 }, 'step_start')
  await tick()
  const callId = `call-${role}-${nextEventId}`
  emit(run, role, 'tool_call', legacyTool
    ? { type: 'tool_call', callId, name: 'fs_read', arguments: JSON.stringify({ path: 'docs/brief.md' }) }
    : { type: 'tool_call', callId, tool: 'bash', input: { command } })
  await tick()
  if (failWith !== undefined) {
    emit(run, role, 'tool_result', { type: 'tool_result', callId, status: 'error', error: failWith })
    emit(run, role, 'role_error', { role, durationMs: Date.now() - started, message: failWith })
    throw new StageError(502, 'STAGE_ROLE_FAILED', `${role} failed: ${failWith}`)
  }
  emit(run, role, 'tool_result', { type: 'tool_result', callId, status: 'ok', result: output })
  emit(run, role, 'status', { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 1800, outputTokens: 640 } }, 'step_end')
  await tick()
  emit(run, role, 'text', { type: 'text', text })
  emit(run, role, 'status', { type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 2400, outputTokens: 910 } }, 'step_end')
  emit(run, role, 'final', { type: 'final', reason: { kind: 'stop' }, text, sessionId: `mock-${role}` })
  emit(run, role, 'role_end', { role, durationMs: Date.now() - started, textLength: text.length })
}

/** Produce the document and PDF path; only called once a human completes the stage. */
function completeDocument(project, run, entry, brief) {
  const { kind, title, stem } = RUNTIMES[run.stage]
  const content = run.stage === 'requirements' ? run.draftMarkdown : telosMarkdown(project, brief)
  const createdAt = new Date().toISOString()
  for (const existing of entry.documents) {
    if (existing.kind === kind && existing.status === 'approved') existing.status = 'superseded'
  }
  const version = entry.documents.filter((document) => document.kind === kind).length + 1
  const document = {
    id: randomUUID(),
    projectId: project.id,
    stage: run.stage,
    kind,
    title,
    storagePath: `.aifactory/documents/${run.stage}/${stem}-${run.id}.md`,
    mimeType: 'text/markdown',
    sizeBytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    status: 'approved',
    version,
    createdAt,
    updatedAt: createdAt,
    stageRunId: run.id,
    exportPath: null,
  }
  entry.documents.push(document)
  entry.contents.set(document.id, content)
  if (brief.includes('RENDERBUG')) emit(run, null, 'document_export_failed', { message: 'renderer crashed while laying out the Economic table' })
  else document.exportPath = exportPathFor(document, project)
  emit(run, null, 'document_created', { documentId: document.id, kind, storagePath: document.storagePath })
  if (run.stage === 'requirements') {
    for (const [key] of CHECKLISTS.requirements) checkItem(entry, run.stage, key, document.id)
  } else {
    checkItem(entry, 'planning', 'business_idea', document.id)
    checkItem(entry, 'planning', 'stakeholder_goals', document.id)
    checkItem(entry, 'planning', 'telos_report', document.id)
    run.summaryMarkdown = `# Planning & Feasibility — stage summary

Status: awaiting human decision

## Analysis

The idea is technically straightforward; legal and schedule risks dominate.

## Review

Decision: approved

## Artifact

- ${document.title}: \`${document.storagePath}\`
`
  }
  return document
}

function validateSettings(body, previous) {
  const current = { ...previous }
  if (body?.gateAfterEachReview !== undefined) {
    if (typeof body.gateAfterEachReview !== 'boolean') throw new StageError(400, 'INVALID_GATE_SETTING', 'gateAfterEachReview must be a boolean')
    current.gateAfterEachReview = body.gateAfterEachReview
  }
  if (body?.maxReviewCycles !== undefined) {
    if (!Number.isInteger(body.maxReviewCycles) || body.maxReviewCycles < 1 || body.maxReviewCycles > 10) {
      throw new StageError(400, 'INVALID_REVIEW_CYCLES', 'maxReviewCycles must be an integer from 1 to 10')
    }
    current.maxReviewCycles = body.maxReviewCycles
  }
  for (const [key, max, code] of [['minRating', 100, 'INVALID_MIN_RATING'], ['maxBlockers', 20, 'INVALID_MAX_BLOCKERS'], ['maxMajor', 50, 'INVALID_MAX_MAJOR']]) {
    if (body?.[key] === undefined) continue
    if (!Number.isInteger(body[key]) || body[key] < 0 || body[key] > max) throw new StageError(400, code, `${key} must be an integer from 0 to ${max}`)
    current[key] = body[key]
  }
  if (body?.processParams?.review?.maxFindings !== undefined) {
    const cap = body.processParams.review.maxFindings
    if (!Number.isInteger(cap) || cap < 1 || cap > 12) {
      throw new StageError(400, 'INVALID_PROCESS_PARAMS', 'params.review.maxFindings: expected an integer from 1 to 12')
    }
    current.processParams = { review: { maxFindings: cap } }
  }
  return current
}

function effectiveSettings(projectId, stage) {
  const own = projectSettings.get(`${projectId}:${stage}`)
  const settings = { ...factoryFor(stage), ...own }
  return { ...settings, source: own === undefined ? 'factory' : 'project' }
}

/** Pin the settings a run starts with; later changes never affect it. */
function resolveSettings(projectId, stage, brief = '') {
  const base = effectiveSettings(projectId, stage)
  return { ...base, gateAfterEachReview: brief.includes('GATE') ? true : base.gateAfterEachReview }
}

function reviewOutcome(run) {
  const review = run.reviews.at(-1)
  if (review === undefined) return {}
  const count = (severity) => review.findings.filter((finding) => finding.severity === severity).length
  const counts = { blockers: count('blocker'), major: count('major'), minor: count('minor') }
  const criteria = { minRating: run.gating.minRating ?? 0, maxBlockers: run.gating.maxBlockers ?? 0, maxMajor: run.gating.maxMajor ?? 0 }
  const accepted = counts.blockers <= criteria.maxBlockers && counts.major <= criteria.maxMajor && review.rating >= criteria.minRating
  return { accepted, rating: review.rating, counts, criteria }
}

function raiseGate(run, kind, extra = {}) {
  const findings = extra.findings ?? run.reviews.at(-1)?.findings ?? []
  run.pendingGate = {
    kind,
    question: kind === 'review_changes' ? 'Apply the reviewer findings, or accept the draft as it is?' : 'The draft is ready. Complete the stage, or refine further?',
    cycle: extra.cycle ?? Math.max(0, run.reviews.length - 1),
    maxReviewCycles: run.gating.maxReviewCycles,
    gateAfterEachReview: run.gating.gateAfterEachReview,
    reviewDecision: extra.reviewDecision ?? run.reviews.at(-1)?.decision ?? 'approved',
    findings,
    waitingSince: new Date().toISOString(),
    ...(kind === 'final' ? reviewOutcome(run) : {}),
  }
  run.status = 'awaiting_human'
  run.updatedAt = new Date().toISOString()
  emit(run, null, 'gate_raised', { kind })
}

/** Review (and revise) from `startCycle`; pauses at a gate instead of finishing. `opts.once` = one refine pass. */
async function reviewFrom(project, run, entry, brief, startCycle, opts = {}) {
  const set = (status) => {
    run.status = status
    run.updatedAt = new Date().toISOString()
  }
  run.pendingGate = null
  {
    for (let cycle = startCycle; ; cycle += 1) {
      set('reviewing')
      await roleTurn(run, 'reviewer', {
        thinking: `Checking each TELOS dimension against the rubric (pass ${cycle}).`,
        command: `grep -n "Recommendation" .aifactory/drafts/telos-${run.id.slice(0, 8)}.md`,
        output: '42:## 10. Recommendation',
        text: cycle >= 2 && !brief.includes('CYCLE') ? 'The draft meets the rubric.' : 'The recommendation lacks go conditions; legal section misses data residency.',
        ...(brief.includes('REVIEWERFAIL') ? { failWith: 'role timed out after 300000ms' } : {}),
      })
      const approve = !brief.includes('CYCLE') && cycle >= 2
      const findings = approve
        ? [{ id: 'F-101', severity: 'minor', section: '3. Economic feasibility', finding: 'Run cost excludes support staff.', required_change: 'Note the assumption.' }]
        : [
            { id: `F-${cycle}01`, severity: 'major', section: '10. Recommendation', finding: 'The recommendation does not state the conditions for a go decision.', required_change: 'List each condition with an owner and a date.' },
            { id: `F-${cycle}02`, severity: 'minor', section: '6. Schedule feasibility', finding: 'The 16-week estimate has no buffer. '.repeat(12).trim(), required_change: 'Add a contingency of at least 20%.' },
            { id: `F-${cycle}03`, severity: 'blocker', section: '4. Legal feasibility', finding: '<img src=x onerror=alert(1)> Data residency is not addressed.', required_change: 'State where customer data is stored.' },
          ]
      const decision = approve ? 'approved' : 'needs_revision'
      run.reviews.push({
        id: randomUUID(),
        stageRunId: run.id,
        reviewerRole: 'planning_reviewer',
        decision,
        rating: approve ? 96 : 55 + cycle * 5,
        findings,
        createdAt: new Date().toISOString(),
      })
      emit(run, null, 'review_decision', { decision, findings })
      if (approve || (!brief.includes('CYCLE') && !opts.once && reviewOutcome(run).accepted)) break
      if (opts.once && cycle > startCycle) break
      if (!opts.once && run.gating.gateAfterEachReview) {
        raiseGate(run, 'review_changes', { cycle: cycle - 1, reviewDecision: decision, findings })
        return
      }
      if (!opts.once && !brief.includes('CYCLE') && cycle > run.gating.maxReviewCycles) break
      if (brief.includes('CYCLE') && cycle >= MAX_REVIEW_CYCLES) {
        throw new StageError(409, 'REVIEW_CYCLE_LIMIT', `review did not approve after ${MAX_REVIEW_CYCLES} revision cycles`)
      }
      set('revising')
      await roleTurn(run, 'author', {
        thinking: 'Addressing reviewer findings: add go conditions and a data-residency statement.',
        command: 'apply_patch .aifactory/drafts/telos.md',
        output: 'patched 2 sections',
        text: `Revised the draft (revision ${cycle}).`,
        legacyTool: true,
      })
      run.draftMarkdown = `${telosMarkdown(project, brief)}\n\n_Revision ${cycle}: addressed reviewer findings._\n`
    }

    }
  raiseGate(run, 'final')
}

function setRunStatus(run, status) {
  run.status = status
  run.updatedAt = new Date().toISOString()
}

function failRun(run, error) {
  run.summaryMarkdown = `# ${stageLabel(run.stage)} run failed\n\n${error.message}\n`
  setRunStatus(run, 'failed')
  run.completedAt = run.updatedAt
}

async function draftAndReviewRequirements(project, run, refinement) {
  const { markdown, coverage } = requirementsDraft(project, run, refinement)
  const brief = run.inputText ?? ''
  setRunStatus(run, refinement === 0 ? 'drafting' : 'revising')
  await roleTurn(run, 'author', {
    thinking: refinement === 0 ? 'Drafting testable requirements and mapping them to their sources.' : 'Addressing the review and filling traceability gaps.',
    command: 'cat .aifactory/templates/requirements-specification.md',
    output: '# Requirements specification',
    text: markdown,
    ...(brief.includes('FAIL') && !brief.includes('REVIEWERFAIL') ? { failWith: 'model harness exited with status 1' } : {}),
  })
  run.draftMarkdown = markdown
  setRunStatus(run, 'reviewing')
  await roleTurn(run, 'reviewer', {
    thinking: 'Checking requirements, acceptance criteria and traceability.',
    command: 'cat .aifactory/drafts/requirements-specification.md',
    output: '# Requirements specification',
    text: 'The draft is ready for operator review.',
    ...(brief.includes('REVIEWERFAIL') ? { failWith: 'role timed out after 300000ms' } : {}),
  })
  const review = { id: randomUUID(), stageRunId: run.id, reviewerRole: 'requirements_reviewer', decision: 'approved', rating: 96, findings: [], createdAt: new Date().toISOString() }
  run.reviews.push(review)
  emit(run, null, 'review_decision', { decision: review.decision, findings: review.findings })
  const outcome = reviewOutcome(run)
  run.pendingGate = {
    kind: 'final', question: 'Complete the stage with this document, or refine it further?',
    cycle: refinement, maxReviewCycles: run.gating.maxReviewCycles, reviewDecision: review.decision,
    findings: review.findings, waitingSince: new Date().toISOString(), ...outcome,
    accepted: outcome.accepted && !coverage.findings.some(({ severity }) => severity === 'blocking'),
    coverage,
  }
  run.summaryMarkdown = `# Requirements — stage summary\n\nStatus: awaiting human decision\n${coverageSummary(coverage)}`
  setRunStatus(run, 'awaiting_human')
  emit(run, null, 'final_gate', { cycle: refinement, decision: review.decision, coverage })
}

async function executeRequirements(project, run) {
  setRunStatus(run, 'analyzing')
  await roleTurn(run, 'analyzer', {
    thinking: 'Identifying actors, scope and the source of each candidate requirement.',
    command: 'cat docs/brief.md',
    output: run.inputText || 'Baseline evidence available.',
    text: 'Extracted the request workflow, performance target and open questions.',
  })
  run.analysisMarkdown = `# Requirements analysis\n\n- Scope: ${run.inputText?.trim().split('\n')[0] || 'Use baseline evidence.'}\n- Identify actors, acceptance criteria and traceability.\n`
  await draftAndReviewRequirements(project, run, 0)
}

async function decideRequirements(project, run, body) {
  if (run.status !== 'awaiting_human' || run.pendingGate?.kind !== 'final') {
    throw new StageError(409, 'STAGE_RUN_NOT_AWAITING_DECISION', 'this run is not waiting on a final decision')
  }
  const { decision, coverageWaiverReason } = body ?? {}
  const refine = body?.refine === true
  if (!refine && !['approved', 'rejected', 'go', 'conditional_go', 'no_go'].includes(decision)) {
    throw new StageError(400, 'INVALID_HUMAN_DECISION', 'decision must be approved or rejected')
  }
  const waiver = typeof coverageWaiverReason === 'string' ? coverageWaiverReason.trim() : ''
  if (coverageWaiverReason !== undefined && (refine || decision !== 'approved' || waiver === '' || waiver.length > 2000)) {
    throw new StageError(400, 'INVALID_COVERAGE_WAIVER', 'provide a nonblank coverageWaiverReason of at most 2000 characters with explicit requirements approval')
  }
  if (refine) {
    const cycle = run.pendingGate.cycle + 1
    emit(run, null, 'gate_decision', { gate: 'final', refine: true })
    run.pendingGate = null
    try {
      await draftAndReviewRequirements(project, run, cycle)
    } catch (error) {
      failRun(run, error)
    }
    return
  }
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  const previous = (run.summaryMarkdown ?? '').split('\n## Human decision')[0].trimEnd()
  const decisionSummary = `\n\n## Human decision\n\nDecision: **${decision.replace('_', '-')}**`
  if (decision === 'rejected' || decision === 'no_go') {
    run.summaryMarkdown = `${previous}${decisionSummary} — the stage was not completed.\n\n${note ? `${note}\n\n` : ''}The run is still at the final gate: refine it, or approve it when it is ready.\n`
    emit(run, null, 'gate_decision', { gate: 'final', decision, rejected: true, note: note || null })
    setRunStatus(run, 'awaiting_human')
    return
  }
  const { coverage } = requirementsDraft(project, run, run.pendingGate.cycle)
  const blocking = coverage.findings.filter(({ severity }) => severity === 'blocking')
  if (blocking.length > 0 && !waiver) {
    throw new StageError(409, 'REQUIREMENTS_COVERAGE_BLOCKED', `approval blocked by ${blocking.length} requirements coverage finding(s); refine or explicitly approve with coverageWaiverReason`)
  }
  const document = completeDocument(project, run, workspace(project), run.inputText ?? '')
  run.summaryMarkdown = `# Requirements — stage summary\n\nStatus: completed${decisionSummary}\n${note === '' ? '' : `\n${note}\n`}\n${coverageSummary(coverage, blocking.length > 0 ? waiver : undefined)}`
  if (document.exportPath !== null) emit(run, null, 'document_exported', { path: document.exportPath, documentId: document.id })
  emit(run, null, 'human_decision', { decision, note: note || null, ...(blocking.length > 0 ? { coverageWaiver: { reason: waiver, findings: blocking } } : {}) })
  run.pendingGate = null
  setRunStatus(run, 'completed')
  run.completedAt = run.updatedAt
}

async function execute(project, run) {
  const entry = workspace(project)
  const brief = run.inputText ?? ''
  const set = (status) => {
    run.status = status
    run.updatedAt = new Date().toISOString()
  }
  try {
    run.startedAt = new Date().toISOString()
    run.gating = resolveSettings(project.id, run.stage, brief)
    if (run.stage === 'requirements') {
      await executeRequirements(project, run)
      return
    }
    set('analyzing')
    await roleTurn(run, 'analyzer', {
      thinking: 'Assessing which TELOS dimensions the brief covers. Legal and schedule evidence look thin.',
      command: 'rg -n "refund|GDPR|deadline" docs && echo api_key=sk-test-1234567890abcdefgh',
      output: 'docs/brief.md:12: refunds within 14 days\ndocs/brief.md:31: launch before Q3\n' + 'x'.repeat(5000),
      text: 'Analysis: the idea is technically straightforward; legal (data residency) and schedule risks dominate. <script>alert("text")</script>',
    })
    run.analysisMarkdown = `# Planning analysis\n\n- Idea: ${brief.slice(0, 120) || project.name}\n- Main risks: legal (data residency), schedule.\n\n<script>alert('analysis')</script>\n`
    set('drafting')
    const authorFails = brief.includes('FAIL') && !brief.includes('REVIEWERFAIL')
    await roleTurn(run, 'author', {
      thinking: 'Structuring the report by the template sections; Economic needs a cost table.',
      command: 'cat .aifactory/templates/telos.md',
      output: '# TELOS feasibility report\n## 1. Executive summary\n…',
      text: 'Drafted the TELOS feasibility report (10 sections).',
      ...(authorFails ? { failWith: 'model harness exited with status 1' } : {}),
    })
    run.draftMarkdown = telosMarkdown(project, brief)
    await reviewFrom(project, run, entry, brief, 1)
  } catch (error) {
    failRun(run, error)
  }
}

/**
 * SSE replay + tail, like chat-cli: `after` (or Last-Event-ID), poll every
 * 100 ms, keepalive comments, `event: end` once the run is terminal and no
 * events remain; stays open for awaiting_human. A brief containing "DROP"
 * closes the first connection after 4 events to exercise reconnects.
 */
const dropped = new Set()
/**
 * Fold a run's status events into one telemetry snapshot (like the real API:
 * null = cannot be computed, never 0). Context window is a fixed 200k.
 */
function foldTelemetry(runId) {
  const events = eventsAfter(runId, '0', 100000)
  let turns = 0
  let steps = 0
  let phase = null
  const usage = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 }
  let seenUsage = false
  let last = null
  let lastRate = null
  let timedSeconds = 0
  let timedOutput = 0
  const startedAt = new Map()
  for (const event of events) {
    if (event.type !== 'status') continue
    const p = event.payload ?? {}
    if (typeof p.turn === 'number') turns = Math.max(turns, p.turn)
    phase = p.phase ?? phase
    if (p.phase === 'step_start') startedAt.set(event.role, Date.parse(event.createdAt))
    if (p.phase === 'step_end') {
      steps += 1
      const u = p.usage
      if (u) {
        const input = u.inputTokens ?? 0
        const output = u.outputTokens ?? 0
        const cacheRead = u.cacheReadTokens ?? Math.round(input * 0.5)
        seenUsage = true
        usage.input += input; usage.output += output; usage.cacheRead += cacheRead
        usage.total += input + output + cacheRead
        last = { input, cacheRead, cacheWrite: 0 }
        const start = startedAt.get(event.role)
        const seconds = start === undefined ? 0 : (Date.parse(event.createdAt) - start) / 1000
        if (seconds > 0 && output > 0) { lastRate = output / seconds; timedSeconds += seconds; timedOutput += output }
      }
    }
  }
  if (events.length === 0) return null
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  const contextUsedTokens = last === null ? null : last.input + last.cacheRead + last.cacheWrite
  return {
    turns, steps, phase,
    usage,
    lastStep: null,
    tokensPerSecond: lastRate,
    averageTokensPerSecond: timedSeconds > 0 ? timedOutput / timedSeconds : null,
    cacheHitPercent: seenUsage && prompt > 0 ? Math.round((usage.cacheRead / prompt) * 1000) / 10 : null,
    contextUsedTokens,
    contextWindow: 200000,
    contextUsedPercent: contextUsedTokens === null ? null : Math.round((contextUsedTokens / 200000) * 1000) / 10,
    model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    startedAt: events[0].createdAt,
    updatedAt: events.at(-1).createdAt,
  }
}

function streamEvents(request, response, run, url) {
  let after = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0'
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })
  response.flushHeaders?.()
  let closed = false
  let sent = 0
  let lastTelemetry = ''
  const sendTelemetry = () => {
    const snapshot = foldTelemetry(run.id)
    const text = JSON.stringify(snapshot)
    if (snapshot === null || text === lastTelemetry) return
    lastTelemetry = text
    response.write(`event: telemetry\ndata: ${text}\n\n`)
  }
  const dropAfter = (run.inputText ?? '').includes('DROP') && !dropped.has(run.id) ? 4 : Infinity
  const stop = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    clearInterval(keepalive)
  }
  const poll = () => {
    if (closed) return
    const events = eventsAfter(run.id, after)
    for (const event of events) {
      response.write(`id: ${event.id}\nevent: stage\ndata: ${JSON.stringify(event)}\n\n`)
      after = event.id
      sent += 1
      if (sent >= dropAfter) {
        dropped.add(run.id)
        stop()
        response.destroy()
        return
      }
    }
    if (events.length > 0 || lastTelemetry === '') sendTelemetry()
    if (events.length === 0 && ['completed', 'failed', 'cancelled'].includes(run.status)) {
      response.write('event: end\ndata: {}\n\n')
      stop()
      response.end()
    }
  }
  const timer = setInterval(poll, 100)
  const keepalive = setInterval(() => {
    if (!closed) response.write(': keepalive\n\n')
  }, 15000)
  request.on('close', stop)
  poll()
}


// ---------------------------------------------------------------------------
// Stage input PDFs (attachments) and the exported deliverable PDF.

const attachments = new Map() // id -> attachment (with private buffer)

async function readBuffer(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** Minimal multipart/form-data parser: fields + files (enough for the mock). */
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  if (match === null) throw new StageError(400, 'INVALID_MULTIPART', 'multipart boundary missing')
  const boundary = Buffer.from(`--${match[1] ?? match[2]}`)
  const fields = {}
  const files = []
  let start = buffer.indexOf(boundary)
  while (start !== -1) {
    const next = buffer.indexOf(boundary, start + boundary.length)
    if (next === -1) break
    const part = buffer.subarray(start + boundary.length + 2, next - 2)
    const split = part.indexOf('\r\n\r\n')
    const head = part.subarray(0, split).toString('utf8')
    const body = part.subarray(split + 4)
    const name = /name="([^"]*)"/.exec(head)?.[1]
    const filename = /filename="([^"]*)"/.exec(head)?.[1]
    const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? ''
    if (filename !== undefined) files.push({ field: name, filename, mimeType: type, buffer: body })
    else if (name !== undefined) fields[name] = body.toString('utf8')
    start = next
  }
  return { fields, files }
}

function stripAttachment(attachment) {
  const { buffer: _buffer, ...rest } = attachment
  return rest
}

/** A small but valid one-page PDF (hand-built) used as the "exported" deliverable. */
function samplePdf(title) {
  const text = `BT /F1 20 Tf 72 720 Td (${title.replace(/[()\\]/g, ' ')}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

async function handleAttachments(request, response, project, segments, sendJson) {
  // segments: ['api','projects',id,'attachments',(attachmentId),(content)]
  if (segments.length === 4 && request.method === 'GET') {
    sendJson(response, 200, { attachments: [...attachments.values()].filter((entry) => entry.projectId === project.id).reverse().map(stripAttachment) })
    return true
  }
  if (segments.length === 4 && request.method === 'POST') {
    const { fields, files } = parseMultipart(await readBuffer(request), request.headers['content-type'])
    if (files.length === 0) throw new StageError(400, 'FILES_REQUIRED', 'choose at least one PDF')
    if (files.length > 10) throw new StageError(400, 'TOO_MANY_FILES', 'at most 10 files per upload')
    // The request fails as a whole if any file breaks a rule.
    for (const file of files) {
      const lower = file.filename.toLowerCase()
      if (!lower.endsWith('.pdf') || file.mimeType.startsWith('image/')) {
        throw new StageError(415, 'UNSUPPORTED_FILE_TYPE', `${file.filename}: images and non-PDF files are not supported. Stage analysis reads text only, so an image would not influence the result.`)
      }
      if (file.buffer.length > 20 * 1024 * 1024) throw new StageError(413, 'ATTACHMENT_TOO_LARGE', `${file.filename} is over 20 MB`)
      if (!file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new StageError(400, 'INVALID_PDF', `${file.filename} is not a PDF`)
      if (lower.includes('scan')) throw new StageError(422, 'PDF_HAS_NO_TEXT', `${file.filename} has no extractable text`)
    }
    const stage = fields.stage ?? project.currentStage
    const created = files.map((file) => {
      const attachment = {
        id: randomUUID(),
        projectId: project.id,
        stage,
        kind: 'input',
        title: files.length === 1 && fields.title ? fields.title : file.filename.replace(/\.pdf$/i, ''),
        filename: file.filename,
        mimeType: 'application/pdf',
        sizeBytes: file.buffer.length,
        pages: Math.max(1, Math.round(file.buffer.length / 20000)),
        characters: Math.min(file.buffer.length, 60000),
        truncated: file.filename.toLowerCase().includes('long'),
        createdAt: new Date().toISOString(),
        buffer: file.buffer,
      }
      attachments.set(attachment.id, attachment)
      return stripAttachment(attachment)
    })
    sendJson(response, 201, { attachments: created })
    return true
  }
  const attachment = attachments.get(segments[4])
  if (segments.length >= 5 && (attachment === undefined || attachment.projectId !== project.id)) {
    throw new StageError(404, 'ATTACHMENT_NOT_FOUND', 'attachment not found')
  }
  if (segments.length === 6 && segments[5] === 'content' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': attachment.buffer.length, 'Access-Control-Allow-Origin': '*' })
    response.end(attachment.buffer)
    return true
  }
  if (segments.length === 5 && request.method === 'DELETE') {
    attachments.delete(attachment.id)
    response.writeHead(204, { 'Access-Control-Allow-Origin': '*' }).end()
    return true
  }
  return false
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/**
 * Handle stage routes. Returns true when the request was handled.
 * `projects` is the mock's project Map.
 */
export async function handleStageRoutes(request, response, url, projects, { sendJson, sendError }) {
  const segments = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
  const fail = (error) => {
    if (error instanceof StageError) sendError(response, error.status, error.message, error.code)
    else if (error instanceof SyntaxError) sendError(response, 400, 'request body is not valid JSON', 'INVALID_JSON')
    else throw error
    return true
  }
  const projectOf = (id) => {
    const project = projects.get(id)
    if (project === undefined) throw new StageError(404, 'PROJECT_NOT_FOUND', 'project not found')
    return withStage(project)
  }

  try {
    if (request.method === 'GET' && url.pathname === '/api/settings/models') {
      sendJson(response, 200, { target: { provider: 'deepseek', model: 'deepseek-chat' }, source: 'settings', warnings: [], updatedAt: null, providers: [] })
      return true
    }
    if (request.method === 'GET' && url.pathname === '/api/models') {
      sendJson(response, 200, { models: [{ provider: 'deepseek', model: 'deepseek-chat', displayName: 'DeepSeek Chat', contextWindow: 128000, maxOutput: 8192, capabilities: {}, price: {}, discoveredAt: null }] })
      return true
    }

    const legacyDefaults = url.pathname === '/api/settings/stage-defaults'
    const factoryStage = legacyDefaults ? 'planning' : url.pathname.match(/^\/api\/settings\/stages\/(planning|requirements)$/)?.[1]
    if (factoryStage !== undefined && ['GET', 'PATCH'].includes(request.method)) {
      if (request.method === 'PATCH') factorySettings.set(factoryStage, validateSettings(await readJson(request), factoryFor(factoryStage)))
      const settings = factoryFor(factoryStage)
      sendJson(response, 200, legacyDefaults ? { stageDefaults: settings } : { stage: factoryStage, settings })
      return true
    }

    if (request.method === 'GET' && url.pathname === '/api/sdlc/stages') {
      sendJson(response, 200, { stages: SDLC_STAGES })
      return true
    }

    if (segments[0] === 'api' && segments[1] === 'stage-runs' && segments[2] !== undefined) {
      const run = runs.get(segments[2])
      if (run === undefined) throw new StageError(404, 'STAGE_RUN_NOT_FOUND', 'stage run not found')
      const project = projectOf(run.projectId)
      if (segments.length === 3 && request.method === 'GET') {
        sendJson(response, 200, { run: detail(run) })
        return true
      }
      if (segments.length === 4 && segments[3] === 'reviews' && request.method === 'GET') {
        sendJson(response, 200, { reviews: run.reviews })
        return true
      }
      if (segments.length === 4 && segments[3] === 'events' && request.method === 'GET') {
        const after = url.searchParams.get('after') ?? '0'
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200))
        const events = eventsAfter(run.id, after, limit)
        sendJson(response, 200, { events, nextAfter: events.at(-1)?.id ?? after })
        return true
      }
      if (segments.length === 4 && segments[3] === 'telemetry' && request.method === 'GET') {
        sendJson(response, 200, { telemetry: foldTelemetry(run.id) })
        return true
      }
      if (segments.length === 5 && segments[3] === 'events' && segments[4] === 'stream' && request.method === 'GET') {
        streamEvents(request, response, run, url)
        return true
      }
      if (segments.length === 4 && segments[3] === 'execute' && request.method === 'POST') {
        if (['completed', 'failed', 'cancelled'].includes(run.status)) {
          throw new StageError(409, 'STAGE_RUN_TERMINAL', `stage run is already ${run.status}`)
        }
        if (run.status === 'awaiting_human') {
          throw new StageError(409, 'STAGE_RUN_AWAITING_HUMAN', 'stage run is waiting for a human decision')
        }
        if (run.status !== 'pending') throw new StageError(409, 'STAGE_RUN_RUNNING', 'stage run is already executing')
        run.status = 'analyzing'
        void execute(project, run)
        sendJson(response, 202, { run: detail(run) })
        return true
      }
      if (segments.length === 4 && segments[3] === 'gate' && request.method === 'POST') {
        const body = await readJson(request)
        if (run.status !== 'awaiting_human' || run.pendingGate?.kind !== 'review_changes') {
          throw new StageError(409, 'STAGE_RUN_NOT_AT_REVIEW_GATE', 'stage run is not at a review gate')
        }
        if (!['apply', 'accept'].includes(body?.action)) throw new StageError(400, 'INVALID_GATE_ACTION', 'action must be apply or accept')
        const entry = workspace(project)
        const brief = run.inputText ?? ''
        emit(run, null, 'gate_answered', { action: body.action })
        try {
          if (body.action === 'accept') {
            run.pendingGate = null
            raiseGate(run, 'final', { reviewDecision: 'needs_revision' })
          } else {
            run.pendingGate = null
            run.status = 'revising'
            await roleTurn(run, 'author', {
              thinking: 'Addressing reviewer findings.',
              command: 'apply_patch .aifactory/drafts/telos.md',
              output: 'patched sections',
              text: 'Revised the draft.',
              legacyTool: true,
            })
            run.draftMarkdown = `${telosMarkdown(project, brief)}\n\n_Revised after the review gate._\n`
            // The next review approves, so the run reaches the final gate.
            await reviewFrom(project, run, entry, brief.replace('GATE', 'GATE').includes('CYCLE') ? brief : `${brief} `, run.reviews.length + 2)
          }
        } catch (error) {
          run.summaryMarkdown = `# Planning & Feasibility run failed\n\n${error.message}\n`
          run.status = 'failed'
          run.completedAt = new Date().toISOString()
        }
        sendJson(response, 200, { run: detail(run) })
        return true
      }
      if (segments.length === 5 && segments[3] === 'export' && segments[4] === 'content' && request.method === 'GET') {
        const entry = workspace(project)
        const document = entry.documents.find((candidate) => candidate.stageRunId === run.id)
        if (document?.exportPath === undefined || document.exportPath === null) throw new StageError(404, 'EXPORT_NOT_FOUND', 'no exported PDF for this run')
        const pdf = samplePdf(`${document.title} - ${project.name}`)
        response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Access-Control-Allow-Origin': '*' })
        response.end(pdf)
        return true
      }
      if (segments.length === 4 && segments[3] === 'export' && request.method === 'POST') {
        const entry = workspace(project)
        const document = entry.documents.find((candidate) => candidate.stageRunId === run.id)
        if (document === undefined) throw new StageError(409, 'DOCUMENT_NOT_READY', 'the stage has no approved document yet')
        if ((run.inputText ?? '').includes('RENDERBUG') && !run.exportRetried) {
          run.exportRetried = true
          throw new StageError(500, 'PDF_EXPORT_FAILED', 'renderer crashed while laying out the Economic table')
        }
        document.exportPath = exportPathFor(document, project)
        emit(run, null, 'document_exported', { path: document.exportPath })
        sendJson(response, 200, { export: { path: document.exportPath, bytes: 48213, documentId: document.id } })
        return true
      }
      if (segments.length === 4 && segments[3] === 'decision' && request.method === 'POST') {
        const body = await readJson(request)
        if (run.stage === 'requirements') {
          await decideRequirements(project, run, body)
          sendJson(response, 200, { run: detail(run) })
          return true
        }
        if (run.status !== 'awaiting_human') {
          throw new StageError(409, 'STAGE_RUN_NOT_AWAITING_HUMAN', 'stage run is not awaiting a human decision')
        }
        if (run.pendingGate !== null && run.pendingGate !== undefined && run.pendingGate.kind !== 'final') {
          throw new StageError(409, 'STAGE_RUN_NOT_AWAITING_DECISION', 'the run is at a review gate, not the final gate')
        }
        const entry = workspace(project)
        const brief = run.inputText ?? ''
        if (body?.refine === true) {
          const cycle = (run.pendingGate?.cycle ?? 0) + 1
          emit(run, null, 'gate_answered', { action: 'refine' })
          run.pendingGate = null
          run.status = 'reviewing'
          try {
            await reviewFrom(project, run, entry, `${brief} `, run.reviews.length + 2, { once: true })
            if (run.pendingGate !== null) run.pendingGate.cycle = cycle
          } catch (error) {
            run.summaryMarkdown = `# Planning & Feasibility run failed\n\n${error.message}\n`
            run.status = 'failed'
            run.completedAt = new Date().toISOString()
          }
          sendJson(response, 200, { run: detail(run) })
          return true
        }
        if (!['go', 'conditional_go', 'no_go'].includes(body?.decision)) {
          throw new StageError(400, 'INVALID_HUMAN_DECISION', 'decision must be go, conditional_go or no_go')
        }
        const note = typeof body.note === 'string' ? body.note.trim() : ''
        completeDocument(project, run, entry, brief)
        checkItem(entry, 'planning', 'feasibility_decision')
        run.summaryMarkdown = `${run.summaryMarkdown ?? ''}\n\n## Human decision\n\nDecision: **${body.decision.replace('_', '-')}**\n${note === '' ? '' : `\n${note}\n`}`
        emit(run, null, 'human_decision', { decision: body.decision, note })
        run.pendingGate = null
        run.status = 'completed'
        run.completedAt = new Date().toISOString()
        run.updatedAt = run.completedAt
        sendJson(response, 200, { run: detail(run) })
        return true
      }
      return false
    }

    if (segments[0] !== 'api' || segments[1] !== 'projects' || segments[2] === undefined || segments[2] === 'new') return false
    const projectId = segments[2]

    if (segments[3] === 'attachments') {
      if (await handleAttachments(request, response, projectOf(projectId), segments, sendJson)) return true
    }

    if (segments.length === 6 && segments[3] === 'stages' && segments[5] === 'settings') {
      projectOf(projectId)
      if (!Object.hasOwn(RUNTIMES, segments[4])) throw new StageError(501, 'STAGE_SETTINGS_NOT_IMPLEMENTED', 'stage settings are not implemented')
      const settingsKey = `${projectId}:${segments[4]}`
      const resolved = () => effectiveSettings(projectId, segments[4])
      if (request.method === 'GET') {
        sendJson(response, 200, { settings: resolved() })
        return true
      }
      if (request.method === 'PATCH') {
        projectSettings.set(settingsKey, validateSettings(await readJson(request), projectSettings.get(settingsKey)))
        sendJson(response, 200, { settings: resolved() })
        return true
      }
      if (request.method === 'DELETE') {
        projectSettings.delete(settingsKey)
        sendJson(response, 200, { settings: resolved() })
        return true
      }
    }

    // GET /api/projects/:id → detail with SDLC state
    if (segments.length === 3 && request.method === 'GET') {
      sendJson(response, 200, snapshot(projectOf(projectId)))
      return true
    }

    if (segments.length === 4 && segments[3] === 'stats' && request.method === 'GET') {
      projectOf(projectId)
      if (process.env.MOCK_STATS === 'off') throw new StageError(503, 'WORKSPACE_NOT_CONFIGURED', 'stats unavailable')
      sendJson(response, 200, { stats: projectStats(projectId) })
      return true
    }

    if (segments.length === 4 && segments[3] === 'observability' && request.method === 'GET') {
      projectOf(projectId)
      if (process.env.MOCK_PHOENIX === 'off') throw new StageError(503, 'PHOENIX_DISABLED', 'Phoenix observability is disabled')
      const hours = Number(url.searchParams.get('hours') ?? 24)
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new StageError(400, 'INVALID_HOURS', 'hours must be 1-168')
      sendJson(response, 200, { observability: observability(projectId, hours) })
      return true
    }

    if (segments.length === 4 && segments[3] === 'logs' && request.method === 'GET') {
      projectOf(projectId)
      if (url.searchParams.get('level') && !['debug', 'info', 'warn', 'error'].includes(url.searchParams.get('level'))) {
        throw new StageError(400, 'INVALID_LOG_LEVEL', 'level must be debug, info, warn or error')
      }
      sendJson(response, 200, projectLogs(projectId, url.searchParams))
      return true
    }

    if (segments.length === 4 && segments[3] === 'stage' && request.method === 'PATCH') {
      const project = projectOf(projectId)
      const body = await readJson(request)
      const target = body?.stage
      if (!STAGE_KEYS.includes(target)) throw new StageError(400, 'INVALID_STAGE', 'invalid stage')
      const entry = workspace(project)
      const current = project.currentStage
      if (target !== current) {
        const next = STAGE_KEYS[STAGE_KEYS.indexOf(current) + 1]
        if (next !== target) {
          throw new StageError(409, 'INVALID_STAGE_TRANSITION', `the next stage after ${current} is ${next ?? '(none)'}`)
        }
        const open = entry.checklist
          .filter((item) => item.stage === current && item.required && item.status === 'open')
          .sort((a, b) => a.key.localeCompare(b.key))
        if (open.length > 0) {
          throw new StageError(409, 'STAGE_CHECKLIST_INCOMPLETE', `complete required items for ${current}: ${open.map((item) => item.label).join('; ')}`)
        }
        const now = new Date().toISOString()
        const from = entry.stages.find((stage) => stage.stage === current)
        const to = entry.stages.find((stage) => stage.stage === target)
        from.status = 'completed'
        from.completedAt = now
        to.status = 'in_progress'
        to.startedAt ??= now
        project.currentStage = target
        project.stageUpdatedAt = now
        project.updatedAt = now
      }
      sendJson(response, 200, snapshot(project))
      return true
    }

    if (segments[3] === 'documents') {
      const project = projectOf(projectId)
      const entry = workspace(project)
      if (segments.length === 4 && request.method === 'GET') {
        sendJson(response, 200, { documents: entry.documents.map(stripPrivate) })
        return true
      }
      const document = entry.documents.find((candidate) => candidate.id === segments[4])
      if (document === undefined) throw new StageError(404, 'DOCUMENT_NOT_FOUND', 'document not found')
      if (segments.length === 5 && request.method === 'GET') {
        sendJson(response, 200, { document: stripPrivate(document) })
        return true
      }
      if (segments.length === 6 && segments[5] === 'export' && request.method === 'GET') {
        const fileName = exportPathFor(document, project).split('/').at(-1)
        if (document.exportPath === undefined || document.exportPath === null) throw new StageError(404, 'DOCUMENT_NOT_EXPORTED', 'this document has no exported PDF yet')
        const pdf = samplePdf(`${document.title} - ${project.name}`)
        response.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': pdf.length,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Disposition',
        })
        response.end(pdf)
        return true
      }
      if (segments.length === 6 && segments[5] === 'content' && request.method === 'GET') {
        if (url.searchParams.has('fail') || process.env.MOCK_DOCUMENT_CONTENT_FAIL === '1') {
          throw new StageError(404, 'DOCUMENT_FILE_MISSING', 'document file is missing from the project directory')
        }
        const body = entry.contents.get(document.id) ?? ''
        response.writeHead(200, {
          'Content-Type': document.mimeType,
          'Content-Disposition': `attachment; filename="${document.storagePath.split('/').pop()}"`,
          'Access-Control-Allow-Origin': '*',
        })
        response.end(body)
        return true
      }
      return false
    }

    if (segments[3] === 'stages' && segments[4] !== undefined && segments[5] === 'runs' && segments.length === 6) {
      const project = projectOf(projectId)
      const stage = segments[4]
      if (!STAGE_KEYS.includes(stage)) throw new StageError(400, 'INVALID_STAGE', 'invalid stage')
      if (!Object.hasOwn(RUNTIMES, stage)) throw new StageError(501, 'STAGE_RUNTIME_NOT_IMPLEMENTED', 'stage execution is not implemented')
      if (request.method === 'GET') {
        const list = [...runs.values()]
          .filter((run) => run.projectId === project.id && run.stage === stage)
          .sort((a, b) => b.attempt - a.attempt)
          .map(summaryOf)
        sendJson(response, 200, { runs: list })
        return true
      }
      if (request.method === 'POST') {
        const body = await readJson(request)
        if (body?.brief !== undefined && typeof body.brief !== 'string') {
          throw new StageError(400, 'INVALID_BRIEF', 'brief must be a string')
        }
        const attachmentIds = Array.isArray(body?.attachmentIds) ? body.attachmentIds : []
        if (attachmentIds.length > 20) throw new StageError(400, 'TOO_MANY_ATTACHMENTS', 'a run accepts at most 20 input documents')
        for (const attachmentId of attachmentIds) {
          if (attachments.get(attachmentId)?.projectId !== project.id) throw new StageError(404, 'ATTACHMENT_NOT_FOUND', `attachment ${attachmentId} not found`)
        }
        if (project.rootPath.includes('missing')) {
          throw new StageError(409, 'PROJECT_ROOT_UNAVAILABLE', `project root is not available: ${project.rootPath}`)
        }
        const entry = workspace(project)
        const attempt = [...runs.values()].filter((run) => run.projectId === project.id && run.stage === stage).length + 1
        const prior = entry.stages.filter((state) => state.status === 'completed')
        const context = {
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
            key: stage,
            checklist: entry.checklist.filter((item) => item.stage === stage),
            documents: entry.documents.filter((document) => document.stage === stage).map(stripPrivate),
          },
          priorStages: prior.map((state) => ({ stage: state.stage, summary: `${state.stage} completed`, completedAt: state.completedAt })),
          documents: entry.documents.map(stripPrivate),
          input: body?.brief ?? null,
          attachments: attachmentIds.map((attachmentId) => { const a = attachments.get(attachmentId); return { id: a.id, title: a.title, pages: a.pages } }),
          constraints: { maxReviewCycles: MAX_REVIEW_CYCLES, documentKind: RUNTIMES[stage].kind, cardinality: 'one' },
        }
        const now = new Date().toISOString()
        if (stage === 'requirements') {
          const baseline = entry.documents.findLast((document) => document.kind === 'telos_report' && document.status === 'approved')
          const attachmentCount = [...attachments.values()].filter((a) => a.projectId === project.id && a.stage === stage).length
          const priorBrief = [...runs.values()].findLast((run) => run.projectId === project.id && run.stage === stage && run.inputText?.trim() && !['failed', 'cancelled'].includes(run.status))
          if (baseline === undefined && attachmentCount === 0 && !body?.brief?.trim() && priorBrief === undefined) {
            throw new StageError(409, 'STAGE_PREREQUISITES_MISSING', 'the requirements stage needs: Planning baseline or requirements input (planning-baseline). Provide the evidence or waive it with a reason.')
          }
          const evidence = baseline !== undefined
            ? { kind: 'document', documentId: baseline.id, documentKind: baseline.kind, status: baseline.status }
            : attachmentCount > 0 ? { kind: 'attachment', count: attachmentCount }
              : priorBrief === undefined ? null : { kind: 'brief', runId: priorBrief.id }
          context.readiness = { evaluatedAt: now, prerequisites: [{ key: 'planning-baseline', satisfied: true, evidence }] }
        }
        // The real API serializes a start-time snapshot; later checklist or
        // document mutations must not silently change a run's context/hash.
        const pinnedContext = structuredClone(context)
        const run = {
          id: randomUUID(),
          projectId: project.id,
          stage,
          attempt,
          sessionId: null,
          status: 'pending',
          contextHash: createHash('sha256').update(JSON.stringify(pinnedContext)).digest('hex'),
          context: pinnedContext,
          inputText: body?.brief ?? null,
          analysisMarkdown: null,
          draftMarkdown: null,
          pendingGate: null,
          summaryMarkdown: null,
          startedAt: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
          reviews: [],
        }
        runs.set(run.id, run)
        sendJson(response, 201, { run: detail(run) })
        return true
      }
    }
    return false
  } catch (error) {
    return fail(error)
  }
}
