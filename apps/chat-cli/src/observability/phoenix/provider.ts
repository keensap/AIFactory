/**
 * Phoenix adapter for the observability ports.
 *
 * Files under `src/observability/phoenix/` are the only place that may import
 * OpenTelemetry or Phoenix-specific types. Core code depends on the ports only.
 */

import { SpanStatusCode, trace, type Span } from '@opentelemetry/api'
import type { PhoenixConfig } from './config.ts'
import { PhoenixClient } from './client.ts'
import { PhoenixTelemetry } from './telemetry.ts'
import type {
  ObservabilityHealth,
  ObservabilityProvider,
  ObservabilityReader,
  ObservabilitySummary,
  RoleTraceInput,
  RunTraceInput,
  TraceContext,
  TraceRecorder,
  TraceSpan,
  TraceStatus,
} from '../ports.ts'
import { ObservabilityError } from '../ports.ts'

class OtelTraceSpan implements TraceSpan {
  private readonly span: Span

  constructor(span: Span) {
    this.span = span
  }

  get traceId(): string {
    return this.span.spanContext().traceId
  }

  get spanId(): string {
    return this.span.spanContext().spanId
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.span.setAttribute(key, value)
  }

  addEvent(name: string, attributes?: Record<string, unknown>): void {
    this.span.addEvent(name, attributes as never)
  }

  recordException(error: unknown): void {
    this.span.recordException(error instanceof Error ? error : new Error(String(error)))
  }

  setStatus(status: TraceStatus, message?: string): void {
    this.span.setStatus({
      code: status === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      ...(message !== undefined ? { message } : {}),
    })
  }

  end(): void {
    this.span.end()
  }

  raw(): Span {
    return this.span
  }
}

function unwrap(span: TraceSpan | undefined): Span | undefined {
  return span instanceof OtelTraceSpan ? span.raw() : undefined
}

class PhoenixTraceRecorder implements TraceRecorder {
  private readonly telemetry: PhoenixTelemetry

  constructor(telemetry: PhoenixTelemetry) {
    this.telemetry = telemetry
  }

  startRun(input: RunTraceInput): TraceSpan | undefined {
    const span = this.telemetry.startRun(
      { id: input.projectId, name: input.projectName } as never,
      {
        id: input.runId,
        stage: input.stage,
        attempt: input.attempt,
        contextHash: input.contextHash ?? null,
        lockedBy: input.workerId ?? null,
        status: input.status,
      } as never,
    )
    return span === undefined ? undefined : new OtelTraceSpan(span)
  }

  startRole(input: RoleTraceInput): TraceSpan | undefined {
    const span = this.telemetry.startRole({
      projectId: input.projectId,
      runId: input.runId,
      role: input.role,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs,
      ...(input.parent !== undefined ? { parent: unwrap(input.parent) } : {}),
    })
    return span === undefined ? undefined : new OtelTraceSpan(span)
  }

  recordHarnessEvent(span: TraceSpan | undefined, event: Parameters<TraceRecorder['recordHarnessEvent']>[1]): void {
    this.telemetry.recordHarnessEvent(unwrap(span), event)
  }

  completeRole(span: TraceSpan | undefined, output: string): void {
    this.telemetry.completeRole(unwrap(span), output)
  }

  failRole(span: TraceSpan | undefined, error: unknown): void {
    this.telemetry.failRole(unwrap(span), error)
  }

  recordReview(span: TraceSpan | undefined, decision: string, findings: number): void {
    this.telemetry.recordReview(unwrap(span), decision, findings)
  }

  recordDocument(span: TraceSpan | undefined, kind: string, path: string): void {
    this.telemetry.recordDocument(unwrap(span), kind, path)
  }

  recordHumanDecision(projectId: string, runId: string, decision: string): void {
    this.telemetry.recordHumanDecision(projectId, runId, decision)
  }

  async forgetProject(projectId: string): Promise<void> {
    await this.telemetry.forgetProject(projectId)
  }

  currentTraceContext(): TraceContext | undefined {
    try {
      const span = trace.getActiveSpan()
      if (span === undefined) return undefined
      const context = span.spanContext()
      return { traceId: context.traceId, spanId: context.spanId }
    } catch {
      return undefined
    }
  }
}

class PhoenixReader implements ObservabilityReader {
  private readonly client: PhoenixClient
  private readonly telemetry: PhoenixTelemetry

  constructor(client: PhoenixClient, telemetry: PhoenixTelemetry) {
    this.client = client
    this.telemetry = telemetry
  }

  async summary(projectId: string, hours: number): Promise<ObservabilitySummary> {
    return this.client.summary(projectId, hours) as Promise<ObservabilitySummary>
  }

  async deleteProject(projectId: string): Promise<void> {
    try {
      await this.client.deleteProject(projectId)
    } catch (error) {
      throw new ObservabilityError(
        502,
        'OBSERVABILITY_DELETE_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  health(): ObservabilityHealth {
    const exporters = this.telemetry.health().map((entry) => entry.exporter)
    const rest = this.client.health()
    const openExporter = exporters.find((entry) => entry.state === 'open')
    const state = openExporter !== undefined || rest.state === 'open'
      ? 'open'
      : rest.state === 'degraded' || exporters.some((entry) => entry.failures > 0)
        ? 'degraded'
        : 'healthy'
    return {
      provider: 'phoenix',
      enabled: this.telemetry.enabled,
      state,
      projects: this.telemetry.projectCount,
      // Exports are span batches; REST requests are counted separately below.
      exports: exporters.reduce((sum, entry) => sum + entry.exports, 0) + rest.requests,
      failures: exporters.reduce((sum, entry) => sum + entry.failures, 0) + rest.failures,
      droppedSpans: exporters.reduce((sum, entry) => sum + entry.droppedSpans, 0),
      lastError: openExporter?.lastError ?? rest.lastError ?? exporters.find((entry) => entry.lastError !== null)?.lastError ?? null,
      openUntil: openExporter?.openUntil ?? rest.openUntil,
    }
  }
}

export class PhoenixObservabilityProvider implements ObservabilityProvider {
  readonly name = 'phoenix'
  readonly recorder: TraceRecorder
  readonly reader: ObservabilityReader
  private readonly telemetry: PhoenixTelemetry

  constructor(config: PhoenixConfig) {
    this.telemetry = new PhoenixTelemetry(config)
    this.recorder = new PhoenixTraceRecorder(this.telemetry)
    this.reader = new PhoenixReader(new PhoenixClient(config), this.telemetry)
  }

  async shutdown(timeoutMs?: number): Promise<void> {
    await this.telemetry.shutdown(timeoutMs)
  }
}

export function createPhoenixProvider(config: PhoenixConfig): ObservabilityProvider {
  return new PhoenixObservabilityProvider(config)
}

export { phoenixConfigFromEnv } from './config.ts'
export type { PhoenixConfig, PhoenixEnv } from './config.ts'
export { PhoenixError } from './errors.ts'
export { PhoenixClient } from './client.ts'
export { PhoenixTelemetry } from './telemetry.ts'
export { ResilientSpanExporter, type TelemetryExporterHealth } from './exporter.ts'
export {
  summarizeSpans,
  type PhoenixObservabilitySummary,
  type PhoenixRoleSummary,
  type PhoenixSpan,
} from './summary.ts'
