import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelError, discoverModels, probeProvider, type ProviderRecord } from '../src/models/index.ts'

const base: ProviderRecord = {
  id: 'openai', kind: 'openai', displayName: 'OpenAI', baseUrl: null, apiKeyEnv: 'OPENAI_API_KEY',
  headers: {}, defaults: {}, enabled: true, local: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

const local: ProviderRecord = {
  ...base, id: 'llamacpp', kind: 'openai-compatible', displayName: 'llama.cpp',
  baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: null, local: true,
}

const anthropic: ProviderRecord = {
  ...base, id: 'anthropic', kind: 'anthropic', displayName: 'Anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY',
}

test('discovers OpenAI-compatible models with bearer auth', async () => {
  let seen: { url: string; headers: Headers } | undefined
  const models = await discoverModels(local, {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), headers: new Headers(init?.headers) }
      return new Response(JSON.stringify({
        data: [
          { id: 'qwen3-8b', context_length: 32768 },
          { id: 'llama-3.1-8b' },
          { nope: true },
        ],
      }), { status: 200 })
    }) as typeof fetch,
  })
  assert.equal(seen?.url, 'http://127.0.0.1:8080/v1/models')
  assert.equal(models.length, 2)
  assert.equal(models[0]?.model, 'qwen3-8b')
  assert.equal(models[0]?.contextWindow, 32768)
  assert.equal(models[1]?.contextWindow, null)
  // Local servers start conservative: tools disabled until --jinja is confirmed.
  assert.equal(models[0]?.capabilities.tools, false)
})

test('discovers Anthropic models with x-api-key and version header', async () => {
  let headers: Headers | undefined
  let url = ''
  const models = await discoverModels(anthropic, {
    apiKey: 'sk-ant-test',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input)
      headers = new Headers(init?.headers)
      return new Response(JSON.stringify({
        data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', max_input_tokens: 200000, max_tokens: 8192 }],
      }), { status: 200 })
    }) as typeof fetch,
  })
  assert.equal(url, 'https://api.anthropic.com/v1/models?limit=1000')
  assert.equal(headers?.get('x-api-key'), 'sk-ant-test')
  assert.equal(headers?.get('anthropic-version'), '2023-06-01')
  assert.equal(headers?.get('authorization'), null)
  assert.equal(models[0]?.contextWindow, 200000)
  assert.equal(models[0]?.maxOutput, 8192)
  assert.equal(models[0]?.displayName, 'Claude Sonnet 4.5')
})

test('discovery maps HTTP failures to normalized errors', async () => {
  await assert.rejects(
    () => discoverModels(local, { fetch: (async () => new Response('', { status: 401 })) as typeof fetch }),
    (error: unknown) => error instanceof ModelError && error.kind === 'auth' && error.status === 401,
  )
  await assert.rejects(
    () => discoverModels(local, { fetch: (async () => { throw new Error('connect ECONNREFUSED') }) as typeof fetch }),
    (error: unknown) => error instanceof ModelError && error.kind === 'network',
  )
  await assert.rejects(
    () => discoverModels({ ...local, baseUrl: null }, { fetch: (async () => new Response('', { status: 200 })) as typeof fetch }),
    (error: unknown) => error instanceof ModelError && error.kind === 'invalid_request',
  )
})

test('discovery rejects unsupported provider kinds', async () => {
  await assert.rejects(
    () => discoverModels({ ...base, kind: 'google' }, {}),
    (error: unknown) => error instanceof ModelError && error.kind === 'unsupported',
  )
})

test('health reports unconfigured without a credential and never calls the network', async () => {
  let called = false
  const health = await probeProvider(base, 0, {
    credential: false,
    fetch: (async () => { called = true; return new Response('', { status: 200 }) }) as typeof fetch,
  })
  assert.equal(health.state, 'unconfigured')
  assert.equal(health.credential, false)
  assert.match(health.lastError ?? '', /OPENAI_API_KEY/)
  assert.equal(called, false)
})

test('health reports healthy, degraded and reachable correctly', async () => {
  const ok = await probeProvider(local, 2, {
    credential: true,
    fetch: (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch,
  })
  assert.equal(ok.state, 'healthy')
  assert.equal(ok.reachable, true)
  assert.equal(ok.models, 2)
  assert.equal(typeof ok.latencyMs, 'number')

  const degraded = await probeProvider(local, 2, {
    credential: true,
    fetch: (async () => new Response('', { status: 500 })) as typeof fetch,
  })
  assert.equal(degraded.state, 'degraded')
  assert.equal(degraded.reachable, false)
  assert.equal(degraded.lastError, 'HTTP 500')

  const offline = await probeProvider(local, 2, {
    credential: true,
    fetch: (async () => { throw new Error('connect ECONNREFUSED') }) as typeof fetch,
  })
  assert.equal(offline.state, 'degraded')
  assert.match(offline.lastError ?? '', /ECONNREFUSED/)
})

test('a cloud provider using vendor defaults is not probed over the network', async () => {
  let called = false
  const health = await probeProvider(base, 3, {
    credential: true,
    fetch: (async () => { called = true; return new Response('', { status: 200 }) }) as typeof fetch,
  })
  assert.equal(health.state, 'healthy')
  assert.equal(health.reachable, null)
  assert.equal(called, false)
})
