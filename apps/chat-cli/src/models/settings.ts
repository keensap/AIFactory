/**
 * Global model target.
 *
 * The whole Factory uses one target: every project and every stage. There is no
 * per-project or per-stage override in this iteration. The target is resolved
 * from settings, then environment, then "unconfigured".
 */

import { Pool } from 'pg'
import { sharedPool } from '../db.ts'
import type { ModelCatalog } from './catalog/store.ts'
import type { ModelRecord, ProviderRecord } from './catalog/types.ts'

export interface TargetRef {
  provider: string
  model: string
}

export interface ModelTarget extends TargetRef {
  temperature?: number
  maxTokens?: number
  reasoningEffort?: string
  fallback: TargetRef[]
}

export interface ModelSettings {
  target: ModelTarget | null
  updatedAt: string | null
}

export type TargetSource = 'settings' | 'environment' | 'unconfigured'

export interface ResolvedTarget {
  target: ModelTarget | null
  source: TargetSource
  warnings: string[]
  updatedAt: string | null
}

export const MAX_FALLBACK = 4
export const MAX_TOKENS_LIMIT = 200_000

export class ModelSettingsError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ModelSettingsError'
    this.status = status
    this.code = code
  }
}

export interface ModelSettingsStore {
  load(): Promise<ModelSettings>
  save(target: ModelTarget): Promise<ModelSettings>
  /** Remove the stored target so resolution falls back to the environment. */
  clear(): Promise<void>
  close?(): Promise<void>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new ModelSettingsError(400, 'INVALID_TARGET', `${name} must be a non-empty string (max ${max})`)
  }
  return value.trim()
}

function optionalNumber(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ModelSettingsError(400, 'INVALID_TARGET', `${name} must be a number between ${min} and ${max}`)
  }
  return value
}

/** Credential presence without ever returning the value. */
export function credentialPresent(provider: ProviderRecord, env: Record<string, string | undefined>): boolean {
  if (provider.local) return true
  if (provider.apiKeyEnv === null) return true
  const value = env[provider.apiKeyEnv]
  return value !== undefined && value.trim() !== ''
}

function checkProvider(provider: ProviderRecord | undefined, id: string): ProviderRecord {
  if (provider === undefined) {
    throw new ModelSettingsError(400, 'PROVIDER_NOT_FOUND', `unknown provider "${id}"`)
  }
  if (!provider.enabled) {
    throw new ModelSettingsError(400, 'PROVIDER_DISABLED', `provider "${id}" is disabled`)
  }
  return provider
}

function checkModel(models: ModelRecord[], provider: ProviderRecord, model: string): void {
  // An empty catalogue means discovery has not run yet; accept the model and
  // let the engine surface an unknown-model error at call time.
  if (models.length === 0) return
  if (!models.some((entry) => entry.model === model)) {
    throw new ModelSettingsError(
      400,
      'MODEL_NOT_FOUND',
      `model "${model}" is not in the ${provider.id} catalogue; run discovery first`,
    )
  }
}

/** Validate a target against the catalogue. Throws `ModelSettingsError`. */
export function validateTarget(
  input: unknown,
  catalog: { providers: ProviderRecord[]; models: ModelRecord[] },
): ModelTarget {
  if (!isPlainObject(input)) throw new ModelSettingsError(400, 'INVALID_BODY', 'request body must be a JSON object')
  if (input.provider === undefined || input.model === undefined) {
    throw new ModelSettingsError(400, 'INVALID_TARGET', 'provider and model are required')
  }
  const providerId = requiredString(input.provider, 'provider', 64)
  const model = requiredString(input.model, 'model', 200)
  const provider = checkProvider(catalog.providers.find((entry) => entry.id === providerId), providerId)
  const providerModels = catalog.models.filter((entry) => entry.provider === providerId)
  checkModel(providerModels, provider, model)

  const target: ModelTarget = {
    provider: providerId,
    model,
    fallback: [],
  }
  const temperature = optionalNumber(input.temperature, 'temperature', 0, 2)
  if (temperature !== undefined) target.temperature = temperature
  const maxTokens = optionalNumber(input.maxTokens, 'maxTokens', 1, MAX_TOKENS_LIMIT)
  if (maxTokens !== undefined) target.maxTokens = Math.floor(maxTokens)
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== null) {
    target.reasoningEffort = requiredString(input.reasoningEffort, 'reasoningEffort', 32)
  }

  if (input.fallback !== undefined) {
    if (!Array.isArray(input.fallback)) {
      throw new ModelSettingsError(400, 'INVALID_FALLBACK', 'fallback must be an array')
    }
    if (input.fallback.length > MAX_FALLBACK) {
      throw new ModelSettingsError(400, 'INVALID_FALLBACK', `fallback accepts at most ${MAX_FALLBACK} entries`)
    }
    const seen = new Set<string>([`${providerId}:${model}`])
    for (const entry of input.fallback) {
      if (!isPlainObject(entry)) throw new ModelSettingsError(400, 'INVALID_FALLBACK', 'fallback entries must be objects')
      const refProvider = requiredString(entry.provider, 'fallback.provider', 64)
      const refModel = requiredString(entry.model, 'fallback.model', 200)
      const ref = checkProvider(catalog.providers.find((candidate) => candidate.id === refProvider), refProvider)
      checkModel(catalog.models.filter((candidate) => candidate.provider === refProvider), ref, refModel)
      const key = `${refProvider}:${refModel}`
      if (seen.has(key)) {
        throw new ModelSettingsError(400, 'INVALID_FALLBACK', `duplicate fallback entry ${key}`)
      }
      seen.add(key)
      target.fallback.push({ provider: refProvider, model: refModel })
    }
  }
  return target
}

/** Non-fatal problems with a target, e.g. a missing API key. */
export function targetWarnings(
  target: ModelTarget,
  catalog: { providers: ProviderRecord[]; models: ModelRecord[] },
  env: Record<string, string | undefined>,
): string[] {
  const warnings: string[] = []
  for (const ref of [target, ...target.fallback]) {
    const provider = catalog.providers.find((entry) => entry.id === ref.provider)
    if (provider === undefined) continue
    if (!credentialPresent(provider, env)) {
      warnings.push(`${provider.apiKeyEnv} is not set; ${provider.id} cannot be called`)
    }
    const models = catalog.models.filter((entry) => entry.provider === provider.id)
    if (models.length === 0) {
      warnings.push(`the ${provider.id} catalogue is empty; run discovery to list models`)
    }
  }
  return [...new Set(warnings)]
}

/** Build a target from environment variables, if configured. */
export function targetFromEnvironment(env: Record<string, string | undefined>): ModelTarget | null {
  const provider = env.AIFACTORY_MODEL_PROVIDER?.trim()
  const model = env.AIFACTORY_MODEL?.trim()
  if (provider === undefined || provider === '' || model === undefined || model === '') return null
  const target: ModelTarget = { provider, model, fallback: [] }
  const temperature = Number(env.AIFACTORY_MODEL_TEMPERATURE)
  if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) target.temperature = temperature
  const maxTokens = Number(env.AIFACTORY_MODEL_MAX_TOKENS)
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0 && maxTokens <= MAX_TOKENS_LIMIT) target.maxTokens = maxTokens
  const effort = env.AIFACTORY_MODEL_REASONING_EFFORT?.trim()
  if (effort !== undefined && effort !== '') target.reasoningEffort = effort
  const fallback = env.AIFACTORY_MODEL_FALLBACK?.trim()
  if (fallback !== undefined && fallback !== '') {
    for (const entry of fallback.split(',').slice(0, MAX_FALLBACK)) {
      const [refProvider, ...rest] = entry.split(':')
      const refModel = rest.join(':').trim()
      if (refProvider !== undefined && refProvider.trim() !== '' && refModel !== '') {
        target.fallback.push({ provider: refProvider.trim(), model: refModel })
      }
    }
  }
  return target
}

export class PostgresModelSettingsStore implements ModelSettingsStore {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = sharedPool(connectionString)
  }

  async load(): Promise<ModelSettings> {
    const result = await this.pool.query<{ value: unknown; updatedAt: Date | string }>(
      `SELECT value, updated_at AS "updatedAt" FROM settings WHERE key = 'models'`,
    )
    const row = result.rows[0]
    if (row === undefined) return { target: null, updatedAt: null }
    const at = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date(row.updatedAt).toISOString()
    return { target: normalizeStoredTarget(row.value), updatedAt: at }
  }

  async save(target: ModelTarget): Promise<ModelSettings> {
    const value = {
      provider: target.provider,
      model: target.model,
      ...(target.temperature !== undefined ? { temperature: target.temperature } : {}),
      ...(target.maxTokens !== undefined ? { maxTokens: target.maxTokens } : {}),
      ...(target.reasoningEffort !== undefined ? { reasoningEffort: target.reasoningEffort } : {}),
      fallback: target.fallback,
    }
    const result = await this.pool.query<{ updatedAt: Date | string }>(
      `INSERT INTO settings (key, value, updated_at) VALUES ('models', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING updated_at AS "updatedAt"`,
      [JSON.stringify(value)],
    )
    const at = result.rows[0]!.updatedAt
    return {
      target,
      updatedAt: at instanceof Date ? at.toISOString() : new Date(at).toISOString(),
    }
  }

  async clear(): Promise<void> {
    await this.pool.query(`DELETE FROM settings WHERE key = 'models'`)
  }

  async close(): Promise<void> {
    // The pool is shared and closed once at shutdown (db.closeSharedPools).
  }
}

/** Tolerant parse of a stored target; invalid rows behave as "unconfigured". */
export function normalizeStoredTarget(value: unknown): ModelTarget | null {
  if (!isPlainObject(value)) return null
  if (typeof value.provider !== 'string' || typeof value.model !== 'string') return null
  const target: ModelTarget = { provider: value.provider, model: value.model, fallback: [] }
  if (typeof value.temperature === 'number') target.temperature = value.temperature
  if (typeof value.maxTokens === 'number') target.maxTokens = value.maxTokens
  if (typeof value.reasoningEffort === 'string') target.reasoningEffort = value.reasoningEffort
  if (Array.isArray(value.fallback)) {
    for (const entry of value.fallback) {
      if (isPlainObject(entry) && typeof entry.provider === 'string' && typeof entry.model === 'string') {
        target.fallback.push({ provider: entry.provider, model: entry.model })
      }
    }
  }
  return target
}

/**
 * Resolve the target for a run: settings, then environment, then unconfigured.
 * The result is a snapshot; changing it later never affects a running stage.
 */
export async function resolveTarget(
  store: ModelSettingsStore,
  env: Record<string, string | undefined>,
  catalog: { providers: ProviderRecord[]; models: ModelRecord[] },
): Promise<ResolvedTarget> {
  const settings = await store.load()
  if (settings.target !== null) {
    return {
      target: settings.target,
      source: 'settings',
      warnings: targetWarnings(settings.target, catalog, env),
      updatedAt: settings.updatedAt,
    }
  }
  const fromEnv = targetFromEnvironment(env)
  if (fromEnv !== null) {
    return {
      target: fromEnv,
      source: 'environment',
      warnings: targetWarnings(fromEnv, catalog, env),
      updatedAt: null,
    }
  }
  return { target: null, source: 'unconfigured', warnings: [], updatedAt: null }
}
