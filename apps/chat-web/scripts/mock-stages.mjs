/**
 * In-memory stage runtime for the mock Chat API: SDLC stages, checklist,
 * documents and Planning & Feasibility runs (analyzer → author → reviewer →
 * human decision). Mirrors `apps/chat-cli` routes and error codes.
 *
 * Execution is simulated on a timer (MOCK_STAGE_STEP_MS, default 1200 ms per
 * step). The brief steers the outcome for testing:
 *   - contains "FAIL"  → author fails while drafting (STAGE_ROLE_FAILED; analysis kept)
 *   - contains "REVIEWERFAIL" → reviewer fails after the draft is saved (analysis + draft kept)
 *   - contains "CYCLE" → reviewer never approves (REVIEW_CYCLE_LIMIT)
 *   - contains "DROP"  → the first event stream connection drops after 4 events
 *   - otherwise        → one needs_revision review, then approved
 * Every role turn writes stage_run_events (role_start … role_end) served by
 * GET /api/stage-runs/:id/events and /events/stream (SSE).
 * A project whose rootPath contains "missing" → 409 PROJECT_ROOT_UNAVAILABLE.
 */

import { createHash, randomUUID } from 'node:crypto'

const STEP_MS = Number(process.env.MOCK_STAGE_STEP_MS ?? 1200)
const MAX_REVIEW_CYCLES = 3

export const SDLC_STAGES = [
  { key: 'planning', name: 'Planning & Feasibility', position: 0 },
  { key: 'requirements', name: 'Requirements', position: 1 },
  { key: 'design', name: 'Design', position: 2 },
  { key: 'architecture', name: 'Architecture', position: 3 },
  { key: 'development', name: 'Development', position: 4 },
  { key: 'testing', name: 'Testing', position: 5 },
  { key: 'deployment', name: 'Deployment', position: 6 },
  { key: 'maintenance', name: 'Maintenance', position: 7 },
]
const STAGE_KEYS = SDLC_STAGES.map((stage) => stage.key)

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
  const { reviews, ...rest } = run
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

async function execute(project, run) {
  const entry = workspace(project)
  const brief = run.inputText ?? ''
  const set = (status) => {
    run.status = status
    run.updatedAt = new Date().toISOString()
  }
  try {
    run.startedAt = new Date().toISOString()
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
    for (let cycle = 1; ; cycle += 1) {
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
        findings,
        createdAt: new Date().toISOString(),
      })
      emit(run, null, 'review_decision', { decision, findings })
      if (approve) break
      if (cycle >= MAX_REVIEW_CYCLES) {
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

    const content = telosMarkdown(project, brief)
    const createdAt = new Date().toISOString()
    for (const existing of entry.documents) {
      if (existing.kind === 'telos_report' && existing.status === 'approved') existing.status = 'superseded'
    }
    const version = entry.documents.filter((document) => document.kind === 'telos_report').length + 1
    const document = {
      id: randomUUID(),
      projectId: project.id,
      stage: 'planning',
      kind: 'telos_report',
      title: 'TELOS feasibility report',
      storagePath: `.aifactory/documents/planning/telos-${run.id}.md`,
      mimeType: 'text/markdown',
      sizeBytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
      status: 'approved',
      version,
      createdAt,
      updatedAt: createdAt,
      stageRunId: run.id,
    }
    entry.documents.push(document)
    entry.contents.set(document.id, content)
    emit(run, null, 'document_created', { documentId: document.id, kind: document.kind, storagePath: document.storagePath })
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
    set('awaiting_human')
  } catch (error) {
    run.summaryMarkdown = `# Planning & Feasibility run failed\n\n${error.message}\n`
    set('failed')
    run.completedAt = new Date().toISOString()
  }
}

/**
 * SSE replay + tail, like chat-cli: `after` (or Last-Event-ID), poll every
 * 100 ms, keepalive comments, `event: end` once the run is terminal and no
 * events remain; stays open for awaiting_human. A brief containing "DROP"
 * closes the first connection after 4 events to exercise reconnects.
 */
const dropped = new Set()
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
      if (segments.length === 4 && segments[3] === 'decision' && request.method === 'POST') {
        const body = await readJson(request)
        if (run.status !== 'awaiting_human') {
          throw new StageError(409, 'STAGE_RUN_NOT_AWAITING_HUMAN', 'stage run is not awaiting a human decision')
        }
        if (!['go', 'conditional_go', 'no_go'].includes(body?.decision)) {
          throw new StageError(400, 'INVALID_HUMAN_DECISION', 'decision must be go, conditional_go or no_go')
        }
        const note = typeof body.note === 'string' ? body.note.trim() : ''
        const entry = workspace(project)
        checkItem(entry, 'planning', 'feasibility_decision')
        run.summaryMarkdown = `${run.summaryMarkdown ?? ''}\n\n## Human decision\n\nDecision: **${body.decision.replace('_', '-')}**\n${note === '' ? '' : `\n${note}\n`}`
        emit(run, null, 'human_decision', { decision: body.decision, note })
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

    // GET /api/projects/:id → detail with SDLC state
    if (segments.length === 3 && request.method === 'GET') {
      sendJson(response, 200, snapshot(projectOf(projectId)))
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
      if (stage !== 'planning') throw new StageError(501, 'STAGE_RUNTIME_NOT_IMPLEMENTED', 'only planning stage execution is implemented')
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
            key: 'planning',
            checklist: entry.checklist.filter((item) => item.stage === 'planning'),
            documents: entry.documents.filter((document) => document.stage === 'planning').map(stripPrivate),
          },
          priorStages: prior.map((state) => ({ stage: state.stage, summary: `${state.stage} completed`, completedAt: state.completedAt })),
          documents: entry.documents.map(stripPrivate),
          input: body?.brief ?? null,
          constraints: { maxReviewCycles: MAX_REVIEW_CYCLES, documentKind: 'telos_report', cardinality: 'one' },
        }
        const now = new Date().toISOString()
        const run = {
          id: randomUUID(),
          projectId: project.id,
          stage,
          attempt,
          sessionId: null,
          status: 'pending',
          contextHash: createHash('sha256').update(JSON.stringify(context)).digest('hex'),
          context,
          inputText: body?.brief ?? null,
          analysisMarkdown: null,
          draftMarkdown: null,
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
