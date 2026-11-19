import { describe, expect, it } from 'vitest'
import type { SdlcStage, StageState } from '../src/api/types.ts'
import { normalizeProjectUsage } from '../src/api/client.ts'
import { buildStageBar, isHistoricalStage, stageBarSummary } from '../src/data/stageBar.ts'
import { formatCost, formatTokenCount, modelLabel } from '../src/data/statusbar.ts'

const stages = ['planning', 'requirements', 'design', 'architecture'].map((key, position) => ({ key, name: key, position })) as unknown as SdlcStage[]
const states = (completed: string[]): StageState[] => stages.map((s) => ({ stage: s.key, status: completed.includes(s.key) ? 'completed' : 'not_started' })) as unknown as StageState[]

describe('stage bar', () => {
  it('marks done / current / todo and only enables done + current', () => {
    const items = buildStageBar(stages, states(['planning', 'requirements']), 'design', 'requirements')
    expect(items.map((i) => i.status)).toEqual(['done', 'done', 'current', 'todo'])
    expect(items.map((i) => i.enabled)).toEqual([true, true, true, false])
    expect(items.find((i) => i.selected)?.key).toBe('requirements')
    expect(isHistoricalStage(items, 'requirements')).toBe(true)
    expect(isHistoricalStage(items, 'design')).toBe(false)
    expect(isHistoricalStage(items, 'architecture')).toBe(false)
    expect(stageBarSummary(items, 'design')).toBe('Stage 3 of 4 · 2 completed')
  })

  it('treats every stage before the current one as history even without completed state', () => {
    const items = buildStageBar(stages, states([]), 'design', 'planning')
    expect(items.map((i) => i.status)).toEqual(['done', 'done', 'current', 'todo'])
  })
})

describe('status bar helpers', () => {
  it('formats tokens, cost, speed and model', () => {
    expect(formatTokenCount(842)).toBe('842')
    expect(formatTokenCount(184_200)).toBe('184k')
    expect(formatTokenCount(12_345)).toBe('12.3k')
    expect(formatTokenCount(3_100_000)).toBe('3.1M')
    expect(formatCost(0.4213)).toBe('$0.42')
    expect(formatCost(0.001)).toBe('<$0.01')
    expect(formatCost(1, true)).toBe('≥ $1.00')
    expect(formatCost(null)).toBe('')
    expect(modelLabel({ provider: 'a', model: 'm' }, [{ provider: 'a', model: 'm', displayName: 'Model M', contextWindow: 1000 }])).toBe('Model M')
    expect(modelLabel({ provider: 'a', model: 'm' }, [])).toBe('m')
    expect(modelLabel(null, [])).toBe('')
  })

  it('normalizes stats usage', () => {
    expect(normalizeProjectUsage({ tokens: { input: 10, output: 5, total: 15 }, cost: { usd: 0.5, unpricedTokens: 3 } }))
      .toMatchObject({ tokens: { total: 15 }, costUsd: 0.5, costPartial: true })
    expect(normalizeProjectUsage(null)).toMatchObject({ tokens: { total: 0 }, costUsd: null, costPartial: false })
  })
})
