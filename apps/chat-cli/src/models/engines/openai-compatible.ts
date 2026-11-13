/**
 * OpenAI Chat Completions engine.
 *
 * Serves OpenAI itself and every OpenAI-compatible server: llama.cpp
 * (`llama-server --jinja` for tools), Ollama, vLLM, LM Studio, OpenRouter, Groq,
 * Together and gateways. Differences are handled by data, not by new engines:
 *
 *  - reasoning models (o-series, gpt-5) take `max_completion_tokens` and reject
 *    `temperature`;
 *  - `reasoning_content` / `reasoning` deltas are surfaced as thinking;
 *  - usage is normalized so `inputTokens` excludes cached tokens, matching the
 *    harness convention.
 */

import { inferCapabilities } from '../capabilities.ts'
import {
  ModelError,
  assertCapabilities,
  normalizeUsage,
  type ChatMessage,
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
  parseToolArguments,
  postJson,
  readJson,
  redact,
  type CallContext,
} from './shared.ts'

export interface OpenAIEngineOptions {
  /** Effective provider record (environment overrides already applied). */
  provider: ProviderRecord
  /** Resolved at call time so a rotated key needs no restart. */
  apiKey?: () => string | undefined
  /** Catalogue-backed capabilities; defaults to inference from the provider kind. */
  capabilities?: (model: string) => ModelCapabilities
  fetch?: typeof fetch
}

const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1'
const REASONING_MODEL = /^(?:o\d|gpt-5)/i

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .join('')
  }
  return ''
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** OpenAI usage → normalized usage (input excludes cached tokens). */
export function mapOpenAIUsage(raw: unknown): Usage {
  if (raw === null || typeof raw !== 'object') return normalizeUsage(undefined)
  const usage = raw as Record<string, unknown>
  const details = usage.prompt_tokens_details !== null && typeof usage.prompt_tokens_details === 'object'
    ? (usage.prompt_tokens_details as Record<string, unknown>)
    : {}
  const prompt = numberOf(usage.prompt_tokens)
  const cached = Math.min(numberOf(details.cached_tokens), prompt)
  return normalizeUsage({
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: numberOf(usage.completion_tokens),
    totalTokens: numberOf(usage.total_tokens),
    cacheReadTokens: cached,
  })
}

export function mapOpenAIFinish(reason: unknown, hasToolCalls: boolean): FinishReason {
  if (reason === 'length') return 'length'
  if (reason === 'content_filter') return 'content_filter'
  if (reason === 'tool_calls' || reason === 'function_call' || (reason === 'stop' && hasToolCalls)) return 'tool_calls'
  if (reason === 'stop' || reason === null || reason === undefined) return hasToolCalls ? 'tool_calls' : 'stop'
  return 'stop'
}

function toolCallsOf(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return []
  const calls: ToolCall[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    if (typeof record.function?.name !== 'string') continue
    calls.push({
      id: typeof record.id === 'string' ? record.id : `call_${calls.length}`,
      name: record.function.name,
      arguments: typeof record.function.arguments === 'string'
        ? parseToolArguments(record.function.arguments)
        : record.function.arguments ?? {},
    })
  }
  return calls
}

export function toOpenAIMessages(request: ModelRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  if (request.system !== undefined && request.system !== '') messages.push({ role: 'system', content: request.system })
  for (const message of request.messages as ChatMessage[]) {
    if (message.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content })
    } else if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: message.content === '' ? null : message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
          },
        })),
      })
    } else {
      messages.push({ role: message.role, content: message.content })
    }
  }
  return messages
}

export class OpenAICompatibleEngine implements ModelEngine {
  readonly kind: string
  private readonly provider: ProviderRecord
  private readonly apiKey?: () => string | undefined
  private readonly capabilityLookup?: (model: string) => ModelCapabilities
  private readonly fetchImpl: typeof fetch
  private lastError: string | null = null

  constructor(options: OpenAIEngineOptions) {
    this.provider = options.provider
    this.kind = options.provider.kind
    if (options.apiKey !== undefined) this.apiKey = options.apiKey
    if (options.capabilities !== undefined) this.capabilityLookup = options.capabilities
    this.fetchImpl = options.fetch ?? fetch
  }

  private get baseUrl(): string {
    if (this.provider.baseUrl !== null && this.provider.baseUrl !== '') return trimSlash(this.provider.baseUrl)
    return OPENAI_DEFAULT_BASE
  }

  capabilities(model: string): ModelCapabilities {
    return this.capabilityLookup?.(model) ?? inferCapabilities(this.provider)
  }

  private context(request: ModelRequest): CallContext {
    return { provider: this.provider.id, model: request.model }
  }

  private requireKey(request: ModelRequest): string | undefined {
    const env = this.provider.apiKeyEnv
    if (env === null || env === '' || this.provider.local) return this.apiKey?.()
    const key = this.apiKey?.()
    if (key === undefined || key.trim() === '') {
      throw new ModelError('auth', `${env} is not set; ${this.provider.id} cannot be called`, {
        provider: this.provider.id,
        model: request.model,
      })
    }
    return key
  }

  private headers(key: string | undefined): Record<string, string> {
    return {
      ...this.provider.headers,
      ...(key !== undefined && key !== '' ? { Authorization: `Bearer ${key}` } : {}),
    }
  }

  /** Request body; exported through `buildBody` for golden tests. */
  buildBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
    const reasoning = this.provider.kind === 'openai' && REASONING_MODEL.test(request.model)
    const maxTokens = request.maxTokens ?? this.provider.defaults.maxTokens
    const temperature = request.temperature ?? this.provider.defaults.temperature
    const effort = request.reasoningEffort ?? this.provider.defaults.reasoningEffort

    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(request),
    }
    if (maxTokens !== undefined) body[reasoning ? 'max_completion_tokens' : 'max_tokens'] = maxTokens
    if (temperature !== undefined && !reasoning) body.temperature = temperature
    if (effort !== undefined && (reasoning || this.provider.kind === 'openai-compatible')) body.reasoning_effort = effort
    if (request.stop !== undefined && request.stop.length > 0) body.stop = request.stop
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      }))
    }
    if (request.responseFormat?.type === 'json') {
      body.response_format = request.responseFormat.schema === undefined
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: 'response', schema: request.responseFormat.schema } }
    }
    if (stream) {
      body.stream = true
      body.stream_options = { include_usage: true }
    }
    return body
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    assertCapabilities(request, this.capabilities(request.model))
    const ctx = this.context(request)
    try {
      const key = this.requireKey(request)
      const response = await postJson(`${this.baseUrl}/chat/completions`, this.headers(key), this.buildBody(request, false), ctx, this.fetchImpl, signal)
      const json = await readJson(response, ctx, signal)
      const choice = Array.isArray(json.choices) ? (json.choices[0] as Record<string, unknown> | undefined) : undefined
      if (choice === undefined) throw new ModelError('unknown', `${this.provider.id} returned no choices`, { provider: this.provider.id, model: request.model })
      const message = (choice.message !== null && typeof choice.message === 'object' ? choice.message : {}) as Record<string, unknown>
      const toolCalls = toolCallsOf(message.tool_calls)
      const thinking = textOf(message.reasoning_content ?? message.reasoning)
      this.lastError = null
      return {
        provider: this.provider.id,
        model: request.model,
        text: textOf(message.content),
        ...(thinking !== '' ? { thinking } : {}),
        toolCalls,
        usage: mapOpenAIUsage(json.usage),
        finishReason: mapOpenAIFinish(choice.finish_reason, toolCalls.length > 0),
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
    let usage: Usage | undefined
    let finish: unknown
    let id: string | undefined
    const calls = new Map<number, { id: string; name: string; args: string }>()
    try {
      const key = this.requireKey(request)
      const response = await postJson(`${this.baseUrl}/chat/completions`, { ...this.headers(key), Accept: 'text/event-stream' }, this.buildBody(request, true), ctx, this.fetchImpl, signal)
      for await (const message of parseSse(response.body, ctx, signal)) {
        if (message.data === '[DONE]') break
        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(message.data) as Record<string, unknown>
        } catch {
          continue
        }
        if (chunk.error !== null && typeof chunk.error === 'object') {
          const failure = chunk.error as { message?: unknown; type?: unknown; code?: unknown }
          const type = typeof failure.type === 'string' ? failure.type : typeof failure.code === 'string' ? failure.code : ''
          const text = typeof failure.message === 'string' ? failure.message : 'stream error'
          throw new ModelError(kindFromErrorType(type, text), `${this.provider.id} stream error: ${redact(text)}`, {
            provider: this.provider.id,
            model: request.model,
          })
        }
        if (typeof chunk.id === 'string') id = chunk.id
        if (chunk.usage !== null && typeof chunk.usage === 'object') usage = mapOpenAIUsage(chunk.usage)
        const choice = Array.isArray(chunk.choices) ? (chunk.choices[0] as Record<string, unknown> | undefined) : undefined
        if (choice === undefined) continue
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) finish = choice.finish_reason
        const delta = (choice.delta !== null && typeof choice.delta === 'object' ? choice.delta : {}) as Record<string, unknown>
        const content = textOf(delta.content)
        if (content !== '') {
          text += content
          yield { type: 'text', text: content }
        }
        const reasoning = textOf(delta.reasoning_content ?? delta.reasoning)
        if (reasoning !== '') {
          thinking += reasoning
          yield { type: 'thinking', text: reasoning }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const part of delta.tool_calls as Array<Record<string, unknown>>) {
            const index = typeof part.index === 'number' ? part.index : 0
            const entry = calls.get(index) ?? { id: '', name: '', args: '' }
            if (typeof part.id === 'string' && part.id !== '') entry.id = part.id
            const fn = (part.function !== null && typeof part.function === 'object' ? part.function : {}) as Record<string, unknown>
            if (typeof fn.name === 'string') entry.name += fn.name
            if (typeof fn.arguments === 'string') entry.args += fn.arguments
            calls.set(index, entry)
          }
        }
      }
      if (signal?.aborted === true) throw abortedError(ctx)

      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, entry]) => entry.name !== '')
        .map(([index, entry]) => ({
          id: entry.id === '' ? `call_${index}` : entry.id,
          name: entry.name,
          arguments: parseToolArguments(entry.args),
        }))
      for (const call of toolCalls) yield { type: 'tool_call', call }
      const finalUsage = usage ?? normalizeUsage(undefined)
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
          finishReason: mapOpenAIFinish(finish, toolCalls.length > 0),
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
    const missingKey = env !== null && env !== '' && !this.provider.local && (this.apiKey?.() ?? '').trim() === ''
    return {
      provider: this.provider.id,
      state: missingKey ? 'unconfigured' : this.lastError !== null ? 'degraded' : 'healthy',
      models: 0,
      lastError: missingKey ? `${env} is not set` : this.lastError,
    }
  }
}
