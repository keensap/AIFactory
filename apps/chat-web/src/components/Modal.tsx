import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from './Icons.tsx'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'wide'
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: ModalProps) {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    previousFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null

    const panel = panelRef.current
    const firstInput = panel?.querySelector<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled])',
    )
    const first = firstInput ?? panel?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || panel === null) return
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((element) => element.offsetParent !== null || element === document.activeElement)
      if (focusable.length === 0) return
      const firstElement = focusable[0]!
      const lastElement = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault()
        lastElement.focus()
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault()
        firstElement.focus()
      }
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (panel !== null && event.target instanceof Node && !panel.contains(event.target)) {
        onCloseRef.current()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    const overlay = panel?.parentElement
    overlay?.addEventListener('pointerdown', onPointerDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      overlay?.removeEventListener('pointerdown', onPointerDown)
      document.body.style.overflow = previousOverflow
      previousFocus.current?.focus()
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div className="modal-overlay" role="presentation">
      <div
        ref={panelRef}
        className={`modal-panel modal-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
      >
        <header className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description !== undefined && <p id={descriptionId}>{description}</p>}
          </div>
          <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer !== undefined && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
