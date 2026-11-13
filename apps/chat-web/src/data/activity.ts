/**
 * Pure view logic for the stage-run Activity drawer.
 *
 * Events come from `GET /api/stage-runs/:id/events[/stream]`. Their payloads are
 * untrusted model/tool output: everything here produces plain strings that the
 * UI renders as text (never HTML), after `redactSecrets`.
 */

import type { StageRunEvent } from '../api/types.ts'
import { compareEventIds, maxEventId } from '../api/stageEvents.ts'

export const MAX_EVENTS = 2000

export type ActivityRole = 'analyzer' | 'author' | 'reviewer' | 'run'
export const ACTIVITY_ROLES: ActivityRole[] = ['analyzer', 'author', 'reviewer', 'run']

/** Short role names for activity text ("Reviewer is running bash"). */
export const ROLE_LABEL: Record<ActivityRole, string> = {
  analyzer: 'Analyzer',
  author: 'Author',
  reviewer: 'Reviewer',
  run: 'Run',
}

export type ActivityTypeFilter = 'all' | 'model' | 'tools' | 'thinking' | 'reviews' | 'errors'
export const TYPE_FILTERS: { key: ActivityTypeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'model', label: 'Model' },
  { key: 'tools', label: 'Tools' },
  { key: 'thinking', label: 'Thinking' },
  { key: 'reviews', label: 'Reviews' },
  { key: 'errors', label: 'Errors' },
]

export interface ActivityFilters {
  role: ActivityRole | 'all'
  type: ActivityTypeFilter
  errorsOnly: boolean
  search: string
}

export const DEFAULT_FILTERS: ActivityFilters = { role: 'all', type: 'all', errorsOnly: false, search: '' }

// ---------------------------------------------------------------------------
// Ordering and merging

export { compareEventIds, maxEventId }

/**
 * Merge incoming events into an ordered list: dedupe by id (replays and
 * reconnects resend events), keep numeric order, keep the newest `cap`.
 */
export function mergeEvents(
  existing: readonly StageRunEvent[],
  incoming: readonly StageRunEvent[],
  cap = MAX_EVENTS,
): { events: StageRunEvent[]; trimmed: boolean } {
  if (incoming.length === 0) return { events: existing as StageRunEvent[], trimmed: false }
  const last = existing.at(-1)
  let merged: StageRunEvent[]
  // Fast path: strictly newer, already ordered events (the live-tail case).
  const ordered = incoming.every((event, index) => index === 0 || compareEventIds(incoming[index - 1]!.id, event.id) < 0)
  if (ordered && (last === undefined || compareEventIds(last.id, incoming[0]!.id) < 0)) {
    merged = [...existing, ...incoming]
  } else {
    const byId = new Map<string, StageRunEvent>()
    for (const event of existing) byId.set(event.id, event)
    for (const event of incoming) if (!byId.has(event.id)) byId.set(event.id, event)
    merged = [...byId.values()].sort((a, b) => compareEventIds(a.id, b.id))
  }
  if (merged.length <= cap) return { events: merged, trimmed: false }
  return { events: merged.slice(merged.length - cap), trimmed: true }
}

// ---------------------------------------------------------------------------
// Payload access (loose: DSH projection fields may grow or be missing)

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Any value as display text; objects become compact JSON. */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function eventRole(event: Pick<StageRunEvent, 'role' | 'payload'>): ActivityRole {
  const role = (event.role ?? str(event.payload.role) ?? '').toLowerCase()
  return role === 'analyzer' || role === 'author' || role === 'reviewer' ? role : 'run'
}

/** Tool name and input; supports the current (`tool`/`input`) and old (`name`/`arguments`) fields. */
export function toolCallInfo(payload: Record<string, unknown>): { tool: string; input: unknown; command: string | null; callId: string | null } {
  const tool = str(payload.tool) ?? str(payload.name) ?? 'tool'
  let input: unknown = payload.input !== undefined ? payload.input : payload.arguments
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input)
    } catch {
      // a plain string argument
    }
  }
  let command: string | null = null
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    command = str(record.command) ?? str(record.cmd) ?? str(record.script)
  } else if (typeof input === 'string' && /^(bash|shell|sh|exec|run)/i.test(tool)) {
    command = input
  }
  return { tool, input, command, callId: str(payload.callId) }
}

export function toolResultInfo(payload: Record<string, unknown>): { status: string; output: string; isError: boolean; callId: string | null } {
  const status = str(payload.status) ?? (payload.error !== undefined && payload.error !== null ? 'error' : 'ok')
  const error = payload.error === undefined || payload.error === null ? '' : asText(payload.error)
  const output = error !== '' ? error : asText(payload.result ?? payload.output ?? '')
  const isError = error !== '' || /^(error|failed|failure|denied|timeout)/i.test(status) || payload.isError === true
  return { status, output, isError, callId: str(payload.callId) }
}

/** Tokens from a DSH `usage` object, whatever its field names; null when absent. */
export function usageTokens(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null
  const record = usage as Record<string, unknown>
  const total = num(record.totalTokens) ?? num(record.total_tokens) ?? num(record.total)
  if (total !== null) return total
  const input = num(record.inputTokens) ?? num(record.input_tokens) ?? num(record.prompt_tokens) ?? 0
  const output = num(record.outputTokens) ?? num(record.output_tokens) ?? num(record.completion_tokens) ?? 0
  return input + output > 0 ? input + output : null
}

export function formatTokens(count: number): string {
  if (count < 1000) return `${count} tokens`
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k tokens`
}

/** "16s", "2m 05s", "1h 02m". */
export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function isErrorEvent(event: Pick<StageRunEvent, 'type' | 'payload'>): boolean {
  if (event.type === 'role_error' || event.type === 'error') return true
  if (event.type === 'tool_result') return toolResultInfo(event.payload).isError
  return false
}

// ---------------------------------------------------------------------------
// Redaction (defense in depth; the API does not redact yet)

const SECRET_PATTERNS: RegExp[] = [
  // key=value / key: value for secret-looking keys
  /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"'&,;]{4,})/gi,
  // Authorization: Bearer xxx
  /\b(bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
  // Common key prefixes: sk-…, ghp_…, xox…-, AKIA…
  /()\b((?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
]

/** Replace obvious secrets with `[redacted]`. Not a guarantee. */
export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (_match, prefix: string) => `${prefix}[redacted]`)
  return out
}

// ---------------------------------------------------------------------------
// Current activity line

/** One short line describing the latest meaningful event. */
export function currentActivity(events: readonly StageRunEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const line = activityLine(events[index]!)
    if (line !== null) return line
  }
  return 'Waiting for events…'
}

function activityLine(event: StageRunEvent): string | null {
  const role = ROLE_LABEL[eventRole(event)]
  const payload = event.payload
  switch (event.type) {
    case 'role_start':
      return `${role} started`
    case 'tool_call':
      return `${role} is running ${toolCallInfo(payload).tool}`
    case 'tool_result':
      return toolResultInfo(payload).isError ? `${role}’s ${str(payload.name) ?? 'tool'} call failed` : `${role} is reading tool output`
    case 'thinking':
      return `${role} is reasoning`
    case 'text':
      return eventRole(event) === 'author' ? 'Author is writing the TELOS' : `${role} is writing`
    case 'final':
      return `${role} finished its turn`
    case 'role_end': {
      const duration = num(payload.durationMs)
      return duration === null ? `${role} completed` : `${role} completed in ${shortDuration(duration)}`
    }
    case 'role_error':
    case 'error':
      return `${role} failed`
    case 'review_decision': {
      const decision = str(payload.decision)
      if (decision === 'approved') return 'Reviewer approved'
      if (decision === 'rejected') return 'Reviewer rejected the draft'
      return 'Reviewer requested changes'
    }
    case 'document_created':
      return 'TELOS report saved'
    case 'human_decision':
      return 'Decision recorded'
    default:
      return null // session, status and unknown types aren't "activity"
  }
}

// ---------------------------------------------------------------------------
// Timeline

export type ActivityRow =
  | { kind: 'status'; key: string; createdAt: string; text: string; count: number; events: StageRunEvent[] }
  | { kind: 'thinking'; key: string; createdAt: string; text: string; events: StageRunEvent[] }
  | { kind: 'text'; key: string; createdAt: string; text: string; events: StageRunEvent[] }
  | {
      kind: 'tool'
      key: string
      createdAt: string
      tool: string
      command: string | null
      input: string
      result: { status: string; output: string; isError: boolean } | null
      events: StageRunEvent[]
    }
  | { kind: 'final'; key: string; createdAt: string; text: string; events: StageRunEvent[] }
  | { kind: 'error'; key: string; createdAt: string; text: string; events: StageRunEvent[] }
  | { kind: 'review'; key: string; createdAt: string; decision: string; findingCount: number; events: StageRunEvent[] }
  | { kind: 'document'; key: string; createdAt: string; documentId: string | null; documentKind: string; storagePath: string; events: StageRunEvent[] }
  | { kind: 'decision'; key: string; createdAt: string; decision: string; note: string; events: StageRunEvent[] }
  | { kind: 'other'; key: string; createdAt: string; type: string; text: string; events: StageRunEvent[] }

export type GroupState = 'running' | 'done' | 'failed' | 'stopped'

export interface ActivityGroup {
  key: string
  role: ActivityRole
  /** 1 for the first time this role ran, 2 for the next (revisions)… */
  pass: number
  startedAt: string
  durationMs: number | null
  state: GroupState
  eventCount: number
  errorCount: number
  /** Events not shown as rows (session, role_start, role_end), for the raw view. */
  hidden: StageRunEvent[]
  rows: ActivityRow[]
}

function statusText(payload: Record<string, unknown>): string {
  const parts: string[] = []
  const step = num(payload.step)
  const turn = num(payload.turn)
  if (step !== null) parts.push(`step ${step}`)
  else if (turn !== null) parts.push(`turn ${turn}`)
  const phase = str(payload.phase)
  if (phase !== null && parts.length === 0) parts.push(phase.replace(/[_-]+/g, ' '))
  const tokens = usageTokens(payload.usage)
  if (tokens !== null) parts.push(formatTokens(tokens))
  return parts.join(' · ') || 'status'
}

function rowFor(event: StageRunEvent): ActivityRow | null {
  const base = { key: event.id, createdAt: event.createdAt, events: [event] }
  const payload = event.payload
  switch (event.type) {
    case 'session':
    case 'role_start':
    case 'role_end':
      return null // folded into the group header / raw view
    case 'status':
      return { ...base, kind: 'status', text: statusText(payload), count: 1 }
    case 'thinking':
      return { ...base, kind: 'thinking', text: redactSecrets(asText(payload.text)) }
    case 'text':
      return { ...base, kind: 'text', text: redactSecrets(asText(payload.text)) }
    case 'tool_call': {
      const info = toolCallInfo(payload)
      return {
        ...base,
        kind: 'tool',
        tool: info.tool,
        command: info.command === null ? null : redactSecrets(info.command),
        input: redactSecrets(asText(info.input)),
        result: null,
      }
    }
    case 'tool_result': {
      const info = toolResultInfo(payload)
      return {
        ...base,
        kind: 'tool',
        tool: str(payload.name) ?? 'tool',
        command: null,
        input: '',
        result: { status: info.status, output: redactSecrets(info.output), isError: info.isError },
      }
    }
    case 'final': {
      const reason = typeof payload.reason === 'object' && payload.reason !== null ? str((payload.reason as Record<string, unknown>).kind) : null
      return { ...base, kind: 'final', text: reason === null ? 'Turn finished' : `Turn finished (${reason.replace(/[_-]+/g, ' ')})` }
    }
    case 'role_error':
    case 'error':
      return { ...base, kind: 'error', text: redactSecrets(str(payload.message) ?? 'The role failed.') }
    case 'review_decision':
      return {
        ...base,
        kind: 'review',
        decision: str(payload.decision) ?? 'unknown',
        findingCount: Array.isArray(payload.findings) ? payload.findings.length : 0,
      }
    case 'document_created':
      return {
        ...base,
        kind: 'document',
        documentId: str(payload.documentId),
        documentKind: str(payload.kind) ?? 'document',
        storagePath: str(payload.storagePath) ?? '',
      }
    case 'human_decision':
      return { ...base, kind: 'decision', decision: str(payload.decision) ?? 'unknown', note: redactSecrets(str(payload.note) ?? '') }
    default:
      return { ...base, kind: 'other', type: event.type, text: redactSecrets(asText(payload)) }
  }
}

/**
 * Chronological role groups: a new group starts at each `role_start` or when
 * the role changes, so revisions show as "Author · pass 2" after the review.
 * `runActive` marks an unfinished last group as running rather than stopped.
 */
export function buildTimeline(events: readonly StageRunEvent[], runActive: boolean): ActivityGroup[] {
  const groups: ActivityGroup[] = []
  const passes = new Map<ActivityRole, number>()
  const toolRows = new Map<string, Extract<ActivityRow, { kind: 'tool' }>>()

  for (const event of events) {
    const role = eventRole(event)
    let group = groups.at(-1)
    if (group === undefined || group.role !== role || (event.type === 'role_start' && group.eventCount > 0)) {
      const pass = (passes.get(role) ?? 0) + 1
      passes.set(role, pass)
      group = {
        key: `${role}-${event.id}`,
        role,
        pass,
        startedAt: event.createdAt,
        durationMs: null,
        state: role === 'run' ? 'done' : 'running',
        eventCount: 0,
        errorCount: 0,
        hidden: [],
        rows: [],
      }
      groups.push(group)
      toolRows.clear()
    }
    group.eventCount += 1
    if (isErrorEvent(event)) group.errorCount += 1
    if (event.type === 'role_end') {
      group.durationMs = num(event.payload.durationMs)
      if (group.state !== 'failed') group.state = 'done'
    }
    if (event.type === 'role_error') {
      group.durationMs = num(event.payload.durationMs)
      group.state = 'failed'
    }

    const row = rowFor(event)
    if (row === null) {
      group.hidden.push(event)
      continue
    }
    const previous = group.rows.at(-1)
    // Collapse consecutive status markers into one (latest text wins).
    if (row.kind === 'status' && previous?.kind === 'status') {
      previous.text = row.text
      previous.count += 1
      previous.events.push(event)
      continue
    }
    // Attach a tool result to its call (by callId, else the latest open call).
    if (row.kind === 'tool' && row.result !== null) {
      const callId = str(event.payload.callId)
      const call = callId !== null ? toolRows.get(callId) : [...toolRows.values()].reverse().find((item) => item.result === null)
      if (call !== undefined && call.result === null) {
        call.result = row.result
        call.events.push(event)
        if (callId !== null) toolRows.delete(callId)
        continue
      }
    }
    if (row.kind === 'tool' && row.result === null) {
      toolRows.set(str(event.payload.callId) ?? `#${event.id}`, row)
    }
    group.rows.push(row)
  }

  // Groups that never ended: the last one may still be running.
  groups.forEach((group, index) => {
    if (group.role === 'run' || group.state !== 'running') return
    if (!(runActive && index === groups.length - 1)) group.state = 'stopped'
  })
  return groups
}

function rowCategory(row: ActivityRow): Exclude<ActivityTypeFilter, 'all' | 'errors'> | null {
  switch (row.kind) {
    case 'status':
    case 'text':
    case 'final':
      return 'model'
    case 'tool':
      return 'tools'
    case 'thinking':
      return 'thinking'
    case 'review':
    case 'document':
    case 'decision':
      return 'reviews'
    default:
      return null
  }
}

export function rowIsError(row: ActivityRow): boolean {
  return row.kind === 'error' || (row.kind === 'tool' && row.result?.isError === true)
}

function rowSearchText(row: ActivityRow): string {
  switch (row.kind) {
    case 'tool':
      return `${row.tool} ${row.command ?? ''} ${row.input} ${row.result?.output ?? ''}`
    case 'review':
      return `review ${row.decision}`
    case 'document':
      return `${row.documentKind} ${row.storagePath}`
    case 'decision':
      return `${row.decision} ${row.note}`
    case 'other':
      return `${row.type} ${row.text}`
    default:
      return row.text
  }
}

const SEARCH_CAP = 20_000

/** Apply role/type/error/search filters. Groups left empty are dropped when any filter is on. */
export function filterTimeline(groups: readonly ActivityGroup[], filters: ActivityFilters): ActivityGroup[] {
  const query = filters.search.trim().toLowerCase()
  const filtering = filters.type !== 'all' || filters.errorsOnly || query !== ''
  const out: ActivityGroup[] = []
  for (const group of groups) {
    if (filters.role !== 'all' && group.role !== filters.role) continue
    if (!filtering) {
      out.push(group)
      continue
    }
    const rows = group.rows.filter((row) => {
      if (filters.errorsOnly || filters.type === 'errors') {
        if (!rowIsError(row)) return false
      } else if (filters.type !== 'all' && rowCategory(row) !== filters.type) {
        return false
      }
      if (query !== '' && !rowSearchText(row).slice(0, SEARCH_CAP).toLowerCase().includes(query)) return false
      return true
    })
    if (rows.length > 0) out.push({ ...group, rows })
  }
  return out
}

/** Per-role totals for the pipeline step badges (real durations from role_end only). */
export function roleSummaries(groups: readonly ActivityGroup[]): Partial<Record<ActivityRole, { durationMs: number; passes: number; running: boolean; failed: boolean; events: number }>> {
  const out: Partial<Record<ActivityRole, { durationMs: number; passes: number; running: boolean; failed: boolean; events: number }>> = {}
  for (const group of groups) {
    const entry = out[group.role] ?? { durationMs: 0, passes: 0, running: false, failed: false, events: 0 }
    entry.durationMs += group.durationMs ?? 0
    entry.passes = Math.max(entry.passes, group.pass)
    entry.running = entry.running || group.state === 'running'
    entry.failed = entry.failed || group.state === 'failed'
    entry.events += group.eventCount
    out[group.role] = entry
  }
  return out
}

/** Text worth announcing to screen readers (not every event). */
export function announcement(event: StageRunEvent): string | null {
  switch (event.type) {
    case 'role_end':
    case 'role_error':
    case 'error':
    case 'review_decision':
    case 'document_created':
    case 'human_decision':
      return activityLine(event)
    default:
      return null
  }
}

/** "17:31:28" local time. */
export function clockTime(iso: string): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return ''
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(timestamp))
}
