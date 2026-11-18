/**
 * Settings and stage configuration: chat limits, the model target, logging,
 * per-stage settings, the prerequisite catalogue, readiness and waivers.
 */

import type { ChatApiOptions } from '../api-options.ts'
import { HttpError, readJson, sendJson } from '../http.ts'
import type { StageSettingsService } from '../stage-settings.ts'
import type { StagePrerequisiteService } from '../stage-prerequisites.ts'
import { requireLoggingManager } from './shared.ts'
import { requiredParam, route, type RouteDef } from './router.ts'

function requireStageSettings(options: ChatApiOptions): StageSettingsService {
  const service = options.stageSettings
  if (service === undefined) {
    throw new HttpError(503, 'stage settings are disabled; set DATABASE_URL', 'STAGE_SETTINGS_NOT_CONFIGURED')
  }
  return service
}

function requirePrerequisites(options: ChatApiOptions): StagePrerequisiteService {
  const service = options.prerequisites
  if (service === undefined) {
    throw new HttpError(503, 'stage prerequisites are disabled; set DATABASE_URL', 'PREREQUISITES_NOT_CONFIGURED')
  }
  return service
}

function requireProjects(options: ChatApiOptions) {
  const projects = options.projects
  if (projects === undefined) {
    throw new HttpError(503, 'project registry is disabled; set DATABASE_URL', 'DATABASE_NOT_CONFIGURED')
  }
  return projects
}

function requireModels(options: ChatApiOptions) {
  const models = options.models
  if (models === undefined) {
    throw new HttpError(503, 'model providers are disabled; set DATABASE_URL', 'MODELS_NOT_CONFIGURED')
  }
  return models
}

export const settingsRoutes: RouteDef[] = [
  // ---- chat settings ---------------------------------------------------
  route('GET', '/api/settings', 'operator', async ({ response, options }) => {
    const settings = options.settings
    if (settings === undefined) {
      throw new HttpError(503, 'settings are disabled; set DATABASE_URL', 'SETTINGS_NOT_CONFIGURED')
    }
    sendJson(response, 200, { settings: await settings.get() })
  }, 'getSettings'),

  route('PATCH', '/api/settings', 'admin', async ({ request, response, options }) => {
    const settings = options.settings
    if (settings === undefined) {
      throw new HttpError(503, 'settings are disabled; set DATABASE_URL', 'SETTINGS_NOT_CONFIGURED')
    }
    const activeProjects = await requireProjects(options).countActive()
    sendJson(response, 200, { settings: await settings.update(await readJson(request), activeProjects) })
  }, 'updateSettings'),

  // ---- model target ----------------------------------------------------
  route('GET', '/api/settings/models', 'operator', async ({ response, options }) => {
    sendJson(response, 200, await requireModels(options).target())
  }, 'getModelTarget'),

  route('PATCH', '/api/settings/models', 'admin', async ({ request, response, options }) => {
    sendJson(response, 200, await requireModels(options).updateTarget(await readJson(request)))
  }, 'setModelTarget'),

  route('DELETE', '/api/settings/models', 'admin', async ({ response, options }) => {
    sendJson(response, 200, await requireModels(options).clearTarget())
  }, 'clearModelTarget'),

  // ---- logging settings ------------------------------------------------
  route('GET', '/api/settings/logging', 'operator', ({ response, options }) => {
    const manager = requireLoggingManager(options)
    sendJson(response, 200, { settings: manager.settings(), postgresAvailable: manager.postgresAvailable })
  }, 'getLoggingSettings'),

  route('PATCH', '/api/settings/logging', 'admin', async ({ request, response, options }) => {
    const manager = requireLoggingManager(options)
    sendJson(response, 200, {
      settings: await manager.update(await readJson(request)),
      postgresAvailable: manager.postgresAvailable,
    })
  }, 'updateLoggingSettings'),

  // ---- stage settings --------------------------------------------------
  route('GET', '/api/settings/stages', 'operator', async ({ response, options }) => {
    sendJson(response, 200, { stages: await requireStageSettings(options).factoryDefaults() })
  }, 'listStageDefaults'),

  route('GET', '/api/settings/stages/:stage', 'operator', async ({ params, response, options }) => {
    const stage = requiredParam(params, 'stage')
    sendJson(response, 200, { stage, settings: await requireStageSettings(options).factoryDefaultFor(stage) })
  }, 'getStageDefault'),

  route('PATCH', '/api/settings/stages/:stage', 'admin', async ({ request, params, response, options }) => {
    const stage = requiredParam(params, 'stage')
    sendJson(response, 200, {
      stage,
      settings: await requireStageSettings(options).updateFactoryDefaults(stage, await readJson(request)),
    })
  }, 'updateStageDefault'),

  route('POST', '/api/settings/stages/:stage', 'admin', async ({ request, params, response, options }) => {
    const stage = requiredParam(params, 'stage')
    sendJson(response, 200, {
      stage,
      settings: await requireStageSettings(options).updateFactoryDefaults(stage, await readJson(request)),
    })
  }, 'updateStageDefaultPost'),

  // Deprecated alias for the planning defaults, kept for existing clients.
  route('GET', '/api/settings/stage-defaults', 'operator', async ({ response, options }) => {
    sendJson(response, 200, { stageDefaults: await requireStageSettings(options).factoryDefaultFor('planning') })
  }, 'getPlanningDefaultsAlias'),

  route('PATCH', '/api/settings/stage-defaults', 'admin', async ({ request, response, options }) => {
    sendJson(response, 200, {
      stageDefaults: await requireStageSettings(options).updateFactoryDefaults('planning', await readJson(request)),
    })
  }, 'updatePlanningDefaultsAlias'),

  route('POST', '/api/settings/stage-defaults', 'admin', async ({ request, response, options }) => {
    sendJson(response, 200, {
      stageDefaults: await requireStageSettings(options).updateFactoryDefaults('planning', await readJson(request)),
    })
  }, 'updatePlanningDefaultsAliasPost'),

  // ---- project stage settings -----------------------------------------
  route('GET', '/api/projects/:id/stages/:stage/settings', 'operator', async ({ params, response, options }) => {
    const service = requireStageSettings(options)
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    sendJson(response, 200, await service.resolve(id, requiredParam(params, 'stage')))
  }, 'getProjectStageSettings'),

  route('PATCH', '/api/projects/:id/stages/:stage/settings', 'admin', async ({ request, params, response, options }) => {
    const service = requireStageSettings(options)
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    sendJson(response, 200, await service.setProject(id, requiredParam(params, 'stage'), await readJson(request)))
  }, 'setProjectStageSettings'),

  route('POST', '/api/projects/:id/stages/:stage/settings', 'admin', async ({ request, params, response, options }) => {
    const service = requireStageSettings(options)
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    sendJson(response, 200, await service.setProject(id, requiredParam(params, 'stage'), await readJson(request)))
  }, 'setProjectStageSettingsPost'),

  route('DELETE', '/api/projects/:id/stages/:stage/settings', 'admin', async ({ params, response, options }) => {
    const service = requireStageSettings(options)
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    sendJson(response, 200, await service.setProject(id, requiredParam(params, 'stage'), null))
  }, 'clearProjectStageSettings'),

  // ---- prerequisite catalogue, readiness and waivers ------------------
  route('GET', '/api/stages', 'operator', async ({ response, options }) => {
    sendJson(response, 200, { stages: await requirePrerequisites(options).catalogue() })
  }, 'listStageCatalogue'),

  // Editing the catalogue itself, not the evidence (AR-13).
  route('PUT', '/api/stages/:stage/prerequisites/:key', 'admin', async ({ request, params, response, options }) => {
    sendJson(response, 200, {
      prerequisite: await requirePrerequisites(options).saveCatalogueEntry(
        requiredParam(params, 'stage'),
        requiredParam(params, 'key'),
        await readJson(request),
      ),
    })
  }, 'savePrerequisite'),

  route('DELETE', '/api/stages/:stage/prerequisites/:key', 'admin', async ({ params, response, options }) => {
    await requirePrerequisites(options).removeCatalogueEntry(
      requiredParam(params, 'stage'),
      requiredParam(params, 'key'),
    )
    response.writeHead(204).end()
  }, 'removePrerequisite'),

  route('GET', '/api/projects/:id/stages/:stage/readiness', 'operator', async ({ params, response, options }) => {
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    sendJson(response, 200, await requirePrerequisites(options).readiness(id, requiredParam(params, 'stage')))
  }, 'getStageReadiness'),

  route('POST', '/api/projects/:id/stages/:stage/waivers', 'admin', async ({ request, params, response, options }) => {
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    const body = await readJson(request)
    const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
    if (typeof record.key !== 'string' || typeof record.reason !== 'string') {
      throw new HttpError(400, 'key and reason are required', 'INVALID_WAIVER')
    }
    sendJson(response, 200, await requirePrerequisites(options).waive({
      projectId: id,
      stage: requiredParam(params, 'stage'),
      key: record.key,
      reason: record.reason,
    }))
  }, 'waivePrerequisite'),

  route('DELETE', '/api/projects/:id/stages/:stage/waivers/:key', 'admin', async ({ params, response, options }) => {
    const id = requiredParam(params, 'id')
    await requireProjects(options).get(id)
    sendJson(response, 200, await requirePrerequisites(options).unwaive(
      id,
      requiredParam(params, 'stage'),
      requiredParam(params, 'key'),
    ))
  }, 'removeWaiver'),
]