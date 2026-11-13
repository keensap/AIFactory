import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshHarness } from '../src/harness.ts'
import { ModelError, ModelSettingsError, type ModelErrorKind } from '../src/models/index.ts'
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
    tests: [] as unknown[],
    prices: [] as unknown[],
    resets: [] as string[],
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
      async test(input: { fail?: ModelErrorKind; prompt?: string }) {
        state.tests.push(input)
        if (input.fail !== undefined) throw new ModelError(input.fail, `simulated ${input.fail}`)
        return { provider: 'openai', model: 'gpt-5', text: 'ok', truncated: false, finishReason: 'stop', usage: {}, costUsd: 0.01, durationMs: 5, attempts: [] }
      },
      async setPrice(provider: string, model: string, price: Record<string, unknown>) {
        state.prices.push({ provider, model, price })
        if (model === 'missing') throw new ModelSettingsError(404, 'MODEL_NOT_FOUND', 'not in the catalogue')
        return { provider, model, price }
      },
      async resetBreaker(provider: string) {
        state.resets.push(provider)
        return { provider, reset: true }
      },
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

test('admin exposes the applied model runtime status', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-models-admin-'))
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    modelRuntime: {
      status: () => ({
        applied: true, provider: 'llamacpp', model: 'qwen3-8b', source: 'settings',
        patchPath: '/tmp/model-target-1.json', warnings: [], lastError: null,
      }),
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const response = await fetch(`http://127.0.0.1:${serverPort(server)}/api/admin/models`)
    assert.equal(response.status, 200)
    const body = await response.json() as { models: { applied: boolean; provider: string; patchPath: string } }
    assert.equal(body.models.applied, true)
    assert.equal(body.models.provider, 'llamacpp')
    assert.match(body.models.patchPath, /model-target-1\.json$/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  }
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

const json = (body: unknown): RequestInit => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('POST /api/models/test runs a routed completion (admin only)', async () => {
  await withApi({ apiToken: 'tok' }, async (base, fake) => {
    assert.equal((await fetch(`${base}/api/models/test`, { method: 'POST', ...json({}) })).status, 401)
    const ok = await fetch(`${base}/api/models/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify({ prompt: 'ping' }),
    })
    assert.equal(ok.status, 200)
    const body = await ok.json() as { test: { provider: string; text: string; costUsd: number } }
    assert.equal(body.test.provider, 'openai')
    assert.equal(body.test.costUsd, 0.01)
    assert.deepEqual(fake.state.tests, [{ prompt: 'ping' }])
  })
})

test('POST /api/models/test with an empty body uses defaults', async () => {
  await withApi({}, async (base, fake) => {
    assert.equal((await fetch(`${base}/api/models/test`, { method: 'POST' })).status, 200)
    assert.deepEqual(fake.state.tests, [{}])
  })
})

test('model failures map to distinguishable HTTP statuses and codes', async () => {
  const expected: Array<[ModelErrorKind, number]> = [
    ['invalid_request', 400], ['unsupported', 400], ['context_overflow', 400],
    ['content_filter', 422], ['unconfigured', 503], ['timeout', 504],
    ['auth', 502], ['quota', 502], ['rate_limit', 502], ['overloaded', 502],
    ['network', 502], ['unavailable', 502], ['unknown', 502],
  ]
  await withApi({}, async (base) => {
    for (const [kind, status] of expected) {
      const response = await fetch(`${base}/api/models/test`, { method: 'POST', ...json({ fail: kind }) })
      assert.equal(response.status, status, kind)
      const body = await response.json() as { error: { code: string; message: string } }
      assert.equal(body.error.code, `MODEL_${kind.toUpperCase()}`)
    }
  })
})

test('PUT /api/models/price validates the body and returns the updated model', async () => {
  await withApi({ apiToken: 'tok' }, async (base, fake) => {
    const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }
    assert.equal((await fetch(`${base}/api/models/price`, { method: 'PUT', ...json({ provider: 'openai', model: 'gpt-5', input: 1 }) })).status, 401)

    const ok = await fetch(`${base}/api/models/price`, { method: 'PUT', headers: auth, body: JSON.stringify({ provider: 'openai', model: 'gpt-5', input: 1.25, output: 10 }) })
    assert.equal(ok.status, 200)
    assert.deepEqual(fake.state.prices, [{ provider: 'openai', model: 'gpt-5', price: { input: 1.25, output: 10 } }])

    const missing = await fetch(`${base}/api/models/price`, { method: 'PUT', headers: auth, body: JSON.stringify({ input: 1 }) })
    assert.equal(missing.status, 400)
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'INVALID_PRICE')

    const unknown = await fetch(`${base}/api/models/price`, { method: 'PUT', headers: auth, body: JSON.stringify({ provider: 'openai', model: 'missing', input: 1 }) })
    assert.equal(unknown.status, 404)
  })
})

test('POST /api/admin/models/providers/:id/reset closes a provider breaker (admin only)', async () => {
  await withApi({ apiToken: 'tok' }, async (base, fake) => {
    assert.equal((await fetch(`${base}/api/admin/models/providers/openai/reset`, { method: 'POST' })).status, 401)
    const ok = await fetch(`${base}/api/admin/models/providers/openai/reset`, { method: 'POST', headers: { Authorization: 'Bearer tok' } })
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { provider: 'openai', reset: true })
    assert.deepEqual(fake.state.resets, ['openai'])
  })
})
