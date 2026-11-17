import assert from 'node:assert/strict'
import test from 'node:test'
import { attributionForModel, attributeUsage, type ModelAttribution } from '../src/models/attribution.ts'

const FACTORY: ModelAttribution = {
  provider: 'acme',
  model: 'big-model',
  source: 'settings',
  price: { input: 10, output: 30 },
  contextWindow: 200_000,
}

const MODELS = [
  { provider: 'acme', model: 'big-model', price: { input: 10, output: 30 }, contextWindow: 200_000 },
  { provider: 'acme', model: 'small-model', price: { input: 1, output: 3 }, contextWindow: 32_000 },
]

test('a role using the Factory model keeps the Factory attribution', () => {
  assert.deepEqual(attributionForModel(FACTORY, MODELS, undefined), FACTORY)
  assert.deepEqual(attributionForModel(FACTORY, MODELS, 'big-model'), FACTORY)
})

test('an agent model is priced and measured as itself, not as the Factory model', () => {
  const role = attributionForModel(FACTORY, MODELS, 'small-model')!
  assert.equal(role.model, 'small-model')
  assert.equal(role.provider, 'acme', 'the provider never changes')
  assert.deepEqual(role.price, { input: 1, output: 3 })
  assert.equal(role.contextWindow, 32_000)

  // The same usage must cost 10x less on the small model.
  const usage = { type: 'status', usage: { inputTokens: 1_000, outputTokens: 1_000 } }
  const asFactory = attributeUsage(usage, FACTORY) as { costUsd?: number }
  const asSmall = attributeUsage(usage, role) as { costUsd?: number }
  assert.ok(asFactory.costUsd !== undefined && asSmall.costUsd !== undefined)
  assert.ok(
    asSmall.costUsd < asFactory.costUsd,
    `expected the small model to be cheaper: ${asSmall.costUsd} vs ${asFactory.costUsd}`,
  )
})

test('a model the catalogue does not know is reported as unpriced, never guessed', () => {
  const role = attributionForModel(FACTORY, MODELS, 'mystery-model')!
  assert.equal(role.model, 'mystery-model')
  assert.equal(role.price, null)
  assert.equal(role.contextWindow, null)

  const stamped = attributeUsage({ type: 'status', usage: { inputTokens: 10, outputTokens: 5 } }, role) as {
    costUsd?: number
    unpriced?: boolean
    contextWindow?: number
    model?: { model: string }
  }
  assert.equal(stamped.costUsd, undefined, 'no cost is invented')
  assert.equal(stamped.unpriced, true, 'the event says the cost is unknown')
  assert.equal(stamped.contextWindow, undefined)
  assert.equal(stamped.model?.model, 'mystery-model')
})

test('a model absent from a different provider is not borrowed', () => {
  const other = [{ provider: 'other', model: 'small-model', price: { input: 1, output: 1 }, contextWindow: 1_000 }]
  assert.equal(attributionForModel(FACTORY, other, 'small-model')!.price, null)
})

test('no attribution stays no attribution', () => {
  assert.equal(attributionForModel(null, MODELS, 'small-model'), null)
})
