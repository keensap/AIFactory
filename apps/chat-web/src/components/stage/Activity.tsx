import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { ActivityConnection } from '../../api/stageEvents.ts'
import type { StageRunEvent } from '../../api/types.ts'
import {
  ACTIVITY_ROLES,
  buildTimeline,
  clockTime,
  currentActivity,
  filterTimeline,
  redactSecrets,
  ROLE_LABEL,
  shortDuration,
  TYPE_FILTERS,
  type ActivityFilters,
  type ActivityGroup,
  type ActivityRole,
  type ActivityRow,
} from '../../data/activity.ts'
import { describeStageError } from '../../data/stageErrors.ts'
import type { RunEventsState } from '../../hooks/useRunEvents.ts'
import { copyText } from '../../lib/clipboard.ts'
import { formatFullDate, pluralize } from '../../lib/format.ts'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, CopyIcon, ListIcon } from '../Icons.tsx'
import { StageNotice } from './StageBits.tsx'

const CONNECTION_LABEL: Record<ActivityConnection, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  ended: 'Complete',
  error: 'Error',
}

export function ConnectionBadge({ connection }: { connection: ActivityConnection }) {
  return (
    <span className="activity-conn" data-state={connection}>
      <span className="activity-conn-dot" aria-hidden="true" />
      {CONNECTION_LABEL[connection]}
    </span>
  )
}

/** One-line "what's happening now"; opens the drawer. */
export function CurrentActivityLine({
  events,
  connection,
  onOpen,
  expanded,
}: {
  events: readonly StageRunEvent[]
  connection: ActivityConnection
  onOpen: () => void
  expanded: boolean
}) {
  const line = events.length === 0 && connection === 'ended' ? 'No activity was recorded for this run.' : currentActivity(events)
  return (
    <button type="button" className="activity-line" onClick={onOpen} aria-expanded={expanded} aria-controls="run-activity">
      <ConnectionBadge connection={connection} />
      <span className="activity-line-text">{line}</span>
      <span className="activity-line-cta">
        Activity{events.length > 0 ? ` · ${events.length}` : ''}
        <ChevronRightIcon size={13} />
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Drawer

const WIDTH_KEY = 'aifactory.chat-web.activity.v1'
const MIN_WIDTH = 340
const DEFAULT_WIDTH = 440

function loadWidth(): number {
  try {
    const value = Number(JSON.parse(window.localStorage.getItem(WIDTH_KEY) ?? 'null')?.width)
    return Number.isFinite(value) && value >= MIN_WIDTH ? value : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

function saveWidth(width: number): void {
  try {
    window.localStorage.setItem(WIDTH_KEY, JSON.stringify({ width }))
  } catch {
    // per-viewer convenience only
  }
}

function maxWidth(): number {
  return Math.max(MIN_WIDTH, Math.min(960, window.innerWidth - 240))
}

export interface ActivityDrawerProps {
  open: boolean
  onClose: () => void
  attempt: number
  log: RunEventsState & { reconnect: () => void }
  /** The run can still produce events (marks the last unfinished role as running). */
  runActive: boolean
  filters: ActivityFilters
  onFiltersChange: (filters: ActivityFilters) => void
  onShowReviews: () => void
  onShowDocument: () => void
  /** Href of the project log viewer for this run (see `runLogsHref`). */
  logsHref: string
}

export function ActivityDrawer({ open, onClose, attempt, log, runActive, filters, onFiltersChange, onShowReviews, onShowDocument, logsHref }: ActivityDrawerProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const openerRef = useRef<Element | null>(null)
  const [width, setWidth] = useState(loadWidth)
  const [top, setTop] = useState(60)
  const [following, setFollowing] = useState(true)
  const [raw, setRaw] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [seenCount, setSeenCount] = useState(0)

  const groups = useMemo(() => buildTimeline(log.events, runActive), [log.events, runActive])
  const visible = useMemo(() => filterTimeline(groups, filters), [groups, filters])
  const roleCounts = useMemo(() => {
    const counts: Partial<Record<ActivityRole, number>> = {}
    for (const group of groups) counts[group.role] = (counts[group.role] ?? 0) + group.eventCount
    return counts
  }, [groups])
  const filtering = filters.role !== 'all' || filters.type !== 'all' || filters.errorsOnly || filters.search.trim() !== ''

  // Focus management: remember the opener, focus the title, restore on close.
  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement
    headingRef.current?.focus()
    return () => {
      const opener = openerRef.current
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [open])

  // Sit below the sticky project header on desktop.
  useEffect(() => {
    if (!open) return
    const measure = (): void => {
      const header = document.querySelector('.stage-project-header')
      setTop(header === null ? 0 : Math.max(0, Math.round(header.getBoundingClientRect().bottom)))
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, { passive: true })
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure)
    }
  }, [open])

  // Follow live: keep the newest event in view unless the user scrolled up.
  useLayoutEffect(() => {
    if (!open) return
    const box = scrollRef.current
    if (box === null) return
    if (following) {
      box.scrollTop = box.scrollHeight
      setSeenCount(log.events.length)
    }
  }, [open, following, log.events.length, visible])

  const onScroll = (): void => {
    const box = scrollRef.current
    if (box === null) return
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 32
    if (atBottom !== following) setFollowing(atBottom)
    if (atBottom) setSeenCount(log.events.length)
  }

  const jumpToLatest = (moveFocus = false): void => {
    setFollowing(true)
    const box = scrollRef.current
    if (box === null) return
    box.scrollTop = box.scrollHeight
    // The jump button disappears once following; keep focus inside the drawer.
    if (moveFocus) box.focus({ preventScroll: true })
  }

  // Esc closes from anywhere while the drawer is open (focus may have left it,
  // e.g. after a control unmounts). Ignored when something else handled it.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!open) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('.modal-overlay, [aria-modal="true"]') !== null) return
      event.preventDefault()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // Resize from the left edge (pointer or arrow keys).
  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent): void => {
      setWidth(Math.min(maxWidth(), Math.max(MIN_WIDTH, window.innerWidth - moveEvent.clientX)))
    }
    const up = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      setWidth((current) => {
        saveWidth(current)
        return current
      })
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }
  const resizeKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 80 : 24
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = width + step
    if (event.key === 'ArrowRight') next = width - step
    if (next === null) return
    event.preventDefault()
    const clamped = Math.min(maxWidth(), Math.max(MIN_WIDTH, next))
    setWidth(clamped)
    saveWidth(clamped)
  }

  const toggleGroup = useCallback((key: string, isOpen: boolean) => {
    setCollapsed((current) => ({ ...current, [key]: isOpen }))
  }, [])

  const unseen = Math.max(0, log.events.length - seenCount)
  const errorView = log.error === null ? null : describeStageError(log.error)

  return (
    <aside
      ref={panelRef}
      id="run-activity"
      className="activity-drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      hidden={!open}
      style={{ width: `${width}px`, top: `${top}px` }}
    >
      <div
        className="activity-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize activity panel"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={960}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={resizeKey}
      />
      <header className="activity-head">
        <div className="activity-head-title">
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>Activity</h2>
          <span className="activity-head-sub">Attempt {attempt} · {pluralize(log.events.length, 'event')}</span>
        </div>
        <ConnectionBadge connection={log.connection} />
        <a className="button button-ghost button-sm" href={logsHref} title="Open this run in the project log viewer">
          <ListIcon size={13} /> View in logs
        </a>
        <button type="button" className="icon-button" aria-label="Close activity" title="Close (Esc)" onClick={onClose}>
          <CloseIcon size={16} />
        </button>
      </header>

      <div className="activity-filters" role="group" aria-label="Activity filters">
        <div className="activity-roles" role="radiogroup" aria-label="Role">
          {(['all', ...ACTIVITY_ROLES] as const).map((role) => {
            const count = role === 'all' ? log.events.length : roleCounts[role] ?? 0
            return (
              <button
                key={role}
                type="button"
                role="radio"
                aria-checked={filters.role === role}
                className="activity-role-chip"
                data-role={role}
                onClick={() => onFiltersChange({ ...filters, role })}
              >
                {role === 'all' ? 'All' : ROLE_LABEL[role]}
                <span className="activity-role-count">{count}</span>
              </button>
            )
          })}
        </div>
        <div className="activity-filter-row">
          <label className="activity-select">
            <span className="sr-only">Event type</span>
            <select value={filters.type} onChange={(event) => onFiltersChange({ ...filters, type: event.target.value as ActivityFilters['type'] })}>
              {TYPE_FILTERS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          </label>
          <input
            type="search"
            className="activity-search"
            placeholder="Search text, tools, commands"
            aria-label="Search activity"
            value={filters.search}
            maxLength={200}
            onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
          />
        </div>
        <div className="activity-filter-row activity-toggles">
          <label className="activity-toggle">
            <input type="checkbox" checked={filters.errorsOnly} onChange={(event) => onFiltersChange({ ...filters, errorsOnly: event.target.checked })} />
            Errors only
          </label>
          <label className="activity-toggle">
            <input type="checkbox" checked={following} onChange={(event) => (event.target.checked ? jumpToLatest(false) : setFollowing(false))} />
            Follow live
          </label>
          <label className="activity-toggle" title="Operator view: show the raw event JSON">
            <input type="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} />
            Raw events
          </label>
          {filtering && (
            <button type="button" className="text-button" onClick={() => onFiltersChange({ role: 'all', type: 'all', errorsOnly: false, search: '' })}>
              Clear filters
            </button>
          )}
        </div>
      </div>

      {errorView !== null && log.connection === 'error' && (
        <StageNotice
          tone={errorView.kind === 'unauthorized' || errorView.kind === 'not-found' ? 'error' : 'warning'}
          error={{
            title: errorView.kind === 'disabled' ? 'Event streaming is disabled' : errorView.kind === 'not-found' ? 'Stage run not found' : errorView.kind === 'unauthorized' ? errorView.title : 'Live detail stream failed',
            message: errorView.kind === 'unauthorized' || errorView.kind === 'not-found' || errorView.kind === 'disabled' ? errorView.message : 'Showing the events received so far.',
          }}
          {...(errorView.kind === 'unauthorized' || errorView.kind === 'not-found' ? {} : { onRetry: log.reconnect })}
        />
      )}
      {log.trimmed && <p className="activity-note">Older events were trimmed to keep the page responsive; showing the newest {log.events.length}.</p>}
      {log.malformed > 0 && <p className="activity-note">{pluralize(log.malformed, 'malformed event')} skipped.</p>}

      <div className="activity-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={0} aria-label="Activity timeline">
        {log.events.length === 0 ? (
          <p className="activity-empty">
            {log.connection === 'connecting' ? 'Loading activity…'
              : log.connection === 'ended' ? 'No events were recorded for this run. Runs created before the activity log existed have no history.'
                : 'No events yet. The run will write its first event when execution starts.'}
          </p>
        ) : visible.length === 0 ? (
          <p className="activity-empty">No events match these filters.</p>
        ) : (
          <ol className="activity-groups">
            {visible.map((group) => (
              <ActivityGroupView
                key={group.key}
                group={group}
                open={collapsed[group.key] ?? true}
                onToggle={toggleGroup}
                raw={raw}
                onShowReviews={onShowReviews}
                onShowDocument={onShowDocument}
              />
            ))}
          </ol>
        )}
      </div>

      {!following && (
        <button type="button" className="button activity-jump" onClick={() => jumpToLatest(true)}>
          Jump to latest{unseen > 0 ? ` (${unseen} new)` : ''}
        </button>
      )}
      <p className="sr-only" aria-live="polite">{open ? log.announcement : ''}</p>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Groups and rows

const GROUP_STATE_LABEL = { running: 'running', done: 'done', failed: 'failed', stopped: 'stopped' } as const

function ActivityGroupView({
  group,
  open,
  onToggle,
  raw,
  onShowReviews,
  onShowDocument,
}: {
  group: ActivityGroup
  open: boolean
  onToggle: (key: string, open: boolean) => void
  raw: boolean
  onShowReviews: () => void
  onShowDocument: () => void
}) {
  const bodyId = useId()
  const title = group.role === 'run' ? 'Run' : `${ROLE_LABEL[group.role]}${group.pass > 1 ? ` · pass ${group.pass}` : ''}`
  return (
    <li className="activity-group" data-role={group.role} data-state={group.state}>
      <h3 className="activity-group-head">
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => onToggle(group.key, !open)}>
          {open ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
          <span className="activity-group-dot" aria-hidden="true" />
          <span className="activity-group-title">{title}</span>
          {group.role !== 'run' && <span className="activity-group-state">{GROUP_STATE_LABEL[group.state]}</span>}
          <span className="activity-group-meta">
            <time dateTime={group.startedAt} title={group.startedAt === '' ? undefined : `${formatFullDate(group.startedAt)} ${clockTime(group.startedAt)}`}>{clockTime(group.startedAt)}</time>
            {group.durationMs !== null && <span className="activity-badge">{shortDuration(group.durationMs)}</span>}
            <span>{pluralize(group.eventCount, 'event')}</span>
            {group.errorCount > 0 && <span className="activity-badge" data-tone="error">{pluralize(group.errorCount, 'error')}</span>}
          </span>
        </button>
      </h3>
      <div id={bodyId} hidden={!open}>
        {raw && group.hidden.length > 0 && <RawEvents events={group.hidden} label={`${pluralize(group.hidden.length, 'lifecycle/session event')} (raw)`} />}
        {group.rows.length === 0 ? (
          <p className="activity-row-empty">{group.state === 'running' ? 'Started — waiting for the first model event…' : 'No model events.'}</p>
        ) : (
          <ol className="activity-rows">
            {group.rows.map((row) => (
              <ActivityRowView key={row.key} row={row} raw={raw} onShowReviews={onShowReviews} onShowDocument={onShowDocument} />
            ))}
          </ol>
        )}
      </div>
    </li>
  )
}

const ROW_LABEL: Record<ActivityRow['kind'], string> = {
  status: 'status',
  thinking: 'thinking',
  text: 'text',
  tool: 'tool',
  final: 'final',
  error: 'error',
  review: 'review',
  document: 'document',
  decision: 'decision',
  other: 'event',
}

const TEXT_PREVIEW = 600
const OUTPUT_CAP = 4000

function ActivityRowView({ row, raw, onShowReviews, onShowDocument }: { row: ActivityRow; raw: boolean; onShowReviews: () => void; onShowDocument: () => void }) {
  const error = row.kind === 'error' || (row.kind === 'tool' && row.result?.isError === true)
  return (
    <li className="activity-row" data-kind={row.kind} data-error={error || undefined}>
      <time className="activity-time" dateTime={row.createdAt}>{clockTime(row.createdAt)}</time>
      <span className="activity-type">{ROW_LABEL[row.kind]}</span>
      <div className="activity-body">
        <RowBody row={row} onShowReviews={onShowReviews} onShowDocument={onShowDocument} />
        {raw && <RawEvents events={row.events} label="Raw event" />}
      </div>
    </li>
  )
}

function RowBody({ row, onShowReviews, onShowDocument }: { row: ActivityRow; onShowReviews: () => void; onShowDocument: () => void }) {
  switch (row.kind) {
    case 'status':
      return <span className="activity-muted">{row.text}{row.count > 1 ? ` (${row.count} updates)` : ''}</span>
    case 'thinking':
      return (
        <details className="activity-thinking">
          <summary>Reasoning (may be summarized)</summary>
          <p className="activity-pre">{row.text}</p>
        </details>
      )
    case 'text':
      return <LongText text={row.text} />
    case 'tool':
      return <ToolBody row={row} />
    case 'final':
      return <span className="activity-muted">{row.text}</span>
    case 'error':
      return <span className="activity-error-text">{row.text}</span>
    case 'review':
      return (
        <span className="activity-inline">
          <span className="chip review-chip" data-decision={row.decision}>{row.decision.replace(/_/g, ' ')}</span>
          <span>{pluralize(row.findingCount, 'finding')}</span>
          <button type="button" className="text-button" onClick={onShowReviews}>View findings</button>
        </span>
      )
    case 'document':
      return (
        <span className="activity-inline activity-wrap">
          <span>{row.documentKind === 'telos_report' ? 'TELOS report saved' : `${row.documentKind} saved`}</span>
          {row.storagePath !== '' && <code className="activity-path">{row.storagePath}</code>}
          <button type="button" className="text-button" onClick={onShowDocument}>Open report</button>
        </span>
      )
    case 'decision':
      return (
        <span className="activity-inline activity-wrap">
          <strong>Decision: {row.decision.replace(/_/g, '-')}</strong>
          {row.note !== '' && <span className="activity-muted">{row.note}</span>}
        </span>
      )
    case 'other':
      return (
        <details>
          <summary><code>{row.type}</code></summary>
          <pre className="activity-code">{row.text}</pre>
        </details>
      )
  }
}

function LongText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > TEXT_PREVIEW
  return (
    <div className="activity-text">
      <p className="activity-pre">{long && !expanded ? `${text.slice(0, TEXT_PREVIEW).trimEnd()}…` : text}</p>
      {long && (
        <button type="button" className="text-button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : `Expand (${text.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  )
}

function ToolBody({ row }: { row: Extract<ActivityRow, { kind: 'tool' }> }) {
  const result = row.result
  const output = result === null ? '' : result.output
  const truncated = output.length > OUTPUT_CAP
  return (
    <div className="activity-tool">
      <span className="activity-inline">
        <code className="activity-tool-name">{row.tool}</code>
        {result !== null && (
          <span className="activity-badge" data-tone={result.isError ? 'error' : 'ok'}>{result.isError ? '✕ ' : '✓ '}{result.status}</span>
        )}
        {result === null && row.input !== '' && <span className="activity-muted">running…</span>}
      </span>
      {row.command !== null ? (
        <div className="activity-command">
          <pre className="activity-code"><span aria-hidden="true">$ </span>{row.command}</pre>
          <CopyButton value={row.command} label="command" />
        </div>
      ) : row.input !== '' && row.input !== '{}' ? (
        <details>
          <summary>Input</summary>
          <pre className="activity-code">{row.input}</pre>
        </details>
      ) : null}
      {result !== null && output !== '' && (
        <details className="activity-output">
          <summary>{result.isError ? 'Error output' : 'Output'} <span className="activity-muted">({output.length.toLocaleString()} chars{truncated ? ', truncated' : ''})</span></summary>
          <pre className="activity-code activity-output-body">{truncated ? `${output.slice(0, OUTPUT_CAP)}\n…` : output}</pre>
        </details>
      )}
    </div>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="icon-button activity-copy"
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
  )
}

function RawEvents({ events, label }: { events: StageRunEvent[]; label: string }) {
  return (
    <details className="activity-raw">
      <summary>{label}</summary>
      <pre className="activity-code">{redactSecrets(JSON.stringify(events.length === 1 ? events[0] : events, null, 2))}</pre>
    </details>
  )
}

