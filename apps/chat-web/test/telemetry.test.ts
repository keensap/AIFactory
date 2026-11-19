import { describe, expect, it } from 'vitest'
import {
  NO_VALUE, contextLevel, contextTitle, formatCount, formatPercent, formatRate, formatTokens, meterWidth, modelName,
  normalizeTelemetry, phaseState, telemetryTitle,
} from '../src/data/telemetry.ts'

const full = {
  turns: 1, steps: 2, phase: 'step_end',
  usage: { input: 4000, output: 1500, total: 5500, cacheRead: 8000, cacheWrite: 0 },
  lastStep: { input: 2000, output: 1000, total: 3000, cacheRead: 8000, cacheWrite: 0, durationMs: 4000, tokensPerSecond: 250 },
  tokensPerSecond: 250, averageTokensPerSecond: 187.5, cacheHitPercent: 66.7,
  contextUsedTokens: 10000, contextWindow: 200000, contextUsedPercent: 5,
  model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  startedAt: '2026-11-16T09:00:00.000Z', updatedAt: '2026-11-16T09:00:04.000Z',
}

describe('telemetry', () => {
  it('keeps null as null and 0 as 0', () => {
    const t = normalizeTelemetry({ ...full, tokensPerSecond: null, cacheHitPercent: 0, contextUsedPercent: null, contextWindow: null })!
    expect(t.tokensPerSecond).toBeNull()
    expect(t.cacheHitPercent).toBe(0)
    expect(t.contextUsedPercent).toBeNull()
    expect(formatRate(t.tokensPerSecond)).toBe(NO_VALUE)
    expect(formatPercent(t.cacheHitPercent)).toBe('0%')
    expect(formatTokens(0)).toBe('0')
    expect(formatCount(0)).toBe('0')
    expect(formatCount(null)).toBe(NO_VALUE)
  })

  it('coerces junk to null and rejects non-objects', () => {
    expect(normalizeTelemetry(null)).toBeNull()
    expect(normalizeTelemetry([])).toBeNull()
    const t = normalizeTelemetry({ turns: 'x', steps: -1, usage: 5, model: { provider: 'a' }, tokensPerSecond: NaN })!
    expect(t.turns).toBeNull()
    expect(t.steps).toBeNull()
    expect(t.usage.total).toBeNull()
    expect(t.model).toBeNull()
    expect(t.tokensPerSecond).toBeNull()
  })

  it('formats compactly', () => {
    expect([950, 5500, 12_000, 1_200_000].map(formatTokens)).toEqual(['950', '5.5k', '12k', '1.2M'])
    expect([250, 2.5, 249.6].map(formatRate)).toEqual(['250', '2.5', '250'])
    expect([5, 66.7, 100, 4.25].map(formatPercent)).toEqual(['5%', '67%', '100%', '4.3%'])
  })

  it('maps context level and width from the API percent', () => {
    expect([null, 10, 60, 85, 85.1].map(contextLevel)).toEqual([null, 'ok', 'warn', 'warn', 'high'])
    expect([null, -5, 40, 300].map(meterWidth)).toEqual([0, 0, 40, 100])
  })

  it('builds tooltips and model names', () => {
    const t = normalizeTelemetry(full)!
    expect(contextTitle(t)).toBe('10,000 of 200,000 context tokens (5%)')
    expect(contextTitle(normalizeTelemetry({ ...full, contextWindow: null, contextUsedPercent: null }))).toBe('Context window unknown')
    expect(modelName(t, false)).toBe('anthropic/claude-sonnet-4-5')
    expect(modelName(t, true)).toBe('claude-sonnet-4-5')
    expect(modelName(normalizeTelemetry({ ...full, model: null }), false)).toBe('')
    expect(telemetryTitle(t)).toContain('average 188 tok/s')
    expect(telemetryTitle(null)).toBe('No run telemetry yet')
  })

  it('maps phase to a dot state', () => {
    expect([null, 'step_start', 'step_end', 'turn_end'].map(phaseState)).toEqual([null, 'working', 'idle', 'idle'])
  })
})
