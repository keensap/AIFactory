import assert from 'node:assert/strict'
import test from 'node:test'
import { DOCUMENT_CHECKLIST_MAP, SDLC_STAGES, STAGE_CHECKLISTS, STAGE_LABELS, nextStage } from '../src/sdlc.ts'

test('defines the eight project stages and their order', () => {
  assert.deepEqual(SDLC_STAGES, [
    'planning', 'requirements', 'design', 'architecture',
    'development', 'testing', 'deployment', 'maintenance',
  ])
  assert.equal(nextStage('planning'), 'requirements')
  assert.equal(nextStage('testing'), 'deployment')
  assert.equal(nextStage('maintenance'), undefined)
})

test('every stage has at least one required checklist item', () => {
  for (const stage of SDLC_STAGES) {
    const items = STAGE_CHECKLISTS[stage]
    assert.ok(items.length > 0, stage)
    assert.ok(items.some((item) => item.required), stage)
  }
})

test('planning is Planning & Feasibility and produces one TELOS report', () => {
  assert.equal(STAGE_LABELS.planning, 'Planning & Feasibility')
  assert.deepEqual(STAGE_CHECKLISTS.planning.map((item) => item.key), [
    'business_idea',
    'stakeholder_goals',
    'telos_report',
    'feasibility_decision',
  ])
  assert.ok(STAGE_CHECKLISTS.planning.every((item) => item.required))
  assert.equal(DOCUMENT_CHECKLIST_MAP.telos_report, 'telos_report')
})
