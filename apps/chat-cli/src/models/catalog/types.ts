/**
 * Provider and model records.
 *
 * Providers are configuration rows; credentials are *references* to environment
 * variables, never values. Models come from the static catalogue and are filled
 * in by an explicit discovery action.
 */

import { defaultCapabilities, type ModelCapabilities } from '../ports.ts'

export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'openai-compatible'
  | 'azure-openai'
  | 'google'
  | 'bedrock'

export interface ProviderDefaults {
  temperature?: number
  maxTokens?: number
  reasoningEffort?: string
}

export interface ProviderRecord {
  id: string
  kind: ProviderKind
  displayName: string
  /** Endpoint root, e.g. `http://127.0.0.1:8080/v1`. Empty for vendor defaults. */
  baseUrl: string | null
  /** Environment variable that holds the key. Never the key itself. */
  apiKeyEnv: string | null
  headers: Record<string, string>
  defaults: ProviderDefaults
  enabled: boolean
  /** Local providers skip credentials and cloud-only policies. */
  local: boolean
  createdAt: string
  updatedAt: string
}

export interface ModelPrice {
  /** USD per one million tokens. */
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

export interface ModelRecord {
  provider: string
  model: string
  displayName: string | null
  contextWindow: number | null
  maxOutput: number | null
  capabilities: ModelCapabilities
  price: ModelPrice
  discoveredAt: string | null
}

/** Provider definitions seeded on first migration. */
export interface SeedProvider {
  id: string
  kind: ProviderKind
  displayName: string
  baseUrl: string | null
  apiKeyEnv: string | null
  local: boolean
  headers?: Record<string, string>
  defaults?: ProviderDefaults
}

export const SEED_PROVIDERS: readonly SeedProvider[] = [
  {
    id: 'anthropic',
    kind: 'anthropic',
    displayName: 'Anthropic (Claude)',
    baseUrl: null,
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    local: false,
  },
  {
    id: 'openai',
    kind: 'openai',
    displayName: 'OpenAI',
    baseUrl: null,
    apiKeyEnv: 'OPENAI_API_KEY',
    local: false,
  },
  {
    id: 'llamacpp',
    kind: 'openai-compatible',
    displayName: 'llama.cpp (local)',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKeyEnv: null,
    local: true,
  },
  {
    id: 'ollama',
    kind: 'openai-compatible',
    displayName: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKeyEnv: null,
    local: true,
  },
  {
    id: 'openrouter',
    kind: 'openai-compatible',
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    local: false,
    headers: { 'HTTP-Referer': 'https://aifactory.local', 'X-Title': 'AI Factory' },
  },
]

export function emptyCapabilities(): ModelCapabilities {
  return defaultCapabilities()
}

/** Environment variable naming for a provider override, e.g. `AIFACTORY_LLAMACPP_BASE_URL`. */
export function providerEnvPrefix(id: string): string {
  return `AIFACTORY_${id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
}
