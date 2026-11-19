import { useCallback, useEffect, useState } from 'react'
import { ApiError, errorMessage, isAbortError, type ChatApi } from '../../api/client.ts'
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

export interface StageDocumentProps {
  stage: string
  api: ChatApi
  document: ProjectDocument
  /** Run that produced the document; enables Re-export. */
  runId?: string
  /** Newest `document_export_failed` message from the run's activity, if any. */
  exportFailed?: string | null
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
}

/** The run's output document: metadata, rendered body, download, wide preview. */
export function StageDocument({ stage, api, document, runId, exportFailed, onNotify }: StageDocumentProps) {
  const { state, reload } = useDocumentText(api, document)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [pdfPath, setPdfPath] = useState<string | null>(document.exportPath ?? null)
  const [pdfBytes, setPdfBytes] = useState<number | null>(null)
  const [pdfBusy, setPdfBusy] = useState<'open' | 'download' | null>(null)
  const [renderFailure, setRenderFailure] = useState<string | null>(exportFailed ?? null)
  useEffect(() => {
    setPdfPath(document.exportPath ?? null)
    setPdfBytes(null)
  }, [document.id, document.exportPath])
  useEffect(() => setRenderFailure(exportFailed ?? null), [exportFailed])
  const pdfName = pdfPath === null ? 'document.pdf' : (pdfPath.split('/').pop() ?? 'document.pdf')

  const download = (): void => {
    setDownloading(true)
    const save = state.status === 'ready'
      ? Promise.resolve(saveBlob(new Blob([state.text], { type: document.mimeType || 'text/markdown' }), documentFilename(document)))
      : downloadDocument(api, document)
    save
      .catch((error: unknown) => onNotify(`Download failed: ${errorMessage(error)}`, 'error'))
      .finally(() => setDownloading(false))
  }

  const reExport = (): void => {
    if (runId === undefined) return
    setExporting(true)
    api.exportStageRun(runId)
      .then(({ path, bytes }) => {
        if (path !== '') setPdfPath(path)
        setPdfBytes(bytes)
        setRenderFailure(null)
        onNotify(path === '' ? 'PDF exported' : `PDF exported to ${path}`, 'success')
      })
      .catch((error: unknown) => {
        const message = describeStageError(error).message
        setRenderFailure(message)
        onNotify(`PDF export failed: ${message}`, 'error')
      })
      .finally(() => setExporting(false))
  }

  // The API doesn't hand out the project tree, so the PDF is fetched with the
  // bearer token. If the server can't serve it, fall back to the path.
  const withPdf = (mode: 'open' | 'download'): void => {
    // Open the tab synchronously (inside the click) so popup blockers allow it.
    const tab = mode === 'open' ? window.open('', '_blank') : null
    setPdfBusy(mode)
    // The API serves an already-exported PDF; when none exists yet (or the file
    // was removed) write it once with the run export, then fetch again.
    const fetchPdf = (): ReturnType<ChatApi['getExportedPdf']> =>
      api.getExportedPdf(document.projectId, document.id).catch(async (error: unknown) => {
        const notExported = error instanceof ApiError && (error.code === 'DOCUMENT_NOT_EXPORTED' || error.code === 'EXPORT_FILE_MISSING')
        if (!notExported || runId === undefined) throw error
        const exported = await api.exportStageRun(runId)
        if (exported.path !== '') setPdfPath(exported.path)
        setPdfBytes(exported.bytes)
        return api.getExportedPdf(document.projectId, document.id)
      })
    fetchPdf()
      .then(({ blob, filename }) => {
        if (pdfPath === null && filename !== null) {
          setPdfPath(`documents/${stage}/${filename}`)
          setPdfBytes(blob.size)
        }
        const pdf = blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' })
        if (mode === 'download') {
          saveBlob(pdf, pdfPath === null ? (filename ?? `${document.title}.pdf`) : pdfName)
          return
        }
        const url = URL.createObjectURL(pdf)
        if (tab === null) window.open(url, '_blank')
        else tab.location.href = url
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      })
      .catch((error: unknown) => {
        tab?.close()
        const missing = error instanceof ApiError && [404, 405, 501].includes(error.status)
        onNotify(
          missing
            ? `The PDF isn’t available from the API. Look for it in your project folder at ${pdfPath ?? 'documents/'}.`
            : `Couldn’t get the PDF: ${errorMessage(error)}`,
          missing ? 'info' : 'error',
        )
      })
      .finally(() => setPdfBusy(null))
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
          {(
            <>
              <button type="button" className="button button-primary button-sm" onClick={() => withPdf('open')} disabled={pdfBusy !== null}>
                <ArrowUpRightIcon size={14} /> {pdfBusy === 'open' ? 'Opening…' : 'Open PDF'}
              </button>
              <button type="button" className="button button-ghost button-sm" onClick={() => withPdf('download')} disabled={pdfBusy !== null}>
                <ArrowDownIcon size={14} /> {pdfBusy === 'download' ? 'Downloading…' : 'Download PDF'}
              </button>
            </>
          )}
          {runId !== undefined && (
            <button type="button" className="button button-ghost button-sm" onClick={reExport} disabled={exporting}>
              <RefreshIcon size={14} /> {exporting ? 'Exporting…' : pdfPath === null ? 'Export PDF' : 'Re-export PDF'}
            </button>
          )}
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
        {pdfPath !== null && (
          <div className="doc-meta-path">
            <dt>PDF</dt>
            <dd>
              <CopyField value={pdfPath} label="PDF path" />
              {pdfBytes !== null && <span className="field-hint"> {formatBytes(pdfBytes)}</span>}
            </dd>
          </div>
        )}
        <div className="doc-meta-path"><dt>Path</dt><dd><CopyField value={document.storagePath} label="document path" /></dd></div>
      </dl>

      {renderFailure !== null && (
        <div className="stage-notice" data-tone="warning" role="alert">
          <div className="stage-notice-body">
            <strong>The PDF could not be produced</strong>
            <p>{renderFailure} The Markdown document below is complete.</p>
          </div>
          {runId !== undefined && (
            <button type="button" className="button button-secondary button-sm" onClick={reExport} disabled={exporting}>
              {exporting ? 'Retrying…' : 'Retry'}
            </button>
          )}
        </div>
      )}
      {pdfPath === null && renderFailure === null && (
        <p className="field-hint pdf-pending">The PDF is written to the project’s <code>documents/</code> folder. If it isn’t there yet, Open PDF creates it.</p>
      )}

      <div className="telos-body">
        {state.status === 'loading' && <Skeleton lines={6} />}
        {state.status === 'error' && (
          <StageNotice error={{ title: 'Couldn’t load the document body', message: state.message }} onRetry={reload} />
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
