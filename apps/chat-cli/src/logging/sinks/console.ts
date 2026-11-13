import { guardStream } from '../emergency.ts'
import type { LogEvent } from '../event.ts'
import type { Level } from '../levels.ts'
import type { LogSink } from '../sink.ts'

export interface ConsoleSinkOptions {
  format?: 'json' | 'pretty'
  minLevel?: Level
  color?: boolean
  /** Defaults to process.stdout. Injectable for tests. */
  write?: (text: string) => void
}

const HIDDEN = new Set(['schema', 'ts', 'level', 'event', 'msg', 'component', 'service', 'version', 'env', 'host', 'pid'])
const COLORS: Record<string, string> = { trace: '90', debug: '36', info: '32', warn: '33', error: '31', fatal: '35' }

export class ConsoleSink implements LogSink {
  readonly name = 'console'
  readonly minLevel?: Level
  private readonly format: 'json' | 'pretty'
  private readonly color: boolean
  private readonly writeText: (text: string) => void

  constructor(options: ConsoleSinkOptions = {}) {
    if (options.minLevel !== undefined) this.minLevel = options.minLevel
    this.format = options.format ?? 'json'
    this.color = options.color ?? false
    if (options.write !== undefined) {
      this.writeText = options.write
    } else {
      guardStream(process.stdout)
      this.writeText = (text) => { process.stdout.write(text) }
    }
  }

  write(batch: readonly LogEvent[]): void {
    let text = ''
    for (const event of batch) {
      text += this.format === 'json' ? `${event.line}\n` : `${this.pretty(event)}\n`
    }
    this.writeText(text)
  }

  private pretty(event: LogEvent): string {
    const record = event.record
    const time = typeof record.ts === 'string' ? record.ts.slice(11, 23) : '--:--:--.---'
    const level = event.level.toUpperCase().padEnd(5)
    const coloredLevel = this.color ? `\u001b[${COLORS[event.level] ?? '0'}m${level}\u001b[0m` : level
    const parts = [`${time} ${coloredLevel}`]
    if (typeof record.component === 'string') parts.push(`[${record.component}]`)
    if (typeof record.event === 'string') parts.push(record.event)
    if (typeof record.msg === 'string' && record.msg !== '') parts.push(`— ${record.msg}`)
    const fields: string[] = []
    for (const [key, value] of Object.entries(record)) {
      if (HIDDEN.has(key)) continue
      if (key === 'err' && value !== null && typeof value === 'object') {
        const err = value as Record<string, unknown>
        fields.push(`err=${String(err.type ?? 'Error')}: ${String(err.message ?? '')}`)
        continue
      }
      fields.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    }
    return fields.length === 0 ? parts.join(' ') : `${parts.join(' ')}  ${fields.join(' ')}`
  }
}
