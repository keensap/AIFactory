import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshHarness } from '../src/harness.ts'
import {
  ModelRuntime,
  defaultCapabilities,
  type ModelCatalog,
  type ModelRecord,
  type ModelSettingsStore,
  type ProviderRecord,
} from '../src/models/index.ts'

const provider = (id: string, overrides: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id, kind: 'openai', displayName: id, baseUrl: null, apiKeyEnv: `${id.toUpperCase()}_API_KEY`,
  headers: {}, defaults: {}, enabled: true, local: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const model = (providerId: string, name: string): ModelRecord => ({
  provider: providerId, model: name, displayName: name, contextWindow: 32768, maxOutput: 8192,
  capabilities: { ...defaultCapabilities(), contextWindow: 32768 }, price: {}, discoveredAt: null,
})

class FakeCatalog implements ModelCatalog {
  providers: ProviderRecord[] = [
    provider('llamacpp', { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: null, local: true }),
    provider('openai'),
  ]
  models: ModelRecord[] = [model('llamacpp', 'qwen3-8b'), model('openai', 'gpt-5')]
  async listProviders(): Promise<ProviderRecord[]> { return this.providers }
  async getProvider(id: string): Promise<ProviderRecord | undefined> { return this.providers.find((entry) => entry.id === id) }
  async listModels(providerId?: string): Promise<ModelRecord[]> {
    return providerId === undefined ? this.models : this.models.filter((entry) => entry.provider === providerId)
  }
  async replaceModels(): Promise<ModelRecord[]> { return [] }
}

class FakeSettings implements ModelSettingsStore {
  target: import('../src/models/index.ts').ModelTarget | null = { provider: 'llamacpp', model: 'qwen3-8b', fallback: [] }
  async load() { return { target: this.target, updatedAt: null } }
  async save(target: import('../src/models/index.ts').ModelTarget) { this.target = target; return { target, updatedAt: null } }
  async clear() { this.target = null }
}

function serviceFor(catalog: FakeCatalog, settings: FakeSettings) {
  // The runtime only needs these three calls; a structural stand-in keeps the test small.
  return {
    async resolveForRun() {
      const target = settings.target
      if (target === null) return { target: null, source: 'unconfigured' as const, warnings: [], updatedAt: null }
      return { target, source: 'settings' as const, warnings: [], updatedAt: null }
    },
    async snapshot() { return { providers: catalog.providers, models: catalog.models } },
  } as unknown as import('../src/models/index.ts').ModelService
}

function runtimeFor(options: { target?: boolean; validate?: boolean; dumpExit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aifactory-patch-'))
  const catalog = new FakeCatalog()
  const settings = new FakeSettings()
  if (options.target === false) settings.target = null
  // Stand-in for `dsh --dump-config`: exit with a controllable status.
  const script = join(dir, 'fake-dsh.mjs')
  writeFileSync(script, `process.exit(${options.dumpExit ?? 0})\n`)
  const runtime = new ModelRuntime({
    service: serviceFor(catalog, settings),
    command: process.execPath,
    commandArgs: [script],
    profile: 'headless',
    patchDir: join(dir, 'patches'),
    env: { OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY: 'sk-anthropic' },
    validate: options.validate ?? false,
  })
  return { runtime, dir, catalog, settings }
}

test('refresh writes a 0600 patch and applies it to the harness', async () => {
  const { runtime, dir } = runtimeFor()
  try {
    const status = await runtime.refresh()
    assert.equal(status.applied, true)
    assert.equal(status.provider, 'llamacpp')
    assert.ok(status.patchPath)
    const mode = statSync(status.patchPath!).mode & 0o777
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
    const content = JSON.parse(readFileSync(status.patchPath!, 'utf8'))
    assert.equal(content[0].id, 'llm-pi-ai')
    assert.equal(content[1].config.provider, 'llamacpp')
    const harness = runtime.harness('/tmp', 1000)
    assert.ok(harness instanceof DshHarness)
  } finally {
    await runtime.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unconfigured target removes the patch and leaves the harness default', async () => {
  const { runtime, dir } = runtimeFor({ target: false })
  try {
    const status = await runtime.refresh()
    assert.equal(status.applied, false)
    assert.equal(status.patchPath, null)
    assert.equal(runtime.currentPatch(), null)
    assert.equal(existsSync(join(dir, 'patches')) ? readdirSync(join(dir, 'patches')).filter((name) => name.endsWith('.json')).length : 0, 0)
  } finally {
    await runtime.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('changing the target rewrites the patch and keeps the previous one for in-flight runs', async () => {
  const { runtime, dir, settings } = runtimeFor()
  try {
    const first = await runtime.refresh()
    settings.target = { provider: 'openai', model: 'gpt-5', fallback: [] }
    const second = await runtime.refresh()
    assert.notEqual(second.patchPath, first.patchPath)
    assert.equal(statSync(first.patchPath!).isFile(), true, 'the harness may still be reading it')
    const content = JSON.parse(readFileSync(second.patchPath!, 'utf8'))
    assert.equal(content[1].config.provider, 'openai')
  } finally {
    await runtime.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed refresh keeps the previous patch and reports the error', async () => {
  const { runtime, dir, catalog } = runtimeFor()
  try {
    const first = await runtime.refresh()
    catalog.providers = [] // simulate the provider disappearing
    const status = await runtime.refresh()
    assert.equal(status.applied, true, 'the last good patch stays applied')
    assert.equal(status.patchPath, first.patchPath)
    assert.match(status.lastError ?? '', /unknown provider/)
  } finally {
    await runtime.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validation runs against the generated patch', async () => {
  const ok = runtimeFor({ validate: true })
  try {
    const status = await ok.runtime.refresh()
    assert.equal(status.applied, true)
    assert.deepEqual(status.warnings, [])
  } finally {
    await ok.runtime.shutdown()
    rmSync(ok.dir, { recursive: true, force: true })
  }

  const bad = runtimeFor({ validate: true, dumpExit: 3 })
  try {
    const status = await bad.runtime.refresh()
    assert.equal(status.applied, true, 'a rejected patch is a warning, not a failure')
    assert.ok(status.warnings.some((warning) => /rejected the generated patch/.test(warning)), JSON.stringify(status.warnings))
  } finally {
    await bad.runtime.shutdown()
    rmSync(bad.dir, { recursive: true, force: true })
  }
})
