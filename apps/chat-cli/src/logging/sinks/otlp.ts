/**
 * OTLP/HTTP JSON logs sink.
 *
 * Phoenix ingests OTLP **traces**, not logs (`POST /v1/logs` is 405), so this
 * sink targets a generic OTLP logs endpoint — an OpenTelemetry Collector, or a
 * backend that accepts OTLP logs. Logs still carry `traceId`/`spanId`, so they
 * can be correlated with the Phoenix traces for the same stage run.
 *
 * The sink is opt-in (`AIFACTORY_OTLP_LOGS_URL`) and, like every sink, runs
 * behind the retry/breaker/spool envelope. It never touches the hot path.
 */

import type { LogEvent, LogRecord } from '../event.ts'
import { LEVEL_VALUE, type Level } from '../levels.ts'
import type { LogSink } from '../sink.ts'

export interface OtlpLogsSinkOptions {
  /** Base endpoint (`http://collector:4318`) or the full logs URL (`.../v1/logs`). */
  endpoint: string
  headers?: Record<string, string>
  serviceName?: string
  environment?: string
  minLevel?: Level
  timeoutMs?: number
  /** Injectable fetch for tests. */
  fetch?: typeof fetch
}

const SEVERITY: Record<Level, number> = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 }

function logsUrl(endpoint: string): string {
  const url = new URL(endpoint)
  const path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/v1/logs')) return url.toString()
  if (path.endsWith('/v1')) url.pathname = `${path}/logs`
  else url.pathname = `${path}/v1/logs`
  return url.toString()
}

function stringAttribute(key: string, value: unknown): { key: string; value: Record<string, unknown> } | undefined {
  if (typeof value === 'string') return { key, value: { stringValue: value } }
  if (typeof value === 'number' && Number.isFinite(value)) return { key, value: { doubleValue: value } }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  if (value === null || value === undefined) return undefined
  try {
    return { key, value: { stringValue: JSON.stringify(value) } }
  } catch {
    return undefined
  }
}

function nano(value: unknown): string {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return (BigInt(Number.isFinite(time) ? time : Date.now()) * 1_000_000n).toString()
}

function hexId(value: unknown, expected: number): string | undefined {
  return typeof value === 'string' && new RegExp(`^[0-9a-fA-F]{${expected}}$`).test(value) ? value.toLowerCase() : undefined
}

function recordToOtlp(record: LogRecord, event: LogEvent): Record<string, unknown> {
  const attributes: Array<{ key: string; value: Record<string, unknown> }> = []
  for (const [key, value] of Object.entries(record)) {
    if (key === 'msg' || key === 'body') continue
    const attribute = stringAttribute(key, value)
    if (attribute !== undefined) attributes.push(attribute)
  }
  const out: Record<string, unknown> = {
    timeUnixNano: nano(record.ts),
    observedTimeUnixNano: nano(record.ts),
    severityNumber: SEVERITY[event.level],
    severityText: event.level.toUpperCase(),
    body: { stringValue: String(record.msg ?? record.event ?? '') },
    attributes,
  }
  const traceId = hexId(record.traceId, 32)
  const spanId = hexId(record.spanId, 16)
  if (traceId !== undefined) out.traceId = traceId
  if (spanId !== undefined) out.spanId = spanId
  return out
}

export function toOtlpPayload(events: readonly LogEvent[], serviceName: string, environment: string): Record<string, unknown> {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: serviceName } },
          { key: 'deployment.environment', value: { stringValue: environment } },
        ],
      },
      scopeLogs: [{
        scope: { name: 'aifactory', version: '1' },
        logRecords: events.map((event) => recordToOtlp(event.record, event)),
      }],
    }],
  }
}

export class OtlpLogsSink implements LogSink {
  readonly name = 'otlp'
  readonly minLevel?: Level
  readonly spool = true
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly serviceName: string
  private readonly environment: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: OtlpLogsSinkOptions) {
    this.url = logsUrl(options.endpoint)
    this.headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) }
    this.serviceName = options.serviceName ?? 'aifactory-api'
    this.environment = options.environment ?? 'local'
    this.timeoutMs = Math.max(500, options.timeoutMs ?? 5000)
    this.fetchImpl = options.fetch ?? fetch
    if (options.minLevel !== undefined) this.minLevel = options.minLevel
  }

  async write(batch: readonly LogEvent[], signal: AbortSignal): Promise<void> {
    if (batch.length === 0) return
    if (signal.aborted) throw new Error('aborted')
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(toOtlpPayload(batch, this.serviceName, this.environment)),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`OTLP logs endpoint returned ${response.status}`)
    } catch (error) {
      if (signal.aborted) throw new Error('aborted')
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}
