/**
 * Per-sink delivery envelope.
 *
 * Each sink has its own bounded list of pending batches and delivers them one
 * at a time. A slow, throwing or hanging sink therefore only affects itself:
 * its batches are retried with backoff, then dropped (and counted) while the
 * application and every other sink continue normally.
 *
 * Circuit breaker: after `breakerThreshold` consecutive failed batches the sink
 * is "open" for a cool-down (doubling up to a maximum). While open its batches
 * are dropped immediately instead of piling up behind timeouts. After the
 * cool-down one probe batch is tried ("half-open"); success closes the breaker,
 * failure re-opens it with a longer cool-down.
 */

import { LEVEL_VALUE } from './levels.ts'
import type { LogEvent } from './event.ts'
import type { LogSink } from './sink.ts'
import type { BatchSpool, SpoolStats } from './spool.ts'

export type SinkState = 'healthy' | 'degraded' | 'open' | 'half_open'

export interface SinkStats {
  name: string
  state: SinkState
  written: number
  failed: number
  dropped: number
  droppedByBreaker: number
  retries: number
  breakerOpens: number
  pendingBatches: number
  consecutiveFailures: number
  openUntil: string | null
  lastError: string | null
  lastErrorAt: string | null
  spooled: number
  replayed: number
  spoolFailures: number
  spool: SpoolStats | null
}

export interface RunnerOptions {
  timeoutMs: number
  maxPendingBatches: number
  /** Extra attempts after the first failure (default 2). */
  retries?: number
  /** First retry delay; doubles each attempt with jitter (default 200 ms). */
  retryBaseMs?: number
  /** Consecutive failed batches that open the breaker (default 5). */
  breakerThreshold?: number
  /** First open duration (default 30 s). */
  breakerCooldownMs?: number
  /** Cap for the doubling cool-down (default 5 min). */
  breakerMaxCooldownMs?: number
  now?: () => number
  /** Optional bounded disk spool for outages; replayed after a successful write. */
  spool?: BatchSpool
  onFailure?: (sink: string, message: string) => void
  onStateChange?: (sink: string, state: SinkState) => void
}

export class SinkRunner {
  readonly sink: LogSink
  private readonly options: RunnerOptions
  private readonly now: () => number
  private readonly pending: LogEvent[][] = []
  private running = false
  private closing = false
  private waiters: Array<() => void> = []
  private written = 0
  private failed = 0
  private dropped = 0
  private droppedByBreaker = 0
  private retries = 0
  private breakerOpens = 0
  private consecutiveFailures = 0
  private openUntil = 0
  private openCount = 0
  private halfOpen = false
  private lastError: string | null = null
  private lastErrorAt: number | null = null
  private lastState: SinkState = 'healthy'
  private readonly spool?: BatchSpool
  private spooled = 0
  private replayed = 0
  private spoolFailures = 0
  private replayRequested = false

  constructor(sink: LogSink, options: RunnerOptions) {
    this.sink = sink
    this.options = options
    this.now = options.now ?? Date.now
    this.spool = options.spool
  }

  enqueue(batch: readonly LogEvent[]): void {
    if (this.closing) return
    const min = this.sink.minLevel === undefined ? 0 : LEVEL_VALUE[this.sink.minLevel]
    const filtered = min === 0 ? [...batch] : batch.filter((event) => event.levelValue >= min)
    if (filtered.length === 0) return
    if (this.pending.length >= this.options.maxPendingBatches) {
      const dropped = this.pending.shift()
      if (dropped !== undefined) this.dropped += dropped.length
    }
    this.pending.push(filtered)
    if (!this.running) {
      this.running = true
      void this.loop()
    }
  }

  idle(): Promise<void> {
    if (!this.running && this.pending.length === 0) return Promise.resolve()
    return new Promise((resolve) => { this.waiters.push(resolve) })
  }

  pendingEvents(): number {
    return this.pending.reduce((sum, batch) => sum + batch.length, 0)
  }

  /** Wake the runner to replay spooled batches even when no new logs arrive. */
  replay(): void {
    if (this.closing) return
    this.replayRequested = true
    if (!this.running) {
      this.running = true
      void this.loop()
    }
  }

  get state(): SinkState {
    if (this.halfOpen) return 'half_open'
    if (this.openUntil > this.now()) return 'open'
    return this.consecutiveFailures > 0 ? 'degraded' : 'healthy'
  }

  stats(): SinkStats {
    return {
      name: this.sink.name,
      state: this.state,
      written: this.written,
      failed: this.failed,
      dropped: this.dropped,
      droppedByBreaker: this.droppedByBreaker,
      retries: this.retries,
      breakerOpens: this.breakerOpens,
      pendingBatches: this.pending.length,
      consecutiveFailures: this.consecutiveFailures,
      openUntil: this.openUntil > this.now() ? new Date(this.openUntil).toISOString() : null,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt === null ? null : new Date(this.lastErrorAt).toISOString(),
      spooled: this.spooled,
      replayed: this.replayed,
      spoolFailures: this.spoolFailures,
      spool: this.spool?.stats() ?? null,
    }
  }

  async flush(timeoutMs: number): Promise<void> {
    await this.guarded((signal) => this.sink.flush?.(signal), timeoutMs)
  }

  async close(timeoutMs: number): Promise<void> {
    this.closing = true
    await this.guarded(() => this.sink.close?.(), timeoutMs)
  }

  private async loop(): Promise<void> {
    try {
      for (;;) {
        if (this.pending.length === 0) {
          if (this.replayRequested) {
            this.replayRequested = false
            const progressed = await this.replaySpool()
            if (progressed && this.spool !== undefined && this.spool.stats().files > 0 && this.openUntil <= this.now()) {
              // Keep draining until the spool is empty or a replay fails.
              this.replayRequested = true
              continue
            }
          }
          break
        }
        const batch = this.pending.shift()!
        const now = this.now()
        if (this.openUntil > now) {
          const spooled = await this.spoolBatch(batch)
          if (!spooled) {
            this.dropped += batch.length
            this.droppedByBreaker += batch.length
          }
          continue
        }
        // Cool-down elapsed after an open period: this batch is the probe.
        this.halfOpen = this.openCount > 0
        this.notify()
        const ok = await this.deliver(batch)
        this.halfOpen = false
        if (ok) {
          this.written += batch.length
          this.consecutiveFailures = 0
          this.openCount = 0
          this.openUntil = 0
          await this.replaySpool()
        } else {
          const spooled = await this.spoolBatch(batch)
          if (!spooled) this.dropped += batch.length
          this.consecutiveFailures += 1
          this.maybeOpen()
        }
        this.notify()
      }
    } finally {
      this.running = false
      const waiters = this.waiters
      this.waiters = []
      for (const resolve of waiters) resolve()
    }
  }

  /** Persist a failed batch to the spool. Returns false when nothing was saved. */
  private async spoolBatch(batch: LogEvent[]): Promise<boolean> {
    if (this.spool === undefined) return false
    try {
      await this.spool.append(batch)
      this.spooled += batch.length
      return true
    } catch {
      this.spoolFailures += 1
      return false
    }
  }

  /** Replay a few spool segments; stops on the first failure so they stay queued. */
  private async replaySpool(limit = 4): Promise<boolean> {
    if (this.spool === undefined || this.openUntil > this.now()) return false
    for (let i = 0; i < limit; i++) {
      let batch: Awaited<ReturnType<BatchSpool['take']>>
      try {
        batch = await this.spool.take()
      } catch {
        this.spoolFailures += 1
        return false
      }
      if (batch === undefined) return true
      if (batch.events.length === 0) {
        await batch.commit()
        continue
      }
      const ok = await this.guarded((signal) => this.sink.write(batch.events, signal), this.options.timeoutMs)
      if (!ok) {
        await batch.requeue()
        return false
      }
      await batch.commit()
      this.replayed += batch.events.length
      this.written += batch.events.length
    }
    return true
  }

  /** Write one batch with bounded retries. A probe gets a single attempt. */
  private async deliver(batch: LogEvent[]): Promise<boolean> {
    const retries = this.halfOpen ? 0 : Math.max(0, this.options.retries ?? 2)
    const base = Math.max(0, this.options.retryBaseMs ?? 200)
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (this.closing && attempt > 0) return false
      const ok = await this.guarded((signal) => this.sink.write(batch, signal), this.options.timeoutMs)
      if (ok) return true
      if (attempt < retries) {
        this.retries += 1
        await sleep(base * 2 ** attempt * (0.75 + Math.random() * 0.5))
      }
    }
    return false
  }

  private maybeOpen(): void {
    const threshold = Math.max(1, this.options.breakerThreshold ?? 5)
    if (!this.halfOpenWasProbe() && this.consecutiveFailures < threshold) return
    const base = Math.max(1, this.options.breakerCooldownMs ?? 30_000)
    const max = Math.max(base, this.options.breakerMaxCooldownMs ?? 300_000)
    const cooldown = Math.min(max, base * 2 ** this.openCount)
    this.openCount += 1
    this.breakerOpens += 1
    this.openUntil = this.now() + cooldown
  }

  /** A failed probe always re-opens, regardless of the consecutive count. */
  private halfOpenWasProbe(): boolean {
    return this.openCount > 0
  }

  /** Run `action` with a timeout; never throws. Returns whether it succeeded. */
  private async guarded(action: (signal: AbortSignal) => Promise<void> | void, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
      timer.unref?.()
    })
    try {
      const outcome = await Promise.race([Promise.resolve().then(() => action(controller.signal)), timeout])
      if (outcome === 'timeout') {
        controller.abort()
        this.recordFailure(`write timed out after ${timeoutMs}ms`)
        return false
      }
      return true
    } catch (error) {
      this.recordFailure(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private recordFailure(message: string): void {
    this.failed += 1
    this.lastError = message.slice(0, 500)
    this.lastErrorAt = this.now()
    try {
      this.options.onFailure?.(this.sink.name, this.lastError)
    } catch {
      // Self-diagnostics must not throw.
    }
  }

  private notify(): void {
    const state = this.state
    if (state === this.lastState) return
    this.lastState = state
    try {
      this.options.onStateChange?.(this.sink.name, state)
    } catch {
      // Self-diagnostics must not throw.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
