import assert from 'node:assert/strict'
import test from 'node:test'
import { STAGE_DOCUMENT_REQUIREMENTS, TELOS_DOCUMENT_KIND, TELOS_TEMPLATE } from '../src/telos.ts'

test('planning requires exactly one TELOS document', () => {
  const planning = STAGE_DOCUMENT_REQUIREMENTS.filter((item) => item.stage === 'planning')
  assert.equal(planning.length, 1)
  assert.equal(planning[0]?.kind, TELOS_DOCUMENT_KIND)
  assert.equal(planning[0]?.cardinality, 'one')
  assert.equal(planning[0]?.required, true)
})

test('TELOS template covers all five feasibility dimensions', () => {
  for (const heading of [
    'Technical feasibility',
    'Economic feasibility',
    'Legal feasibility',
    'Operational feasibility',
    'Schedule feasibility',
  ]) {
    assert.match(TELOS_TEMPLATE, new RegExp(heading))
  }
  assert.match(TELOS_TEMPLATE, /Business idea and context/)
  assert.match(TELOS_TEMPLATE, /Stakeholder goals and success measures/)
  assert.match(TELOS_TEMPLATE, /Decision: \*\*Go \/ Conditional go \/ No-go\*\*/)
})
