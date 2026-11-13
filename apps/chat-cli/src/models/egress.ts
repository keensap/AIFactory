/**
 * Egress policy.
 *
 * `AIFACTORY_MODEL_EGRESS=local-only` restricts model traffic to providers
 * marked local (llama.cpp, Ollama, …), for projects that must not leave the
 * host. It is enforced when a target is saved and on every routed call.
 *
 * Scope note: this governs the direct engines and target validation. The
 * harness's own profile default (when no target is configured) is outside it.
 */

import type { ProviderRecord } from './catalog/types.ts'
import { ModelSettingsError, type ModelTarget } from './settings.ts'

export function egressLocalOnly(env: Record<string, string | undefined>): boolean {
  return (env.AIFACTORY_MODEL_EGRESS ?? '').trim().toLowerCase() === 'local-only'
}

export function providerAllowed(provider: ProviderRecord, env: Record<string, string | undefined>): boolean {
  return !egressLocalOnly(env) || provider.local
}

/** Throws when any provider in the target chain would leave the host. */
export function assertEgress(
  target: ModelTarget,
  providers: ProviderRecord[],
  env: Record<string, string | undefined>,
): void {
  if (!egressLocalOnly(env)) return
  for (const ref of [target, ...target.fallback]) {
    const provider = providers.find((entry) => entry.id === ref.provider)
    if (provider !== undefined && !provider.local) {
      throw new ModelSettingsError(
        400,
        'EGRESS_BLOCKED',
        `provider "${provider.id}" is not local and AIFACTORY_MODEL_EGRESS=local-only`,
      )
    }
  }
}
