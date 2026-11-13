/**
 * Failure isolation around a `ModelEngine`.
 *
 *  - a per-attempt deadline (first-token deadline for streams);
 *  - bounded retry with exponential backoff, jitter and `Retry-After`, only for
 *    retryable error kinds and, for streams, only before any event was emitted
 *    (a partially delivered answer is never silently restarted);
 *  - a circuit breaker per provider: after N consecutive retryable failures the
 *    route opens for a cool-down and calls fail fast with `unavailable`, then a
 *    single probe is allowed (half-open).
 *
 * Non-retryable errors (auth, invalid request, context overflow, unsupported)
 * describe the request or configuration, not the provider's health, so they never
 * trip the breaker.
 */

import { ModelError, isRetryable, type EngineHealth, type ModelEngine, type ModelEvent, type ModelRequest, type ModelResponse } from './ports.ts'

export type BreakerState = 'closed' | 'open' | 'half_open'

export interface BreakerOptions {
  failureThreshold?: number
  cooldownMs?: number
  now?: () => number
}

export interface BreakerSnapshot {
  state: BreakerState
  consecutiveFailures: number
  openedAt: number | null
  retryAt: number | null
  lastError: string | null
  successes: number
  failures: number
}

export class CircuitBreaker {
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly now: () => number
  private state: BreakerState = 'closed'
  private consecutive = 0
  private openedAt: number | null = null
  private probing = false
  private lastError: string | null = null
  private successes = 0
  private failures = 0

  constructor(options: BreakerOptions = {}) {
    this.threshold = Math.max(1, options.failureThreshold ?? 5)
    this.cooldownMs = Math.max(0, options.cooldownMs ?? 30_000)
    this.now = options.now ?? Date.now
  }

  /** True when a call may proceed. In half-open state only one probe is admitted. */
  tryAcquire(): boolean {
    if (this.state === 'closed') return true
    if (this.state === 'open') {
      if (this.now() - (this.openedAt ?? 0) < this.cooldownMs) return false
      this.state = 'half_open'
      this.probing = false
    }
    if (this.probing) return false
    this.probing = true
    return true
  }

  success(): void {
    this.successes += 1
    this.consecutive = 0
    this.state = 'closed'
    this.openedAt = null
    this.probing = false
    this.lastError = null
  }

  /** Record a provider-health failure (not a bad request). */
  failure(message: string): void {
    this.failures += 1
    this.consecutive += 1
    this.lastError = message
    this.probing = false
    if (this.state === 'half_open' || this.consecutive >= this.threshold) {
      this.state = 'open'
      this.openedAt = this.now()
    }
  }

  /** The call ended without telling us anything about provider health. */
  release(): void {
    this.probing = false
  }

  snapshot(): BreakerSnapshot {
    const retryAt = this.state === 'open' && this.openedAt !== null ? this.openedAt + this.cooldownMs : null
    return {
      state: this.state === 'open' && retryAt !== null && this.now() >= retryAt ? 'half_open' : this.state,
      consecutiveFailures: this.consecutive,
      openedAt: this.openedAt,
      retryAt,
      lastError: this.lastError,
      successes: this.successes,
      failures: this.failures,
    }
  }

  reset(): void {
    this.state = 'closed'
    this.consecutive = 0
    this.openedAt = null
    this.probing = false
    this.lastError = null
  }
}

export interface ResilienceOptions {
  /** Maximum duration of one attempt. Local CPU inference needs a large value. */
  attemptTimeoutMs?: number
  /** Retries after the first attempt. */
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  breaker?: CircuitBreaker
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
  onRetry?: (info: { attempt: number; delayMs: number; error: ModelError }) => void
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted === true) {
    reject(new ModelError('aborted', 'request aborted by the caller'))
    return
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  const onAbort = (): void => {
    clearTimeout(timer)
    reject(new ModelError('aborted', 'request aborted by the caller'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
})

/** Delay before retry `attempt` (1-based): exponential, jittered, honouring Retry-After. */
export function backoffDelay(
  attempt: number,
  error: ModelError,
  options: { baseDelayMs: number; maxDelayMs: number; random: () => number },
): number {
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1))
  const jittered = Math.round(exponential * (0.5 + options.random() * 0.5))
  return Math.min(options.maxDelayMs, Math.max(jittered, error.retryAfterMs ?? 0))
}

/** Combine the caller's signal with an attempt deadline. */
function attemptSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()
  const onAbort = (): void => controller.abort()
  if (parent?.aborted === true) controller.abort()
  else parent?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

function normalize(error: unknown, request: ModelRequest, timedOut: boolean, timeoutMs: number): ModelError {
  if (timedOut) {
    return new ModelError('timeout', `${request.provider} did not answer within ${timeoutMs}ms`, { provider: request.provider, model: request.model })
  }
  if (error instanceof ModelError) return error
  return new ModelError('unknown', error instanceof Error ? error.message : String(error), { provider: request.provider, model: request.model, cause: error })
}

export class ResilientEngine implements ModelEngine {
  readonly kind: string
  readonly breaker: CircuitBreaker
  private readonly inner: ModelEngine
  private readonly attemptTimeoutMs: number
  private readonly maxRetries: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly random: () => number
  private readonly onRetry?: ResilienceOptions['onRetry']

  constructor(inner: ModelEngine, options: ResilienceOptions = {}) {
    this.inner = inner
    this.kind = inner.kind
    this.breaker = options.breaker ?? new CircuitBreaker()
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 120_000
    this.maxRetries = Math.max(0, options.maxRetries ?? 2)
    this.baseDelayMs = options.baseDelayMs ?? 500
    this.maxDelayMs = options.maxDelayMs ?? 15_000
    this.sleep = options.sleep ?? defaultSleep
    this.random = options.random ?? Math.random
    if (options.onRetry !== undefined) this.onRetry = options.onRetry
  }

  private openError(request: ModelRequest): ModelError {
    const snapshot = this.breaker.snapshot()
    const wait = snapshot.retryAt === null ? '' : ` (retrying after ${new Date(snapshot.retryAt).toISOString()})`
    return new ModelError('unavailable', `${request.provider} is unavailable after repeated failures${wait}`, {
      provider: request.provider,
      model: request.model,
      retryable: false,
    })
  }

  /**
   * Whether another attempt is allowed after `error` on attempt number `attempt`.
   * Once this failure has opened the breaker a retry cannot be admitted, so the
   * caller fails now instead of sleeping through a backoff first.
   */
  private shouldRetry(error: ModelError, attempt: number): boolean {
    if (attempt > this.maxRetries || !error.retryable || !isRetryable(error.kind)) return false
    return this.breaker.snapshot().state === 'closed'
  }

  private record(error: ModelError): void {
    if (error.retryable && isRetryable(error.kind)) {
      this.breaker.failure(`${error.kind}: ${error.message}`)
    } else if (error.status !== undefined) {
      // The provider answered with an HTTP error: it is up; the request was at fault.
      this.breaker.success()
    } else {
      // Aborted, unsupported, missing key…: raised locally, so no evidence either way.
      this.breaker.release()
    }
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    for (let attempt = 1; ; attempt++) {
      if (!this.breaker.tryAcquire()) throw this.openError(request)
      const scope = attemptSignal(signal, this.attemptTimeoutMs)
      try {
        const response = await this.inner.complete(request, scope.signal)
        this.breaker.success()
        return response
      } catch (raw) {
        const error = normalize(raw, request, scope.timedOut(), this.attemptTimeoutMs)
        this.record(error)
        if (!this.shouldRetry(error, attempt) || signal?.aborted === true) throw error
        const delayMs = backoffDelay(attempt, error, { baseDelayMs: this.baseDelayMs, maxDelayMs: this.maxDelayMs, random: this.random })
        this.onRetry?.({ attempt, delayMs, error })
        await this.sleep(delayMs, signal)
      } finally {
        scope.dispose()
      }
    }
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    for (let attempt = 1; ; attempt++) {
      if (!this.breaker.tryAcquire()) throw this.openError(request)
      const scope = attemptSignal(signal, this.attemptTimeoutMs)
      let emitted = false
      try {
        for await (const event of this.inner.stream(request, scope.signal)) {
          emitted = true
          yield event
        }
        this.breaker.success()
        return
      } catch (raw) {
        const error = normalize(raw, request, scope.timedOut(), this.attemptTimeoutMs)
        this.record(error)
        // After the first event a retry would duplicate or contradict what the
        // consumer already saw; surface the error instead.
        if (emitted || !this.shouldRetry(error, attempt) || signal?.aborted === true) throw error
        const delayMs = backoffDelay(attempt, error, { baseDelayMs: this.baseDelayMs, maxDelayMs: this.maxDelayMs, random: this.random })
        this.onRetry?.({ attempt, delayMs, error })
        await this.sleep(delayMs, signal)
      } finally {
        scope.dispose()
      }
    }
  }

  async health(): Promise<EngineHealth> {
    const inner = await this.inner.health()
    const snapshot = this.breaker.snapshot()
    if (snapshot.state === 'open') {
      return { ...inner, state: 'degraded', lastError: snapshot.lastError ?? inner.lastError }
    }
    return inner
  }
}
