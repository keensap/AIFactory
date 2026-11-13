/**
 * Anthropic Messages engine (`/v1/messages`).
 *
 * Protocol notes (verified against the Claude API docs):
 *  - the system prompt is a top-level field, not a message;
 *  - `max_tokens` is required;
 *  - tool results are `tool_result` blocks inside a *user* message and must come
 *    first in that message;
 *  - extended thinking uses `{type:"enabled", budget_tokens}` with a budget of at
 *    least 1024 that counts toward `max_tokens`; temperature must not be set;
 *  - streaming emits `message_start`, content blocks, `message_delta` (usage is
 *    cumulative) and `message_stop`, with `ping` and in-stream `error` events;
 *  - `input_tokens` already excludes cached tokens, matching the shared
 *    convention.
 *
 * Models that only accept adaptive thinking are not special-cased; the API's
 * rejection surfaces as an `invalid_request` error with its message.
 */

import { inferCapabilities } from '../capabilities.ts'
import {
  ModelError,
  assertCapabilities,
  normalizeUsage,
  type EngineHealth,
  type FinishReason,
  type ModelCapabilities,
  type ModelEngine,
  type ModelEvent,
  type ModelRequest,
  type ModelResponse,
  type ToolCall,
  type Usage,
} from '../ports.ts'
import type { ProviderRecord } from '../catalog/types.ts'
import {
  abortedError,
  kindFromErrorType,
  parseSse,
  postJson,
  readJson,
  redact,
  type CallContext,
} from './shared.ts'

export interface AnthropicEngineOptions {
  provider: ProviderRecord
  apiKey?: () => string | undefined
  capabilities?: (model: string) => ModelCapabilities
  fetch?: typeof fetch
  /** Used when neither the request nor the provider defaults set `max_tokens`. */
  defaultMaxTokens?: number
}

const DEFAULT_BASE = 'https://api.anthropic.com/v1'
const API_VERSION = '2023-06-01'
const MIN_THINKING_BUDGET = 1024
const EFFORT_BUDGET: Record<string, number> = { minimal: 1024, low: 1024, medium: 4096, high: 8192 }

type Block = Record<string, unknown>

function baseUrl(provider: ProviderRecord): string {
  const raw = provider.baseUrl === null || provider.baseUrl === '' ? DEFAULT_BASE : provider.baseUrl.replace(/\/+$/, '')
  return raw.endsWith('/v1') ? raw : `${raw}/v1`
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function mapAnthropicUsage(raw: unknown): Usage {
  if (raw === null || typeof raw !== 'object') return normalizeUsage(undefined)
  const usage = raw as Record<string, unknown>
  return normalizeUsage({
    inputTokens: numberOf(usage.input_tokens),
    outputTokens: numberOf(usage.output_tokens),
    cacheReadTokens: numberOf(usage.cache_read_input_tokens),
    cacheWriteTokens: numberOf(usage.cache_creation_input_tokens),
  })
}

export function mapAnthropicStop(reason: unknown): FinishReason {
  switch (reason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case 'refusal':
      return 'content_filter'
    default:
      return 'stop'
  }
}

function pushMessage(out: Array<{ role: 'user' | 'assistant'; content: Block[] }>, role: 'user' | 'assistant', blocks: Block[]): void {
  if (blocks.length === 0) return
  const last = out.at(-1)
  if (last !== undefined && last.role === role) last.content.push(...blocks)
  else out.push({ role, content: [...blocks] })
}

/** Convert neutral messages to Anthropic's alternating user/assistant blocks. */
export function toAnthropicMessages(request: ModelRequest): { system: string; messages: Array<{ role: 'user' | 'assistant'; content: Block[] }> } {
  const systemParts: string[] = []
  if (request.system !== undefined && request.system !== '') systemParts.push(request.system)
  const messages: Array<{ role: 'user' | 'assistant'; content: Block[] }> = []
  for (const message of request.messages) {
    if (message.role === 'system') {
      if (message.content !== '') systemParts.push(message.content)
    } else if (message.role === 'user') {
      if (message.content !== '') pushMessage(messages, 'user', [{ type: 'text', text: message.content }])
    } else if (message.role === 'assistant') {
      const blocks: Block[] = []
      if (message.content !== '') blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments !== null && typeof call.arguments === 'object' ? call.arguments : {},
        })
      }
      pushMessage(messages, 'assistant', blocks)
    } else {
      pushMessage(messages, 'user', [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content }])
    }
  }
  // tool_result blocks must precede any other block in a user message.
  for (const message of messages) {
    if (message.role === 'user') {
      message.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'))
    }
  }
  return { system: systemParts.join('\n\n'), messages }
}

export class AnthropicEngine implements ModelEngine {
  readonly kind = 'anthropic'
  private readonly provider: ProviderRecord
  private readonly apiKey?: () => string | undefined
  private readonly capabilityLookup?: (model: string) => ModelCapabilities
  private readonly fetchImpl: typeof fetch
  private readonly defaultMaxTokens: number
  private lastError: string | null = null

  constructor(options: AnthropicEngineOptions) {
    this.provider = options.provider
    if (options.apiKey !== undefined) this.apiKey = options.apiKey
    if (options.capabilities !== undefined) this.capabilityLookup = options.capabilities
    this.fetchImpl = options.fetch ?? fetch
    this.defaultMaxTokens = options.defaultMaxTokens ?? 4096
  }

  capabilities(model: string): ModelCapabilities {
    return this.capabilityLookup?.(model) ?? inferCapabilities(this.provider)
  }

  private context(request: ModelRequest): CallContext {
    return { provider: this.provider.id, model: request.model }
  }

  private headers(request: ModelRequest): Record<string, string> {
    const env = this.provider.apiKeyEnv
    const key = this.apiKey?.()
    if (env !== null && env !== '' && (key === undefined || key.trim() === '')) {
      throw new ModelError('auth', `${env} is not set; ${this.provider.id} cannot be called`, {
        provider: this.provider.id,
        model: request.model,
      })
    }
    return {
      'anthropic-version': API_VERSION,
      ...this.provider.headers,
      ...(key !== undefined && key !== '' ? { 'x-api-key': key } : {}),
    }
  }

  /** Request body; exported for golden tests. */
  buildBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
    const { system, messages } = toAnthropicMessages(request)
    const maxTokens = request.maxTokens ?? this.provider.defaults.maxTokens ?? this.defaultMaxTokens
    const temperature = request.temperature ?? this.provider.defaults.temperature
    let systemText = system
    if (request.responseFormat?.type === 'json') {
      const schema = request.responseFormat.schema === undefined ? '' : ` It must match this JSON Schema: ${JSON.stringify(request.responseFormat.schema)}`
      systemText = `${systemText}${systemText === '' ? '' : '\n\n'}Respond with a single valid JSON value and nothing else.${schema}`
    }

    const body: Record<string, unknown> = { model: request.model, max_tokens: maxTokens, messages }
    if (systemText !== '') body.system = systemText
    if (request.thinking === true) {
      const effort = request.reasoningEffort ?? this.provider.defaults.reasoningEffort
      const wanted = EFFORT_BUDGET[effort ?? 'medium'] ?? 4096
      const budget = Math.min(wanted, maxTokens - 1)
      if (budget < MIN_THINKING_BUDGET) {
        throw new ModelError('invalid_request', `max tokens must exceed ${MIN_THINKING_BUDGET} to enable thinking`, {
          provider: this.provider.id,
          model: request.model,
        })
      }
      body.thinking = { type: 'enabled', budget_tokens: budget }
    } else if (temperature !== undefined) {
      body.temperature = temperature
    }
    if (request.stop !== undefined && request.stop.length > 0) body.stop_sequences = request.stop
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        input_schema: tool.parameters ?? { type: 'object', properties: {} },
      }))
    }
    if (stream) body.stream = true
    return body
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    assertCapabilities(request, this.capabilities(request.model))
    const ctx = this.context(request)
    try {
      const response = await postJson(`${baseUrl(this.provider)}/messages`, this.headers(request), this.buildBody(request, false), ctx, this.fetchImpl, signal)
      const json = await readJson(response, ctx, signal)
      let text = ''
      let thinking = ''
      const toolCalls: ToolCall[] = []
      for (const block of Array.isArray(json.content) ? (json.content as Block[]) : []) {
        if (block.type === 'text' && typeof block.text === 'string') text += block.text
        else if (block.type === 'thinking' && typeof block.thinking === 'string') thinking += block.thinking
        else if (block.type === 'tool_use' && typeof block.name === 'string') {
          toolCalls.push({ id: typeof block.id === 'string' ? block.id : `toolu_${toolCalls.length}`, name: block.name, arguments: block.input ?? {} })
        }
      }
      this.lastError = null
      return {
        provider: this.provider.id,
        model: request.model,
        text,
        ...(thinking !== '' ? { thinking } : {}),
        toolCalls,
        usage: mapAnthropicUsage(json.usage),
        finishReason: mapAnthropicStop(json.stop_reason),
        ...(typeof json.id === 'string' ? { providerRequestId: redact(json.id, 100) } : {}),
      }
    } catch (error) {
      this.lastError = error instanceof Error ? redact(error.message, 300) : String(error)
      throw error
    }
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    assertCapabilities(request, this.capabilities(request.model))
    const ctx = this.context(request)
    let text = ''
    let thinking = ''
    let stop: unknown
    let id: string | undefined
    let finished = false
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const tools = new Map<number, { id: string; name: string; json: string }>()
    const toolCalls: ToolCall[] = []

    const absorb = (raw: unknown): void => {
      if (raw === null || typeof raw !== 'object') return
      const record = raw as Record<string, unknown>
      // message_delta usage is cumulative: later values replace earlier ones.
      if (typeof record.input_tokens === 'number') usage.input = record.input_tokens
      if (typeof record.output_tokens === 'number') usage.output = record.output_tokens
      if (typeof record.cache_read_input_tokens === 'number') usage.cacheRead = record.cache_read_input_tokens
      if (typeof record.cache_creation_input_tokens === 'number') usage.cacheWrite = record.cache_creation_input_tokens
    }

    try {
      const response = await postJson(`${baseUrl(this.provider)}/messages`, { ...this.headers(request), Accept: 'text/event-stream' }, this.buildBody(request, true), ctx, this.fetchImpl, signal)
      for await (const message of parseSse(response.body, ctx, signal)) {
        let event: Record<string, unknown>
        try {
          event = JSON.parse(message.data) as Record<string, unknown>
        } catch {
          continue
        }
        const type = typeof event.type === 'string' ? event.type : message.event
        if (type === 'ping') continue
        if (type === 'error') {
          const failure = (event.error !== null && typeof event.error === 'object' ? event.error : {}) as { type?: unknown; message?: unknown }
          const failureType = typeof failure.type === 'string' ? failure.type : ''
          const failureText = typeof failure.message === 'string' ? failure.message : 'stream error'
          throw new ModelError(kindFromErrorType(failureType, failureText), `${this.provider.id} stream error: ${redact(failureText)}`, {
            provider: this.provider.id,
            model: request.model,
          })
        }
        if (type === 'message_start') {
          const started = (event.message !== null && typeof event.message === 'object' ? event.message : {}) as Record<string, unknown>
          if (typeof started.id === 'string') id = started.id
          absorb(started.usage)
        } else if (type === 'content_block_start') {
          const index = numberOf(event.index)
          const block = (event.content_block !== null && typeof event.content_block === 'object' ? event.content_block : {}) as Block
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            tools.set(index, { id: typeof block.id === 'string' ? block.id : `toolu_${index}`, name: block.name, json: '' })
          }
        } else if (type === 'content_block_delta') {
          const index = numberOf(event.index)
          const delta = (event.delta !== null && typeof event.delta === 'object' ? event.delta : {}) as Record<string, unknown>
          if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
            text += delta.text
            yield { type: 'text', text: delta.text }
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
            thinking += delta.thinking
            yield { type: 'thinking', text: delta.thinking }
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const tool = tools.get(index)
            if (tool !== undefined) tool.json += delta.partial_json
          }
        } else if (type === 'content_block_stop') {
          const index = numberOf(event.index)
          const tool = tools.get(index)
          if (tool !== undefined) {
            tools.delete(index)
            let input: unknown = {}
            if (tool.json.trim() !== '') {
              try {
                input = JSON.parse(tool.json) as unknown
              } catch {
                input = tool.json
              }
            }
            const call: ToolCall = { id: tool.id, name: tool.name, arguments: input }
            toolCalls.push(call)
            yield { type: 'tool_call', call }
          }
        } else if (type === 'message_delta') {
          const delta = (event.delta !== null && typeof event.delta === 'object' ? event.delta : {}) as Record<string, unknown>
          if (delta.stop_reason !== undefined && delta.stop_reason !== null) stop = delta.stop_reason
          absorb(event.usage)
        } else if (type === 'message_stop') {
          finished = true
          break
        }
      }
      if (signal?.aborted === true) throw abortedError(ctx)
      if (!finished) {
        throw new ModelError('network', `${this.provider.id} stream ended before message_stop`, { provider: this.provider.id, model: request.model })
      }
      const finalUsage = normalizeUsage({
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
      })
      yield { type: 'usage', usage: finalUsage }
      this.lastError = null
      yield {
        type: 'done',
        response: {
          provider: this.provider.id,
          model: request.model,
          text,
          ...(thinking !== '' ? { thinking } : {}),
          toolCalls,
          usage: finalUsage,
          finishReason: mapAnthropicStop(stop),
          ...(id !== undefined ? { providerRequestId: redact(id, 100) } : {}),
        },
      }
    } catch (error) {
      this.lastError = error instanceof Error ? redact(error.message, 300) : String(error)
      throw error
    }
  }

  async health(): Promise<EngineHealth> {
    const env = this.provider.apiKeyEnv
    const missingKey = env !== null && env !== '' && (this.apiKey?.() ?? '').trim() === ''
    return {
      provider: this.provider.id,
      state: missingKey ? 'unconfigured' : this.lastError !== null ? 'degraded' : 'healthy',
      models: 0,
      lastError: missingKey ? `${env} is not set` : this.lastError,
    }
  }
}
