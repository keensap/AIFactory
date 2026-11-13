import { LEVEL_VALUE, levelFromValue, type Level } from './levels.ts'

/** The record shape sinks see after parsing. Unknown extra fields are allowed. */
export interface LogRecord {
  schema?: number
  ts?: string
  level: Level
  event?: string
  msg?: string
  component?: string
  service?: string
  version?: string
  env?: string
  host?: string
  pid?: number
  requestId?: string
  traceId?: string
  spanId?: string
  projectId?: string
  stageRunId?: string
  stage?: string
  role?: string
  err?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * One serialized log event. The JSON line is built once on the hot path; the
 * parsed record is created lazily and only by sinks that need fields.
 */
export class LogEvent {
  readonly levelValue: number
  readonly line: string
  private parsed: LogRecord | undefined

  constructor(levelValue: number, line: string) {
    this.levelValue = levelValue
    this.line = line
  }

  get level(): Level {
    return levelFromValue(this.levelValue)
  }

  get record(): LogRecord {
    if (this.parsed === undefined) {
      try {
        this.parsed = JSON.parse(this.line) as LogRecord
      } catch {
        this.parsed = { level: this.level, msg: this.line.slice(0, 1024) }
      }
    }
    return this.parsed
  }
}

export function levelAtLeast(event: LogEvent, min: Level): boolean {
  return event.levelValue >= LEVEL_VALUE[min]
}
