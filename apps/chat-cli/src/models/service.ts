/**
 * Provider-neutral facade used by the HTTP API.
 *
 * Owns the global target, the static catalogue and the explicit discovery /
 * health actions. Never returns a credential value.
 */

import { ModelSettingsError, credentialPresent, resolveTarget, validateTarget, type ModelSettingsStore, type ModelTarget, type ResolvedTarget } from './settings.ts'
import type { ModelCatalog } from './catalog/store.ts'
import type { ModelRecord, ProviderRecord } from './catalog/types.ts'
import { discoverModels, probeProvider, type ProviderHealth } from './catalog/probe.ts'

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
}

export class ModelService {
  private readonly catalog: ModelCatalog
  private readonly store: ModelSettingsStore
  private readonly env: Record<string, string | undefined>
  private readonly fetchImpl?: typeof fetch
  private readonly discoverTimeoutMs: number
  private readonly healthTimeoutMs: number

  constructor(options: ModelServiceOptions) {
    this.catalog = options.catalog
    this.store = options.store
    this.env = options.env ?? process.env
    if (options.fetch !== undefined) this.fetchImpl = options.fetch
    this.discoverTimeoutMs = options.discoverTimeoutMs ?? 5000
    this.healthTimeoutMs = options.healthTimeoutMs ?? 3000
  }

  async providers(): Promise<ProviderView[]> {
    const [providers, models] = await Promise.all([this.catalog.listProviders(), this.catalog.listModels()])
    return providers.map((provider) => this.view(provider, models))
  }

  async models(provider?: string): Promise<ModelRecord[]> {
    return this.catalog.listModels(provider)
  }

  async target(): Promise<TargetView> {
    const [providers, models] = await Promise.all([this.catalog.listProviders(), this.catalog.listModels()])
    const resolved = await resolveTarget(this.store, this.env, { providers, models })
    return { ...resolved, providers: providers.map((provider) => this.view(provider, models)) }
  }

  async updateTarget(input: unknown): Promise<TargetView> {
    const [providers, models] = await Promise.all([this.catalog.listProviders(), this.catalog.listModels()])
    const target = validateTarget(input, { providers, models })
    await this.store.save(target)
    return this.target()
  }

  /** Remove the stored target; resolution falls back to the environment. */
  async clearTarget(): Promise<TargetView> {
    await this.store.clear()
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
    const [providers, models] = await Promise.all([this.catalog.listProviders(), this.catalog.listModels()])
    return resolveTarget(this.store, this.env, { providers, models })
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
    return provider
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
