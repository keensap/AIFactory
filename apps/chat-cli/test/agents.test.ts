import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
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
  tools: ['tool-fs', 'tool-todo'],
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
  const key = (scope: string, stage: string, process: string) => `${scope}|${stage}|${process}`
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
          return { scope: scope!, process: process!, agentId }
        })
    },
    async setAssignment(input) { assignments.set(key(input.scope, input.stage, input.process), input.agentId) },
    async clearAssignment(input) { return assignments.delete(key(input.scope, input.stage, input.process)) },
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
      stageSettings: { planning: async () => ({ gateAfterEachReview: false, maxReviewCycles: 1, minRating: 0, maxBlockers: 0, maxMajor: 0 }) },
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
    assert.equal(authorStart?.payload.model, 'author-model', 'the event records the agent model')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
