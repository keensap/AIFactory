/**
 * Reusable contract suite for `ModelEngine` implementations.
 *
 * Every adapter (harness, OpenAI-compatible, Anthropic, fake) must pass this.
 * Adding an adapter means one call to `defineModelEngineContract`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ModelError,
  type ModelEngine,
  type ModelEvent,
  type ModelRequest,
} from '../../src/models/index.ts'

export interface EngineContractOptions {
  /** A second engine that advertises no tool support, for the capability check. */
  withoutTools?: () => ModelEngine
  /** Skip the abort case when an engine cannot be cancelled. */
  supportsAbort?: boolean
}

export function baseRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    provider: 'test',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  }
}

export function defineModelEngineContract(
  name: string,
  create: () => ModelEngine,
  options: EngineContractOptions = {},
): void {
  test(`${name}: complete returns text and normalized usage`, async () => {
    const engine = create()
    const response = await engine.complete(baseRequest())
    assert.equal(typeof response.text, 'string')
    assert.equal(response.provider, 'test')
    assert.equal(response.model, 'test-model')
    assert.ok(['stop', 'tool_calls', 'length', 'content_filter', 'error'].includes(response.finishReason))
    const usage = response.usage
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
      assert.equal(typeof usage[key], 'number', key)
      assert.ok(usage[key] >= 0, `${key} must not be negative`)
      assert.ok(Number.isInteger(usage[key]), `${key} must be an integer`)
    }
    assert.ok(usage.totalTokens >= usage.inputTokens + usage.outputTokens, 'total must cover input + output')
    assert.ok(Array.isArray(response.toolCalls))
  })

  test(`${name}: complete does not mutate the request`, async () => {
    const engine = create()
    const request = baseRequest({ system: 'be brief', temperature: 0.1 })
    const before = JSON.stringify(request)
    await engine.complete(request)
    assert.equal(JSON.stringify(request), before)
  })

  test(`${name}: stream ends with exactly one done event whose text matches`, async () => {
    const engine = create()
    const events: ModelEvent[] = []
    for await (const event of engine.stream(baseRequest())) events.push(event)
    const done = events.filter((event) => event.type === 'done')
    assert.equal(done.length, 1, 'exactly one done event')
    assert.equal(events.at(-1)?.type, 'done', 'done is the last event')
    const text = events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text).join('')
    const response = (done[0] as { response: { text: string } }).response
    assert.equal(text, response.text)
  })

  test(`${name}: errors are ModelError instances`, async () => {
    const engine = options.withoutTools?.()
    if (engine === undefined) return
    await assert.rejects(
      () => engine.complete(baseRequest({ tools: [{ name: 'x' }] })),
      (error: unknown) => error instanceof ModelError && error.kind === 'unsupported',
    )
  })

  test(`${name}: unsupported requests fail before the engine is called`, async () => {
    const engine = options.withoutTools?.()
    if (engine === undefined) return
    const before = JSON.stringify(await engine.health())
    await engine.complete(baseRequest({ tools: [{ name: 'x' }] })).catch(() => undefined)
    assert.equal(JSON.stringify(await engine.health()), before, 'a rejected request must not change engine state')
  })

  if (options.supportsAbort !== false) {
    test(`${name}: an aborted signal rejects with kind aborted`, async () => {
      const engine = create()
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        () => engine.complete(baseRequest(), controller.signal),
        (error: unknown) => error instanceof ModelError && error.kind === 'aborted',
      )
    })

    test(`${name}: an aborted stream stops without a done event`, async () => {
      const engine = create()
      const controller = new AbortController()
      controller.abort()
      let sawDone = false
      await assert.rejects(async () => {
        for await (const event of engine.stream(baseRequest(), controller.signal)) {
          if (event.type === 'done') sawDone = true
        }
      }, (error: unknown) => error instanceof ModelError && error.kind === 'aborted')
      assert.equal(sawDone, false)
    })
  }

  test(`${name}: health reports a valid state`, async () => {
    const engine = create()
    const health = await engine.health()
    assert.equal(typeof health.provider, 'string')
    assert.ok(['healthy', 'degraded', 'unavailable', 'unconfigured'].includes(health.state))
    assert.equal(typeof health.models, 'number')
    assert.ok(health.lastError === null || typeof health.lastError === 'string')
  })
}
