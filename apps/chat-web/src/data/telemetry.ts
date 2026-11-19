/**
 * Run telemetry for the status bar. The API folds the event stream into one
 * snapshot; this module only COERCES and FORMATS it. Nothing here computes a
 * metric: a null field stays null and renders as "—", a real 0 renders "0".
 */

import type { RunTelemetry, TelemetryUsage } from '../api/types.ts'

export const NO_VALUE = '—'

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function usage(value: unknown): TelemetryUsage {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return {
    input: num(record.input),
    output: num(record.output),
    total: num(record.total),
    cacheRead: num(record.cacheRead),
    cacheWrite: num(record.cacheWrite),
  }
}

/** Coerce an untrusted payload into a snapshot; null when it isn't an object. */
export function normalizeTelemetry(raw: unknown): RunTelemetry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const lastStep = typeof record.lastStep === 'object' && record.lastStep !== null ? (record.lastStep as Record<string, unknown>) : null
  const model = typeof record.model === 'object' && record.model !== null ? (record.model as Record<string, unknown>) : null
  const modelName = model === null ? null : str(model.model)
  return {
    turns: num(record.turns),
    steps: num(record.steps),
    phase: str(record.phase),
    usage: usage(record.usage),
    lastStep: lastStep === null ? null : { ...usage(lastStep), durationMs: num(lastStep.durationMs), tokensPerSecond: num(lastStep.tokensPerSecond) },
    tokensPerSecond: num(record.tokensPerSecond),
    averageTokensPerSecond: num(record.averageTokensPerSecond),
    cacheHitPercent: num(record.cacheHitPercent),
    contextUsedTokens: num(record.contextUsedTokens),
    contextWindow: num(record.contextWindow),
    contextUsedPercent: num(record.contextUsedPercent),
    model: modelName === null ? null : { provider: str(model?.provider) ?? '', model: modelName },
    startedAt: str(record.startedAt),
    updatedAt: str(record.updatedAt),
  }
}

/** `950` · `5.5k` (one decimal below 10k) · `12k` · `1.2M`. */
export function formatTokens(count: number | null): string {
  if (count === null) return NO_VALUE
  if (count < 1000) return String(Math.round(count))
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** Integer, or one decimal below 10. */
export function formatRate(value: number | null): string {
  if (value === null) return NO_VALUE
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}

/** One decimal below 10, otherwise an integer; `%` appended. */
export function formatPercent(value: number | null): string {
  if (value === null) return NO_VALUE
  return `${value < 10 ? (Math.round(value * 10) / 10).toString() : Math.round(value).toString()}%`
}

export function formatCount(value: number | null): string {
  return value === null ? NO_VALUE : String(Math.round(value))
}

/** "provider/model" or the bare name; '' without a model. */
export function modelName(telemetry: RunTelemetry | null, short: boolean): string {
  const model = telemetry?.model ?? null
  if (model === null) return ''
  return short || model.provider === '' ? model.model : `${model.provider}/${model.model}`
}

export type ContextLevel = 'ok' | 'warn' | 'high'

/** Colour cue only: green < 60 %, amber 60–85 %, red above 85 %. */
export function contextLevel(percent: number | null): ContextLevel | null {
  if (percent === null) return null
  return percent > 85 ? 'high' : percent >= 60 ? 'warn' : 'ok'
}

/** Width of the context bar (a rendering of the API percent, clamped). */
export function meterWidth(percent: number | null): number {
  return percent === null ? 0 : Math.min(100, Math.max(0, percent))
}

export function contextTitle(telemetry: RunTelemetry | null): string {
  const used = telemetry?.contextUsedTokens ?? null
  const window = telemetry?.contextWindow ?? null
  const percent = telemetry?.contextUsedPercent ?? null
  if (used === null || window === null || percent === null) return 'Context window unknown'
  return `${used.toLocaleString('en-US')} of ${window.toLocaleString('en-US')} context tokens (${formatPercent(percent)})`
}

/** Full-detail tooltip for the whole bar. */
export function telemetryTitle(telemetry: RunTelemetry | null): string {
  if (telemetry === null) return 'No run telemetry yet'
  const { usage: u } = telemetry
  const lines = [
    `Turns ${formatCount(telemetry.turns)} · steps ${formatCount(telemetry.steps)}`,
    `Throughput ${formatRate(telemetry.tokensPerSecond)} tok/s (last step) · average ${formatRate(telemetry.averageTokensPerSecond)} tok/s`,
    `Tokens: input ${formatTokens(u.input)} · output ${formatTokens(u.output)} · cache read ${formatTokens(u.cacheRead)} · cache write ${formatTokens(u.cacheWrite)} · total ${formatTokens(u.total)}`,
    `Cache hit ${formatPercent(telemetry.cacheHitPercent)}`,
    contextTitle(telemetry),
  ]
  const name = modelName(telemetry, false)
  if (name !== '') lines.push(`Model ${name}`)
  return lines.join('\n')
}

/** Phase → "working" while a step is in flight; idle after a step/turn ends. */
export function phaseState(phase: string | null): 'working' | 'idle' | null {
  if (phase === null) return null
  return phase === 'step_start' || phase === 'turn_start' ? 'working' : 'idle'
}
