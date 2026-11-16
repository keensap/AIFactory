import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DshHarness } from '../src/harness.ts'
import { createChatServer, serverPort } from '../src/server.ts'
import { SessionStore } from '../src/store.ts'
import type { RunTelemetry } from '../src/telemetry.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'

const USAGE_SCRIPT = fileURLToPath(new URL('./support/usage-dsh.mjs', import.meta.url))
const USAGE = { inputTokens: 2_000, outputTokens: 1_000, totalTokens: 3_000, cacheReadTokens: 8_000, cacheWriteTokens: 0 }
const MODEL = { provider: 'anthropic', model: 'claude-sonnet-4-5' }

function harnessWithUsage(): DshHarness {
  return new DshHarness({
    command: process.execPath,
    commandArgs: [USAGE_SCRIPT],
    profile: 'headless',
    timeoutMs: 20_000,
    env: { USAGE: JSON.stringify(USAGE) },
  })
}

/** Parse an SSE body into `{ event, data }` records. */
function parseSse(text: string): Array<{ event: string; data: unknown }> {
  return text.split('\n\n').flatMap((block) => {
    const lines = block.split('\n')
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7)
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6)
    if (event === undefined || data === undefined) return []
    try {
      return [{ event, data: JSON.parse(data) as unknown }]
    } catch {
      return []
    }
  })
}

async function withApi(
  options: { workspace?: unknown; modelRuntime?: unknown; stageRuntime?: boolean },
  run: (base: string) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-telemetry-'))
  const server = createChatServer({
    harnessFactory: () => harnessWithUsage(),
    store: new SessionStore({ dataDir }),
    version: 'test',
    ...(options.workspace !== undefined ? { workspace: options.workspace as never } : {}),
    ...(options.modelRuntime !== undefined ? { modelRuntime: options.modelRuntime as never } : {}),
    // Stage routes sit behind the stage-runtime guard, like the sibling events route.
    ...(options.stageRuntime === false ? {} : { stageRuntime: { get: async (id: string) => ({ id }) } as never }),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    await run(`http://127.0.0.1:${serverPort(server)}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  }
}

test('the chat stream forwards usage and emits telemetry', async () => {
  await withApi({}, async (base) => {
    const response = await fetch(`${base}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    assert.equal(response.status, 200)
    const events = parseSse(await response.text())

    const statuses = events.filter((event) => event.event === 'status')
    const withUsage = statuses.filter((event) => (event.data as { usage?: unknown }).usage !== undefined)
    assert.equal(withUsage.length, 1, 'the step_end usage reaches the client')
    assert.deepEqual((withUsage[0]!.data as { usage: unknown }).usage, USAGE)

    const telemetry = events.filter((event) => event.event === 'telemetry')
    assert.ok(telemetry.length >= 1, 'telemetry is emitted')
    const last = telemetry.at(-1)!.data as RunTelemetry
    assert.equal(last.turns, 1)
    assert.equal(last.steps, 1)
    assert.deepEqual(last.usage, { input: 2_000, output: 1_000, total: 3_000, cacheRead: 8_000, cacheWrite: 0 })
    assert.equal(last.cacheHitPercent, 80, '8000 of 10000 prompt tokens served from cache')
    assert.equal(last.contextUsedTokens, 10_000)
    assert.equal(last.model, null, 'no model runtime is configured in this test')
    const done = events.findIndex((event) => event.event === 'done')
    const lastTelemetry = events.findLastIndex((event) => event.event === 'telemetry')
    assert.ok(lastTelemetry < done, 'telemetry is not sent after the stream ends')
  })
})

test('the chat telemetry includes the configured model and context window', async () => {
  const modelRuntime = {
    status: () => ({ applied: true, provider: MODEL.provider, model: MODEL.model, contextWindow: 40_000, source: 'settings' }),
  }
  await withApi({ modelRuntime }, async (base) => {
    const response = await fetch(`${base}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    const telemetry = parseSse(await response.text()).filter((event) => event.event === 'telemetry')
    const last = telemetry.at(-1)!.data as RunTelemetry
    assert.deepEqual(last.model, MODEL)
    assert.equal(last.contextWindow, 40_000)
    assert.equal(last.contextUsedPercent, 25, '10000 of 40000')
  })
})

test('GET /api/stage-runs/:id/telemetry folds stored events', async () => {
  const workspace = fakeWorkspace()
  const run = await workspace.createStageRun({ projectId: 'p', stage: 'planning', context: {}, contextHash: 'h' })
  const ids = await (async () => {
    const events = (workspace as unknown as { events: Array<Record<string, unknown>> }).events
    const push = (payload: unknown, createdAt: string): void => {
      events.push({
        id: String(events.length + 1), projectId: 'p', stageRunId: run.id, role: 'analyzer', agentId: 'analyzer',
        type: 'status', phase: null, level: 'debug', payload, createdAt,
      })
    }
    push({ type: 'status', phase: 'step_start', turn: 1, step: 1 }, '2026-01-01T10:00:00.000Z')
    push({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: USAGE, model: MODEL, contextWindow: 20_000 }, '2026-01-01T10:00:04.000Z')
    return events.length
  })()
  assert.equal(ids, 2)

  await withApi({ workspace }, async (base) => {
    const response = await fetch(`${base}/api/stage-runs/${run.id}/telemetry`)
    assert.equal(response.status, 200)
    const body = await response.json() as { telemetry: RunTelemetry }
    assert.equal(body.telemetry.steps, 1)
    assert.equal(body.telemetry.tokensPerSecond, 250, '1000 output tokens over 4s')
    assert.equal(body.telemetry.contextUsedPercent, 50)
    assert.deepEqual(body.telemetry.model, MODEL)
  })
})

test('the stage event stream sends telemetry on connect and after new usage', async () => {
  const workspace = fakeWorkspace()
  const run = await workspace.createStageRun({ projectId: 'p', stage: 'planning', context: {}, contextHash: 'h' })
  await workspace.appendStageRunEvent({
    projectId: 'p', stageRunId: run.id, role: 'analyzer', type: 'status', level: 'debug',
    payload: { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: USAGE },
  })

  await withApi({ workspace }, async (base) => {
    const response = await fetch(`${base}/api/stage-runs/${run.id}/events/stream`)
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    // Read until the first telemetry frame, which is sent immediately on connect.
    for (let i = 0; i < 40 && !text.includes('event: telemetry'); i++) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    await reader.cancel().catch(() => {})
    const frames = parseSse(text)
    const telemetry = frames.find((frame) => frame.event === 'telemetry')
    assert.ok(telemetry, `expected a telemetry frame, got: ${text.slice(0, 300)}`)
    const snapshot = telemetry.data as RunTelemetry
    assert.equal(snapshot.steps, 1, 'seeded from stored events')
    assert.equal(snapshot.usage.output, 1_000)
  })
})

test('a run with no usage reports an empty telemetry snapshot', async () => {
  const workspace = fakeWorkspace()
  const run = await workspace.createStageRun({ projectId: 'p', stage: 'planning', context: {}, contextHash: 'h' })
  await withApi({ workspace }, async (base) => {
    const body = await (await fetch(`${base}/api/stage-runs/${run.id}/telemetry`)).json() as { telemetry: RunTelemetry }
    assert.equal(body.telemetry.turns, 0)
    assert.equal(body.telemetry.steps, 0)
    assert.equal(body.telemetry.usage.total, 0)
    assert.equal(body.telemetry.tokensPerSecond, null)
    assert.equal(body.telemetry.cacheHitPercent, null)
    assert.equal(body.telemetry.contextUsedPercent, null)
  })
})

test('the telemetry endpoint is a 404 for an unknown run and 503 without a workspace', async () => {
  await withApi({ workspace: fakeWorkspace() }, async (base) => {
    const missing = await fetch(`${base}/api/stage-runs/nope/telemetry`)
    assert.equal(missing.status, 404)
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'STAGE_RUN_NOT_FOUND')
  })
  await withApi({ stageRuntime: false }, async (base) => {
    const disabled = await fetch(`${base}/api/stage-runs/run-1/telemetry`)
    assert.equal(disabled.status, 503)
    assert.equal(((await disabled.json()) as { error: { code: string } }).error.code, 'STAGE_RUNTIME_DISABLED')
  })
  await withApi({ stageRuntime: true }, async (base) => {
    const noWorkspace = await fetch(`${base}/api/stage-runs/run-1/telemetry`)
    assert.equal(noWorkspace.status, 503)
    assert.equal(((await noWorkspace.json()) as { error: { code: string } }).error.code, 'WORKSPACE_NOT_CONFIGURED')
  })
})
