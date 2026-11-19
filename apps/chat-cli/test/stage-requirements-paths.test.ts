/**
 * R7: regression paths of the requirements stage against a real StageEngine.
 *
 * The model is stubbed, the deterministic checks are not. The key guarantee is
 * that no path lets the stage publish an incomplete requirements document
 * because a model reviewer said it was fine.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { ProjectService } from '../src/projects.ts'
import { renderReportPdf } from '../src/report/pdf.ts'
import { SettingsService } from '../src/settings.ts'
import { StageEngine, type StageRole } from '../src/stage-runtime.ts'
import { stageDefinition } from '../src/stages/index.ts'
import { inspectRequirementsDocument } from '../src/stages/requirements-checks.ts'
import { inspectRequirementsCoverage } from '../src/stages/requirements-coverage.ts'
import { inspectRequirementsValidation } from '../src/stages/requirements-validation.ts'
import type { StageRunEvent } from '../src/workspace.ts'
import { FAILURE_MODES, REALISTIC_REQUIREMENTS } from './support/requirements-fixture.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const MAX_CYCLES = 2
const SETTINGS = { maxReviewCycles: MAX_CYCLES, minRating: 80, maxBlockers: 0, maxMajor: 0, gateReminderHours: 72 }
const APPROVE = '{"decision":"approved","rating":100,"findings":[]}'
const BLOCKER = JSON.stringify({
  decision: 'needs_revision',
  rating: 40,
  findings: [{ id: 'F-001', severity: 'blocker', section: '3. Functional requirements', finding: 'FR-002 does not say how long a slot is held', required_change: 'State the hold time' }],
})
/** The engine stores model output trimmed (cleanMarkdown). */
const PUBLISHED = REALISTIC_REQUIREMENTS.trim()
const REQUIREMENTS_CHECKLIST = ['acceptance_criteria', 'requirement_document', 'requirements_review']

/** The code each failure mode is built to trigger in the runtime's combined report. */
const EXPECTED_BLOCKER: Record<string, string> = {
  'missing section': 'CONTRACT_MISSING_SECTION',
  'FR without acceptance criterion': 'UNCOVERED_REQUIREMENT',
  'dangling AC reference': 'DANGLING_ACCEPTANCE_ID',
  'duplicate FR id': 'DUPLICATE_REQUIREMENT_ID',
  'NFR without verification': 'MISSING_NFR_VERIFICATION',
  'missing NFR domain': 'CONTRACT_MISSING_NFR_DOMAIN',
  'missing scope boundary': 'CONTRACT_MISSING_SCOPE_BOUNDARY',
  'register entry without owner': 'CONTRACT_MISSING_REQUIRED_FIELD',
  'register entry without impact': 'CONTRACT_MISSING_REQUIRED_FIELD',
  'empty FR field': 'CONTRACT_MISSING_REQUIRED_FIELD',
  'trivial single-bullet draft': 'NO_FUNCTIONAL_REQUIREMENTS',
  'invalid priority': 'CONTRACT_INVALID_PRIORITY',
  'open register entry without resolve-by': 'CONTRACT_MISSING_RESOLVE_BY',
  'invalid register type': 'CONTRACT_INVALID_REGISTER_TYPE',
  'business rule without acceptance criterion': 'UNCOVERED_REQUIREMENT',
  'business rule applying to an unknown FR': 'DANGLING_REQUIREMENT_ID',
  'inconsistent glossary term': 'CONTRACT_INCONSISTENT_GLOSSARY_TERM',
}

/** The report the runtime gates on: R4 coverage plus R5 validation as blocking CONTRACT_ codes. */
function runtimeReport(markdown: string): Array<{ code: string; severity: string }> {
  return inspectRequirementsDocument(markdown).findings
}

const code = (expected: string) => (error: unknown): boolean => {
  assert.equal((error as { code?: string }).code, expected)
  return true
}

interface Script {
  /** Author outputs in order; the last repeats. A function may throw. */
  drafts?: Array<string | (() => string)>
  /** Reviewer outputs in order; the last repeats. A function may throw. */
  reviews?: Array<string | (() => string)>
  /** Per-brief author override (for HTTP tests with several runs). */
  draftForPrompt?: (prompt: string) => string | undefined
}

function harness(script: Script = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-req-paths-'))
  const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
  const workspace = fakeWorkspace()
  const calls: StageRole[] = []
  const prompts: Array<{ role: StageRole; prompt: string }> = []
  const stored: Array<{ filename: string; markdown: string }> = []
  const pdfs: Array<{ title: string; stageLabel: string; projectName: string }> = []
  const drafts = [...(script.drafts ?? [REALISTIC_REQUIREMENTS])]
  const reviews = [...(script.reviews ?? [APPROVE])]
  const next = (queue: Array<string | (() => string)>): string => {
    const entry = queue.length > 1 ? queue.shift()! : queue[0]!
    return typeof entry === 'function' ? entry() : entry
  }

  // The fake keeps no bytes; capture what the engine asked it to store.
  const addDocument = workspace.addDocument.bind(workspace)
  workspace.addDocument = async (input) => {
    stored.push({ filename: input.filename, markdown: Buffer.from(input.buffer).toString('utf8') })
    return addDocument(input)
  }

  const runtime = new StageEngine({
    definition: stageDefinition('requirements')!,
    projects,
    workspace,
    harnessFactory: () => { throw new Error('not used') },
    runPrompt: async (role, prompt) => {
      calls.push(role)
      prompts.push({ role, prompt })
      if (role === 'analyzer') return '# Analysis\n\n## Actors\n- Patient\n- Receptionist'
      if (role === 'author') return script.draftForPrompt?.(prompt) ?? next(drafts)
      return next(reviews)
    },
    renderPdf: async (input) => {
      pdfs.push({ title: input.title, stageLabel: input.stageLabel, projectName: input.projectName })
      return renderReportPdf(input)
    },
    stageSettings: { requirements: async () => SETTINGS },
  })

  return {
    root, runtime, workspace, projects, calls, prompts, stored, pdfs,
    count: (role: StageRole) => calls.filter((entry) => entry === role).length,
    events: (type?: string) => (workspace as unknown as { events: StageRunEvent[] }).events
      .filter((event) => type === undefined || event.type === type),
    checklistDone: async () => (await workspace.getSnapshot('p')).checklist
      .filter((item) => item.stage === 'requirements' && item.status === 'done')
      .map((item) => item.key)
      .sort(),
    start: async (brief = 'Online appointment booking for Riverside Clinic') => {
      const project = await projects.create({ name: 'Riverside Clinic', rootPath: mkdtempSync(join(root, 'project-')), organization: null, ownerEmail: null, status: 'active' })
      const run = await runtime.start({ projectId: project.id, stage: 'requirements', brief })
      return { project, run }
    },
  }
}

async function using(script: Script, fn: (h: ReturnType<typeof harness>) => Promise<void>): Promise<void> {
  const h = harness(script)
  try {
    await fn(h)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
}

// ---- a. the fixtures themselves ----------------------------------------

test('the realistic requirements fixture has zero findings in the coverage, validation and combined checks', () => {
  // 6 FRs + 7 specified NFRs + 2 business rules; 16 acceptance criterion rows (FR-002 has two).
  assert.equal((REALISTIC_REQUIREMENTS.match(/^\| `AC-\d{3}`/gm) ?? []).length, 16)

  const coverage = inspectRequirementsCoverage(REALISTIC_REQUIREMENTS)
  assert.deepEqual(coverage.findings, [])
  assert.deepEqual(coverage.counts, {
    totalRequirements: 13,
    withAcceptanceCriteria: 13,
    withSource: 13,
    withGoal: 13,
    priorities: { must: 5, should: 1, could: 0, wont: 0 },
    businessRules: 2,
  })

  assert.deepEqual(inspectRequirementsValidation(REALISTIC_REQUIREMENTS), [])
  assert.deepEqual(runtimeReport(REALISTIC_REQUIREMENTS), [])
})

test('every named failure mode differs from the realistic fixture', () => {
  assert.deepEqual(Object.keys(FAILURE_MODES).sort(), Object.keys(EXPECTED_BLOCKER).sort(), 'each failure mode states its expected blocker')
  for (const [name, markdown] of Object.entries(FAILURE_MODES)) {
    assert.notEqual(markdown, REALISTIC_REQUIREMENTS, `${name} must change the fixture`)
  }
})

for (const [name, markdown] of Object.entries(FAILURE_MODES)) {
  test(`failure mode "${name}" produces a blocking ${EXPECTED_BLOCKER[name]} finding in the runtime report`, () => {
    const blocking = runtimeReport(markdown).filter((finding) => finding.severity === 'blocking')
    assert.ok(blocking.length > 0, `${name} has at least one blocking finding`)
    assert.ok(
      blocking.some((finding) => finding.code === EXPECTED_BLOCKER[name]),
      `${name}: expected ${EXPECTED_BLOCKER[name]}, got ${blocking.map((finding) => finding.code).join(', ')}`,
    )
  })
}

// ---- b. a model approval never publishes an incomplete document --------

for (const [name, markdown] of Object.entries(FAILURE_MODES)) {
  test(`"${name}": an unconditionally approving reviewer cannot get the draft published; budget exhausted, gate not accepted, approval refused`, async () => {
    await using({ drafts: [markdown], reviews: [APPROVE] }, async (h) => {
      const { run } = await h.start()
      const gated = await h.runtime.execute(run.id)

      assert.equal(gated.status, 'awaiting_human')
      assert.equal(gated.pendingGate?.kind, 'final')
      assert.equal(gated.pendingGate?.accepted, false, 'deterministic blockers override a 100-rated approval')
      assert.equal(gated.pendingGate?.rating, 100)
      assert.equal(gated.pendingGate?.reviewDecision, 'approved')
      assert.equal(gated.reviewCycles, MAX_CYCLES, 'the automatic budget was exhausted')
      assert.equal(h.count('author'), 1 + MAX_CYCLES, 'one draft plus one revision per cycle')
      assert.equal(h.count('reviewer'), 1 + MAX_CYCLES)
      assert.ok(gated.pendingGate?.coverage?.findings.some((finding) => finding.severity === 'blocking' && finding.code === EXPECTED_BLOCKER[name]))
      const decisions = h.events('review_decision').map((event) => (event.payload as { accepted: boolean }).accepted)
      assert.deepEqual(decisions, Array(1 + MAX_CYCLES).fill(false), 'every review was refused')

      for (const decision of ['approved', 'go', 'conditional_go'] as const) {
        await assert.rejects(() => h.runtime.decide(run.id, { decision, note: 'model says it is fine' }), code('REQUIREMENTS_COVERAGE_BLOCKED'), decision)
      }
      const after = await h.runtime.get(run.id)
      assert.equal(after.status, 'awaiting_human')
      assert.deepEqual(after.pendingGate, gated.pendingGate, 'a refused approval leaves the gate untouched')
      assert.equal(after.documents.length, 0, 'no document is published')
      assert.equal(h.stored.length, 0)
      assert.equal(h.pdfs.length, 0, 'no PDF is rendered')
      assert.equal(h.events('document_created').length, 0)
      assert.equal(h.events('human_decision').length, 0)
      assert.deepEqual(await h.checklistDone(), [])
    })
  })
}

// ---- c. a failed review followed by an acceptable revision -------------

for (const [name, markdown] of Object.entries(FAILURE_MODES)) {
  test(`"${name}" draft is revised automatically into the realistic spec, accepted, and approval publishes one requirements_spec`, async () => {
    await using({ drafts: [markdown, REALISTIC_REQUIREMENTS], reviews: [APPROVE] }, async (h) => {
      const { run } = await h.start()
      const gated = await h.runtime.execute(run.id)

      const decisions = h.events('review_decision').map((event) => (event.payload as { accepted: boolean }).accepted)
      assert.deepEqual(decisions, [false, true], 'first review refused on deterministic findings, second accepted')
      assert.equal(gated.reviewCycles, 1)
      assert.equal(gated.pendingGate?.accepted, true)
      assert.deepEqual(gated.pendingGate?.coverage?.findings, [])
      assert.equal(gated.draftMarkdown, PUBLISHED)
      const revision = h.prompts.filter(({ role }) => role === 'author')[1]!.prompt
      assert.match(revision, /\[blocker\] Requirements coverage:/, 'the deterministic findings were handed to the author')

      const done = await h.runtime.decide(run.id, { decision: 'approved' })
      assert.equal(done.status, 'completed')
      assert.equal(done.pendingGate, null)
      assert.equal(done.documents.length, 1)
      assert.equal(done.documents[0]?.kind, 'requirements_spec')
      assert.equal(done.documents[0]?.stage, 'requirements')
      assert.equal(done.documents[0]?.status, 'approved')
      assert.equal(h.stored.length, 1)
      assert.equal(h.stored[0]?.markdown, PUBLISHED, 'the accepted revision is what is published')
      assert.deepEqual(await h.checklistDone(), REQUIREMENTS_CHECKLIST)
      const human = h.events('human_decision')
      assert.equal(human.length, 1)
      assert.equal('coverageWaiver' in (human[0]!.payload as object), false, 'a clean document needs no waiver')
    })
  })
}

// ---- d. model-reported blockers exhaust the budget ----------------------

test('a reviewer that keeps reporting a blocker on a clean draft exhausts the budget (accepted:false) but ordinary approval is still allowed, since model findings are not deterministic blockers', async () => {
  await using({ drafts: [REALISTIC_REQUIREMENTS], reviews: [BLOCKER] }, async (h) => {
    const { run } = await h.start()
    const gated = await h.runtime.execute(run.id)

    assert.equal(gated.pendingGate?.kind, 'final')
    assert.equal(gated.pendingGate?.accepted, false)
    assert.equal(gated.reviewCycles, MAX_CYCLES)
    assert.equal(gated.pendingGate?.maxReviewCycles, MAX_CYCLES)
    assert.equal(gated.pendingGate?.counts?.blockers, 1)
    assert.equal(gated.pendingGate?.reviewDecision, 'needs_revision')
    assert.deepEqual(gated.pendingGate?.coverage?.findings, [], 'the deterministic report is clean')
    assert.equal(h.count('reviewer'), 1 + MAX_CYCLES)
    assert.match(gated.summaryMarkdown ?? '', /Acceptance criteria: not met/)

    // Observed runtime behaviour: REQUIREMENTS_COVERAGE_BLOCKED is reserved for
    // deterministic findings, so the human may approve over model findings.
    const done = await h.runtime.decide(run.id, { decision: 'approved', note: 'hold time agreed verbally' })
    assert.equal(done.status, 'completed')
    assert.equal(done.documents.length, 1)
    assert.deepEqual(await h.checklistDone(), REQUIREMENTS_CHECKLIST)
  })
})

// ---- e. the published Markdown and its PDF -----------------------------

test('approving a realistic run writes the requirements-specification Markdown and a Requirements PDF outside .aifactory, with no planning or TELOS naming', async () => {
  await using({}, async (h) => {
    const { project, run } = await h.start()
    const gated = await h.runtime.execute(run.id)
    assert.equal(gated.pendingGate?.accepted, true)
    for (const text of [gated.summaryMarkdown ?? '']) {
      assert.match(text, /^# Requirements — awaiting human/)
      assert.doesNotMatch(text, /Planning|TELOS/)
    }

    const done = await h.runtime.decide(run.id, { decision: 'approved', note: 'Ready for design' })
    assert.equal(done.status, 'completed')

    // Markdown: named by the requirements definition's fileStem.
    assert.equal(h.stored.length, 1)
    assert.equal(h.stored[0]?.filename, `requirements-specification-${run.id}.md`)
    assert.equal(h.stored[0]?.markdown, PUBLISHED)
    const created = h.events('document_created')
    assert.equal(created.length, 1)
    assert.equal((created[0]!.payload as { kind: string }).kind, 'requirements_spec')

    // PDF: rendered with the requirements title and stage, into documents/requirements/.
    const exported = h.events('document_exported')
    assert.equal(exported.length, 1)
    assert.equal(h.events('document_export_failed').length, 0)
    const payload = exported[0]!.payload as { path: string; bytes: number; documentId: string }
    assert.equal(payload.documentId, done.documents[0]?.id)
    assert.equal(payload.path, 'documents/requirements/Requirements specification — Riverside Clinic.pdf')
    assert.ok(!payload.path.startsWith('.aifactory'), 'the deliverable lives outside .aifactory')
    const absolute = join(project.rootPath, payload.path)
    assert.ok(existsSync(absolute))
    const bytes = readFileSync(absolute)
    assert.equal(bytes.byteLength, payload.bytes)
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-')
    assert.deepEqual(h.pdfs, [{ title: 'Requirements specification', stageLabel: 'Requirements', projectName: 'Riverside Clinic' }])
    assert.doesNotMatch(basename(payload.path), /TELOS|Planning/)
    const exports = (h.workspace as unknown as { documentExports: Map<string, { path: string }> }).documentExports
    assert.equal(exports.get(done.documents[0]!.id)?.path, payload.path)

    // Summaries name the requirements stage, keep the parsed section headings,
    // and carry no planning text.
    const summary = done.summaryMarkdown ?? ''
    assert.match(summary, /^# Requirements — stage summary/)
    assert.match(summary, /## Human decision\n\nDecision: \*\*approved\*\*/)
    assert.match(summary, /Ready for design/)
    assert.doesNotMatch(summary, /Planning|TELOS/)

    // A re-export keeps the same requirements naming.
    const again = await h.runtime.exportRun(run.id)
    assert.equal(again.path, payload.path)
  })
})

// ---- f. failure and retry ----------------------------------------------

test('an author failure on first execution fails the requirements run; retry re-runs only the author and reaches the gate', async () => {
  let thrown = false
  const failOnce = (): string => {
    if (!thrown) {
      thrown = true
      throw new Error('synthetic author timeout')
    }
    return REALISTIC_REQUIREMENTS
  }
  await using({ drafts: [failOnce], reviews: [APPROVE] }, async (h) => {
    const { run } = await h.start()
    await assert.rejects(() => h.runtime.execute(run.id), /synthetic author timeout/)
    const failed = await h.runtime.get(run.id)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.pendingGate, null)
    assert.match(failed.summaryMarkdown ?? '', /^# Requirements run failed/)
    assert.match(failed.summaryMarkdown ?? '', /synthetic author timeout/)
    assert.doesNotMatch(failed.summaryMarkdown ?? '', /Planning|TELOS/)
    assert.equal(failed.draftMarkdown, null)
    assert.deepEqual(h.calls, ['analyzer', 'author'])

    const retried = await h.runtime.retry(run.id)
    assert.equal(retried.status, 'pending')
    const event = h.events('run_retried')
    assert.equal(event.length, 1)
    assert.deepEqual(event[0]!.payload, { attempt: 1, hadAnalysis: true, hadDraft: false })

    const gated = await h.runtime.execute(run.id)
    assert.equal(gated.pendingGate?.kind, 'final')
    assert.equal(gated.pendingGate?.accepted, true)
    assert.deepEqual(h.calls, ['analyzer', 'author', 'author', 'reviewer'], 'the stored analysis was reused')

    const done = await h.runtime.decide(run.id, { decision: 'approved' })
    assert.equal(done.status, 'completed')
    assert.equal(done.documents.length, 1)
    assert.deepEqual(await h.checklistDone(), REQUIREMENTS_CHECKLIST)
  })
})

test('a reviewer failure on first execution fails the requirements run; retry reuses the stored analysis and draft', async () => {
  let thrown = false
  const failOnce = (): string => {
    if (!thrown) {
      thrown = true
      throw new Error('synthetic reviewer outage')
    }
    return APPROVE
  }
  await using({ drafts: [REALISTIC_REQUIREMENTS], reviews: [failOnce] }, async (h) => {
    const { run } = await h.start()
    await assert.rejects(() => h.runtime.execute(run.id), /synthetic reviewer outage/)
    const failed = await h.runtime.get(run.id)
    assert.equal(failed.status, 'failed')
    assert.match(failed.summaryMarkdown ?? '', /synthetic reviewer outage/)
    assert.equal(failed.draftMarkdown, PUBLISHED, 'the draft survives the failure')
    await assert.rejects(() => h.runtime.decide(run.id, { decision: 'approved' }), code('STAGE_RUN_NOT_AWAITING_DECISION'))

    await h.runtime.retry(run.id)
    assert.equal((h.events('run_retried')[0]!.payload as { hadDraft: boolean }).hadDraft, true)
    const gated = await h.runtime.execute(run.id)
    assert.equal(gated.pendingGate?.accepted, true)
    assert.equal(gated.reviewCycles, 0)
    assert.deepEqual(h.calls, ['analyzer', 'author', 'reviewer', 'reviewer'], 'neither analyzer nor author ran again')

    const done = await h.runtime.decide(run.id, { decision: 'approved' })
    assert.equal(done.status, 'completed')
    assert.equal(done.documents.length, 1)
  })
})

// ---- g. every decision path over HTTP ----------------------------------

const BLOCKED_BRIEF = 'BLOCKED-BRIEF'
const BLOCKED_DRAFT = FAILURE_MODES['dangling AC reference']!

test('the HTTP decision route drives every requirements decision path', async () => {
  const h = harness({ draftForPrompt: (prompt) => prompt.includes(BLOCKED_BRIEF) ? BLOCKED_DRAFT : REALISTIC_REQUIREMENTS })
  const { createChatServer, serverPort } = await import('../src/server.ts')
  const { DshHarness } = await import('../src/harness.ts')
  const { SessionStore } = await import('../src/store.ts')
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-req-paths-api-'))
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    projects: h.projects,
    workspace: h.workspace,
    // No planning runtime: requirements runs must resolve through stageEngines.
    stageEngines: {
      for: (stage) => stage === 'requirements' ? h.runtime : undefined,
      forRun: async (runId) => (await h.workspace.getStageRun(runId))?.stage === 'requirements' ? h.runtime : undefined,
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const base = `http://127.0.0.1:${serverPort(server)}`
  type Run = { id: string; status: string; reviewCycles: number; pendingGate: { kind: string; accepted?: boolean } | null; documents: Array<{ kind: string }>; summaryMarkdown: string | null }
  const post = async (path: string, body?: unknown): Promise<{ status: number; json: { run?: Run; error?: { code: string } } }> => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
    return { status: response.status, json: await response.json() as { run?: Run; error?: { code: string } } }
  }
  const decide = (runId: string, body: unknown) => post(`/api/stage-runs/${runId}/decision`, body)
  const refused = async (runId: string, body: unknown, status: number, expected: string): Promise<void> => {
    const result = await decide(runId, body)
    assert.equal(result.status, status, `${JSON.stringify(body)} → ${status}`)
    assert.equal(result.json.error?.code, expected, `${JSON.stringify(body)} → ${expected}`)
  }
  const gatedRun = async (brief: string): Promise<Run> => {
    const project = await h.projects.create({ name: 'Riverside Clinic', rootPath: mkdtempSync(join(h.root, 'api-')), organization: null, ownerEmail: null, status: 'active' })
    const created = await post(`/api/projects/${project.id}/stages/requirements/runs`, { brief })
    assert.equal(created.status, 201)
    const executed = await post(`/api/stage-runs/${created.json.run!.id}/execute?wait=1`)
    assert.equal(executed.status, 200)
    assert.equal(executed.json.run?.status, 'awaiting_human')
    assert.equal(executed.json.run?.pendingGate?.kind, 'final')
    return executed.json.run!
  }

  try {
    // ---- a clean draft ----
    const clean = await gatedRun('Online appointment booking')
    assert.equal(clean.pendingGate?.accepted, true)

    // An empty or unknown decision never approves.
    await refused(clean.id, {}, 400, 'INVALID_HUMAN_DECISION')
    await refused(clean.id, { note: 'looks fine' }, 400, 'INVALID_HUMAN_DECISION')
    await refused(clean.id, { decision: 'maybe' }, 400, 'INVALID_HUMAN_DECISION')
    await refused(clean.id, { refine: false }, 400, 'INVALID_HUMAN_DECISION')

    // Malformed waivers are refused before anything runs.
    await refused(clean.id, { decision: 'approved', coverageWaiverReason: 42 }, 400, 'INVALID_COVERAGE_WAIVER')
    await refused(clean.id, { decision: 'approved', coverageWaiverReason: null }, 400, 'INVALID_COVERAGE_WAIVER')
    await refused(clean.id, { refine: true, coverageWaiverReason: 'please' }, 400, 'INVALID_COVERAGE_WAIVER')
    await refused(clean.id, { decision: 'approved', coverageWaiverReason: '   ' }, 400, 'INVALID_COVERAGE_WAIVER')
    await refused(clean.id, { decision: 'approved', coverageWaiverReason: 'x'.repeat(2001) }, 400, 'INVALID_COVERAGE_WAIVER')
    await refused(clean.id, { decision: 'go', coverageWaiverReason: 'exception' }, 400, 'INVALID_COVERAGE_WAIVER')
    await refused(clean.id, { decision: 'rejected', coverageWaiverReason: 'exception' }, 400, 'INVALID_COVERAGE_WAIVER')

    // Rejection keeps the gate open and publishes nothing.
    const rejected = await decide(clean.id, { decision: 'rejected', note: 'Need the family booking answer first' })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.json.run?.status, 'awaiting_human')
    assert.equal(rejected.json.run?.pendingGate?.kind, 'final')
    assert.deepEqual(rejected.json.run?.documents, [])
    assert.match(rejected.json.run?.summaryMarkdown ?? '', /Decision: \*\*rejected\*\*/)
    assert.doesNotMatch(rejected.json.run?.summaryMarkdown ?? '', /Planning|TELOS/)

    // no_go is the rejection alias on an approval stage.
    const noGo = await decide(clean.id, { decision: 'no_go' })
    assert.equal(noGo.status, 200)
    assert.equal(noGo.json.run?.status, 'awaiting_human')
    assert.deepEqual(noGo.json.run?.documents, [])
    assert.match(noGo.json.run?.summaryMarkdown ?? '', /Decision: \*\*no-go\*\* — the stage was not completed/)
    assert.deepEqual(
      h.events('gate_decision').filter((event) => event.stageRunId === clean.id).map((event) => (event.payload as { decision?: string }).decision),
      ['rejected', 'no_go'],
    )

    // Refine runs one more review and returns to the gate.
    const reviewsBefore = h.count('reviewer')
    const refined = await decide(clean.id, { refine: true })
    assert.equal(refined.status, 200)
    assert.equal(refined.json.run?.status, 'awaiting_human')
    assert.equal(refined.json.run?.pendingGate?.kind, 'final')
    assert.equal(refined.json.run?.pendingGate?.accepted, true)
    assert.equal(h.count('reviewer'), reviewsBefore + 1)
    assert.deepEqual(refined.json.run?.documents, [])

    // The go alias approves a clean draft.
    const approved = await decide(clean.id, { decision: 'go', note: 'ship it to design' })
    assert.equal(approved.status, 200)
    assert.equal(approved.json.run?.status, 'completed')
    assert.equal(approved.json.run?.documents.length, 1)
    assert.equal(approved.json.run?.documents[0]?.kind, 'requirements_spec')
    assert.match(approved.json.run?.summaryMarkdown ?? '', /Decision: \*\*go\*\*/)
    await refused(clean.id, { decision: 'approved' }, 409, 'STAGE_RUN_NOT_AWAITING_DECISION')

    // ---- a draft with deterministic blockers ----
    const blocked = await gatedRun(BLOCKED_BRIEF)
    assert.equal(blocked.pendingGate?.accepted, false)
    assert.equal(blocked.reviewCycles, MAX_CYCLES)
    for (const decision of ['approved', 'go', 'conditional_go']) {
      await refused(blocked.id, { decision }, 409, 'REQUIREMENTS_COVERAGE_BLOCKED')
    }
    // A waiver only accompanies an explicit 'approved'.
    await refused(blocked.id, { decision: 'conditional_go', coverageWaiverReason: 'tracked' }, 400, 'INVALID_COVERAGE_WAIVER')

    // Refining a blocked draft revises it once more and comes back to the gate.
    const blockedRefined = await decide(blocked.id, { refine: true })
    assert.equal(blockedRefined.status, 200)
    assert.equal(blockedRefined.json.run?.status, 'awaiting_human')
    assert.equal(blockedRefined.json.run?.pendingGate?.accepted, false)
    assert.equal(blockedRefined.json.run?.reviewCycles, MAX_CYCLES + 1)

    // Rejecting a blocked draft is always allowed and still publishes nothing.
    const blockedRejected = await decide(blocked.id, { decision: 'rejected' })
    assert.equal(blockedRejected.status, 200)
    assert.deepEqual(blockedRejected.json.run?.documents, [])

    const stillBlocked = await (await fetch(`${base}/api/stage-runs/${blocked.id}`)).json() as { run: Run }
    assert.equal(stillBlocked.run.status, 'awaiting_human')
    assert.deepEqual(stillBlocked.run.documents, [])

    // An explicit, audited waiver completes it.
    const waived = await decide(blocked.id, { decision: 'approved', coverageWaiverReason: '  AC-099 is tracked in the design backlog  ', note: 'accepted risk' })
    assert.equal(waived.status, 200)
    assert.equal(waived.json.run?.status, 'completed')
    assert.equal(waived.json.run?.documents.length, 1)
    assert.match(waived.json.run?.summaryMarkdown ?? '', /Coverage waiver reason: AC-099 is tracked in the design backlog/)
    const decision = h.events('human_decision').find((event) => event.stageRunId === blocked.id)
    const audit = decision?.payload as { decision: string; note: string; coverageWaiver: { reason: string; findings: Array<{ code: string; severity: string }> } }
    assert.equal(audit.decision, 'approved')
    assert.equal(audit.note, 'accepted risk')
    assert.equal(audit.coverageWaiver.reason, 'AC-099 is tracked in the design backlog', 'the reason is recorded trimmed')
    assert.ok(audit.coverageWaiver.findings.length > 0)
    assert.ok(audit.coverageWaiver.findings.every((finding) => finding.severity === 'blocking'))
    assert.ok(audit.coverageWaiver.findings.some((finding) => finding.code === 'DANGLING_ACCEPTANCE_ID'))

    // The clean run recorded no waiver.
    const cleanDecision = h.events('human_decision').find((event) => event.stageRunId === clean.id)
    assert.equal('coverageWaiver' in (cleanDecision?.payload as object), false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('over HTTP, a waiver on a clean requirements draft completes it without recording a waiver', async () => {
  const h = harness()
  const { createChatServer, serverPort } = await import('../src/server.ts')
  const { DshHarness } = await import('../src/harness.ts')
  const { SessionStore } = await import('../src/store.ts')
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-req-paths-api-'))
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    projects: h.projects,
    workspace: h.workspace,
    stageEngines: { for: () => h.runtime, forRun: async () => h.runtime },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const base = `http://127.0.0.1:${serverPort(server)}`
  try {
    const { run } = await h.start()
    await h.runtime.execute(run.id)
    const response = await fetch(`${base}/api/stage-runs/${run.id}/decision`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', coverageWaiverReason: 'nothing to waive' }),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as { run: { status: string; summaryMarkdown: string } }
    assert.equal(body.run.status, 'completed')
    assert.doesNotMatch(body.run.summaryMarkdown, /Coverage waiver reason/)
    const decision = h.events('human_decision')[0]!.payload as object
    assert.equal('coverageWaiver' in decision, false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(h.root, { recursive: true, force: true })
  }
})
