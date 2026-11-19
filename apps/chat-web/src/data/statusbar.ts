/**
 * Pure helpers for the bottom status bar.
 *
 * Model, tokens consumed and cost come from the API (settings/models, models,
 * projects/:id/stats). Run figures (speed, context %) live in `telemetry.ts`
 * and come straight from the API snapshot; nothing is derived client-side.
 */

import type { ModelCatalogEntry, ModelTarget } from '../api/types.ts'

/** "184.2k", "3.1M", "842". */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '—'
  if (count < 1000) return String(Math.round(count))
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 100_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** "$0.42", "<$0.01"; '' when null. A partial figure is prefixed with "≥". */
export function formatCost(usd: number | null, partial = false): string {
  if (usd === null) return ''
  const text = usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
  return partial ? `≥ ${text}` : text
}

export function modelLabel(target: ModelTarget | null, catalog: readonly ModelCatalogEntry[]): string {
  if (target === null) return ''
  return catalogEntry(target, catalog)?.displayName ?? target.model
}

export function catalogEntry(target: ModelTarget | null, catalog: readonly ModelCatalogEntry[]): ModelCatalogEntry | undefined {
  return target === null ? undefined : catalog.find((entry) => entry.provider === target.provider && entry.model === target.model)
}
