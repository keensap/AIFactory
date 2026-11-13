/**
 * Routes a model request through the global target and its fallback chain.
 *
 *  - The target is a **snapshot** (`plan()`), taken when a run starts, so a
 *    settings change never alters a half-finished run.
 *  - Fallback follows the failure table in the design: transient failures and
 *    configuration problems on one provider move to the next target; failures
 *    that no other provider would change (content filter, caller abort) do not;
 *    a context overflow only falls back to a model with a larger window.
 *  - A stream falls back only before its first event: a partially delivered
 *    answer is never silently restarted on another model.
 *  - Cost is computed here, at call time, and stored with the response.
 */

import { effectiveProvider, type ModelPrice, type ModelRecord, type ProviderRecord } from './catalog/types.ts'
import { capabilitiesFor } from './capabilities.ts'
import { computeCost } from './cost.ts'
import { providerAllowed } from './egress.ts'
import { ModelError, assertCapabilities, type ModelErrorKind, type ModelEvent, type ModelRequest, type ModelResponse, type Usage } from './ports.ts'
import { EngineRegistry } from './registry.ts'
import type { ModelTarget, ResolvedTarget, TargetRef } from './settings.ts'

export type RouteRequest = Omit<ModelRequest, 'provider' | 'model'>

export interface RouteSource {
  /** Resolve the target and the catalogue it refers to. */
  resolve(): Promise<ResolvedTarget & { providers: ProviderRecord[]; models: ModelRecord[] }>
}

export interface PlannedRoute {
  ref: TargetRef
  provider: ProviderRecord | undefined
}

/** A frozen view of the target for one run. */
export interface RoutePlan {
  target: ModelTarget
  source: ResolvedTarget['source']
  routes: PlannedRoute[]
  models: readonly ModelRecord[]
}

export interface AttemptInfo {
  provider: string
  model: string
  /** 0 for the primary target, 1.. for fallbacks. */
  position: number
  outcome: 'ok' | 'error' | 'skipped'
  durationMs: number
  kind?: ModelErrorKind
  status?: number
  message?: string
  usage?: Usage
  costUsd?: number
  requestId?: string
  projectId?: string
  stageRunId?: string
  role?: string
}

export interface RouterOptions {
  source: RouteSource
  registry: EngineRegistry
  env: Record<string, string | undefined>
  /** Called for every attempt (success, failure or skip). Must not throw. */
  onAttempt?: (info: AttemptInfo) => void
  now?: () => number
}

export interface CallOptions {
  signal?: AbortSignal
  /** A plan captured earlier; omit to snapshot the current target. */
  plan?: RoutePlan
  /** Observer for this call only, in addition to the router-wide one. Must not throw. */
  onAttempt?: (info: AttemptInfo) => void
}

/** Whether the failure on `from` should be followed by an attempt on `to`. */
export function shouldFallBack(
  error: ModelError,
  from: { contextWindow: number },
  to: { contextWindow: number },
): boolean {
  switch (error.kind) {
    case 'aborted':
    case 'content_filter':
      return false
    case 'context_overflow':
      return to.contextWindow > from.contextWindow
    default:
      return true
  }
}

function priceOf(models: readonly ModelRecord[], provider: string, model: string): ModelPrice | undefined {
  return models.find((entry) => entry.provider === provider && entry.model === model)?.price
}

export class ModelRouter {
  private readonly source: RouteSource
  private readonly registry: EngineRegistry
  private readonly env: Record<string, string | undefined>
  private readonly onAttempt?: (info: AttemptInfo) => void
  private readonly now: () => number

  constructor(options: RouterOptions) {
    this.source = options.source
    this.registry = options.registry
    this.env = options.env
    if (options.onAttempt !== undefined) this.onAttempt = options.onAttempt
    this.now = options.now ?? Date.now
  }

  /** Snapshot the target for a run. Throws `unconfigured` when none is set. */
  async plan(): Promise<RoutePlan> {
    const resolved = await this.source.resolve()
    if (resolved.target === null) {
      throw new ModelError('unconfigured', 'no model is configured; set one with PATCH /api/settings/models or AIFACTORY_MODEL_PROVIDER/AIFACTORY_MODEL', { retryable: false })
    }
    this.registry.setCatalog(resolved.models)
    this.registry.retain(resolved.providers.map((provider) => provider.id))
    const byId = new Map(resolved.providers.map((provider) => [provider.id, effectiveProvider(provider, this.env)]))
    const refs: TargetRef[] = [resolved.target, ...resolved.target.fallback]
    return {
      target: resolved.target,
      source: resolved.source,
      routes: refs.map((ref) => ({ ref, provider: byId.get(ref.provider) })),
      models: resolved.models,
    }
  }

  private requestFor(input: RouteRequest, plan: RoutePlan, position: number, ref: TargetRef): ModelRequest {
    const { target } = plan
    const request: ModelRequest = { ...input, provider: ref.provider, model: ref.model }
    if (request.temperature === undefined && target.temperature !== undefined) request.temperature = target.temperature
    if (request.maxTokens === undefined && target.maxTokens !== undefined) request.maxTokens = target.maxTokens
    // Reasoning effort is provider-specific, so it only applies to the primary.
    if (position === 0 && request.reasoningEffort === undefined && target.reasoningEffort !== undefined) {
      request.reasoningEffort = target.reasoningEffort
    }
    return request
  }

  private report(info: AttemptInfo, request: ModelRequest, local?: (info: AttemptInfo) => void): void {
    const full: AttemptInfo = {
      ...info,
      ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
      ...(request.stageRunId !== undefined ? { stageRunId: request.stageRunId } : {}),
      ...(request.role !== undefined ? { role: request.role } : {}),
    }
    for (const observer of [this.onAttempt, local]) {
      try {
        observer?.(full)
      } catch {
        // Observers must never affect the call.
      }
    }
  }

  private withCost(response: ModelResponse, models: readonly ModelRecord[]): ModelResponse {
    const cost = computeCost(response.usage, priceOf(models, response.provider, response.model))
    return cost === undefined ? response : { ...response, costUsd: cost }
  }

  /** Why a route cannot be tried at all, before any network call. */
  private skipReason(route: PlannedRoute): ModelError | undefined {
    const { ref, provider } = route
    if (provider === undefined) return new ModelError('unavailable', `provider "${ref.provider}" no longer exists`, { provider: ref.provider, model: ref.model, retryable: false })
    if (!provider.enabled) return new ModelError('unavailable', `provider "${provider.id}" is disabled`, { provider: provider.id, model: ref.model, retryable: false })
    if (!providerAllowed(provider, this.env)) {
      return new ModelError('unavailable', `provider "${provider.id}" is blocked by AIFACTORY_MODEL_EGRESS=local-only`, { provider: provider.id, model: ref.model, retryable: false })
    }
    return undefined
  }

  private windowOf(plan: RoutePlan, route: PlannedRoute): number {
    return route.provider === undefined ? 0 : capabilitiesFor(route.provider, route.ref.model, plan.models).contextWindow
  }

  private failure(errors: Array<{ ref: TargetRef; error: ModelError }>, total: number): ModelError {
    const only = errors[0]
    if (total === 1 && only !== undefined) return only.error
    // Errors that no fallback should hide (e.g. the caller aborted) are surfaced as is.
    const last = errors.at(-1)
    if (last !== undefined && (last.error.kind === 'aborted' || last.error.kind === 'content_filter')) return last.error
    const summary = errors.map((entry) => `${entry.ref.provider}/${entry.ref.model}: ${entry.error.kind}`).join('; ')
    return new ModelError('unavailable', `all ${errors.length} model target(s) failed (${summary})`, {
      retryable: false,
      cause: errors.map((entry) => ({ provider: entry.ref.provider, model: entry.ref.model, kind: entry.error.kind, message: entry.error.message })),
    })
  }

  async complete(input: RouteRequest, options: CallOptions = {}): Promise<ModelResponse> {
    const plan = options.plan ?? await this.plan()
    const errors: Array<{ ref: TargetRef; error: ModelError }> = []
    for (let position = 0; position < plan.routes.length; position++) {
      const route = plan.routes[position]!
      const request = this.requestFor(input, plan, position, route.ref)
      const started = this.now()
      const skipped = this.skipReason(route)
      let error: ModelError | undefined = skipped
      if (error === undefined) {
        try {
          const engine = this.registry.engineFor(route.provider!)
          assertCapabilities(request, capabilitiesFor(route.provider!, route.ref.model, plan.models))
          const response = this.withCost(await engine.complete(request, options.signal), plan.models)
          this.report({
            provider: route.ref.provider, model: route.ref.model, position, outcome: 'ok', durationMs: this.now() - started,
            usage: response.usage, ...(response.costUsd !== undefined ? { costUsd: response.costUsd } : {}),
            ...(response.providerRequestId !== undefined ? { requestId: response.providerRequestId } : {}),
          }, request, options.onAttempt)
          return response
        } catch (raw) {
          error = raw instanceof ModelError ? raw : new ModelError('unknown', raw instanceof Error ? raw.message : String(raw), { provider: route.ref.provider, model: route.ref.model, cause: raw })
        }
      }
      errors.push({ ref: route.ref, error })
      this.report({
        provider: route.ref.provider, model: route.ref.model, position, outcome: skipped !== undefined ? 'skipped' : 'error',
        durationMs: this.now() - started, kind: error.kind, message: error.message,
        ...(error.status !== undefined ? { status: error.status } : {}),
      }, request, options.onAttempt)
      const next = plan.routes[position + 1]
      if (next === undefined || !shouldFallBack(error, { contextWindow: this.windowOf(plan, route) }, { contextWindow: this.windowOf(plan, next) })) break
    }
    throw this.failure(errors, plan.routes.length)
  }

  async *stream(input: RouteRequest, options: CallOptions = {}): AsyncIterable<ModelEvent> {
    const plan = options.plan ?? await this.plan()
    const errors: Array<{ ref: TargetRef; error: ModelError }> = []
    for (let position = 0; position < plan.routes.length; position++) {
      const route = plan.routes[position]!
      const request = this.requestFor(input, plan, position, route.ref)
      const started = this.now()
      const skipped = this.skipReason(route)
      let error: ModelError | undefined = skipped
      let emitted = false
      if (error === undefined) {
        try {
          const engine = this.registry.engineFor(route.provider!)
          assertCapabilities(request, capabilitiesFor(route.provider!, route.ref.model, plan.models))
          for await (const event of engine.stream(request, options.signal)) {
            emitted = true
            if (event.type === 'done') {
              const response = this.withCost(event.response, plan.models)
              this.report({
                provider: route.ref.provider, model: route.ref.model, position, outcome: 'ok', durationMs: this.now() - started,
                usage: response.usage, ...(response.costUsd !== undefined ? { costUsd: response.costUsd } : {}),
                ...(response.providerRequestId !== undefined ? { requestId: response.providerRequestId } : {}),
              }, request, options.onAttempt)
              yield { type: 'done', response }
            } else {
              yield event
            }
          }
          return
        } catch (raw) {
          error = raw instanceof ModelError ? raw : new ModelError('unknown', raw instanceof Error ? raw.message : String(raw), { provider: route.ref.provider, model: route.ref.model, cause: raw })
        }
      }
      errors.push({ ref: route.ref, error })
      this.report({
        provider: route.ref.provider, model: route.ref.model, position, outcome: skipped !== undefined ? 'skipped' : 'error',
        durationMs: this.now() - started, kind: error.kind, message: error.message,
        ...(error.status !== undefined ? { status: error.status } : {}),
      }, request, options.onAttempt)
      // Never restart a stream the consumer has already started reading.
      if (emitted) throw error
      const next = plan.routes[position + 1]
      if (next === undefined || !shouldFallBack(error, { contextWindow: this.windowOf(plan, route) }, { contextWindow: this.windowOf(plan, next) })) break
    }
    throw this.failure(errors, plan.routes.length)
  }
}
