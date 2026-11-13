import assert from 'node:assert/strict'
import test from 'node:test'
import { PostgresModelCatalog, PostgresModelSettingsStore, defaultCapabilities } from '../src/models/index.ts'

const url = process.env.AIFACTORY_TEST_DATABASE_URL
const skip = url === undefined || url === '' ? 'AIFACTORY_TEST_DATABASE_URL is not set' : false

test('migration seeds providers and discovery writes the catalogue', { skip }, async () => {
  const catalog = new PostgresModelCatalog(url!)
  try {
    await catalog.migrate()
    // Idempotent.
    await catalog.migrate()
    const providers = await catalog.listProviders()
    const ids = providers.map((provider) => provider.id)
    for (const expected of ['anthropic', 'openai', 'llamacpp']) {
      assert.ok(ids.includes(expected), `missing seeded provider ${expected}`)
    }
    const llamacpp = await catalog.getProvider('llamacpp')
    assert.equal(llamacpp?.local, true)
    assert.equal(llamacpp?.baseUrl, 'http://127.0.0.1:8080/v1')
    assert.equal(llamacpp?.apiKeyEnv, null)
    assert.equal((await catalog.getProvider('nope')), undefined)

    const written = await catalog.replaceModels('llamacpp', [
      { model: 'qwen3-8b', displayName: 'Qwen3 8B', contextWindow: 32768, maxOutput: 8192, capabilities: defaultCapabilities(), price: { input: 0, output: 0 } },
      { model: 'llama-3.1-8b', displayName: null, contextWindow: null, maxOutput: null, capabilities: defaultCapabilities(), price: {} },
    ])
    assert.equal(written.length, 2)
    assert.equal(written[0]?.provider, 'llamacpp')
    assert.ok(written.every((model) => model.discoveredAt !== null))

    // Replacing drops models that are no longer present.
    const replaced = await catalog.replaceModels('llamacpp', [
      { model: 'qwen3-8b', displayName: 'Qwen3 8B', contextWindow: 32768, maxOutput: 8192, capabilities: defaultCapabilities(), price: {} },
    ])
    assert.equal(replaced.length, 1)
    assert.equal((await catalog.listModels('llamacpp')).length, 1)
    assert.equal((await catalog.listModels()).some((model) => model.model === 'llama-3.1-8b'), false)
  } finally {
    await catalog.close()
  }
})

test('the global target round-trips through settings', { skip }, async () => {
  const store = new PostgresModelSettingsStore(url!)
  try {
    await store.clear()
    assert.equal((await store.load()).target, null)
    const saved = await store.save({
      provider: 'llamacpp', model: 'qwen3-8b', temperature: 0.3, maxTokens: 2048,
      reasoningEffort: 'low', fallback: [{ provider: 'openai', model: 'gpt-5' }],
    })
    assert.ok(saved.updatedAt)
    const loaded = await store.load()
    assert.deepEqual(loaded.target, {
      provider: 'llamacpp', model: 'qwen3-8b', temperature: 0.3, maxTokens: 2048,
      reasoningEffort: 'low', fallback: [{ provider: 'openai', model: 'gpt-5' }],
    })
    await store.clear()
    assert.equal((await store.load()).target, null, 'clearing reverts to the environment')
  } finally {
    await store.close()
  }
})

test('rediscovery keeps operator-set prices, drops vanished models and adds new ones unpriced', { skip }, async () => {
  const catalog = new PostgresModelCatalog(url!)
  const entry = (name: string, window = 1000, price: Record<string, number> = {}) => ({
    model: name, displayName: null, contextWindow: window, maxOutput: null, capabilities: defaultCapabilities(), price,
  })
  try {
    await catalog.migrate()
    await catalog.replaceModels('llamacpp', [entry('keep'), entry('vanish')])
    await catalog.setPrice('llamacpp', 'keep', { input: 1, output: 2 })
    await catalog.setPrice('llamacpp', 'vanish', { input: 9 })

    const after = await catalog.replaceModels('llamacpp', [entry('keep', 4096), entry('fresh')])
    const by = (name: string) => after.find((model) => model.model === name)
    assert.deepEqual(by('keep')?.price, { input: 1, output: 2 }, 'the price survives a refresh')
    assert.equal(by('keep')?.contextWindow, 4096, 'while the discovered facts are updated')
    assert.deepEqual(by('fresh')?.price, {}, 'a new model starts unpriced')
    assert.equal(by('vanish'), undefined, 'a model that disappeared is removed')

    // A price supplied by discovery itself wins over the stored one.
    const supplied = await catalog.replaceModels('llamacpp', [entry('keep', 4096, { input: 5 })])
    assert.deepEqual(supplied.find((model) => model.model === 'keep')?.price, { input: 5 })

    // An empty discovery result clears the provider's catalogue.
    assert.deepEqual(await catalog.replaceModels('llamacpp', []), [])
  } finally {
    await catalog.close()
  }
})
