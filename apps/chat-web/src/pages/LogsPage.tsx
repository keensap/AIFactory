import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, isAbortError, type ChatApi } from '../api/client.ts'
import type { StageRun } from '../api/types.ts'
import { LogRow } from '../components/logs/LogRow.tsx'
import { LogToolbar } from '../components/logs/LogToolbar.tsx'
import { ObservabilityCard } from '../components/logs/ObservabilityCard.tsx'
import { healthLabel } from '../components/AppHeader.tsx'
import {
  ArrowDownIcon, ArrowLeftIcon, MoonIcon, RefreshIcon, SettingsIcon, SunIcon,
} from '../components/Icons.tsx'
import { Skeleton, StageNotice } from '../components/stage/StageBits.tsx'
import type { ApiHealthController } from '../hooks/useApiHealth.ts'
import { StatusBar } from '../components/StatusBar.tsx'
import { useStatusBarData } from '../hooks/useStatusBarData.ts'
import { useObservability } from '../hooks/useObservability.ts'
import { useProjectLogs } from '../hooks/useProjectLogs.ts'
import {
  activeFilterCount, filtersFromSearch, filtersToSearch, toCsv, toJsonl, DEFAULT_LOG_FILTERS, MAX_LOGS, type LogFilters,
} from '../data/logs.ts'
import type { Project } from '../data/projects.ts'
import { describeStageError } from '../data/stageErrors.ts'
import { DEFAULT_WINDOW_HOURS, normalizeWindow } from '../data/observability.ts'
import { copyText } from '../lib/clipboard.ts'
import { routeHref } from '../lib/router.ts'
import { readJson, writeJson, type StorageLike } from '../lib/storage.ts'

const PREFS_KEY = 'aifactory.chat-web.logs.v1'
interface LogsPrefs { obsCollapsed: boolean; obsHours: number }

export interface LogsPageProps {
  api: ChatApi
  storage: StorageLike
  project: Project
  /** Query string of the route, used once for the initial filters. */
  initialSearch: string
  health: ApiHealthController
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onOpenSettings: () => void
  onNotify: (message: string, tone?: 'info' | 'success' | 'error') => void
}

/**
 * Log viewer for ONE project. Every request goes to
 * `/api/projects/:id/logs` for this project only; the page is keyed by project
 * id in App, so switching projects remounts it and drops all state.
 */
export function LogsPage({ api, storage, project, initialSearch, health, theme, onToggleTheme, onOpenSettings, onNotify }: LogsPageProps) {
  const [filters, setFilters] = useState<LogFilters>(() => filtersFromSearch(initialSearch))
  const [atTop, setAtTop] = useState(true)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [redact, setRedact] = useState(true)
  const [runs, setRuns] = useState<StageRun[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const logs = useProjectLogs(api, project.id, filters, { atTop })

  // Trace summary (Phoenix). Its prefs are per browser, not per project.
  const [prefs, setPrefs] = useState<LogsPrefs>(() => {
    const saved = readJson<Partial<LogsPrefs>>(storage, PREFS_KEY, {})
    return { obsCollapsed: saved.obsCollapsed === true, obsHours: normalizeWindow(saved.obsHours ?? DEFAULT_WINDOW_HOURS) }
  })
  const updatePrefs = useCallback((patch: Partial<LogsPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch }
      writeJson(storage, PREFS_KEY, next)
      return next
    })
  }, [storage])
  const statusData = useStatusBarData(api, project.id)
  const observability = useObservability(api, project.id, prefs.obsHours, true)

  // A real navigation (pasted link, back/forward) to different filters: adopt them.
  // Our own URL updates use replaceState, which does not change the route.
  const lastRouteSearch = useRef(initialSearch)
  useEffect(() => {
    if (lastRouteSearch.current === initialSearch) return
    lastRouteSearch.current = initialSearch
    const next = filtersFromSearch(initialSearch)
    setFilters((current) => (filtersToSearch(current) === filtersToSearch(next) ? current : next))
    setExpanded(new Set())
  }, [initialSearch])

  // Keep the URL shareable without re-routing (replaceState fires no hashchange).
  useEffect(() => {
    const href = routeHref({ name: 'logs', projectId: project.id, search: filtersToSearch(filters) })
    if (window.location.hash !== href) window.history.replaceState(null, '', href)
  }, [filters, project.id])

  useEffect(() => { document.title = `Logs · ${project.name} — AI Factory Chat` }, [project.name])

  // Runs for the run filter: the selected stage, or planning (the only runnable stage).
  useEffect(() => {
    const controller = new AbortController()
    const stage = (filters.stage === '' ? 'planning' : filters.stage) as StageRun['stage']
    api.listStageRuns(project.id, stage, controller.signal)
      .then((list) => setRuns(list))
      .catch((error: unknown) => { if (!isAbortError(error)) setRuns([]) })
    return () => controller.abort()
  }, [api, project.id, filters.stage])

  // "/" focuses search (unless typing somewhere).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const changeFilters = useCallback((next: LogFilters) => {
    setFilters(next)
    setExpanded(new Set())
    scrollRef.current?.scrollTo({ top: 0 })
  }, [])

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const jumpToTop = (): void => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    logs.showPending()
  }

  const download = (kind: 'jsonl' | 'csv'): void => {
    const body = kind === 'jsonl' ? toJsonl(logs.logs, redact) : toCsv(logs.logs, redact)
    const blob = new Blob([body], { type: kind === 'jsonl' ? 'application/x-ndjson' : 'text/csv' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${project.name.replace(/[^\w.-]+/g, '-')}-logs.${kind}`
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const copyLink = (): void => {
    void copyText(`${window.location.origin}${window.location.pathname}${routeHref({ name: 'logs', projectId: project.id, search: filtersToSearch(filters) })}`)
      .then((ok) => onNotify(ok ? 'Link copied' : 'Could not copy the link', ok ? 'success' : 'error'))
  }

  const hasFilters = activeFilterCount(filters) > 0
  const errorView = useMemo(() => (logs.error === null ? null : describeLogsError(logs.error)), [logs.error])
  const stageHref = routeHref({ name: 'stage', projectId: project.id, stage: project.currentStage ?? 'planning', runId: null })

  return (
    <div className="stage-page logs-page">
      <header className="stage-project-header">
        <a className="back-link stage-back" href={stageHref} aria-label="Back to project" title="Back to project">
          <ArrowLeftIcon size={16} />
        </a>
        <div className="stage-project-id">
          <div className="stage-project-title">
            <h2>{project.name}</h2>
            <span className="chip stage-badge">Logs</span>
          </div>
        </div>
        <div className="stage-project-actions">
          <button type="button" className="health-pill" data-status={health.state.status} onClick={onOpenSettings} title={health.state.error ?? 'Connection settings'}>
            <span className="status-dot" aria-hidden="true" />
            {healthLabel(health.state)}
          </button>
          <button type="button" className="icon-button" aria-label="Settings" title="Settings" onClick={onOpenSettings}><SettingsIcon size={16} /></button>
          <button type="button" className="icon-button" onClick={onToggleTheme} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </button>
        </div>
      </header>

      <main className="logs-main">
        <LogToolbar filters={filters} onChange={changeFilters} runs={runs} searchRef={searchRef} />

        <ObservabilityCard
          state={observability}
          hours={prefs.obsHours}
          collapsed={prefs.obsCollapsed}
          onToggle={() => updatePrefs({ obsCollapsed: !prefs.obsCollapsed })}
          onHoursChange={(hours) => updatePrefs({ obsHours: hours })}
          onRefresh={observability.refresh}
          onFilterRole={(role) => changeFilters({ ...filters, role })}
          onShowErrors={() => changeFilters({ ...filters, level: 'error' })}
        />

        <div className="logs-statusbar">
          <span className="logs-live" data-state={logs.liveState}>
            <span className="status-dot" aria-hidden="true" />
            {{ live: 'Live', paused: 'Paused (tab hidden)', reconnecting: 'Reconnecting…', off: 'Live off' }[logs.liveState]}
          </span>
          <button
            type="button"
            className="button button-ghost button-sm"
            aria-pressed={logs.live}
            onClick={() => logs.setLive(!logs.live)}
          >
            {logs.live ? 'Pause live tail' : 'Resume live tail'}
          </button>
          <button type="button" className="button button-ghost button-sm" onClick={logs.refresh} disabled={logs.status === 'loading'}>
            <RefreshIcon size={13} /> Refresh
          </button>
          <span className="logs-count" aria-live="polite">
            {logs.status === 'ready' ? `${logs.logs.length.toLocaleString()} log${logs.logs.length === 1 ? '' : 's'}${logs.hasMore ? '+' : ''}` : ''}
          </span>
          <span className="logs-spacer" />
          <label className="logs-redact" title="Secrets such as API keys and tokens are masked in the viewer and in exports">
            <input type="checkbox" checked={redact} onChange={(event) => setRedact(event.target.checked)} /> Mask secrets
          </label>
          <button type="button" className="button button-ghost button-sm" onClick={copyLink}>Copy link</button>
          <button type="button" className="button button-ghost button-sm" disabled={logs.logs.length === 0} onClick={() => download('jsonl')}>Export JSONL</button>
          <button type="button" className="button button-ghost button-sm" disabled={logs.logs.length === 0} onClick={() => download('csv')}>Export CSV</button>
        </div>

        <div
          ref={scrollRef}
          className="logs-scroll"
          onScroll={(event) => setAtTop(event.currentTarget.scrollTop < 24)}
        >
          {logs.pending > 0 && !atTop && (
            <button type="button" className="logs-new-pill" onClick={jumpToTop} aria-live="polite">
              <ArrowDownIcon size={13} className="logs-new-arrow" /> {logs.pending} new log{logs.pending === 1 ? '' : 's'}
            </button>
          )}

          {logs.status === 'loading' && <div className="logs-state"><Skeleton lines={6} /></div>}

          {logs.status === 'error' && errorView !== null && (
            <div className="logs-state">
              <StageNotice error={errorView} onRetry={errorView.retryable ? logs.refresh : undefined} />
            </div>
          )}

          {logs.status === 'ready' && logs.logs.length === 0 && (
            <div className="logs-state logs-empty">
              <strong>{hasFilters ? 'No logs match these filters' : 'No logs yet'}</strong>
              <p>
                {hasFilters
                  ? 'Try a different level, run or search term.'
                  : 'Logs appear here when a stage run executes. Runs created before the event log existed have none.'}
              </p>
              {hasFilters && <button type="button" className="button button-sm" onClick={() => changeFilters(DEFAULT_LOG_FILTERS)}>Clear filters</button>}
            </div>
          )}

          {logs.status === 'ready' && logs.logs.length > 0 && (
            <ol className="log-list" aria-label={`Logs for ${project.name}, newest first`}>
              {logs.logs.map((log) => (
                <LogRow
                  key={log.id}
                  log={log}
                  expanded={expanded.has(log.id)}
                  onToggle={() => toggle(log.id)}
                  onFilterRun={(runId) => changeFilters({ ...filters, runId, stage: '' })}
                  redact={redact}
                  projectId={project.id}
                />
              ))}
            </ol>
          )}

          {logs.status === 'ready' && logs.logs.length > 0 && (
            <div className="logs-footer">
              {logs.moreError !== null && <span className="logs-footer-error" role="alert">{logs.moreError}</span>}
              {logs.hasMore && !logs.trimmed && (
                <button type="button" className="button button-sm" onClick={logs.loadOlder} disabled={logs.loadingMore}>
                  {logs.loadingMore ? 'Loading…' : 'Load older logs'}
                </button>
              )}
              {logs.trimmed && <span>Showing the newest {MAX_LOGS.toLocaleString()} logs. Narrow the filters to see older ones.</span>}
              {!logs.hasMore && !logs.trimmed && <span>End of logs</span>}
            </div>
          )}
        </div>
      </main>
      <StatusBar data={statusData} />
    </div>
  )
}

function describeLogsError(error: ApiError): { title: string; message: string; retryable: boolean } {
  if (error.status === 404 || error.status === 503) {
    return {
      title: 'Logs are not available',
      message: 'Project logs need the projects registry (PostgreSQL) and an API version that has the logs endpoint.',
      retryable: false,
    }
  }
  const view = describeStageError(error)
  return { title: error.status === 401 || error.status === 403 ? 'Token required' : view.title, message: view.message, retryable: view.retryable }
}
