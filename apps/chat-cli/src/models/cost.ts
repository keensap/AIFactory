/**
 * Cost computation from the catalogue price table.
 *
 * Prices are USD per one million tokens. Cost is computed when a call is made
 * and stored with the result, so later price changes never rewrite history.
 * A model without a price has no cost (`undefined`), which is different from a
 * free model (price 0).
 */

import type { ModelPrice } from './catalog/types.ts'
import type { Usage } from './ports.ts'

export function computeCost(usage: Usage, price: ModelPrice | undefined): number | undefined {
  if (price === undefined) return undefined
  const known = [price.input, price.output, price.cacheRead, price.cacheWrite].some((value) => typeof value === 'number')
  if (!known) return undefined
  const dollars = (usage.inputTokens * (price.input ?? 0)
    + usage.outputTokens * (price.output ?? 0)
    + usage.cacheReadTokens * (price.cacheRead ?? 0)
    + usage.cacheWriteTokens * (price.cacheWrite ?? 0)) / 1_000_000
  return Math.round(dollars * 1e9) / 1e9
}
