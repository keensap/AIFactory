import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBriefingPrompt, parseBriefing } from '../src/briefing.ts'
import type { Project } from '../src/projects.ts'
import type { ProjectWorkspaceSnapshot } from '../src/workspace.ts'

const project: Project = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Portal',
  rootPath: '/srv/portal',
  organization: 'Acme',
  ownerEmail: null,
  status: 'active',
  currentStage: 'requirements',
  stageUpdatedAt: '2026-11-10T08:00:00.000Z',
  createdAt: '2026-11-10T08:00:00.000Z',
  updatedAt: '2026-11-10T08:00:00.000Z',
}

const snapshot: ProjectWorkspaceSnapshot = {
  currentStage: 'requirements',
  stages: [{ stage: 'requirements', status: 'in_progress', startedAt: null, completedAt: null, notes: null }],
  documents: [],
  checklist: [{ id: 'x', stage: 'requirements', key: 'acceptance_criteria', label: 'Acceptance criteria', required: true, status: 'open', evidenceDocumentId: null, completedAt: null }],
  nextActions: [{ kind: 'checklist', stage: 'requirements', key: 'acceptance_criteria', label: 'Acceptance criteria', required: true }],
  progress: { completedStages: 0, totalStages: 8, completedRequiredItems: 0, totalRequiredItems: 16 },
}

test('parses briefing JSON and falls back to Markdown', () => {
  const json = parseBriefing('{"markdown":"# Briefing","risks":["One risk"]}')
  assert.equal(json.markdown, '# Briefing')
  assert.deepEqual(json.risks, ['One risk'])

  const fenced = parseBriefing('```json\n{"markdown":"# Fenced","risks":[]}\n```')
  assert.equal(fenced.markdown, '# Fenced')

  const plain = parseBriefing('# Plain briefing')
  assert.equal(plain.markdown, '# Plain briefing')
  assert.equal(plain.risks.length, 0)
})

test('builds a prompt from structured facts rather than chat history', () => {
  const prompt = buildBriefingPrompt(project, snapshot)
  assert.match(prompt, /Portal/)
  assert.match(prompt, /Use ONLY the structured facts/)
  assert.match(prompt, /Acceptance criteria/)
  assert.doesNotMatch(prompt, /chat history/i)
})
