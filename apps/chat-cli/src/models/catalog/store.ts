/**
 * PostgreSQL-backed provider and model catalogue.
 *
 * The catalogue is deliberately static: discovery is an explicit action that
 * writes rows, never something a request performs implicitly.
 */

import { Pool } from 'pg'
import { sharedPool } from '../../db.ts'
import { runMigrations } from '../../migrations.ts'
import type { ModelCapabilities } from '../ports.ts'
import { defaultCapabilities } from '../ports.ts'
import {
  SEED_PROVIDERS,
  type ModelPrice,
  type ModelRecord,
  type ProviderDefaults,
  type ProviderKind,
  type ProviderRecord,
} from './types.ts'


export interface ModelCatalog {
  listProviders(): Promise<ProviderRecord[]>
  getProvider(id: string): Promise<ProviderRecord | undefined>
  listModels(provider?: string): Promise<ModelRecord[]>
  replaceModels(provider: string, models: Array<Omit<ModelRecord, 'provider' | 'discoveredAt'>>): Promise<ModelRecord[]>
  /** Set or replace a model's price. Returns undefined when the model is not in the catalogue. */
  setPrice(provider: string, model: string, price: ModelPrice): Promise<ModelRecord | undefined>
  close?(): Promise<void>
}

export class PostgresModelCatalog implements ModelCatalog {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = sharedPool(connectionString)
  }

  async migrate(): Promise<void> {
    await runMigrations(this.pool)
    await this.seedProviders()
  }

  /** Built-in providers. Reference data, not schema; an operator edit is kept. */
  private async seedProviders(): Promise<void> {
    for (const provider of SEED_PROVIDERS) {
      await this.pool.query(
        `INSERT INTO model_providers (id, kind, display_name, base_url, api_key_env, headers, defaults, enabled, local)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, true, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          provider.id,
          provider.kind,
          provider.displayName,
          provider.baseUrl,
          provider.apiKeyEnv,
          JSON.stringify(provider.headers ?? {}),
          JSON.stringify(provider.defaults ?? {}),
          provider.local,
        ],
      )
    }
  }


  async listProviders(): Promise<ProviderRecord[]> {
    const result = await this.pool.query<ProviderRow>(
      `SELECT ${PROVIDER_COLUMNS} FROM model_providers ORDER BY local ASC, id ASC`,
    )
    return result.rows.map(mapProvider)
  }

  async getProvider(id: string): Promise<ProviderRecord | undefined> {
    const result = await this.pool.query<ProviderRow>(
      `SELECT ${PROVIDER_COLUMNS} FROM model_providers WHERE id = $1`,
      [id],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : mapProvider(row)
  }

  async listModels(provider?: string): Promise<ModelRecord[]> {
    const result = await this.pool.query<ModelRow>(
      `SELECT provider, model, display_name AS "displayName", context_window AS "contextWindow",
              max_output AS "maxOutput", capabilities, price, discovered_at AS "discoveredAt"
       FROM model_catalog
       ${provider === undefined ? '' : 'WHERE provider = $1'}
       ORDER BY provider ASC, model ASC`,
      provider === undefined ? [] : [provider],
    )
    return result.rows.map(mapModel)
  }

  /**
   * Sync a provider's catalogue with a discovery result.
   *
   * Models that are still present are updated in place and **keep their price**
   * (discovery never reports one, and an operator-set price must survive a
   * refresh); models that disappeared are removed; new ones are added unpriced.
   */
  async replaceModels(
    provider: string,
    models: Array<Omit<ModelRecord, 'provider' | 'discoveredAt'>>,
  ): Promise<ModelRecord[]> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'DELETE FROM model_catalog WHERE provider = $1 AND model <> ALL($2::text[])',
        [provider, models.map((entry) => entry.model)],
      )
      for (const model of models) {
        await client.query(
          `INSERT INTO model_catalog
             (provider, model, display_name, context_window, max_output, capabilities, price, discovered_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now())
           ON CONFLICT (provider, model) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             context_window = EXCLUDED.context_window,
             max_output = EXCLUDED.max_output,
             capabilities = EXCLUDED.capabilities,
             discovered_at = now(),
             price = CASE WHEN EXCLUDED.price = '{}'::jsonb THEN model_catalog.price ELSE EXCLUDED.price END`,
          [
            provider,
            model.model,
            model.displayName,
            model.contextWindow,
            model.maxOutput,
            JSON.stringify(model.capabilities),
            JSON.stringify(model.price),
          ],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
    return this.listModels(provider)
  }

  async setPrice(provider: string, model: string, price: ModelPrice): Promise<ModelRecord | undefined> {
    const result = await this.pool.query(
      `UPDATE model_catalog SET price = $3::jsonb WHERE provider = $1 AND model = $2`,
      [provider, model, JSON.stringify(price)],
    )
    if ((result.rowCount ?? 0) === 0) return undefined
    return (await this.listModels(provider)).find((entry) => entry.model === model)
  }

  async close(): Promise<void> {
    // The pool is shared and closed once at shutdown (db.closeSharedPools).
  }
}

const PROVIDER_COLUMNS = `id, kind, display_name AS "displayName", base_url AS "baseUrl",
  api_key_env AS "apiKeyEnv", headers, defaults, enabled, local,
  created_at AS "createdAt", updated_at AS "updatedAt"`

interface ProviderRow {
  id: string
  kind: ProviderKind
  displayName: string
  baseUrl: string | null
  apiKeyEnv: string | null
  headers: Record<string, string>
  defaults: ProviderDefaults
  enabled: boolean
  local: boolean
  createdAt: Date | string
  updatedAt: Date | string
}

interface ModelRow {
  provider: string
  model: string
  displayName: string | null
  contextWindow: number | null
  maxOutput: number | null
  capabilities: Partial<ModelCapabilities>
  price: ModelPrice
  discoveredAt: Date | string | null
}

function mapProvider(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    apiKeyEnv: row.apiKeyEnv,
    headers: row.headers ?? {},
    defaults: row.defaults ?? {},
    enabled: row.enabled,
    local: row.local,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }
}

function mapModel(row: ModelRow): ModelRecord {
  return {
    provider: row.provider,
    model: row.model,
    displayName: row.displayName,
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    capabilities: { ...defaultCapabilities(), ...(row.capabilities ?? {}) },
    price: row.price ?? {},
    discoveredAt: row.discoveredAt === null ? null : toIso(row.discoveredAt),
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
