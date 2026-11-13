/**
 * Resilient OTLP span exporter.
 *
 * Guarantees a hard timeout, a circuit breaker and no throwing, so an
 * unavailable monitor can only cause span loss.
 */

import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'

interface ExportResultLike {
  code: number
  error?: Error
}

export interface TelemetryExporterHealth {
  state: 'healthy' | 'open'
  exports: number
  failures: number
  droppedSpans: number
  consecutiveFailures: number
  openUntil: string | null
  lastError: string | null
}

export class ResilientSpanExporter implements SpanExporter {
  private readonly delegate: SpanExporter
  private readonly timeoutMs: number
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly now: () => number
  private exports = 0
  private failures = 0
  private droppedSpans = 0
  private consecutiveFailures = 0
  private openUntil = 0
  private lastError: string | null = null

  constructor(delegate: SpanExporter, options: { timeoutMs?: number; threshold?: number; cooldownMs?: number; now?: () => number } = {}) {
    this.delegate = delegate
    this.timeoutMs = Math.max(100, options.timeoutMs ?? 5000)
    this.threshold = Math.max(1, options.threshold ?? 3)
    this.cooldownMs = Math.max(1000, options.cooldownMs ?? 30_000)
    this.now = options.now ?? Date.now
  }

  health(): TelemetryExporterHealth {
    return {
      state: this.openUntil > this.now() ? 'open' : 'healthy',
      exports: this.exports,
      failures: this.failures,
      droppedSpans: this.droppedSpans,
      consecutiveFailures: this.consecutiveFailures,
      openUntil: this.openUntil > this.now() ? new Date(this.openUntil).toISOString() : null,
      lastError: this.lastError,
    }
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResultLike) => void): void {
    try {
      if (this.openUntil > this.now()) {
        this.droppedSpans += spans.length
        resultCallback({ code: 1, error: new Error('phoenix telemetry circuit is open') })
        return
      }
      this.exports += 1
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: ExportResultLike): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (result.code === 0) {
          this.consecutiveFailures = 0
          this.openUntil = 0
        } else {
          this.recordFailure(result.error)
        }
        resultCallback(result)
      }
      timer = setTimeout(() => {
        this.droppedSpans += spans.length
        finish({ code: 1, error: new Error(`phoenix export timed out after ${this.timeoutMs}ms`) })
      }, this.timeoutMs)
      timer.unref?.()
      this.delegate.export(spans, finish)
    } catch (error) {
      this.recordFailure(error)
      try {
        resultCallback({ code: 1, error: error instanceof Error ? error : new Error(String(error)) })
      } catch {
        // The callback belongs to the span processor; nothing else to do.
      }
    }
  }

  async forceFlush(): Promise<void> {
    try {
      if (this.delegate.forceFlush !== undefined) {
        await settleWithin(Promise.resolve(this.delegate.forceFlush()), this.timeoutMs)
      }
    } catch {
      // Best-effort observability only.
    }
  }

  async shutdown(): Promise<void> {
    try {
      if (this.delegate.shutdown !== undefined) {
        await settleWithin(Promise.resolve(this.delegate.shutdown()), this.timeoutMs)
      }
    } catch {
      // Best-effort observability only.
    }
  }

  private recordFailure(error: unknown): void {
    this.failures += 1
    this.consecutiveFailures += 1
    this.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    if (this.consecutiveFailures >= this.threshold) {
      this.openUntil = this.now() + this.cooldownMs
      this.consecutiveFailures = 0
    }
  }
}

/** Resolve true if `promise` settles within `ms`; never rejects. */
export async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms))
    timer.unref?.()
  })
  try {
    return (await Promise.race([promise.then(() => true, () => true), timeout])) === true
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}