/**
 * Observability ports.
 *
 * The core (stage runtime, HTTP API, logging) depends only on these types.
 * Phoenix — or any future monitor — is an adapter that implements them.
 * No vendor SDK types may appear in this file.
 */

import type { HarnessEvent } from '../protocol.ts'

export interface TraceContext {
  traceId: string
  spanId: string
}

export interface RunTraceInput {
  projectId: string
  projectName: string
  runId: string
  stage: string
  attempt: number
  contextHash?: string | null
  workerId?: string | null
  status: string
}

export interface RoleTraceInput {
  projectId: string
  runId: string
  role: string
  prompt: string
  timeoutMs: number
  parent?: TraceSpan
}

export type TraceStatus = 'ok' | 'error'

/**
 * A handle for one span. Adapters hide their SDK behind this: the stage runtime
 * must not import an OpenTelemetry (or any other) span type.
 */
export interface TraceSpan {
  readonly traceId: string
  readonly spanId: string
  setAttribute(key: string, value: string | number | boolean): void
  addEvent(name: string, attributes?: Record<string, unknown>): void
  recordException(error: unknown): void
  setStatus(status: TraceStatus, message?: string): void
  end(): void
}

/**
 * Write-side observability contract used by the stage runtime and logging.
 *
 * Implementations must be non-throwing and must not block: tracing is optional
 * and must never change the outcome of a stage run.
 */
export interface TraceRecorder {
  startRun(input: RunTraceInput): TraceSpan | undefined
  startRole(input: RoleTraceInput): TraceSpan | undefined
  recordHarnessEvent(span: TraceSpan | undefined, event: HarnessEvent): void
  completeRole(span: TraceSpan | undefined, output: string): void
  failRole(span: TraceSpan | undefined, error: unknown): void
  recordReview(span: TraceSpan | undefined, decision: string, findings: number): void
  recordDocument(span: TraceSpan | undefined, kind: string, path: string): void
  recordHumanDecision(projectId: string, runId: string, decision: string): void
  /** Release any per-project resources (providers, exporters, queues). */
  forgetProject(projectId: string): Promise<void>
  /** Current trace/span ids for log enrichment, if any. */
  currentTraceContext(): TraceContext | undefined
}

export interface ObservabilityRoleSummary {
  role: string
  spans: number
  errors: number
  durationMs: number
  tokens: number
}

export interface ObservabilityLatency {
  count: number
  avg: number
  p50: number
  p95: number
  max: number
}

/** Provider-neutral summary returned by the HTTP API. */
export interface ObservabilitySummary {
  available: boolean
  reason?: string
  projectName: string
  windowHours: number
  traces: number
  spans: number
  errors: number
  tools: number
  tokens: number
  latencyMs: ObservabilityLatency
  roles: ObservabilityRoleSummary[]
  lastSpanAt: string | null
  truncated: boolean
  /** True when the data came from cache because a fresh read failed. */
  stale?: boolean
  /** When the cached summary was produced. */
  cachedAt?: string
}

export type ObservabilityState = 'healthy' | 'degraded' | 'open' | 'disabled'

export interface ObservabilityCacheStats {
  entries: number
  hits: number
  misses: number
  timeouts: number
  ttlMs: number
  deadlineMs: number
}

export interface ObservabilityHealth {
  provider: string
  enabled: boolean
  state: ObservabilityState
  projects: number
  exports: number
  failures: number
  droppedSpans: number
  lastError: string | null
  openUntil: string | null
  /** Present when the reader is wrapped in the cache/deadline layer. */
  cache?: ObservabilityCacheStats
}

/**
 * Read-side contract used by the HTTP API. Implementations must be
 * time-bounded and must return an `available:false` summary rather than throw
 * when the backend is down.
 */
export interface ObservabilityReader {
  summary(projectId: string, hours: number): Promise<ObservabilitySummary>
  deleteProject(projectId: string): Promise<void>
  health(): ObservabilityHealth
}

export interface ObservabilityProvider {
  readonly name: string
  readonly recorder: TraceRecorder
  readonly reader: ObservabilityReader
  /** Bounded; must resolve even when the backend is unresponsive. */
  shutdown(timeoutMs?: number): Promise<void>
}

/** Provider-neutral error shape for HTTP mapping in a later phase. */
export class ObservabilityError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ObservabilityError'
    this.status = status
    this.code = code
  }
}
