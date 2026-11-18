/**
 * Named agents, their stage-process assignments and the composition probe.
 */

import { HttpError, readJson, sendJson } from '../http.ts'
import { requiredParam, route, type RouteDef, type RouteContext } from './router.ts'

function agentsOf(options: RouteContext['options']) {
  const agents = options.agents
  if (agents === undefined) {
    throw new HttpError(503, 'agents are disabled; set DATABASE_URL', 'AGENTS_NOT_CONFIGURED')
  }
  return agents
}

function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null || value === '' ? undefined : value
}

export const agentRoutes: RouteDef[] = [
  route('GET', '/api/agents', 'operator', async ({ response, options }) => {
    sendJson(response, 200, { agents: await agentsOf(options).list() })
  }, 'listAgents'),

  route('POST', '/api/agents', 'admin', async ({ request, response, options }) => {
    sendJson(response, 201, { agent: await agentsOf(options).create(await readJson(request)) })
  }, 'createAgent'),

  // Probe before the generic :agentId route would claim `/test` as an id.
  route('POST', '/api/agents/:agentId/test', 'admin', async ({ params, response, url, options }) => {
    const agents = agentsOf(options)
    const probe = options.probeAgent
    if (probe === undefined) {
      throw new HttpError(503, 'agent probing is unavailable', 'AGENT_PROBE_NOT_CONFIGURED')
    }
    const mode = queryParam(url, 'mode')
    if (mode !== undefined && mode !== 'offline' && mode !== 'online') {
      throw new HttpError(400, 'mode must be "offline" or "online"', 'INVALID_PROBE_MODE')
    }
    const agent = await agents.get(requiredParam(params, 'agentId'))
    sendJson(response, 200, await probe(agent, mode === undefined ? {} : { mode }))
  }, 'testAgent'),

  route('GET', '/api/agents/:agentId', 'operator', async ({ params, response, options }) => {
    sendJson(response, 200, { agent: await agentsOf(options).get(requiredParam(params, 'agentId')) })
  }, 'getAgent'),

  route('PATCH', '/api/agents/:agentId', 'admin', async ({ request, params, response, options }) => {
    const agentId = requiredParam(params, 'agentId')
    sendJson(response, 200, { agent: await agentsOf(options).update(agentId, await readJson(request)) })
  }, 'updateAgent'),

  route('POST', '/api/agents/:agentId', 'admin', async ({ request, params, response, options }) => {
    const agentId = requiredParam(params, 'agentId')
    sendJson(response, 200, { agent: await agentsOf(options).update(agentId, await readJson(request)) })
  }, 'updateAgentPost'),

  route('DELETE', '/api/agents/:agentId', 'admin', async ({ params, response, options }) => {
    await agentsOf(options).remove(requiredParam(params, 'agentId'))
    response.writeHead(204)
    response.end()
  }, 'deleteAgent'),

  route('GET', '/api/stages/:stage/assignments', 'operator', async ({ params, response, url, options }) => {
    const stage = requiredParam(params, 'stage')
    sendJson(response, 200, {
      stage,
      assignments: await agentsOf(options).assignments(stage, queryParam(url, 'projectId')),
    })
  }, 'listAssignments'),

  route('PUT', '/api/stages/:stage/assignments/:process', 'admin', async ({ request, params, response, url, options }) => {
    sendJson(response, 200, {
      assignments: await setAssignment(request, params, url, options),
    })
  }, 'setAssignment'),

  route('POST', '/api/stages/:stage/assignments/:process', 'admin', async ({ request, params, response, url, options }) => {
    sendJson(response, 200, {
      assignments: await setAssignment(request, params, url, options),
    })
  }, 'setAssignmentPost'),

  route('DELETE', '/api/stages/:stage/assignments/:process', 'admin', async ({ params, response, url, options }) => {
    const stage = requiredParam(params, 'stage')
    const processName = requiredParam(params, 'process')
    sendJson(response, 200, {
      assignments: await agentsOf(options).clearAssignment({
        stage,
        process: processName,
        ...(queryParam(url, 'projectId') !== undefined ? { projectId: queryParam(url, 'projectId')! } : {}),
      }),
    })
  }, 'clearAssignment'),
]

async function setAssignment(
  request: RouteContext['request'],
  params: Readonly<Record<string, string>>,
  url: URL,
  options: RouteContext['options'],
): Promise<unknown> {
  const agents = agentsOf(options)
  const stage = requiredParam(params, 'stage')
  const processName = requiredParam(params, 'process')
  const body = await readJson(request)
  const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
  if (typeof record.agentId !== 'string') {
    throw new HttpError(400, 'agentId is required', 'INVALID_ASSIGNMENT')
  }
  const target = typeof record.projectId === 'string' ? record.projectId : queryParam(url, 'projectId')
  return agents.setAssignment({
    stage,
    process: processName,
    agentId: record.agentId,
    ...(target !== undefined ? { projectId: target } : {}),
  })
}