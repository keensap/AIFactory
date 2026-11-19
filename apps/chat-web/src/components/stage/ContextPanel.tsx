import { useState, type ReactNode } from 'react'
import { errorMessage, type ChatApi } from '../../api/client.ts'
import type { ChecklistItem, ProjectDocument } from '../../api/types.ts'
import { ChevronDownIcon, ChevronRightIcon } from '../Icons.tsx'
import { ChecklistChip, Skeleton, TimeAgo } from './StageBits.tsx'
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
  checklist: ChecklistItem[] | null
  /** Only used to resolve checklist evidence links. */
  documents: ProjectDocument[] | null
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
}

export function ContextPanel({ api, checklist, documents, onNotify }: ContextPanelProps) {
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
    </aside>
  )
}
