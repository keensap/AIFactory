import { useId } from 'react'
import type { ObservabilitySummary } from '../../api/types.ts'
import type { ObservabilityState } from '../../hooks/useObservability.ts'
import {
  WINDOW_OPTIONS, durationShare, errorRate, formatCount, formatLatency, hasTraces, sortRoles,
} from '../../data/observability.ts'
import { AlertIcon, ChevronRightIcon, RefreshIcon } from '../Icons.tsx'
import { Skeleton, TimeAgo } from '../stage/StageBits.tsx'

export interface ObservabilityCardProps {
  state: ObservabilityState
  hours: number
  collapsed: boolean
  onToggle: () => void
  onHoursChange: (hours: number) => void
  onRefresh: () => void
  /** Show only this role's logs. */
  onFilterRole: (role: string) => void
  /** Show only error logs. */
  onShowErrors: () => void
}

/**
 * Phoenix trace summary for the project (aggregates only: no prompts, outputs
 * or tool content). Degrades on its own: the log list never depends on it.
 */
export function ObservabilityCard({ state, hours, collapsed, onToggle, onHoursChange, onRefresh, onFilterRole, onShowErrors }: ObservabilityCardProps) {
  const bodyId = useId()
  const { summary } = state

  // Phoenix off / route missing: a single quiet line, no controls to fiddle with.
  if (state.status === 'disabled') {
    return (
      <div className="obs-card obs-card-quiet" role="note">
        <AlertIcon size={14} />
        <span>
          Trace summary is off. Phoenix observability is not enabled on this API
          {state.error?.status === 404 ? ' (or the API is older than the observability route).' : '.'}
        </span>
      </div>
    )
  }

  return (
    <section className="obs-card" aria-label="Trace summary (Phoenix)">
      <header className="obs-head">
        <button type="button" className="obs-toggle" aria-expanded={!collapsed} aria-controls={bodyId} onClick={onToggle}>
          <ChevronRightIcon size={14} className="obs-chevron" />
          <strong>Traces</strong>
          <span className="obs-sub">Phoenix</span>
        </button>
        {summary !== null && summary.projectName !== '' && <code className="obs-project" title="Phoenix project">{summary.projectName}</code>}
        {collapsed && summary !== null && hasTraces(summary) && (
          <span className="obs-inline">
            {formatCount(summary.spans)} spans · {summary.errors} error{summary.errors === 1 ? '' : 's'} · p95 {formatLatency(summary.latencyMs?.p95 ?? 0)}
          </span>
        )}
        <span className="obs-spacer" />
        <label className="obs-window">
          <span className="sr-only">Time window</span>
          <select aria-label="Trace window" value={hours} onChange={(event) => onHoursChange(Number(event.target.value))}>
            {WINDOW_OPTIONS.map((option) => <option key={option.hours} value={option.hours}>{option.label}</option>)}
          </select>
        </label>
        <button type="button" className="icon-button subtle" aria-label="Refresh trace summary" title="Refresh trace summary" onClick={onRefresh} disabled={state.refreshing}>
          <RefreshIcon size={14} className={state.refreshing ? 'obs-spin' : undefined} />
        </button>
      </header>

      {!collapsed && (
        <div className="obs-body" id={bodyId}>
          {state.status === 'loading' && <Skeleton lines={2} />}

          {state.status === 'error' && (
            <div className="obs-note" data-tone="error" role="alert">
              <AlertIcon size={15} />
              <span>{state.error?.status === 401 || state.error?.status === 403 ? 'A token is required to read the trace summary.' : 'Could not load the trace summary.'}</span>
              <button type="button" className="button button-ghost button-sm" onClick={onRefresh}>Retry</button>
            </div>
          )}

          {summary !== null && !summary.available && (
            <div className="obs-note" data-tone="warning" role="status">
              <AlertIcon size={15} />
              <span>Phoenix is not reachable{summary.reason !== null ? `: ${summary.reason}` : '.'} Logs are unaffected.</span>
              <button type="button" className="button button-ghost button-sm" onClick={onRefresh}>Retry</button>
            </div>
          )}

          {summary !== null && summary.available && !hasTraces(summary) && (
            <p className="obs-empty">No traces in the {windowLabel(hours)}. They appear when a stage run executes with Phoenix enabled.</p>
          )}

          {summary !== null && hasTraces(summary) && <Metrics summary={summary} onFilterRole={onFilterRole} onShowErrors={onShowErrors} />}

          {state.updatedAt !== null && summary !== null && summary.available && (
            <p className="obs-foot">
              {summary.lastSpanAt !== null && <><TimeAgo iso={summary.lastSpanAt} prefix="Last span" /> · </>}
              updated <time dateTime={new Date(state.updatedAt).toISOString()}>{new Date(state.updatedAt).toLocaleTimeString()}</time>
              {state.status === 'error' && ' · refresh failed, showing earlier data'}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function windowLabel(hours: number): string {
  return (WINDOW_OPTIONS.find((option) => option.hours === hours)?.label ?? `last ${hours} hours`).toLowerCase()
}

function Metrics({ summary, onFilterRole, onShowErrors }: { summary: ObservabilitySummary; onFilterRole: (role: string) => void; onShowErrors: () => void }) {
  const roles = sortRoles(summary.roles)
  const latency = summary.latencyMs
  const rate = errorRate(summary)
  return (
    <>
      <dl className="obs-stats">
        <Stat label="Traces" value={formatCount(summary.traces)} />
        <Stat label="Spans" value={formatCount(summary.spans)} />
        <div className="obs-stat" data-tone={summary.errors > 0 ? 'error' : undefined}>
          <dt>Errors</dt>
          <dd>
            {summary.errors > 0
              ? <button type="button" className="obs-link" onClick={onShowErrors} title="Show error logs">{formatCount(summary.errors)}</button>
              : '0'}
            {rate !== '' && <small>{rate}</small>}
          </dd>
        </div>
        <Stat label="Tool calls" value={formatCount(summary.tools)} />
        <Stat label="Tokens" value={formatCount(summary.tokens)} />
        {latency !== null && latency.count > 0 && (
          <>
            <Stat label="Latency p50" value={formatLatency(latency.p50)} />
            <Stat label="Latency p95" value={formatLatency(latency.p95)} />
            <Stat label="Slowest" value={formatLatency(latency.max)} />
          </>
        )}
      </dl>

      {roles.length > 0 && (
        <table className="obs-roles">
          <caption className="sr-only">Spans by role</caption>
          <thead>
            <tr><th scope="col">Role</th><th scope="col">Spans</th><th scope="col">Errors</th><th scope="col">Time</th><th scope="col">Tokens</th></tr>
          </thead>
          <tbody>
            {roles.map((role) => (
              <tr key={role.role}>
                <th scope="row"><button type="button" className="obs-link" onClick={() => onFilterRole(role.role)} title={`Show ${role.role} logs`}>{role.role}</button></th>
                <td>{formatCount(role.spans)}</td>
                <td data-tone={role.errors > 0 ? 'error' : undefined}>{role.errors}</td>
                <td>
                  <span className="obs-bar" aria-hidden="true"><span style={{ width: `${durationShare(role.durationMs, roles)}%` }} /></span>
                  {formatLatency(role.durationMs)}
                </td>
                <td>{formatCount(role.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {summary.truncated && <p className="obs-note-inline">Large window: only a sample of spans was read, so totals may be lower than actual.</p>}
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="obs-stat"><dt>{label}</dt><dd>{value}</dd></div>
}
