import { useId, useRef, useState, type DragEvent } from 'react'
import type { Project } from '../data/projects.ts'
import {
  formatBytes,
  MAX_REQUIREMENT_CHARS,
  readPdfSignature,
  validatePdfFile,
  type RequirementSubmission,
} from '../data/requirements.ts'
import { CloseIcon, FolderIcon, PencilIcon, SendIcon } from './Icons.tsx'

export interface RequirementsIntakeProps {
  project: Project
  /** PDF review needs the project registry (`pdf-review` route). */
  pdfSupported: boolean
  busy: boolean
  onSubmit: (submission: RequirementSubmission) => void
  onSkip: () => void
}

type Mode = 'text' | 'pdf'

/** Shown in place of the chat for a project that has no chats yet. */
export function RequirementsIntake({ project, pdfSupported, busy, onSubmit, onSkip }: RequirementsIntakeProps) {
  const [mode, setMode] = useState<Mode>('text')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | undefined>()
  const [message, setMessage] = useState('')
  const [touched, setTouched] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const ids = { text: useId(), file: useId(), message: useId() }

  const textError = text.trim() === ''
    ? 'Describe the requirements, or switch to PDF.'
    : text.length > MAX_REQUIREMENT_CHARS
      ? `Keep it under ${MAX_REQUIREMENT_CHARS.toLocaleString()} characters, or upload a PDF instead.`
      : undefined
  const pdfError = fileError ?? (file === null ? 'Choose a PDF requirement document.' : undefined)
  const error = mode === 'text' ? textError : pdfError

  const pickFile = async (candidate: File | undefined): Promise<void> => {
    setTouched(true)
    if (candidate === undefined) return
    const problem = validatePdfFile(candidate)
      ?? ((await readPdfSignature(candidate)) ? undefined : 'That file does not look like a valid PDF.')
    setFile(problem === undefined ? candidate : null)
    setFileError(problem)
    if (inputRef.current !== null) inputRef.current.value = ''
  }

  const onDrop = (event: DragEvent<HTMLLabelElement>): void => {
    event.preventDefault()
    setDragging(false)
    void pickFile(event.dataTransfer.files[0])
  }

  const submit = (): void => {
    setTouched(true)
    if (error !== undefined || busy) return
    if (mode === 'text') onSubmit({ kind: 'text', text, message })
    else if (file !== null) onSubmit({ kind: 'pdf', file, message })
  }

  return (
    <div className="intake">
      <div className="intake-head">
        <span className="eyebrow">New project</span>
        <h1>What should {project.name} deliver?</h1>
        <p>
          Start with the requirements. Write them below or upload a PDF requirement document.
          The harness reviews them in <code>{project.workspace || 'the project directory'}</code> and
          points out gaps before any design or code.
        </p>
      </div>

      <form
        className="intake-card"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="intake-tabs" role="tablist" aria-label="Requirement source">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'text'}
            className="intake-tab"
            onClick={() => setMode('text')}
          >
            <PencilIcon size={14} /> Write requirements
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'pdf'}
            className="intake-tab"
            disabled={!pdfSupported}
            title={pdfSupported ? undefined : 'PDF review needs the project registry'}
            onClick={() => setMode('pdf')}
          >
            <FolderIcon size={14} /> Upload PDF
          </button>
        </div>

        {mode === 'text' ? (
          <div className="field">
            <label className="field-label" htmlFor={ids.text}>Requirements</label>
            <textarea
              id={ids.text}
              className="text-input text-area intake-textarea"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={'Who is it for, what problem does it solve, and what must it do?\n\n• Users and roles\n• Core features and user stories\n• Constraints: platforms, integrations, performance, security\n• Out of scope'}
              rows={14}
              autoFocus
              aria-invalid={touched && textError !== undefined}
            />
            <div className="intake-meta">
              {touched && textError !== undefined
                ? <span className="field-error">{textError}</span>
                : <span className="field-hint">Plain text or Markdown.</span>}
              <span className="field-hint" data-over={text.length > MAX_REQUIREMENT_CHARS || undefined}>
                {text.length.toLocaleString()} / {MAX_REQUIREMENT_CHARS.toLocaleString()}
              </span>
            </div>
          </div>
        ) : (
          <div className="field">
            <span className="field-label" id={ids.file}>Requirement document</span>
            {file === null ? (
              <label
                className="dropzone"
                data-dragging={dragging || undefined}
                data-invalid={(touched && pdfError !== undefined) || undefined}
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  aria-labelledby={ids.file}
                  onChange={(event) => void pickFile(event.target.files?.[0])}
                />
                <FolderIcon size={22} />
                <span className="dropzone-title">Drop a PDF here or <u>browse</u></span>
                <span className="field-hint">.pdf only · up to 5 MB · text-based PDFs (scans can’t be read)</span>
              </label>
            ) : (
              <div className="file-chip">
                <span className="file-chip-icon" aria-hidden="true">PDF</span>
                <span className="file-chip-name" title={file.name}>{file.name}</span>
                <span className="field-hint">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => {
                    setFile(null)
                    setFileError(undefined)
                  }}
                >
                  <CloseIcon size={15} />
                </button>
              </div>
            )}
            {touched && pdfError !== undefined && <span className="field-error" role="alert">{pdfError}</span>}
          </div>
        )}

        <div className="field">
          <label className="field-label" htmlFor={ids.message}>
            Message <span className="field-optional">optional</span>
          </label>
          <textarea
            id={ids.message}
            className="text-input text-area"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Anything the reviewer should know: priorities, deadlines, what to focus on…"
            rows={3}
          />
        </div>

        <div className="intake-actions">
          <button type="button" className="text-button" onClick={onSkip} disabled={busy}>
            Skip and start a blank chat
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            <SendIcon size={15} /> {busy ? 'Sending…' : mode === 'pdf' ? 'Upload and review' : 'Submit requirements'}
          </button>
        </div>
      </form>
    </div>
  )
}
