export {
  addUsage,
  assertCapabilities,
  defaultCapabilities,
  emptyUsage,
  isRetryable,
  kindFromStatus,
  missingCapabilities,
  modelErrorFromStatus,
  ModelError,
  normalizeUsage,
  type ChatMessage,
  type ChatRole,
  type EngineHealth,
  type EngineState,
  type FinishReason,
  type ModelCapabilities,
  type ModelEngine,
  type ModelErrorKind,
  type ModelErrorOptions,
  type ModelEvent,
  type ModelRequest,
  type ModelResponse,
  type ResponseFormat,
  type ToolCall,
  type ToolSchema,
  type Usage,
} from './ports.ts'
export { FakeEngine, createFakeEngine, type FakeEngineOptions } from './fake.ts'

export { PostgresModelCatalog } from './catalog/store.ts'
export type { ModelCatalog } from './catalog/store.ts'
export { SEED_PROVIDERS, providerEnvPrefix } from './catalog/types.ts'
export type { ModelPrice, ModelRecord, ProviderDefaults, ProviderKind, ProviderRecord, SeedProvider } from './catalog/types.ts'
export { discoverModels, probeProvider } from './catalog/probe.ts'
export type { DiscoveredModel, ProviderHealth, ProviderState } from './catalog/probe.ts'
export {
  MAX_FALLBACK,
  MAX_TOKENS_LIMIT,
  ModelSettingsError,
  PostgresModelSettingsStore,
  credentialPresent,
  normalizeStoredTarget,
  resolveTarget,
  targetFromEnvironment,
  targetWarnings,
  validateTarget,
} from './settings.ts'
export type {
  ModelSettings,
  ModelSettingsStore,
  ModelTarget,
  ResolvedTarget,
  TargetRef,
  TargetSource,
} from './settings.ts'
export { ModelService } from './service.ts'
export type { DiscoveryResult, ModelServiceOptions, ProviderView, TargetView, TestCallInput, TestCallResult } from './service.ts'
export { buildModelPatch, assertRoutable, keysToScrub, MANAGED_KEY_PATTERN } from './harness/patch.ts'
export type { ModelPatch, RouteModel, RouteProfile } from './harness/patch.ts'
export { ModelRuntime } from './harness/runtime.ts'
export type { ModelRuntimeOptions, ModelRuntimeStatus } from './harness/runtime.ts'
export { CircuitBreaker, ResilientEngine, backoffDelay } from './resilience.ts'
export type { BreakerOptions, BreakerSnapshot, BreakerState, ResilienceOptions } from './resilience.ts'
export { OpenAICompatibleEngine, mapOpenAIUsage } from './engines/openai-compatible.ts'
export type { OpenAIEngineOptions } from './engines/openai-compatible.ts'
export { AnthropicEngine, mapAnthropicUsage } from './engines/anthropic.ts'
export type { AnthropicEngineOptions } from './engines/anthropic.ts'
export { capabilitiesFor, inferCapabilities } from './capabilities.ts'
export { computeCost } from './cost.ts'
export { assertEgress, egressLocalOnly, providerAllowed } from './egress.ts'
export { effectiveProvider } from './catalog/types.ts'
export { EngineRegistry, DEFAULT_TUNING, tuningFromEnvironment } from './registry.ts'
export type { ProviderRuntime, RegistryOptions, RegistryTuning } from './registry.ts'
export { ModelRouter, shouldFallBack } from './router.ts'
export type { AttemptInfo, CallOptions, PlannedRoute, RouteRequest, RoutePlan, RouteSource, RouterOptions } from './router.ts'
export { attributeUsage, roleModel } from './attribution.ts'
export type { ModelAttribution, RoleModel } from './attribution.ts'
export type { ModelPin } from './harness/runtime.ts'
