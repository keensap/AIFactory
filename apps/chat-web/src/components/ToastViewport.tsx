import type { ToastController } from '../hooks/useToasts.ts'
import { CheckIcon, CloseIcon, InfoIcon, AlertIcon } from './Icons.tsx'

export function ToastViewport({ toasts, dismiss }: ToastController) {
  if (toasts.length === 0) return null
  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`} role="status">
          <span className="toast-icon" aria-hidden="true">
            {toast.tone === 'success' ? <CheckIcon size={16} /> : null}
            {toast.tone === 'error' ? <AlertIcon size={16} /> : null}
            {toast.tone === 'info' ? <InfoIcon size={16} /> : null}
          </span>
          <span className="toast-text">{toast.message}</span>
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
