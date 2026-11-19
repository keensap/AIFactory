import { useEffect, useState } from 'react'
import { ApiError, isAbortError, type ChatApi } from '../api/client.ts'
import type { ModelCatalogEntry, ModelTarget, ProjectUsage } from '../api/types.ts'

export interface StatusBarData {
  target: ModelTarget | null
  catalog: ModelCatalogEntry[]
  usage: ProjectUsage | null
  /** Each part fails on its own; the bar just hides what it doesn't have. */
  usageUnavailable: boolean
}

const USAGE_DAYS = 30
const USAGE_REFRESH_MS = 60_000
const EMPTY: StatusBarData = { target: null, catalog: [], usage: null, usageUnavailable: false }

/**
 * Model target + catalogue once per project; project token usage every minute
 * while the tab is visible (and right after `refreshKey` changes, e.g. when a
 * run finishes). Never throws into the page.
 */
export function useStatusBarData(api: ChatApi, projectId: string, refreshKey: string | number = 0): StatusBarData {
  const [data, setData] = useState<StatusBarData>(EMPTY)

  useEffect(() => {
    const controller = new AbortController()
    setData(EMPTY)
    void Promise.allSettled([api.getModelTarget(controller.signal), api.listModels(controller.signal)]).then(([target, catalog]) => {
      if (controller.signal.aborted) return
      setData((current) => ({
        ...current,
        target: target.status === 'fulfilled' ? target.value : null,
        catalog: catalog.status === 'fulfilled' ? catalog.value : [],
      }))
    })
    return () => controller.abort()
  }, [api, projectId])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const load = async (): Promise<void> => {
      if (controller.signal.aborted) return
      if (document.visibilityState !== 'hidden') {
        try {
          const usage = await api.getProjectUsage(projectId, USAGE_DAYS, controller.signal)
          if (controller.signal.aborted) return
          setData((current) => ({ ...current, usage, usageUnavailable: false }))
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) return
          if (error instanceof ApiError && [401, 403, 404, 503].includes(error.status)) stopped = true
          setData((current) => ({ ...current, usageUnavailable: current.usage === null }))
        }
      }
      if (!stopped && !controller.signal.aborted) timer = setTimeout(() => void load(), USAGE_REFRESH_MS)
    }
    void load()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [api, projectId, refreshKey])

  return data
}
