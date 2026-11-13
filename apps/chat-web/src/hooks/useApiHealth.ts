import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, errorMessage, type ChatApi } from '../api/client.ts'
import type { HealthResponse } from '../api/types.ts'

export type ApiHealthStatus = 'checking' | 'online' | 'offline' | 'unauthorized'

export interface ApiHealthState {
  status: ApiHealthStatus
  health?: HealthResponse
  error?: string
  checkedAt?: number
}

export interface ApiHealthController {
  state: ApiHealthState
  refresh: () => Promise<void>
}

const POLL_MS = 30_000

/** Poll `/api/health`, pausing while the tab is hidden. */
export function useApiHealth(api: ChatApi): ApiHealthController {
  const [state, setState] = useState<ApiHealthState>({ status: 'checking' })
  const requestRef = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    try {
      const health = await api.health()
      if (request !== requestRef.current) return
      setState({
        status: health.ok ? 'online' : 'offline',
        health,
        checkedAt: Date.now(),
        ...(health.ok ? {} : { error: 'The API reported that it is not ready.' }),
      })
    } catch (error) {
      if (request !== requestRef.current) return
      if (error instanceof ApiError && error.status === 401) {
        setState({
          status: 'unauthorized',
          error: error.message,
          checkedAt: Date.now(),
        })
        return
      }
      setState({
        status: 'offline',
        error: errorMessage(error),
        checkedAt: Date.now(),
      })
    }
  }, [api])

  useEffect(() => {
    let disposed = false
    void refresh()

    const interval = window.setInterval(() => {
      if (!disposed && document.visibilityState !== 'hidden') void refresh()
    }, POLL_MS)

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      disposed = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      requestRef.current += 1
    }
  }, [refresh])

  return { state, refresh }
}
