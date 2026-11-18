import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectService } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import {
  PlanningStageRuntime,
  classifyHarnessError,
  type StageRole,
} from '../src/stage-runtime.ts'
import type { ModelPin } from '../src/models/index.ts'
import type { DshHarness } from '../src/harness.ts'
import type { StageRunEvent } from '../src/workspace.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const APPROVED = '{"decision":"approved","rating":100,"findings":[]}'

// ---- classification -----------------------------------------------------

test('harness failures are classified for failover, and only some are retryable', () => {
  const cases: Array<[string, string, boolean]> = [
    ['dsh: TRANSPORT: Connection error.', 'unavailable', true],
    ['HTTP 503 from provider', 'unavailable', true],
    ['RATE_LIMIT: slow down', 'rate_limited', true],
    ['harness turn timed out after 300000ms', 'timeout', true],
    ['llm: no API key for provider route', 'unconfigured', true],
    ['harness turn cancelled', 'aborted', false],
    ['content_filter blocked the request', 'content_filter', false],
    ['something unexpected', 'unknown', true],
  ]
  for (const [message, kind, retryable] of cases) {
    assert.deepEqual(classifyHarnessError(message), { kind, retryable }, message)
  }
})

// ---- failover -----------------------------------------------------------

interface Attempt { provider: string; model: string }

/**
 * A runtime whose harness fails or succeeds per model, so failover can be driven
 * without a real provider.
 */
function harness(options: {
  /** Models whose harness throws. */
  failModels?: string[]
  /** Error message the failing model produces. */
  failMessage?: string
  /** Provider health, defaulting to a closed breaker. */
  health?: (provider: string) => { tryAcquire(): boolean; recordSuccess(): void; recordFailure(e: unknown): void } | null
}) {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-failover-'))
  const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
  const workspace = fakeWorkspace()
  const attempts: Attempt[] = []
  const successes: string[] = []
  const failures: string[] = []
  let roles: StageRole[] = []

  const target = {
    provider: 'primary',
    model: 'primary-model',
    fallback: [{ provider: 'backup', model: 'backup-model' }],
  }

  const makePin = (provider: string, model: string): ModelPin => ({
    attribution: { provider, model, source: 'settings', price: { input: 1, output: 1 }, contextWindow: 8_000 },
    routes: { [provider]: { api: 'openai-completions', baseURL: 'http://x', models: [{ id: model }] } },
    attributionFor: (m?: string) => ({ provider, model: m ?? model, source: 'settings', price: { input: 1, output: 1 }, contextWindow: 8_000 }),
    harness: () => {
      attempts.push({ provider, model })
      const harnessStub = {
        run: async (prompt: string, runOptions?: { onEvent?: (event: unknown) => void }) => {
          // The role is identified by the prompt the runtime builds for it.
          const role: StageRole = prompt.includes('You are the reviewer') || /review/i.test(prompt.slice(0, 400))
            ? 'reviewer'
            : prompt.includes('TELOS') && /draft|report/i.test(prompt.slice(0, 400))
              ? 'author'
              : 'analyzer'
          if (options.failModels?.includes(model) === true) {
            throw new Error(options.failMessage ?? 'dsh: TRANSPORT: Connection error.')
          }
          successes.push(model)
          // One usage event per role, so attribution can be asserted.
          runOptions?.onEvent?.({
            type: 'status',
            phase: 'step_end',
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          })
          if (role === 'analyzer') return { text: '# Analysis', stderr: '' }
          if (role === 'author') return { text: '# TELOS Feasibility Report\n\nbody\n', stderr: '' }
          return { text: APPROVED, stderr: '' }
        },
      } as unknown as DshHarness
      return harnessStub
    },
    release: () => {},
  })

  const runtime = new PlanningStageRuntime({
    projects,
    workspace,
    harnessFactory: () => { throw new Error('the fallback path must not use the factory harness') },
    stageSettings: {
      planning: async () => ({
        gateAfterEachReview: false, maxReviewCycles: 1, minRating: 0, maxBlockers: 0, maxMajor: 0, gateReminderHours: 72,
      }),
    },
    currentTarget: () => target,
    pinTarget: async (candidate) => makePin(candidate.provider, candidate.model),
    modelHealth: async (provider) => options.health?.(provider) ?? {
      tryAcquire: () => true,
      recordSuccess: () => {},
      recordFailure: () => {},
    },
  })

  return {
    root, runtime, workspace, attempts, successes, failures, projects,
    events: () => (workspace as unknown as { events: StageRunEvent[] }).events,
    start: async () => {
      const project = await projects.create({ name: 'Failover', rootPath: root, organization: null, ownerEmail: null, status: 'active' })
      const run = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'portal' })
      return { project, run }
    },
  }
}

async function withHarness(
  options: Parameters<typeof harness>[0],
  fn: (h: ReturnType<typeof harness>) => Promise<void>,
): Promise<void> {
  const h = harness(options)
  try {
    await fn(h)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
}

test('a role falls back to the next model and the run completes', async () => {
  await withHarness({ failModels: ['primary-model'] }, async (h) => {
    const { run } = await h.start()
    const gated = await h.runtime.execute(run.id)

    assert.equal(gated.status, 'awaiting_human', 'the run survived the primary outage')
    const fallbacks = h.events().filter((event) => event.type === 'role_fallback')
    assert.ok(fallbacks.length > 0, 'the fallback is recorded')
    const payload = fallbacks[0]!.payload as { from: { model: string }; to: { model: string }; kind: string }
    assert.equal(payload.from.model, 'primary-model')
    assert.equal(payload.to.model, 'backup-model')
    assert.equal(payload.kind, 'unavailable')
    assert.ok(h.successes.includes('backup-model'))
  })
})

test('a non-retryable failure does not fall back', async () => {
  await withHarness({ failModels: ['primary-model'], failMessage: 'harness turn cancelled' }, async (h) => {
    const { run } = await h.start()
    await assert.rejects(
      () => h.runtime.execute(run.id),
      (error: unknown) => (error as { code?: string }).code === 'STAGE_ROLE_FAILED',
    )
    assert.deepEqual(h.attempts.map((attempt) => attempt.model), ['primary-model'], 'the backup was never tried')
    assert.equal(h.events().filter((event) => event.type === 'role_fallback').length, 0)
  })
})

test('an open breaker skips the primary and says so', async () => {
  await withHarness({
    health: (provider) => ({
      tryAcquire: () => provider !== 'primary',
      recordSuccess: () => {},
      recordFailure: () => {},
    }),
  }, async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)
    const skipped = h.events().filter((event) => event.type === 'role_fallback_skipped')
    assert.ok(skipped.length > 0, 'the skip is recorded')
    assert.equal((skipped[0]!.payload as { provider: string }).provider, 'primary')
    assert.deepEqual([...new Set(h.successes)], ['backup-model'], 'only the healthy candidate ran')
  })
})

test('a fallback is attributed to the model that actually ran', async () => {
  await withHarness({ failModels: ['primary-model'] }, async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)
    const usage = h.events().filter((event) => event.type === 'status'
      && (event.payload as { usage?: unknown }).usage !== undefined)
    const models = new Set(usage.map((event) => (event.payload as { model?: { model: string } }).model?.model))
    assert.equal(models.has('backup-model'), true, 'usage names the fallback')
    assert.equal(models.has('primary-model'), false, 'nothing is billed to the model that failed')
  })
})
