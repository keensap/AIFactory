import { useEffect, useState } from 'react'
import type { LogLevel, StageRun } from '../../api/types.ts'
import { LOG_LEVELS } from '../../api/types.ts'
import {
  DEFAULT_LOG_FILTERS, LEVEL_LABEL, LOG_ROLES, LOG_TYPES, activeFilterCount, type LogFilters,
} from '../../data/logs.ts'
import { CloseIcon, SearchIcon } from '../Icons.tsx'

const STAGES = ['planning', 'requirements', 'design', 'architecture', 'development', 'testing', 'deployment', 'maintenance']

export function LogToolbar({
  filters, onChange, runs, searchRef,
}: {
  filters: LogFilters
  onChange: (next: LogFilters) => void
  runs: StageRun[]
  searchRef: React.RefObject<HTMLInputElement>
}) {
  // Debounce typing so each keystroke doesn't hit the API.
  const [text, setText] = useState(filters.search)
  useEffect(() => setText(filters.search), [filters.search])
  useEffect(() => {
    if (text.trim() === filters.search.trim()) return
    const timer = window.setTimeout(() => onChange({ ...filters, search: text }), 300)
    return () => window.clearTimeout(timer)
  }, [text, filters, onChange])

  const set = (patch: Partial<LogFilters>): void => onChange({ ...filters, ...patch })
  const count = activeFilterCount(filters)
  const knownRun = filters.runId === '' || runs.some((run) => run.id === filters.runId)

  return (
    <div className="logs-toolbar" role="search" aria-label="Filter logs">
      <label className="logs-search">
        <SearchIcon size={15} />
        <input
          ref={searchRef}
          type="search"
          value={text}
          placeholder="Search message, type, payload…  ( / )"
          aria-label="Search logs"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') { setText(''); set({ search: '' }) } }}
        />
      </label>

      <div className="logs-levels" role="group" aria-label="Level">
        {(['', ...LOG_LEVELS] as const).map((level) => (
          <button
            key={level || 'all'}
            type="button"
            className="logs-level-chip"
            data-level={level || undefined}
            aria-pressed={filters.level === level}
            onClick={() => set({ level: level as LogLevel | '' })}
          >
            {level === '' ? 'All' : LEVEL_LABEL[level]}
          </button>
        ))}
      </div>

      <label className="logs-select">
        <span>Stage</span>
        <select aria-label="Stage" value={filters.stage} onChange={(event) => set({ stage: event.target.value, runId: '' })}>
          <option value="">All stages</option>
          {STAGES.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
        </select>
      </label>
      <label className="logs-select">
        <span>Run</span>
        <select aria-label="Run" value={filters.runId} onChange={(event) => set({ runId: event.target.value })}>
          <option value="">All runs</option>
          {!knownRun && <option value={filters.runId}>{filters.runId.slice(0, 8)}…</option>}
          {runs.map((run) => (
            <option key={run.id} value={run.id}>{`${run.stage} · attempt ${run.attempt} · ${run.status}`}</option>
          ))}
        </select>
      </label>
      <label className="logs-select">
        <span>Role</span>
        <select aria-label="Role" value={filters.role} onChange={(event) => set({ role: event.target.value })}>
          <option value="">All roles</option>
          {LOG_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
        </select>
      </label>
      <label className="logs-select">
        <span>Type</span>
        <select aria-label="Type" value={filters.type} onChange={(event) => set({ type: event.target.value })}>
          <option value="">All types</option>
          {LOG_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
      </label>

      {count > 0 && (
        <button type="button" className="button button-ghost button-sm" onClick={() => { setText(''); onChange(DEFAULT_LOG_FILTERS) }}>
          <CloseIcon size={13} /> Clear filters ({count})
        </button>
      )}
    </div>
  )
}
