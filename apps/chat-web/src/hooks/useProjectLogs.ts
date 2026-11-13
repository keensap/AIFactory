import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, isAbortError, type ChatApi } from '../api/client.ts'
import type { ProjectLog } from '../api/types.ts'
import { compareEventIds } from '../api/stageEvents.ts'
import {
  LIVE_POLL_MS, MAX_LOGS, PAGE_SIZE, filtersToQuery, mergeLogs, newestId, type LogFilters,
} from '../data/logs.ts'

export type LogsStatus = 'loading' | 'ready' | 'error'
export type LiveState = 'off' | 'live' | 'paused' | 'reconnecting'

export interface ProjectLogsState {
  logs: ProjectLog[]
  status: LogsStatus
  /** Blocking error for the first page (shown instead of the list). */
  error: ApiError | null
  hasMore: boolean
  loadingMore: boolean
  moreError: string | null
  /** Oldest rows were dropped to stay under the in-memory cap. */
  trimmed: boolean
  /** New logs received while the user is scrolled away from the top. */
  pending: number
  live: boolean
  liveState: LiveState
  lastUpdated: number | null
}

const INITIAL: ProjectLogsState = {
  logs: [], status: 'loading', error: null, hasMore: false, loadingMore: false, moreError: null,
  trimmed: false, pending: 0, live: true, liveState: 'live', lastUpdated: null,
}

/** Errors that make retrying pointless (auth, missing project, registry off). */
const FATAL = new Set([400, 401, 403, 404, 503])
/** A live poll may chase at most this many pages to close a gap. */
const MAX_GAP_PAGES = 5
const RETRY_DELAYS_MS = [3000, 6000, 12_000, 20_000]

/**
 * Logs of ONE project. The project id is part of every request, and the
 * effect restarts (abort + reset) whenever the project or the filters change,
 * so rows from a previous project/filter never leak into the current view.
 *
 * Live tail: one poll at a time, every LIVE_POLL_MS, skipped while the tab is
 * hidden. New rows are merged straight in while the user is at the top of the
 * list, and buffered (`pending`) while they are scrolled down.
 */
export function useProjectLogs(
  api: ChatApi,
  projectId: string,
  filters: LogFilters,
  options: { atTop: boolean },
): ProjectLogsState & {
  setLive: (live: boolean) => void
  loadOlder: () => void
  refresh: () => void
  showPending: () => void
} {
  const [state, setState] = useState<ProjectLogsState>(INITIAL)
  const [restart, setRestart] = useState(0)
  const stateRef = useRef(state)
  stateRef.current = state
  const pendingRef = useRef<ProjectLog[]>([])
  const atTopRef = useRef(options.atTop)
  atTopRef.current = options.atTop
  const loadMoreRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)
  const filtersKey = JSON.stringify(filters)
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  const applyNew = useCallback((incoming: ProjectLog[]) => {
    setState((current) => {
      const merged = mergeLogs(current.logs, incoming)
      return { ...current, logs: merged.logs, trimmed: current.trimmed || merged.trimmed, pending: 0, lastUpdated: Date.now() }
    })
  }, [])

  // First page, restarted on project / filter / manual refresh.
  useEffect(() => {
    const controller = new AbortController()
    const generation = ++generationRef.current
    loadMoreRef.current?.abort()
    pendingRef.current = []
    const current = (): boolean => generationRef.current === generation && !controller.signal.aborted
    setState({ ...INITIAL, live: stateRef.current.live })

    void (async () => {
      try {
        const page = await api.listProjectLogs(projectId, filtersToQuery(filtersRef.current, { limit: PAGE_SIZE }), controller.signal)
        if (!current()) return
        setState((s) => ({
          ...s, logs: mergeLogs([], page.logs).logs, status: 'ready', error: null,
          hasMore: page.nextBefore !== null, lastUpdated: Date.now(), liveState: s.live ? 'live' : 'off',
        }))
      } catch (error) {
        if (!current() || isAbortError(error)) return
        const apiError = error instanceof ApiError ? error : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : 'Could not load logs.')
        setState((s) => ({ ...s, status: 'error', error: apiError, liveState: 'off' }))
      }
    })()

    return () => controller.abort()
  }, [api, projectId, filtersKey, restart])

  // Live tail: one poll at a time while enabled and the first page is loaded.
  const polling = state.live && state.status === 'ready'
  useEffect(() => {
    if (!polling) return
    const controller = new AbortController()
    const generation = generationRef.current
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const current = (): boolean => generationRef.current === generation && !controller.signal.aborted
    const schedule = (delay: number): void => {
      if (current()) timer = setTimeout(() => void poll(), delay)
    }
    const poll = async (): Promise<void> => {
      if (!current()) return
      if (document.visibilityState === 'hidden') {
        setState((s) => (s.liveState === 'paused' ? s : { ...s, liveState: 'paused' }))
        schedule(LIVE_POLL_MS)
        return
      }
      try {
        const known = newestId(stateRef.current.logs)
        const fresh: ProjectLog[] = []
        let before: string | undefined
        // Chase older pages until we reach rows we already have (closes gaps
        // when more than a page of logs arrived between polls).
        for (let page = 0; page < MAX_GAP_PAGES; page += 1) {
          const result = await api.listProjectLogs(
            projectId,
            filtersToQuery(filtersRef.current, { limit: PAGE_SIZE, ...(before !== undefined ? { before } : {}) }),
            controller.signal,
          )
          if (!current()) return
          fresh.push(...result.logs.filter((log) => compareEventIds(log.id, known) > 0))
          const reachedKnown = result.logs.some((log) => compareEventIds(log.id, known) <= 0)
          if (reachedKnown || result.nextBefore === null || result.logs.length === 0) break
          before = result.nextBefore
        }
        failures = 0
        if (fresh.length > 0) {
          if (atTopRef.current) applyNew(fresh)
          else {
            pendingRef.current = mergeLogs(pendingRef.current, fresh, MAX_LOGS).logs
            setState((s) => ({ ...s, pending: pendingRef.current.length }))
          }
        }
        setState((s) => (s.liveState === 'live' ? s : { ...s, liveState: 'live' }))
        schedule(LIVE_POLL_MS)
      } catch (error) {
        if (!current() || isAbortError(error)) return
        if (error instanceof ApiError && FATAL.has(error.status)) {
          setState((s) => ({ ...s, live: false, liveState: 'off' }))
          return
        }
        failures += 1
        setState((s) => ({ ...s, liveState: 'reconnecting' }))
        schedule(RETRY_DELAYS_MS[Math.min(failures - 1, RETRY_DELAYS_MS.length - 1)]!)
      }
    }
    schedule(LIVE_POLL_MS)
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [api, projectId, filtersKey, restart, polling, applyNew])

  // Back at the top: show what arrived while scrolled away.
  useEffect(() => {
    if (options.atTop && pendingRef.current.length > 0) {
      const held = pendingRef.current
      pendingRef.current = []
      applyNew(held)
    }
  }, [options.atTop, applyNew])

  const setLive = useCallback((live: boolean) => {
    setState((s) => ({ ...s, live, liveState: live ? 'live' : 'off' }))
  }, [])

  const loadOlder = useCallback(() => {
    const snapshot = stateRef.current
    if (snapshot.loadingMore || !snapshot.hasMore || snapshot.trimmed || snapshot.status !== 'ready') return
    const oldest = snapshot.logs.at(-1)
    if (oldest === undefined) return
    const generation = generationRef.current
    const controller = new AbortController()
    loadMoreRef.current = controller
    setState((s) => ({ ...s, loadingMore: true, moreError: null }))
    api.listProjectLogs(projectId, filtersToQuery(filtersRef.current, { limit: PAGE_SIZE, before: oldest.id }), controller.signal)
      .then((page) => {
        if (generationRef.current !== generation || controller.signal.aborted) return
        setState((s) => {
          const merged = mergeLogs(s.logs, page.logs)
          return {
            ...s, logs: merged.logs, loadingMore: false, hasMore: page.nextBefore !== null && !merged.trimmed,
            trimmed: s.trimmed || merged.trimmed,
          }
        })
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || generationRef.current !== generation) return
        setState((s) => ({ ...s, loadingMore: false, moreError: error instanceof Error ? error.message : 'Could not load older logs.' }))
      })
  }, [api, projectId])

  const refresh = useCallback(() => setRestart((n) => n + 1), [])
  const showPending = useCallback(() => {
    const held = pendingRef.current
    pendingRef.current = []
    applyNew(held)
  }, [applyNew])

  return useMemo(() => ({ ...state, setLive, loadOlder, refresh, showPending }), [state, setLive, loadOlder, refresh, showPending])
}
