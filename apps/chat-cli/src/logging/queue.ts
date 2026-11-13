/**
 * Bounded, priority-aware record queue.
 *
 * Memory is capped by record count and approximate size. When full, the
 * lowest-priority oldest record is evicted first, so `error`/`fatal` records
 * survive until the queue is entirely high-priority. Every drop is counted.
 */

import { LEVEL_NAMES, LEVEL_VALUE, levelFromValue, type Level } from './levels.ts'

export interface QueuedRecord {
  levelValue: number
  line: string
}

interface Item extends QueuedRecord {
  seq: number
}

class Bucket {
  items: Item[] = []
  head = 0
  get length(): number {
    return this.items.length - this.head
  }
  peek(): Item | undefined {
    return this.items[this.head]
  }
  shift(): Item | undefined {
    const item = this.items[this.head]
    if (item === undefined) return undefined
    this.head += 1
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
    return item
  }
  push(item: Item): void {
    this.items.push(item)
  }
}

export interface QueueStats {
  size: number
  bytes: number
  maxRecords: number
  maxBytes: number
  dropped: Record<Level, number>
  bytesDropped: number
}

export class BoundedQueue {
  private readonly buckets: Bucket[] = LEVEL_NAMES.map(() => new Bucket())
  private seq = 0
  private count = 0
  private bytes = 0
  private readonly dropped: Record<Level, number> = { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 }
  private bytesDropped = 0
  private readonly maxRecords: number
  private readonly maxBytes: number

  constructor(maxRecords = 10_000, maxBytes = 16 * 1024 * 1024) {
    this.maxRecords = Math.max(1, maxRecords)
    this.maxBytes = Math.max(1024, maxBytes)
  }

  get size(): number {
    return this.count
  }

  /** Returns false when the incoming record itself was dropped. */
  push(record: QueuedRecord): boolean {
    const size = record.line.length
    if (size > this.maxBytes) {
      this.countDrop(record.levelValue, size)
      return false
    }
    while (this.count + 1 > this.maxRecords || this.bytes + size > this.maxBytes) {
      if (!this.evictFor(record.levelValue)) {
        this.countDrop(record.levelValue, size)
        return false
      }
    }
    this.buckets[this.bucketIndex(record.levelValue)]!.push({ ...record, seq: this.seq++ })
    this.count += 1
    this.bytes += size
    return true
  }

  /** Remove up to `max` records in original arrival order. */
  drain(max: number): QueuedRecord[] {
    const out: QueuedRecord[] = []
    while (out.length < max && this.count > 0) {
      let best: Bucket | undefined
      let bestSeq = Number.POSITIVE_INFINITY
      for (const bucket of this.buckets) {
        const head = bucket.peek()
        if (head !== undefined && head.seq < bestSeq) {
          best = bucket
          bestSeq = head.seq
        }
      }
      const item = best?.shift()
      if (item === undefined) break
      this.count -= 1
      this.bytes -= item.line.length
      out.push({ levelValue: item.levelValue, line: item.line })
    }
    return out
  }

  stats(): QueueStats {
    return {
      size: this.count,
      bytes: this.bytes,
      maxRecords: this.maxRecords,
      maxBytes: this.maxBytes,
      dropped: { ...this.dropped },
      bytesDropped: this.bytesDropped,
    }
  }

  /** Evict the oldest record whose priority is <= the incoming one. */
  private evictFor(levelValue: number): boolean {
    const limit = this.bucketIndex(levelValue)
    for (let index = 0; index <= limit; index++) {
      const item = this.buckets[index]!.shift()
      if (item !== undefined) {
        this.count -= 1
        this.bytes -= item.line.length
        this.countDrop(item.levelValue, item.line.length)
        return true
      }
    }
    return false
  }

  private countDrop(levelValue: number, size: number): void {
    this.dropped[levelFromValue(levelValue)] += 1
    this.bytesDropped += size
  }

  private bucketIndex(levelValue: number): number {
    let index = 0
    for (let i = 0; i < LEVEL_NAMES.length; i++) {
      if (LEVEL_VALUE[LEVEL_NAMES[i]!] <= levelValue) index = i
    }
    return index
  }
}
