/**
 * Model providers, the catalogue, discovery, health probes, pricing and usage.
 */

import type { ChatApiOptions } from '../api-options.ts'
import { HttpError, readJson, sendJson, statsRangeFromQuery } from '../http.ts'
import { requireWorkspace } from './shared.ts'
import { requiredParam, route, type RouteDef } from './router.ts'

function requireModels(options: ChatApiOptions) {
  const models = options.models
  if (models === undefined) {
    throw new HttpError(503, 'model providers are disabled; set DATABASE_URL', 'MODELS_NOT_CONFIGURED')
  }
  return models
}

export const modelRoutes: RouteDef[] = [
  // Cross-project spend report: independent of the catalogue, so it is checked
  // before the catalogue requirement.
  route('GET', '/api/models/usage', 'admin', async ({ url, response, options }) => {
    sendJson(response, 200, { usage: await requireWorkspace(options).modelUsage(statsRangeFromQuery(url.searchParams)) })
  }, 'modelUsage'),

  route('GET', '/api/models', 'operator', async ({ url, response, options }) => {
    const provider = url.searchParams.get('provider') ?? undefined
    sendJson(response, 200, { models: await requireModels(options).models(provider) })
  }, 'listModels'),

  route('GET', '/api/models/providers', 'operator', async ({ response, options }) => {
    sendJson(response, 200, { providers: await requireModels(options).providers() })
  }, 'listProviders'),

  route('POST', '/api/models/providers/:id/discover', 'admin', async ({ params, response, options }) => {
    sendJson(response, 200, { discovery: await requireModels(options).discover(requiredParam(params, 'id')) })
  }, 'discoverModels'),

  route('POST', '/api/models/providers/:id/health', 'admin', async ({ params, response, options }) => {
    sendJson(response, 200, { health: await requireModels(options).health(requiredParam(params, 'id')) })
  }, 'providerHealth'),

  route('POST', '/api/models/test', 'admin', async ({ request, response, options }) => {
    sendJson(response, 200, { test: await requireModels(options).test(await readJson(request)) })
  }, 'testModel'),

  route('PUT', '/api/models/price', 'admin', async ({ request, response, options }) => {
    const models = requireModels(options)
    const body = await readJson(request)
    const record = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
    if (typeof record.provider !== 'string' || typeof record.model !== 'string') {
      throw new HttpError(400, 'provider and model are required', 'INVALID_PRICE')
    }
    const { provider, model, ...price } = record
    sendJson(response, 200, { model: await models.setPrice(provider, model, price) })
  }, 'setModelPrice'),

  // ---- admin: runtime state and circuit breakers ----------------------
  route('GET', '/api/admin/models', 'admin', ({ response, options }) => {
    const runtime = options.modelRuntime
    if (runtime === undefined) {
      throw new HttpError(503, 'model runtime is disabled; set DATABASE_URL', 'MODELS_NOT_CONFIGURED')
    }
    sendJson(response, 200, { models: runtime.status() })
  }, 'modelRuntimeStatus'),

  route('POST', '/api/admin/models/providers/:id/reset', 'admin', async ({ params, response, options }) => {
    sendJson(response, 200, await requireModels(options).resetBreaker(requiredParam(params, 'id')))
  }, 'resetProviderBreaker'),
]