import type { ReactNode } from 'react'
import { Modal } from './Modal.tsx'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel: string
  busy?: boolean
  tone?: 'danger' | 'primary'
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  tone = 'danger',
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={(
        <>
          <button type="button" className="button button-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'button button-danger' : 'button button-primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      )}
    >
      <div className="confirm-copy">{description}</div>
    </Modal>
  )
}
