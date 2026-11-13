/**
 * Provider-neutral facade used by the HTTP API.
 *
 * Owns the global target, the static catalogue and the explicit discovery /
 * health actions. Never returns a credential value.
 */

import { assertEgress } from './egress.ts'
import { ModelSettingsError, credentialPresent, resolveTarget, validateTarget, type ModelSettingsStore, type ModelTarget, type ResolvedTarget } from './settings.ts'
import type { ModelCatalog } from './catalog/store.ts'
import { effectiveProvider, type ModelPrice, type ModelRecord, type ProviderRecord } from './catalog/types.ts'
import { discoverModels, probeProvider, type ProviderHealth } from './catalog/probe.ts'
import { ModelError, type ModelResponse } from './ports.ts'
import { EngineRegistry, type ProviderRuntime, type RegistryOptions } from './registry.ts'
import { ModelRouter, type AttemptInfo, type RouteSource } from './router.ts'

export interface ProviderView {
  id: string
  kind: string
  displayName: string
  baseUrl: string | null
  apiKeyEnv: string | null
  local: boolean
  enabled: boolean
  /** True when the referenced environment variable is present. Never the value. */
  credentialPresent: boolean
  modelCount: number
}

export interface TargetView extends ResolvedTarget {
  providers: ProviderView[]
}

export interface DiscoveryResult {
  provider: string
  discovered: number
  models: ModelRecord[]
}

export interface ModelServiceOptions {
  catalog: ModelCatalog
  store: ModelSettingsStore
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  discoverTimeoutMs?: number
  healthTimeoutMs?: number
  /** Called for every routed attempt (success, failure, skip). Must not throw. */
  onAttempt?: (info: AttemptInfo) => void
  /** Called for every provider retry. */
  onRetry?: RegistryOptions['onRetry']
  /** Engine tuning overrides (tests). */
  tuning?: RegistryOptions['tuning']
  sleep?: RegistryOptions['sleep']
  random?: RegistryOptions['random']
  now?: RegistryOptions['now']
}

export interface TestCallInput {
  prompt?: string
  maxTokens?: number
  timeoutMs?: number
}

export interface TestCallResult {
  provider: string
  model: string
  text: string
  truncated: boolean
  finishReason: string
  usage: ModelResponse['usage']
  costUsd: number | null
  durationMs: number
  attempts: AttemptInfo[]
}

const TEST_PROMPT = 'Reply with the single word: ok'
const TEST_MAX_PROMPT = 2000
const TEST_MAX_TOKENS = 256
const TEST_MAX_TIMEOUT_MS = 300_000
const TEST_TEXT_LIMIT = 500

export class ModelService {
  private readonly catalog: ModelCatalog
  private readonly store: ModelSettingsStore
  private readonly env: Record<string, string | undefined>
  private readonly fetchImpl?: typeof fetch
  private readonly discoverTimeoutMs: number
  private readonly healthTimeoutMs: number
  private onTargetChange?: () => Promise<void> | void
  private readonly registry: EngineRegistry
  private readonly modelRouter: ModelRouter
  private readonly observers: Array<(info: AttemptInfo) => void> = []

  constructor(options: ModelServiceOptions) {
    this.catalog = options.catalog
    this.store = options.store
    this.env = options.env ?? process.env
    if (options.fetch !== undefined) this.fetchImpl = options.fetch
    this.discoverTimeoutMs = options.discoverTimeoutMs ?? 5000
    this.healthTimeoutMs = options.healthTimeoutMs ?? 3000
    if (options.onAttempt !== undefined) this.observers.push(options.onAttempt)
    this.registry = new EngineRegistry({
      env: this.env,
      ...(this.fetchImpl !== undefined ? { fetch: this.fetchImpl } : {}),
      ...(options.tuning !== undefined ? { tuning: options.tuning } : {}),
      ...(options.onRetry !== undefined ? { onRetry: options.onRetry } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
      ...(options.random !== undefined ? { random: options.random } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    })
    const source: RouteSource = {
      resolve: async () => {
        const { providers, models } = await this.load()
        const resolved = await resolveTarget(this.store, this.env, { providers, models })
        return { ...resolved, providers, models }
      },
    }
    this.modelRouter = new ModelRouter({
      source,
      registry: this.registry,
      env: this.env,
      onAttempt: (info) => {
        for (const observer of this.observers) {
          try { observer(info) } catch { /* observers never affect a call */ }
        }
      },
    })
  }

  /** The router every direct (non-harness) model call goes through. */
  get router(): ModelRouter {
    return this.modelRouter
  }

  /** Add an attempt observer (logging, stats). Observers must not throw. */
  observe(observer: (info: AttemptInfo) => void): void {
    this.observers.push(observer)
  }

  /** Per-provider circuit-breaker state. */
  runtime(): ProviderRuntime[] {
    return this.registry.runtime()
  }

  /** Close a provider's breaker by hand. */
  async resetBreaker(providerId: string): Promise<{ provider: string; reset: boolean }> {
    await this.requireProvider(providerId)
    return { provider: providerId, reset: this.registry.resetBreaker(providerId) }
  }

  /**
   * A small, bounded completion through the real routing path (settings →
   * fallback chain), so an operator can verify credentials, endpoints and
   * fallbacks without starting a stage run.
   */
  async test(input: unknown): Promise<TestCallResult> {
    const body = input === undefined || input === null ? {} : input
    if (typeof body !== 'object' || Array.isArray(body)) {
      throw new ModelSettingsError(400, 'INVALID_BODY', 'request body must be a JSON object')
    }
    const record = body as Record<string, unknown>
    const prompt = record.prompt === undefined ? TEST_PROMPT : record.prompt
    if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > TEST_MAX_PROMPT) {
      throw new ModelSettingsError(400, 'INVALID_TEST', `prompt must be a non-empty string up to ${TEST_MAX_PROMPT} characters`)
    }
    const maxTokens = record.maxTokens === undefined ? 32 : record.maxTokens
    if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > TEST_MAX_TOKENS) {
      throw new ModelSettingsError(400, 'INVALID_TEST', `maxTokens must be an integer between 1 and ${TEST_MAX_TOKENS}`)
    }
    const timeoutMs = record.timeoutMs === undefined ? 60_000 : record.timeoutMs
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > TEST_MAX_TIMEOUT_MS) {
      throw new ModelSettingsError(400, 'INVALID_TEST', `timeoutMs must be an integer between 1000 and ${TEST_MAX_TIMEOUT_MS}`)
    }

    const attempts: AttemptInfo[] = []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    const started = Date.now()
    try {
      const response = await this.modelRouter.complete(
        { messages: [{ role: 'user', content: prompt }], maxTokens, metadata: { purpose: 'models.test' } },
        { signal: controller.signal, onAttempt: (info) => { attempts.push(info) } },
      )
      return {
        provider: response.provider,
        model: response.model,
        text: response.text.slice(0, TEST_TEXT_LIMIT),
        truncated: response.text.length > TEST_TEXT_LIMIT,
        finishReason: response.finishReason,
        usage: response.usage,
        costUsd: response.costUsd ?? null,
        durationMs: Date.now() - started,
        attempts,
      }
    } catch (error) {
      if (error instanceof ModelError && error.kind === 'aborted') {
        throw new ModelError('timeout', `the test call did not finish within ${timeoutMs}ms`, { retryable: false })
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** Providers and models with environment overrides applied. */
  private async load(): Promise<{ providers: ProviderRecord[]; models: ModelRecord[] }> {
    const [providers, models] = await Promise.all([this.catalog.listProviders(), this.catalog.listModels()])
    return { providers: providers.map((provider) => effectiveProvider(provider, this.env)), models }
  }

  async providers(): Promise<ProviderView[]> {
    const { providers, models } = await this.load()
    return providers.map((provider) => this.view(provider, models))
  }

  async models(provider?: string): Promise<ModelRecord[]> {
    return this.catalog.listModels(provider)
  }

  /** Raw records for consumers that build harness patches. */
  async snapshot(): Promise<{ providers: ProviderRecord[]; models: ModelRecord[] }> {
    return this.load()
  }

  /** Environment the service resolves credentials and overrides from. */
  get environment(): Record<string, string | undefined> {
    return this.env
  }

  async target(): Promise<TargetView> {
    const { providers, models } = await this.load()
    const resolved = await resolveTarget(this.store, this.env, { providers, models })
    return { ...resolved, providers: providers.map((provider) => this.view(provider, models)) }
  }

  async updateTarget(input: unknown): Promise<TargetView> {
    const { providers, models } = await this.load()
    const target = validateTarget(input, { providers, models })
    assertEgress(target, providers, this.env)
    await this.store.save(target)
    await this.notifyTargetChange()
    return this.target()
  }

  /** Late-bound so the runtime can refresh without a construction cycle. */
  setTargetChangeHandler(handler: () => Promise<void> | void): void {
    this.onTargetChange = handler
  }

  private async notifyTargetChange(): Promise<void> {
    if (this.onTargetChange === undefined) return
    try {
      await this.onTargetChange()
    } catch {
      // A refresh failure is logged by the runtime; settings stay saved.
    }
  }

  /** Remove the stored target; resolution falls back to the environment. */
  async clearTarget(): Promise<TargetView> {
    await this.store.clear()
    await this.notifyTargetChange()
    return this.target()
  }

  /** Explicit discovery: fetch the provider's models and replace the catalogue. */
  async discover(providerId: string): Promise<DiscoveryResult> {
    const provider = await this.requireProvider(providerId)
    const apiKey = this.apiKeyFor(provider)
    const discovered = await discoverModels(provider, {
      ...(this.fetchImpl !== undefined ? { fetch: this.fetchImpl } : {}),
      timeoutMs: this.discoverTimeoutMs,
      ...(apiKey !== undefined ? { apiKey } : {}),
    })
    const models = await this.catalog.replaceModels(provider.id, discovered)
    return { provider: provider.id, discovered: discovered.length, models }
  }

  async health(providerId: string): Promise<ProviderHealth> {
    const provider = await this.requireProvider(providerId)
    const models = await this.catalog.listModels(provider.id)
    const apiKey = this.apiKeyFor(provider)
    return probeProvider(provider, models.length, {
      ...(this.fetchImpl !== undefined ? { fetch: this.fetchImpl } : {}),
      timeoutMs: this.healthTimeoutMs,
      credential: credentialPresent(provider, this.env),
      ...(apiKey !== undefined ? { apiKey } : {}),
    })
  }

  /** Snapshot for a run: the target plus the catalog needed to validate it. */
  async resolveForRun(): Promise<ResolvedTarget> {
    const { providers, models } = await this.load()
    return resolveTarget(this.store, this.env, { providers, models })
  }

  /** Set a model's price (USD per million tokens). Admin action. */
  async setPrice(providerId: string, model: string, input: unknown): Promise<ModelRecord> {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new ModelSettingsError(400, 'INVALID_BODY', 'request body must be a JSON object')
    }
    const record = input as Record<string, unknown>
    const price: ModelPrice = {}
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      const value = record[key]
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000) {
        throw new ModelSettingsError(400, 'INVALID_PRICE', `${key} must be a number between 0 and 100000 (USD per million tokens)`)
      }
      price[key] = value
    }
    if (Object.keys(price).length === 0) {
      throw new ModelSettingsError(400, 'INVALID_PRICE', 'provide at least one of input, output, cacheRead, cacheWrite')
    }
    await this.requireProvider(providerId)
    const updated = await this.catalog.setPrice(providerId, model, price)
    if (updated === undefined) {
      throw new ModelSettingsError(404, 'MODEL_NOT_FOUND', `model "${model}" is not in the ${providerId} catalogue; run discovery first`)
    }
    return updated
  }

  async close(): Promise<void> {
    await this.store.close?.()
    await this.catalog.close?.()
  }

  private async requireProvider(id: string): Promise<ProviderRecord> {
    const provider = await this.catalog.getProvider(id)
    if (provider === undefined) {
      throw new ModelSettingsError(404, 'PROVIDER_NOT_FOUND', `unknown provider "${id}"`)
    }
    return effectiveProvider(provider, this.env)
  }

  private apiKeyFor(provider: ProviderRecord): string | undefined {
    if (provider.apiKeyEnv === null) return undefined
    const value = this.env[provider.apiKeyEnv]
    return value === undefined || value.trim() === '' ? undefined : value
  }

  private view(provider: ProviderRecord, models: ModelRecord[]): ProviderView {
    return {
      id: provider.id,
      kind: provider.kind,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv,
      local: provider.local,
      enabled: provider.enabled,
      credentialPresent: credentialPresent(provider, this.env),
      modelCount: models.filter((entry) => entry.provider === provider.id).length,
    }
  }
}

export type { ModelTarget, ProviderHealth }
