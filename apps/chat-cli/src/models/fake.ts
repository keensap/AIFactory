/**
 * Deterministic in-memory engine for tests and local development.
 *
 * It implements every port invariant without network access, so the core and
 * the conformance suite can run anywhere.
 */

import {
  assertCapabilities,
  emptyUsage,
  ModelError,
  normalizeUsage,
  type EngineHealth,
  type ModelCapabilities,
  type ModelEngine,
  type ModelEvent,
  type ModelRequest,
  type ModelResponse,
  type Usage,
} from './ports.ts'

export interface FakeEngineOptions {
  /** Responses returned in order; the last one repeats. */
  responses?: string[]
  capabilities?: Partial<ModelCapabilities>
  usage?: Partial<Usage>
  /** Emit a thinking delta before the text. */
  thinking?: string
  /** Throw this instead of answering. */
  failWith?: ModelError
  /** Simulated latency per call; honours abort. */
  latencyMs?: number
  /** Split streamed text into chunks of this size. */
  chunkSize?: number
  provider?: string
}

export class FakeEngine implements ModelEngine {
  readonly kind = 'fake'
  readonly requests: ModelRequest[] = []
  private readonly options: FakeEngineOptions
  private calls = 0

  constructor(options: FakeEngineOptions = {}) {
    this.options = options
  }

  get callCount(): number {
    return this.calls
  }

  capabilities(): ModelCapabilities {
    const base: ModelCapabilities = {
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      tools: true,
      thinking: true,
      jsonMode: true,
      vision: false,
      streaming: true,
    }
    return { ...base, ...(this.options.capabilities ?? {}) }
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    // Capability checks happen before the engine is counted as called.
    assertCapabilities(request, this.capabilities())
    this.requests.push(request)
    this.calls += 1
    if (this.options.failWith !== undefined) throw this.options.failWith
    await this.delay(signal)
    const text = this.nextText(request)
    return {
      provider: request.provider,
      model: request.model,
      text,
      ...(this.options.thinking !== undefined ? { thinking: this.options.thinking } : {}),
      toolCalls: [],
      usage: normalizeUsage(this.options.usage),
      finishReason: 'stop',
      providerRequestId: `fake-${this.calls}`,
    }
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    assertCapabilities(request, this.capabilities())
    this.requests.push(request)
    this.calls += 1
    if (this.options.failWith !== undefined) {
      yield { type: 'error', error: this.options.failWith }
      return
    }
    await this.delay(signal)
    if (this.options.thinking !== undefined) {
      yield { type: 'thinking', text: this.options.thinking }
    }
    const text = this.nextText(request)
    const size = Math.max(1, this.options.chunkSize ?? 16)
    for (let index = 0; index < text.length; index += size) {
      if (signal?.aborted === true) throw abortError()
      yield { type: 'text', text: text.slice(index, index + size) }
    }
    const usage = normalizeUsage(this.options.usage)
    yield { type: 'usage', usage }
    yield {
      type: 'done',
      response: {
        provider: request.provider,
        model: request.model,
        text,
        ...(this.options.thinking !== undefined ? { thinking: this.options.thinking } : {}),
        toolCalls: [],
        usage,
        finishReason: 'stop',
        providerRequestId: `fake-${this.calls}`,
      },
    }
  }

  async health(): Promise<EngineHealth> {
    return {
      provider: this.options.provider ?? 'fake',
      state: this.options.failWith !== undefined ? 'degraded' : 'healthy',
      models: 1,
      lastError: this.options.failWith?.message ?? null,
    }
  }

  private nextText(request: ModelRequest): string {
    const scripted = this.options.responses
    if (scripted !== undefined && scripted.length > 0) {
      return scripted[Math.min(this.calls - 1, scripted.length - 1)]!
    }
    const last = [...request.messages].reverse().find((message) => message.role === 'user')
    return `echo: ${last?.content ?? ''}`
  }

  private async delay(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw abortError()
    const ms = this.options.latencyMs ?? 0
    if (ms <= 0) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      timer.unref?.()
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

function abortError(): ModelError {
  return new ModelError('aborted', 'request aborted by the caller')
}

/** Convenience factory used by tests and the contract suite. */
export function createFakeEngine(options: FakeEngineOptions = {}): ModelEngine {
  return new FakeEngine(options)
}

export { emptyUsage }
