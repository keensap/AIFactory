/**
 * Phoenix adapter configuration.
 *
 * All Phoenix-specific environment variables are parsed here, so the core
 * composition root only deals with a provider-neutral config.
 */

export interface PhoenixConfig {
  baseUrl: string
  /** OTLP gRPC endpoint, for example http://127.0.0.1:4317. */
  otlpEndpoint?: string
  apiKey?: string
  projectPrefix: string
  serviceName: string
  environment: string
  captureContent: boolean
  captureMaxChars: number
  retentionHours: number
  enabled: boolean
  /** Per OTLP export attempt timeout (default 5000 ms). */
  otlpTimeoutMs?: number
  /** Consecutive failed exports before the telemetry breaker opens (default 3). */
  otlpBreakerThreshold?: number
  /** Telemetry exporter cool-down (default 30 000 ms). */
  otlpBreakerCooldownMs?: number
  /** Upper bound for provider shutdown (default 3000 ms). */
  shutdownTimeoutMs?: number
  /** REST request timeout (default 5000 ms). */
  requestTimeoutMs?: number
  /** Maximum live per-project tracer providers (default 64). */
  maxProjectProviders?: number
  /** Close a provider unused for this long (default 10 min, minimum 1 min). */
  providerIdleTimeoutMs?: number
}

export type PhoenixEnv = Record<string, string | undefined>

function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase())
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Build a config from environment variables. Returns `undefined` when Phoenix
 * is disabled, so the caller can fall back to the no-op provider.
 */
export function phoenixConfigFromEnv(env: PhoenixEnv = process.env): PhoenixConfig | undefined {
  if (!isEnabled(env.AIFACTORY_PHOENIX_ENABLED)) return undefined
  const apiKey = env.AIFACTORY_PHOENIX_API_KEY
  return {
    baseUrl: env.AIFACTORY_PHOENIX_URL ?? 'http://127.0.0.1:6006',
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4317',
    projectPrefix: env.AIFACTORY_PHOENIX_PROJECT_PREFIX ?? 'aifactory-',
    serviceName: env.OTEL_SERVICE_NAME ?? 'aifactory',
    environment: env.AIFACTORY_PHOENIX_ENVIRONMENT ?? 'local',
    captureContent: isEnabled(env.AIFACTORY_PHOENIX_CAPTURE_CONTENT),
    captureMaxChars: positiveInt(env.AIFACTORY_PHOENIX_CAPTURE_MAX_CHARS, 2000),
    retentionHours: positiveInt(env.AIFACTORY_PHOENIX_RETENTION_HOURS, 24),
    enabled: true,
    otlpTimeoutMs: positiveInt(env.AIFACTORY_PHOENIX_OTLP_TIMEOUT_MS, 5000),
    otlpBreakerThreshold: positiveInt(env.AIFACTORY_PHOENIX_BREAKER_THRESHOLD, 3),
    otlpBreakerCooldownMs: positiveInt(env.AIFACTORY_PHOENIX_BREAKER_COOLDOWN_MS, 30_000),
    shutdownTimeoutMs: positiveInt(env.AIFACTORY_PHOENIX_SHUTDOWN_TIMEOUT_MS, 3000),
    requestTimeoutMs: positiveInt(env.AIFACTORY_PHOENIX_REQUEST_TIMEOUT_MS, 5000),
    maxProjectProviders: positiveInt(env.AIFACTORY_PHOENIX_MAX_PROVIDERS, 64),
    providerIdleTimeoutMs: positiveInt(env.AIFACTORY_PHOENIX_PROVIDER_IDLE_MS, 600_000),
    ...(apiKey !== undefined && apiKey !== '' ? { apiKey } : {}),
  }
}
