/**
 * Reader hardening shared by every provider.
 *
 * - **TTL cache**: one Phoenix (or future backend) read per project/window per
 *   TTL, so a dashboard polling every second cannot hammer the monitor.
 * - **Single flight**: concurrent requests for the same key share one read.
 * - **Overall deadline**: a slow backend cannot hold an HTTP request open for
 *   the sum of its page timeouts.
 * - **Stale fallback**: if a refresh fails but a previous summary exists, the
 *   stale summary is returned and flagged, instead of an empty result.
 *
 * Never throws: a failure is reported as an unavailable summary.
 */

import type {
  ObservabilityHealth,
  ObservabilityReader,
  ObservabilitySummary,
} from './ports.ts'

export interface CachedReaderOptions {
  /** Freshness window in milliseconds (default 15 s). */
  ttlMs?: number
  /** Overall deadline for one refresh (default 3 s). */
  deadlineMs?: number
  /** Maximum cached project/window combinations (default 500). */
  maxEntries?: number
  now?: () => number
}

interface Entry {
  summary: ObservabilitySummary
  at: number
}

function unavailable(projectId: string, hours: number, reason: string): ObservabilitySummary {
  return {
    available: false,
    reason,
    projectName: projectId,
    windowHours: hours,
    traces: 0, spans: 0, errors: 0, tools: 0, tokens: 0,
    latencyMs: { count: 0, avg: 0, p50: 0, p95: 0, max: 0 },
    roles: [], lastSpanAt: null, truncated: false,
  }
}

export class CachedObservabilityReader implements ObservabilityReader {
  private readonly inner: ObservabilityReader
  private readonly ttlMs: number
  private readonly deadlineMs: number
  private readonly maxEntries: number
  private readonly now: () => number
  private readonly cache = new Map<string, Entry>()
  private readonly inflight = new Map<string, Promise<ObservabilitySummary>>()
  private hits = 0
  private misses = 0
  private timeouts = 0

  constructor(inner: ObservabilityReader, options: CachedReaderOptions = {}) {
    this.inner = inner
    this.ttlMs = Math.max(0, options.ttlMs ?? 15_000)
    this.deadlineMs = Math.max(100, options.deadlineMs ?? 3000)
    this.maxEntries = Math.max(1, options.maxEntries ?? 500)
    this.now = options.now ?? Date.now
  }

  async summary(projectId: string, hours: number): Promise<ObservabilitySummary> {
    const key = `${projectId}:${hours}`
    const cached = this.cache.get(key)
    if (cached !== undefined && this.now() - cached.at < this.ttlMs) {
      this.hits += 1
      return cached.summary
    }
    const running = this.inflight.get(key)
    if (running !== undefined) {
      this.hits += 1
      return running
    }
    this.misses += 1
    const promise = this.load(key, projectId, hours, cached)
    this.inflight.set(key, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(key)
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    this.invalidate(projectId)
    await this.inner.deleteProject(projectId)
  }

  health(): ObservabilityHealth {
    return {
      ...this.inner.health(),
      cache: {
        entries: this.cache.size,
        hits: this.hits,
        misses: this.misses,
        timeouts: this.timeouts,
        ttlMs: this.ttlMs,
        deadlineMs: this.deadlineMs,
      },
    }
  }

  /** Drop every cached window for a project (used on deletion). */
  invalidate(projectId: string): void {
    const prefix = `${projectId}:`
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key)
    }
  }

  /** Test/diagnostics hook: current cache size. */
  get size(): number {
    return this.cache.size
  }

  private async load(
    key: string,
    projectId: string,
    hours: number,
    stale: Entry | undefined,
  ): Promise<ObservabilitySummary> {
    const summary = await this.withDeadline(projectId, hours)
    if (!summary.available && stale !== undefined) {
      return {
        ...stale.summary,
        stale: true,
        cachedAt: new Date(stale.at).toISOString(),
      }
    }
    this.store(key, summary)
    return summary
  }

  private async withDeadline(projectId: string, hours: number): Promise<ObservabilitySummary> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<ObservabilitySummary>((resolve) => {
      timer = setTimeout(() => {
        this.timeouts += 1
        resolve(unavailable(projectId, hours, `observability read timed out after ${this.deadlineMs}ms`))
      }, this.deadlineMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([
        this.inner.summary(projectId, hours).catch((error: unknown) =>
          unavailable(projectId, hours, error instanceof Error ? error.message : String(error))),
        timeout,
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private store(key: string, summary: ObservabilitySummary): void {
    this.cache.delete(key)
    this.cache.set(key, { summary, at: this.now() })
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}
