/**
 * Observability provider registry.
 *
 * The composition root asks for a provider by name instead of constructing a
 * vendor class. Adding a monitor means registering a factory here.
 */

import { noopProvider } from '../noop.ts'
import { createMemoryProvider } from '../memory.ts'
import type { ObservabilityProvider } from '../ports.ts'
import { createPhoenixProvider, phoenixConfigFromEnv } from '../phoenix/index.ts'

export type ObservabilityProviderName = 'phoenix' | 'noop' | 'memory' | string

export interface ProviderFactoryContext {
  env: Record<string, string | undefined>
}

export type ObservabilityProviderFactory = (context: ProviderFactoryContext) => ObservabilityProvider | undefined

const factories = new Map<string, ObservabilityProviderFactory>()

export function registerObservabilityProvider(name: string, factory: ObservabilityProviderFactory): void {
  factories.set(name, factory)
}

registerObservabilityProvider('phoenix', ({ env }) => {
  const config = phoenixConfigFromEnv(env)
  return config === undefined ? undefined : createPhoenixProvider(config)
})

registerObservabilityProvider('noop', () => noopProvider)
// In-process provider for tests and local development; bounded, never a monitor.
registerObservabilityProvider('memory', () => createMemoryProvider())

/**
 * Select a provider.
 *
 * Order: `AIFACTORY_OBSERVABILITY_PROVIDER` when set, otherwise Phoenix when
 * `AIFACTORY_PHOENIX_ENABLED` is truthy, otherwise the no-op provider.
 * An unknown or misconfigured provider falls back to no-op: observability must
 * never prevent the API from starting.
 */
export function createObservabilityProvider(
  env: Record<string, string | undefined> = process.env,
): ObservabilityProvider {
  const explicit = env.AIFACTORY_OBSERVABILITY_PROVIDER?.trim().toLowerCase()
  const name = explicit !== undefined && explicit !== '' ? explicit : 'phoenix'
  const factory = factories.get(name)
  if (factory === undefined) return noopProvider
  try {
    return factory({ env }) ?? noopProvider
  } catch {
    return noopProvider
  }
}

export function listObservabilityProviders(): string[] {
  return [...factories.keys()].sort()
}
