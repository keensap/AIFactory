/**
 * PostgreSQL connection pools.
 *
 * Every store used to create its own pool: twelve of them, up to 46 connections
 * per API process against a server with `max_connections` 100. Two API instances
 * plus a test run exhausted the server, which showed up as intermittent,
 * load-dependent failures. Lowering test concurrency hid the symptom; this fixes
 * the cause.
 *
 * Rules:
 *  - one application pool per connection string, shared by every store;
 *  - one small, separate pool for the PostgreSQL log sink, so log back-pressure
 *    can never take connections away from requests;
 *  - stores never end a pool. `closeSharedPools()` runs at shutdown.
 *
 * Size with `AIFACTORY_DB_POOL_MAX` (default 10).
 */

import { Pool, type PoolClient } from 'pg'

const DEFAULT_POOL_MAX = 10
const LOG_POOL_MAX = 2
/** Long statements are a bug here; fail them rather than hold a connection. */
const STATEMENT_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 30_000

export interface DbPoolOptions {
  /** Overrides `AIFACTORY_DB_POOL_MAX`. */
  max?: number
  applicationName?: string
}

function poolMax(options: DbPoolOptions): number {
  if (options.max !== undefined && Number.isSafeInteger(options.max) && options.max > 0) return options.max
  const configured = Number(process.env.AIFACTORY_DB_POOL_MAX)
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_POOL_MAX
}

function create(connectionString: string, max: number, applicationName: string): Pool {
  const pool = new Pool({
    connectionString,
    max,
    application_name: applicationName,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    allowExitOnIdle: false,
  })
  // A pool error must never take the process down; the caller's query sees it.
  pool.on('error', () => {})
  return pool
}

/** Application pool, shared per connection string. */
const appPools = new Map<string, Pool>()
/** Log sink pool, kept separate and small on purpose. */
const logPools = new Map<string, Pool>()

export function sharedPool(connectionString: string, options: DbPoolOptions = {}): Pool {
  const existing = appPools.get(connectionString)
  if (existing !== undefined) return existing
  const pool = create(connectionString, poolMax(options), options.applicationName ?? 'aifactory')
  appPools.set(connectionString, pool)
  return pool
}

export function logSinkPool(connectionString: string): Pool {
  const existing = logPools.get(connectionString)
  if (existing !== undefined) return existing
  // A distinct application_name makes the two pools visible in pg_stat_activity.
  const pool = create(connectionString, LOG_POOL_MAX, 'aifactory-logs')
  logPools.set(connectionString, pool)
  return pool
}

export interface DbPoolSnapshot {
  app: Array<{ total: number; idle: number; waiting: number }>
  logs: Array<{ total: number; idle: number; waiting: number }>
}

function snapshot(pools: Map<string, Pool>): DbPoolSnapshot['app'] {
  return [...pools.values()].map((pool) => ({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  }))
}

/** Diagnostics for the health endpoint. */
export function poolSnapshot(): DbPoolSnapshot {
  return { app: snapshot(appPools), logs: snapshot(logPools) }
}

/** Total connections this process may hold; asserted in tests. */
export function poolCapacity(): { app: number; logs: number } {
  let app = 0
  let logs = 0
  for (const pool of appPools.values()) app += pool.options.max ?? 0
  for (const pool of logPools.values()) logs += pool.options.max ?? 0
  return { app, logs }
}

/** Graceful shutdown: end every pool this process opened. */
export async function closeSharedPools(): Promise<void> {
  const pools = [...appPools.values(), ...logPools.values()]
  appPools.clear()
  logPools.clear()
  await Promise.all(pools.map((pool) => pool.end().catch(() => {})))
}

/** Run `fn` inside a transaction on the shared pool. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}