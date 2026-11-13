/**
 * Logging pipeline: facade → sanitize → pino serialize → bounded queue →
 * async pump → isolated sinks.
 *
 * Guarantees (see docs/design/LOGGING-ARCHITECTURE.md):
 *  - a log call never throws, awaits, or does I/O;
 *  - memory is bounded regardless of sink speed;
 *  - a failing/slow/hanging sink only affects itself;
 *  - shutdown always resolves within its deadline.
 */

import { hostname } from 'node:os'
import { join } from 'node:path'
import { pino, type Logger as PinoLogger } from 'pino'
import { ambientFields, type LogFields, type TraceContextSource } from './context.ts'
import { EmergencySink, type EmergencyOptions } from './emergency.ts'
import { LogEvent } from './event.ts'
import { LEVEL_VALUE, LevelController, type Level, type LevelSnapshot } from './levels.ts'
import { BoundedQueue, type QueueStats } from './queue.ts'
import { FileSpool } from './spool.ts'
import { SinkRunner, type RunnerOptions, type SinkStats } from './runner.ts'
import { MAX_MESSAGE_CHARS, MAX_RECORD_CHARS, capString, normalizeError, sanitizeFields, scrubString } from './sanitize.ts'
import type { LogSink } from './sink.ts'

export interface Logger {
  trace(fields: LogFields | string, message?: string): void
  debug(fields: LogFields | string, message?: string): void
  info(fields: LogFields | string, message?: string): void
  warn(fields: LogFields | string, message?: string): void
  error(fields: LogFields | string, message?: string): void
  fatal(fields: LogFields | string, message?: string): void
  /** Serilog `ForContext`: bind fields (typically `component`) to every record. */
  child(bindings: LogFields): Logger
  isEnabled(level: Level): boolean
}

export interface LoggingOptions {
  service: string
  version?: string
  env?: string
  level?: Level
  override?: Record<string, Level>
  redact?: string[]
  queue?: { maxRecords?: number; maxBytes?: number }
  sinks?: LogSink[]
  emergency?: EmergencyOptions
  sinkTimeoutMs?: number
  maxPendingBatches?: number
  batchSize?: number
  /** Retry policy applied to every sink write. */
  sinkRetry?: { retries?: number; baseMs?: number }
  /** Circuit breaker applied to every sink. */
  breaker?: { threshold?: number; cooldownMs?: number; maxCooldownMs?: number }
  /** Bounded disk spool for sinks that opt in (`sink.spool === true`). */
  spool?: { directory: string; maxBytes?: number; maxFiles?: number }
  /** Optional provider-neutral trace id source for log enrichment. */
  traceContext?: TraceContextSource
}

export interface LoggingDiagnostics {
  closed: boolean
  levels: LevelSnapshot
  queue: QueueStats
  facadeErrors: number
  emergencySuppressed: number
  sinks: SinkStats[]
}

export interface ShutdownResult {
  flushed: boolean
  lost: number
}

export interface Logging {
  readonly logger: Logger
  readonly levels: LevelController
  diagnostics(): LoggingDiagnostics
  addSink(sink: LogSink): void
  removeSink(name: string): Promise<void>
  /** Synchronous, rate-limited stderr record for crash paths where async delivery cannot be trusted. */
  emergency(fields: LogFields): void
  /** Deliver everything queued so far to the sinks (bounded wait). Never throws. */
  flush(options?: { timeoutMs?: number }): Promise<boolean>
  shutdown(options?: { timeoutMs?: number }): Promise<ShutdownResult>
}

export const DEFAULT_REDACT = [
  'password', 'passwd', 'secret', 'token', 'apiKey', 'api_key', 'authorization', 'cookie',
  '*.password', '*.passwd', '*.secret', '*.token', '*.apiKey', '*.api_key', '*.authorization', '*.cookie',
]

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
const CORE_KEYS = ['schema', 'ts', 'level', 'event', 'component', 'service', 'version', 'env', 'host', 'pid',
  'requestId', 'traceId', 'spanId', 'projectId', 'stageRunId', 'stage', 'role']

class Core {
  readonly controller: LevelController
  readonly queue: BoundedQueue
  readonly emergency: EmergencySink
  readonly runners: SinkRunner[] = []
  readonly pino: PinoLogger
  readonly batchSize: number
  readonly sinkTimeoutMs: number
  readonly maxPendingBatches: number
  readonly replayTimer: ReturnType<typeof setInterval> | undefined
  private readonly runnerOptions: Omit<RunnerOptions, 'timeoutMs' | 'maxPendingBatches' | 'onFailure' | 'onStateChange'>
  private readonly spoolOptions?: { directory: string; maxBytes?: number; maxFiles?: number }
  readonly spools = new Map<string, FileSpool>()
  closed = false
  facadeErrors = 0
  currentLevel = 0
  private scheduled = false

  constructor(options: LoggingOptions) {
    this.controller = new LevelController(options.level ?? 'info', options.override ?? {})
    this.queue = new BoundedQueue(options.queue?.maxRecords, options.queue?.maxBytes)
    this.emergency = new EmergencySink(options.emergency)
    this.batchSize = options.batchSize ?? 256
    this.sinkTimeoutMs = options.sinkTimeoutMs ?? 5000
    this.maxPendingBatches = options.maxPendingBatches ?? 64
    this.spoolOptions = options.spool
    this.runnerOptions = {
      ...(options.sinkRetry?.retries !== undefined ? { retries: options.sinkRetry.retries } : {}),
      ...(options.sinkRetry?.baseMs !== undefined ? { retryBaseMs: options.sinkRetry.baseMs } : {}),
      ...(options.breaker?.threshold !== undefined ? { breakerThreshold: options.breaker.threshold } : {}),
      ...(options.breaker?.cooldownMs !== undefined ? { breakerCooldownMs: options.breaker.cooldownMs } : {}),
      ...(options.breaker?.maxCooldownMs !== undefined ? { breakerMaxCooldownMs: options.breaker.maxCooldownMs } : {}),
    }
    const destination = { write: (line: string): void => { this.enqueue(line) } }
    this.pino = pino(
      {
        level: 'trace',
        base: {
          schema: 1,
          service: options.service,
          version: options.version ?? '0.0.0',
          env: options.env ?? 'local',
          host: hostname(),
          pid: process.pid,
        },
        timestamp: () => `,"ts":"${new Date().toISOString()}"`,
        messageKey: 'msg',
        // Errors are already normalized by sanitize.ts; pino's default `err`
        // serializer would re-wrap our plain object and mangle type/message.
        serializers: { err: (value: unknown) => value },
        formatters: { level: (label: string) => ({ level: label }) },
        redact: { paths: options.redact ?? DEFAULT_REDACT, censor: '[redacted]' },
        mixin: () => sanitizeFields(ambientFields(options.traceContext)),
      },
      destination,
    )
    for (const sink of options.sinks ?? []) this.addSink(sink)
    this.replayTimer = setInterval(() => { for (const runner of this.runners) runner.replay() }, 30_000)
    this.replayTimer.unref?.()
  }

  addSink(sink: LogSink): void {
    if (this.runners.some((runner) => runner.sink.name === sink.name)) return
    const spool = this.spoolOptions !== undefined && sink.spool === true
      ? new FileSpool({
          directory: join(this.spoolOptions.directory, sink.name),
          ...(this.spoolOptions.maxBytes !== undefined ? { maxBytes: this.spoolOptions.maxBytes } : {}),
          ...(this.spoolOptions.maxFiles !== undefined ? { maxFiles: this.spoolOptions.maxFiles } : {}),
        })
      : undefined
    const runner = new SinkRunner(sink, {
      ...this.runnerOptions,
      timeoutMs: this.sinkTimeoutMs,
      maxPendingBatches: this.maxPendingBatches,
      ...(spool !== undefined ? { spool } : {}),
      onFailure: (name, message) => {
        this.emergency.write({ level: 'warn', event: 'logging.sink_failed', sink: name, message })
      },
      onStateChange: (name, state) => {
        this.emergency.write({ level: state === 'healthy' ? 'info' : 'warn', event: 'logging.sink_state', sink: name, state })
      },
    })
    this.runners.push(runner)
    if (spool !== undefined) {
      this.spools.set(sink.name, spool)
      // Replay anything left from a previous process without waiting for new logs.
      setImmediate(() => runner.replay()).unref?.()
    }
  }

  enqueue(line: string): void {
    try {
      // pino terminates every record with a newline; sinks add their own framing.
      let output = line.endsWith('\n') ? line.slice(0, -1) : line
      if (output.length > MAX_RECORD_CHARS) output = shrink(output)
      this.queue.push({ levelValue: this.currentLevel, line: output })
      this.schedule()
    } catch (error) {
      this.facadeFailure(error, 'enqueue')
    }
  }

  schedule(): void {
    if (this.scheduled || this.closed) return
    this.scheduled = true
    const immediate = setImmediate(() => {
      this.scheduled = false
      this.pump()
    })
    immediate.unref?.()
  }

  /** Move queued records to the sink runners. Never throws. */
  pump(): void {
    try {
      for (;;) {
        const batch = this.queue.drain(this.batchSize)
        if (batch.length === 0) break
        const events = batch.map((item) => new LogEvent(item.levelValue, item.line))
        for (const runner of this.runners) runner.enqueue(events)
      }
    } catch (error) {
      this.facadeFailure(error, 'pump')
    }
  }

  facadeFailure(error: unknown, where: string): void {
    this.facadeErrors += 1
    this.emergency.write({
      level: 'error',
      event: 'logging.facade_error',
      where,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  pendingEvents(): number {
    return this.queue.size + this.runners.reduce((sum, runner) => sum + runner.pendingEvents(), 0)
  }
}

/** Reduce an oversized record to its core fields. */
function shrink(line: string): string {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of CORE_KEYS) if (parsed[key] !== undefined) out[key] = parsed[key]
    if (typeof parsed.msg === 'string') out.msg = capString(parsed.msg, 1024)
    out.truncated = true
    out.originalChars = line.length
    return JSON.stringify(out)
  } catch {
    return JSON.stringify({ level: 'warn', event: 'logging.record_truncated', truncated: true, originalChars: line.length })
  }
}

const EMPTY: LogFields = {}

class LoggerImpl implements Logger {
  private readonly core: Core
  private readonly bindings: LogFields
  private readonly component: string | undefined

  constructor(core: Core, bindings: LogFields) {
    this.core = core
    this.bindings = bindings
    this.component = typeof bindings.component === 'string' ? bindings.component : undefined
  }

  trace(fields: LogFields | string, message?: string): void { this.write('trace', fields, message) }
  debug(fields: LogFields | string, message?: string): void { this.write('debug', fields, message) }
  info(fields: LogFields | string, message?: string): void { this.write('info', fields, message) }
  warn(fields: LogFields | string, message?: string): void { this.write('warn', fields, message) }
  error(fields: LogFields | string, message?: string): void { this.write('error', fields, message) }
  fatal(fields: LogFields | string, message?: string): void { this.write('fatal', fields, message) }

  child(bindings: LogFields): Logger {
    try {
      return new LoggerImpl(this.core, { ...this.bindings, ...sanitizeFields(bindings) })
    } catch {
      return this
    }
  }

  isEnabled(level: Level): boolean {
    try {
      return !this.core.closed && this.core.controller.isEnabled(level, this.component)
    } catch {
      return false
    }
  }

  private write(level: Level, first: LogFields | string, second: string | undefined): void {
    try {
      const value = LEVEL_VALUE[level]
      if (value < this.core.controller.levelFor(this.component)) return
      let fields: LogFields
      let message: string | undefined
      if (typeof first === 'string') {
        fields = EMPTY
        message = first
      } else {
        fields = first ?? EMPTY
        message = second
      }
      if (this.core.closed) {
        if (value >= LEVEL_VALUE.error) {
          this.core.emergency.write({ level, event: 'logging.after_shutdown', message: message ?? '', ...flat(fields) })
        }
        return
      }
      const merged = this.bindings === EMPTY || Object.keys(this.bindings).length === 0
        ? sanitizeFields(fields)
        : { ...this.bindings, ...sanitizeFields(fields) }
      const text = message === undefined ? undefined : scrubString(capString(message, MAX_MESSAGE_CHARS))
      this.core.currentLevel = value
      if (text === undefined) this.core.pino[level](merged)
      else this.core.pino[level](merged, text)
    } catch (error) {
      this.core.facadeFailure(error, 'write')
    }
  }
}

function flat(fields: LogFields): LogFields {
  try {
    const out: LogFields = {}
    for (const key of ['event', 'component', 'projectId', 'stageRunId'] as const) {
      const value = fields[key]
      if (typeof value === 'string') out[key] = value
    }
    const err = fields.err
    if (err instanceof Error) out.err = normalizeError(err)
    return out
  } catch {
    return {}
  }
}

function flat2(fields: LogFields): LogFields {
  try {
    const out = sanitizeFields(fields)
    if (out.level === undefined) out.level = 'fatal'
    return out
  } catch {
    return { level: 'fatal', event: 'logging.emergency' }
  }
}

export function createLogging(options: LoggingOptions): Logging {
  const core = new Core(options)
  const logger: Logger = new LoggerImpl(core, EMPTY)

  const withDeadline = async (work: Promise<unknown>, ms: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, ms))
      timer.unref?.()
    })
    try {
      return (await Promise.race([work.then(() => true, () => true), deadline])) === true
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  return {
    logger,
    levels: core.controller,

    diagnostics(): LoggingDiagnostics {
      return {
        closed: core.closed,
        levels: core.controller.snapshot(),
        queue: core.queue.stats(),
        facadeErrors: core.facadeErrors,
        emergencySuppressed: core.emergency.suppressed,
        sinks: core.runners.map((runner) => runner.stats()),
      }
    },

    addSink(sink: LogSink): void {
      try {
        core.addSink(sink)
      } catch (error) {
        core.facadeFailure(error, 'addSink')
      }
    },

    emergency(fields: LogFields): void {
      core.emergency.write(flat2(fields))
    },

    async flush(flushOptions: { timeoutMs?: number } = {}): Promise<boolean> {
      try {
        core.pump()
        for (const runner of core.runners) runner.replay()
        return await withDeadline(Promise.all(core.runners.map((runner) => runner.idle())), flushOptions.timeoutMs ?? 2000)
      } catch (error) {
        core.facadeFailure(error, 'flush')
        return false
      }
    },

    async removeSink(name: string): Promise<void> {
      try {
        const index = core.runners.findIndex((runner) => runner.sink.name === name)
        if (index < 0) return
        const [runner] = core.runners.splice(index, 1)
        if (runner === undefined) return
        await withDeadline(runner.idle(), core.sinkTimeoutMs)
        await withDeadline(runner.close(core.sinkTimeoutMs), core.sinkTimeoutMs)
        const spool = core.spools.get(name)
        core.spools.delete(name)
        await spool?.close()
      } catch (error) {
        core.facadeFailure(error, 'removeSink')
      }
    },

    async shutdown(shutdownOptions: { timeoutMs?: number } = {}): Promise<ShutdownResult> {
      const timeoutMs = shutdownOptions.timeoutMs ?? 2000
      const started = Date.now()
      const remaining = (): number => Math.max(0, timeoutMs - (Date.now() - started))
      try {
        core.pump()
        const drained = await withDeadline(Promise.all(core.runners.map((runner) => runner.idle())), remaining())
        core.closed = true
        await withDeadline(Promise.all(core.runners.map((runner) => runner.flush(remaining()))), remaining())
        await withDeadline(Promise.all(core.runners.map((runner) => runner.close(remaining()))), remaining())
        if (core.replayTimer !== undefined) clearInterval(core.replayTimer)
        await Promise.all([...core.spools.values()].map((spool) => spool.close().catch(() => {})))
        core.spools.clear()
        core.controller.dispose()
        const lost = core.pendingEvents()
        if (!drained || lost > 0) {
          core.emergency.write({ level: 'warn', event: 'logging.shutdown_incomplete', lost })
        }
        return { flushed: drained && lost === 0, lost }
      } catch (error) {
        core.closed = true
        core.facadeFailure(error, 'shutdown')
        return { flushed: false, lost: core.pendingEvents() }
      }
    },
  }
}

export const noopLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() { return noopLogger },
  isEnabled() { return false },
}

export { LEVELS }
