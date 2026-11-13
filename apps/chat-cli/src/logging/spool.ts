/**
 * Bounded on-disk spool for sinks that must not lose records during an outage
 * (PostgreSQL, OTLP). One segment file per failed batch, oldest replayed first.
 *
 * Delivery is at-least-once: a segment is deleted only after the sink accepted
 * it, so a crash between write and delete can replay duplicates. The spool has
 * hard size/file limits; when full, the oldest segments are dropped and counted.
 */

import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LogEvent } from './event.ts'

export interface SpoolStats {
  files: number
  bytes: number
  maxBytes: number
  maxFiles: number
  appended: number
  replayed: number
  droppedFiles: number
  droppedRecords: number
}

export interface SpooledBatch {
  events: LogEvent[]
  /** Delete the segment after successful delivery. */
  commit(): Promise<void>
  /** Leave the segment for a later retry. */
  requeue(): Promise<void>
}

export interface BatchSpool {
  append(batch: readonly LogEvent[]): Promise<void>
  take(): Promise<SpooledBatch | undefined>
  stats(): SpoolStats
  close?(): Promise<void>
}

interface Segment {
  name: string
  path: string
  bytes: number
}

export interface FileSpoolOptions {
  directory: string
  /** Hard cap for all segment files (default 64 MB). */
  maxBytes?: number
  /** Hard cap for segment count (default 512). */
  maxFiles?: number
  /** Injectable clock for tests/retention. */
  now?: () => number
}

const SAFE_NAME = /^spool-\d+-\d+-[A-Za-z0-9]+\.jsonl$/

export class FileSpool implements BatchSpool {
  private readonly directory: string
  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly now: () => number
  private segments: Segment[] | undefined
  private bytes = 0
  private appended = 0
  private replayed = 0
  private droppedFiles = 0
  private droppedRecords = 0
  private seq = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(options: FileSpoolOptions) {
    this.directory = options.directory
    this.maxBytes = Math.max(64 * 1024, options.maxBytes ?? 64 * 1024 * 1024)
    this.maxFiles = Math.max(4, options.maxFiles ?? 512)
    this.now = options.now ?? Date.now
  }

  async append(batch: readonly LogEvent[]): Promise<void> {
    if (batch.length === 0) return
    const text = batch.map((event) => JSON.stringify({ v: event.levelValue, l: event.line })).join('\n') + '\n'
    // Serialize appends so the segment list and totals stay consistent.
    const run = this.chain.then(async () => {
      await this.ensure()
      const name = `spool-${this.now()}-${this.seq++}-${process.pid.toString(36)}.jsonl`
      const path = join(this.directory, name)
      await writeFile(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      const bytes = Buffer.byteLength(text)
      this.segments!.push({ name, path, bytes })
      this.bytes += bytes
      this.appended += batch.length
      await this.prune()
    })
    this.chain = run.catch(() => undefined)
    await run
  }

  async take(): Promise<SpooledBatch | undefined> {
    await this.ensure()
    const segment = this.segments![0]
    if (segment === undefined) return undefined
    let events: LogEvent[] = []
    try {
      const text = await readFile(segment.path, 'utf8')
      events = []
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          const parsed = JSON.parse(line) as { v?: unknown; l?: unknown }
          if (typeof parsed.l === 'string') {
            const value = typeof parsed.v === 'number' ? parsed.v : 30
            events.push(new LogEvent(value, parsed.l))
          }
        } catch {
          // A torn final line is expected after a crash; skip it.
        }
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ENOENT')) throw error
      this.removeFromList(segment)
      this.bytes -= segment.bytes
      return this.take()
    }
    return {
      events,
      commit: async () => {
        await unlink(segment.path).catch(() => {})
        this.removeFromList(segment)
        this.bytes -= segment.bytes
        this.replayed += events.length
      },
      requeue: async () => {
        // The file is still on disk; nothing to do.
      },
    }
  }

  stats(): SpoolStats {
    return {
      files: this.segments?.length ?? 0,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      maxFiles: this.maxFiles,
      appended: this.appended,
      replayed: this.replayed,
      droppedFiles: this.droppedFiles,
      droppedRecords: this.droppedRecords,
    }
  }

  async close(): Promise<void> {
    await this.chain.catch(() => undefined)
  }

  private async ensure(): Promise<void> {
    if (this.segments !== undefined) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const names = (await readdir(this.directory)).filter((name) => SAFE_NAME.test(name)).sort()
    const segments: Segment[] = []
    let bytes = 0
    for (const name of names) {
      const path = join(this.directory, name)
      try {
        const info = await stat(path)
        segments.push({ name, path, bytes: info.size })
        bytes += info.size
      } catch {
        // Removed concurrently; ignore.
      }
    }
    this.segments = segments
    this.bytes = bytes
    await this.prune()
  }

  /** Drop oldest segments until both limits are satisfied. */
  private async prune(): Promise<void> {
    const segments = this.segments
    if (segments === undefined) return
    while (segments.length > this.maxFiles || this.bytes > this.maxBytes) {
      const oldest = segments.shift()
      if (oldest === undefined) break
      this.bytes -= oldest.bytes
      this.droppedFiles += 1
      let records = 0
      try {
        const text = await readFile(oldest.path, 'utf8')
        records = text.split('\n').filter((line) => line.trim() !== '').length
      } catch {
        // If it cannot be read it cannot be replayed either.
      }
      this.droppedRecords += records
      await unlink(oldest.path).catch(() => {})
    }
  }

  private removeFromList(segment: Segment): void {
    if (this.segments === undefined) return
    const index = this.segments.indexOf(segment)
    if (index >= 0) this.segments.splice(index, 1)
  }
}

