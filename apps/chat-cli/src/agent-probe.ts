/**
 * Structural probe for an agent composition (AR-08).
 *
 * The original probe inferred "did the composition load?" from words in an error
 * message, which most configuration errors contain, so broken compositions were
 * routinely reported as accepted. This probe asks the harness directly and
 * inspects what it actually sent:
 *
 *  - the harness booted at all (`session`, then `step_start`);
 *  - the system prompt contains the agent's persona;
 *  - the request names the agent's model;
 *  - each configured skill appears in the request (the skill catalogue);
 *  - tools belonging to disabled rows are absent;
 *  - infrastructure rows were not disabled (the request still has tools).
 *
 * The model call goes to a local stand-in endpoint, so the probe needs no
 * credentials, costs nothing, and can run on every save.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materialiseAgent, type MaterialisedAgentInput } from './agent-patch.ts'
import { DshHarness } from './harness.ts'

/** Env var the probe's route references; its value is irrelevant to the stand-in. */
const PROBE_KEY_ENV = 'AIFACTORY_PROBE_KEY'
const PROBE_PROVIDER = 'aifactory-probe'

/**
 * Tool names each harness row is expected to expose, for the rows where a leak
 * would matter most. Names differ from row ids (a row is a plugin), so a row
 * whose name is unknown is simply not asserted on; the boot and patch checks
 * still cover it.
 */
export const TOOL_NAME_HINTS: Record<string, readonly string[]> = {
  'tool-bash': ['bash'],
  'tool-pwsh': ['pwsh'],
  'tool-fs': ['read', 'write', 'edit'],
  'tool-fs-search': ['glob', 'grep'],
  'tool-web': ['web_search', 'web_fetch'],
  'tool-subagent': ['subagent'],
  'tool-subagent-fork': ['subagent_fork'],
  'tool-workflow': ['workflow'],
  'tool-skill': ['skill'],
  'tool-todo': ['todo_write'],
}

export interface ProbeCheck {
  name: string
  ok: boolean
  detail: string
}

export interface ProbeRequest {
  model?: string
  systemPrompt: string
  toolNames: string[]
  /** Every captured request body, stringified, for skill/persona searching. */
  body: string
}

export interface ProbeResult {
  ok: boolean
  configAccepted: boolean
  checks: ProbeCheck[]
  /** The composition, echoed for the UI. */
  config: { persona: boolean; model: string | null; tools: number; skills: string[]; patchRows: number }
  /** What the harness actually sent: useful in the UI and for assertions. */
  request: { model: string | null; tools: number; toolNames: string[] }
}

export interface ProbeOptions {
  harness: { command: string; profile: string; commandArgs?: string[]; env?: Record<string, string | undefined> }
  /** Model the prompt asks for; the composition's model wins when it has one. */
  fallbackModel?: string
  /** The profile's `tool-*` rows, so an allowlist can be verified before running. */
  profileToolRows?: readonly string[]
  timeoutMs?: number
}

/** One OpenAI-compatible reply, captured so the probe can inspect the request. */
async function startStandIn(): Promise<{ server: Server; port: number; requests: ProbeRequest[] }> {
  const requests: ProbeRequest[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    request.on('end', () => {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(raw) as Record<string, unknown> } catch { /* keep the raw text */ }
      const messages = Array.isArray(body.messages) ? body.messages as Array<{ role?: string; content?: unknown }> : []
      const system = messages.find((message) => message.role === 'system')
      const tools = Array.isArray(body.tools) ? body.tools as Array<{ function?: { name?: string }; name?: string }> : []
      requests.push({
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        systemPrompt: typeof system?.content === 'string' ? system.content : '',
        toolNames: tools.map((tool) => tool.function?.name ?? tool.name ?? '').filter((name) => name !== ''),
        body: raw,
      })

      const send = (payload: unknown): void => {
        if (response.headersSent) return
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      if (body.stream === true) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const chunk = (delta: unknown, finish: string | null) => ({
          id: 'probe', object: 'chat.completion.chunk', created: 0, model: 'probe',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })
        response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'READY' }, null))}\n\n`)
        response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      send({
        id: 'probe', object: 'chat.completion', created: 0, model: 'probe',
        choices: [{ index: 0, message: { role: 'assistant', content: 'READY' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return { server, port: (server.address() as AddressInfo).port, requests }
}

/**
 * Probe one composition. Never throws for a bad composition: the result says what
 * failed, because "the agent is broken" is a valid answer the caller must show.
 */
export async function probeAgentComposition(
  agent: MaterialisedAgentInput,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const model = agent.model !== null && agent.model !== '' ? agent.model : (options.fallbackModel ?? 'probe-model')
  const config = {
    persona: agent.persona !== null && agent.persona.trim() !== '',
    model: agent.model,
    tools: agent.tools.length,
    skills: agent.skills.map((skill) => skill.name),
    patchRows: 0,
  }
  const checks: ProbeCheck[] = []
  const dir = await mkdtemp(join(tmpdir(), 'aifactory-probe-'))
  const standIn = await startStandIn()

  try {
    const baseURL = `http://127.0.0.1:${standIn.port}/v1`
    let materialised
    try {
      materialised = await materialiseAgent(dir, agent, {
        provider: PROBE_PROVIDER,
        model,
        routes: {
          [PROBE_PROVIDER]: {
            api: 'openai-completions',
            baseURL,
            apiKeyEnv: PROBE_KEY_ENV,
            models: [{ id: model }],
          },
        },
        ...(options.profileToolRows !== undefined ? { profileToolRows: options.profileToolRows } : {}),
      })
    } catch (error) {
      return {
        ok: false,
        configAccepted: false,
        checks: [{
          name: 'composition',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        }],
        config,
        request: { model: null, tools: 0, toolNames: [] },
      }
    }

    config.patchRows = (JSON.parse(await readFile(materialised.patchPath, 'utf8')) as unknown[]).length

    const capturedBefore = standIn.requests.length
    let booted = false
    let bootError: string | null = null
    try {
      const harness = new DshHarness({
        command: options.harness.command,
        profile: options.harness.profile,
        ...(options.harness.commandArgs !== undefined ? { commandArgs: options.harness.commandArgs } : {}),
        cwd: dir,
        timeoutMs: options.timeoutMs ?? 60_000,
        patches: [materialised.patchPath],
        env: { ...options.harness.env, [PROBE_KEY_ENV]: 'probe' },
      })
      let sawSession = false
      let sawStep = false
      await harness.run('Reply with the single word READY.', {
        onEvent: (event) => {
          const type = (event as { type?: string }).type
          if (type === 'session') sawSession = true
          if (type === 'status' && (event as { phase?: string }).phase === 'step_start') sawStep = true
        },
      })
      booted = sawSession || sawStep
    } catch (error) {
      bootError = error instanceof Error ? error.message : String(error)
      // A boot that produced steps still proves the composition loaded: the model
      // call is what failed, and that is a different answer.
      booted = standIn.requests.length > capturedBefore
    }

    checks.push({
      name: 'composition',
      ok: booted,
      detail: booted
        ? 'the harness started with the composed patch'
        : `the harness did not start with this composition: ${(bootError ?? 'no output').slice(0, 400)}`,
    })

    // The harness can exit 0 while the turn itself failed (a provider error is
    // reported in the result, not thrown). A composition is only proven by a
    // request that actually reached the stand-in.
    const request = standIn.requests[capturedBefore] ?? null
    if (!booted || request === null) {
      checks.push({
        name: 'request',
        ok: false,
        detail: bootError !== null
          ? `no model request was made; the harness reported: ${bootError.slice(0, 300)}`
          : 'no model request reached the probe endpoint; the composition did not take effect',
      })
      return {
        ok: false,
        configAccepted: false,
        checks,
        config,
        request: { model: null, tools: 0, toolNames: [] },
      }
    }
    checks.push({
      name: 'request',
      ok: true,
      detail: 'the harness sent a model request to the probe endpoint',
    })

    if (config.persona) {
      const persona = (agent.persona ?? '').trim()
      // Use a distinctive slice: the prompt is wrapped, but the text is verbatim.
      const needle = persona.slice(0, Math.min(80, persona.length))
      checks.push({
        name: 'persona',
        ok: request.systemPrompt.includes(needle),
        detail: request.systemPrompt.includes(needle)
          ? 'the agent persona reached the system prompt'
          : 'the agent persona is missing from the system prompt',
      })
    }

    checks.push({
      name: 'model',
      ok: request.model === model,
      detail: `request model ${request.model ?? '(none)'} (expected ${model})`,
    })

    for (const skill of agent.skills) {
      checks.push({
        name: `skill:${skill.name}`,
        ok: request.body.includes(skill.name),
        detail: request.body.includes(skill.name)
          ? 'the skill is visible to the model'
          : 'the skill was not offered to the model (is "tool-skill" allowed?)',
      })
    }

    if (agent.tools.length > 0) {
      const leaked: string[] = []
      for (const row of allRows()) {
        if (agent.tools.includes(row)) continue
        const hints = TOOL_NAME_HINTS[row] ?? []
        for (const hint of hints) {
          if (request.toolNames.includes(hint)) leaked.push(`${hint} (from ${row})`)
        }
      }
      checks.push({
        name: 'tools',
        ok: leaked.length === 0 && request.toolNames.length > 0,
        detail: leaked.length > 0
          ? `tools outside the allowlist are enabled: ${leaked.join(', ')}`
          : request.toolNames.length === 0
            ? 'no tools reached the model; infrastructure rows may have been disabled'
            : `${request.toolNames.length} tool(s) offered, none outside the allowlist`,
      })
    }

    const ok = checks.every((check) => check.ok)
    return {
      ok,
      configAccepted: ok,
      checks,
      config,
      request: {
        model: request.model ?? null,
        tools: request.toolNames.length,
        toolNames: [...request.toolNames].sort(),
      },
    }
  } finally {
    await new Promise<void>((resolve) => standIn.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Every row the allowlist can govern, for leak detection. */
function allRows(): string[] {
  return Object.keys(TOOL_NAME_HINTS)
}
