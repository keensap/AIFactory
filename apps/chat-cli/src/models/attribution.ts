/**
 * Which model produced a harness run's tokens, and what they cost.
 *
 * The harness reports usage without naming the model, so the stage runtime
 * records the attribution itself, once per role at the moment it starts, and
 * stamps it (with the cost computed from the price in force *then*) onto every
 * usage event it stores. Historical stats therefore never change when prices or
 * targets change later.
 *
 * Events written before attribution existed carry none of these fields and are
 * reported as "unattributed" rather than guessed.
 */

import type { ModelPrice } from './catalog/types.ts'
import { computeCost } from './cost.ts'
import { normalizeUsage } from './ports.ts'

export interface ModelAttribution {
  provider: string
  model: string
  /** Where the target came from: `settings` or `environment`. */
  source: string
  /** Price in force when the run started; null when the model has none. */
  price: ModelPrice | null
  /**
   * The model's context window when the run started, stamped onto usage events
   * so a run's context percentage stays computable even if the catalogue entry
   * changes later.
   */
  contextWindow: number | null
}

/** What `role_start` records. `null` means the harness profile default was used. */
export interface RoleModel {
  provider: string
  model: string
  source: string
}

/**
 * Attribution for a model on the same provider, from the catalogue snapshot taken
 * when the run was pinned.
 *
 * An agent may run a different model from the Factory target. Pricing and context
 * that role at the Factory model would be wrong, so the price and window are
 * looked up per model. A model the catalogue does not know keeps `price: null`
 * (cost is then reported as unknown, never guessed) and `contextWindow: null`.
 */
export function attributionForModel(
  base: ModelAttribution | null,
  models: ReadonlyArray<{ provider: string; model: string; price?: ModelPrice | null; contextWindow?: number | null }>,
  model: string | undefined,
): ModelAttribution | null {
  if (base === null) return null
  if (model === undefined || model === '' || model === base.model) return base
  const entry = models.find((candidate) => candidate.provider === base.provider && candidate.model === model)
  return {
    provider: base.provider,
    model,
    source: base.source,
    price: entry?.price ?? null,
    contextWindow: entry?.contextWindow !== undefined && entry.contextWindow !== null && entry.contextWindow > 0
      ? entry.contextWindow
      : null,
  }
}

export function roleModel(attribution: ModelAttribution | null | undefined): RoleModel | null {
  if (attribution === null || attribution === undefined) return null
  return { provider: attribution.provider, model: attribution.model, source: attribution.source }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Add `model`, `costUsd` and `contextWindow` to a harness `status` event that
 * carries usage.
 * Every other event, and every event when no attribution is known, is returned
 * unchanged. The input is never mutated.
 */
export function attributeUsage(event: unknown, attribution: ModelAttribution | null | undefined): unknown {
  if (attribution === null || attribution === undefined) return event
  if (!isRecord(event) || event.type !== 'status' || !isRecord(event.usage)) return event
  const cost = computeCost(normalizeUsage(event.usage as Record<string, number>), attribution.price ?? undefined)
  return {
    ...event,
    model: { provider: attribution.provider, model: attribution.model },
    ...(cost !== undefined ? { costUsd: cost } : {}),
    // No cost is reported as unknown, never as another model's price.
    ...(attribution.price === null ? { unpriced: true } : {}),
    ...(attribution.contextWindow !== null && attribution.contextWindow > 0
      ? { contextWindow: attribution.contextWindow }
      : {}),
  }
}
