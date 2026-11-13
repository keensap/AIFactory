import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ModelSettingsError,
  buildModelPatch,
  keysToScrub,
  type ModelRecord,
  type ModelTarget,
  type ProviderRecord,
} from '../src/models/index.ts'
import { defaultCapabilities } from '../src/models/index.ts'

const provider = (id: string, overrides: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id, kind: 'openai', displayName: id, baseUrl: null, apiKeyEnv: `${id.toUpperCase()}_API_KEY`,
  headers: {}, defaults: {}, enabled: true, local: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const model = (providerId: string, name: string, contextWindow = 128000): ModelRecord => ({
  provider: providerId, model: name, displayName: name, contextWindow, maxOutput: 8192,
  capabilities: { ...defaultCapabilities(), contextWindow }, price: {}, discoveredAt: null,
})

const providers = [
  provider('anthropic', { kind: 'anthropic' }),
  provider('openai', { kind: 'openai' }),
  provider('llamacpp', { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: null, local: true }),
  provider('openrouter', { kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', headers: { 'X-Title': 'AI Factory' } }),
  provider('google', { kind: 'google' }),
  provider('broken', { kind: 'openai-compatible', baseUrl: null }),
]
const models = [
  model('openai', 'gpt-5'), model('anthropic', 'claude-sonnet-4-5', 200000),
  model('llamacpp', 'qwen3-8b', 32768), model('openrouter', 'openai/gpt-5'),
]

const target = (overrides: Partial<ModelTarget> = {}): ModelTarget => ({
  provider: 'llamacpp', model: 'qwen3-8b', fallback: [], ...overrides,
})

test('a local OpenAI-compatible target becomes a hand-declared route', () => {
  const patch = buildModelPatch({ target: target(), providers, models })
  const route = patch.routes.llamacpp!
  assert.equal(route.api, 'openai-completions')
  assert.equal(route.baseURL, 'http://127.0.0.1:8080/v1')
  assert.equal(route.apiKeyEnv, undefined)
  assert.deepEqual(route.models, [{ id: 'qwen3-8b', contextWindow: 32768 }])
  assert.equal(patch.provider, 'llamacpp')
  assert.equal(patch.model, 'qwen3-8b')
  assert.deepEqual(patch.requiredEnv, [])
})

test('catalog providers keep their credential reference and omit the protocol', () => {
  const patch = buildModelPatch({ target: target({ provider: 'anthropic', model: 'claude-sonnet-4-5' }), providers, models })
  const route = patch.routes.anthropic!
  assert.equal(route.api, undefined, 'the installed catalog knows the protocol')
  assert.equal(route.apiKeyEnv, 'ANTHROPIC_API_KEY')
  assert.deepEqual(route.models, [{ id: 'claude-sonnet-4-5', contextWindow: 200000 }])
  assert.deepEqual(patch.requiredEnv, ['ANTHROPIC_API_KEY'])
})

test('the patch is a two-entry overlay with the selected defaults', () => {
  const patch = buildModelPatch({ target: target(), providers, models })
  const document = JSON.parse(patch.content) as Array<{ id: string; config: Record<string, unknown> }>
  assert.equal(document.length, 2)
  assert.equal(document[0]?.id, 'llm-pi-ai')
  assert.equal(document[1]?.id, 'agent-default-model')
  assert.deepEqual(document[1]?.config, { provider: 'llamacpp', model: 'qwen3-8b' })
})

test('reasoning effort is forwarded only when set', () => {
  const withEffort = JSON.parse(buildModelPatch({ target: target({ reasoningEffort: 'high' }), providers, models }).content)
  assert.equal(withEffort[1].config.reasoningEffort, 'high')
  const without = JSON.parse(buildModelPatch({ target: target(), providers, models }).content)
  assert.equal('reasoningEffort' in without[1].config, false)
})

test('fallback providers are routed together with the primary', () => {
  const patch = buildModelPatch({
    target: target({ fallback: [{ provider: 'openai', model: 'gpt-5' }, { provider: 'anthropic', model: 'claude-sonnet-4-5' }] }),
    providers, models,
  })
  assert.deepEqual(Object.keys(patch.routes).sort(), ['anthropic', 'llamacpp', 'openai'])
  assert.deepEqual(patch.requiredEnv.sort(), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
})

test('a provider used twice is routed once with both models', () => {
  const patch = buildModelPatch({
    target: target({ fallback: [{ provider: 'llamacpp', model: 'llama-3.1-8b' }] }),
    providers, models,
  })
  assert.equal(Object.keys(patch.routes).length, 1)
  assert.deepEqual(patch.routes.llamacpp?.models?.map((entry) => entry.id), ['qwen3-8b', 'llama-3.1-8b'])
})

test('a local model missing from the catalogue still gets a context window', () => {
  const patch = buildModelPatch({ target: target({ model: 'unknown-local' }), providers, models: [] })
  assert.deepEqual(patch.routes.llamacpp?.models, [{ id: 'unknown-local', contextWindow: 8192 }])
})

test('unsupported or unroutable providers are rejected with stable codes', () => {
  const expect = (code: string, input: ModelTarget) => assert.throws(
    () => buildModelPatch({ target: input, providers, models }),
    (error: unknown) => error instanceof ModelSettingsError && error.code === code,
  )
  expect('PROVIDER_NOT_SUPPORTED', target({ provider: 'google', model: 'gemini-2' }))
  expect('PATCH_INVALID_PROVIDER', target({ provider: 'broken', model: 'x' }))
  expect('PROVIDER_NOT_FOUND', target({ provider: 'nope', model: 'x' }))
})

test('a disabled provider in the fallback chain is rejected', () => {
  const disabled = providers.map((entry) => (entry.id === 'openai' ? { ...entry, enabled: false } : entry))
  assert.throws(
    () => buildModelPatch({ target: target({ fallback: [{ provider: 'openai', model: 'gpt-5' }] }), providers: disabled, models }),
    (error: unknown) => error instanceof ModelSettingsError && error.code === 'PROVIDER_DISABLED',
  )
})

test('the patch never contains a credential value', () => {
  const secret = 'sk-live-should-never-appear'
  const env = { OPENAI_API_KEY: secret, ANTHROPIC_API_KEY: secret }
  const patch = buildModelPatch({ target: target({ fallback: [{ provider: 'openai', model: 'gpt-5' }] }), providers, models })
  assert.ok(!patch.content.includes(secret))
  assert.ok(!Object.values(env).some((value) => patch.content.includes(value)))
  assert.ok(patch.content.includes('OPENAI_API_KEY'), 'the reference name is present')
})

test('key scrubbing removes unselected managed keys only', () => {
  const env = {
    OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b', OPENROUTER_API_KEY: 'c',
    DEEPSEEK_API_KEY: 'keep', PATH: '/usr/bin', HOME: '/home/x',
  }
  assert.deepEqual(keysToScrub(env, ['OPENAI_API_KEY']).sort(), ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'])
  assert.deepEqual(keysToScrub(env, []).sort(), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'])
  assert.deepEqual(keysToScrub({ PATH: '/x' }, []), [])
})
