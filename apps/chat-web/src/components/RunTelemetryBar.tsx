import type { ReactNode } from 'react'
import type { RunTelemetry } from '../api/types.ts'
import {
  NO_VALUE, contextLevel, contextTitle, formatCount, formatPercent, formatRate, formatTokens, meterWidth, modelName, phaseState,
  telemetryTitle,
} from '../data/telemetry.ts'

export interface RunTelemetryBarProps {
  /** Latest API snapshot; null renders "—" for every metric. */
  telemetry: RunTelemetry | null
  /** Stream failed: keep the last values but dim them. */
  stale?: boolean
  /** Render nothing until the first snapshot (chat). */
  hideUntilData?: boolean
  /** Extra content on the far right (e.g. run label). */
  trailing?: ReactNode
  className?: string
}

/**
 * Run telemetry strip shared by the chat and the stage run view. It only
 * displays API fields: null → "—", 0 → "0", nothing is derived here.
 */
export function RunTelemetryBar({ telemetry, stale = false, hideUntilData = false, trailing, className }: RunTelemetryBarProps) {
  if (telemetry === null && hideUntilData) return null
  const percent = telemetry?.contextUsedPercent ?? null
  const level = contextLevel(percent)
  const state = phaseState(telemetry?.phase ?? null)
  const full = modelName(telemetry, false)
  const short = modelName(telemetry, true)

  return (
    <div
      className={`run-telemetry${className === undefined ? '' : ` ${className}`}`}
      data-stale={stale || undefined}
      title={telemetryTitle(telemetry)}
      role="status"
      aria-label="Run telemetry"
    >
      <span className="rt-group">
        <span className="rt-dot" data-state={state ?? 'none'} aria-hidden="true" />
        <span className="rt-item rt-optional-1">turns <b className="rt-num">{formatCount(telemetry?.turns ?? null)}</b></span>
        <span className="rt-item rt-optional-1">steps <b className="rt-num">{formatCount(telemetry?.steps ?? null)}</b></span>
        <span className="rt-item"><b className="rt-num rt-num-rate">{formatRate(telemetry?.tokensPerSecond ?? null)}</b> tok/s</span>
        <span className="rt-item"><b className="rt-num">{formatTokens(telemetry?.usage.total ?? null)}</b> tokens</span>
      </span>
      <span className="rt-group rt-right">
        <span className="rt-item rt-optional-2">cache <b className="rt-num rt-num-pct">{formatPercent(telemetry?.cacheHitPercent ?? null)}</b></span>
        <span className="rt-item" title={contextTitle(telemetry)}>
          context <b className="rt-num rt-num-pct">{formatPercent(percent)}</b>
          <span
            className="rt-meter"
            data-level={level ?? undefined}
            role="meter"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(percent === null ? {} : { 'aria-valuenow': meterWidth(percent) })}
          >
            <i style={{ width: `${meterWidth(percent)}%` }} />
          </span>
        </span>
        {short !== '' && <span className="rt-item rt-model" title={full}>{short}</span>}
        {trailing !== undefined && trailing !== null && <span className="rt-item rt-trailing">{trailing}</span>}
      </span>
      {telemetry === null && <span className="sr-only">{NO_VALUE} no telemetry yet</span>}
    </div>
  )
}
