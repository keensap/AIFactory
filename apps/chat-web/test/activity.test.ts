import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, ChatApi, parseStageRunEvent } from '../src/api/client.ts'
import { followStageRunEvents, type ActivityConnection } from '../src/api/stageEvents.ts'
import type { StageRunEvent } from '../src/api/types.ts'
import {
  buildTimeline,
  compareEventIds,
  currentActivity,
  DEFAULT_FILTERS,
  filterTimeline,
  mergeEvents,
  redactSecrets,
  roleSummaries,
  toolCallInfo,
} from '../src/data/activity.ts'

let nextId = 1
function ev(type: string, role: string | null, payload: Record<string, unknown> = {}, id?: number): StageRunEvent {
  const n = id ?? nextId++
  return {
    id: String(n),
    projectId: 'p',
    stageRunId: 'r',
    role,
    agentId: role,
    type,
    phase: null,
    payload,
    createdAt: `2026-11-11T07:00:${String(n % 60).padStart(2, '0')}.000Z`,
  }
}

function frames(...chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const stage = (event: StageRunEvent) => `id: ${event.id}\nevent: stage\ndata: ${JSON.stringify(event)}\n\n`

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('event ordering', () => {
  it('orders ids numerically and merges without duplicates', () => {
    expect(compareEventIds('10', '9')).toBe(1)
    expect(['10', '2', '1', '11'].sort(compareEventIds)).toEqual(['1', '2', '10', '11'])
    const a = [ev('text', 'analyzer', {}, 1), ev('text', 'analyzer', {}, 2)]
    const replay = [ev('text', 'analyzer', {}, 2), ev('text', 'analyzer', {}, 10), ev('text', 'analyzer', {}, 9)]
    expect(mergeEvents(a, replay).events.map((event) => event.id)).toEqual(['1', '2', '9', '10'])
    const capped = mergeEvents(a, [ev('text', 'analyzer', {}, 3)], 2)
    expect(capped).toMatchObject({ trimmed: true })
    expect(capped.events.map((event) => event.id)).toEqual(['2', '3'])
  })

  it('validates stream payloads', () => {
    expect(parseStageRunEvent('{nope')).toBeNull()
    expect(parseStageRunEvent(JSON.stringify({ id: 'abc', type: 'text' }))).toBeNull()
    expect(parseStageRunEvent(JSON.stringify({ id: 7, type: 'text', payload: [] }))).toMatchObject({ id: '7', payload: {}, role: null })
  })
})

describe('timeline', () => {
  const run = (): StageRunEvent[] => [
    ev('role_start', 'analyzer', { role: 'analyzer', timeoutMs: 1 }),
    ev('session', 'analyzer', { sessionId: 's' }),
    ev('status', 'analyzer', { phase: 'turn_start', turn: 1 }),
    ev('status', 'analyzer', { phase: 'step_end', step: 2, usage: { inputTokens: 2000, outputTokens: 400 } }),
    ev('thinking', 'analyzer', { text: 'hmm' }),
    ev('tool_call', 'analyzer', { name: 'fs_read', arguments: '{"path":"a.md"}' }),
    ev('tool_result', 'analyzer', { status: 'ok', result: 'content' }),
    ev('role_end', 'analyzer', { role: 'analyzer', durationMs: 16000 }),
    ev('role_start', 'author', { role: 'author' }),
    ev('tool_call', 'author', { tool: 'bash', callId: 'c1', input: { command: 'ls' } }),
    ev('tool_result', 'author', { callId: 'c1', status: 'error', error: 'denied' }),
    ev('role_end', 'author', { durationMs: 4000 }),
    ev('role_start', 'reviewer', { role: 'reviewer' }),
    ev('role_end', 'reviewer', { durationMs: 2000 }),
    ev('review_decision', null, { decision: 'needs_revision', findings: [{}, {}] }),
    ev('role_start', 'author', { role: 'author' }),
    ev('role_error', 'author', { durationMs: 1000, message: 'timed out' }),
  ]

  it('groups by role chronologically with passes, durations and states', () => {
    const groups = buildTimeline(run(), false)
    expect(groups.map((group) => `${group.role}:${group.pass}:${group.state}`)).toEqual([
      'analyzer:1:done', 'author:1:done', 'reviewer:1:done', 'run:1:done', 'author:2:failed',
    ])
    expect(groups[0]!.durationMs).toBe(16000)
    expect(groups[0]!.hidden.map((event) => event.type)).toEqual(['role_start', 'session', 'role_end'])
    // Consecutive status events collapse; legacy name/arguments tool call pairs with its result.
    const kinds = groups[0]!.rows.map((row) => row.kind)
    expect(kinds).toEqual(['status', 'thinking', 'tool'])
    expect(groups[0]!.rows[0]).toMatchObject({ kind: 'status', count: 2, text: 'step 2 · 2.4k tokens' })
    expect(groups[0]!.rows[2]).toMatchObject({ kind: 'tool', tool: 'fs_read', result: { status: 'ok' } })
    expect(groups[1]!.rows[0]).toMatchObject({ kind: 'tool', command: 'ls', result: { isError: true, output: 'denied' } })
    expect(groups[1]!.errorCount).toBe(1)
    expect(groups[3]!.rows[0]).toMatchObject({ kind: 'review', decision: 'needs_revision', findingCount: 2 })
    expect(roleSummaries(groups).author).toMatchObject({ passes: 2, durationMs: 5000, failed: true })
  })

  it('marks an unfinished last role running only while the run is active', () => {
    const events = [ev('role_start', 'reviewer', { role: 'reviewer' }), ev('thinking', 'reviewer', { text: 'x' })]
    expect(buildTimeline(events, true)[0]!.state).toBe('running')
    expect(buildTimeline(events, false)[0]!.state).toBe('stopped')
  })

  it('filters by role, type, errors and search', () => {
    const groups = buildTimeline(run(), false)
    expect(filterTimeline(groups, { ...DEFAULT_FILTERS, role: 'reviewer' }).map((group) => group.role)).toEqual(['reviewer'])
    expect(filterTimeline(groups, { ...DEFAULT_FILTERS, type: 'thinking' }).flatMap((group) => group.rows.map((row) => row.kind))).toEqual(['thinking'])
    expect(filterTimeline(groups, { ...DEFAULT_FILTERS, errorsOnly: true }).flatMap((group) => group.rows.map((row) => row.kind))).toEqual(['tool', 'error'])
    expect(filterTimeline(groups, { ...DEFAULT_FILTERS, search: 'A.MD' })).toHaveLength(1)
  })

  it('describes the current activity from the latest meaningful event', () => {
    expect(currentActivity([])).toBe('Waiting for events…')
    expect(currentActivity([ev('tool_call', 'reviewer', { tool: 'bash' }), ev('status', 'reviewer', {})])).toBe('Reviewer is running bash')
    expect(currentActivity([ev('role_end', 'analyzer', { durationMs: 16400 })])).toBe('Analyzer completed in 16s')
    expect(currentActivity([ev('text', 'author', { text: 'x' })])).toBe('Author is writing the TELOS')
    expect(currentActivity([ev('review_decision', null, { decision: 'approved' })])).toBe('Reviewer approved')
    expect(currentActivity([ev('review_decision', null, { decision: 'needs_revision' })])).toBe('Reviewer requested changes')
    expect(currentActivity([ev('document_created', null, {})])).toBe('TELOS report saved')
    expect(currentActivity([ev('role_error', 'reviewer', {})])).toBe('Reviewer failed')
    expect(currentActivity([ev('human_decision', null, {})])).toBe('Decision recorded')
  })

  it('redacts obvious secrets and reads tool commands', () => {
    expect(redactSecrets('echo api_key=sk-test-1234567890abcdefgh && x')).toBe('echo api_key=[redacted] && x')
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop123')).toBe('Authorization: Bearer [redacted]')
    expect(redactSecrets('use ghp_abcdefghijklmnopqrstuvwxyz12 now')).toBe('use [redacted] now')
    expect(redactSecrets('password: hunter22')).toBe('password: [redacted]')
    expect(redactSecrets('tokens used: 12')).toBe('tokens used: 12')
    expect(toolCallInfo({ tool: 'bash', input: { command: 'rg -n x' } }).command).toBe('rg -n x')
    // Rendered as text: markup stays a string, never parsed.
    expect(buildTimeline([ev('text', 'author', { text: '<script>x</script>' })], false)[0]!.rows[0]).toMatchObject({ text: '<script>x</script>' })
  })
})

describe('event stream client', () => {
  it('streams with the bearer header, handles split frames, CRLF, comments, malformed data and end', async () => {
    const e1 = ev('text', 'analyzer', { text: 'a' }, 41)
    const e2 = ev('text', 'analyzer', { text: 'b\nc' }, 42)
    const whole = `${stage(e1)}: keepalive\n\nid: 43\r\nevent: stage\r\ndata: {broken\r\n\r\n${stage(e2)}event: end\ndata: {}\n\n`
    const fetchMock = vi.fn(async () => frames(whole.slice(0, 17), whole.slice(17, 90), whole.slice(90)))
    vi.stubGlobal('fetch', fetchMock)
    const api = new ChatApi({ baseUrl: 'http://api.test', token: 'secret-token' })
    const seen: string[] = []
    let malformed = 0
    const result = await api.streamStageRunEvents('run-1', {
      after: '40',
      signal: new AbortController().signal,
      onEvent: (event) => seen.push(event.id),
      onMalformed: () => { malformed += 1 },
    })
    expect(result).toBe('end')
    expect(seen).toEqual(['41', '42'])
    expect(malformed).toBe(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://api.test/api/stage-runs/run-1/events/stream?after=40')
    expect(url).not.toContain('secret-token')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token')
  })

  it('reports a dropped connection and event: error', async () => {
    const api = new ChatApi({ baseUrl: 'http://api.test', token: '' })
    vi.stubGlobal('fetch', vi.fn(async () => frames(stage(ev('text', 'author', {}, 5)))))
    await expect(api.streamStageRunEvents('r', { signal: new AbortController().signal, onEvent: () => {} })).resolves.toBe('closed')
    vi.stubGlobal('fetch', vi.fn(async () => frames('event: error\ndata: {"message":"event stream failed"}\n\n')))
    await expect(api.streamStageRunEvents('r', { signal: new AbortController().signal, onEvent: () => {} }))
      .rejects.toMatchObject({ code: 'STREAM_ERROR', message: 'event stream failed' })
  })
})

describe('followStageRunEvents', () => {
  function fakeApi(script: {
    pages?: StageRunEvent[][]
    streams: Array<(after: string, onEvent: (event: StageRunEvent) => void, onOpen: () => void) => Promise<'end' | 'closed'>>
  }) {
    const pages = [...(script.pages ?? [[]])]
    const afters: string[] = []
    let stream = 0
    const api = {
      listStageRunEvents: vi.fn(async () => ({ events: pages.shift() ?? [], nextAfter: '0' })),
      streamStageRunEvents: vi.fn(async (_runId: string, options: { after?: string; onEvent: (event: StageRunEvent) => void; onOpen?: () => void }) => {
        afters.push(options.after ?? '0')
        const step = script.streams[stream++]
        if (step === undefined) throw new Error('unexpected stream')
        return step(options.after ?? '0', options.onEvent, () => options.onOpen?.())
      }),
    }
    return { api: api as unknown as ChatApi, afters, raw: api }
  }

  it('loads the backlog, tails live, reconnects from the last id and stops on end', async () => {
    const states: ActivityConnection[] = []
    const delays: number[] = []
    const received: string[] = []
    const onEnd = vi.fn()
    const { api, afters } = fakeApi({
      pages: [[ev('role_start', 'analyzer', {}, 1), ev('text', 'analyzer', {}, 2)]],
      streams: [
        async (_after, onEvent, onOpen) => { onOpen(); onEvent(ev('text', 'analyzer', {}, 3)); return 'closed' },
        async () => { throw new ApiError(0, 'NETWORK', 'down') },
        async (_after, onEvent, onOpen) => { onOpen(); onEvent(ev('role_end', 'analyzer', {}, 4)); return 'end' },
      ],
    })
    await followStageRunEvents(api, {
      runId: 'r',
      signal: new AbortController().signal,
      live: true,
      onEvents: (events) => received.push(...events.map((event) => event.id)),
      onState: (state) => states.push(state),
      onEnd,
      sleep: async (ms) => { delays.push(ms) },
    })
    expect(received).toEqual(['1', '2', '3', '4'])
    expect(afters).toEqual(['2', '3', '3'])
    expect(delays).toEqual([1000, 2000])
    expect(states).toEqual(['connecting', 'live', 'reconnecting', 'reconnecting', 'live', 'ended'])
    expect(onEnd).toHaveBeenCalledOnce()
  })

  it('pages a long backlog and skips the stream for terminal runs', async () => {
    const page = Array.from({ length: 500 }, (_, index) => ev('status', 'author', {}, index + 1))
    const { api, raw } = fakeApi({ pages: [page, [ev('text', 'author', {}, 501)]], streams: [] })
    const states: ActivityConnection[] = []
    await followStageRunEvents(api, { runId: 'r', signal: new AbortController().signal, live: false, onEvents: () => {}, onState: (state) => states.push(state) })
    expect(raw.listStageRunEvents).toHaveBeenCalledTimes(2)
    expect(raw.streamStageRunEvents).not.toHaveBeenCalled()
    expect(states).toEqual(['connecting', 'ended'])
  })

  it('stops without retrying on 401/404 and after 5 failed reconnects', async () => {
    const unauthorized = fakeApi({ streams: [async () => { throw new ApiError(401, 'UNAUTHORIZED', 'no') }] })
    const states: Array<[ActivityConnection, string | undefined]> = []
    await followStageRunEvents(unauthorized.api, { runId: 'r', signal: new AbortController().signal, live: true, onEvents: () => {}, onState: (state, error) => states.push([state, error?.code]) })
    expect(states.at(-1)).toEqual(['error', 'UNAUTHORIZED'])
    expect(unauthorized.raw.streamStageRunEvents).toHaveBeenCalledOnce()

    const flaky = fakeApi({ streams: Array.from({ length: 6 }, () => async () => 'closed' as const) })
    const delays: number[] = []
    let last: string | undefined
    await followStageRunEvents(flaky.api, {
      runId: 'r', signal: new AbortController().signal, live: true, onEvents: () => {},
      onState: (state, error) => { if (state === 'error') last = error?.code },
      sleep: async (ms) => { delays.push(ms) },
    })
    expect(delays).toEqual([1000, 2000, 5000, 10000, 10000])
    expect(flaky.raw.streamStageRunEvents).toHaveBeenCalledTimes(6)
    expect(last).toBe('STREAM_RECONNECT_FAILED')
  })

  it('allows one reconnect after event: error', async () => {
    const { api, raw } = fakeApi({
      streams: [
        async () => { throw new ApiError(502, 'STREAM_ERROR', 'x') },
        async () => { throw new ApiError(502, 'STREAM_ERROR', 'x') },
      ],
    })
    let final: ActivityConnection | undefined
    await followStageRunEvents(api, { runId: 'r', signal: new AbortController().signal, live: true, onEvents: () => {}, onState: (state) => { final = state }, sleep: async () => {} })
    expect(raw.streamStageRunEvents).toHaveBeenCalledTimes(2)
    expect(final).toBe('error')
  })
})
