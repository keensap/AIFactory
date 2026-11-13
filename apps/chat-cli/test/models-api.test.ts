import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshHarness } from '../src/harness.ts'
import { createChatServer, serverPort } from '../src/server.ts'
import { SessionStore } from '../src/store.ts'

interface FakeModelsOptions {
  missing?: boolean
  apiToken?: string
}

function fakeModels() {
  const state = {
    updated: null as unknown,
    discovered: [] as string[],
   health: [] as string[],
  }
  const providers = [
    { id: 'openai', kind: 'openai', displayName: 'OpenAI', baseUrl: null, apiKeyEnv: 'OPENAI_API_KEY', local: false, enabled: true, credentialPresent: false, modelCount: 1 },
    { id: 'llamacpp', kind: 'openai-compatible', displayName: 'llama.cpp (local)', baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: null, local: true, enabled: true, credentialPresent: true, modelCount: 0 },
  ]
  const models = [
    { provider: 'openai', model: 'gpt-5', displayName: 'gpt-5', contextWindow: 128000, maxOutput: 8192, capabilities: {}, price: {}, discoveredAt: null },
  ]
  return {
    state,
    service: {
      async providers() { return providers },
      async models(provider?: string) { return provider === undefined ? models : models.filter((entry) => entry.provider === provider) },
      async target() {
        return {
          target: null, source: 'unconfigured', warnings: [], updatedAt: null, providers,
        }
      },
      async updateTarget(input: unknown) { state.updated = input; return this.target() },
      async clearTarget() { return this.target() },
      async discover(id: string) {
        state.discovered.push(id)
        return { provider: id, discovered: 1, models }
      },
      async health(id: string) {
        state.health.push(id)
        return { provider: id, state: 'unconfigured', credential: false, reachable: null, latencyMs: null, models: 0, lastError: 'OPENAI_API_KEY is not set' }
      },
      async close() {},
    },
  }
}

async function withApi(options: FakeModelsOptions, run: (base: string, fake: ReturnType<typeof fakeModels>) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-models-api-'))
  const fake = fakeModels()
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    ...(options.missing === true ? {} : { models: fake.service as never }),
    ...(options.apiToken !== undefined ? { apiToken: options.apiToken } : {}),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    await run(`http://127.0.0.1:${serverPort(server)}`, fake)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  }
}

test('lists providers and models without exposing credentials', async () => {
  await withApi({}, async (base) => {
    const providers = await (await fetch(`${base}/api/models/providers`)).json() as { providers: Array<Record<string, unknown>> }
    assert.equal(providers.providers.length, 2)
    const openai = providers.providers.find((entry) => entry.id === 'openai')!
    assert.equal(openai.credentialPresent, false)
    assert.equal(openai.apiKeyEnv, 'OPENAI_API_KEY')
    assert.ok(!('apiKey' in openai) && !('key' in openai), 'no secret fields')

    const models = await (await fetch(`${base}/api/models?provider=openai`)).json() as { models: Array<{ provider: string }> }
    assert.equal(models.models.length, 1)
    assert.equal(models.models[0]?.provider, 'openai')
  })
})

test('reads and updates the global target', async () => {
  await withApi({}, async (base) => {
    const current = await (await fetch(`${base}/api/settings/models`)).json() as { source: string; providers: unknown[] }
    assert.equal(current.source, 'unconfigured')
    assert.equal(current.providers.length, 2)

    const response = await fetch(`${base}/api/settings/models`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-5' }),
    })
    assert.equal(response.status, 200)

    const cleared = await fetch(`${base}/api/settings/models`, { method: 'DELETE' })
    assert.equal(cleared.status, 200)
    assert.equal(((await cleared.json()) as { source: string }).source, 'unconfigured')
  })
})

test('discovery and health are explicit POST actions', async () => {
  await withApi({}, async (base, fake) => {
    const discover = await fetch(`${base}/api/models/providers/openai/discover`, { method: 'POST' })
    assert.equal(discover.status, 200)
    const body = await discover.json() as { discovery: { provider: string; discovered: number } }
    assert.equal(body.discovery.provider, 'openai')
    assert.equal(body.discovery.discovered, 1)
    assert.deepEqual(fake.state.discovered, ['openai'])

    const health = await fetch(`${base}/api/models/providers/openai/health`, { method: 'POST' })
    assert.equal(health.status, 200)
    assert.equal(((await health.json()) as { health: { state: string } }).health.state, 'unconfigured')
    assert.deepEqual(fake.state.health, ['openai'])

    assert.equal((await fetch(`${base}/api/models/providers/openai/discover`)).status, 404, 'GET is not allowed')
  })
})

test('model routes report 503 when the catalogue is not configured', async () => {
  await withApi({ missing: true }, async (base) => {
    for (const path of ['/api/models', '/api/models/providers', '/api/settings/models']) {
      const response = await fetch(`${base}${path}`)
      assert.equal(response.status, 503, path)
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'MODELS_NOT_CONFIGURED')
    }
  })
})

test('discovery requires the bearer token when one is configured', async () => {
  await withApi({ apiToken: 'secret-token' }, async (base) => {
    assert.equal((await fetch(`${base}/api/models/providers/openai/discover`, { method: 'POST' })).status, 401)
    const ok = await fetch(`${base}/api/models/providers/openai/discover`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret-token' },
    })
    assert.equal(ok.status, 200)
  })
})
