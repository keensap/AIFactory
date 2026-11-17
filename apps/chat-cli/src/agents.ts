/**
 * Named agents, and which stage process each one runs.
 *
 * An agent is a **composition**, not a harness preset: the prototype showed the
 * headless runner never binds `dsh-agent-preset` (the session header carries no
 * preset), while the profile patch does express everything we need — persona,
 * tool allowlist, skill directory and model. We already launch one harness
 * process per role, so the agent becomes that process's patch.
 *
 * Model constraint: an agent may choose a model, never a provider. The provider
 * stays the Factory's, so there is one credential, one breaker and one fallback
 * path in force.
 */

import { Pool } from 'pg'
import { SDLC_STAGES, type ProjectStage } from './sdlc.ts'
import { TOOL_ROW_IDS } from './agent-patch.ts'

/** Processes each stage runs. Only planning has a runtime today. */
export const STAGE_PROCESSES: Partial<Record<ProjectStage, readonly string[]>> = {
  planning: ['analyzer', 'author', 'reviewer'],
}

export type AgentSkill = { name: string; description: string; instructions: string }

export interface AgentInput {
  name: string
  description?: string
  /** Replaces the deployment persona for this agent's process. */
  persona?: string
  /** Model inside the Factory provider; null/absent keeps the Factory model. */
  model?: string | null
  reasoningEffort?: string | null
  /** Harness tool row ids the agent may use. Empty means "no restriction". */
  tools?: string[]
  skills?: AgentSkill[]
  enabled?: boolean
}

export interface AgentRecord extends AgentInput {
  id: string
  createdAt: string
  updatedAt: string
}

/** What a role's harness process is composed from. */
export interface AgentComposition {
  id: string
  name: string
  persona: string | null
  model: string | null
  reasoningEffort: string | null
  tools: string[]
  skills: AgentSkill[]
}

/** The composition an agent definition represents. */
export function compositionOf(agent: AgentRecord): AgentComposition {
  const persona = agent.persona ?? ''
  return {
    id: agent.id,
    name: agent.name,
    persona: persona === '' ? null : persona,
    model: agent.model ?? null,
    reasoningEffort: agent.reasoningEffort ?? null,
    tools: agent.tools ?? [],
    skills: agent.skills ?? [],
  }
}

export class AgentError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AgentError'
    this.status = status
    this.code = code
  }
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_PERSONA = 8_000
const MAX_SKILLS = 20
const MAX_SKILL_INSTRUCTIONS = 20_000

function asString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new AgentError(400, 'INVALID_AGENT', `${field} must be a string`)
  if (value.length > max) throw new AgentError(400, 'INVALID_AGENT', `${field} must be at most ${max} characters`)
  return value
}

/** Validate an agent definition. Accepts a partial update when `partial` is set. */
export function parseAgent(input: unknown, options: { partial?: boolean } = {}): AgentInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AgentError(400, 'INVALID_BODY', 'expected a JSON object')
  }
  const record = input as Record<string, unknown>
  const out: Partial<AgentInput> = {}

  if (record.name !== undefined) {
    const name = asString(record.name, 'name', 64)
    if (!NAME_PATTERN.test(name)) {
      throw new AgentError(400, 'INVALID_AGENT_NAME', 'name must be lower-case words joined by hyphens')
    }
    out.name = name
  }
  if (record.description !== undefined) out.description = asString(record.description, 'description', 2_000)
  if (record.persona !== undefined) out.persona = asString(record.persona, 'persona', MAX_PERSONA)
  if (record.model !== undefined) {
    out.model = record.model === null ? null : asString(record.model, 'model', 200)
  }
  if (record.reasoningEffort !== undefined) {
    out.reasoningEffort = record.reasoningEffort === null ? null : asString(record.reasoningEffort, 'reasoningEffort', 40)
  }
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== 'boolean') throw new AgentError(400, 'INVALID_AGENT', 'enabled must be a boolean')
    out.enabled = record.enabled
  }

  if (record.tools !== undefined) {
    if (!Array.isArray(record.tools) || record.tools.some((tool) => typeof tool !== 'string')) {
      throw new AgentError(400, 'INVALID_AGENT_TOOLS', 'tools must be an array of tool ids')
    }
    const known = TOOL_ROW_IDS as readonly string[]
    const unknown = record.tools.filter((tool) => !known.includes(tool))
    if (unknown.length > 0) {
      throw new AgentError(400, 'INVALID_AGENT_TOOLS', `unknown tool(s): ${unknown.join(', ')}; known: ${TOOL_ROW_IDS.join(', ')}`)
    }
    out.tools = [...new Set(record.tools as string[])]
  }

  if (record.skills !== undefined) {
    if (!Array.isArray(record.skills)) throw new AgentError(400, 'INVALID_AGENT_SKILLS', 'skills must be an array')
    if (record.skills.length > MAX_SKILLS) {
      throw new AgentError(400, 'INVALID_AGENT_SKILLS', `at most ${MAX_SKILLS} skills`)
    }
    out.skills = record.skills.map((entry: unknown) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new AgentError(400, 'INVALID_AGENT_SKILLS', 'each skill must be an object')
      }
      const skill = entry as Record<string, unknown>
      const name = asString(skill.name, 'skills[].name', 64)
      if (!NAME_PATTERN.test(name)) {
        throw new AgentError(400, 'INVALID_AGENT_SKILLS', `skill "${name}" must be lower-case words joined by hyphens`)
      }
      return {
        name,
        description: asString(skill.description ?? '', 'skills[].description', 500),
        instructions: asString(skill.instructions, 'skills[].instructions', MAX_SKILL_INSTRUCTIONS),
      }
    })
  }

  if (options.partial !== true && out.name === undefined) {
    throw new AgentError(400, 'NO_FIELDS', 'name is required')
  }
  return out as AgentInput
}

export function assertProcess(stage: string, process: string): void {
  if (!(SDLC_STAGES as readonly string[]).includes(stage)) {
    throw new AgentError(400, 'INVALID_STAGE', `unknown SDLC stage ${stage}`)
  }
  const processes = STAGE_PROCESSES[stage as ProjectStage]
  if (processes === undefined) {
    throw new AgentError(400, 'NO_PROCESSES', `the ${stage} stage has no processes yet`)
  }
  if (!processes.includes(process)) {
    throw new AgentError(400, 'INVALID_PROCESS', `unknown process "${process}" for ${stage}; known: ${processes.join(', ')}`)
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface AgentRow {
  id: string
  name: string
  description: string
  enabled: boolean
  persona: string
  model: string | null
  reasoning_effort: string | null
  tools: string[]
  skills: AgentSkill[]
  created_at: Date | string
  updated_at: Date | string
}

function toRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    persona: row.persona,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    tools: Array.isArray(row.tools) ? row.tools : [],
    skills: Array.isArray(row.skills) ? row.skills : [],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
  }
}

export interface AgentStore {
  migrate?(): Promise<void>
  list(): Promise<AgentRecord[]>
  get(id: string): Promise<AgentRecord | undefined>
  create(input: AgentInput): Promise<AgentRecord>
  update(id: string, input: Partial<AgentInput>): Promise<AgentRecord | undefined>
  remove(id: string): Promise<boolean>
  /** Factory assignments ('factory') plus the project's overrides. */
  assignments(stage: ProjectStage): Promise<Array<{ scope: string; process: string; agentId: string }>>
  setAssignment(input: { scope: string; stage: ProjectStage; process: string; agentId: string }): Promise<void>
  clearAssignment(input: { scope: string; stage: ProjectStage; process: string }): Promise<boolean>
  close?(): Promise<void>
}

export class PostgresAgentStore implements AgentStore {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 })
    this.pool.on('error', () => {})
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_definitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled BOOLEAN NOT NULL DEFAULT true,
        persona TEXT NOT NULL DEFAULT '',
        model TEXT,
        reasoning_effort TEXT,
        tools JSONB NOT NULL DEFAULT '[]'::jsonb,
        skills JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- scope_key is 'factory' or a project id, so the key works without NULL semantics.
      CREATE TABLE IF NOT EXISTS agent_assignments (
        scope_key TEXT NOT NULL,
        stage TEXT NOT NULL,
        process TEXT NOT NULL,
        agent_id UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (scope_key, stage, process)
      );
    `)
  }

  async list(): Promise<AgentRecord[]> {
    const result = await this.pool.query<AgentRow>(`SELECT * FROM agent_definitions ORDER BY name`)
    return result.rows.map(toRecord)
  }

  async get(id: string): Promise<AgentRecord | undefined> {
    const result = await this.pool.query<AgentRow>(`SELECT * FROM agent_definitions WHERE id::text = $1 OR name = $1`, [id])
    const row = result.rows[0]
    return row === undefined ? undefined : toRecord(row)
  }

  async create(input: AgentInput): Promise<AgentRecord> {
    try {
      const result = await this.pool.query<AgentRow>(
        `INSERT INTO agent_definitions (name, description, enabled, persona, model, reasoning_effort, tools, skills)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
         RETURNING *`,
        [
          input.name, input.description ?? '', input.enabled !== false, input.persona ?? '',
          input.model ?? null, input.reasoningEffort ?? null,
          JSON.stringify(input.tools ?? []), JSON.stringify(input.skills ?? []),
        ],
      )
      return toRecord(result.rows[0]!)
    } catch (error) {
      if (error !== null && typeof error === 'object' && (error as { code?: string }).code === '23505') {
        throw new AgentError(409, 'AGENT_NAME_TAKEN', `an agent named "${input.name}" already exists`)
      }
      throw error
    }
  }

  async update(id: string, input: Partial<AgentInput>): Promise<AgentRecord | undefined> {
    const current = await this.get(id)
    if (current === undefined) return undefined
    try {
      const result = await this.pool.query<AgentRow>(
        `UPDATE agent_definitions SET
           name = $2, description = $3, enabled = $4, persona = $5, model = $6,
           reasoning_effort = $7, tools = $8::jsonb, skills = $9::jsonb, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          current.id,
          input.name ?? current.name,
          input.description ?? current.description ?? '',
          input.enabled ?? current.enabled !== false,
          input.persona ?? current.persona ?? '',
          input.model === undefined ? (current.model ?? null) : input.model,
          input.reasoningEffort === undefined ? (current.reasoningEffort ?? null) : input.reasoningEffort,
          JSON.stringify(input.tools ?? current.tools ?? []),
          JSON.stringify(input.skills ?? current.skills ?? []),
        ],
      )
      return result.rows[0] === undefined ? undefined : toRecord(result.rows[0])
    } catch (error) {
      if (error !== null && typeof error === 'object' && (error as { code?: string }).code === '23505') {
        throw new AgentError(409, 'AGENT_NAME_TAKEN', `an agent named "${input.name}" already exists`)
      }
      throw error
    }
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM agent_definitions WHERE id::text = $1`, [id])
    return (result.rowCount ?? 0) > 0
  }

  async assignments(stage: ProjectStage): Promise<Array<{ scope: string; process: string; agentId: string }>> {
    const result = await this.pool.query<{ scope: string; process: string; agentId: string }>(
      `SELECT scope_key AS "scope", process, agent_id::text AS "agentId"
       FROM agent_assignments WHERE stage = $1 ORDER BY scope_key, process`,
      [stage],
    )
    return result.rows
  }

  async setAssignment(input: { scope: string; stage: ProjectStage; process: string; agentId: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_assignments (scope_key, stage, process, agent_id, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (scope_key, stage, process) DO UPDATE SET agent_id = EXCLUDED.agent_id, updated_at = now()`,
      [input.scope, input.stage, input.process, input.agentId],
    )
  }

  async clearAssignment(input: { scope: string; stage: ProjectStage; process: string }): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM agent_assignments WHERE scope_key = $1 AND stage = $2 AND process = $3`,
      [input.scope, input.stage, input.process],
    )
    return (result.rowCount ?? 0) > 0
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const FACTORY_SCOPE = 'factory'

export interface ResolvedAssignment {
  process: string
  agent: AgentRecord | null
  source: 'project' | 'factory' | 'none'
}

export class AgentService {
  private readonly store: AgentStore

  constructor(store: AgentStore) {
    this.store = store
  }

  async migrate(): Promise<void> {
    await this.store.migrate?.()
  }

  list(): Promise<AgentRecord[]> {
    return this.store.list()
  }

  async get(id: string): Promise<AgentRecord> {
    const agent = await this.store.get(id)
    if (agent === undefined) throw new AgentError(404, 'AGENT_NOT_FOUND', `no agent "${id}"`)
    return agent
  }

  async create(input: unknown): Promise<AgentRecord> {
    return this.store.create(parseAgent(input))
  }

  async update(id: string, input: unknown): Promise<AgentRecord> {
    const agent = await this.get(id)
    const updated = await this.store.update(agent.id, parseAgent(input, { partial: true }))
    if (updated === undefined) throw new AgentError(404, 'AGENT_NOT_FOUND', `no agent "${id}"`)
    return updated
  }

  async remove(id: string): Promise<void> {
    const agent = await this.get(id)
    if (!(await this.store.remove(agent.id))) throw new AgentError(404, 'AGENT_NOT_FOUND', `no agent "${id}"`)
  }

  /** Assignments for a stage, showing the project override over the Factory default. */
  async assignments(stage: string, projectId?: string): Promise<ResolvedAssignment[]> {
    if (!(SDLC_STAGES as readonly string[]).includes(stage)) {
      throw new AgentError(400, 'INVALID_STAGE', `unknown SDLC stage ${stage}`)
    }
    const processes = STAGE_PROCESSES[stage as ProjectStage] ?? []
    const rows = await this.store.assignments(stage as ProjectStage)
    const agents = new Map((await this.store.list()).map((agent) => [agent.id, agent]))
    return processes.map((process) => {
      const project = projectId === undefined ? undefined : rows.find((row) => row.scope === projectId && row.process === process)
      const factory = rows.find((row) => row.scope === FACTORY_SCOPE && row.process === process)
      if (project !== undefined) {
        return { process, agent: agents.get(project.agentId) ?? null, source: 'project' as const }
      }
      if (factory !== undefined) {
        return { process, agent: agents.get(factory.agentId) ?? null, source: 'factory' as const }
      }
      return { process, agent: null, source: 'none' as const }
    })
  }

  async setAssignment(input: { stage: string; process: string; agentId: string; projectId?: string }): Promise<ResolvedAssignment[]> {
    assertProcess(input.stage, input.process)
    const agent = await this.get(input.agentId)
    if (agent.enabled === false) {
      throw new AgentError(400, 'AGENT_DISABLED', `agent "${agent.name}" is disabled`)
    }
    await this.store.setAssignment({
      scope: input.projectId ?? FACTORY_SCOPE,
      stage: input.stage as ProjectStage,
      process: input.process,
      agentId: agent.id,
    })
    return this.assignments(input.stage, input.projectId)
  }

  async clearAssignment(input: { stage: string; process: string; projectId?: string }): Promise<ResolvedAssignment[]> {
    assertProcess(input.stage, input.process)
    await this.store.clearAssignment({
      scope: input.projectId ?? FACTORY_SCOPE,
      stage: input.stage as ProjectStage,
      process: input.process,
    })
    return this.assignments(input.stage, input.projectId)
  }

  /** The composition a stage process should run with, or undefined for the default. */
  async composition(input: { projectId: string; stage: string; process: string }): Promise<AgentComposition | undefined> {
    const processes = STAGE_PROCESSES[input.stage as ProjectStage]
    if (processes === undefined || !processes.includes(input.process)) return undefined
    const rows = await this.store.assignments(input.stage as ProjectStage)
    const chosen = rows.find((row) => row.scope === input.projectId && row.process === input.process)
      ?? rows.find((row) => row.scope === FACTORY_SCOPE && row.process === input.process)
    if (chosen === undefined) return undefined
    const agent = await this.store.get(chosen.agentId)
    if (agent === undefined || agent.enabled === false) return undefined
    return compositionOf(agent)
  }

  async close(): Promise<void> {
    await this.store.close?.()
  }
}
