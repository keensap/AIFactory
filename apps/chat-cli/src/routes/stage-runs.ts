/**
 * Stage runs: reading a run, its reviews, events and telemetry, and the actions
 * that move it (execute, gate, decision, retry, export).
 *
 * Creating and listing a project's runs lives here too: they are run operations
 * that happen to be addressed under a project.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChatApiOptions } from '../api-options.ts'
import { HttpError, readJson, sendJson } from '../http.ts'
import { RunTelemetryFolder, telemetryFromEvents } from '../telemetry.ts'
import type { ProjectStage } from '../sdlc.ts'
import type { PostgresProjectWorkspace, StageRunEvent } from '../workspace.ts'
import { requireWorkspace } from './shared.ts'
import { requiredParam, route, type RouteDef, type RouteContext } from './router.ts'

function requireRuntime(options: ChatApiOptions) {
  const runtime = options.stageRuntime
  if (runtime === undefined) {
    throw new HttpError(503, 'stage runtime is disabled', 'STAGE_RUNTIME_DISABLED')
  }
  return runtime
}

function requireWorkspaceOr503(options: ChatApiOptions): PostgresProjectWorkspace {
  if (options.workspace === undefined) {
    throw new HttpError(503, 'project workspace is disabled', 'WORKSPACE_NOT_CONFIGURED')
  }
  return options.workspace
}

async function assertRunExists(workspace: PostgresProjectWorkspace, runId: string): Promise<void> {
  if (await workspace.getStageRun(runId) === undefined) {
    throw new HttpError(404, 'stage run not found', 'STAGE_RUN_NOT_FOUND')
  }
}

/**
 * Page through a run's stored events.
 *
 * `upTo` stops at an id (used to seed a reconnecting stream with exactly the
 * events it has already seen); `maxEvents` bounds memory for very long runs.
 */
export async function readRunEvents(
  workspace: PostgresProjectWorkspace,
  runId: string,
  options: { upTo?: string; maxEvents?: number } = {},
): Promise<StageRunEvent[]> {
  const maxEvents = options.maxEvents ?? 20_000
  const upTo = options.upTo === undefined || options.upTo === '0' ? undefined : Number(options.upTo)
  const events: StageRunEvent[] = []
  let cursor = '0'
  while (events.length < maxEvents) {
    const page = await workspace.listStageRunEvents(runId, cursor, 1000)
    if (page.length === 0) break
    for (const event of page) {
      if (upTo !== undefined && Number(event.id) > upTo) return events
      events.push(event)
    }
    cursor = page[page.length - 1]!.id
    if (page.length < 1000) break
  }
  return events
}

export async function streamStageEvents(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runId: string,
  workspace: PostgresProjectWorkspace,
): Promise<void> {
  if (await workspace.getStageRun(runId) === undefined) {
    throw new HttpError(404, 'stage run not found', 'STAGE_RUN_NOT_FOUND')
  }

  const header = request.headers['last-event-id']
  const headerValue = Array.isArray(header) ? header[0] : header
  let after = headerValue ?? url.searchParams.get('after') ?? '0'
  let closed = false
  let polling = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined

  const cleanup = (): void => {
    if (closed) return
    closed = true
    if (pollTimer !== undefined) clearInterval(pollTimer)
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders?.()
  response.on('close', cleanup)

  const writeEvent = (event: Awaited<ReturnType<PostgresProjectWorkspace['listStageRunEvents']>>[number]): void => {
    response.write(`id: ${event.id}\nevent: stage\ndata: ${JSON.stringify(event)}\n\n`)
    after = event.id
  }

  // Telemetry is folded from the same events the client receives, seeded with
  // whatever it has already seen, so live and reloaded numbers always agree.
  const folder = new RunTelemetryFolder()
  try {
    for (const event of await readRunEvents(workspace, runId, { upTo: after })) {
      folder.add(event.payload, Date.parse(event.createdAt) || undefined)
    }
  } catch {
    // A seed failure only means the bar starts from zero; streaming continues.
  }
  const sendTelemetry = (): void => {
    if (closed) return
    response.write(`event: telemetry\ndata: ${JSON.stringify(folder.snapshot())}\n\n`)
  }
  sendTelemetry()

  const poll = async (): Promise<void> => {
    if (closed || polling) return
    polling = true
    let changed = false
    try {
      const events = await workspace.listStageRunEvents(runId, after, 1000)
      for (const event of events) {
        if (closed) return
        writeEvent(event)
        if (folder.add(event.payload, Date.parse(event.createdAt) || undefined)) changed = true
      }
      if (changed) sendTelemetry()
      const run = await workspace.getStageRun(runId)
      if (run !== undefined && ['completed', 'failed', 'cancelled'].includes(run.status) && events.length === 0) {
        if (!closed) {
          response.write('event: end\ndata: {}\n\n')
          cleanup()
          response.end()
        }
      }
    } catch {
      if (!closed) {
        response.write('event: error\ndata: {"message":"event stream failed"}\n\n')
        cleanup()
        response.end()
      }
    } finally {
      polling = false
    }
  }

  pollTimer = setInterval(() => { void poll() }, 500)
  heartbeatTimer = setInterval(() => {
    if (!closed) response.write(': keepalive\n\n')
  }, 15_000)
  void poll()
}
export const stageRunRoutes: RouteDef[] = [
  // ---- creating and listing a project's runs --------------------------
  route('GET', '/api/projects/:id/stages/:stage/runs', 'operator', async ({ params, response, options }) => {
    const workspace = requireWorkspace(options)
    const runs = await workspace.listStageRuns(requiredParam(params, 'id'), requiredParam(params, 'stage') as ProjectStage)
    sendJson(response, 200, { runs })
  }, 'listStageRuns'),

  route('POST', '/api/projects/:id/stages/:stage/runs', 'operator', async ({ request, params, response, options }) => {
    const runtime = requireRuntime(options)
    const body = await readJson(request)
    const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
    const attachmentIds = record.attachmentIds
    if (attachmentIds !== undefined
      && (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== 'string'))) {
      throw new HttpError(400, '"attachmentIds" must be an array of attachment ids', 'INVALID_ATTACHMENTS')
    }
    if (record.brief !== undefined && typeof record.brief !== 'string') {
      throw new HttpError(400, '"brief" must be a string', 'INVALID_BRIEF')
    }
    const run = await runtime.start({
      projectId: requiredParam(params, 'id'),
      stage: requiredParam(params, 'stage') as ProjectStage,
      ...(typeof record.brief === 'string' ? { brief: record.brief } : {}),
      ...(Array.isArray(attachmentIds) ? { attachmentIds: attachmentIds as string[] } : {}),
    })
    sendJson(response, 201, { run })
  }, 'createStageRun'),

  // ---- reading a run --------------------------------------------------
  route('GET', '/api/stage-runs/:runId', 'operator', async ({ params, response, options }) => {
    sendJson(response, 200, { run: await requireRuntime(options).get(requiredParam(params, 'runId')) })
  }, 'getStageRun'),

  route('GET', '/api/stage-runs/:runId/reviews', 'operator', async ({ params, response, options }) => {
    // The runtime gate comes first, as it did when all stage-run routes were one
    // handler: a deployment without a runtime answers 503 for every one of them.
    requireRuntime(options)
    const workspace = requireWorkspaceOr503(options)
    sendJson(response, 200, { reviews: await workspace.listStageReviews(requiredParam(params, 'runId')) })
  }, 'listStageRunReviews'),

  route('GET', '/api/stage-runs/:runId/events', 'operator', async ({ params, url, response, options }) => {
    requireRuntime(options)
    const workspace = requireWorkspaceOr503(options)
    const runId = requiredParam(params, 'runId')
    await assertRunExists(workspace, runId)
    const after = url.searchParams.get('after') ?? '0'
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10) || 200
    const events = await workspace.listStageRunEvents(runId, after, limit)
    sendJson(response, 200, { events, nextAfter: events.at(-1)?.id ?? after })
  }, 'listStageRunEvents'),

  route('GET', '/api/stage-runs/:runId/telemetry', 'operator', async ({ params, response, options }) => {
    requireRuntime(options)
    const workspace = requireWorkspaceOr503(options)
    const runId = requiredParam(params, 'runId')
    await assertRunExists(workspace, runId)
    sendJson(response, 200, { telemetry: telemetryFromEvents(await readRunEvents(workspace, runId)) })
  }, 'stageRunTelemetry'),

  // Registered after `/events` because it is longer; the matcher compares segment
  // counts, so order only matters within one length.
  route('GET', '/api/stage-runs/:runId/events/stream', 'operator', async ({ request, params, response, url, options }) => {
    requireRuntime(options)
    const workspace = requireWorkspaceOr503(options)
    await streamStageEvents(request, response, url, requiredParam(params, 'runId'), workspace)
  }, 'streamStageRunEvents'),

  // ---- acting on a run ------------------------------------------------
  route('POST', '/api/stage-runs/:runId/export', 'operator', async ({ params, response, options }) => {
    sendJson(response, 200, { export: await requireRuntime(options).exportRun(requiredParam(params, 'runId')) })
  }, 'exportStageRun'),

  route('POST', '/api/stage-runs/:runId/execute', 'operator', async ({ params, url, response, options }) => {
    const runtime = requireRuntime(options)
    const runId = requiredParam(params, 'runId')
    if (url.searchParams.get('wait') === '1') {
      sendJson(response, 200, { run: await runtime.execute(runId) })
      return
    }
    // Fire and forget: the client polls or streams. A failure is recorded on the
    // run, so swallowing it here loses nothing.
    void runtime.execute(runId).catch(() => {})
    sendJson(response, 202, { run: await runtime.get(runId) })
  }, 'executeStageRun'),

  route('POST', '/api/stage-runs/:runId/gate', 'operator', async ({ request, params, response, options }) => {
    const runtime = requireRuntime(options)
    const body = await readJson(request)
    const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
    if (record.action !== 'apply' && record.action !== 'accept') {
      throw new HttpError(400, 'action must be "apply" or "accept"', 'INVALID_GATE_ACTION')
    }
    sendJson(response, 200, { run: await runtime.answerGate(requiredParam(params, 'runId'), record.action) })
  }, 'answerStageGate'),

  route('POST', '/api/stage-runs/:runId/retry', 'admin', async ({ params, response, options }) => {
    // Explicit retry of a failed run: it resumes from stored analysis and draft (AR-04).
    sendJson(response, 200, { run: await requireRuntime(options).retry(requiredParam(params, 'runId')) })
  }, 'retryStageRun'),

  route('POST', '/api/stage-runs/:runId/decision', 'operator', async ({ request, params, response, options }) => {
    const runtime = requireRuntime(options)
    const runId = requiredParam(params, 'runId')
    const body = await readJson(request)
    const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
    if (record.refine === true) {
      sendJson(response, 200, { run: await runtime.decide(runId, { refine: true }) })
      return
    }
    const decision = record.decision
    if (decision !== 'go' && decision !== 'conditional_go' && decision !== 'no_go') {
      throw new HttpError(400, 'decision must be go, conditional_go or no_go when refine is false', 'INVALID_HUMAN_DECISION')
    }
    sendJson(response, 200, {
      run: await runtime.decide(runId, {
        decision,
        ...(typeof record.note === 'string' ? { note: record.note } : {}),
      }),
    })
  }, 'decideStageRun'),
]

void (null as unknown as RouteContext)
