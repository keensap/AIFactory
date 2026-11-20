import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { renderPrompt } from '../src/processes/render.ts'
import type { Project } from '../src/projects.ts'
import {
  buildAnalyzerPrompt,
  buildAuthorPrompt,
  buildReviewerPrompt,
  buildRevisionPrompt,
  type StageContextPacket,
} from '../src/stage-runtime.ts'
import { settingsFromContext } from '../src/stage-settings.ts'
import { PLANNING_DEFINITION } from '../src/stages/planning.ts'

const timestamp = '2026-01-02T03:04:05.000Z'
const project: Project = {
  id: 'project-1',
  name: 'Café Portal',
  rootPath: '/work/portal',
  organization: 'Example Co',
  ownerEmail: 'owner@example.test',
  status: 'active',
  currentStage: 'planning',
  stageUpdatedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
}
const context: StageContextPacket = {
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
  stage: { key: 'planning', checklist: [], documents: [] },
  priorStages: [{ stage: 'planning', summary: 'Earlier scoping', completedAt: null }],
  documents: [],
  attachments: [{
    id: 'attachment-1',
    title: 'Sponsor brief',
    filename: 'brief.pdf',
    pages: 1,
    characters: 14,
    truncated: false,
    text: 'Usage: 5 cafés',
  }],
  input: 'Plan a pilot.\nKeep evidence explicit.',
  constraints: {
    maxReviewCycles: 2,
    minRating: 87,
    maxBlockers: 0,
    maxMajor: 1,
    documentKind: 'telos_report',
    cardinality: 'one',
  },
}
const analysis = '## Analysis\nPilot feasibility is uncertain.'
const draft = '# TELOS\nConditional go.'
const findings = [{ id: 'F-001', severity: 'major', section: 'Schedule', finding: 'No dates', required_change: 'Flag the gap' }]

// Captured from the actual stage-runtime exports at baseline 68845b1, before extraction.
const adapterPrompts = PLANNING_DEFINITION.prompts
const prompts: Array<[string, string, () => string, () => string]> = [
  ['analyzer', 'b0cd30a96116c803d88b9c8fa38dfa301157c4068ed837bb8d77e49c17735977',
    () => buildAnalyzerPrompt(project, context),
    () => adapterPrompts.analyzer(project, context)],
  ['author', '66f4c83de7228f55304f3464af115c89e2f6d1c4acb8213ea68b76c033ce4f9f',
    () => buildAuthorPrompt(project, context, analysis),
    () => adapterPrompts.author(project, context, analysis)],
  ['reviewer', '7f02cd3cba6b20a4b0faa60e6b83a89c5b091658656163b17bd741ed531cf905',
    () => buildReviewerPrompt(project, context, draft),
    () => adapterPrompts.reviewer(project, context, draft, settingsFromContext(context))],
  ['revision', '25bf7ea60c982a8f8d429c930b1e8b59643f6f5b5faa863f262f5262ac8d3c36',
    () => buildRevisionPrompt(project, context, analysis, draft, findings),
    () => adapterPrompts.revision(project, context, analysis, draft, findings)],
]
for (const [role, expectedHash, runtimePrompt, adapterPrompt] of prompts) {
  for (const [entryPoint, buildPrompt] of [['runtime export', runtimePrompt], ['stage adapter', adapterPrompt]] as const) {
    test(`planning ${role} ${entryPoint} matches the baseline bytes`, () => {
      assert.equal(createHash('sha256').update(buildPrompt(), 'utf8').digest('hex'), expectedHash)
    })
  }
}

test('renderPrompt orders sections and joins bodies without normalizing whitespace', () => {
  const sections = [
    { id: 'last', order: 20, body: 'last\n' },
    { id: 'first', order: 10, body: ' first', maxChars: 6 },
  ]
  assert.deepEqual(renderPrompt(sections), {
    text: ' first\n\nlast\n',
    sections: [
      { id: 'first', originalChars: 6, chars: 6, truncated: false },
      { id: 'last', originalChars: 5, chars: 5, truncated: false },
    ],
  })
  assert.deepEqual(sections.map(({ id }) => id), ['last', 'first'])
})

test('renderPrompt caps the retained body and appends a truncation marker', () => {
  const { text, sections } = renderPrompt([{ id: 'limited', order: 1, body: 'abcXYZ', maxChars: 3 }])
  assert.equal(text.slice(0, 3), 'abc')
  assert.doesNotMatch(text, /XYZ/)
  assert.match(text.slice(3), /truncat/i)
  assert.equal(sections.length, 1)
  assert.equal(sections[0]?.id, 'limited')
  assert.equal(sections[0]?.originalChars, 6)
  assert.equal(sections[0]?.chars, text.length)
  assert.equal(sections[0]?.truncated, true)
})

test('renderPrompt rejects duplicate ids even when orders and bodies differ', () => {
  assert.throws(() => renderPrompt([
    { id: 'duplicate', order: 1, body: 'one' },
    { id: 'duplicate', order: 2, body: 'two' },
  ]), /duplicate/i)
})

test('renderPrompt preserves input order for ties', () => {
  const result = renderPrompt([
    { id: 'z', order: 10, body: 'z' },
    { id: 'a', order: 10, body: 'a' },
  ])
  assert.equal(result.text, 'z\n\na')
  assert.deepEqual(result.sections.map(({ id }) => id), ['z', 'a'])
})

test('renderPrompt accepts an empty section list', () => {
  assert.deepEqual(renderPrompt([]), { text: '', sections: [] })
})
