/**
 * OTLP trace writer: one tracer provider per project.
 */

import { context, SpanKind, SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc'
import { Resource } from '@opentelemetry/resources'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import type { HarnessEvent } from '../../protocol.ts'
import type { Project } from '../../projects.ts'
import type { StageRun } from '../../workspace.ts'
import type { PhoenixConfig } from './config.ts'
import { ResilientSpanExporter, settleWithin, type TelemetryExporterHealth } from './exporter.ts'

export class PhoenixTelemetry {
  private readonly config: PhoenixConfig
  private readonly providers = new Map<string, { provider: NodeTracerProvider; tracer: Tracer }>()
  private readonly exporters = new Map<string, ResilientSpanExporter>()
  private readonly lastUsed = new Map<string, number>()
  private readonly maxProviders: number
  private readonly idleTimeoutMs: number
  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined
  private evictions = 0

  constructor(config: PhoenixConfig) {
    this.config = config
    this.maxProviders = Math.max(1, config.maxProjectProviders ?? 64)
    this.idleTimeoutMs = Math.max(60_000, config.providerIdleTimeoutMs ?? 600_000)
    this.sweepTimer = setInterval(() => { this.evictIdle() }, 60_000)
    this.sweepTimer.unref?.()
  }

  /** Number of live per-project providers (diagnostics/tests). */
  get projectCount(): number {
    return this.providers.size
  }

  /** Number of providers closed because of the cap or idleness. */
  get evicted(): number {
    return this.evictions
  }

  /**
   * Close and forget one project's provider. Called on project deletion and by
   * the cap/idle sweeper. Never throws and never blocks the caller.
   */
  async forgetProject(projectId: string): Promise<void> {
    const entry = this.providers.get(projectId)
    this.providers.delete(projectId)
    this.exporters.delete(projectId)
    this.lastUsed.delete(projectId)
    if (entry === undefined) return
    await settleWithin(entry.provider.shutdown().catch(() => undefined), this.config.shutdownTimeoutMs ?? 3000)
  }

  get enabled(): boolean {
    return this.config.enabled
  }

  /** Exporter health per project; useful for diagnostics and tests. */
  health(): Array<{ projectId: string; exporter: TelemetryExporterHealth }> {
    return [...this.exporters.entries()].map(([projectId, exporter]) => ({ projectId, exporter: exporter.health() }))
  }

  startRun(project: Project, run: StageRun): Span | undefined {
    if (!this.config.enabled) return undefined
    try {
      const span = this.tracer(project.id).startSpan('stage.run', {
      kind: SpanKind.INTERNAL,
      attributes: {
        'openinference.span.kind': 'CHAIN',
        'project.id': project.id,
        'project.name': project.name,
        stage: run.stage,
        'run.id': run.id,
        'run.attempt': run.attempt,
        'context.hash': run.contextHash ?? '',
        'worker.id': run.lockedBy ?? '',
        status: run.status,
      },
      })
      return span
    } catch {
      return undefined
    }
  }

  startRole(input: {
    parent?: Span
    projectId: string
    runId: string
    role: string
    prompt: string
    timeoutMs: number
  }): Span | undefined {
    if (!this.config.enabled) return undefined
    try {
    const attributes: Record<string, string | number> = {
      'openinference.span.kind': 'LLM',
      'project.id': input.projectId,
      'run.id': input.runId,
      role: input.role,
      'timeout.ms': input.timeoutMs,
    }
    if (this.config.captureContent) attributes['llm.input_messages'] = truncate(input.prompt, this.config.captureMaxChars)
    const parentContext = input.parent === undefined ? context.active() : trace.setSpan(context.active(), input.parent)
    return this.tracer(input.projectId).startSpan(`stage.role.${input.role}`, { kind: SpanKind.INTERNAL, attributes }, parentContext)
    } catch {
      return undefined
    }
  }

  recordHarnessEvent(span: Span | undefined, event: HarnessEvent): void {
    if (span === undefined) return
    try {
      this.recordHarnessEventUnsafe(span, event)
    } catch {
      // Telemetry must never fail a stage run.
    }
  }

  private recordHarnessEventUnsafe(span: Span, event: HarnessEvent): void {
    if (event.type === 'thinking') {
      span.addEvent('thinking', this.config.captureContent
        ? { text: truncate(String(event.text ?? ''), this.config.captureMaxChars) }
        : { length: String(event.text ?? '').length })
      return
    }
    if (event.type === 'text') {
      span.addEvent('text', this.config.captureContent
        ? { text: truncate(String(event.text ?? ''), this.config.captureMaxChars) }
        : { length: String(event.text ?? '').length })
      return
    }
    if (event.type === 'tool_call') {
      const tool = typeof event.tool === 'string' ? event.tool : typeof event.name === 'string' ? event.name : 'unknown'
      const attributes: Record<string, string> = {
        tool,
        callId: String(event.callId ?? ''),
      }
      if (this.config.captureContent) {
        attributes.input = truncate(JSON.stringify(event.input ?? event.arguments ?? {}), this.config.captureMaxChars)
      }
      span.addEvent('tool_call', attributes)
      return
    }
    if (event.type === 'tool_result') {
      const result = String(event.result ?? '')
      const attributes: Record<string, string> = {
        callId: String(event.callId ?? ''),
        status: String(event.status ?? ''),
        size: String(result.length),
      }
      if (this.config.captureContent) attributes.result = truncate(result, this.config.captureMaxChars)
      span.addEvent('tool_result', attributes)
      return
    }
    if (event.type === 'status' && event.usage !== undefined && typeof event.usage === 'object') {
      const usage = event.usage as Record<string, unknown>
      const tokenAttributes: Record<string, string> = {
        inputTokens: 'llm.token_count.prompt',
        outputTokens: 'llm.token_count.completion',
        totalTokens: 'llm.token_count.total',
        reasoningTokens: 'llm.token_count.reasoning',
      }
      for (const [key, attribute] of Object.entries(tokenAttributes)) {
        const value = usage[key]
        if (typeof value === 'number') span.setAttribute(attribute, value)
      }
    }
  }

  completeRole(span: Span | undefined, output: string): void {
    if (span === undefined) return
    try {
      span.setAttribute('status', 'completed')
      if (this.config.captureContent) span.setAttribute('llm.output_messages', truncate(output, this.config.captureMaxChars))
      span.setStatus({ code: SpanStatusCode.OK })
      span.end()
    } catch {
      // Telemetry must never fail a stage run.
    }
  }

  failRole(span: Span | undefined, error: unknown): void {
    if (span === undefined) return
    try {
      span.setAttribute('status', 'failed')
      span.recordException(error instanceof Error ? error : new Error(String(error)))
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) })
      span.end()
    } catch {
      // Telemetry must never fail a stage run.
    }
  }

  recordReview(span: Span | undefined, decision: string, findings: number): void {
    try {
      span?.addEvent('review.decision', { decision, findings })
    } catch {}
  }

  recordDocument(span: Span | undefined, kind: string, path: string): void {
    try {
      span?.addEvent('document.created', {
        kind,
        path: this.config.captureContent ? truncate(path, this.config.captureMaxChars) : '[redacted]',
      })
    } catch {}
  }

  recordHumanDecision(projectId: string, runId: string, decision: string): void {
    if (!this.config.enabled) return
    try {
    const span = this.tracer(projectId).startSpan('stage.human_decision', {
      kind: SpanKind.INTERNAL,
      attributes: {
        'openinference.span.kind': 'CHAIN',
        'project.id': projectId,
        'run.id': runId,
        decision,
      },
      })
      span.end()
    } catch {
      // Telemetry must never fail a stage run.
    }
  }

  /**
   * Flush and close every provider within a deadline. A dead Phoenix endpoint
   * must not delay API shutdown, so each provider is bounded and errors ignored.
   */
  async shutdown(timeoutMs = this.config.shutdownTimeoutMs ?? 3000): Promise<void> {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    const entries = [...this.providers.values()]
    this.providers.clear()
    this.exporters.clear()
    this.lastUsed.clear()
    await Promise.all(entries.map(async ({ provider }) => {
      try {
        await settleWithin(provider.shutdown().catch(() => undefined), timeoutMs)
      } catch {
        // Observability shutdown is best-effort.
      }
    }))
  }

  /** Close providers unused for longer than the idle timeout. */
  private evictIdle(): void {
    const cutoff = Date.now() - this.idleTimeoutMs
    for (const [projectId, used] of [...this.lastUsed]) {
      if (used < cutoff) void this.forget(projectId)
    }
  }

  /**
   * Make room for a new provider by closing the least recently used one.
   * A single project can always keep its provider; the cap bounds memory when
   * many projects are active, at the cost of re-creating a provider later.
   */
  private makeRoom(): void {
    if (this.providers.size < this.maxProviders) return
    let oldestProject: string | undefined
    let oldestUsed = Number.POSITIVE_INFINITY
    for (const [projectId, used] of this.lastUsed) {
      if (used < oldestUsed) {
        oldestUsed = used
        oldestProject = projectId
      }
    }
    if (oldestProject !== undefined) void this.forget(oldestProject)
  }

  private async forget(projectId: string): Promise<void> {
    this.evictions += 1
    await this.forgetProject(projectId)
  }

  private tracer(projectId: string): Tracer {
    let entry = this.providers.get(projectId)
    if (entry === undefined) {
      this.makeRoom()
      const baseExporter = new OTLPTraceExporter({
        url: this.config.otlpEndpoint ?? 'http://127.0.0.1:4317',
        timeoutMillis: this.config.otlpTimeoutMs ?? 5000,
        ...(this.config.apiKey !== undefined ? { headers: { Authorization: `Bearer ${this.config.apiKey}` } } : {}),
      })
      const exporter = new ResilientSpanExporter(baseExporter, {
        timeoutMs: this.config.otlpTimeoutMs ?? 5000,
        threshold: this.config.otlpBreakerThreshold ?? 3,
        cooldownMs: this.config.otlpBreakerCooldownMs ?? 30_000,
      })
      const provider = new NodeTracerProvider({
        resource: new Resource({
          'service.name': this.config.serviceName,
          'deployment.environment': this.config.environment,
          'project.id': projectId,
          'openinference.project.name': `${this.config.projectPrefix}${projectId}`,
        }),
        spanProcessors: [new BatchSpanProcessor(exporter, {
          maxQueueSize: 2048,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 5000,
          exportTimeoutMillis: this.config.otlpTimeoutMs ?? 5000,
        })],
      })
      entry = { provider, tracer: provider.getTracer('aifactory') }
      this.providers.set(projectId, entry)
      this.exporters.set(projectId, exporter)
    }
    this.lastUsed.set(projectId, Date.now())
    return entry.tracer
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
