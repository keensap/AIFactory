/**
 * Wire types for `dsh --profile headless --json`.
 *
 * The headless runner projects one durable agent run onto newline-delimited
 * JSON events. We keep the types deliberately loose: the projection is the
 * stable public surface, but individual fields may grow over time and a chat
 * client must not crash on an unknown event or an added field.
 */

export interface TurnReason {
  kind?: string
  [key: string]: unknown
}

export interface SessionEvent {
  type: 'session'
  sessionId: string
  cwd?: string
}

export interface StatusEvent {
  type: 'status'
  phase: 'turn_start' | 'step_start' | 'step_end' | 'turn_end' | string
  turn?: number
  step?: number
  reason?: TurnReason
  usage?: unknown
}

export interface TextEvent {
  type: 'text'
  text: string
}

export interface ThinkingEvent {
  type: 'thinking'
  text: string
}

export interface ToolCallEvent {
  type: 'tool_call'
  /** Current headless projection field. */
  tool?: string
  /** Current headless projection field. */
  input?: unknown
  /** Compatibility with older projections/clients. */
  name?: string
  arguments?: unknown
  callId?: string
}

export interface ToolResultEvent {
  type: 'tool_result'
  name?: string
  callId?: string
  status?: string
  result?: string
  error?: unknown
}

export interface FinalEvent {
  type: 'final'
  sessionId: string
  reason: TurnReason | null
  text: string
}

export interface ErrorEvent {
  type: 'error'
  message: string
  code?: string
}

export interface UnknownEvent {
  type: string
  [key: string]: unknown
}

export type HarnessEvent =
  | SessionEvent
  | StatusEvent
  | TextEvent
  | ThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | FinalEvent
  | ErrorEvent
  | UnknownEvent

/** Parse one NDJSON line, returning null for blank or malformed input. */
export function parseHarnessEvent(line: string): HarnessEvent | null {
  const trimmed = line.trim()
  if (trimmed === '') return null

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }

  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string' || record.type === '') return null
  return record as unknown as HarnessEvent
}

/** The terminal outcome kind reported by `final`, when present. */
export function reasonKind(reason: TurnReason | null | undefined): string | undefined {
  if (reason === null || reason === undefined) return undefined
  return typeof reason.kind === 'string' ? reason.kind : undefined
}
