import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ModelRuntime, ModelService, type ModelTarget } from '../src/models/index.ts'
import { ProjectService } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import { PlanningStageRuntime } from '../src/stage-runtime.ts'
import type { StageRunEvent } from '../src/workspace.ts'
import { MemoryCatalog, MemorySettings, model, provider } from './support/memory-models.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'

const USAGE_SCRIPT = fileURLToPath(new URL('./support/usage-dsh.mjs', import.meta.url))

function build(
  initial: ModelTarget | null = { provider: 'openai', model: 'gpt-4o', fallback: [] },
  options: { now?: () => number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'aifactory-pin-'))
  const catalog = new MemoryCatalog(
    [
      provider('openai', { kind: 'openai', apiKeyEnv: 'OPENAI_API_KEY' }),
      provider('llamacpp', { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', local: true }),
    ],
    [model('openai', 'gpt-4o', 128_000, { input: 2.5, output: 10 }), model('llamacpp', 'qwen3-8b', 32_768, { input: 0, output: 0 })],
  )
  const settings = new MemorySettings(initial)
  const service = new ModelService({ catalog, store: settings, env: { OPENAI_API_KEY: 'sk-test-key-for-pin-tests-0123456789' } })
  const runtime = new ModelRuntime({
    service,
    command: process.execPath,
    commandArgs: [USAGE_SCRIPT],
    profile: 'headless',
    patchDir: join(dir, 'patches'),
    env: { OPENAI_API_KEY: 'sk-test-key-for-pin-tests-0123456789' },
    validate: false,
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
  service.setTargetChangeHandler(async () => { await runtime.refresh() })
  const patchFiles = (): string[] => (existsSync(join(dir, 'patches')) ? readdirSync(join(dir, 'patches')).filter((name) => name.endsWith('.json')) : [])
  return { dir, catalog, settings, service, runtime, patchFiles, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ---- pin semantics -----------------------------------------------------

test('a pin freezes attribution and price; later changes affect only new pins', async () => {
  const { runtime, service, cleanup } = build()
  try {
    await runtime.refresh()
    const first = runtime.pin()
    assert.deepEqual(first.attribution, { provider: 'openai', model: 'gpt-4o', source: 'settings', price: { input: 2.5, output: 10 }, contextWindow: 128_000 })

    await service.setPrice('openai', 'gpt-4o', { input: 5, output: 20 })
    await service.updateTarget({ provider: 'llamacpp', model: 'qwen3-8b' })
    const second = runtime.pin()
    assert.deepEqual(second.attribution, { provider: 'llamacpp', model: 'qwen3-8b', source: 'settings', price: { input: 0, output: 0 }, contextWindow: 32_768 })
    assert.deepEqual(first.attribution?.price, { input: 2.5, output: 10 }, 'the first pin keeps the price in force when it was taken')
    assert.equal(first.attribution?.provider, 'openai')
    first.release()
    second.release()
  } finally {
    cleanup()
  }
})

test('an attribution handed out cannot be altered through a later pin', async () => {
  const { runtime, cleanup } = build()
  try {
    await runtime.refresh()
    const a = runtime.pin()
    ;(a.attribution as { provider: string }).provider = 'tampered'
    assert.equal(runtime.pin().attribution?.provider, 'openai')
  } finally {
    cleanup()
  }
})

test('a price change refreshes the runtime so the next pin sees it', async () => {
  const { runtime, service, cleanup } = build()
  try {
    await runtime.refresh()
    assert.deepEqual(runtime.pin().attribution?.price, { input: 2.5, output: 10 })
    await service.setPrice('openai', 'gpt-4o', { input: 1, output: 2 })
    assert.deepEqual(runtime.pin().attribution?.price, { input: 1, output: 2 })
  } finally {
    cleanup()
  }
})

test('an unpriced model pins with a null price', async () => {
  const { runtime, catalog, cleanup } = build()
  try {
    catalog.models.find((entry) => entry.model === 'gpt-4o')!.price = {}
    await runtime.refresh()
    assert.equal(runtime.pin().attribution?.price, null)
  } finally {
    cleanup()
  }
})

test('an unconfigured target pins with no attribution and no patch', async () => {
  const { runtime, cleanup } = build(null)
  try {
    await runtime.refresh()
    const pin = runtime.pin()
    assert.equal(pin.attribution, null)
    assert.equal(runtime.leasedPatches(), 0)
    pin.release()
  } finally {
    cleanup()
  }
})

// ---- patch leases ------------------------------------------------------

test('a leased patch survives the target being cleared and many refreshes, and is removed after release', async () => {
  const { runtime, service, patchFiles, cleanup } = build()
  try {
    await runtime.refresh()
    const pin = runtime.pin()
    const pinned = runtime.status().patchPath!
    assert.equal(runtime.leasedPatches(), 1)

    await service.clearTarget()
    assert.ok(existsSync(pinned), 'clearing the target must not delete a patch a running stage still needs')

    for (let i = 0; i < 8; i++) {
      await service.updateTarget({ provider: i % 2 === 0 ? 'llamacpp' : 'openai', model: i % 2 === 0 ? 'qwen3-8b' : 'gpt-4o', temperature: i / 10 })
      await new Promise((resolve) => setTimeout(resolve, 2)) // distinct file names
    }
    assert.ok(existsSync(pinned), 'pruning must skip leased patches')
    assert.ok(patchFiles().length <= 6, `directory stays small, got ${patchFiles().length}`)

    pin.release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(runtime.leasedPatches(), 0)
    assert.equal(existsSync(pinned), false, 'released and superseded patches are pruned')
  } finally {
    cleanup()
  }
})

test('release is idempotent and two pins on one patch need two releases', async () => {
  const { runtime, cleanup } = build()
  try {
    await runtime.refresh()
    const a = runtime.pin()
    const b = runtime.pin()
    assert.equal(runtime.leasedPatches(), 1, 'one file, two holders')
    a.release()
    a.release()
    a.release()
    assert.equal(runtime.leasedPatches(), 1, 'b still holds it')
    b.release()
    assert.equal(runtime.leasedPatches(), 0)
  } finally {
    cleanup()
  }
})

test('pin.harness() starts roles with the pinned patch even after the target changed', async () => {
  const { runtime, service, cleanup, dir } = build()
  const log = join(dir, 'argv.log')
  const previous = process.env.ARGV_LOG
  process.env.ARGV_LOG = log
  try {
    await runtime.refresh()
    const pin = runtime.pin()
    const pinned = runtime.status().patchPath!
    await service.updateTarget({ provider: 'llamacpp', model: 'qwen3-8b' })
    assert.notEqual(runtime.status().patchPath, pinned)

    await pin.harness().run('STAGE_ROLE: analyzer')
    await runtime.harness().run('STAGE_ROLE: analyzer')
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] })
    const patchOf = (argv: string[]): string => argv[argv.indexOf('--patch') + 1]!
    assert.equal(patchOf(lines[0]!.argv), pinned, 'the pinned harness keeps its patch')
    assert.equal(patchOf(lines[1]!.argv), runtime.status().patchPath, 'an unpinned harness follows the current target')
    pin.release()
  } finally {
    if (previous === undefined) delete process.env.ARGV_LOG
    else process.env.ARGV_LOG = previous
    cleanup()
  }
})

// ---- end to end: change the target while a run is in flight ------------

test('changing or clearing the target mid-run does not change the model of later roles', async () => {
  const { runtime, service, cleanup, dir, patchFiles } = build()
  const log = join(dir, 'argv.log')
  const gate = join(dir, 'gate')
  const saved = { ARGV_LOG: process.env.ARGV_LOG, GATE_FILE: process.env.GATE_FILE }
  process.env.ARGV_LOG = log
  process.env.GATE_FILE = gate
  const root = mkdtempSync(join(tmpdir(), 'aifactory-pin-project-'))
  try {
    await runtime.refresh()
    const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
    const project = await projects.create({ name: 'Portal', rootPath: root, organization: null, ownerEmail: null, status: 'active' })
    const workspace = fakeWorkspace()
    const stages = new PlanningStageRuntime({
      projects,
      workspace,
      harnessFactory: () => { throw new Error('the pinned harness must be used') },
      pinModel: () => runtime.pin(),
    })

    const started = await stages.start({ projectId: project.id, stage: 'planning', brief: 'Build a portal' })
    const originalPatch = runtime.status().patchPath!
    const pending = stages.execute(started.id)

    // Wait for the analyzer to start (it then blocks on the gate file).
    for (let i = 0; i < 200 && !existsSync(log); i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(existsSync(log), 'analyzer started')

    // The operator switches the whole Factory to the local model, then clears it, mid-run.
    await service.updateTarget({ provider: 'llamacpp', model: 'qwen3-8b' })
    await service.clearTarget()
    assert.equal(runtime.status().applied, false)
    assert.ok(existsSync(originalPatch), 'the in-flight run still needs its patch')

    writeFileSync(gate, 'go')
    const detail = await pending
    assert.equal(detail.status, 'awaiting_human')

    const lines = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { role: string; argv: string[] })
    assert.deepEqual(lines.map((line) => line.role), ['analyzer', 'author', 'reviewer'])
    for (const line of lines) {
      assert.equal(line.argv[line.argv.indexOf('--patch') + 1], originalPatch, `${line.role} used the run's pinned patch`)
    }

    const recorded = (workspace as unknown as { events: StageRunEvent[] }).events
    const starts = recorded.filter((event) => event.type === 'role_start').map((event) => (event.payload as { model: { provider: string; model: string } }).model)
    assert.deepEqual(starts, [
      { provider: 'openai', model: 'gpt-4o', source: 'settings' },
      { provider: 'openai', model: 'gpt-4o', source: 'settings' },
      { provider: 'openai', model: 'gpt-4o', source: 'settings' },
    ].map((entry) => ({ ...entry })))
    const costs = recorded
      .filter((event) => event.type === 'status' && (event.payload as { costUsd?: number }).costUsd !== undefined)
      .map((event) => (event.payload as { costUsd: number }).costUsd)
    assert.deepEqual(costs, [0.0075, 0.0075, 0.0075], '1000*2.5 + 500*10 per million, at the price in force at run start')

    // Released after the run: nothing is leased any more. The file is kept by the
    // newest-five retention (an unpinned harness may have just captured it) and is
    // pruned as soon as newer patches push it out.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(runtime.leasedPatches(), 0)
    assert.ok(patchFiles().length <= 5)
    for (let i = 0; i < 6; i++) {
      await service.updateTarget({ provider: 'llamacpp', model: 'qwen3-8b', temperature: i / 10 })
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    assert.equal(existsSync(originalPatch), false, 'no longer leased, so it is pruned with the older patches')
    assert.ok(patchFiles().length <= 5)

  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
    cleanup()
  }
})

test('two refreshes in the same millisecond never share a patch file', async () => {
  // Frozen clock: without unique names these two writes would hit the same path
  // and overwrite a patch that a running stage run is still using.
  const { runtime, service, patchFiles, cleanup } = build(undefined, { now: () => 1_700_000_000_000 })
  try {
    await runtime.refresh()
    const pinned = runtime.pin()
    const held = runtime.status().patchPath!
    await service.updateTarget({ provider: 'llamacpp', model: 'qwen3-8b' })
    const next = runtime.status().patchPath!
    assert.notEqual(next, held, 'the frozen clock did not hide the collision')
    assert.ok(existsSync(held), 'the leased patch is intact')
    assert.deepEqual(JSON.parse(readFileSync(held, 'utf8'))[1].config.provider, 'openai')
    assert.deepEqual(JSON.parse(readFileSync(next, 'utf8'))[1].config.provider, 'llamacpp')
    assert.equal(new Set(patchFiles()).size, patchFiles().length, 'file names are unique')
    pinned.release()
  } finally {
    cleanup()
  }
})
