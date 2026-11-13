/**
 * Model provider ports.
 *
 * The core depends only on these types. Anthropic, OpenAI, llama.cpp or any
 * future provider is an adapter that implements `ModelEngine`. No vendor SDK
 * type may appear in this file.
 *
 * Invariants every engine must satisfy (enforced by the contract suite):
 *  - `complete`/`stream` reject only with `ModelError`;
 *  - the caller's `AbortSignal` is honoured;
 *  - usage is normalized into `Usage`;
 *  - `stream` always ends with exactly one `done` event;
 *  - unsupported requests fail before network I/O with kind `unsupported`.
 */

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** Token accounting shared by every provider and by the stats API. */
export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Normalize a provider's usage report.
 *
 * Convention (matches the harness): `inputTokens` excludes cached tokens, which
 * are reported separately, so `totalTokens` = input + output + cacheRead +
 * cacheWrite. When a provider omits the total it is derived the same way, so
 * cross-provider totals stay comparable.
 */
export function normalizeUsage(partial: Partial<Usage> | undefined | null): Usage {
  if (partial === null || partial === undefined) return emptyUsage()
  const inputTokens = count(partial.inputTokens)
  const outputTokens = count(partial.outputTokens)
  const total = count(partial.totalTokens)
  return {
    inputTokens,
    outputTokens,
    totalTokens: total > 0
      ? total
      : inputTokens + outputTokens + count(partial.cacheReadTokens) + count(partial.cacheWriteTokens),
    cacheReadTokens: count(partial.cacheReadTokens),
    cacheWriteTokens: count(partial.cacheWriteTokens),
  }
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  /** Tokens the model can accept in one request. Required for routing. */
  contextWindow: number
  maxOutputTokens?: number
  tools: boolean
  thinking: boolean
  jsonMode: boolean
  vision: boolean
  streaming: boolean
}

/** Conservative defaults: usable for plain text, nothing else. */
export function defaultCapabilities(): ModelCapabilities {
  return {
    contextWindow: 8192,
    tools: false,
    thinking: false,
    jsonMode: false,
    vision: false,
    streaming: true,
  }
}

/** Features a request needs but the model does not advertise. */
export function missingCapabilities(
  request: Pick<ModelRequest, 'tools' | 'responseFormat' | 'thinking'>,
  capabilities: ModelCapabilities,
): string[] {
  const missing: string[] = []
  if (request.tools !== undefined && request.tools.length > 0 && !capabilities.tools) missing.push('tools')
  if (request.responseFormat?.type === 'json' && !capabilities.jsonMode) missing.push('json')
  if (request.thinking === true && !capabilities.thinking) missing.push('thinking')
  return missing
}

// ---------------------------------------------------------------------------
// Messages, tools, request and response
// ---------------------------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  arguments: unknown
}

export interface ChatMessage {
  role: ChatRole
  content: string
  /** Tool name for `tool` messages and, optionally, assistant messages. */
  name?: string
  /** Correlates a `tool` message with the assistant call it answers. */
  toolCallId?: string
  /** Tool calls requested by an assistant message. */
  toolCalls?: ToolCall[]
}

export interface ToolSchema {
  name: string
  description?: string
  /** JSON Schema for the arguments object. */
  parameters?: unknown
}

export type ResponseFormat = { type: 'text' } | { type: 'json'; schema?: unknown }

export interface ModelRequest {
  provider: string
  model: string
  messages: ChatMessage[]
  /** Provider-neutral system prompt; adapters place it per protocol. */
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  reasoningEffort?: string
  responseFormat?: ResponseFormat
  /** Ask for extended reasoning where the model supports it. */
  thinking?: boolean
  stop?: string[]
  /** Ambient correlation; never sent to the provider. */
  projectId?: string
  stageRunId?: string
  role?: string
  metadata?: Record<string, string>
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error'

export interface ModelResponse {
  provider: string
  model: string
  text: string
  thinking?: string
  toolCalls: ToolCall[]
  usage: Usage
  finishReason: FinishReason
  providerRequestId?: string
  /** Computed from the price table when known. */
  costUsd?: number
}

export type ModelEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; response: ModelResponse }
  | { type: 'error'; error: ModelError }

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ModelErrorKind =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'overloaded'
  | 'timeout'
  | 'network'
  | 'invalid_request'
  | 'context_overflow'
  | 'content_filter'
  | 'unsupported'
  | 'aborted'
  /** Every target in the chain failed, or the route is shut by its breaker. */
  | 'unavailable'
  /** No model target is configured (settings and environment are both empty). */
  | 'unconfigured'
  | 'unknown'

const RETRYABLE: ReadonlySet<ModelErrorKind> = new Set<ModelErrorKind>([
  'rate_limit',
  'overloaded',
  'timeout',
  'network',
])

/** Whether a retry (and therefore a fallback) may help. */
export function isRetryable(kind: ModelErrorKind): boolean {
  return RETRYABLE.has(kind)
}

export interface ModelErrorOptions {
  status?: number
  retryable?: boolean
  /** Provider-suggested wait before a retry (Retry-After), in milliseconds. */
  retryAfterMs?: number
  provider?: string
  model?: string
  providerRequestId?: string
  cause?: unknown
}

export class ModelError extends Error {
  readonly kind: ModelErrorKind
  readonly status?: number
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly provider?: string
  readonly model?: string
  readonly providerRequestId?: string

  constructor(kind: ModelErrorKind, message: string, options: ModelErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ModelError'
    this.kind = kind
    this.retryable = options.retryable ?? isRetryable(kind)
    if (options.status !== undefined) this.status = options.status
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
    if (options.provider !== undefined) this.provider = options.provider
    if (options.model !== undefined) this.model = options.model
    if (options.providerRequestId !== undefined) this.providerRequestId = options.providerRequestId
  }
}

/** Map an HTTP status from any provider to a normalized error kind. */
export function kindFromStatus(status: number): ModelErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'quota'
  if (status === 429) return 'rate_limit'
  if (status === 400 || status === 404 || status === 422) return 'invalid_request'
  if (status === 413) return 'context_overflow'
  if (status === 408) return 'timeout'
  if (status === 529 || status === 503 || status === 502) return 'overloaded'
  if (status >= 500) return 'overloaded'
  return 'unknown'
}

export function modelErrorFromStatus(status: number, message: string, options: ModelErrorOptions = {}): ModelError {
  return new ModelError(kindFromStatus(status), message, { ...options, status })
}

/** Fail before network I/O when a request needs a feature the model lacks. */
export function assertCapabilities(request: ModelRequest, capabilities: ModelCapabilities): void {
  const missing = missingCapabilities(request, capabilities)
  if (missing.length === 0) return
  throw new ModelError(
    'unsupported',
    `${request.provider}/${request.model} does not support: ${missing.join(', ')}`,
    { provider: request.provider, model: request.model },
  )
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export type EngineState = 'healthy' | 'degraded' | 'unavailable' | 'unconfigured'

export interface EngineHealth {
  provider: string
  state: EngineState
  /** Models the engine can serve, when known. */
  models: number
  lastError: string | null
}

/**
 * One provider implementation.
 *
 * Implementations must be non-throwing except for `ModelError`, must honour
 * the abort signal, and must not mutate the request.
 */
export interface ModelEngine {
  readonly kind: string
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>
  health(): Promise<EngineHealth>
}
