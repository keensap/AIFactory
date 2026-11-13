import type { LogEvent } from './event.ts'
import type { Level } from './levels.ts'

/**
 * A destination for log events. Implement this and register it to add a sink
 * (console, file, PostgreSQL, OTLP…). Sinks never run on the application hot
 * path and are isolated: a throwing or hanging sink cannot affect the app or
 * other sinks.
 */
export interface LogSink {
  readonly name: string
  /** Only events at or above this level are delivered. */
  readonly minLevel?: Level
  /** Opt in to the bounded disk spool when the sink fails or its breaker opens. */
  readonly spool?: boolean
  write(batch: readonly LogEvent[], signal: AbortSignal): Promise<void> | void
  flush?(signal: AbortSignal): Promise<void> | void
  close?(): Promise<void> | void
}
