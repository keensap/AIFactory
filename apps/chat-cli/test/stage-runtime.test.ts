import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ProjectService } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import { DshHarness } from '../src/harness.ts'
import type { ModelPin } from '../src/models/index.ts'
import type { renderReportPdf } from '../src/report/pdf.ts'
import { PlanningStageRuntime, StageRuntimeError, buildAnalyzerPrompt, buildContextPacket, cleanMarkdown, parseStageReview } from '../src/stage-runtime.ts'
import type { ProjectWorkspaceSnapshot, ProjectDocument, StageReview, StageRun, StageRunDetail, StageRunEvent, StageRunEventInput } from '../src/workspace.ts'
import type { PostgresProjectWorkspace } from '../src/workspace.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

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
    assert.equal(executed.pendingGate?.kind, 'final', 'the run waits at the final gate')
    assert.equal(executed.reviews.length, 1)
    assert.equal(executed.documents.length, 0, 'no artifact is produced before approval')
    assert.deepEqual(calls, ['analyzer', 'author', 'reviewer'])
    assert.match(executed.summaryMarkdown ?? '', /awaiting human/i)
    const workspaceEvents = (workspace as unknown as { events: StageRunEvent[] }).events
    assert.ok(workspaceEvents.some((event) => event.type === 'role_start' && event.role === 'analyzer'))
    assert.ok(workspaceEvents.some((event) => event.type === 'role_end' && event.role === 'reviewer'))
    assert.ok(workspaceEvents.some((event) => event.type === 'review_decision'))
    assert.ok(workspaceEvents.some((event) => event.type === 'final_gate'))
    assert.equal(workspaceEvents.some((event) => event.type === 'document_created'), false)

    const decided = await runtime.decide(started.id, { decision: 'go', note: 'Approved by sponsor' })
    assert.equal(decided.status, 'completed')
    assert.equal(decided.documents.length, 1, 'the document is stored on completion')
    assert.match(decided.summaryMarkdown ?? '', /Decision: \*\*go\*\*/)
    assert.ok(workspaceEvents.some((event) => event.type === 'document_created'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Model attribution and per-run pinning
// ---------------------------------------------------------------------------

const USAGE_SCRIPT = fileURLToPath(new URL('./support/usage-dsh.mjs', import.meta.url))

function scriptHarness(cwd?: string, env: Record<string, string> = {}): DshHarness {
  return new DshHarness({
    command: process.execPath,
    commandArgs: [USAGE_SCRIPT],
    profile: 'headless',
    ...(cwd !== undefined ? { cwd } : {}),
    timeoutMs: 20_000,
    env,
  })
}

interface FakePin extends ModelPin { released: number }

function fakePin(attribution: ModelPin['attribution'], env: Record<string, string> = {}): FakePin {
  const pin: FakePin = {
    attribution,
    released: 0,
    harness: (cwd) => scriptHarness(cwd, env),
    release() { pin.released += 1 },
  }
  return pin
}

async function runWith(options: { pin?: ModelPin | undefined; harnessEnv?: Record<string, string> }) {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-attr-'))
  const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
  const project = await projects.create({ name: 'Portal', rootPath: root, organization: null, ownerEmail: null, status: 'active' })
  const workspace = fakeWorkspace()
  const runtime = new PlanningStageRuntime({
    projects,
    workspace,
    harnessFactory: (cwd) => scriptHarness(cwd, options.harnessEnv),
    ...(options.pin !== undefined ? { pinModel: () => options.pin } : {}),
  })
  const started = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'Build a portal' })
  return { runtime, workspace, started, root }
}

const events = (workspace: PostgresProjectWorkspace): StageRunEvent[] => (workspace as unknown as { events: StageRunEvent[] }).events

test('role_start records the pinned model and usage events carry model and cost', async () => {
  const pin = fakePin({ provider: 'anthropic', model: 'claude-sonnet-4-5', source: 'settings', price: { input: 3, output: 15 }, contextWindow: 200_000 })
  const { runtime, workspace, started, root } = await runWith({ pin })
  try {
    await runtime.execute(started.id)
    const starts = events(workspace).filter((event) => event.type === 'role_start')
    assert.equal(starts.length, 3)
    for (const event of starts) {
      assert.deepEqual((event.payload as { model: unknown }).model, { provider: 'anthropic', model: 'claude-sonnet-4-5', source: 'settings' })
    }
    const usage = events(workspace).filter((event) => event.type === 'status' && (event.payload as { usage?: unknown }).usage !== undefined)
    assert.equal(usage.length, 3, 'one step_end per role')
    for (const event of usage) {
      const payload = event.payload as { model: unknown; costUsd: number; contextWindow: number; usage: { inputTokens: number } }
      assert.deepEqual(payload.model, { provider: 'anthropic', model: 'claude-sonnet-4-5' })
      assert.equal(payload.contextWindow, 200_000, 'the window is stamped so context % stays computable later')
      // 1000 * 3 + 500 * 15 = 10500 per million
      assert.equal(payload.costUsd, 0.0105)
      assert.equal(payload.usage.inputTokens, 1000, 'the original usage is preserved')
    }
    const other = events(workspace).filter((event) => event.type === 'text')
    assert.ok(other.every((event) => !('model' in (event.payload as object))), 'only usage events are stamped')
    assert.equal(pin.released, 1, 'the pin is released when the run ends')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a model without a price is attributed but has no cost (unknown, not free)', async () => {
  const pin = fakePin({ provider: 'llamacpp', model: 'qwen3-8b', source: 'environment', price: null, contextWindow: 32_768 })
  const { runtime, workspace, started, root } = await runWith({ pin })
  try {
    await runtime.execute(started.id)
    const usage = events(workspace).filter((event) => event.type === 'status' && (event.payload as { usage?: unknown }).usage !== undefined)
    for (const event of usage) {
      const payload = event.payload as Record<string, unknown>
      assert.deepEqual(payload.model, { provider: 'llamacpp', model: 'qwen3-8b' })
      assert.equal('costUsd' in payload, false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a free local model (price 0) records a cost of 0', async () => {
  const pin = fakePin({ provider: 'llamacpp', model: 'qwen3-8b', source: 'settings', price: { input: 0, output: 0 }, contextWindow: 32_768 })
  const { runtime, workspace, started, root } = await runWith({ pin })
  try {
    await runtime.execute(started.id)
    const usage = events(workspace).filter((event) => event.type === 'status' && (event.payload as { usage?: unknown }).usage !== undefined)
    assert.ok(usage.every((event) => (event.payload as { costUsd: number }).costUsd === 0))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('without a pin the harness default runs and events stay unattributed', async () => {
  const { runtime, workspace, started, root } = await runWith({})
  try {
    await runtime.execute(started.id)
    const starts = events(workspace).filter((event) => event.type === 'role_start')
    assert.ok(starts.every((event) => (event.payload as { model: unknown }).model === null))
    const usage = events(workspace).filter((event) => event.type === 'status' && (event.payload as { usage?: unknown }).usage !== undefined)
    assert.equal(usage.length, 3)
    assert.ok(usage.every((event) => !('model' in (event.payload as object)) && !('costUsd' in (event.payload as object))))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unconfigured pin (null attribution) is recorded as the harness default', async () => {
  const pin = fakePin(null)
  const { runtime, workspace, started, root } = await runWith({ pin })
  try {
    await runtime.execute(started.id)
    assert.ok(events(workspace).filter((event) => event.type === 'role_start').every((event) => (event.payload as { model: unknown }).model === null))
    assert.equal(pin.released, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the pin is released even when a role fails', async () => {
  const pin = fakePin({ provider: 'openai', model: 'gpt-4o', source: 'settings', price: { input: 1, output: 1 }, contextWindow: 128_000 }, { FAIL_ROLE: 'author' })
  const { runtime, started, root } = await runWith({ pin })
  try {
    await assert.rejects(() => runtime.execute(started.id), /author failed/)
    assert.equal(pin.released, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('every role of a run uses the pinned harness, not the factory one', async () => {
  const pin = fakePin({ provider: 'openai', model: 'gpt-4o', source: 'settings', price: null, contextWindow: 128_000 })
  const { runtime, started, root } = await runWith({ pin, harnessEnv: { FAIL_ROLE: 'analyzer' } })
  try {
    // harnessFactory would fail the analyzer; the pin's harness does not.
    const detail = await runtime.execute(started.id)
    assert.equal(detail.status, 'awaiting_human')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// PDF inputs and the exported deliverable
// ---------------------------------------------------------------------------

interface FakeWorkspaceExtras {
  events: StageRunEvent[]
  attachments: Map<string, { id: string; title: string; text: string }>
  runAttachments: Map<string, string[]>
  documentExports: Map<string, { path: string; bytes: number }>
  addTestAttachment(input: { id?: string; projectId?: string; title: string; filename: string; text: string; pages?: number }): Promise<{ id: string }>
}

function extras(workspace: PostgresProjectWorkspace): FakeWorkspaceExtras {
  return workspace as unknown as FakeWorkspaceExtras
}

async function runWithPrompt(options: { renderPdf?: typeof renderReportPdf } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-pdf-'))
  const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
  const project = await projects.create({ name: 'ABCClothing', rootPath: root, organization: null, ownerEmail: null, status: 'active' })
  const workspace = fakeWorkspace()
  const prompts: Array<{ role: string; prompt: string }> = []
  const runtime = new PlanningStageRuntime({
    projects,
    workspace,
    harnessFactory: () => { throw new Error('not used') },
    runPrompt: async (role, prompt) => {
      prompts.push({ role, prompt })
      if (role === 'analyzer') return '# Analysis\n\nFeasible.'
      if (role === 'author') return '# TELOS Feasibility Report\n\n## 10. Recommendation\n\nDecision: **Go**\n'
      return '{"decision":"approved","findings":[]}'
    },
    ...(options.renderPdf !== undefined ? { renderPdf: options.renderPdf } : {}),
  })
  return { runtime, workspace, project, root, prompts }
}

test('attached PDFs reach every role prompt and are linked to the run', async () => {
  const { runtime, workspace, project, prompts, root } = await runWithPrompt()
  try {
    const attachment = await extras(workspace).addTestAttachment({
      projectId: project.id, title: 'Requirements brief', filename: 'brief.pdf',
      text: 'The portal must show invoices and accept card payments.',
    })
    const started = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'Build a portal', attachmentIds: [attachment.id] })
    assert.deepEqual(extras(workspace).runAttachments.get(started.id), [attachment.id])

    await runtime.execute(started.id)
    for (const role of ['analyzer', 'author', 'reviewer']) {
      const prompt = prompts.find((entry) => entry.role === role)?.prompt ?? ''
      assert.ok(prompt.includes('INPUT DOCUMENTS'), `${role} prompt has a documents section`)
      assert.ok(prompt.includes('Requirements brief'), `${role} prompt names the document`)
      assert.ok(prompt.includes('The portal must show invoices'), `${role} prompt contains the text`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a run without attachments says so explicitly instead of omitting the section', async () => {
  const { runtime, project, prompts, root } = await runWithPrompt()
  try {
    const started = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'no docs' })
    await runtime.execute(started.id)
    assert.match(prompts[0]!.prompt, /INPUT DOCUMENTS\nThe requester attached no documents/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unknown and excessive attachment ids are rejected before a run is created', async () => {
  const { runtime, workspace, project, root } = await runWithPrompt()
  try {
    await assert.rejects(
      () => runtime.start({ projectId: project.id, stage: 'planning', brief: 'x', attachmentIds: ['00000000-0000-0000-0000-000000000000'] }),
      (error: unknown) => error instanceof StageRuntimeError && error.status === 404 && error.code === 'ATTACHMENT_NOT_FOUND',
    )
    const ids = Array.from({ length: 21 }, (_, index) => `id-${index}`)
    await assert.rejects(
      () => runtime.start({ projectId: project.id, stage: 'planning', brief: 'x', attachmentIds: ids }),
      (error: unknown) => error instanceof StageRuntimeError && error.status === 400 && error.code === 'TOO_MANY_ATTACHMENTS',
    )
    assert.equal(extras(workspace).events.filter((event) => event.type === 'role_start').length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('completing a stage writes the PDF outside .aifactory with the requested name', async () => {
  const { runtime, workspace, project, root } = await runWithPrompt()
  try {
    const started = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'Build a portal' })
    const gated = await runtime.execute(started.id)
    assert.equal(gated.status, 'awaiting_human')
    assert.equal(existsSync(join(root, 'documents')), false, 'no PDF before approval')

    const detail = await runtime.decide(started.id, { decision: 'go' })
    assert.equal(detail.status, 'completed')

    const expected = join(root, 'documents', 'planning', 'TELOS Feasibility Report — ABCClothing.pdf')
    assert.ok(existsSync(expected), `expected ${expected}`)
    assert.ok(!expected.includes('.aifactory'))

    const exported = extras(workspace).documentExports
    assert.equal(exported.size, 1)
    const entry = [...exported.values()][0]!
    assert.equal(entry.path, 'documents/planning/TELOS Feasibility Report — ABCClothing.pdf')
    assert.ok(entry.bytes > 1000)
    assert.ok(extras(workspace).events.some((event) => event.type === 'document_exported'))

    // The PDF really contains the report.
    const { extractText } = await import('unpdf')
    const pdf = await extractText(new Uint8Array(readFileSync(expected)), { mergePages: false })
    const text = (Array.isArray(pdf.text) ? pdf.text : [pdf.text]).join('\n')
    // The file name carries the project; the title page names the report and the project.
    assert.ok(text.includes('TELOS Feasibility Report'))
    assert.ok(text.includes('ABCClothing'))
    assert.ok(text.includes('Decision: Go'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a PDF rendering failure never fails the stage run', async () => {
  const { runtime, workspace, project, root } = await runWithPrompt({
    renderPdf: async () => { throw new Error('renderer exploded') },
  })
  try {
    const started = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'Build a portal' })
    await runtime.execute(started.id)
    const detail = await runtime.decide(started.id, { decision: 'go' })
    assert.equal(detail.status, 'completed', 'the run still completes')
    assert.equal(detail.documents.length, 1, 'the Markdown artifact is still stored')
    assert.ok(existsSync(join(root, 'documents')) === false, 'no partial PDF directory')
    const failure = extras(workspace).events.find((event) => event.type === 'document_export_failed')
    assert.ok(failure, 'the failure is recorded on the run')
    assert.match(JSON.stringify(failure!.payload), /renderer exploded/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportRun re-renders and overwrites the canonical file', async () => {
  const { runtime, project, root } = await runWithPrompt()
  try {
    const started = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'Build a portal' })
    await runtime.execute(started.id)
    await runtime.decide(started.id, { decision: 'go' })
    const file = join(root, 'documents', 'planning', 'TELOS Feasibility Report — ABCClothing.pdf')
    const first = readFileSync(file)
    assert.equal(first.subarray(0, 5).toString(), '%PDF-')
    const again = await runtime.exportRun(started.id)
    assert.equal(again.path, 'documents/planning/TELOS Feasibility Report — ABCClothing.pdf')
    // The title page carries a generation timestamp, so bytes differ; the document does not.
    const second = readFileSync(file)
    assert.equal(second.subarray(0, 5).toString(), '%PDF-')
    assert.ok(second.byteLength > 1000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
