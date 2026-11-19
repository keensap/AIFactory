import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbortError, type ApiError, type ChatApi } from '../api/client.ts'
import { followStageRunEvents, type ActivityConnection } from '../api/stageEvents.ts'
import type { RunTelemetry, StageRunEvent } from '../api/types.ts'
import { announcement, mergeEvents } from '../data/activity.ts'

export interface RunEventsState {
  events: StageRunEvent[]
  connection: ActivityConnection
  error: ApiError | null
  /** Oldest events were dropped to stay under the in-memory cap. */
  trimmed: boolean
  malformed: number
  /** Latest screen-reader announcement (role completion, errors, reviews). */
  announcement: string
  /** Latest API snapshot for the run (null until the first one arrives). */
  telemetry: RunTelemetry | null
}

const INITIAL: RunEventsState = { events: [], connection: 'connecting', error: null, trimmed: false, malformed: 0, announcement: '', telemetry: null }

/** Flush buffered events at most this often (avoid a render per event). */
const BATCH_MS = 100

/**
 * Follow the event log of one run. Exactly one reader per run id: the effect
 * aborts the previous reader before starting a new one, and on unmount.
 *
 * `live` is read once per (re)start: true while the run can still produce
 * events (pending…revising, awaiting_human), false for terminal runs (load
 * the persisted log only). `onEnd` fires on `event: end` so the caller can
 * refresh the run instead of trusting the last event.
 */
export function useRunEvents(
  api: ChatApi,
  runId: string | null,
  live: boolean | null,
  onEnd: () => void,
): RunEventsState & { reconnect: () => void } {
  const [state, setState] = useState<RunEventsState>(INITIAL)
  const [restart, setRestart] = useState(0)
  const onEndRef = useRef(onEnd)
  onEndRef.current = onEnd
  const liveRef = useRef(live)
  liveRef.current = live
  const lastIdRef = useRef<string>('0')
  const ready = runId !== null && live !== null

  // New run → fresh log.
  useEffect(() => {
    lastIdRef.current = '0'
    setState(INITIAL)
  }, [runId])

  useEffect(() => {
    if (!ready || runId === null) return
    const controller = new AbortController()
    let buffer: StageRunEvent[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    let malformed = 0

    const flush = (): void => {
      timer = null
      if (buffer.length === 0 && malformed === 0) return
      const batch = buffer
      const bad = malformed
      buffer = []
      malformed = 0
      let spoken: string | null = null
      for (const event of batch) spoken = announcement(event) ?? spoken
      setState((current) => {
        const merged = mergeEvents(current.events, batch)
        return {
          ...current,
          events: merged.events,
          trimmed: current.trimmed || merged.trimmed,
          malformed: current.malformed + bad,
          announcement: spoken ?? current.announcement,
        }
      })
    }
    const schedule = (): void => {
      if (timer === null) timer = setTimeout(flush, BATCH_MS)
    }

    // Historical figures first, so a finished run shows its bar before (or
    // without) a stream. A stream snapshot that already arrived wins.
    let streamed = false
    api.getStageRunTelemetry(runId, controller.signal).then((telemetry) => {
      if (telemetry !== null && !streamed && !controller.signal.aborted) setState((current) => ({ ...current, telemetry }))
    }).catch(() => {
      // the stream (or nothing) fills the bar; a failed fetch never blanks it
    })

    followStageRunEvents(api, {
      runId,
      signal: controller.signal,
      after: lastIdRef.current,
      live: liveRef.current === true,
      onEvents: (events) => {
        for (const event of events) {
          lastIdRef.current = event.id
          buffer.push(event)
        }
        schedule()
      },
      onTelemetry: (telemetry) => {
        streamed = true
        setState((current) => ({ ...current, telemetry }))
      },
      onMalformed: () => {
        malformed += 1
        schedule()
      },
      onState: (connection, error) => {
        if (connection === 'ended' || connection === 'error') flush()
        setState((current) => ({
          ...current,
          connection,
          error: error ?? null,
          announcement:
            connection === 'reconnecting' ? 'Activity stream reconnecting'
              : connection === 'error' ? 'Activity stream stopped'
                : connection === 'live' && current.connection === 'reconnecting' ? 'Activity stream reconnected'
                  : current.announcement,
        }))
      },
      onEnd: () => onEndRef.current(),
    }).catch((error: unknown) => {
      if (!isAbortError(error)) setState((current) => ({ ...current, connection: 'error' }))
    })

    return () => {
      controller.abort()
      if (timer !== null) clearTimeout(timer)
    }
  }, [api, runId, ready, restart])

  const reconnect = useCallback(() => setRestart((value) => value + 1), [])
  return { ...state, reconnect }
}
