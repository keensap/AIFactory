import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatApi } from '../src/api/client.ts'
import { normalizeStageSettings, parseSettingField, reviewSettingsPatch } from '../src/data/gates.ts'

const cap = (maxFindings: number) => ({ processParams: { review: { maxFindings } } })

afterEach(() => vi.unstubAllGlobals())

describe('P5 review settings', () => {
  it('accepts only whole numbers from 1 to 12', () => {
    for (const valid of ['1', '12']) expect(parseSettingField('maxFindings', valid)).toEqual({ value: Number(valid) })
    for (const invalid of ['', '0', '13', '1.5', '1e1']) expect(parseSettingField('maxFindings', invalid)).toHaveProperty('error')
  })

  it('normalizes only supported review params and does not invent a cap', () => {
    expect(normalizeStageSettings({ processParams: { ...cap(8).processParams, prompt: { extraInstructions: 'other' } } })).toMatchObject(cap(8))
    for (const raw of [{}, cap(0), cap(13), cap(1.5), { processParams: { review: { maxFindings: '8' } } }]) {
      expect(normalizeStageSettings(raw)).not.toHaveProperty('processParams')
    }
  })

  it('patches only edited values so a gate-only save never pins the inherited cap', () => {
    const saved = normalizeStageSettings(cap(8))
    expect(reviewSettingsPatch(saved, { ...saved, maxMajor: 2 })).toEqual({ maxMajor: 2 })
    expect(reviewSettingsPatch(saved, { ...saved, ...cap(5) })).toEqual(cap(5))
    expect(reviewSettingsPatch(saved, { ...saved })).toEqual({})
    const inherited = normalizeStageSettings({})
    expect(reviewSettingsPatch(inherited, { ...inherited, ...cap(12) })).toEqual(cap(12))
  })

  it('loads, updates and resets nested settings in the requested scope', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ stageDefaults: cap(8) }))
      .mockResolvedValueOnce(Response.json({ settings: cap(6) }))
      .mockResolvedValueOnce(Response.json({ settings: cap(4) }))
      .mockResolvedValueOnce(Response.json({ settings: cap(4), source: 'factory' }))
      .mockResolvedValueOnce(Response.json({ settings: cap(2), source: 'project' }))
      .mockResolvedValueOnce(Response.json({ settings: cap(4), source: 'factory' }))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ChatApi({ baseUrl: 'http://api.test', token: '' })
    expect(await api.getFactoryStageSettings('planning')).toMatchObject(cap(8))
    expect(await api.getFactoryStageSettings('requirements')).toMatchObject(cap(6))
    expect(await api.updateFactoryStageSettings('requirements', cap(4))).toMatchObject(cap(4))
    expect(await api.getProjectStageSettings('p/1', 'requirements')).toMatchObject({ ...cap(4), source: 'factory' })
    expect(await api.updateProjectStageSettings('p/1', 'requirements', cap(2))).toMatchObject({ ...cap(2), source: 'project' })
    expect(await api.resetProjectStageSettings('p/1', 'requirements')).toMatchObject({ ...cap(4), source: 'factory' })
    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), init.method, init.body && JSON.parse(init.body)])).toEqual([
      ['http://api.test/api/settings/stage-defaults', 'GET', undefined],
      ['http://api.test/api/settings/stages/requirements', 'GET', undefined],
      ['http://api.test/api/settings/stages/requirements', 'PATCH', cap(4)],
      ['http://api.test/api/projects/p%2F1/stages/requirements/settings', 'GET', undefined],
      ['http://api.test/api/projects/p%2F1/stages/requirements/settings', 'PATCH', cap(2)],
      ['http://api.test/api/projects/p%2F1/stages/requirements/settings', 'DELETE', undefined],
    ])
  })
})
