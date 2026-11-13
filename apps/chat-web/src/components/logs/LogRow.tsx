import { useState } from 'react'
import type { ProjectLog } from '../../api/types.ts'
import { copyText } from '../../lib/clipboard.ts'
import { LEVEL_LABEL, fullTimestamp, logTimestamp, payloadText, redacted, runLabel } from '../../data/logs.ts'
import { routeHref } from '../../lib/router.ts'
import { ArrowUpRightIcon, ChevronRightIcon, CopyIcon, CheckIcon } from '../Icons.tsx'

const LEVEL_GLYPH = { error: '✕', warn: '!', info: 'i', debug: '·' } as const

export function LevelBadge({ level }: { level: ProjectLog['level'] }) {
  return (
    <span className="log-level" data-level={level}>
      <span aria-hidden="true">{LEVEL_GLYPH[level]}</span>
      {LEVEL_LABEL[level]}
    </span>
  )
}

/** One log line. All text is rendered as text (never HTML) after redaction. */
export function LogRow({
  log, expanded, onToggle, onFilterRun, redact, projectId,
}: {
  log: ProjectLog
  expanded: boolean
  onToggle: () => void
  onFilterRun: (runId: string) => void
  redact: boolean
  projectId: string
}) {
  const clean = (text: string | null): string => (text === null ? '' : redact ? redacted(text) : text)
  const message = clean(log.message)
  const preview = clean(log.preview)
  return (
    <li className="log-item" data-level={log.level} data-expanded={expanded ? '' : undefined}>
      <button type="button" className="log-row" aria-expanded={expanded} onClick={onToggle}>
        <ChevronRightIcon size={13} className="log-chevron" />
        <time className="log-time" dateTime={log.createdAt} title={fullTimestamp(log.createdAt)}>{logTimestamp(log.createdAt)}</time>
        <LevelBadge level={log.level} />
        <span className="log-scope">
          <span>{runLabel(log)}</span>
          {log.role !== null && <span className="chip log-chip" data-role={log.role}>{log.role}</span>}
        </span>
        <span className="log-type">{log.type}</span>
        <span className="log-message">
          <span className="log-message-text">{message}</span>
          {preview !== '' && !expanded && <span className="log-preview">{preview}</span>}
        </span>
      </button>
      {expanded && <LogDetail log={log} message={message} preview={preview} redact={redact} onFilterRun={onFilterRun} projectId={projectId} />}
    </li>
  )
}

function LogDetail({
  log, message, preview, redact, onFilterRun, projectId,
}: {
  log: ProjectLog
  message: string
  preview: string
  redact: boolean
  onFilterRun: (runId: string) => void
  projectId: string
}) {
  const [copied, setCopied] = useState(false)
  const payload = payloadText(log.payload, redact)
  const copy = (): void => {
    void copyText(JSON.stringify({ ...log, message, preview: preview === '' ? null : preview, payload: payload === '' ? {} : JSON.parse(payload) }, null, 2)).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="log-detail">
      <pre className="log-block log-block-message">{message}</pre>
      {preview !== '' && (
        <section>
          <h4>Preview</h4>
          <pre className="log-block">{preview}</pre>
        </section>
      )}
      {payload !== '' && (
        <section>
          <h4>Payload</h4>
          <pre className="log-block">{payload}</pre>
        </section>
      )}
      <dl className="log-meta">
        <div><dt>Event</dt><dd>{log.id}</dd></div>
        <div><dt>Run</dt><dd>{log.stageRunId}</dd></div>
        {log.agentId !== null && <div><dt>Agent</dt><dd>{log.agentId}</dd></div>}
        {log.phase !== null && <div><dt>Phase</dt><dd>{log.phase}</dd></div>}
        <div><dt>Time</dt><dd>{fullTimestamp(log.createdAt)}</dd></div>
      </dl>
      <div className="log-actions">
        <button type="button" className="button button-ghost button-sm" onClick={() => onFilterRun(log.stageRunId)}>Only this run</button>
        <a className="button button-ghost button-sm" href={routeHref({ name: 'stage', projectId, stage: log.stage, runId: log.stageRunId })}>
          Open run <ArrowUpRightIcon size={13} />
        </a>
        <button type="button" className="button button-ghost button-sm" onClick={copy}>
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />} {copied ? 'Copied' : 'Copy JSON'}
        </button>
      </div>
    </div>
  )
}
