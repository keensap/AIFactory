/**
 * Phoenix REST reader.
 *
 * Every request is time-bounded and a process-local breaker stops repeated
 * attempts against an unreachable Phoenix.
 */

import { PhoenixError } from './errors.ts'
import { summarizeSpans, type PhoenixObservabilitySummary, type PhoenixSpan } from './summary.ts'
import type { PhoenixConfig } from './config.ts'

export interface PhoenixClientHealth {
  state: 'healthy' | 'degraded' | 'open'
  requests: number
  failures: number
  lastError: string | null
  openUntil: string | null
}

export class PhoenixClient {
  private readonly baseUrl: string
  private readonly projectPrefix: string
  private readonly retentionHours: number
  private readonly apiKey?: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private consecutiveFailures = 0
  private openUntil = 0
  private requests = 0
  private failures = 0
  private lastError: string | null = null

  constructor(config: PhoenixConfig & { fetch?: typeof fetch }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.projectPrefix = config.projectPrefix
    this.retentionHours = config.retentionHours
    if (config.apiKey !== undefined && config.apiKey !== '') this.apiKey = config.apiKey
    this.timeoutMs = config.requestTimeoutMs ?? 5000
    this.fetchImpl = config.fetch ?? fetch
  }

  /** REST breaker and failure counters for the admin health endpoint. */
  health(): PhoenixClientHealth {
    return {
      state: this.openUntil > Date.now() ? 'open' : this.failures > 0 ? 'degraded' : 'healthy',
      requests: this.requests,
      failures: this.failures,
      lastError: this.lastError,
      openUntil: this.openUntil > Date.now() ? new Date(this.openUntil).toISOString() : null,
    }
  }

  projectName(projectId: string): string {
    return `${this.projectPrefix}${projectId}`
  }

  async summary(projectId: string, hours = this.retentionHours): Promise<PhoenixObservabilitySummary> {
    if (this.openUntil > Date.now()) {
      return {
        available: false,
        reason: 'Phoenix is unavailable (circuit open)',
        projectName: this.projectName(projectId),
        windowHours: this.retentionHours,
        traces: 0, spans: 0, errors: 0, tools: 0, tokens: 0,
        latencyMs: { count: 0, avg: 0, p50: 0, p95: 0, max: 0 }, roles: [], lastSpanAt: null, truncated: false,
      }
    }
    const windowHours = Math.min(Math.max(Number.isFinite(hours) ? hours : this.retentionHours, 1), 168)
    const projectName = this.projectName(projectId)
    try {
      const spans = await this.listSpans(projectName, windowHours)
      return summarizeSpans(projectName, windowHours, spans)
    } catch (error) {
      if (error instanceof PhoenixError && error.status === 404) {
        return {
          available: true,
          projectName,
          windowHours,
          traces: 0,
          spans: 0,
          errors: 0,
          tools: 0,
          tokens: 0,
          latencyMs: { count: 0, avg: 0, p50: 0, p95: 0, max: 0 },
          roles: [],
          lastSpanAt: null,
          truncated: false,
        }
      }
      if (!(error instanceof PhoenixError)) this.recordFailure(error)
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        projectName,
        windowHours,
        traces: 0,
        spans: 0,
        errors: 0,
        tools: 0,
        tokens: 0,
        latencyMs: { count: 0, avg: 0, p50: 0, p95: 0, max: 0 },
        roles: [],
        lastSpanAt: null,
        truncated: false,
      }
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    const url = new URL(`${this.baseUrl}/v1/projects/${encodeURIComponent(this.projectName(projectId))}`)
    try {
      const response = await this.request(url, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) {
        throw new PhoenixError(502, 'PHOENIX_DELETE_FAILED', `Phoenix returned ${response.status}`)
      }
    } catch (error) {
      if (error instanceof PhoenixError && error.status === 404) return
      throw error
    }
  }

  async listSpans(projectName: string, hours: number, maxSpans = 10_000): Promise<PhoenixSpan[]> {
    const spans: PhoenixSpan[] = []
    let cursor: string | null = null
    const end = new Date()
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000)
    for (;;) {
      const url = new URL(`${this.baseUrl}/v1/projects/${encodeURIComponent(projectName)}/spans`)
      url.searchParams.set('limit', '1000')
      url.searchParams.set('start_time', start.toISOString())
      url.searchParams.set('end_time', end.toISOString())
      if (cursor !== null) url.searchParams.set('cursor', cursor)
      const response = await this.request(url)
      const body = await response.json() as { data?: PhoenixSpan[]; next_cursor?: string | null }
      if (!Array.isArray(body.data)) {
        throw new PhoenixError(502, 'PHOENIX_RESPONSE_INVALID', 'Phoenix spans response has no data array')
      }
      spans.push(...body.data)
      if (spans.length >= maxSpans) return spans.slice(0, maxSpans)
      if (body.next_cursor === null || body.next_cursor === undefined) return spans
      cursor = body.next_cursor
    }
  }

  private async request(url: URL, init: RequestInit = {}): Promise<Response> {
    if (this.openUntil > Date.now()) {
      throw new PhoenixError(503, 'PHOENIX_UNAVAILABLE', 'Phoenix is unavailable (circuit open)')
    }
    this.requests += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref()
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init.headers ?? {}),
          ...(this.apiKey !== undefined ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: controller.signal,
      })
      if (response.status === 404) {
        throw new PhoenixError(404, 'PHOENIX_PROJECT_NOT_FOUND', `Phoenix project not found: ${url.pathname}`)
      }
      if (!response.ok) {
        if (response.status >= 500) this.recordFailure(new Error(`Phoenix returned ${response.status}`))
        throw new PhoenixError(
          502,
          'PHOENIX_HTTP_ERROR',
          `Phoenix returned ${response.status} for ${url.pathname}`,
        )
      }
      this.consecutiveFailures = 0
      this.openUntil = 0
      return response
    } catch (error) {
      if (error instanceof PhoenixError) {
        if (error.code === 'PHOENIX_UNAVAILABLE') this.recordFailure(error)
        throw error
      }
      this.recordFailure(error)
      throw new PhoenixError(
        502,
        'PHOENIX_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private recordFailure(error: unknown): void {
    this.consecutiveFailures += 1
    this.failures += 1
    this.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    if (this.consecutiveFailures >= 3) {
      this.openUntil = Date.now() + 30_000
      this.consecutiveFailures = 0
    }
  }
}