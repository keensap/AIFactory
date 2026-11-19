import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  AgentError,
  AgentService,
  parseAgent,
  type AgentRecord,
  type AgentStore,
  type AgentInput,
} from '../src/agents.ts'
import { buildAgentPatch } from '../src/agent-patch.ts'
import type { ModelPin } from '../src/models/index.ts'
import type { DshHarness } from '../src/harness.ts'
import { ProjectService } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import { PlanningStageRuntime } from '../src/stage-runtime.ts'
import { fakeWorkspace } from './support/fake-stage-workspace.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const AUTHOR: AgentInput = {
  name: 'feasibility-author',
  persona: 'You are the AI Factory planning author.',
  model: 'author-model',
  tools: ['tool-fs', 'tool-todo', 'tool-skill'],
  skills: [{ name: 'telos-writing', description: 'Write TELOS sections', instructions: '# Write TELOS\n' }],
}

// ---- validation --------------------------------------------------------

test('agent names are kebab-case and tools must exist', () => {
  assert.equal(parseAgent({ name: 'feasibility-author' }).name, 'feasibility-author')
  for (const bad of ['Feasibility Author', 'author_1', '-author', '']) {
    assert.throws(() => parseAgent({ name: bad }), (error: unknown) => error instanceof AgentError)
  }
  assert.throws(
    () => parseAgent({ name: 'a-b', tools: ['tool-nope'] }),
    (error: unknown) => error instanceof AgentError && error.code === 'INVALID_AGENT_TOOLS',
  )
  assert.deepEqual(parseAgent({ name: 'a-b', tools: ['tool-fs', 'tool-fs'] }).tools, ['tool-fs'], 'tools are deduplicated')
  assert.throws(
    () => parseAgent({ name: 'a-b', skills: [{ name: 'Bad Name', instructions: 'x' }] }),
    /lower-case words joined by hyphens/,
  )
  assert.throws(() => parseAgent({ description: 'no name' }), (error: unknown) => error instanceof AgentError && error.code === 'NO_FIELDS')
  assert.deepEqual(parseAgent({ model: null }, { partial: true }), { model: null })
})

// ---- the patch ---------------------------------------------------------

test('the agent patch carries persona, model on the same provider, tools and skills', () => {
  const content = buildAgentPatch({
    composition: { persona: 'You are the author.', model: 'author-model', reasoningEffort: 'high', tools: ['tool-fs'] },
    provider: 'acme',
    model: 'base-model',
    routes: { acme: { api: 'openai-completions', baseURL: 'http://x', models: [{ id: 'base-model' }] } },
    skillsDir: '/tmp/skills',
  })
  const rows = JSON.parse(content) as Array<Record<string, unknown>>
  const byId = new Map(rows.map((row) => [row.id as string, row]))

  assert.deepEqual(byId.get('system-prompt'), { id: 'system-prompt', config: { personaPrefix: 'You are the author.' } })
  assert.deepEqual(byId.get('agent-default-model'), {
    id: 'agent-default-model',
    config: { provider: 'acme', model: 'author-model', reasoningEffort: 'high' },
  })
  const routes = (byId.get('llm-pi-ai')!.config as { providers: Record<string, { models: Array<{ id: string }> }> }).providers
  assert.deepEqual(routes.acme!.models.map((entry) => entry.id), ['base-model', 'author-model'], 'agent model declared on the same route')
  assert.deepEqual(byId.get('skill-filesystem'), {
    id: 'skill-filesystem',
    config: { includeDefaultRoots: false, customSkillDirs: ['/tmp/skills'] },
  })
  assert.equal(byId.get('tool-fs'), undefined, 'an allowed tool is not disabled')
  assert.equal((byId.get('tool-bash') as { disabled?: boolean }).disabled, true)
})

test('an unrestricted agent leaves the tools and model alone', () => {
  const rows = JSON.parse(buildAgentPatch({
    composition: { persona: null, model: null, reasoningEffort: null, tools: [] },
  })) as unknown[]
  assert.deepEqual(rows, [], 'nothing to change means an empty patch')
})

// ---- service -----------------------------------------------------------

function memoryStore(): AgentStore & { agentsMap: Map<string, AgentRecord>; assignmentsMap: Map<string, string> } {
  const agents = new Map<string, AgentRecord>()
  const assignments = new Map<string, string>()
  let sequence = 0
  const key = (projectId: string | null, stage: string, process: string) => `${projectId ?? 'factory'}|${stage}|${process}`
  const store: AgentStore & { agentsMap: Map<string, AgentRecord>; assignmentsMap: Map<string, string> } = {
    agentsMap: agents,
    assignmentsMap: assignments,
    async list() { return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)) },
    async get(id) { return agents.get(id) },
    async create(input) {
      sequence += 1
      const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
      const now = new Date().toISOString()
      const record: AgentRecord = { ...input, id, createdAt: now, updatedAt: now }
      agents.set(id, record)
      return record
    },
    async update(id, input) {
      const current = agents.get(id)
      if (current === undefined) return undefined
      const next = { ...current, ...input, updatedAt: new Date().toISOString() }
      agents.set(id, next)
      return next
    },
    async remove(id) { return agents.delete(id) },
    async assignments(stage) {
      return [...assignments.entries()]
        .filter(([entry]) => entry.split('|')[1] === stage)
        .map(([entry, agentId]) => {
          const [scope, , process] = entry.split('|')
          return { projectId: scope === 'factory' ? null : scope!, process: process!, agentId }
        })
    },
    async setAssignment(input) { assignments.set(key(input.projectId, input.stage, input.process), input.agentId) },
    async clearAssignment(input) { return assignments.delete(key(input.projectId, input.stage, input.process)) },
  }
  return store
}

test('a project assignment overrides the Factory one, and clearing falls back', async () => {
  const store = memoryStore()
  const service = new AgentService(store)
  const author = await service.create(AUTHOR)
  const reviewer = await service.create({ name: 'feasibility-reviewer', persona: 'You review.' })

  await service.setAssignment({ stage: 'planning', process: 'author', agentId: author.id })
  let rows = await service.assignments('planning', 'project-1')
  assert.equal(rows.find((row) => row.process === 'author')?.agent?.name, 'feasibility-author')
  assert.equal(rows.find((row) => row.process === 'author')?.source, 'factory')

  await service.setAssignment({ stage: 'planning', process: 'author', agentId: reviewer.id, projectId: 'project-1' })
  rows = await service.assignments('planning', 'project-1')
  assert.equal(rows.find((row) => row.process === 'author')?.agent?.name, 'feasibility-reviewer')
  assert.equal(rows.find((row) => row.process === 'author')?.source, 'project')

  const composition = await service.composition({ projectId: 'project-1', stage: 'planning', process: 'author' })
  assert.equal(composition?.name, 'feasibility-reviewer')

  await service.clearAssignment({ stage: 'planning', process: 'author', projectId: 'project-1' })
  rows = await service.assignments('planning', 'project-1')
  assert.equal(rows.find((row) => row.process === 'author')?.source, 'factory')

  await assert.rejects(
    () => service.setAssignment({ stage: 'planning', process: 'nope', agentId: author.id }),
    (error: unknown) => error instanceof AgentError && error.code === 'INVALID_PROCESS',
  )
  await assert.rejects(() => service.get('missing'), (error: unknown) => error instanceof AgentError && error.code === 'AGENT_NOT_FOUND')
})

test('a disabled agent is not composed, and unassigned processes keep the default', async () => {
  const store = memoryStore()
  const service = new AgentService(store)
  const agent = await service.create(AUTHOR)
  await service.setAssignment({ stage: 'planning', process: 'author', agentId: agent.id })
  assert.equal((await service.composition({ projectId: 'p', stage: 'planning', process: 'author' }))?.name, 'feasibility-author')
  await service.update(agent.id, { enabled: false })
  assert.equal(await service.composition({ projectId: 'p', stage: 'planning', process: 'author' }), undefined, 'a disabled agent is skipped')
  assert.equal(await service.composition({ projectId: 'p', stage: 'planning', process: 'reviewer' }), undefined)
})

// ---- the runtime -------------------------------------------------------

test('each planning role runs with its assigned agent composition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-agent-run-'))
  const patches: Array<{ role: string; content: string }> = []
  const texts = [
    '# Analysis',
    '# TELOS Feasibility Report\n\nbody\n',
    '{"decision":"approved","rating":100,"findings":[]}',
  ]
  let calls = 0
  const harness = {
    run: async () => ({ text: texts[Math.min(calls++, texts.length - 1)]!, stderr: '' }),
  } as unknown as DshHarness
  let roles = 0
  try {
    const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
    const project = await projects.create({ name: 'AgentRun', rootPath: root, organization: null, ownerEmail: null, status: 'active' })
    const store = memoryStore()
    const service = new AgentService(store)
    const author = await service.create(AUTHOR)
    await service.setAssignment({ stage: 'planning', process: 'author', agentId: author.id })

    const pin: ModelPin = {
      attribution: { provider: 'acme', model: 'base-model', source: 'global', price: null, contextWindow: 1000 },
      routes: { acme: { api: 'openai-completions', baseURL: 'http://x', models: [{ id: 'base-model' }] } },
      // The agent's model must be attributed as itself (AR-02).
      attributionFor: (model?: string) => (model === undefined || model === '' || model === 'base-model'
        ? { provider: 'acme', model: 'base-model', source: 'global', price: null, contextWindow: 1000 }
        : { provider: 'acme', model, source: 'global', price: { input: 1, output: 2 }, contextWindow: 32_000 }),
      harness: (_cwd: string | undefined, _timeout: number | undefined, extraPatchPath?: string | null) => {
        roles += 1
        if (extraPatchPath !== null && extraPatchPath !== undefined) {
          patches.push({ role: String(roles), content: readFileSync(extraPatchPath, 'utf8') })
        }
        return harness
      },
      release: () => {},
    } as unknown as ModelPin

    const workspace = fakeWorkspace()
    const runtime = new PlanningStageRuntime({
      projects,
      workspace,
      harnessFactory: () => harness,
      pinModel: () => pin,
      runPrompt: undefined,
      stageSettings: { planning: async () => ({ maxReviewCycles: 1, minRating: 0, maxBlockers: 0, maxMajor: 0, gateReminderHours: 72 }) },
      agents: service,
    })
    const run = await runtime.start({ projectId: project.id, stage: 'planning', brief: 'portal' })
    await runtime.execute(run.id)

    assert.equal(roles, 3, 'analyzer, author and reviewer each ran')
    assert.equal(patches.length, 1, 'only the author has an assigned agent')
    const authorPatch = JSON.parse(patches[0]!.content) as Array<Record<string, unknown>>
    const ids = authorPatch.map((row) => row.id)
    assert.ok(ids.includes('system-prompt'))
    assert.ok(ids.includes('agent-default-model'))
    assert.ok(ids.includes('skill-filesystem'))

    const skillFile = join(root, '.aifactory', 'agents', author.id, 'skills', 'telos-writing', 'SKILL.md')
    assert.equal(existsSync(skillFile), true, 'the agent skill was materialised for the harness')
    assert.match(readFileSync(skillFile, 'utf8'), /name: telos-writing/)

    const events = (workspace as unknown as { events: Array<{ type: string; payload: Record<string, unknown> }> }).events
    const authorStart = events.find((event) => event.type === 'role_start' && event.payload.role === 'author')
    assert.equal(authorStart?.payload.agent, 'feasibility-author')
    assert.deepEqual(
      authorStart?.payload.model,
      { provider: 'acme', model: 'author-model', source: 'global' },
      'the event records the agent model as attribution, not as the Factory one',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---- probe -------------------------------------------------------------

test('materialiseAgent writes the patch and SKILL.md, and cleans up the patch', async () => {
  const { materialiseAgent } = await import('../src/agent-patch.ts')
  const dir = mkdtempSync(join(tmpdir(), 'aifactory-materialise-'))
  try {
    const agent = {
      id: 'agent-1',
      persona: 'You are the author.',
      model: 'author-model',
      reasoningEffort: null,
      tools: ['tool-fs', 'tool-skill'],
      skills: [{ name: 'telos-writing', description: 'Write TELOS', instructions: '# TELOS\n' }],
    }
    const materialised = await materialiseAgent(dir, agent, {
      provider: 'acme',
      model: 'base-model',
      routes: { acme: { api: 'openai-completions', baseURL: 'http://x', models: [{ id: 'base-model' }] } },
    })
    const rows = JSON.parse(readFileSync(materialised.patchPath, 'utf8')) as Array<Record<string, unknown>>
    assert.ok(rows.some((row) => row.id === 'system-prompt'))
    assert.ok(rows.some((row) => row.id === 'agent-default-model'))

    const skill = join(dir, '.aifactory', 'agents', 'agent-1', 'skills', 'telos-writing', 'SKILL.md')
    assert.equal(existsSync(skill), true)
    assert.match(readFileSync(skill, 'utf8'), /name: telos-writing/)

    await materialised.cleanup()
    assert.equal(existsSync(materialised.patchPath), false, 'the patch is removed')
    assert.equal(existsSync(skill), true, 'skills stay for inspection')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the probe endpoint reports a composition and refuses when unavailable', async () => {
  const { createChatServer, serverPort } = await import('../src/server.ts')
  const { SessionStore } = await import('../src/store.ts')
  const { DshHarness } = await import('../src/harness.ts')
  const { ProjectService } = await import('../src/projects.ts')
  const { SettingsService } = await import('../src/settings.ts')
  const { MemoryProjectStore } = await import('./support/memory-project-store.ts')
  const { MemorySettingsStore } = await import('./support/memory-settings-store.ts')

  const store = memoryStore()
  const service = new AgentService(store)
  const agent = await service.create(AUTHOR)
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-agent-api-'))
  const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))

  const start = async (probe?: (agent: AgentRecord) => Promise<unknown>) => {
    const server = createChatServer({
      harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
      store: new SessionStore({ dataDir }),
      version: 'test',
      projects,
      agents: service,
      ...(probe !== undefined ? { probeAgent: probe } : {}),
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    return { server, base: `http://127.0.0.1:${serverPort(server)}` }
  }

  const withProbe = await start(async (probed) => ({
    ok: true,
    configAccepted: true,
    config: { persona: true, model: probed.model, tools: 2, skills: ['telos-writing'], patchRows: 4 },
    model: { ok: true, reply: 'READY' },
  }))
  try {
    const response = await fetch(`${withProbe.base}/api/agents/${agent.id}/test`, { method: 'POST' })
    assert.equal(response.status, 200)
    const body = await response.json() as { ok: boolean; configAccepted: boolean; model: { reply: string } }
    assert.equal(body.ok, true)
    assert.equal(body.configAccepted, true)
    assert.equal(body.model.reply, 'READY')
  } finally {
    await new Promise<void>((resolve) => withProbe.server.close(() => resolve()))
  }

  const withoutProbe = await start()
  try {
    const response = await fetch(`${withoutProbe.base}/api/agents/${agent.id}/test`, { method: 'POST' })
    assert.equal(response.status, 503)
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'AGENT_PROBE_NOT_CONFIGURED')
  } finally {
    await new Promise<void>((resolve) => withoutProbe.server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---- AR-05: the allowlist fails closed ---------------------------------

test('tool rows are classified, and unknown rows are reported as drift', async () => {
  const { MODEL_FACING_TOOL_ROWS, INFRASTRUCTURE_TOOL_ROWS, classifyToolRows } = await import('../src/agent-patch.ts')
  const result = classifyToolRows([
    'tool-fs', 'tool-bash', 'tool-executor-native', 'tool-result-pruner', 'tool-subagent-fork', 'not-a-tool',
  ])
  assert.deepEqual(result.modelFacing, ['tool-bash', 'tool-fs', 'tool-subagent-fork'])
  assert.deepEqual(result.infrastructure, ['tool-executor-native', 'tool-result-pruner'])
  assert.deepEqual(result.unclassified, [], 'every listed row is known')
  assert.equal(result.modelFacing.includes('tool-executor-native'), false, 'infrastructure is never allowlisted')

  assert.equal(classifyToolRows(['tool-brand-new']).unclassified[0], 'tool-brand-new')
  assert.ok(MODEL_FACING_TOOL_ROWS.includes('tool-subagent-fork'), 'subagent_fork is model-facing')
  assert.equal(INFRASTRUCTURE_TOOL_ROWS.includes('tool-executor-ptc'), true)
})

test('a restricted agent disables model-facing tools it did not allow, including subagent_fork', () => {
  const rows = JSON.parse(buildAgentPatch({
    composition: { persona: null, model: null, reasoningEffort: null, tools: ['tool-fs'] },
  })) as Array<{ id: string; disabled?: boolean }>
  const disabled = new Set(rows.filter((row) => row.disabled === true).map((row) => row.id))

  assert.equal(disabled.has('tool-subagent-fork'), true, 'the row the old allowlist leaked')
  assert.equal(disabled.has('tool-bash'), true)
  assert.equal(disabled.has('tool-fs'), false, 'the allowed tool stays')
  for (const infrastructure of ['tool-executor-native', 'tool-executor-ptc', 'tool-result-pruner']) {
    assert.equal(disabled.has(infrastructure), false, `${infrastructure} must never be disabled`)
  }
})

test('an unclassified profile row refuses the allowlist instead of granting it', async () => {
  const { buildAgentPatch: build, ToolsetUnverifiedError } = await import('../src/agent-patch.ts')
  assert.throws(
    () => build({
      composition: { persona: null, model: null, reasoningEffort: null, tools: ['tool-fs'] },
      profileToolRows: ['tool-fs', 'tool-mystery'],
    }),
    (error: unknown) => error instanceof ToolsetUnverifiedError
      && error.code === 'AGENT_TOOLSET_UNVERIFIED'
      && error.unclassified[0] === 'tool-mystery',
  )
  // An unrestricted agent does not depend on the classification.
  assert.doesNotThrow(() => build({
    composition: { persona: null, model: null, reasoningEffort: null, tools: [] },
    profileToolRows: ['tool-mystery'],
  }))
})

test('the installed profile contains only classified tool rows', () => {
  // Runs as a separate process (like the model import guard) because spawning the
  // harness from inside the test runner fails on filesystem writes it performs.
  const root = fileURLToPath(new URL('..', import.meta.url))
  const output = execFileSync(process.execPath, [join(root, 'scripts/check-tool-rows.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  // Either it verified the profile, or it reported why it could not in this environment.
  assert.match(output, /tool guard: (\d+ tool rows classified|.*skipped)/)
  if (/classified/.test(output)) {
    assert.match(output, /\(\d+ model-facing, \d+ infrastructure\)/)
  }
})

// ---- AR-10: skills need tool-skill ------------------------------------

test('an agent with skills must allow tool-skill', () => {
  const skills = [{ name: 'telos-writing', description: 'x', instructions: '# x' }]
  assert.throws(
    () => parseAgent({ name: 'a-b', tools: ['tool-fs'], skills }),
    (error: unknown) => error instanceof AgentError && error.code === 'AGENT_SKILLS_NEED_SKILL_TOOL',
  )
  assert.ok(parseAgent({ name: 'a-b', tools: ['tool-fs', 'tool-skill'], skills }).skills !== undefined)
  assert.ok(parseAgent({ name: 'a-b', tools: [], skills }).skills !== undefined, 'no allowlist means no restriction')
  assert.ok(parseAgent({ name: 'a-b', tools: ['tool-fs'] }).tools !== undefined, 'no skills, no requirement')
})

test('a definition saved before the rule existed is refused at materialisation', async () => {
  const { materialiseAgent } = await import('../src/agent-patch.ts')
  const dir = mkdtempSync(join(tmpdir(), 'aifactory-requirement-'))
  try {
    await assert.rejects(
      () => materialiseAgent(dir, {
        id: 'legacy', persona: null, model: null, reasoningEffort: null,
        tools: ['tool-fs'],
        skills: [{ name: 'telos-writing', description: '', instructions: '# x' }],
      }),
      (error: unknown) => (error as { code?: string }).code === 'AGENT_SKILLS_NEED_SKILL_TOOL',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('patching only the tools of an agent with skills cannot orphan them', async () => {
  const service = new AgentService(memoryStore())
  const agent = await service.create(AUTHOR)
  await assert.rejects(
    () => service.update(agent.id, { tools: ['tool-fs'] }),
    (error: unknown) => error instanceof AgentError && error.code === 'AGENT_SKILLS_NEED_SKILL_TOOL',
  )
})

// ---- AR-09: assignments belong to a project -------------------------

test('assignments cascade with their project and reject an unknown one', { skip: process.env.AIFACTORY_TEST_DATABASE_URL === undefined }, async () => {
  const { PostgresProjectStore } = await import('../src/projects.ts')
  const { PostgresAgentStore } = await import('../src/agents.ts')
  const url = process.env.AIFACTORY_TEST_DATABASE_URL!
  const projects = new PostgresProjectStore(url)
  const store = new PostgresAgentStore(url)
  await store.migrate()
  const project = await projects.create({
    name: `Cascade ${Date.now()}`, rootPath: mkdtempSync(join(tmpdir(), 'aifactory-cascade-')),
    organization: null, ownerEmail: null, status: 'inactive',
  })
  try {
    const agent = await store.create({ name: `cascade-agent-${Date.now()}`, tools: [] })
    await store.setAssignment({ projectId: project.id, stage: 'planning', process: 'author', agentId: agent.id })
    assert.equal((await store.assignments('planning')).some((row) => row.projectId === project.id), true)

    // Deleting the project removes its override; the Factory default is untouched.
    await projects.remove(project.id)
    assert.equal(
      (await store.assignments('planning')).some((row) => row.projectId === project.id),
      false,
      'the assignment cascaded away with its project',
    )

    // An unknown project is refused by the foreign key, not silently stored.
    await assert.rejects(
      () => store.setAssignment({
        projectId: '00000000-0000-4000-8000-000000000000',
        stage: 'planning', process: 'author', agentId: agent.id,
      }),
      (error: unknown) => (error as { code?: string }).code === '23503',
    )
  } finally {
    await store.close()
    await projects.close()
  }
})
