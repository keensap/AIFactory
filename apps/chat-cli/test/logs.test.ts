import assert from 'node:assert/strict'
import test from 'node:test'
import { logLevel } from '../src/stage-event-sink.ts'

test('classifies stage log levels', () => {
  assert.equal(logLevel('role_error', {}), 'error')
  assert.equal(logLevel('error', {}), 'error')
  assert.equal(logLevel('run_recovered', {}), 'warn')
  assert.equal(logLevel('review_decision', { decision: 'needs_revision' }), 'warn')
  assert.equal(logLevel('review_decision', { decision: 'approved' }), 'info')
  assert.equal(logLevel('thinking', {}), 'debug')
  assert.equal(logLevel('status', {}), 'debug')
  assert.equal(logLevel('tool_call', {}), 'info')
})
