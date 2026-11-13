/**
 * In-memory observability provider.
 *
 * Not a monitor: it keeps bounded spans in process memory so the ports can be
 * exercised end to end (tests, local development, and proving that a provider
 * can be swapped by configuration alone). Selected with
 * `AIFACTORY_OBSERVABILITY_PROVIDER=memory`.
 *
 * Bounds: `maxSpansPerProject` (default 1000) and `maxProjects` (default 100),
 * with the oldest project evicted first. Never throws.
 */

import { randomBytes } from 'node:crypto'
import type { HarnessEvent } from '../protocol.ts'
import type {
  ObservabilityHealth,
  ObservabilityProvider,
  ObservabilityReader,
  ObservabilityRoleSummary,
  ObservabilitySummary,
  RoleTraceInput,
  RunTraceInput,
  TraceContext,
  TraceRecorder,
  TraceSpan,
  TraceStatus,
} from './ports.ts'

interface MemoryEvent {
  name: string
  at: string
  attributes?: Record<string, unknown>
}

interface MemorySpan {
  traceId: string
  spanId: string
  name: string
  start: number
  end: number | null
  status: TraceStatus
  message?: string
  attributes: Record<string, unknown>
  events: MemoryEvent[]
  error?: { type: string; message: string }
}

export interface MemoryProviderOptions {
  maxSpansPerProject?: number
  maxProjects?: number
  now?: () => number
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

class MemoryTraceSpan implements TraceSpan {
  readonly traceId: string
  readonly spanId: string
  private readonly span: MemorySpan
  private readonly sink: (span: MemorySpan) => void

  constructor(traceId: string, name: string, attributes: Record<string, unknown>, now: number, sink: (span: MemorySpan) => void) {
    this.traceId = traceId
    this.spanId = hex(8)
    this.sink = sink
    this.span = { traceId, spanId: this.spanId, name, start: now, end: null, status: 'ok', attributes, events: [] }
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.span.attributes[key] = value
  }

  addEvent(name: string, attributes?: Record<string, unknown>): void {
    this.span.events.push({ name, at: new Date().toISOString(), ...(attributes !== undefined ? { attributes } : {}) })
  }

  recordException(error: unknown): void {
    this.span.error = {
      type: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    }
    this.span.status = 'error'
  }

  setStatus(status: TraceStatus, message?: string): void {
    this.span.status = status
    if (message !== undefined) this.span.message = message
  }

  end(): void {
    if (this.span.end !== null) return
    this.span.end = Date.now()
    this.sink(this.span)
  }
}

class MemoryTraceRecorder implements TraceRecorder {
  readonly spans = new Map<string, MemorySpan[]>()
  private readonly maxSpansPerProject: number
  private readonly maxProjects: number
  private readonly now: () => number

  constructor(options: MemoryProviderOptions = {}) {
    this.maxSpansPerProject = Math.max(1, options.maxSpansPerProject ?? 1000)
    this.maxProjects = Math.max(1, options.maxProjects ?? 100)
    this.now = options.now ?? Date.now
  }

  startRun(input: RunTraceInput): TraceSpan | undefined {
    try {
      const traceId = hex(16)
      const span = new MemoryTraceSpan(traceId, 'stage.run', {
        'openinference.span.kind': 'CHAIN',
        'project.id': input.projectId,
        'project.name': input.projectName,
        stage: input.stage,
        'run.id': input.runId,
        'run.attempt': input.attempt,
        'context.hash': input.contextHash ?? '',
        status: input.status,
      }, this.now(), (finished) => this.store(input.projectId, finished))
      // A run span may never end if the process exits; the trace id is still useful.
      this.reserve(input.projectId)
      return span
    } catch {
      return undefined
    }
  }

  startRole(input: RoleTraceInput): TraceSpan | undefined {
    try {
      const parent = input.parent as MemoryTraceSpan | undefined
      const traceId = parent?.traceId ?? hex(16)
      return new MemoryTraceSpan(traceId, `stage.role.${input.role}`, {
        'openinference.span.kind': 'LLM',
        'project.id': input.projectId,
        'run.id': input.runId,
        role: input.role,
        'timeout.ms': input.timeoutMs,
      }, this.now(), (finished) => this.store(input.projectId, finished))
    } catch {
      return undefined
    }
  }

  recordHarnessEvent(span: TraceSpan | undefined, event: HarnessEvent): void {
    try {
      if (!(span instanceof MemoryTraceSpan)) return
      if (event.type === 'status' && event.usage !== null && typeof event.usage === 'object') {
        for (const [key, attribute] of Object.entries({
          inputTokens: 'llm.token_count.prompt',
          outputTokens: 'llm.token_count.completion',
          totalTokens: 'llm.token_count.total',
        })) {
          const value = (event.usage as Record<string, unknown>)[key]
          if (typeof value === 'number') span.setAttribute(attribute, value)
        }
        return
      }
      span.addEvent(event.type)
    } catch {
      // Never fail a stage run.
    }
  }

  completeRole(span: TraceSpan | undefined, output: string): void {
    try {
      span?.setAttribute('status', 'completed')
      span?.setAttribute('output.length', output.length)
      span?.setStatus('ok')
      span?.end()
    } catch {}
  }

  failRole(span: TraceSpan | undefined, error: unknown): void {
    try {
      span?.setAttribute('status', 'failed')
      span?.recordException(error)
      span?.setStatus('error', error instanceof Error ? error.message : String(error))
      span?.end()
    } catch {}
  }

  recordReview(span: TraceSpan | undefined, decision: string, findings: number): void {
    try { span?.addEvent('review.decision', { decision, findings }) } catch {}
  }

  recordDocument(span: TraceSpan | undefined, kind: string, path: string): void {
    try { span?.addEvent('document.created', { kind, path }) } catch {}
  }

  recordHumanDecision(projectId: string, runId: string, decision: string): void {
    try {
      const span = new MemoryTraceSpan(hex(16), 'stage.human_decision', {
        'openinference.span.kind': 'CHAIN',
        'project.id': projectId,
        'run.id': runId,
        decision,
      }, this.now(), (finished) => this.store(projectId, finished))
      span.end()
    } catch {}
  }

  async forgetProject(projectId: string): Promise<void> {
    this.spans.delete(projectId)
  }

  currentTraceContext(): TraceContext | undefined {
    return undefined
  }

  private reserve(projectId: string): void {
    if (!this.spans.has(projectId)) {
      if (this.spans.size >= this.maxProjects) {
        const oldest = this.spans.keys().next().value
        if (oldest !== undefined) this.spans.delete(oldest)
      }
      this.spans.set(projectId, [])
    }
  }

  private store(projectId: string, span: MemorySpan): void {
    this.reserve(projectId)
    const list = this.spans.get(projectId)!
    list.push(span)
    if (list.length > this.maxSpansPerProject) list.splice(0, list.length - this.maxSpansPerProject)
  }
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0
}

class MemoryReader implements ObservabilityReader {
  private readonly recorder: MemoryTraceRecorder

  constructor(recorder: MemoryTraceRecorder) {
    this.recorder = recorder
  }

  async summary(projectId: string, hours: number): Promise<ObservabilitySummary> {
    const windowHours = Math.min(Math.max(Number.isFinite(hours) ? hours : 24, 1), 168)
    const cutoff = Date.now() - windowHours * 60 * 60 * 1000
    const spans = (this.recorder.spans.get(projectId) ?? []).filter((span) => span.start >= cutoff)
    const traces = new Set(spans.map((span) => span.traceId))
    const durations: number[] = []
    const roles = new Map<string, ObservabilityRoleSummary>()
    let errors = 0
    let tools = 0
    let tokens = 0
    let lastSpanAt: string | null = null
    for (const span of spans) {
      if (span.status === 'error') errors += 1
      if (span.name === 'tool.call') tools += 1
      const end = span.end ?? span.start
      durations.push(Math.max(0, end - span.start))
      const iso = new Date(end).toISOString()
      if (lastSpanAt === null || iso > lastSpanAt) lastSpanAt = iso
      const role = typeof span.attributes.role === 'string' ? span.attributes.role : undefined
      if (role !== undefined) {
        const entry = roles.get(role) ?? { role, spans: 0, errors: 0, durationMs: 0, tokens: 0 }
        entry.spans += 1
        if (span.status === 'error') entry.errors += 1
        entry.durationMs += Math.max(0, end - span.start)
        const value = Number(span.attributes['llm.token_count.total'] ?? 0)
        if (Number.isFinite(value) && value > 0) {
          entry.tokens += value
          tokens += value
        }
        roles.set(role, entry)
      }
    }
    durations.sort((a, b) => a - b)
    return {
      available: true,
      projectName: projectId,
      windowHours,
      traces: traces.size,
      spans: spans.length,
      errors,
      tools,
      tokens,
      latencyMs: {
        count: durations.length,
        avg: durations.length === 0 ? 0 : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        max: durations.at(-1) ?? 0,
      },
      roles: [...roles.values()].sort((a, b) => b.spans - a.spans),
      lastSpanAt,
      truncated: false,
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    this.recorder.spans.delete(projectId)
  }

  health(): ObservabilityHealth {
    const spans = [...this.recorder.spans.values()].reduce((sum, list) => sum + list.length, 0)
    return {
      provider: 'memory',
      enabled: true,
      state: 'healthy',
      projects: this.recorder.spans.size,
      exports: spans,
      failures: 0,
      droppedSpans: 0,
      lastError: null,
      openUntil: null,
    }
  }
}

export class MemoryObservabilityProvider implements ObservabilityProvider {
  readonly name = 'memory'
  readonly recorder: TraceRecorder
  readonly reader: ObservabilityReader

  constructor(options: MemoryProviderOptions = {}) {
    const recorder = new MemoryTraceRecorder(options)
    this.recorder = recorder
    this.reader = new MemoryReader(recorder)
  }

  async shutdown(): Promise<void> {}
}

export function createMemoryProvider(options: MemoryProviderOptions = {}): ObservabilityProvider {
  return new MemoryObservabilityProvider(options)
}
