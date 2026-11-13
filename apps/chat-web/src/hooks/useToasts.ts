import { useCallback, useEffect, useRef, useState } from 'react'
import { newId } from '../lib/id.ts'

export type ToastTone = 'info' | 'success' | 'error'

export interface ToastMessage {
  id: string
  message: string
  tone: ToastTone
}

export interface ToastController {
  toasts: ToastMessage[]
  push: (message: string, tone?: ToastTone) => void
  dismiss: (id: string) => void
}

const TOAST_MS = 4200

export function useToasts(): ToastController {
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const timers = useRef(new Map<string, number>())

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = newId('toast')
    setToasts((current) => [...current.slice(-2), { id, message, tone }])
    const timer = window.setTimeout(() => dismiss(id), TOAST_MS)
    timers.current.set(id, timer)
  }, [dismiss])

  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer)
    timers.current.clear()
  }, [])

  return { toasts, push, dismiss }
}
