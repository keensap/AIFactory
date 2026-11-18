/**
 * Routes with no resource of their own: docs, the API index, health, tool
 * discovery, filesystem browsing and the SDLC stage catalogue.
 */

import { readFileSync } from 'node:fs'
import { createProjectTools } from '../project-tools.ts'
import { listDirectories } from '../directories.ts'
import { HttpError, sendHtml, sendJson, sendText } from '../http.ts'
import { requireWorkspace } from './shared.ts'
import { route, type RouteDef } from './router.ts'

const DOCS_HTML = readFileSync(new URL('../docs.html', import.meta.url), 'utf8')
const OPENAPI_YAML = readFileSync(new URL('../../openapi.yaml', import.meta.url), 'utf8')

/** The endpoint index served at `/api`, kept as data so it reads as one list. */
const ENDPOINTS: Record<string, string> = {
  chat: 'POST /api/chat',
  stream: 'POST /api/chat/stream',
  sessions: 'GET /api/sessions',
  projects: 'GET/POST /api/projects',
  tools: 'GET /api/tools',
  settings: 'GET/PATCH /api/settings',
  directories: 'GET /api/fs/directories?path=',
  pdfReview: 'POST /api/projects/:projectId/sessions/:sessionId/pdf-review',
  sdlcStages: 'GET /api/sdlc/stages',
  stageRuns: 'GET/POST /api/projects/:id/stages/:stage/runs',
  stageRun: 'GET /api/stage-runs/:runId',
  executeStageRun: 'POST /api/stage-runs/:runId/execute',
  stageDecision: 'POST /api/stage-runs/:runId/decision',
  stageRetry: 'POST /api/stage-runs/:runId/retry',
  stageEvents: 'GET /api/stage-runs/:runId/events',
  stageEventStream: 'GET /api/stage-runs/:runId/events/stream',
  stageTelemetry: 'GET /api/stage-runs/:runId/telemetry',
  stageExport: 'POST /api/stage-runs/:runId/export',
  stageGate: 'POST /api/stage-runs/:runId/gate',
  stageSettings: 'GET/POST/PATCH/DELETE /api/projects/:id/stages/:stage/settings',
  stageDefaults: 'GET/POST/PATCH /api/settings/stages[/:stage]',
  stageCatalogue: 'GET /api/stages',
  stageReadiness: 'GET /api/projects/:id/stages/:stage/readiness',
  stageWaiver: 'POST/DELETE /api/projects/:id/stages/:stage/waivers',
  agents: 'GET/POST /api/agents',
  agent: 'GET/PATCH/DELETE /api/agents/:id',
  agentAssignments: 'GET /api/stages/:stage/assignments, PUT/DELETE /api/stages/:stage/assignments/:process',
  agentTest: 'POST /api/agents/:id/test',
  attachments: 'GET/POST /api/projects/:id/attachments',
  documentExport: 'GET /api/projects/:id/documents/:documentId/export',
  semanticIndex: 'POST /api/projects/:id/index',
  semanticSearch: 'GET /api/projects/:id/search?q=...',
  observability: 'GET /api/projects/:id/observability?hours=24',
  projectLogs: 'GET /api/projects/:id/logs?source=events|app|all&level=error&limit=100',
  projectStats: 'GET /api/projects/:id/stats?from=&to=&stage=&role=',
  appLogs: 'GET /api/logs?level=error&projectId=&requestId=&q=',
  loggingSettings: 'GET/PATCH /api/settings/logging',
  loggingAdmin: 'GET /api/admin/logging',
  loggingLevel: 'PUT /api/admin/logging/level',
  observabilityAdmin: 'GET /api/admin/observability',
  modelProviders: 'GET /api/models/providers',
  models: 'GET /api/models?provider=',
  modelDiscover: 'POST /api/models/providers/:id/discover',
  modelHealth: 'POST /api/models/providers/:id/health',
  modelTarget: 'GET/PATCH/DELETE /api/settings/models',
  modelTest: 'POST /api/models/test',
  modelUsage: 'GET /api/models/usage?days=&from=&to=',
  modelPrice: 'PUT /api/models/price',
  modelRuntime: 'GET /api/admin/models',
}

export const systemRoutes: RouteDef[] = [
  route('GET', '/', 'public', ({ response }) => { sendHtml(response, DOCS_HTML) }, 'docs'),
  route('GET', '/docs', 'public', ({ response }) => { sendHtml(response, DOCS_HTML) }, 'docs'),
  route('GET', '/docs/', 'public', ({ response }) => { sendHtml(response, DOCS_HTML) }, 'docs'),
  route('GET', '/openapi.yaml', 'public', ({ response }) => {
    sendText(response, OPENAPI_YAML, 'application/yaml; charset=utf-8')
  }, 'openapi'),

  route('GET', '/api', 'public', ({ response, options }) => {
    sendJson(response, 200, {
      name: 'AI Factory Chat API',
      version: options.version,
      docs: '/docs',
      openapi: '/openapi.yaml',
      health: '/api/health',
      endpoints: ENDPOINTS,
    })
  }, 'apiIndex'),

  // Public by design: a load balancer probes it, and it reveals no data.
  route('GET', '/api/health', 'public', ({ response, options }) => {
    sendJson(response, 200, {
      ok: true,
      version: options.version,
      uptimeSeconds: Math.round(process.uptime()),
      harness: options.harnessInfo ?? null,
      database: options.projects === undefined ? 'disabled' : 'postgres',
      // One application pool plus one small log pool (AR-12).
      ...(options.poolSnapshot !== undefined ? { pools: options.poolSnapshot() } : {}),
      ...(options.schemaVersion !== undefined ? { schema: options.schemaVersion } : {}),
    })
  }, 'health'),

  route('GET', '/api/tools', 'operator', ({ response, options }) => {
    if (options.projects === undefined) {
      throw new HttpError(503, 'project tools are disabled; set DATABASE_URL', 'DATABASE_NOT_CONFIGURED')
    }
    const tools = createProjectTools(options.projects).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }))
    sendJson(response, 200, { tools })
  }, 'listTools'),

  route('GET', '/api/sdlc/stages', 'operator', async ({ response, options }) => {
    const workspace = requireWorkspace(options)
    sendJson(response, 200, { stages: await workspace.listSdlcStages() })
  }, 'listSdlcStages'),

  route('GET', '/api/fs/directories', 'operator', async ({ response, url }) => {
    const path = url.searchParams.get('path')
    sendJson(response, 200, await listDirectories(path ?? undefined, {
      showHidden: url.searchParams.get('hidden') === '1',
    }))
  }, 'listDirectories'),
]