import { errorMessage, type ChatApi } from '../../api/client.ts'
import type { ProjectDocument } from '../../api/types.ts'
import { sortDocuments, stageArtifactKind } from '../../data/stages.ts'
import { ArrowDownIcon } from '../Icons.tsx'
import { Skeleton, TimeAgo } from './StageBits.tsx'
import { downloadDocument } from './TelosDocument.tsx'

/** Documents of the stage on screen (read and download only). */
export function ArtifactsCard({ api, documents, onNotify, stage = 'planning' }: {
  api: ChatApi
  documents: ProjectDocument[] | null
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
  stage?: string
}) {
  const primaryKind = stageArtifactKind(stage)
  return (
    <section className="stage-card artifacts-card" aria-labelledby="artifacts-title">
      <header className="stage-card-head stage-card-head-compact"><h3 id="artifacts-title">Artifacts</h3></header>
      {documents === null ? <Skeleton lines={2} /> : documents.length === 0 ? (
        <p className="section-empty-inline">No documents for this stage yet.</p>
      ) : (
        <ul className="doc-list">
          {sortDocuments(documents, stage).map((document) => (
            <li key={document.id} className="doc-row" data-primary={(document.stage === stage && document.kind === primaryKind) || undefined}>
              <div className="doc-row-main">
                <span className="doc-row-title">{document.title}</span>
                <span className="doc-row-sub">
                  <code>{document.kind}</code> · v{document.version} · <span className="chip doc-chip" data-status={document.status}>{document.status}</span> · <TimeAgo iso={document.createdAt} />
                </span>
                <code className="doc-row-path" title={document.storagePath}>{document.storagePath}</code>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={`Download ${document.title}`}
                title="Download"
                onClick={() => {
                  downloadDocument(api, document).catch((error: unknown) => onNotify(`Download failed: ${errorMessage(error)}`, 'error'))
                }}
              >
                <ArrowDownIcon size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
