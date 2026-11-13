/**
 * Explicit discovery and health probes.
 *
 * Both are operator-triggered, time-bounded and never run implicitly on a
 * request. Discovery writes the static catalogue; health only reports.
 */

import { ModelError, modelErrorFromStatus, type ModelCapabilities } from '../ports.ts'
import type { ModelRecord, ProviderRecord } from './types.ts'

const DEFAULT_TIMEOUT_MS = 5000

export interface ProbeOptions {
  /** Injected for tests. */
  fetch?: typeof fetch
  timeoutMs?: number
  apiKey?: string
}

export interface DiscoveredModel {
  model: string
  displayName: string | null
  contextWindow: number | null
  maxOutput: number | null
  capabilities: ModelCapabilities
  price: Record<string, number>
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function discoveryUrl(provider: ProviderRecord): string {
  if (provider.kind === 'anthropic') {
    const base = provider.baseUrl === null || provider.baseUrl === '' ? 'https://api.anthropic.com' : trimSlash(provider.baseUrl)
    const root = base.endsWith('/v1') ? base : `${base}/v1`
    return `${root}/models?limit=1000`
  }
  const base = provider.baseUrl === null || provider.baseUrl === '' ? '' : trimSlash(provider.baseUrl)
  return `${base}/models`
}

function authHeaders(provider: ProviderRecord, apiKey: string | undefined, extra: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...provider.headers,
    ...extra,
  }
  if (apiKey !== undefined && apiKey !== '') {
    if (provider.kind === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01'
    } else if (provider.kind === 'azure-openai') {
      headers['api-key'] = apiKey
    } else {
      headers.Authorization = `Bearer ${apiKey}`
    }
  }
  return headers
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

function capabilitiesFor(provider: ProviderRecord): ModelCapabilities {
  // Cloud vendors generally support tools; local servers only when started with
  // `--jinja`. Discovery cannot prove it, so local routes start conservative and
  // the router reports `unsupported` until the operator enables it.
  return {
    contextWindow: 8192,
    tools: !provider.local,
    thinking: !provider.local,
    jsonMode: !provider.local,
    vision: false,
    streaming: true,
  }
}

export async function discoverModels(provider: ProviderRecord, options: ProbeOptions = {}): Promise<DiscoveredModel[]> {
  if (provider.kind === 'google' || provider.kind === 'bedrock' || provider.kind === 'azure-openai') {
    throw new ModelError('unsupported', `discovery is not implemented for ${provider.kind} yet`, { provider: provider.id })
  }
  const url = discoveryUrl(provider)
  if (url === '/models') {
    throw new ModelError('invalid_request', `provider "${provider.id}" has no baseUrl to discover from`, { provider: provider.id })
  }
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetchImpl(url, {
      headers: authHeaders(provider, options.apiKey, {}),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw modelErrorFromStatus(response.status, `discovery failed for ${provider.id}: HTTP ${response.status}`, {
        provider: provider.id,
      })
    }
    const body = await response.json() as { data?: unknown }
    const entries = Array.isArray(body.data) ? body.data : []
    const base = capabilitiesFor(provider)
    const models: DiscoveredModel[] = []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const id = typeof record.id === 'string' ? record.id : typeof record.model === 'string' ? record.model : undefined
      if (id === undefined || id === '') continue
      models.push({
        model: id,
        displayName: typeof record.display_name === 'string' ? record.display_name : typeof record.name === 'string' ? record.name : null,
        contextWindow: num(record.context_window) ?? num(record.context_length) ?? num(record.max_input_tokens),
        maxOutput: num(record.max_output_tokens) ?? num(record.max_tokens),
        capabilities: {
          ...base,
          ...(num(record.context_window) !== null || num(record.max_input_tokens) !== null
            ? { contextWindow: (num(record.context_window) ?? num(record.max_input_tokens))! }
            : {}),
        },
        price: {},
      })
    }
    return models
  } catch (error) {
    if (error instanceof ModelError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ModelError('timeout', `discovery timed out after ${timeoutMs}ms`, { provider: provider.id })
    }
    throw new ModelError('network', error instanceof Error ? error.message : String(error), { provider: provider.id, cause: error })
  } finally {
    clearTimeout(timer)
  }
}

export type ProviderState = 'healthy' | 'degraded' | 'unconfigured'

export interface ProviderHealth {
  provider: string
  state: ProviderState
  credential: boolean
  reachable: boolean | null
  latencyMs: number | null
  models: number
  lastError: string | null
}

export async function probeProvider(
  provider: ProviderRecord,
  modelCount: number,
  options: ProbeOptions & { credential: boolean },
): Promise<ProviderHealth> {
  if (!options.credential) {
    return {
      provider: provider.id,
      state: 'unconfigured',
      credential: false,
      reachable: null,
      latencyMs: null,
      models: modelCount,
      lastError: provider.apiKeyEnv === null ? null : `${provider.apiKeyEnv} is not set`,
    }
  }
  const url = discoveryUrl(provider)
  if (url === '/models') {
    // Cloud provider using vendor defaults: reachability is the vendor's problem
    // until the first real call, so report neither up nor down.
    return {
      provider: provider.id,
      state: 'healthy',
      credential: true,
      reachable: null,
      latencyMs: null,
      models: modelCount,
      lastError: null,
    }
  }
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetchImpl(url, { headers: authHeaders(provider, options.apiKey, {}), signal: controller.signal })
    const latencyMs = Date.now() - started
    if (!response.ok) {
      return {
        provider: provider.id,
        state: 'degraded',
        credential: true,
        reachable: false,
        latencyMs,
        models: modelCount,
        lastError: `HTTP ${response.status}`,
      }
    }
    return { provider: provider.id, state: 'healthy', credential: true, reachable: true, latencyMs, models: modelCount, lastError: null }
  } catch (error) {
    return {
      provider: provider.id,
      state: 'degraded',
      credential: true,
      reachable: false,
      latencyMs: Date.now() - started,
      models: modelCount,
      lastError: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

export type { ModelRecord }
