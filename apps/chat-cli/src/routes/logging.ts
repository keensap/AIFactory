/**
 * Application logs, the logging control plane and observability health.
 */

import type { Level } from '../logging/index.ts'
import { HttpError, optionalParams, readJson, sendJson } from '../http.ts'
import { requireLogStore, requireLoggingManager } from './shared.ts'
import { route, type RouteDef } from './router.ts'

export const loggingRoutes: RouteDef[] = [
  route('GET', '/api/logs', 'operator', async ({ url, response, options }) => {
    const store = requireLogStore(options)
    const query = url.searchParams
    const limit = Number.parseInt(query.get('limit') ?? '100', 10)
    sendJson(response, 200, {
      ...(await store.list({
        limit: Number.isSafeInteger(limit) ? limit : 100,
        ...optionalParams(query, [
          'before', 'level', 'minLevel', 'event', 'component', 'projectId',
          'stageRunId', 'requestId', 'role', 'q', 'from', 'to',
        ]),
      })),
      postgresEnabled: options.loggingManager?.view().postgresActive ?? false,
    })
  }, 'listLogs'),

  route('GET', '/api/admin/logging', 'admin', ({ response, options }) => {
    sendJson(response, 200, { logging: requireLoggingManager(options).view() })
  }, 'loggingStatus'),

  route('PUT', '/api/admin/logging/level', 'admin', async ({ request, response, options }) => {
    const manager = requireLoggingManager(options)
    const body = await readJson(request)
    const record = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined
    if (record === undefined) throw new HttpError(400, 'request body must be a JSON object', 'INVALID_BODY')
    if (!('level' in record)) throw new HttpError(400, '"level" is required (use null to clear)', 'INVALID_LOG_LEVEL')
    const levels = manager.setRuntimeLevel({
      level: record.level as Level | null,
      ...(record.ttlSeconds !== undefined ? { ttlSeconds: record.ttlSeconds as number } : {}),
      ...(record.component !== undefined ? { component: String(record.component) } : {}),
    })
    sendJson(response, 200, { levels })
  }, 'setLoggingLevel'),

  route('GET', '/api/admin/observability', 'admin', ({ response, options }) => {
    const reader = options.observability
    if (reader === undefined) throw new HttpError(503, 'observability is disabled', 'OBSERVABILITY_DISABLED')
    sendJson(response, 200, { observability: reader.health() })
  }, 'observabilityHealth'),
]