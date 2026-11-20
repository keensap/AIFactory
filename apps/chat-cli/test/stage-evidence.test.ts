import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BASELINE_TEXT_LIMIT, buildSourceRegister, loadBaselineEvidence, renderBaselineEvidence, renderSourceRegister } from '../src/stage-evidence.ts'
import { inspectRequirementsDocument, requirementsDocumentPasses } from '../src/stages/requirements-checks.ts'
import { StageEngine, type StageContextPacket } from '../src/stage-runtime.ts'
import { stageDefinition } from '../src/stages/index.ts'
import { ProjectService } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import type { ProjectDocument } from '../src/workspace.ts'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { COVERED_REQUIREMENTS } from './support/requirements-fixture.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const settings = { maxReviewCycles: 1, minRating: 0, maxBlockers: 0, maxMajor: 0, gateReminderHours: 72 }
function document(text: string, extra: Partial<ProjectDocument> = {}): ProjectDocument {
  return { id: 'baseline', projectId: 'project', stage: 'planning', kind: 'telos_report', title: 'Approved TELOS', storagePath: 'baseline.md', mimeType: 'text/markdown', sizeBytes: Buffer.byteLength(text), sha256: digest(text), status: 'approved', version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...extra }
}

test('baseline selection excludes unapproved and foreign documents and labels bounded content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'baseline-'))
  try {
    const text = 'x'.repeat(BASELINE_TEXT_LIMIT + 20)
    await writeFile(join(root, 'baseline.md'), text)
    const doc = document(text)
    const evidence = await loadBaselineEvidence(root, 'project', [doc, document('bad', { id: 'draft', status: 'rejected', version: 0, createdAt: '2027' }), document('foreign', { projectId: 'other', createdAt: '2028' })], ['telos_report'])
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0]?.documentId, 'baseline')
    assert.equal(evidence[0]?.text.length, BASELINE_TEXT_LIMIT)
    assert.equal(evidence[0]?.truncated, true)
    assert.match(renderBaselineEvidence(evidence), /Truncated: baseline text is limited/)
    assert.match(renderBaselineEvidence(evidence), /version: 1/)
    await writeFile(join(root, 'baseline.md'), 'changed after approval')
    assert.equal((await loadBaselineEvidence(root, 'project', [doc], ['telos_report']))[0]?.status, 'unavailable')
    assert.match(renderBaselineEvidence(undefined), /older run/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('missing or symlink-escaped baseline is explicit unavailable evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'baseline-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'baseline-outside-'))
  try {
    await writeFile(join(outside, 'secret.md'), 'secret')
    await symlink(join(outside, 'secret.md'), join(root, 'baseline.md'))
    const evidence = await loadBaselineEvidence(root, 'project', [document('secret')], ['telos_report'])
    assert.equal(evidence[0]?.status, 'unavailable')
    assert.equal(evidence[0]?.text, '')
    assert.match(renderBaselineEvidence(evidence), /Unavailable/)
    const missing = await loadBaselineEvidence(root, 'project', [document('missing', { storagePath: 'missing.md' })], ['telos_report'])
    assert.equal(missing[0]?.status, 'unavailable')
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('approved planning handoff is frozen and reaches requirements analysis, author, reviewer and revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'baseline-handoff-'))
  try {
    const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
    const project = await projects.create({ name: 'Handoff', rootPath: root, organization: null, ownerEmail: null, status: 'active' })
    const workspace = fakeWorkspace()
    // Mirror the fake's document storage seam on disk, using the real bytes and provenance.
    const addDocument = workspace.addDocument.bind(workspace)
    workspace.addDocument = async (input) => {
      const doc = await addDocument(input)
      doc.projectId = project.id
      doc.sha256 = createHash('sha256').update(input.buffer).digest('hex')
      await mkdir(join(root, '.aifactory/documents/planning'), { recursive: true })
      await writeFile(join(root, doc.storagePath), input.buffer)
      return doc
    }
    const baseline = '# TELOS\n\nSOURCE-MARKER: monthly budget is 2500.'
    const planning = new StageEngine({ projects, workspace, harnessFactory: () => { throw new Error('unused') }, runPrompt: async (role) => role === 'reviewer' ? '{"decision":"approved","rating":100,"findings":[]}' : baseline })
    const plan = await planning.start({ projectId: project.id, stage: 'planning', brief: 'Plan it' })
    await planning.execute(plan.id)
    const approved = await planning.decide(plan.id, { decision: 'go' })
    const prompts: string[] = []
    let reviews = 0
    const requirements = new StageEngine({ definition: stageDefinition('requirements')!, projects, workspace, stageSettings: { requirements: async () => settings }, harnessFactory: () => { throw new Error('unused') }, runPrompt: async (role, prompt) => {
      prompts.push(prompt)
      if (role === 'reviewer') return ++reviews === 1 ? '{"decision":"needs_revision","findings":[{"severity":"major","finding":"fix"}]}' : '{"decision":"approved","rating":100,"findings":[]}'
      if (prompt.includes('## Reviewer findings to fix')) {
        const feedback = prompt.split('## Reviewer findings to fix')[1]!.split('## Current document')[0]!
        const plan = Array.from(feedback.matchAll(/^- (R-\d+) \[/gm), ([, id]) => ({ id, status: 'unaddressed', note: 'Needs clarification' }))
        return `<revision-plan>${JSON.stringify(plan)}</revision-plan>\n${COVERED_REQUIREMENTS}`
      }
      return COVERED_REQUIREMENTS
    } })
    const run = await requirements.start({ projectId: project.id, stage: 'requirements', brief: 'BRIEF-MARKER' })
    const evidence = (run.context as StageContextPacket).baselineEvidence!
    assert.equal(evidence[0]?.status, 'available')
    assert.equal(evidence[0]?.documentId, approved.documents[0]?.id)
    // In-flight runs must not reread a modified artifact.
    await writeFile(join(root, approved.documents[0]!.storagePath), 'MUTATED')
    await requirements.execute(run.id)
    assert.equal(prompts.length, 5)
    for (const prompt of prompts) {
      assert.match(prompt, /SOURCE-MARKER: monthly budget is 2500/)
      assert.match(prompt, /BRIEF-MARKER/)
      assert.match(prompt, /Approved planning baseline/)
      assert.doesNotMatch(prompt, /MUTATED/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const mode of ['brief', 'attachment'] as const) {
  test(`requirements ${mode}-only entry explicitly notes the missing baseline`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'baseline-direct-'))
    try {
      const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
      const project = await projects.create({ name: 'Direct', rootPath: root, organization: null, ownerEmail: null, status: 'active' })
      const workspace = fakeWorkspace()
      const prompts: string[] = []
      const attachment = mode === 'attachment'
        ? await (workspace as unknown as { addTestAttachment(input: { projectId: string; title: string; filename: string; text: string }): Promise<{ id: string }> }).addTestAttachment({ projectId: project.id, title: 'Client input', filename: 'client.pdf', text: 'DIRECT-INPUT-MARKER' })
        : undefined
      const engine = new StageEngine({ definition: stageDefinition('requirements')!, projects, workspace, harnessFactory: () => { throw new Error('unused') }, runPrompt: async (role, prompt) => {
        prompts.push(prompt)
        return role === 'reviewer' ? '{"decision":"approved","rating":100,"findings":[]}' : COVERED_REQUIREMENTS
      } })
      const run = await engine.start({ projectId: project.id, stage: 'requirements', ...(attachment === undefined ? { brief: 'DIRECT-INPUT-MARKER' } : { attachmentIds: [attachment.id] }) })
      assert.deepEqual((run.context as StageContextPacket).baselineEvidence, [])
      await engine.execute(run.id)
      assert.equal(prompts.length, 3)
      for (const prompt of prompts) {
        assert.match(prompt, /No approved planning baseline is available/)
        assert.match(prompt, /DIRECT-INPUT-MARKER/)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

test('imported approved PDF baseline uses the existing PDF extraction path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'baseline-pdf-'))
  try {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage().drawText('PDF-BASELINE-MARKER', { x: 50, y: 700, font })
    const bytes = await pdf.save()
    await writeFile(join(root, 'baseline.pdf'), bytes)
    const doc = document('', { storagePath: 'baseline.pdf', mimeType: 'application/pdf', sha256: createHash('sha256').update(bytes).digest('hex') })
    const evidence = await loadBaselineEvidence(root, 'project', [doc], ['telos_report'])
    assert.equal(evidence[0]?.status, 'available')
    assert.match(evidence[0]!.text, /PDF-BASELINE-MARKER/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('baseline selection matches readiness version ordering and never resurrects rejected history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'baseline-versions-'))
  try {
    await writeFile(join(root, 'baseline.md'), 'current')
    const older = document('current', { version: 1, createdAt: '2027' })
    const current = document('current', { id: 'v2', version: 2, createdAt: '2026' })
    assert.equal((await loadBaselineEvidence(root, 'project', [older, current], ['telos_report']))[0]?.documentId, 'v2')
    assert.deepEqual(await loadBaselineEvidence(root, 'project', [older, { ...current, status: 'rejected' }], ['telos_report']), [])
    const imported = await loadBaselineEvidence(root, 'project', [{ ...current, status: 'uploaded' }], ['telos_report'])
    assert.equal(imported[0]?.status, 'available')
    assert.equal(imported[0]?.sourceStatus, 'uploaded')
    assert.match(renderBaselineEvidence(imported), /Imported planning input \(not approved\)/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ---- FR-201: source register ---------------------------------------------

test('the source register numbers brief, baseline and uploads with provenance, and stays unclassified', () => {
  const sources = buildSourceRegister({
    brief: '  Build a booking portal  ',
    briefAt: '2026-11-19T10:00:00.000Z',
    attachments: [{ id: 'att-1', title: 'Clinic policy', filename: 'policy.pdf', characters: 900, createdAt: '2026-11-18T09:00:00.000Z', sha256: 'f'.repeat(64) }],
    baseline: [{ documentId: 'doc-7', kind: 'telos_report', title: 'TELOS', version: 2, sha256: 'a'.repeat(64), storagePath: 'x.md', sourceStatus: 'approved', createdAt: '2026-11-17T08:00:00.000Z', status: 'available', text: 'abc', truncated: false }],
  })
  assert.deepEqual(sources.map(({ id, kind }) => [id, kind]), [['SRC-001', 'brief'], ['SRC-002', 'baseline'], ['SRC-003', 'attachment']])
  assert.equal(sources[0]?.sha256, digest('Build a booking portal'), 'the brief is hashed as recorded, trimmed')
  assert.equal(sources[0]?.receivedAt, '2026-11-19T10:00:00.000Z')
  assert.match(sources[1]!.origin, /doc-7 v2 \(telos_report, approved\)/)
  assert.equal(sources[1]?.receivedAt, '2026-11-17T08:00:00.000Z')
  assert.match(sources[2]!.origin, /policy\.pdf \(attachment att-1\)/)
  assert.ok(sources.every((source) => source.classification === 'unclassified'), 'classification is a documented deferral')
  const rendered = renderSourceRegister(sources)
  assert.match(rendered, /## Source register/)
  assert.match(rendered, /\| `SRC-003` \| attachment \| Clinic policy \|/)
  assert.equal(renderSourceRegister(undefined), '', 'legacy runs render nothing rather than an empty claim')
  assert.match(renderSourceRegister([]), /no recorded sources/)
  assert.deepEqual(buildSourceRegister({ brief: '   ', briefAt: 'x', attachments: [], baseline: [] }), [], 'an empty brief is not a source')
})

test('a requirements run freezes its source register and every role sees it; planning records none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sources-'))
  try {
    const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
    const project = await projects.create({ name: 'Sources', rootPath: root, organization: null, ownerEmail: null, status: 'active' })
    const workspace = fakeWorkspace()
    const attachment = await (workspace as unknown as { addTestAttachment(input: { projectId: string; title: string; filename: string; text: string }): Promise<{ id: string }> }).addTestAttachment({ projectId: project.id, title: 'Client notes', filename: 'notes.pdf', text: 'NOTES' })
    const prompts: string[] = []
    const engine = new StageEngine({ definition: stageDefinition('requirements')!, projects, workspace, stageSettings: { requirements: async () => settings }, harnessFactory: () => { throw new Error('unused') }, runPrompt: async (role, prompt) => {
      prompts.push(prompt)
      return role === 'reviewer' ? '{"decision":"approved","rating":100,"findings":[]}' : COVERED_REQUIREMENTS
    } })
    const run = await engine.start({ projectId: project.id, stage: 'requirements', brief: 'Brief text', attachmentIds: [attachment.id] })
    const sources = (run.context as StageContextPacket).sources!
    assert.deepEqual(sources.map(({ id, kind }) => [id, kind]), [['SRC-001', 'brief'], ['SRC-002', 'attachment']])
    assert.match(sources[1]!.origin, new RegExp(attachment.id))
    assert.ok(!Number.isNaN(Date.parse(sources[1]!.receivedAt)), 'the upload date is recorded')
    const gated = await engine.execute(run.id)
    assert.equal(prompts.length, 3)
    for (const prompt of prompts) assert.match(prompt, /## Source register[\s\S]*`SRC-002` \| attachment \| Client notes/)
    // The fixture cites no SRC ids, so both sources are reported uncited, as advice only.
    const codes = gated.pendingGate?.coverage?.findings.map((finding) => `${finding.code}:${finding.severity}`) ?? []
    assert.deepEqual(codes.filter((code) => code.includes('SOURCE')), ['UNCITED_SOURCE:advisory', 'UNCITED_SOURCE:advisory'])
    assert.equal(gated.pendingGate?.accepted, true, 'source advice does not block')

    const planning = new StageEngine({ projects, workspace, harnessFactory: () => { throw new Error('unused') }, runPrompt: async () => '# x' })
    const plan = await planning.start({ projectId: project.id, stage: 'planning', brief: 'Plan it' })
    assert.equal((plan.context as StageContextPacket).sources, undefined, 'planning context is unchanged')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('cited source ids are checked against the register as advice, never as blockers', () => {
  const sources = buildSourceRegister({ brief: 'b', briefAt: '2026-11-19T00:00:00.000Z', attachments: [], baseline: [] })
  const cited = COVERED_REQUIREMENTS.replace('| FR-001 | Brief |', '| FR-001 | SRC-001 §2 |').replace('| NFR-001 | Brief |', '| NFR-001 | SRC-009 |')
  const report = inspectRequirementsDocument(cited, { sources })
  const source = report.findings.filter((finding) => finding.code.includes('SOURCE'))
  assert.deepEqual(source.map(({ code, severity }) => [code, severity]), [['UNKNOWN_SOURCE', 'advisory']])
  assert.match(source[0]!.message, /SRC-009/)
  assert.equal(requirementsDocumentPasses(report), true)
  assert.deepEqual(inspectRequirementsDocument(cited).findings.filter((finding) => finding.code.includes('SOURCE')), [], 'without a register nothing is checked')
})
