/**
 * Ambient log context (Serilog `LogContext` / enrichers).
 *
 * Fields set here (requestId, projectId, stageRunId, stage, role, traceId…) are
 * attached to every record emitted inside the async scope, without passing a
 * logger through every call.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { TraceContext } from '../observability/ports.ts'

export type LogFields = Record<string, unknown>
export type TraceContextSource = () => TraceContext | undefined

const storage = new AsyncLocalStorage<LogFields>()

/** Run `fn` with extra ambient fields; nested scopes inherit and override. */
export function runWithLogContext<T>(fields: LogFields, fn: () => T): T {
  const parent = storage.getStore()
  return storage.run({ ...parent, ...fields }, fn)
}

/** Add fields to the current scope (no-op outside a scope). */
export function addLogContext(fields: LogFields): void {
  const store = storage.getStore()
  if (store !== undefined) Object.assign(store, fields)
}

export function currentLogContext(): LogFields | undefined {
  return storage.getStore()
}

/** Ambient fields plus trace ids supplied by the configured observability provider. */
export function ambientFields(traceContext?: TraceContextSource): LogFields {
  try {
    const result: LogFields = { ...storage.getStore() }
    if (traceContext !== undefined && result.traceId === undefined) {
      const context = traceContext()
      if (context !== undefined) {
        result.traceId = context.traceId
        result.spanId = context.spanId
      }
    }
    return result
  } catch {
    return {}
  }
}
