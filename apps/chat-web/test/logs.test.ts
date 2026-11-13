import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatApi, normalizeObservability, normalizeProjectLog } from '../src/api/client.ts'
import type { ProjectLog } from '../src/api/types.ts'
import {
  DEFAULT_LOG_FILTERS, activeFilterCount, filtersFromSearch, filtersToQuery, filtersToSearch,
  mergeLogs, newestId, runLogsHref, payloadText, toCsv, toJsonl,
} from '../src/data/logs.ts'
import {
  durationShare, errorRate, formatCount, formatLatency, hasTraces, normalizeWindow, sortRoles,
} from '../src/data/observability.ts'
import { parseRoute, routeHref } from '../src/lib/router.ts'

function log(id: number, extra: Partial<ProjectLog> = {}): ProjectLog {
  return {
    id: String(id), projectId: 'p1', stageRunId: 'r1', stage: 'planning', attempt: 1, role: 'author', agentId: 'author',
    type: 'text', phase: null, level: 'info', message: `m${id}`, preview: null, payload: {}, createdAt: '2026-11-11T10:00:00.000Z',
    ...extra,
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('filters <-> url', () => {
  it('round-trips and ignores bad values', () => {
    const filters = { level: 'error' as const, role: 'reviewer', stage: 'planning', runId: 'r-1', type: 'role_error', search: 'time out' }
    expect(filtersFromSearch(filtersToSearch(filters))).toEqual(filters)
    expect(filtersFromSearch('level=bogus&q=')).toEqual(DEFAULT_LOG_FILTERS)
    expect(filtersToSearch(DEFAULT_LOG_FILTERS)).toBe('')
  })

  it('builds the API query and counts active filters', () => {
    expect(filtersToQuery({ ...DEFAULT_LOG_FILTERS, level: 'warn', search: ' x ', runId: 'r' }, { limit: 100 }))
      .toEqual({ limit: 100, level: 'warn', q: 'x', runId: 'r' })
    expect(activeFilterCount(DEFAULT_LOG_FILTERS)).toBe(0)
    expect(activeFilterCount({ ...DEFAULT_LOG_FILTERS, level: 'error', role: 'author' })).toBe(2)
  })
})

describe('mergeLogs', () => {
  it('dedupes, orders newest first and trims to the cap', () => {
    const first = mergeLogs([log(3), log(2)], [log(5), log(3)])
    expect(first.logs.map((l) => l.id)).toEqual(['5', '3', '2'])
    const trimmed = mergeLogs([log(10), log(9), log(8)], [log(11)], 3)
    expect(trimmed.logs.map((l) => l.id)).toEqual(['11', '10', '9'])
    expect(trimmed.trimmed).toBe(true)
    expect(newestId(trimmed.logs)).toBe('11')
    expect(mergeLogs([log(2)], [log(100)]).logs[0]!.id).toBe('100') // numeric, not lexical
  })
})

describe('export and redaction', () => {
  it('redacts secrets and neutralizes CSV formulas', () => {
    const entry = log(1, { message: '=HYPERLINK("x")', preview: 'api_key=abcd1234secret', payload: { token: 'token=supersecretvalue' } })
    expect(payloadText(entry.payload)).not.toContain('supersecretvalue')
    expect(payloadText(entry.payload, false)).toContain('supersecretvalue')
    const csv = toCsv([entry])
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
    expect(csv).not.toContain('abcd1234secret')
    expect(toJsonl([log(2), log(1)]).trim().split('\n').map((line) => JSON.parse(line).id)).toEqual(['1', '2'])
  })
})

describe('logs route', () => {
  it('parses and builds the logs route with filters', () => {
    expect(parseRoute('#/projects/abc/logs')).toEqual({ name: 'logs', projectId: 'abc', search: '' })
    expect(parseRoute('#/projects/abc/logs?level=error&q=a%20b')).toEqual({ name: 'logs', projectId: 'abc', search: 'level=error&q=a%20b' })
    const route = { name: 'logs' as const, projectId: 'a b', search: 'level=warn' }
    expect(parseRoute(routeHref(route))).toEqual(route)
  })
})

describe('ChatApi.listProjectLogs', () => {
  it('sends filters, scopes to the project and drops foreign or malformed entries', async () => {
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      void input
      return new Response(JSON.stringify({
        logs: [log(2), log(1, { projectId: 'other' }), { id: 'x' }, { ...log(3), level: 'weird' }],
        nextBefore: '2',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', mock)
    const api = new ChatApi({ baseUrl: 'http://api.test', token: 't' })
    const page = await api.listProjectLogs('p1', { limit: 50, level: 'error', q: 'time out', before: '' })
    expect(String(mock.mock.calls[0]![0])).toBe('http://api.test/api/projects/p1/logs?limit=50&level=error&q=time+out')
    expect(page.logs.map((l) => l.id)).toEqual(['2', '3'])
    expect(page.logs[1]!.level).toBe('info')
    expect(page.nextBefore).toBe('2')
  })

  it('normalizes entries', () => {
    expect(normalizeProjectLog(null)).toBeNull()
    expect(normalizeProjectLog({ id: 7, type: 'text', message: 'hi' })?.id).toBe('7')
  })
})

describe('observability', () => {
  it('normalizes a full, partial and garbage summary', () => {
    const full = normalizeObservability({
      available: true, projectName: 'aifactory-p', windowHours: 24, traces: 1, spans: 4, errors: 1, tools: 2, tokens: 900,
      latencyMs: { count: 4, avg: 83, p50: 87, p95: 124, max: 124 },
      roles: [{ role: 'reviewer', spans: 1, errors: 0, durationMs: 119, tokens: 0 }, { role: 5 }, null],
      lastSpanAt: '2026-11-11T14:30:00.000Z', truncated: true,
    }, 24)
    expect(full.roles).toHaveLength(1)
    expect(full.latencyMs?.p95).toBe(124)
    expect(full.truncated).toBe(true)
    const down = normalizeObservability({ available: false, reason: 'Phoenix unreachable' }, 6)
    expect(down).toMatchObject({ available: false, reason: 'Phoenix unreachable', windowHours: 6, spans: 0, latencyMs: null, roles: [] })
    expect(normalizeObservability('nope', 24).available).toBe(false)
    expect(normalizeObservability({ spans: -4, errors: 'x' }, 24)).toMatchObject({ spans: 0, errors: 0 })
  })

  it('formats numbers and derives rates', () => {
    expect(formatLatency(87)).toBe('87 ms')
    expect(formatLatency(1234)).toBe('1.2 s')
    expect(formatLatency(125_000)).toBe('2m 05s')
    expect(formatLatency(-1)).toBe('—')
    expect(formatCount(842)).toBe('842')
    expect(formatCount(12_400)).toBe('12k')
    expect(formatCount(3_100_000)).toBe('3.1M')
    expect(errorRate({ spans: 0, errors: 0 })).toBe('')
    expect(errorRate({ spans: 40, errors: 1 })).toBe('2.5%')
    expect(hasTraces({ available: true, spans: 0 })).toBe(false)
    expect(normalizeWindow(72)).toBe(72)
    expect(normalizeWindow(5)).toBe(24)
  })

  it('orders roles and scales bars', () => {
    expect(sortRoles([{ role: 'reviewer' }, { role: 'zeta' }, { role: 'analyzer' }]).map((r) => r.role)).toEqual(['analyzer', 'reviewer', 'zeta'])
    const roles = [{ durationMs: 200 }, { durationMs: 50 }, { durationMs: 0 }]
    expect(durationShare(200, roles)).toBe(100)
    expect(durationShare(50, roles)).toBe(25)
    expect(durationShare(0, roles)).toBe(2)
    expect(durationShare(5, [])).toBe(0)
  })
})

describe('runLogsHref', () => {
  it('links to the run with matching activity filters', () => {
    expect(runLogsHref('p1', 'r1')).toBe('#/projects/p1/logs?run=r1')
    expect(runLogsHref('p1', 'r1', { role: 'reviewer', errorsOnly: true })).toBe('#/projects/p1/logs?level=error&role=reviewer&run=r1')
    expect(runLogsHref('p1', 'r1', { role: 'run', errorsOnly: false })).toBe('#/projects/p1/logs?run=r1')
    expect(parseRoute(runLogsHref('a b', 'r/1'))).toMatchObject({ name: 'logs', projectId: 'a b' })
  })
})
