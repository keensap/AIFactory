/**
 * Builds and caches one resilient engine per provider.
 *
 * Engines are keyed by provider id and rebuilt (with a fresh circuit breaker)
 * when the provider's effective configuration changes, so an endpoint edit never
 * inherits the old endpoint's failure history. Breakers otherwise survive target
 * changes, which is what keeps a dead provider quarantined.
 */

import type { ModelRecord, ProviderRecord } from './catalog/types.ts'
import { capabilitiesFor } from './capabilities.ts'
import { AnthropicEngine } from './engines/anthropic.ts'
import { OpenAICompatibleEngine } from './engines/openai-compatible.ts'
import { ModelError, type ModelCapabilities, type ModelEngine } from './ports.ts'
import { CircuitBreaker, ResilientEngine, type BreakerSnapshot } from './resilience.ts'

export interface RegistryTuning {
  /** Per-attempt deadline for cloud providers. */
  cloudTimeoutMs: number
  /** Per-attempt deadline for local providers (CPU inference is slow). */
  localTimeoutMs: number
  cloudRetries: number
  localRetries: number
  baseDelayMs: number
  maxDelayMs: number
  breakerThreshold: number
  breakerCooldownMs: number
}

export const DEFAULT_TUNING: RegistryTuning = {
  cloudTimeoutMs: 120_000,
  localTimeoutMs: 600_000,
  cloudRetries: 2,
  localRetries: 1,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  breakerThreshold: 5,
  breakerCooldownMs: 30_000,
}

function positive(value: string | undefined, fallback: number, allowZero = false): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) return fallback
  return Math.floor(parsed)
}

export function tuningFromEnvironment(env: Record<string, string | undefined>): RegistryTuning {
  return {
    cloudTimeoutMs: positive(env.AIFACTORY_MODEL_TIMEOUT_MS, DEFAULT_TUNING.cloudTimeoutMs),
    localTimeoutMs: positive(env.AIFACTORY_MODEL_LOCAL_TIMEOUT_MS, DEFAULT_TUNING.localTimeoutMs),
    cloudRetries: positive(env.AIFACTORY_MODEL_MAX_RETRIES, DEFAULT_TUNING.cloudRetries, true),
    localRetries: positive(env.AIFACTORY_MODEL_LOCAL_MAX_RETRIES, DEFAULT_TUNING.localRetries, true),
    baseDelayMs: positive(env.AIFACTORY_MODEL_RETRY_BASE_MS, DEFAULT_TUNING.baseDelayMs),
    maxDelayMs: positive(env.AIFACTORY_MODEL_RETRY_MAX_MS, DEFAULT_TUNING.maxDelayMs),
    breakerThreshold: positive(env.AIFACTORY_MODEL_BREAKER_THRESHOLD, DEFAULT_TUNING.breakerThreshold),
    breakerCooldownMs: positive(env.AIFACTORY_MODEL_BREAKER_COOLDOWN_MS, DEFAULT_TUNING.breakerCooldownMs),
  }
}

export interface RegistryOptions {
  env: Record<string, string | undefined>
  fetch?: typeof fetch
  tuning?: Partial<RegistryTuning>
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
  /** Reports each retry so the caller can log it. */
  onRetry?: (info: { provider: string; model?: string; attempt: number; delayMs: number; kind: string }) => void
}

interface Entry {
  fingerprint: string
  engine: ResilientEngine
  breaker: CircuitBreaker
  raw: ModelEngine
}

function fingerprint(provider: ProviderRecord): string {
  return JSON.stringify([provider.kind, provider.baseUrl, provider.apiKeyEnv, provider.headers, provider.defaults, provider.local])
}

export interface ProviderRuntime {
  provider: string
  breaker: BreakerSnapshot
}

export class EngineRegistry {
  private readonly options: RegistryOptions
  private readonly tuning: RegistryTuning
  private readonly entries = new Map<string, Entry>()
  private models: readonly ModelRecord[] = []

  constructor(options: RegistryOptions) {
    this.options = options
    this.tuning = { ...tuningFromEnvironment(options.env), ...options.tuning }
  }

  /** Keep capability and price lookups current without rebuilding engines. */
  setCatalog(models: readonly ModelRecord[]): void {
    this.models = models
  }

  catalog(): readonly ModelRecord[] {
    return this.models
  }

  private build(provider: ProviderRecord): ModelEngine {
    const common = {
      provider,
      apiKey: (): string | undefined => {
        const name = provider.apiKeyEnv
        if (name === null || name === '') return undefined
        const value = this.options.env[name]
        return value === undefined || value.trim() === '' ? undefined : value
      },
      capabilities: (model: string): ModelCapabilities => capabilitiesFor(provider, model, this.models),
      ...(this.options.fetch !== undefined ? { fetch: this.options.fetch } : {}),
    }
    switch (provider.kind) {
      case 'anthropic':
        return new AnthropicEngine(common)
      case 'openai':
      case 'openai-compatible':
        return new OpenAICompatibleEngine(common)
      default:
        throw new ModelError('unsupported', `provider "${provider.id}" (${provider.kind}) has no direct engine yet`, { provider: provider.id })
    }
  }

  /**
   * The circuit breaker a provider's engine uses, creating the entry if needed.
   *
   * Exposed so harness runs share one view of provider health with direct calls
   * (AR-03): a provider that direct calls have already found unhealthy should not
   * be tried first by every role.
   */
  breakerFor(provider: ProviderRecord): CircuitBreaker {
    this.engineFor(provider)
    return this.entries.get(provider.id)!.breaker
  }

  /** The resilient engine for a provider, rebuilt when its configuration changed. */
  engineFor(provider: ProviderRecord): ResilientEngine {
    const print = fingerprint(provider)
    const existing = this.entries.get(provider.id)
    if (existing !== undefined && existing.fingerprint === print) return existing.engine

    const breaker = new CircuitBreaker({
      failureThreshold: this.tuning.breakerThreshold,
      cooldownMs: this.tuning.breakerCooldownMs,
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
    })
    const raw = this.build(provider)
    const engine = new ResilientEngine(raw, {
      breaker,
      attemptTimeoutMs: provider.local ? this.tuning.localTimeoutMs : this.tuning.cloudTimeoutMs,
      maxRetries: provider.local ? this.tuning.localRetries : this.tuning.cloudRetries,
      baseDelayMs: this.tuning.baseDelayMs,
      maxDelayMs: this.tuning.maxDelayMs,
      ...(this.options.sleep !== undefined ? { sleep: this.options.sleep } : {}),
      ...(this.options.random !== undefined ? { random: this.options.random } : {}),
      onRetry: (info) => this.options.onRetry?.({
        provider: provider.id,
        attempt: info.attempt,
        delayMs: info.delayMs,
        kind: info.error.kind,
      }),
    })
    this.entries.set(provider.id, { fingerprint: print, engine, breaker, raw })
    return engine
  }

  /** Drop engines for providers that no longer exist. */
  retain(providerIds: Iterable<string>): void {
    const keep = new Set(providerIds)
    for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.entries.delete(id)
  }

  /** Close a provider's breaker by hand (admin recovery action). */
  resetBreaker(providerId: string): boolean {
    const entry = this.entries.get(providerId)
    if (entry === undefined) return false
    entry.breaker.reset()
    return true
  }

  runtime(): ProviderRuntime[] {
    return [...this.entries.entries()]
      .map(([provider, entry]) => ({ provider, breaker: entry.breaker.snapshot() }))
      .sort((a, b) => a.provider.localeCompare(b.provider))
  }
}
