/**
 * Safe, bounded conversion of arbitrary caller data into plain JSON-able values.
 *
 * This is the first line of the "logging never hurts the app" guarantee:
 * every property read is guarded (throwing getters, hostile Proxies), depth,
 * width and string sizes are capped, circular references are cut, and obvious
 * secrets are scrubbed from strings. pino then only ever sees clean data.
 */

import type { LogFields } from './context.ts'

export const MAX_STRING_CHARS = 8 * 1024
export const MAX_STACK_CHARS = 8 * 1024
export const MAX_MESSAGE_CHARS = 4 * 1024
export const MAX_DEPTH = 6
export const MAX_ITEMS = 100
export const MAX_RECORD_CHARS = 64 * 1024

/** Keys the pipeline owns; caller fields with these names are prefixed. */
const RESERVED_KEYS = new Set(['level', 'ts', 'time', 'msg', 'schema', 'service', 'version', 'env', 'host', 'pid', 'hostname'])

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,512}/gi, '$1 [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{16,256}/g, 'sk-[redacted]'],
  [/(:\/\/[^/\s:@]{1,128}:)[^@\s/]{1,256}@/g, '$1[redacted]@'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)(\s*[=:]\s*)("[^"]{1,256}"|'[^']{1,256}'|[^\s,;&"']{1,256})/gi, '$1$2[redacted]'],
]

export function scrubString(value: string): string {
  let out = value
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

export function capString(value: string, max = MAX_STRING_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated ${value.length - max} chars]`
}

function cleanString(value: string, max = MAX_STRING_CHARS): string {
  return scrubString(capString(value, max))
}

export function normalizeError(error: Error, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  try {
    out.type = typeof error.name === 'string' && error.name !== '' ? error.name : 'Error'
    out.message = cleanString(String(error.message), MAX_MESSAGE_CHARS)
    if (typeof error.stack === 'string') out.stack = cleanString(error.stack, MAX_STACK_CHARS)
    const extra = error as unknown as Record<string, unknown>
    for (const key of ['code', 'status', 'statusCode', 'errno', 'syscall']) {
      const value = safeGet(extra, key)
      if (typeof value === 'string' || typeof value === 'number') out[key] = value
    }
    const cause = safeGet(extra, 'cause')
    if (cause instanceof Error && depth < 3) out.cause = normalizeError(cause, depth + 1)
    else if (cause !== undefined && depth < 3) out.cause = sanitizeValue(cause, depth + 1, new WeakSet())
  } catch {
    out.type ??= 'Error'
    out.message ??= '[unreadable error]'
  }
  return out
}

function safeGet(target: unknown, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key]
  } catch {
    return '[unreadable]'
  }
}

export function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  try {
    if (value === null || value === undefined) return value
    switch (typeof value) {
      case 'string':
        return cleanString(value)
      case 'number':
        return Number.isFinite(value) ? value : String(value)
      case 'boolean':
        return value
      case 'bigint':
        return value.toString()
      case 'symbol':
        return value.toString()
      case 'function':
        return '[function]'
      default:
        break
    }
    const object = value as object
    if (object instanceof Error) return normalizeError(object, depth)
    if (object instanceof Date) {
      const time = object.getTime()
      return Number.isNaN(time) ? 'invalid-date' : object.toISOString()
    }
    if (object instanceof Uint8Array) return `[binary ${object.byteLength} bytes]`
    if (seen.has(object)) return '[circular]'
    if (depth >= MAX_DEPTH) return '[max-depth]'
    seen.add(object)
    try {
      if (Array.isArray(object)) {
        const items = object.slice(0, MAX_ITEMS).map((item) => sanitizeValue(item, depth + 1, seen))
        if (object.length > MAX_ITEMS) items.push(`[+${object.length - MAX_ITEMS} more]`)
        return items
      }
      if (object instanceof Map) {
        return sanitizeValue(Object.fromEntries([...object].slice(0, MAX_ITEMS).map(([k, v]) => [String(k), v])), depth, seen)
      }
      if (object instanceof Set) {
        return sanitizeValue([...object].slice(0, MAX_ITEMS), depth, seen)
      }
      return sanitizeObject(object as Record<string, unknown>, depth, seen)
    } finally {
      seen.delete(object)
    }
  } catch {
    return '[unserializable]'
  }
}

function sanitizeObject(object: Record<string, unknown>, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let keys: string[]
  try {
    keys = Object.keys(object)
  } catch {
    return { '[unreadable]': true }
  }
  let count = 0
  for (const key of keys) {
    if (key === '__proto__') continue
    if (count >= MAX_ITEMS) {
      out['[truncated]'] = `${keys.length - MAX_ITEMS} more keys`
      break
    }
    out[key] = sanitizeValue(safeGet(object, key), depth + 1, seen)
    count++
  }
  return out
}

/** Sanitize top-level fields and protect reserved keys. */
export function sanitizeFields(fields: LogFields): LogFields {
  const cleaned = sanitizeValue(fields, 0, new WeakSet())
  if (cleaned === null || typeof cleaned !== 'object' || Array.isArray(cleaned)) return { data: cleaned }
  const out: LogFields = {}
  for (const [key, value] of Object.entries(cleaned as LogFields)) {
    out[RESERVED_KEYS.has(key) ? `field_${key}` : key] = value
  }
  return out
}
