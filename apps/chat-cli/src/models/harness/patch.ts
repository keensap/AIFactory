/**
 * Builds the DSH config overlay that applies the global model target.
 *
 * The overlay is a small JSON document (valid YAML) applied with
 * `dsh --profile <p> --patch <file>`:
 *
 *  - `llm-pi-ai` declares the routes (provider profiles) the target needs;
 *  - `agent-default-model` selects the provider/model every agent uses.
 *
 * No secret is written to the file: profiles reference `apiKeyEnv` names only.
 */

import { ModelSettingsError, type ModelTarget } from '../settings.ts'
import type { ModelRecord, ProviderRecord } from '../catalog/types.ts'

const PI_AI_PLUGIN_ID = 'llm-pi-ai'
const DEFAULT_MODEL_PLUGIN_ID = 'agent-default-model'
const FALLBACK_CONTEXT_WINDOW = 8192

export interface RouteModel {
  id: string
  contextWindow?: number
}

export interface RouteProfile {
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  models?: RouteModel[]
}

export interface ModelPatch {
  /** File content: JSON, which is valid YAML. */
  content: string
  /** Route name → profile, in stable order. */
  routes: Record<string, RouteProfile>
  /** Provider selected by `agent-default-model`. */
  provider: string
  model: string
  /** Environment variables the child process must keep. */
  requiredEnv: string[]
}

function routeName(provider: ProviderRecord): string {
  return provider.id
}

function contextWindowFor(model: string, models: ModelRecord[]): number | undefined {
  const entry = models.find((candidate) => candidate.model === model)
  return entry?.contextWindow ?? entry?.capabilities.contextWindow ?? undefined
}

function modelEntry(model: string, models: ModelRecord[], provider: ProviderRecord): RouteModel {
  const window = contextWindowFor(model, models)
    ?? (provider.local ? FALLBACK_CONTEXT_WINDOW : undefined)
  return window === undefined ? { id: model } : { id: model, contextWindow: window }
}

function profileFor(
  provider: ProviderRecord,
  wanted: string[],
  models: ModelRecord[],
): RouteProfile {
  const profile: RouteProfile = {}
  if (provider.apiKeyEnv !== null && provider.apiKeyEnv !== '') profile.apiKeyEnv = provider.apiKeyEnv
  if (provider.baseUrl !== null && provider.baseUrl !== '') profile.baseURL = provider.baseUrl
  if (Object.keys(provider.headers).length > 0) profile.headers = provider.headers
  if (provider.kind === 'openai-compatible') profile.api = 'openai-completions'
  const entries = wanted.map((model) => modelEntry(model, models, provider))
  if (entries.length > 0) profile.models = entries
  return profile
}

/** Validate that a provider can be expressed in a harness patch. */
export function assertRoutable(provider: ProviderRecord): void {
  if (provider.kind === 'openai-compatible' && (provider.baseUrl === null || provider.baseUrl === '')) {
    throw new ModelSettingsError(
      400,
      'PATCH_INVALID_PROVIDER',
      `provider "${provider.id}" needs a baseUrl to be used by the harness`,
    )
  }
  if (provider.kind === 'google' || provider.kind === 'bedrock' || provider.kind === 'azure-openai') {
    throw new ModelSettingsError(
      400,
      'PROVIDER_NOT_SUPPORTED',
      `provider "${provider.id}" (${provider.kind}) is not wired for harness runs yet`,
    )
  }
}

export function buildModelPatch(input: {
  target: ModelTarget
  providers: ProviderRecord[]
  models: ModelRecord[]
}): ModelPatch {
  const refs = [input.target, ...input.target.fallback]
  const byProvider = new Map<string, string[]>()
  for (const ref of refs) {
    const list = byProvider.get(ref.provider) ?? []
    if (!list.includes(ref.model)) list.push(ref.model)
    byProvider.set(ref.provider, list)
  }

  const routes: Record<string, RouteProfile> = {}
  const requiredEnv: string[] = []
  for (const [providerId, wanted] of byProvider) {
    const provider = input.providers.find((candidate) => candidate.id === providerId)
    if (provider === undefined) {
      throw new ModelSettingsError(400, 'PROVIDER_NOT_FOUND', `unknown provider "${providerId}"`)
    }
    if (!provider.enabled) {
      throw new ModelSettingsError(400, 'PROVIDER_DISABLED', `provider "${providerId}" is disabled`)
    }
    assertRoutable(provider)
    routes[routeName(provider)] = profileFor(provider, wanted, input.models)
    if (provider.apiKeyEnv !== null && provider.apiKeyEnv !== '' && !requiredEnv.includes(provider.apiKeyEnv)) {
      requiredEnv.push(provider.apiKeyEnv)
    }
  }

  const document = [
    { id: PI_AI_PLUGIN_ID, config: { providers: routes } },
    {
      id: DEFAULT_MODEL_PLUGIN_ID,
      config: {
        provider: input.target.provider,
        model: input.target.model,
        ...(input.target.reasoningEffort !== undefined ? { reasoningEffort: input.target.reasoningEffort } : {}),
      },
    },
  ]

  return {
    content: `${JSON.stringify(document, null, 2)}\n`,
    routes,
    provider: input.target.provider,
    model: input.target.model,
    requiredEnv,
  }
}

/** Environment variables this module manages on behalf of providers. */
export const MANAGED_KEY_PATTERN = /^(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|AZURE_OPENAI_API_KEY)$/

/**
 * Keys to remove from the child environment: every managed provider key that
 * the selected routes do not need. Keeps unrelated credentials (e.g. the
 * harness's own DeepSeek key) untouched.
 */
export function keysToScrub(env: Record<string, string | undefined>, keep: string[]): string[] {
  return Object.keys(env).filter((key) => MANAGED_KEY_PATTERN.test(key) && !keep.includes(key))
}
