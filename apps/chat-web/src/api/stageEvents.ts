/**
 * Follow one stage run's event log: load the persisted backlog over JSON, then
 * tail the SSE stream from the last id, reconnecting with backoff.
 *
 * One call = one reader. Callers abort `signal` to stop (route change/unmount)
 * and must not start a second call for the same run until the first settles.
 */

import { ApiError, isAbortError, type ChatApi } from './client.ts'
import type { StageRunEvent } from './types.ts'

export type ActivityConnection = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'error'

function idValue(id: string): bigint {
  try {
    return BigInt(id)
  } catch {
    return 0n
  }
}

/** Numeric id order (`"10"` after `"9"`), never string order. */
export function compareEventIds(a: string, b: string): number {
  const x = idValue(a)
  const y = idValue(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** The larger of two ids (cursor for `?after=`). */
export function maxEventId(a: string, b: string): string {
  return compareEventIds(a, b) >= 0 ? a : b
}

/** Backoff between reconnects (spec: 1s, 2s, 5s, 10s; max 5 attempts). */
export const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 10_000]
export const BACKLOG_PAGE = 500

export interface FollowOptions {
  runId: string
  signal: AbortSignal
  /** Resume after this id (reconnect button keeps what's already loaded). */
  after?: string
  /**
   * Open the live stream after the backlog. False for runs that were already
   * terminal: the stream would only replay and end, so skip the request.
   */
  live: boolean
  onEvents: (events: StageRunEvent[]) => void
  onState: (state: ActivityConnection, error?: ApiError) => void
  /** `event: end` received: the run is terminal and no events remain. */
  onEnd?: () => void
  onMalformed?: () => void
  /** Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Errors that retrying can't fix: stop and show them. */
function isFatal(error: ApiError): boolean {
  return error.status === 401 || error.status === 403 || error.status === 404 || error.status === 503 || error.status === 400
}

/**
 * Resolves when following stops: `event: end`, backlog-only load done, a fatal
 * error, or too many failed reconnects. Rejects only with AbortError.
 */
export async function followStageRunEvents(api: ChatApi, options: FollowOptions): Promise<void> {
  const sleep = options.sleep ?? defaultSleep
  const { signal, runId } = options
  let after = options.after ?? '0'
  let attempts = 0
  let streamErrors = 0
  let backlogDone = false

  const deliver = (events: StageRunEvent[]): void => {
    if (events.length === 0) return
    for (const event of events) after = maxEventId(after, event.id)
    options.onEvents(events)
  }

  options.onState('connecting')
  while (true) {
    try {
      if (!backlogDone) {
        // Page through the persisted log; the stream then replays only what's newer.
        while (true) {
          const page = await api.listStageRunEvents(runId, { after, limit: BACKLOG_PAGE }, signal)
          deliver(page.events)
          if (page.events.length < BACKLOG_PAGE) break
        }
        backlogDone = true
        if (!options.live) {
          options.onState('ended')
          return
        }
      }

      const result = await api.streamStageRunEvents(runId, {
        after,
        signal,
        onOpen: () => {
          attempts = 0
          options.onState('live')
        },
        onEvent: (event) => deliver([event]),
        ...(options.onMalformed === undefined ? {} : { onMalformed: options.onMalformed }),
      })
      if (result === 'end') {
        options.onState('ended')
        options.onEnd?.()
        return
      }
      // 'closed': dropped before `end` → reconnect below.
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error
      const apiError = error instanceof ApiError ? error : new ApiError(0, 'NETWORK', String(error))
      if (isFatal(apiError)) {
        options.onState('error', apiError)
        return
      }
      if (apiError.code === 'STREAM_ERROR') {
        // The server reported a stream failure: allow one reconnect only.
        streamErrors += 1
        if (streamErrors > 1) {
          options.onState('error', apiError)
          return
        }
      }
    }

    if (attempts >= RECONNECT_DELAYS_MS.length) {
      options.onState('error', new ApiError(0, 'STREAM_RECONNECT_FAILED', 'Lost the live detail stream after 5 attempts.'))
      return
    }
    options.onState('reconnecting')
    await sleep(RECONNECT_DELAYS_MS[attempts]!, signal)
    attempts += 1
  }
}
