import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, isAbortError, type ChatApi } from '../api/client.ts'
import type { ObservabilitySummary } from '../api/types.ts'
import { OBSERVABILITY_REFRESH_MS } from '../data/observability.ts'

/**
 * loading      first request in flight
 * ready        summary loaded (it may still say `available: false`)
 * disabled     Phoenix integration is off (503) or the API predates the route (404)
 * error        request failed (auth, network, 5xx); previous data is kept
 */
export type ObservabilityStatus = 'loading' | 'ready' | 'disabled' | 'error'

export interface ObservabilityState {
  status: ObservabilityStatus
  summary: ObservabilitySummary | null
  error: ApiError | null
  refreshing: boolean
  updatedAt: number | null
}

const INITIAL: ObservabilityState = { status: 'loading', summary: null, error: null, refreshing: false, updatedAt: null }

/**
 * Phoenix summary for ONE project. Restarts (abort + reset) when the project
 * or window changes. Refreshes every minute while the tab is visible; stops
 * when Phoenix is disabled or on auth errors. Never throws into the page:
 * the card degrades on its own and the logs stay usable.
 */
export function useObservability(
  api: ChatApi,
  projectId: string,
  hours: number,
  enabled: boolean,
): ObservabilityState & { refresh: () => void } {
  const [state, setState] = useState<ObservabilityState>(INITIAL)
  const [tick, setTick] = useState(0)
  const hasDataRef = useRef(false)

  useEffect(() => {
    hasDataRef.current = false
    setState(INITIAL)
  }, [projectId, hours])

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const load = async (): Promise<void> => {
      if (controller.signal.aborted) return
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void load(), OBSERVABILITY_REFRESH_MS)
        return
      }
      setState((s) => (hasDataRef.current ? { ...s, refreshing: true } : s))
      try {
        const summary = await api.getObservability(projectId, hours, controller.signal)
        if (controller.signal.aborted) return
        hasDataRef.current = true
        setState({ status: 'ready', summary, error: null, refreshing: false, updatedAt: Date.now() })
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return
        const apiError = error instanceof ApiError ? error : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : 'Could not load the trace summary.')
        if (apiError.status === 503 || apiError.status === 404) {
          stopped = true
          setState({ status: 'disabled', summary: null, error: apiError, refreshing: false, updatedAt: null })
        } else {
          if (apiError.status === 401 || apiError.status === 403) stopped = true
          setState((s) => ({ ...s, status: 'error', error: apiError, refreshing: false }))
        }
      }
      if (!stopped && !controller.signal.aborted) timer = setTimeout(() => void load(), OBSERVABILITY_REFRESH_MS)
    }

    void load()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [api, projectId, hours, enabled, tick])

  const refresh = useCallback(() => setTick((n) => n + 1), [])
  return { ...state, refresh }
}
