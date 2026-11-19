import { useId, useRef, useState } from 'react'
import type { StageAttachments } from '../../hooks/useStageAttachments.ts'
import { ATTACHMENT_TEXT_LIMIT, attachmentMeta, MAX_ATTACHMENTS_PER_RUN } from '../../data/attachments.ts'
import { CloseIcon, PlusIcon } from '../Icons.tsx'
import { Skeleton } from './StageBits.tsx'

/** Input documents (PDF) under the brief: add several at once, list, remove. */
export function AttachmentsField({ attachments, disabled, runQueued = false }: { attachments: StageAttachments; disabled: boolean; runQueued?: boolean }) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const id = useId()
  if (attachments.unavailable) return null
  const { items, uploading, error } = attachments
  const busy = disabled || uploading
  const full = items.length >= MAX_ATTACHMENTS_PER_RUN

  const pick = (list: FileList | null): void => {
    if (list === null || list.length === 0) return
    void attachments.add(Array.from(list))
  }

  return (
    <div
      className="field attachments-field"
      data-dragging={dragging || undefined}
      onDragOver={(event) => { if (!busy) { event.preventDefault(); setDragging(true) } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        if (!busy) pick(event.dataTransfer.files)
      }}
    >
      <div className="attachments-head">
        <span className="field-label" id={`${id}-label`}>Input documents (PDF)</span>
        <button
          type="button"
          className="button button-secondary button-sm"
          disabled={busy || full}
          onClick={() => inputRef.current?.click()}
          aria-describedby={`${id}-help`}
        >
          <PlusIcon size={14} /> {uploading ? 'Uploading…' : 'Add PDFs'}
        </button>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept=".pdf,application/pdf"
          multiple
          tabIndex={-1}
          aria-labelledby={`${id}-label`}
          data-testid="attachment-input"
          onChange={(event) => {
            pick(event.target.files)
            event.target.value = ''
          }}
        />
      </div>
      <p className="field-hint" id={`${id}-help`}>
        PDFs with a text layer only (images and scanned pages aren’t read). Up to 20 MB each, 10 at a time, {MAX_ATTACHMENTS_PER_RUN} per run.
        Drop files here or use Add PDFs.
      </p>

      {attachments.loading && <Skeleton lines={1} />}
      {!attachments.loading && items.length === 0 && !uploading && <p className="field-hint attachments-empty">No input documents. The run uses the brief only.</p>}
      {items.length > 0 && (
        <ul className="attachment-list" aria-label="Input documents">
          {items.map((attachment) => (
            <li key={attachment.id} className="attachment-item">
              <span className="attachment-icon" aria-hidden="true">PDF</span>
              <span className="attachment-text">
                <span className="attachment-title" title={attachment.filename}>{attachment.title}</span>
                <span className="attachment-meta">{attachmentMeta(attachment)}</span>
                {attachment.truncated && (
                  <span className="attachment-warning">
                    Long document: only the first {ATTACHMENT_TEXT_LIMIT.toLocaleString()} characters are analysed.
                  </span>
                )}
              </span>
              <button
                type="button"
                className="icon-button attachment-remove"
                disabled={busy}
                aria-label={`Remove ${attachment.title}`}
                title="Remove"
                onClick={() => void attachments.remove(attachment)}
              >
                <CloseIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {runQueued && items.length > 0 && <p className="field-hint">Removing a document doesn’t change a run that already started.</p>}
      {error !== null && <p className="field-error attachment-error" role="alert">{error}</p>}
    </div>
  )
}
