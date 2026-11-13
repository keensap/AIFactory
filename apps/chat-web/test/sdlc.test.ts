import { describe, expect, it } from 'vitest'
import { loadStage, saveStage, SDLC_KEY, SDLC_STAGES, stageState } from '../src/data/sdlc.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

describe('sdlc stages', () => {
  it('classifies stages around the current one', () => {
    expect([0, 1, 2, 3].map((index) => stageState(index, 2))).toEqual(['completed', 'completed', 'current', 'upcoming'])
  })

  it('defaults to the first stage and persists per project', () => {
    const storage = createMemoryStorage()
    expect(loadStage(storage, 'p1')).toBe(0)
    saveStage(storage, 'p1', 3)
    saveStage(storage, 'p2', 1)
    expect(loadStage(storage, 'p1')).toBe(3)
    expect(loadStage(storage, 'p2')).toBe(1)
    expect(JSON.parse(storage.getItem(SDLC_KEY)!)).toEqual({ p1: SDLC_STAGES[3]!.id, p2: SDLC_STAGES[1]!.id })
  })

  it('ignores unknown or malformed stored stages', () => {
    expect(loadStage(createMemoryStorage({ [SDLC_KEY]: '{"p1":"bogus"}' }), 'p1')).toBe(0)
    expect(loadStage(createMemoryStorage({ [SDLC_KEY]: '[1,2]' }), 'p1')).toBe(0)
    const storage = createMemoryStorage()
    saveStage(storage, 'p1', 99)
    expect(storage.getItem(SDLC_KEY)).toBeNull()
  })
})
