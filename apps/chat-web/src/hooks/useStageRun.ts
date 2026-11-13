import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, isAbortError, type ChatApi } from '../api/client.ts'
import type { StageRunDetail } from '../api/types.ts'
import { isPollable, pollDelay, stepForStatus, type PipelineStepKey } from '../data/stages.ts'

export interface StageRunState {
  run: StageRunDetail | null
  loading: boolean
  /** Last load/poll failure. Polling keeps going for network and 5xx errors. */
  error: unknown
  polling: boolean
  /** Polling stopped after 30 minutes. */
  timedOut: boolean
  /** Last pipeline step this browser saw active (for a failed run). */
  lastSeenStep: PipelineStepKey | null
}

export interface StageRunController extends StageRunState {
  /** Restart polling (after execute, or after a timeout). */
  resume: () => void
  /** Use a run returned by a mutation (decision, execute). */
  replace: (run: StageRunDetail) => void
}

/** Errors that polling can't recover from: stop instead of looping. */
function isFatal(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 404].includes(error.status)
}

/**
 * Load a stage run and poll it while it is queued or executing.
 *
 * - one request at a time (the next poll is scheduled after the last settles);
 * - 1.5 s, then 3 s after 30 s, capped at 30 minutes;
 * - paused while the tab is hidden;
 * - cancelled on unmount or when `runId` changes.
 *
 * `onSettled` fires when a polled run reaches a non-pollable status.
 */
export function useStageRun(
  api: ChatApi,
  runId: string | null,
  onSettled?: (run: StageRunDetail) => void,
): StageRunController {
  const [state, setState] = useState<StageRunState>({
    run: null,
    loading: runId !== null,
    error: null,
    polling: false,
    timedOut: false,
    lastSeenStep: null,
  })
  const [generation, setGeneration] = useState(0)
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled
  const runIdRef = useRef(runId)

  // Reset when switching runs.
  if (runIdRef.current !== runId) {
    runIdRef.current = runId
    setState({ run: null, loading: runId !== null, error: null, polling: false, timedOut: false, lastSeenStep: null })
  }

  useEffect(() => {
    if (runId === null) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    let waitingForVisibility = false
    let sawPollable = false
    const startedAt = Date.now()

    const schedule = (): void => {
      const delay = pollDelay(Date.now() - startedAt)
      if (delay === null) {
        setState((current) => ({ ...current, polling: false, timedOut: true }))
        return
      }
      timer = setTimeout(() => void tick(), delay)
    }

    const onVisible = (): void => {
      if (document.visibilityState !== 'visible' || !waitingForVisibility) return
      waitingForVisibility = false
      void tick()
    }

    const tick = async (): Promise<void> => {
      if (cancelled) return
      if (document.visibilityState === 'hidden') {
        waitingForVisibility = true
        return
      }
      controller = new AbortController()
      try {
        const run = await api.getStageRun(runId, controller.signal)
        if (cancelled) return
        const pollable = isPollable(run.status)
        const step = stepForStatus(run.status)
        setState((current) => ({
          run,
          loading: false,
          error: null,
          polling: pollable,
          timedOut: false,
          lastSeenStep: step ?? current.lastSeenStep,
        }))
        if (pollable) {
          sawPollable = true
          schedule()
        } else if (sawPollable) {
          onSettledRef.current?.(run)
        }
      } catch (error) {
        if (cancelled || isAbortError(error)) return
        const fatal = isFatal(error)
        setState((current) => ({ ...current, loading: false, error, polling: !fatal }))
        if (!fatal) schedule()
      }
    }

    document.addEventListener('visibilitychange', onVisible)
    setState((current) => ({ ...current, polling: true, timedOut: false }))
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [api, runId, generation])

  const resume = useCallback(() => setGeneration((value) => value + 1), [])
  const replace = useCallback((run: StageRunDetail) => {
    setState((current) => (current.run !== null && current.run.id !== run.id
      ? current
      : { ...current, run, loading: false, error: null }))
  }, [])

  return { ...state, resume, replace }
}
