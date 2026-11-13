import { useCallback, useEffect, useState } from 'react'
import { errorMessage, isAbortError, type ChatApi } from '../../api/client.ts'
import type { ProjectDocument } from '../../api/types.ts'
import { describeStageError } from '../../data/stageErrors.ts'
import { formatBytes } from '../../data/requirements.ts'
import { ArrowDownIcon, ArrowUpRightIcon, RefreshIcon } from '../Icons.tsx'
import { Markdown } from '../Markdown.tsx'
import { Modal } from '../Modal.tsx'
import { CopyField, Skeleton, StageNotice, TimeAgo } from './StageBits.tsx'

/** Save a Blob through a short-lived object URL (revoked right after). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function documentFilename(document: Pick<ProjectDocument, 'storagePath' | 'title' | 'mimeType'>): string {
  const base = document.storagePath.split('/').pop()
  if (base !== undefined && base !== '') return base
  const extension = document.mimeType === 'text/markdown' ? '.md' : ''
  return `${document.title.replace(/[^\w.-]+/g, '-')}${extension}`
}

export async function downloadDocument(api: ChatApi, document: ProjectDocument): Promise<void> {
  const blob = await api.getDocumentContent(document)
  saveBlob(blob, documentFilename(document))
}

type ContentState =
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'error'; message: string }

/** Fetch a text document body with auth; cancelled on unmount. */
function useDocumentText(api: ChatApi, document: ProjectDocument): { state: ContentState; reload: () => void } {
  const [state, setState] = useState<ContentState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    api.getDocumentContent(document, controller.signal)
      .then((blob) => blob.text())
      .then((text) => {
        if (!controller.signal.aborted) setState({ status: 'ready', text })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return
        setState({ status: 'error', message: describeStageError(error).message })
      })
    return () => controller.abort()
  }, [api, document.id, document.projectId, document.version, attempt])

  return { state, reload: useCallback(() => setAttempt((value) => value + 1), []) }
}

export interface TelosDocumentProps {
  api: ChatApi
  document: ProjectDocument
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
}

/** The run's TELOS feasibility report: metadata, rendered body, download, wide preview. */
export function TelosDocument({ api, document, onNotify }: TelosDocumentProps) {
  const { state, reload } = useDocumentText(api, document)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const download = (): void => {
    setDownloading(true)
    const save = state.status === 'ready'
      ? Promise.resolve(saveBlob(new Blob([state.text], { type: document.mimeType || 'text/markdown' }), documentFilename(document)))
      : downloadDocument(api, document)
    save
      .catch((error: unknown) => onNotify(`Download failed: ${errorMessage(error)}`, 'error'))
      .finally(() => setDownloading(false))
  }

  return (
    <section className="stage-card telos-card" aria-labelledby={`telos-${document.id}`}>
      <header className="stage-card-head">
        <div>
          <span className="eyebrow">Output document</span>
          <h3 id={`telos-${document.id}`}>{document.title}</h3>
        </div>
        <div className="stage-card-actions">
          <button type="button" className="button button-ghost button-sm" onClick={() => setPreviewOpen(true)} disabled={state.status !== 'ready'}>
            <ArrowUpRightIcon size={14} /> Open preview
          </button>
          <button type="button" className="button button-ghost button-sm" onClick={download} disabled={downloading}>
            <ArrowDownIcon size={14} /> {downloading ? 'Downloading…' : 'Download .md'}
          </button>
        </div>
      </header>

      <dl className="doc-meta">
        <div><dt>Status</dt><dd><span className="chip doc-chip" data-status={document.status}>{document.status}</span></dd></div>
        <div><dt>Version</dt><dd>v{document.version}</dd></div>
        {document.sizeBytes !== undefined && <div><dt>Size</dt><dd>{formatBytes(document.sizeBytes)}</dd></div>}
        <div><dt>Created</dt><dd><TimeAgo iso={document.createdAt} /></dd></div>
        <div className="doc-meta-path"><dt>Path</dt><dd><CopyField value={document.storagePath} label="document path" /></dd></div>
      </dl>

      <div className="telos-body">
        {state.status === 'loading' && <Skeleton lines={6} />}
        {state.status === 'error' && (
          <StageNotice error={{ title: 'Couldn’t load the report body', message: state.message }} onRetry={reload} />
        )}
        {state.status === 'ready' && (
          <div className="telos-scroll">
            <Markdown>{state.text}</Markdown>
          </div>
        )}
      </div>

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title={document.title} size="wide" description={document.storagePath}>
        {state.status === 'ready' ? <Markdown>{state.text}</Markdown> : (
          <button type="button" className="button button-ghost" onClick={reload}><RefreshIcon size={14} /> Reload</button>
        )}
      </Modal>
    </section>
  )
}
