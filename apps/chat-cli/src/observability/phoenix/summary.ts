/**
 * Phoenix span DTOs and summary aggregation.
 *
 * Produces the provider-neutral `ObservabilitySummary` consumed by the API.
 */

import type { ObservabilitySummary } from '../ports.ts'

export interface PhoenixSpan {
  id?: string
  name: string
  context: { trace_id: string; span_id: string }
  span_kind: string
  parent_id?: string | null
  start_time: string
  end_time: string
  status_code: string
  status_message?: string
  attributes?: Record<string, unknown>
  events?: Array<{ name: string; timestamp: string; attributes?: Record<string, unknown> }>
}

export interface PhoenixRoleSummary {
  role: string
  spans: number
  errors: number
  durationMs: number
  tokens: number
}

export type PhoenixObservabilitySummary = ObservabilitySummary

export function summarizeSpans(
  projectName: string,
  windowHours: number,
  spans: PhoenixSpan[],
): PhoenixObservabilitySummary {
  const traces = new Set<string>()
  const roles = new Map<string, PhoenixRoleSummary>()
  let errors = 0
  let tools = 0
  let tokens = 0
  let last: string | null = null
  const durations: number[] = []
  for (const span of spans) {
    if (span.context?.trace_id) traces.add(span.context.trace_id)
    if (span.status_code === 'ERROR') errors += 1
    if (span.name === 'tool.call' || span.span_kind === 'TOOL') tools += 1
    const start = Date.parse(span.start_time)
    const end = Date.parse(span.end_time)
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      durations.push(end - start)
      if (last === null || end > Date.parse(last)) last = span.end_time
    }
    const attrs = span.attributes ?? {}
    const role = typeof attrs.role === 'string' ? attrs.role : undefined
    if (role !== undefined) {
      const entry = roles.get(role) ?? { role, spans: 0, errors: 0, durationMs: 0, tokens: 0 }
      entry.spans += 1
      if (span.status_code === 'ERROR') entry.errors += 1
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) entry.durationMs += end - start
      const tokenValue = Number(attrs['llm.token_count.total'] ?? 0)
      if (Number.isFinite(tokenValue)) {
        entry.tokens += tokenValue
        tokens += tokenValue
      }
      roles.set(role, entry)
    }
  }
  durations.sort((a, b) => a - b)
  return {
    available: true,
    projectName,
    windowHours,
    traces: traces.size,
    spans: spans.length,
    errors,
    tools,
    tokens,
    latencyMs: {
      count: durations.length,
      avg: durations.length === 0 ? 0 : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations.at(-1) ?? 0,
    },
    roles: [...roles.values()].sort((a, b) => b.spans - a.spans),
    lastSpanAt: last,
    truncated: spans.length >= 10_000,
  }
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0
}
