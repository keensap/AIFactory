import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectService } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import { PlanningStageRuntime, type StageRole } from '../src/stage-runtime.ts'
import type { ModelPin } from '../src/models/index.ts'
import type { StageRunBindings, StageRunEvent } from '../src/workspace.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const SETTINGS = {
  maxReviewCycles: 3, minRating: 0, maxBlockers: 0, maxMajor: 0, gateReminderHours: 72,
}

function pin(provider: string, model: string): ModelPin {
  return {
    attribution: { provider, model, source: 'settings', price: { input: 1, output: 1 }, contextWindow: 8_000 },
    routes: { [provider]: { api: 'openai-completions', baseURL: 'http://x', models: [{ id: model }] } },
    attributionFor: (m?: string) => ({ provider, model: m ?? model, source: 'settings', price: { input: 1, output: 1 }, contextWindow: 8_000 }),
    harness: () => { throw new Error('not used') },
    release: () => {},
  }
}

/** A runtime whose "current target" and agents can change between calls. */
function harness(options: {
  target?: { provider: string; model: string; fallback: Array<{ provider: string; model: string }> } | null
  agents?: Record<string, { id: string; name: string; persona: string | null; model: string | null; reasoningEffort: string | null; tools: string[]; skills: Array<{ name: string; description: string; instructions: string }> } | undefined>
  pinTargetError?: Error
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-bindings-'))
  const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
  const workspace = fakeWorkspace()
  const prompts: Array<{ role: StageRole; prompt: string }> = []
  let target = options.target === undefined
    ? { provider: 'acme', model: 'model-a', fallback: [] }
    : options.target
  let agents = options.agents ?? {}

  const runtime = new PlanningStageRuntime({
    projects,
    workspace,
    harnessFactory: () => { throw new Error('not used') },
    runPrompt: async (role, prompt) => {
      prompts.push({ role, prompt })
      if (role === 'analyzer') return '# Analysis'
      if (role === 'author') return '# TELOS Feasibility Report\n\nbody\n'
      return '{"decision":"needs_revision","rating":50,"findings":[{"severity":"major","id":"F-1"}]}'
    },
    stageSettings: { planning: async () => SETTINGS },
    currentTarget: () => target,
    catalogDigest: () => 'digest-1',
    pinTarget: async (candidate) => {
      if (options.pinTargetError !== undefined) throw options.pinTargetError
      return pin(candidate.provider, candidate.model)
    },
    pinModel: () => pin(target?.provider ?? 'acme', target?.model ?? 'model-a'),
    agents: {
      async composition(input) {
        return agents[input.process]
      },
    },
  })

  return {
    root, runtime, workspace, projects, prompts,
    events: () => (workspace as unknown as { events: StageRunEvent[] }).events,
    setTarget: (next: typeof target) => { target = next },
    setAgents: (next: typeof agents) => { agents = next },
    start: async () => {
      // Each project needs its own root path; the store enforces uniqueness.
      const projectRoot = mkdtempSync(join(tmpdir(), 'aifactory-bindings-run-'))
      const project = await projects.create({ name: 'Bindings', rootPath: projectRoot, organization: null, ownerEmail: null, status: 'active' })
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

const AGENT_A = {
  id: 'agent-a', name: 'author-a', persona: 'You are A.', model: null,
  reasoningEffort: null, tools: [], skills: [],
}
const AGENT_B = {
  id: 'agent-b', name: 'author-b', persona: 'You are B.', model: null,
  reasoningEffort: null, tools: [], skills: [],
}

// ---- AR-06: bindings ----------------------------------------------------

test('a new run freezes its model and agents', async () => {
  await withHarness({ agents: { author: AGENT_A } }, async (h) => {
    const { run } = await h.start()
    const bindings = (run as { bindings: StageRunBindings | null }).bindings
    assert.ok(bindings !== null, 'bindings are recorded at start')
    assert.equal(bindings!.model?.provider, 'acme')
    assert.equal(bindings!.model?.model, 'model-a')
    assert.equal(bindings!.model?.catalogDigest, 'digest-1')
    assert.equal(bindings!.agents.author?.name, 'author-a')
    assert.equal(bindings!.agents.analyst ?? bindings!.agents.analyzer, null, 'an unassigned process is recorded as null')
  })
})

test('changing the target mid-run does not affect the paused run', async () => {
  await withHarness({ agents: { author: AGENT_A } }, async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)

    // The operator switches the Factory target and the author agent.
    h.setTarget({ provider: 'other', model: 'model-b', fallback: [] })
    h.setAgents({ author: AGENT_B })

    const applied = await h.runtime.get(run.id)
    assert.equal(applied.status, 'awaiting_human')

    const bindings = (await h.runtime.get(run.id)).bindings!
    assert.equal(bindings.model?.model, 'model-a', 'the run keeps the model it started with')
    assert.equal(bindings.agents.author?.name, 'author-a', 'and the agent it started with')
  })
})

test('rebind adopts the current model and agents, and records both', async () => {
  await withHarness({ agents: { author: AGENT_A } }, async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)
    h.setTarget({ provider: 'other', model: 'model-b', fallback: [] })
    h.setAgents({ author: AGENT_B })

    const rebound = await h.runtime.rebind(run.id)
    assert.equal(rebound.before?.model?.model, 'model-a')
    assert.equal(rebound.after?.model?.model, 'model-b')
    assert.equal(rebound.after?.agents.author?.name, 'author-b')

    const event = h.events().find((entry) => entry.type === 'run_rebound')!
    assert.ok(event !== undefined, 'the rebind is audited')
    assert.equal((event.payload as { before: { model: { model: string } | null } }).before.model?.model, 'model-a')

    const stored = (await h.runtime.get(run.id)).bindings!
    assert.equal(stored.model?.model, 'model-b', 'the new binding is what the run now uses')
  })
})

test('a completed run cannot be rebound', async () => {
  await withHarness({}, async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)
    await h.runtime.decide(run.id, { decision: 'go' })
    await assert.rejects(
      () => h.runtime.rebind(run.id),
      (error: unknown) => (error as { code?: string }).code === 'STAGE_RUN_TERMINAL',
    )
  })
})

test('no model target is recorded as null, not as an empty provider', async () => {
  await withHarness({ target: null }, async (h) => {
    const { run } = await h.start()
    // No target and no agents: nothing to freeze, so the run records null and the
    // harness profile default stays in force.
    assert.equal((run as { bindings: unknown }).bindings ?? null, null)

    // With an agent but no model, the agent is bound and the model is explicitly null.
    h.setAgents({ author: AGENT_A })
    const second = await h.start()
    const bindings = (second.run as { bindings: { model: unknown; agents: Record<string, { name: string } | null> } }).bindings
    assert.equal(bindings.model, null, 'no target configured')
    assert.equal(bindings.agents.author?.name, 'author-a')
  })
})

// ---- AR-11: cancellation ------------------------------------------------

test('cancelling a paused run ends it, clears the gate and records why', async () => {
  await withHarness({}, async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)
    const cancelled = await h.runtime.cancel(run.id, 'not needed any more')

    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.pendingGate, null, 'no gate is left open')
    assert.equal(cancelled.cancelReason, 'not needed any more')
    const event = h.events().find((entry) => entry.type === 'run_cancelled')!
    assert.ok(event !== undefined)
    assert.equal((event.payload as { reason: string }).reason, 'not needed any more')
  })
})

test('a terminal run cannot be cancelled', async () => {
  await withHarness({}, async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)
    await h.runtime.decide(run.id, { decision: 'go' })
    await assert.rejects(
      () => h.runtime.cancel(run.id),
      (error: unknown) => (error as { code?: string }).code === 'STAGE_RUN_TERMINAL',
    )
  })
})

// ---- AR-16: stale gates -------------------------------------------------

test('a gate older than its reminder window is reported stale, once', async () => {
  await withHarness({}, async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)

    // Fresh: waiting minutes, not hours.
    let awaiting = await h.runtime.awaiting()
    assert.equal(awaiting.length, 1)
    assert.equal(awaiting[0]!.stale, false)
    assert.equal(awaiting[0]!.reminderAfterHours, 72)
    assert.equal(h.events().filter((entry) => entry.type === 'gate_stale').length, 0)

    // Backdate the gate past the window, as a run waiting over a weekend would be.
    const workspace = h.workspace as unknown as {
      updateStageRun(id: string, patch: { pendingGate: unknown }): Promise<unknown>
    }
    const current = await h.runtime.get(run.id)
    await workspace.updateStageRun(run.id, {
      pendingGate: { ...current.pendingGate, waitingSince: new Date(Date.now() - 100 * 3_600_000).toISOString() },
    })

    awaiting = await h.runtime.awaiting()
    assert.equal(awaiting[0]!.stale, true)
    assert.ok(awaiting[0]!.waitingHours > 99)
    assert.equal(h.events().filter((entry) => entry.type === 'gate_stale').length, 1, 'one reminder')

    // Asked twice, it stays one reminder and the run is unchanged.
    await h.runtime.awaiting()
    assert.equal(h.events().filter((entry) => entry.type === 'gate_stale').length, 1)
    assert.equal((await h.runtime.get(run.id)).status, 'awaiting_human', 'stale is a reminder, never an action')

    await h.runtime.awaiting({ staleOnly: true })
    assert.equal((await h.runtime.awaiting({ staleOnly: true })).length, 1)
  })
})

test('staleOnly filters out fresh gates', async () => {
  await withHarness({}, async (h) => {
    const { run } = await h.start()
    await h.runtime.execute(run.id)
    assert.equal((await h.runtime.awaiting({ staleOnly: true })).length, 0)
    assert.equal((await h.runtime.awaiting()).length, 1)
  })
})

test('the cancel reason survives the immediate path', async () => {
  await withHarness({}, async (h) => {
    const { run } = await h.start()
    // Never executed: no lease, so the request is the action.
    const cancelled = await h.runtime.cancel(run.id, 'spelled wrong')
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.cancelReason, 'spelled wrong', 'a reason given is a reason kept')
  })
})
