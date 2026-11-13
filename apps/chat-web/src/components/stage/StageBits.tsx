import { useState, type ReactNode } from 'react'
import type { ChecklistStatus, StageStatus } from '../../api/types.ts'
import type { StageErrorView } from '../../data/stageErrors.ts'
import { runStatusLabel, STAGE_STATUS_LABEL } from '../../data/stages.ts'
import { copyText } from '../../lib/clipboard.ts'
import { formatRelativeTime } from '../../lib/format.ts'
import { AlertIcon, CheckIcon, CopyIcon, RefreshIcon } from '../Icons.tsx'

/** Stage status chip; text label plus a shape, never colour alone. */
export function StageStatusChip({ status }: { status: StageStatus }) {
  return (
    <span className="chip stage-chip" data-status={status}>
      <span className="chip-glyph" aria-hidden="true" />
      {STAGE_STATUS_LABEL[status] ?? status}
    </span>
  )
}

export function RunStatusChip({ status }: { status: string }) {
  return (
    <span className="chip run-chip" data-status={status}>
      <span className="chip-glyph" aria-hidden="true" />
      {runStatusLabel(status)}
    </span>
  )
}

const CHECKLIST_LABEL: Record<ChecklistStatus, string> = { done: 'Done', open: 'Open', waived: 'Waived' }

export function ChecklistChip({ status }: { status: ChecklistStatus }) {
  return (
    <span className="chip checklist-chip" data-status={status}>
      {status === 'done' ? <CheckIcon size={11} strokeWidth={2.6} /> : <span className="chip-glyph" aria-hidden="true" />}
      {CHECKLIST_LABEL[status] ?? status}
    </span>
  )
}

/** Relative time with the full timestamp on hover. */
export function TimeAgo({ iso, prefix }: { iso: string | null | undefined; prefix?: string }) {
  if (iso === null || iso === undefined || iso === '') return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return (
    <time dateTime={iso} title={date.toLocaleString()}>
      {prefix === undefined ? '' : `${prefix} `}{formatRelativeTime(iso)}
    </time>
  )
}

/** Monospace value with a copy button. `display` overrides the visible text. */
export function CopyField({ value, display, label }: { value: string; display?: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="copy-field">
      <code title={value}>{display ?? value}</code>
      <button
        type="button"
        className="icon-button copy-field-button"
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        title={copied ? 'Copied' : `Copy ${label}`}
        onClick={() => {
          void copyText(value).then((ok) => {
            if (!ok) return
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </button>
    </span>
  )
}

export function StageNotice({
  error,
  tone = 'error',
  onRetry,
  children,
}: {
  error: Pick<StageErrorView, 'title' | 'message'>
  tone?: 'error' | 'warning' | 'info'
  onRetry?: () => void
  children?: ReactNode
}) {
  return (
    <div className="stage-notice" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <AlertIcon size={16} />
      <div className="stage-notice-body">
        <strong>{error.title}</strong>
        {error.message !== '' && <p>{error.message}</p>}
        {children}
      </div>
      {onRetry !== undefined && (
        <button type="button" className="button button-ghost button-sm" onClick={onRetry}>
          <RefreshIcon size={14} /> Retry
        </button>
      )}
    </div>
  )
}

export function Skeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={`skeleton-block ${className ?? ''}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="skeleton-line" style={{ width: `${92 - index * 14}%` }} />
      ))}
    </div>
  )
}

export function ProgressMeter({ done, total, label }: { done: number; total: number; label: string }) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return (
    <span className="progress-meter" title={`${label}: ${done} of ${total}`}>
      <span className="progress-meter-track" aria-hidden="true">
        <span className="progress-meter-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="progress-meter-text">{done}/{total}</span>
      <span className="sr-only">{label}: {done} of {total}</span>
    </span>
  )
}
