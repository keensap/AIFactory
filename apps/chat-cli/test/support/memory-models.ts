import {
  defaultCapabilities,
  type ModelCatalog,
  type ModelPrice,
  type ModelRecord,
  type ModelSettings,
  type ModelSettingsStore,
  type ModelTarget,
  type ProviderRecord,
} from '../../src/models/index.ts'

export const provider = (id: string, overrides: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id, kind: 'openai', displayName: id, baseUrl: null, apiKeyEnv: null, headers: {}, defaults: {}, enabled: true, local: false,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
})

export const model = (providerId: string, name: string, contextWindow = 128_000, price: ModelPrice = {}): ModelRecord => ({
  provider: providerId, model: name, displayName: name, contextWindow, maxOutput: 8192,
  capabilities: { ...defaultCapabilities(), contextWindow, tools: true }, price, discoveredAt: null,
})

export class MemoryCatalog implements ModelCatalog {
  providers: ProviderRecord[]
  models: ModelRecord[]

  constructor(providers: ProviderRecord[], models: ModelRecord[]) {
    this.providers = providers
    this.models = models
  }

  async listProviders(): Promise<ProviderRecord[]> { return this.providers }
  async getProvider(id: string): Promise<ProviderRecord | undefined> { return this.providers.find((entry) => entry.id === id) }
  async listModels(providerId?: string): Promise<ModelRecord[]> {
    return providerId === undefined ? this.models : this.models.filter((entry) => entry.provider === providerId)
  }
  async replaceModels(providerId: string, incoming: Array<Omit<ModelRecord, 'provider' | 'discoveredAt'>>): Promise<ModelRecord[]> {
    const existing = new Map(this.models.filter((entry) => entry.provider === providerId).map((entry) => [entry.model, entry]))
    const kept = this.models.filter((entry) => entry.provider !== providerId)
    for (const model of incoming) {
      const priced = Object.keys(model.price).length > 0
      kept.push({ ...model, provider: providerId, price: priced ? model.price : existing.get(model.model)?.price ?? {}, discoveredAt: new Date().toISOString() })
    }
    this.models = kept
    return this.models.filter((entry) => entry.provider === providerId)
  }
  async setPrice(providerId: string, name: string, price: ModelPrice): Promise<ModelRecord | undefined> {
    const entry = this.models.find((candidate) => candidate.provider === providerId && candidate.model === name)
    if (entry === undefined) return undefined
    entry.price = price
    return entry
  }
}

export class MemorySettings implements ModelSettingsStore {
  target: ModelTarget | null

  constructor(target: ModelTarget | null = null) {
    this.target = target
  }

  async load(): Promise<ModelSettings> { return { target: this.target, updatedAt: null } }
  async save(target: ModelTarget): Promise<ModelSettings> { this.target = target; return { target, updatedAt: null } }
  async clear(): Promise<void> { this.target = null }
}
