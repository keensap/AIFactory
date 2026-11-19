import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, isAbortError, type ChatApi } from '../api/client.ts'
import type { StageAttachment, StageKey } from '../api/types.ts'
import { checkInputFiles, describeAttachmentError } from '../data/attachments.ts'

export interface StageAttachments {
  items: StageAttachment[]
  /** First load in flight. */
  loading: boolean
  /** The list couldn't be loaded (older API / no database): attaching is unavailable. */
  unavailable: boolean
  uploading: boolean
  /** Latest add/remove problem, one message per line. */
  error: string | null
  add: (files: readonly File[]) => Promise<void>
  remove: (attachment: StageAttachment) => Promise<void>
  refresh: () => Promise<void>
  clearError: () => void
}

/**
 * Input PDFs of one project + stage. The server owns the list (and its text
 * extraction); this hook only mirrors it. All files of an add go out in one
 * request, and nothing is shown as attached until the API confirms it.
 */
export function useStageAttachments(api: ChatApi, projectId: string, stage: StageKey, enabled: boolean): StageAttachments {
  const [items, setItems] = useState<StageAttachment[]>([])
  const [loading, setLoading] = useState(enabled)
  const [unavailable, setUnavailable] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const list = await api.listAttachments(projectId, stage, signal)
      if (signal?.aborted) return
      setItems(list)
      setUnavailable(false)
    } catch (caught) {
      if (signal?.aborted || isAbortError(caught)) return
      // 404/501/503: this API has no input documents; hide the control quietly.
      if (caught instanceof ApiError && [404, 501, 503].includes(caught.status)) setUnavailable(true)
      else setError(describeAttachmentError(caught))
    }
  }, [api, projectId, stage])

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setItems([])
    void load(controller.signal).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [enabled, load])

  const add = useCallback(async (files: readonly File[]): Promise<void> => {
    const check = checkInputFiles(files, itemsRef.current.length)
    setError(check.rejected.length === 0 ? null : check.rejected.join('\n'))
    if (check.accepted.length === 0) return
    setUploading(true)
    try {
      const created = await api.uploadAttachments(projectId, check.accepted, stage)
      setItems((current) => [...created, ...current.filter((entry) => !created.some((made) => made.id === entry.id))])
    } catch (caught) {
      // The request is rejected as a whole: nothing from this batch was attached.
      setError([...check.rejected, describeAttachmentError(caught)].join('\n'))
    } finally {
      setUploading(false)
    }
  }, [api, projectId, stage])

  const remove = useCallback(async (attachment: StageAttachment): Promise<void> => {
    setError(null)
    try {
      await api.deleteAttachment(projectId, attachment.id)
      setItems((current) => current.filter((entry) => entry.id !== attachment.id))
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'ATTACHMENT_NOT_FOUND') {
        setItems((current) => current.filter((entry) => entry.id !== attachment.id))
      } else {
        setError(describeAttachmentError(caught))
      }
    }
  }, [api, projectId])

  const refresh = useCallback((): Promise<void> => load(), [load])
  const clearError = useCallback(() => setError(null), [])
  return { items, loading, unavailable, uploading, error, add, remove, refresh, clearError }
}
