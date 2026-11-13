import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ModelSettingsError,
  credentialPresent,
  normalizeStoredTarget,
  resolveTarget,
  targetFromEnvironment,
  targetWarnings,
  validateTarget,
  type ModelSettings,
  type ModelSettingsStore,
  type ModelRecord,
  type ProviderRecord,
} from '../src/models/index.ts'
import { defaultCapabilities } from '../src/models/index.ts'

const provider = (id: string, overrides: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id,
  kind: 'openai',
  displayName: id,
  baseUrl: null,
  apiKeyEnv: `${id.toUpperCase()}_API_KEY`,
  headers: {},
  defaults: {},
  enabled: true,
  local: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const model = (providerId: string, name: string): ModelRecord => ({
  provider: providerId,
  model: name,
  displayName: name,
  contextWindow: 128000,
  maxOutput: 8192,
  capabilities: defaultCapabilities(),
  price: {},
  discoveredAt: null,
})

const providers = [provider('openai'), provider('anthropic', { kind: 'anthropic' }), provider('llamacpp', { local: true, apiKeyEnv: null })]
const models = [model('openai', 'gpt-5'), model('anthropic', 'claude-sonnet-4-5')]

function expectError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof ModelSettingsError && error.code === code, `expected ${code}`)
}

test('validates a target against the catalogue', () => {
  const target = validateTarget({ provider: 'openai', model: 'gpt-5', temperature: 0.2, maxTokens: 4096 }, { providers, models })
  assert.deepEqual(target, { provider: 'openai', model: 'gpt-5', temperature: 0.2, maxTokens: 4096, fallback: [] })

  expectError(() => validateTarget(null, { providers, models }), 'INVALID_BODY')
  expectError(() => validateTarget({}, { providers, models }), 'INVALID_TARGET')
  expectError(() => validateTarget({ provider: 'nope', model: 'x' }, { providers, models }), 'PROVIDER_NOT_FOUND')
  expectError(() => validateTarget({ provider: 'openai', model: 'missing' }, { providers, models }), 'MODEL_NOT_FOUND')
  expectError(() => validateTarget({ provider: 'openai', model: 'gpt-5', temperature: 5 }, { providers, models }), 'INVALID_TARGET')
  expectError(() => validateTarget({ provider: 'openai', model: 'gpt-5', maxTokens: 0 }, { providers, models }), 'INVALID_TARGET')
  expectError(() => validateTarget({ provider: 'openai', model: 'gpt-5', fallback: [{ provider: 'openai', model: 'gpt-5' }] }, { providers, models }), 'INVALID_FALLBACK')
  expectError(() => validateTarget({ provider: 'openai', model: 'gpt-5', fallback: 'x' }, { providers, models }), 'INVALID_FALLBACK')
})

test('a disabled provider is rejected', () => {
  const disabled = [provider('openai', { enabled: false })]
  expectError(() => validateTarget({ provider: 'openai', model: 'gpt-5' }, { providers: disabled, models: [] }), 'PROVIDER_DISABLED')
})

test('an empty catalogue accepts any model (discovery has not run yet)', () => {
  const target = validateTarget({ provider: 'llamacpp', model: 'qwen3-8b' }, { providers, models: [] })
  assert.equal(target.model, 'qwen3-8b')
})

test('fallback entries are validated, deduplicated and capped', () => {
  const target = validateTarget({
    provider: 'openai', model: 'gpt-5',
    fallback: [{ provider: 'anthropic', model: 'claude-sonnet-4-5' }],
  }, { providers, models })
  assert.deepEqual(target.fallback, [{ provider: 'anthropic', model: 'claude-sonnet-4-5' }])

  expectError(() => validateTarget({
    provider: 'openai', model: 'gpt-5',
    fallback: Array.from({ length: 5 }, () => ({ provider: 'anthropic', model: 'claude-sonnet-4-5' })),
  }, { providers, models }), 'INVALID_FALLBACK')
})

test('credential presence never exposes the value', () => {
  assert.equal(credentialPresent(provider('openai'), { OPENAI_API_KEY: 'sk-real' }), true)
  assert.equal(credentialPresent(provider('openai'), { OPENAI_API_KEY: '   ' }), false)
  assert.equal(credentialPresent(provider('openai'), {}), false)
  assert.equal(credentialPresent(provider('llamacpp', { local: true, apiKeyEnv: null }), {}), true)
})

test('warnings report missing keys and an empty catalogue', () => {
  const target = { provider: 'openai', model: 'gpt-5', fallback: [] }
  const warnings = targetWarnings(target, { providers, models: [] }, {})
  assert.ok(warnings.some((warning) => warning.includes('OPENAI_API_KEY')))
  assert.ok(warnings.some((warning) => warning.includes('catalogue is empty')))
  assert.deepEqual(targetWarnings(target, { providers, models }, { OPENAI_API_KEY: 'k' }), [])
})

test('environment targets parse and ignore invalid numbers', () => {
  assert.equal(targetFromEnvironment({}), null)
  assert.equal(targetFromEnvironment({ AIFACTORY_MODEL_PROVIDER: 'openai' }), null)
  const target = targetFromEnvironment({
    AIFACTORY_MODEL_PROVIDER: 'openai',
    AIFACTORY_MODEL: 'gpt-5',
    AIFACTORY_MODEL_TEMPERATURE: '9',
    AIFACTORY_MODEL_MAX_TOKENS: '2048',
    AIFACTORY_MODEL_REASONING_EFFORT: 'high',
    AIFACTORY_MODEL_FALLBACK: 'anthropic:claude-sonnet-4-5,llamacpp:qwen3',
  })
  assert.deepEqual(target, {
    provider: 'openai',
    model: 'gpt-5',
    maxTokens: 2048,
    reasoningEffort: 'high',
    fallback: [
      { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      { provider: 'llamacpp', model: 'qwen3' },
    ],
  })
})

class MemoryStore implements ModelSettingsStore {
  value: ModelSettings = { target: null, updatedAt: null }
  async load(): Promise<ModelSettings> { return this.value }
  async save(target: ModelSettings['target']): Promise<ModelSettings> {
    this.value = { target, updatedAt: '2026-11-13T00:00:00.000Z' }
    return this.value
  }
  async clear(): Promise<void> { this.value = { target: null, updatedAt: null } }
}

test('resolution prefers settings, then environment, then unconfigured', async () => {
  const store = new MemoryStore()
  const catalog = { providers, models }

  const none = await resolveTarget(store, {}, catalog)
  assert.equal(none.source, 'unconfigured')
  assert.equal(none.target, null)

  const env = await resolveTarget(store, { AIFACTORY_MODEL_PROVIDER: 'openai', AIFACTORY_MODEL: 'gpt-5' }, catalog)
  assert.equal(env.source, 'environment')
  assert.equal(env.target?.model, 'gpt-5')

  await store.save({ provider: 'anthropic', model: 'claude-sonnet-4-5', fallback: [] })
  const settings = await resolveTarget(store, { AIFACTORY_MODEL_PROVIDER: 'openai', AIFACTORY_MODEL: 'gpt-5' }, catalog)
  assert.equal(settings.source, 'settings')
  assert.equal(settings.target?.provider, 'anthropic')
})

test('corrupt stored targets degrade to unconfigured instead of crashing', async () => {
  assert.equal(normalizeStoredTarget('garbage'), null)
  assert.equal(normalizeStoredTarget({ model: 'x' }), null)
  const store = new MemoryStore()
  store.value = { target: normalizeStoredTarget({ provider: 'openai', model: 'gpt-5', fallback: 'bad' }), updatedAt: null }
  const resolved = await resolveTarget(store, {}, { providers, models })
  assert.equal(resolved.target?.fallback.length, 0)
})
