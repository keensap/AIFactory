import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ObservabilityError,
  NoopObservabilityProvider,
  noopProvider,
  type ObservabilityHealth,
  type ObservabilityProvider,
  type ObservabilitySummary,
} from '../src/observability/index.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

test('the no-op provider satisfies the observability contract without throwing', async () => {
  const provider: ObservabilityProvider = noopProvider
  assert.equal(provider.name, 'noop')
  assert.equal(provider.recorder.startRun({ projectId: 'p1' } as never), undefined)
  assert.equal(provider.recorder.startRole({ projectId: 'p1' } as never), undefined)
  assert.doesNotThrow(() => provider.recorder.recordHarnessEvent(undefined, { type: 'text', text: 'x' }))
  assert.doesNotThrow(() => provider.recorder.recordReview(undefined, 'approved', 0))
  assert.doesNotThrow(() => provider.recorder.recordDocument(undefined, 'telos_report', '/tmp/x'))
  assert.doesNotThrow(() => provider.recorder.recordHumanDecision('p1', 'r1', 'go'))
  assert.equal(provider.recorder.currentTraceContext(), undefined)
  await provider.recorder.forgetProject('p1')

  const summary: ObservabilitySummary = await provider.reader.summary('p1', 24)
  assert.equal(summary.available, false)
  assert.equal(summary.reason, 'observability is disabled')
  assert.equal(summary.projectName, 'p1')
  assert.deepEqual(summary.roles, [])
  assert.deepEqual(summary.latencyMs, { count: 0, avg: 0, p50: 0, p95: 0, max: 0 })

  const health: ObservabilityHealth = provider.reader.health()
  assert.equal(health.provider, 'noop')
  assert.equal(health.enabled, false)
  assert.equal(health.state, 'disabled')
  assert.equal(health.projects, 0)

  await provider.reader.deleteProject('p1')
  await provider.shutdown()
  await provider.shutdown(0)
})

test('the no-op provider is a fresh instance with no shared mutable state', async () => {
  const first = new NoopObservabilityProvider()
  const second = new NoopObservabilityProvider()
  assert.notEqual(first, second)
  assert.equal(await first.recorder.forgetProject('p1'), undefined)
  assert.equal(first.reader.health().provider, 'noop')
})

test('observability errors carry HTTP status and stable codes', () => {
  const error = new ObservabilityError(503, 'OBSERVABILITY_DISABLED', 'disabled')
  assert.equal(error.name, 'ObservabilityError')
  assert.equal(error.status, 503)
  assert.equal(error.code, 'OBSERVABILITY_DISABLED')
  assert.equal(error.message, 'disabled')
})

test('the ports module contains no vendor imports', () => {
  const directory = join(root, 'src/observability')
  const files = readdirSync(directory).filter((name) => name.endsWith('.ts'))
  const importPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  const forbidden = /(?:^|[/@])(?:phoenix|@opentelemetry|opentelemetry|arize)(?:[/.]|$)/i
  for (const name of files) {
    const source = readFileSync(join(directory, name), 'utf8')
    for (const match of source.matchAll(importPattern)) {
      assert.ok(!forbidden.test(match[1]!), `${name} imports vendor code: ${match[1]}`)
    }
  }
})

test('the import guard passes in its current non-strict mode', () => {
  const output = execFileSync(process.execPath, [join(root, 'scripts/check-observability-imports.mjs')], { encoding: 'utf8' })
  assert.match(output, /observability guard: \d+ port files clean/)
})
