/**
 * Phoenix adapter public surface.
 *
 * Only this adapter (and the provider registry) may import Phoenix/OTel code.
 */

export {
  createPhoenixProvider,
  phoenixConfigFromEnv,
  PhoenixClient,
  PhoenixError,
  PhoenixObservabilityProvider,
  PhoenixTelemetry,
  ResilientSpanExporter,
  summarizeSpans,
  type PhoenixConfig,
  type PhoenixEnv,
  type PhoenixObservabilitySummary,
  type PhoenixRoleSummary,
  type PhoenixSpan,
  type TelemetryExporterHealth,
} from './provider.ts'
