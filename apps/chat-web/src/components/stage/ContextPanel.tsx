import { useState, type ReactNode } from 'react'
import { errorMessage, type ChatApi } from '../../api/client.ts'
import type { ApiProject, ChecklistItem, ProjectDocument, StageRun } from '../../api/types.ts'
import { priorStageSummaries, shortHash, sortDocuments, TELOS_KIND } from '../../data/stages.ts'
import { routeHref } from '../../lib/router.ts'
import { ArrowDownIcon, ChevronDownIcon, ChevronRightIcon } from '../Icons.tsx'
import { ChecklistChip, CopyField, RunStatusChip, Skeleton, TimeAgo } from './StageBits.tsx'
import { downloadDocument } from './TelosDocument.tsx'

/** Collapsible section; open by default on desktop, closable on narrow screens. */
function PanelSection({ id, title, defaultOpen = true, children }: { id: string; title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="context-section" id={id} tabIndex={-1}>
      <h3>
        <button type="button" className="context-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          {title}
        </button>
      </h3>
      <div id={`${id}-body`} hidden={!open}>{children}</div>
    </section>
  )
}

export interface ContextPanelProps {
  api: ChatApi
  project: ApiProject
  checklist: ChecklistItem[] | null
  documents: ProjectDocument[] | null
  /** Run on screen (run route), else the latest run of the stage. */
  run: StageRun | null
  latestRun: StageRun | null
  stage: string
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
}

export function ContextPanel({ api, project, checklist, documents, run, latestRun, stage, onNotify }: ContextPanelProps) {
  const prior = run === null ? [] : priorStageSummaries(run.context)
  const evidence = new Map((documents ?? []).map((document) => [document.id, document]))
  return (
    <aside className="context-panel" aria-label="Stage context">
      <PanelSection id="stage-checklist" title="Checklist">
        {checklist === null ? <Skeleton lines={4} /> : checklist.length === 0 ? (
          <p className="section-empty-inline">No checklist items for this stage.</p>
        ) : (
          <ul className="checklist">
            {checklist.map((item) => {
              const doc = item.evidenceDocumentId === null ? undefined : evidence.get(item.evidenceDocumentId)
              return (
                <li key={item.id} className="checklist-item" data-status={item.status}>
                  <ChecklistChip status={item.status} />
                  <span className="checklist-label">
                    {item.label}
                    <span className="checklist-sub">
                      {item.required ? 'Required' : 'Optional'}
                      {item.status === 'done' && item.completedAt !== null && <> · <TimeAgo iso={item.completedAt} /></>}
                      {item.evidenceDocumentId !== null && (
                        <> · <button type="button" className="text-button" onClick={() => {
                          if (doc === undefined) return
                          downloadDocument(api, doc).catch((error: unknown) => onNotify(`Download failed: ${errorMessage(error)}`, 'error'))
                        }} disabled={doc === undefined}>
                          {doc === undefined ? 'evidence' : `evidence: ${doc.title}`}
                        </button></>
                      )}
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </PanelSection>

      <PanelSection id="stage-documents" title="Documents">
        {documents === null ? <Skeleton lines={2} /> : documents.length === 0 ? (
          <p className="section-empty-inline">No documents for this {run === null ? 'stage' : 'run'} yet.</p>
        ) : (
          <ul className="doc-list">
            {sortDocuments(documents).map((document) => (
              <li key={document.id} className="doc-row" data-primary={document.kind === TELOS_KIND || undefined}>
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
      </PanelSection>

      <PanelSection id="stage-project-context" title="Project context">
        <dl className="context-list">
          <div><dt>Organization</dt><dd>{project.organization ?? '—'}</dd></div>
          <div><dt>Owner</dt><dd>{project.ownerEmail ?? '—'}</dd></div>
          <div><dt>Status</dt><dd className="capitalize">{project.status}</dd></div>
          {run !== null && run.contextHash !== null && (
            <div><dt>Context hash</dt><dd><CopyField value={run.contextHash} display={shortHash(run.contextHash)} label="context hash" /></dd></div>
          )}
        </dl>
        {run !== null && (
          <div className="context-brief">
            <span className="context-label">Input brief</span>
            {run.inputText === null || run.inputText.trim() === ''
              ? <p className="section-empty-inline">No brief — based on project metadata only.</p>
              : <p className="context-brief-text">{run.inputText}</p>}
          </div>
        )}
        {prior.length > 0 && (
          <div className="context-brief">
            <span className="context-label">Prior stage summaries</span>
            {prior.map((entry) => (
              <details key={entry.stage} className="context-details">
                <summary>{entry.stage}</summary>
                <p className="context-brief-text">{entry.summary}</p>
              </details>
            ))}
          </div>
        )}
        {run !== null && run.context !== null && (
          <details className="context-details">
            <summary>View context</summary>
            <pre className="context-json">{JSON.stringify(run.context, null, 2)}</pre>
          </details>
        )}
      </PanelSection>

      {latestRun !== null && (
        <PanelSection id="stage-latest-run" title="Latest run">
          <a className="latest-run" href={routeHref({ name: 'stage', projectId: project.id, stage, runId: latestRun.id })}>
            <span>Attempt {latestRun.attempt}</span>
            <RunStatusChip status={latestRun.status} />
            <TimeAgo iso={latestRun.updatedAt} />
          </a>
        </PanelSection>
      )}
    </aside>
  )
}
