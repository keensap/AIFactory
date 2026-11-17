/**
 * The per-agent overlay applied to a role's harness process.
 *
 * This is core, not a model adapter: it is the AI Factory's own composition
 * (persona, tool allowlist, skills, model within the Factory provider). The
 * adapter that writes the model patch re-exports nothing from here, and core
 * files stay free of adapter imports.
 */

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
