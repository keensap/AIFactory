import type { ReactNode } from 'react'
import type { RunTelemetry } from '../api/types.ts'
import { formatCost, formatTokenCount, modelLabel } from '../data/statusbar.ts'
import { RunTelemetryBar } from './RunTelemetryBar.tsx'
import type { StatusBarData } from '../hooks/useStatusBarData.ts'

export interface StatusBarProps {
  data: StatusBarData
  /**
   * Run view: the API telemetry snapshot (null = no snapshot yet, shows "—").
   * Leave undefined on pages without a run (logs) to show project figures.
   */
  telemetry?: RunTelemetry | null
  /** The run's event stream failed: keep the last numbers but dim them. */
  stale?: boolean
  /** Short run description, e.g. "Reviewer · running". */
  runText?: string | null
  /** Reserved slots on either side of the centred run telemetry (run view only). */
  left?: ReactNode
  right?: ReactNode
}

/**
 * Bottom status bar. With a `telemetry` prop (run view) it shows the shared
 * run telemetry strip, every figure straight from the API. Without it (logs
 * page) it shows the project-level model, 30-day tokens and cost. Items
 * without data are left out (never "NaN" or a lie).
 */
export function StatusBar({ data, telemetry, stale = false, runText = null, left, right }: StatusBarProps) {
  if (telemetry !== undefined) {
    return (
      <footer className="status-bar status-bar-zoned" aria-label="Session status">
        {/* Left and right slots are reserved for later items. */}
        <div className="sb-slot sb-slot-left">{left}</div>
        <div className="sb-slot sb-slot-center">
          <RunTelemetryBar telemetry={telemetry} stale={stale} trailing={runText === null || runText === '' ? undefined : <span aria-live="polite">{runText}</span>} />
        </div>
        <div className="sb-slot sb-slot-right">{right}</div>
      </footer>
    )
  }
  const label = modelLabel(data.target, data.catalog)
  const usage = data.usage
  const cost = usage === null ? '' : formatCost(usage.costUsd, usage.costPartial)

  return (
    <footer className="status-bar" aria-label="Session status">
      {label !== '' && <span className="sb-item" title={data.target === null ? undefined : `${data.target.provider} / ${data.target.model}`}>Model <b>{label}</b></span>}
      {usage !== null && (
        <span className="sb-item" title={`Last 30 days · in ${formatTokenCount(usage.tokens.input)} · out ${formatTokenCount(usage.tokens.output)}`}>
          Tokens <b>{formatTokenCount(usage.tokens.total)}</b>
        </span>
      )}
      {cost !== '' && <span className="sb-item" title="Last 30 days">Cost <b>{cost}</b></span>}
      {label === '' && usage === null && <span className="sb-item sb-muted">No usage data yet</span>}
      <span className="sb-spacer" />
      {runText !== null && runText !== '' && <span className="sb-item" aria-live="polite">{runText}</span>}
    </footer>
  )
}
