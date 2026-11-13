/**
 * Contract tests for the observability ports.
 *
 * Every provider must satisfy these invariants. Adding an adapter means adding
 * it to the list below — the core is never touched.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMemoryProvider,
  noopProvider,
  type ObservabilityProvider,
  type TraceSpan,
} from '../src/observability/index.ts'

const providers: Array<[string, () => ObservabilityProvider]> = [
  ['noop', () => noopProvider],
  ['memory', () => createMemoryProvider()],
]

const runInput = (projectId: string, runId: string) => ({
  projectId, projectName: `Project ${projectId}`, runId,
  stage: 'planning', attempt: 1, status: 'running',
})

for (const [name, create] of providers) {
  test(`${name}: every recorder method is non-throwing and accepts undefined spans`, async () => {
    const provider = create()
    const logo = provider.recorder
    assert.doesNotThrow(() => logo.recordHarnessEvent(undefined, { type: 'text', text: 'x' }))
    assert.doesNotThrow(() => logo.completeRole(undefined, 'out'))
    assert.doesNotThrow(() => logo.failRole(undefined, new Error('boom')))
    assert.doesNotThrow(() => logo.recordReview(undefined, 'approved', 0))
    assert.doesNotThrow(() => logo.recordDocument(undefined, 'telos_report', '/tmp/x'))
    assert.doesNotThrow(() => logo.recordHumanDecision('p1', 'r1', 'go'))
    assert.doesNotThrow(() => logo.recordHarnessEvent(undefined, { type: 'tool_call', tool: 'bash' }))
    await logo.forgetProject('missing')
    await provider.reader.deleteProject('missing')
    await provider.shutdown()
  })

  test(`${name}: the reader always returns a complete summary shape`, async () => {
    const provider = create()
    const summary = await provider.reader.summary('p1', 24)
    assert.equal(typeof summary.available, 'boolean')
    assert.equal(typeof summary.projectName, 'string')
    assert.equal(summary.windowHours, 24)
    for (const key of ['traces', 'spans', 'errors', 'tools', 'tokens'] as const) {
      assert.equal(typeof summary[key], 'number', key)
    }
    for (const key of ['count', 'avg', 'p50', 'p95', 'max'] as const) {
      assert.equal(typeof summary.latencyMs[key], 'number', `latencyMs.${key}`)
    }
    assert.ok(Array.isArray(summary.roles))
    await provider.shutdown()
  })

  test(`${name}: health always reports a provider name and a valid state`, async () => {
    const provider = create()
    const health = provider.reader.health()
    assert.equal(health.provider, name)
    assert.equal(typeof health.enabled, 'boolean')
    assert.ok(['healthy', 'degraded', 'open', 'disabled'].includes(health.state))
    assert.equal(typeof health.projects, 'number')
    assert.equal(typeof health.exports, 'number')
    assert.equal(typeof health.failures, 'number')
    assert.equal(typeof health.droppedSpans, 'number')
    await provider.shutdown()
  })

  test(`${name}: a span handle exposes ids and survives repeated end()`, async () => {
    const provider = create()
    const span: TraceSpan | undefined = provider.recorder.startRun(runInput('p1', 'r1'))
    if (span !== undefined) {
      assert.match(span.traceId, /^[0-9a-f]{32}$/)
      assert.match(span.spanId, /^[0-9a-f]{16}$/)
      span.setAttribute('k', 'v')
      span.addEvent('e', { a: 1 })
      span.recordException(new Error('x'))
      span.setStatus('error', 'failed')
      assert.doesNotThrow(() => { span.end(); span.end() })
    }
    await provider.shutdown()
  })

  test(`${name}: a role span inherits the parent trace and tokens reach the summary`, async () => {
    const provider = create()
    const run = provider.recorder.startRun(runInput('p1', 'r1'))
    const role = provider.recorder.startRole({
      projectId: 'p1', runId: 'r1', role: 'analyzer', prompt: 'p', timeoutMs: 1000,
      ...(run !== undefined ? { parent: run } : {}),
    })
    if (run !== undefined && role !== undefined) {
      assert.equal(role.traceId, run.traceId, 'role spans share the run trace')
    }
    provider.recorder.recordHarnessEvent(role, {
      type: 'status', phase: 'step_end',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
    provider.recorder.completeRole(role, 'output')
    run?.end()
    const summary = await provider.reader.summary('p1', 24)
    if (name === 'memory') {
      assert.ok(summary.spans >= 1)
      assert.equal(summary.traces, 1)
      assert.equal(summary.tokens, 15)
      assert.equal(summary.roles.find((entry) => entry.role === 'analyzer')?.tokens, 15)
    }
    await provider.shutdown()
  })

  test(`${name}: a provider can be selected from configuration without core changes`, () => {
    // Registry is exercised in observability-registry.test.ts; here we assert
    // the factory contract that the registry relies on.
    const provider = create()
    assert.equal(provider.name, name)
    assert.ok(provider.recorder)
    assert.ok(provider.reader)
    assert.equal(typeof provider.shutdown, 'function')
  })
}
