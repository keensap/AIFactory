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

/** Harness rows that expose tools; an agent's allowlist is applied by disabling the rest. */
export const TOOL_ROW_IDS = [
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
  'tool-agent-team',
  'tool-todo',
  'tool-goal',
  'tool-skill',
  'tool-plugin-manager',
] as const


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
}

/**
 * Build the per-role overlay: persona, skills directory, tool allowlist and the
 * agent's model (declared on the Factory route, never a new provider).
 *
 * Applied *after* the model patch, so its `agent-default-model` wins.
 */
export function buildAgentPatch(input: AgentPatchInput): string {
  const rows: unknown[] = []

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

  if (
    input.composition.model !== null && input.composition.model !== ''
    && input.provider !== undefined && input.routes !== undefined
  ) {
    const routes: Record<string, AgentRouteProfile> = { ...input.routes }
    const route = routes[input.provider]
    if (route !== undefined) {
      const models = route.models ?? []
      if (!models.some((entry) => entry.id === input.composition.model)) {
        routes[input.provider] = { ...route, models: [...models, { id: input.composition.model }] }
      }
    }
    rows.push({ id: 'llm-pi-ai', config: { providers: routes } })
    rows.push({
      id: 'agent-default-model',
      config: {
        provider: input.provider,
        model: input.composition.model,
        ...(input.composition.reasoningEffort !== null && input.composition.reasoningEffort !== ''
          ? { reasoningEffort: input.composition.reasoningEffort }
          : {}),
      },
    })
  }

  // An empty allowlist means "no restriction": leave the profile's tools alone.
  if (input.composition.tools.length > 0) {
    for (const id of TOOL_ROW_IDS) {
      if (!input.composition.tools.includes(id)) rows.push({ id, disabled: true })
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
  options: { provider?: string; model?: string; routes?: Record<string, AgentRouteProfile> } = {},
): Promise<MaterialisedAgent> {
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
