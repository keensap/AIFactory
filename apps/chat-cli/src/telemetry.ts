/**
 * Live run telemetry for the status bar: turns, steps, throughput, tokens,
 * cache-hit and context usage.
 *
 * Everything here is derived from the harness event stream, which already
 * reports `status` events with `turn`, `step`, `phase` and `usage`. One folder
 * serves every consumer — the chat SSE stream, the stage-run SSE stream and the
 * stored-history endpoint — so the numbers shown live and the numbers shown
 * later cannot disagree.
 *
 * Two conventions inherited from the model layer (§ usage normalization):
 *  - `inputTokens` EXCLUDES cached tokens, so prompt size is
 *    input + cacheRead + cacheWrite and the cache-hit ratio is cacheRead over
 *    that same prompt total;
 *  - a step that reports no usage is still counted as a step, but contributes
 *    nothing to tokens or throughput.
 *
 * Every derived figure is `null` when it cannot be computed, never 0, so the UI
 * can render "—" instead of a misleading zero.
 */

export interface TelemetryUsage {
  input: number
  output: number
  total: number
  cacheRead: number
  cacheWrite: number
}

export interface TelemetryStep {
  input: number
  output: number
  total: number
  cacheRead: number
  cacheWrite: number
  /** Wall-clock time from this step's start event to its end event. */
  durationMs: number | null
  /** Output tokens per second for this step. */
  tokensPerSecond: number | null
}

export interface TelemetryModel {
  provider: string
  model: string
}

export interface RunTelemetry {
  /** Highest turn number seen; 0 before the first turn starts. */
  turns: number
  /** Number of completed steps (steps that emitted `step_end`). */
  steps: number
  /** Phase of the last status event seen (`step_end`, `turn_end`, …). */
  phase: string | null
  /** Cumulative usage across the whole run. */
  usage: TelemetryUsage
  /** Usage and throughput of the most recent step that reported usage. */
  lastStep: TelemetryStep | null
  /** Output tokens per second of the last step; what the status bar shows live. */
  tokensPerSecond: number | null
  /** Whole-run output tokens per second across all timed steps. */
  averageTokensPerSecond: number | null
  /** Percentage of prompt tokens served from cache (0–100), or null with no prompt. */
  cacheHitPercent: number | null
  /** Prompt tokens of the last step: input + cache read + cache write. */
  contextUsedTokens: number | null
  /** The resolved model's context window, when known. */
  contextWindow: number | null
  /** contextUsedTokens as a percentage of contextWindow (0–100). */
  contextUsedPercent: number | null
  /** Provider/model that produced the run, when known. */
  model: TelemetryModel | null
  /** First and last event times in this folder's input, as ISO timestamps. */
  startedAt: string | null
  updatedAt: string | null
}

export function emptyTelemetry(): RunTelemetry {
  return {
    turns: 0,
    steps: 0,
    phase: null,
    usage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    lastStep: null,
    tokensPerSecond: null,
    averageTokensPerSecond: null,
    cacheHitPercent: null,
    contextUsedTokens: null,
    contextWindow: null,
    contextUsedPercent: null,
    model: null,
    startedAt: null,
    updatedAt: null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A non-negative integer from an unknown value; anything else is 0. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals
  return Math.round(value * scale) / scale
}

/** `part / whole` as a 0–100 percentage, or null when the whole is 0. */
export function percentOf(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null
  return round(Math.min(100, Math.max(0, (part / whole) * 100)), 1)
}

function readUsage(value: unknown): TelemetryUsage | null {
  if (!isRecord(value)) return null
  const input = count(value.inputTokens)
  const output = count(value.outputTokens)
  const cacheRead = count(value.cacheReadTokens)
  const cacheWrite = count(value.cacheWriteTokens)
  const reported = count(value.totalTokens)
  const total = reported > 0 ? reported : input + output + cacheRead + cacheWrite
  if (input === 0 && output === 0 && total === 0 && cacheRead === 0 && cacheWrite === 0) return null
  return { input, output, total, cacheRead, cacheWrite }
}

function readModel(value: unknown): TelemetryModel | null {
  if (!isRecord(value)) return null
  const provider = typeof value.provider === 'string' ? value.provider : ''
  const model = typeof value.model === 'string' ? value.model : ''
  return provider !== '' && model !== '' ? { provider, model } : null
}

function addUsage(target: TelemetryUsage, source: TelemetryUsage): void {
  target.input += source.input
  target.output += source.output
  target.total += source.total
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
}

/**
 * Folds harness events into a telemetry snapshot.
 *
 * Incremental and cheap: feed it every event as it arrives and call
 * `snapshot()` whenever the status bar needs to redraw. It never mutates its
 * input and never throws on a malformed event.
 */
export class RunTelemetryFolder {
  private turns = 0
  private steps = 0
  private phase: string | null = null
  private usage: TelemetryUsage = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 }
  private lastStep: TelemetryStep | null = null
  private model: TelemetryModel | null = null
  private contextWindow: number | null = null
  private startedAtMs: number | null = null
  private updatedAtMs: number | null = null
  /** Start time of the open step, keyed `turn:step`. */
  private readonly stepStarts = new Map<string, number>()
  private timedOutput = 0
  private timedDurationMs = 0

  constructor(seed?: { model?: TelemetryModel | null; contextWindow?: number | null }) {
    if (seed?.model !== undefined && seed.model !== null) this.model = seed.model
    if (seed?.contextWindow !== undefined && seed.contextWindow !== null && seed.contextWindow > 0) {
      this.contextWindow = seed.contextWindow
    }
  }

  /**
   * Add one event observed at `atMs`.
   * Returns true when the event changed something a status bar would show.
   */
  add(event: unknown, atMs: number = Date.now()): boolean {
    if (!isRecord(event)) return false
    const at = Number.isFinite(atMs) ? atMs : Date.now()
    this.startedAtMs ??= at
    this.updatedAtMs = at

    const eventModel = readModel(event.model)
    if (eventModel !== null) this.model = eventModel
    const window = count((event as { contextWindow?: unknown }).contextWindow)
    if (window > 0) this.contextWindow = window

    // Real stage events store the whole harness event (which carries `type`),
    // but tolerate a payload that only has a phase rather than losing telemetry.
    const isStatus = event.type === 'status'
      || (event.type === undefined && typeof event.phase === 'string')
    if (!isStatus) return eventModel !== null || window > 0
    const phase = typeof event.phase === 'string' ? event.phase : null
    if (phase === null) return false
    this.phase = phase

    const turn = count(event.turn)
    if (turn > this.turns) this.turns = turn
    const step = count(event.step)

    if (phase === 'step_start') {
      this.stepStarts.set(`${turn}:${step}`, at)
      return true
    }

    if (phase !== 'step_end') return true

    this.steps += 1
    if (this.turns === 0) this.turns = 1 // a step implies at least one turn

    const usage = readUsage(event.usage)
    if (usage === null) return true

    addUsage(this.usage, usage)
    const key = `${turn}:${step}`
    const startedAt = this.stepStarts.get(key)
    this.stepStarts.delete(key)
    const durationMs = startedAt === undefined || at < startedAt ? null : at - startedAt
    const tokensPerSecond = durationMs !== null && durationMs > 0 ? round(usage.output / (durationMs / 1000), 1) : null
    this.lastStep = { ...usage, durationMs, tokensPerSecond }
    if (durationMs !== null && durationMs > 0) {
      this.timedOutput += usage.output
      this.timedDurationMs += durationMs
    }
    return true
  }

  snapshot(): RunTelemetry {
    const promptTokens = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite
    const contextUsedTokens = this.lastStep === null
      ? null
      : this.lastStep.input + this.lastStep.cacheRead + this.lastStep.cacheWrite
    return {
      turns: this.turns,
      steps: this.steps,
      phase: this.phase,
      usage: { ...this.usage },
      lastStep: this.lastStep === null ? null : { ...this.lastStep },
      tokensPerSecond: this.lastStep?.tokensPerSecond ?? null,
      averageTokensPerSecond: this.timedDurationMs > 0
        ? round(this.timedOutput / (this.timedDurationMs / 1000), 1)
        : null,
      cacheHitPercent: promptTokens > 0 ? percentOf(this.usage.cacheRead, promptTokens) : null,
      contextUsedTokens,
      contextWindow: this.contextWindow,
      contextUsedPercent: contextUsedTokens !== null && this.contextWindow !== null
        ? percentOf(contextUsedTokens, this.contextWindow)
        : null,
      model: this.model === null ? null : { ...this.model },
      startedAt: this.startedAtMs === null ? null : new Date(this.startedAtMs).toISOString(),
      updatedAt: this.updatedAtMs === null ? null : new Date(this.updatedAtMs).toISOString(),
    }
  }
}

/**
 * Fold a stored event list into a snapshot.
 *
 * `at` selects the timestamp: stored stage events carry `createdAt`; a live
 * event stream passes `Date.now()` instead.
 */
export function telemetryFromEvents(
  events: ReadonlyArray<{ payload?: unknown; createdAt?: string }>,
  seed?: { model?: TelemetryModel | null; contextWindow?: number | null },
): RunTelemetry {
  const folder = new RunTelemetryFolder(seed)
  for (const event of events) {
    const at = event.createdAt === undefined ? undefined : Date.parse(event.createdAt)
    folder.add(event.payload ?? event, at !== undefined && Number.isNaN(at) ? undefined : at)
  }
  return folder.snapshot()
}
