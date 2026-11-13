/**
 * Emergency sink: the last-resort, synchronous, rate-limited stderr writer.
 *
 * Used when the facade itself fails, when the pipeline is closed, and for
 * logging-system self-diagnostics (Serilog `SelfLog`). It must never throw and
 * must never flood: a token bucket caps the output and suppressed lines are
 * summarized once capacity returns.
 */

import { capString, scrubString } from './sanitize.ts'

export interface EmergencyOptions {
  write?: (line: string) => void
  ratePerSecond?: number
  now?: () => number
}

const guarded = new WeakSet<object>()

/** Prevent EPIPE/closed-stream `error` events on stdio from crashing the process. */
export function guardStream(stream: { on?: (event: string, listener: () => void) => unknown } | undefined): void {
  try {
    if (stream === undefined || typeof stream.on !== 'function' || guarded.has(stream)) return
    guarded.add(stream)
    stream.on('error', () => {})
  } catch {
    // Nothing useful can be done if even this fails.
  }
}

export class EmergencySink {
  private readonly writeLine: (line: string) => void
  private readonly rate: number
  private readonly now: () => number
  private tokens: number
  private last: number
  private suppressedCount = 0
  private totalSuppressed = 0

  constructor(options: EmergencyOptions = {}) {
    this.rate = Math.max(1, options.ratePerSecond ?? 20)
    this.now = options.now ?? Date.now
    this.tokens = this.rate
    this.last = this.now()
    if (options.write !== undefined) {
      this.writeLine = options.write
    } else {
      guardStream(process.stderr)
      this.writeLine = (line) => { process.stderr.write(`${line}\n`) }
    }
  }

  get suppressed(): number {
    return this.totalSuppressed
  }

  write(fields: Record<string, unknown>): void {
    try {
      this.refill()
      if (this.tokens < 1) {
        this.suppressedCount += 1
        this.totalSuppressed += 1
        return
      }
      if (this.suppressedCount > 0) {
        const count = this.suppressedCount
        this.suppressedCount = 0
        this.tokens -= 1
        this.emit({ level: 'warn', event: 'logging.emergency.suppressed', count })
        if (this.tokens < 1) {
          this.suppressedCount += 1
          this.totalSuppressed += 1
          return
        }
      }
      this.tokens -= 1
      this.emit(fields)
    } catch {
      // The emergency path must be unable to fail the caller.
    }
  }

  private emit(fields: Record<string, unknown>): void {
    const record: Record<string, unknown> = { ts: new Date(this.now()).toISOString(), ...fields }
    if (typeof record.msg === 'string') record.msg = scrubString(capString(record.msg, 1024))
    if (typeof record.message === 'string') record.message = scrubString(capString(record.message, 1024))
    this.writeLine(JSON.stringify(record))
  }

  private refill(): void {
    const current = this.now()
    const elapsed = Math.max(0, current - this.last)
    this.last = current
    this.tokens = Math.min(this.rate, this.tokens + (elapsed / 1000) * this.rate)
  }
}
