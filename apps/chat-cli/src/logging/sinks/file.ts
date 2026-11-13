import { appendFile, chmod, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { LogEvent } from '../event.ts'
import type { Level } from '../levels.ts'
import type { LogSink } from '../sink.ts'

export interface FileSinkOptions {
  /** Directory for log files. Created with mode 0700 if missing. */
  directory: string
  /** File name prefix; files are `<prefix>-YYYY-MM-DD[.N].jsonl`. */
  prefix?: string
  /** Rotate to a new numbered file when the current one reaches this size. */
  maxFileBytes?: number
  /** Delete log files older than this many days (default 7). 0 disables deletion. */
  retentionDays?: number
  minLevel?: Level
  /** Injectable clock for tests. */
  now?: () => Date
}

/**
 * Rolling JSONL file sink: one file per UTC day, numbered segments when a file
 * exceeds `maxFileBytes`, and age-based retention. Runs inside the isolated sink
 * runner, so a full disk or permission error only degrades this sink.
 */
export class FileSink implements LogSink {
  readonly name = 'file'
  readonly minLevel?: Level
  private readonly directory: string
  private readonly prefix: string
  private readonly maxFileBytes: number
  private retentionDays: number
  private readonly now: () => Date
  private ready: Promise<void> | undefined
  private day = ''
  private segment = 0
  private size = 0
  private lastCleanup = 0

  constructor(options: FileSinkOptions) {
    this.directory = options.directory
    this.prefix = options.prefix ?? 'aifactory'
    this.maxFileBytes = Math.max(1024, options.maxFileBytes ?? 50 * 1024 * 1024)
    this.retentionDays = options.retentionDays ?? 7
    this.now = options.now ?? (() => new Date())
    if (options.minLevel !== undefined) this.minLevel = options.minLevel
  }

  /** Change retention at runtime; the next cleanup pass uses the new value. */
  setRetentionDays(days: number): void {
    this.retentionDays = Math.max(0, Math.floor(days))
    this.lastCleanup = 0
  }

  /** Path of the file currently being written (for diagnostics and tests). */
  get currentPath(): string {
    return this.pathFor(this.day === '' ? this.dayOf(this.now()) : this.day, this.segment)
  }

  async write(batch: readonly LogEvent[]): Promise<void> {
    await this.ensureDirectory()
    const text = batch.map((event) => event.line).join('\n') + '\n'
    const bytes = Buffer.byteLength(text)
    const today = this.dayOf(this.now())
    if (today !== this.day) {
      this.day = today
      this.segment = 0
      this.size = await this.currentSize()
    }
    while (this.size > 0 && this.size + bytes > this.maxFileBytes) {
      this.segment += 1
      this.size = await this.currentSize()
    }
    const path = this.pathFor(this.day, this.segment)
    const isNew = this.size === 0
    await appendFile(path, text, { encoding: 'utf8', mode: 0o600 })
    if (isNew) await chmod(path, 0o600).catch(() => {})
    this.size += bytes
    void this.maybeCleanup()
  }

  private ensureDirectory(): Promise<void> {
    this.ready ??= mkdir(this.directory, { recursive: true, mode: 0o700 }).then(() => undefined).catch((error: unknown) => {
      this.ready = undefined
      throw error
    })
    return this.ready
  }

  private async currentSize(): Promise<number> {
    try {
      return (await stat(this.pathFor(this.day, this.segment))).size
    } catch {
      return 0
    }
  }

  private pathFor(day: string, segment: number): string {
    const suffix = segment === 0 ? '' : `.${segment}`
    return join(this.directory, `${this.prefix}-${day}${suffix}.jsonl`)
  }

  private dayOf(date: Date): string {
    return date.toISOString().slice(0, 10)
  }

  /** Remove expired files at most once per hour. Failures are ignored. */
  private async maybeCleanup(): Promise<void> {
    if (this.retentionDays <= 0) return
    const current = this.now().getTime()
    if (current - this.lastCleanup < 60 * 60 * 1000) return
    this.lastCleanup = current
    try {
      const cutoff = current - this.retentionDays * 24 * 60 * 60 * 1000
      const pattern = new RegExp(`^${escapeRegExp(this.prefix)}-(\\d{4}-\\d{2}-\\d{2})(?:\\.\\d+)?\\.jsonl$`)
      for (const name of await readdir(this.directory)) {
        const match = pattern.exec(basename(name))
        if (match === null) continue
        const fileTime = Date.parse(`${match[1]}T23:59:59.999Z`)
        if (Number.isFinite(fileTime) && fileTime < cutoff) {
          await unlink(join(dirname(this.pathFor('x', 0)), name)).catch(() => {})
        }
      }
    } catch {
      // Retention is best-effort.
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
