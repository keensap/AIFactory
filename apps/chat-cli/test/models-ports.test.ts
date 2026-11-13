import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FakeEngine,
  ModelError,
  addUsage,
  assertCapabilities,
  defaultCapabilities,
  emptyUsage,
  isRetryable,
  kindFromStatus,
  missingCapabilities,
  modelErrorFromStatus,
  normalizeUsage,
} from '../src/models/index.ts'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { baseRequest, defineModelEngineContract } from './support/model-engine-contract.ts'

defineModelEngineContract('fake', () => new FakeEngine({ usage: { inputTokens: 10, outputTokens: 4 } }), {
  withoutTools: () => new FakeEngine({ capabilities: { tools: false } }),
  failing: () => new FakeEngine({ failWith: new ModelError('overloaded', 'provider busy') }),
})

test('normalizeUsage falls back to input + output and floors counts', () => {
  assert.deepEqual(normalizeUsage(undefined), emptyUsage())
  assert.deepEqual(normalizeUsage({ inputTokens: 10, outputTokens: 5 }), {
    inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
  assert.equal(normalizeUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 99 }).totalTokens, 99)
  assert.equal(normalizeUsage({ inputTokens: -5, outputTokens: 3.7 }).outputTokens, 3)
  assert.equal(normalizeUsage({ inputTokens: Number.NaN }).inputTokens, 0)
})

test('addUsage sums every counter', () => {
  assert.deepEqual(addUsage(normalizeUsage({ inputTokens: 1, outputTokens: 2 }), normalizeUsage({ totalTokens: 9, cacheReadTokens: 3 })), {
    inputTokens: 1, outputTokens: 2, totalTokens: 12, cacheReadTokens: 3, cacheWriteTokens: 0,
  })
})

test('default capabilities are conservative', () => {
  const caps = defaultCapabilities()
  assert.equal(caps.tools, false)
  assert.equal(caps.thinking, false)
  assert.equal(caps.jsonMode, false)
  assert.equal(caps.streaming, true)
  assert.ok(caps.contextWindow > 0)
})

test('missingCapabilities reports each unsupported feature', () => {
  const caps = defaultCapabilities()
  assert.deepEqual(missingCapabilities({}, caps), [])
  assert.deepEqual(missingCapabilities({ tools: [{ name: 'x' }] }, caps), ['tools'])
  assert.deepEqual(missingCapabilities({ responseFormat: { type: 'json' } }, caps), ['json'])
  assert.deepEqual(missingCapabilities({ thinking: true }, caps), ['thinking'])
  assert.deepEqual(missingCapabilities({ tools: [], responseFormat: { type: 'text' } }, caps), [])
})

test('assertCapabilities fails with a stable unsupported error', () => {
  assert.throws(
    () => assertCapabilities(baseRequest({ provider: 'local', model: 'small', tools: [{ name: 'bash' }] }), defaultCapabilities()),
    (error: unknown) => error instanceof ModelError
      && error.kind === 'unsupported'
      && error.provider === 'local'
      && /does not support: tools/.test(error.message),
  )
})

test('HTTP status maps to normalized error kinds', () => {
  assert.equal(kindFromStatus(401), 'auth')
  assert.equal(kindFromStatus(403), 'auth')
  assert.equal(kindFromStatus(402), 'quota')
  assert.equal(kindFromStatus(429), 'rate_limit')
  assert.equal(kindFromStatus(400), 'invalid_request')
  assert.equal(kindFromStatus(413), 'context_overflow')
  assert.equal(kindFromStatus(408), 'timeout')
  assert.equal(kindFromStatus(502), 'overloaded')
  assert.equal(kindFromStatus(503), 'overloaded')
  assert.equal(kindFromStatus(529), 'overloaded')
  assert.equal(kindFromStatus(418), 'unknown')
})

test('only transient kinds are retryable', () => {
  assert.equal(isRetryable('rate_limit'), true)
  assert.equal(isRetryable('overloaded'), true)
  assert.equal(isRetryable('timeout'), true)
  assert.equal(isRetryable('network'), true)
  for (const kind of ['auth', 'quota', 'invalid_request', 'context_overflow', 'content_filter', 'unsupported', 'aborted'] as const) {
    assert.equal(isRetryable(kind), false, kind)
  }
})

test('a ModelError keeps its status, provider and retryability', () => {
  const error = modelErrorFromStatus(429, 'slow down', { provider: 'openai', model: 'gpt', providerRequestId: 'req_1' })
  assert.equal(error.kind, 'rate_limit')
  assert.equal(error.status, 429)
  assert.equal(error.retryable, true)
  assert.equal(error.provider, 'openai')
  assert.equal(error.model, 'gpt')
  assert.equal(error.providerRequestId, 'req_1')
  assert.equal(error.name, 'ModelError')
  const fatal = new ModelError('auth', 'bad key', { retryable: false })
  assert.equal(fatal.retryable, false)
  assert.equal(new ModelError('timeout', 't').retryable, true)
})

test('the fake engine records calls and repeats the last scripted response', async () => {
  const engine = new FakeEngine({ responses: ['first', 'second'] })
  assert.equal((await engine.complete(baseRequest())).text, 'first')
  assert.equal((await engine.complete(baseRequest())).text, 'second')
  assert.equal((await engine.complete(baseRequest())).text, 'second')
  assert.equal(engine.callCount, 3)
  assert.equal(engine.requests.length, 3)
})

test('the fake engine can simulate a provider failure in both modes', async () => {
  const engine = new FakeEngine({ failWith: new ModelError('overloaded', 'provider busy') })
  await assert.rejects(() => engine.complete(baseRequest()), /provider busy/)
  await assert.rejects(async () => { for await (const _ of engine.stream(baseRequest())) void _ }, /provider busy/)
  assert.equal((await engine.health()).state, 'degraded')
})

test('the ports module contains no vendor imports', () => {
  const directory = fileURLToPath(new URL('../src/models', import.meta.url))
  const files = readdirSync(directory).filter((name) => name.endsWith('.ts'))
  assert.ok(files.includes('ports.ts'))
  const vendor = /(?:^|[/@])(@anthropic-ai|openai|@google|@aws-sdk|@azure|cohere-ai|groq-sdk|@mistralai|ollama|@huggingface)(?:[/.]|$)/i
  const importPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  for (const name of files) {
    const source = readFileSync(join(directory, name), 'utf8')
    for (const match of source.matchAll(importPattern)) {
      assert.ok(!vendor.test(match[1]), `${name} imports vendor code: ${match[1]}`)
    }
  }
})

test('the import guard passes', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const output = execFileSync(process.execPath, [join(root, 'scripts/check-model-imports.mjs')], { encoding: 'utf8' })
  assert.match(output, /model guard: \d+ port files clean/)
})
