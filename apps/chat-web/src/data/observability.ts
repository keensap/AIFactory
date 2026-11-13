/**
 * Pure helpers for the Phoenix observability card (log viewer).
 * The summary is a project-scoped aggregate; nothing here touches content.
 */

import type { ObservabilitySummary } from '../api/types.ts'

export const WINDOW_OPTIONS: { hours: number; label: string }[] = [
  { hours: 1, label: 'Last hour' },
  { hours: 6, label: 'Last 6 hours' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 72, label: 'Last 3 days' },
  { hours: 168, label: 'Last 7 days' },
]
export const DEFAULT_WINDOW_HOURS = 24
/** The summary queries Phoenix, so refresh slowly. */
export const OBSERVABILITY_REFRESH_MS = 60_000

export function normalizeWindow(hours: unknown): number {
  return WINDOW_OPTIONS.some((option) => option.hours === hours) ? hours as number : DEFAULT_WINDOW_HOURS
}

/** "87 ms", "1.2 s", "2m 05s". */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** "842", "12.4k", "3.1M". */
export function formatCount(count: number): string {
  if (!Number.isFinite(count)) return '—'
  if (count < 1000) return String(Math.round(count))
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** Error share of spans as "3.2%"; '' when there are no spans. */
export function errorRate(summary: Pick<ObservabilitySummary, 'spans' | 'errors'>): string {
  if (summary.spans <= 0) return ''
  const rate = (summary.errors / summary.spans) * 100
  return `${rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)}%`
}

/** The summary has data to show (Phoenix is up and saw spans in the window). */
export function hasTraces(summary: Pick<ObservabilitySummary, 'available' | 'spans'>): boolean {
  return summary.available && summary.spans > 0
}

/** Roles with a known filter in the log viewer, in pipeline order. */
const ROLE_ORDER = ['analyzer', 'author', 'reviewer']
export function sortRoles<T extends { role: string }>(roles: readonly T[]): T[] {
  const rank = (role: string): number => {
    const index = ROLE_ORDER.indexOf(role)
    return index === -1 ? ROLE_ORDER.length : index
  }
  return [...roles].sort((a, b) => rank(a.role) - rank(b.role) || a.role.localeCompare(b.role))
}

/** Share of the busiest role's duration, 0–100, for the bar widths. */
export function durationShare(durationMs: number, roles: readonly { durationMs: number }[]): number {
  const max = roles.reduce((m, role) => Math.max(m, role.durationMs), 0)
  return max <= 0 ? 0 : Math.max(2, Math.round((durationMs / max) * 100))
}
