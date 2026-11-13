/**
 * Capability inference shared by discovery and the router.
 *
 * Catalogue rows are authoritative when present. For an unknown model the kind
 * of provider decides: cloud vendors support tools/thinking/JSON; local servers
 * are conservative because tool calling needs `llama-server --jinja` (or an
 * equivalent), which discovery cannot prove.
 */

import { defaultCapabilities, type ModelCapabilities } from './ports.ts'
import type { ModelRecord, ProviderRecord } from './catalog/types.ts'

export function inferCapabilities(provider: Pick<ProviderRecord, 'local' | 'kind'>): ModelCapabilities {
  if (provider.local) return defaultCapabilities()
  return {
    contextWindow: 8192,
    tools: true,
    thinking: true,
    jsonMode: true,
    vision: false,
    streaming: true,
  }
}

/** Capabilities for one model: the catalogue row wins, then inference. */
export function capabilitiesFor(
  provider: Pick<ProviderRecord, 'id' | 'local' | 'kind'>,
  model: string,
  catalog: readonly ModelRecord[],
): ModelCapabilities {
  const entry = catalog.find((candidate) => candidate.provider === provider.id && candidate.model === model)
  if (entry !== undefined) {
    return {
      ...entry.capabilities,
      contextWindow: entry.contextWindow ?? entry.capabilities.contextWindow,
      ...(entry.maxOutput !== null ? { maxOutputTokens: entry.maxOutput } : {}),
    }
  }
  return inferCapabilities(provider)
}
