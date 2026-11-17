/**
 * The per-agent overlay applied to a role's harness process.
 *
 * This is core, not a model adapter: it is the AI Factory's own composition
 * (persona, tool allowlist, skills, model within the Factory provider). The
 * adapter that writes the model patch re-exports nothing from here, and core
 * files stay free of adapter imports.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface AgentRouteModel {
  id: string
  contextWindow?: number
}

export interface AgentRouteProfile {
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  models?: AgentRouteModel[]
}

/**
 * Harness `tool-*` rows, classified so an allowlist can be applied **fail-closed**.
 *
 * A harness entry is either a tool the model can call (`model`) or plumbing that
 * must stay enabled for tools to work at all (`infrastructure`). Only `model`
 * rows are governed by an agent's allowlist; `infrastructure` rows are never
 * disabled. An unclassified row disables restricted agents rather than granting
 * a tool nobody chose (see `classifyToolRows`).
 */

/** Rows that expose one or more model-facing tools. An agent's allowlist selects among these. */
export const MODEL_FACING_TOOL_ROWS = [
  'tool-working-directory',
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'tool-web',
  'tool-workflow',
  'tool-subagent',
  'tool-subagent-control',
  'tool-subagent-fork',
  'tool-agent-team',
  'tool-todo',
  'tool-goal',
  'tool-skill',
  'tool-plugin-manager',
] as const

/** Rows that must never be disabled: disabling them breaks tool execution itself. */
export const INFRASTRUCTURE_TOOL_ROWS = [
  'tool-executor-native',
  'tool-executor-ptc',
  'tool-result-pruner',
] as const

/** Values an agent's `tools` allowlist accepts. */
export const TOOL_ROW_IDS: readonly string[] = MODEL_FACING_TOOL_ROWS

/**
 * Tools that read from harness services an agent configures elsewhere, so that a
 * composition that sets them up without the tool is rejected rather than silently
 * useless. `tool-skill` is what makes materialised `SKILL.md` files reachable.
 */
export const TOOL_REQUIREMENTS: ReadonlyArray<{
  tool: string
  requiredBy: 'skills'
  code: string
  message: string
}> = [
  {
    tool: 'tool-skill',
    requiredBy: 'skills',
    code: 'AGENT_SKILLS_NEED_SKILL_TOOL',
    message: 'an agent with skills needs "tool-skill" in its tools, otherwise the model cannot load them',
  },
]

/** An agent has configured something (skills) whose tool is excluded by its allowlist. */
export class ToolRequirementError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ToolRequirementError'
    this.code = code
  }
}

/**
 * Reject a composition whose allowlist excludes the tool that makes a configured
 * feature reachable. Not applied when the allowlist is empty (no restriction).
 */
export function assertToolRequirements(input: { tools: readonly string[]; hasSkills: boolean }): void {
  if (input.tools.length === 0) return
  for (const requirement of TOOL_REQUIREMENTS) {
    const configured = requirement.requiredBy === 'skills' ? input.hasSkills : false
    if (configured && !input.tools.includes(requirement.tool)) {
      throw new ToolRequirementError(requirement.code, requirement.message)
    }
  }
}

export interface ToolClassification {
  modelFacing: string[]
  infrastructure: string[]
  /** Rows present in the profile that this module does not know about. */
  unclassified: string[]
}

/** Split the profile's `tool-*` row ids into the two classes, and surface drift. */
export function classifyToolRows(rows: readonly string[]): ToolClassification {
  const modelFacing: string[] = []
  const infrastructure: string[] = []
  const unclassified: string[] = []
  const known = new Set<string>([...MODEL_FACING_TOOL_ROWS, ...INFRASTRUCTURE_TOOL_ROWS])
  for (const row of rows) {
    if (!row.startsWith('tool-')) continue
    if ((MODEL_FACING_TOOL_ROWS as readonly string[]).includes(row)) modelFacing.push(row)
    else if ((INFRASTRUCTURE_TOOL_ROWS as readonly string[]).includes(row)) infrastructure.push(row)
    else if (!known.has(row)) unclassified.push(row)
  }
  return { modelFacing: modelFacing.sort(), infrastructure: infrastructure.sort(), unclassified: unclassified.sort() }
}

/** Thrown when the tool set cannot be classified safely. */
export class ToolsetUnverifiedError extends Error {
  readonly code = 'AGENT_TOOLSET_UNVERIFIED'
  readonly unclassified: string[]

  constructor(unclassified: string[]) {
    super(
      `the harness exposes tool row(s) this version does not classify: ${unclassified.join(', ')}. `
      + 'Refusing to apply a tool allowlist that might grant them. Update MODEL_FACING_TOOL_ROWS/'
      + 'INFRASTRUCTURE_TOOL_ROWS in agent-patch.ts.',
    )
    this.name = 'ToolsetUnverifiedError'
    this.unclassified = unclassified
  }
}

/** Refuse to restrict tools when the profile contains a row we cannot classify. */
export function assertToolsetClassified(rows: readonly string[]): ToolClassification {
  const classification = classifyToolRows(rows)
  if (classification.unclassified.length > 0) throw new ToolsetUnverifiedError(classification.unclassified)
  return classification
}

/** What an agent changes in its role's harness composition. */
export interface AgentPatchInput {
  composition: {
    persona: string | null
    model: string | null
    reasoningEffort: string | null
    tools: string[]
  }
  /** The Factory provider: an agent never switches provider. */
  provider?: string
  /** The Factory model, used when the agent does not choose one. */
  model?: string
  /** Routes from the model patch, so an agent model is declared on the same route. */
  routes?: Record<string, AgentRouteProfile>
  /** Directory of materialised SKILL.md bundles, when the agent has skills. */
  skillsDir?: string
  /**
   * Model to select when `composition.model` is null (the probe's stand-in, or
   * the Factory target). Without this an agent that chose no model would keep the
   * profile default and bypass the probe's endpoint.
   */
  effectiveModel?: string
  /**
   * The harness profile's `tool-*` row ids. When supplied, an unclassified row
   * refuses the allowlist instead of possibly granting it.
   */
  profileToolRows?: readonly string[]
}

/**
 * Build the per-role overlay: persona, skills directory, tool allowlist and the
 * agent's model (declared on the Factory route, never a new provider).
 *
 * Applied *after* the model patch, so its `agent-default-model` wins.
 */
export function buildAgentPatch(input: AgentPatchInput): string {
  const rows: unknown[] = []
  const restricted = input.composition.tools.length > 0
  // Fail closed: verify the profile before trusting a deny list built from it.
  const classification = restricted && input.profileToolRows !== undefined
    ? assertToolsetClassified(input.profileToolRows)
    : undefined

  if (input.composition.persona !== null && input.composition.persona.trim() !== '') {
    // Replaces the entry's config wholesale; the other fields keep their defaults.
    rows.push({ id: 'system-prompt', config: { personaPrefix: input.composition.persona } })
  }

  if (input.skillsDir !== undefined) {
    rows.push({
      id: 'skill-filesystem',
      config: { includeDefaultRoots: false, customSkillDirs: [input.skillsDir] },
    })
  }

  const selectedModel = input.composition.model !== null && input.composition.model !== ''
    ? input.composition.model
    : input.effectiveModel
  if (
    selectedModel !== undefined && selectedModel !== ''
    && input.provider !== undefined && input.routes !== undefined
  ) {
    const routes: Record<string, AgentRouteProfile> = { ...input.routes }
    const route = routes[input.provider]
    if (route !== undefined) {
      const models = route.models ?? []
      if (!models.some((entry) => entry.id === selectedModel)) {
        routes[input.provider] = { ...route, models: [...models, { id: selectedModel }] }
      }
    }
    rows.push({ id: 'llm-pi-ai', config: { providers: routes } })
    rows.push({
      id: 'agent-default-model',
      config: {
        provider: input.provider,
        model: selectedModel,
        ...(input.composition.reasoningEffort !== null && input.composition.reasoningEffort !== ''
          ? { reasoningEffort: input.composition.reasoningEffort }
          : {}),
      },
    })
  }

  // An empty allowlist means "no restriction": leave the profile's tools alone.
  if (restricted) {
    // Disable every model-facing row the agent did not allow. Infrastructure rows
    // are never touched, and an unclassified row is refused above rather than left on.
    for (const id of MODEL_FACING_TOOL_ROWS) {
      if (!input.composition.tools.includes(id)) rows.push({ id, disabled: true })
    }
    for (const id of classification?.unclassified ?? []) {
      rows.push({ id, disabled: true })
    }
  }

  return `${JSON.stringify(rows, null, 2)}\n`
}

/** The parts of an agent a run needs; `AgentComposition` satisfies it. */
export interface MaterialisedAgentInput {
  id: string
  persona: string | null
  model: string | null
  reasoningEffort: string | null
  tools: string[]
  skills: Array<{ name: string; description: string; instructions: string }>
}

export interface MaterialisedAgent {
  patchPath: string
  skillsDir: string | null
  /** Remove the patch file; skill bundles stay for inspection. */
  cleanup(): Promise<void>
}

/**
 * Write an agent's composition into `workspace` as a patch file plus `SKILL.md`
 * bundles the harness can discover. Shared by stage runs and the probe so both
 * exercise exactly the same composition.
 */
export async function materialiseAgent(
  workspace: string,
  agent: MaterialisedAgentInput,
  options: {
    provider?: string
    model?: string
    routes?: Record<string, AgentRouteProfile>
    profileToolRows?: readonly string[]
  } = {},
): Promise<MaterialisedAgent> {
  // A definition saved before this rule existed must not silently lose its skills.
  assertToolRequirements({ tools: agent.tools, hasSkills: agent.skills.length > 0 })
  const base = join(workspace, '.aifactory', 'agents', agent.id)
  let skillsDir: string | null = null
  if (agent.skills.length > 0) {
    skillsDir = join(base, 'skills')
    for (const skill of agent.skills) {
      const dir = join(skillsDir, skill.name)
      await mkdir(dir, { recursive: true })
      const description = skill.description === '' ? skill.name : skill.description
      await writeFile(
        join(dir, 'SKILL.md'),
        `---\nname: ${skill.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${skill.instructions}\n`,
        'utf8',
      )
    }
  }
  const content = buildAgentPatch({
    composition: {
      persona: agent.persona,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      tools: agent.tools,
    },
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.routes !== undefined ? { routes: options.routes } : {}),
    ...(skillsDir !== null ? { skillsDir } : {}),
    ...(options.model !== undefined ? { effectiveModel: options.model } : {}),
    ...(options.profileToolRows !== undefined ? { profileToolRows: options.profileToolRows } : {}),
  })
  const dir = join(base, 'tmp')
  await mkdir(dir, { recursive: true })
  const patchPath = join(dir, `patch-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
  await writeFile(patchPath, content, 'utf8')
  return {
    patchPath,
    skillsDir,
    cleanup: async () => { await rm(patchPath, { force: true }).catch(() => {}) },
  }
}
