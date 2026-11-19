import type { ChecklistItem, ProjectDocument, RunStatus, StageState } from '../api/types.ts'
import type { StorageLike } from '../lib/storage.ts'

/**
 * Stage chat: every conversation belongs to one stage of one project. The Chat
 * API has no stage field on sessions yet, so the browser remembers which
 * sessions were opened for a stage, and the first message of a session carries
 * a compact, machine-readable context block that the transcript hides.
 */

const OPEN = '<stage-context>'
const CLOSE = '</stage-context>'

export interface StageContextInput {
  projectName: string
  stageKey: string
  stageLabel: string
  /** Status of the viewed stage. */
  stageStatus: string | null
  /** True when the stage is finished (the chat can discuss it, not change it). */
  readOnly: boolean
  run: { attempt: number; status: RunStatus; id: string } | null
  checklist: readonly ChecklistItem[]
  documents: readonly ProjectDocument[]
  /** All stages in pipeline order with their status, for a one-line history. */
  history: readonly { key: string; label: string; state: StageState | undefined }[]
}

/** Path the agent can use to read a document, relative to the API base. */
export function documentPath(document: Pick<ProjectDocument, 'projectId' | 'id'>): string {
  return `/api/projects/${encodeURIComponent(document.projectId)}/documents/${encodeURIComponent(document.id)}/content`
}

/** Compact context for a stage conversation. Kept short on purpose: links, not contents. */
export function buildStageContext(input: StageContextInput): string {
  const lines: string[] = [
    `Project: ${input.projectName}`,
    `Stage: ${input.stageLabel} (${input.stageKey})${input.stageStatus === null ? '' : `, status: ${input.stageStatus}`}${input.readOnly ? ', read-only (finished; answer questions, nothing can be changed here)' : ''}`,
  ]
  if (input.run !== null) lines.push(`Latest run: attempt ${input.run.attempt}, ${input.run.status} (id ${input.run.id})`)

  const required = input.checklist.filter((item) => item.required)
  if (required.length > 0) {
    const open = required.filter((item) => item.status === 'open').map((item) => item.label)
    lines.push(`Checklist: ${required.length - open.length}/${required.length} required done${open.length === 0 ? '' : `; open: ${open.slice(0, 6).join('; ')}`}`)
  }

  if (input.documents.length > 0) {
    lines.push('Documents of this stage (fetch with the bearer token if needed):')
    for (const document of input.documents.slice(0, 12)) {
      lines.push(`- ${document.title} v${document.version} [${document.status}] ${documentPath(document)}`)
    }
  }

  const history = input.history
    .filter((entry) => entry.state !== undefined && entry.state.status !== 'not_started')
    .map((entry) => `${entry.label}: ${entry.state?.status ?? ''}`)
  if (history.length > 0) lines.push(`Stage history: ${history.join(' | ')}`)

  return `${OPEN}\n${lines.join('\n')}\n${CLOSE}`
}

/** Prepends the context block to the user's text. */
export function withStageContext(context: string, text: string): string {
  return `${context}\n\n${text}`
}

/** Removes the context block from a stored user message so reloaded chats read cleanly. */
export function stripStageContext(text: string): string {
  if (!text.startsWith(OPEN)) return text
  const end = text.indexOf(CLOSE)
  if (end === -1) return text
  return text.slice(end + CLOSE.length).replace(/^\s+/, '')
}

// --- Which sessions belong to which stage (browser-side until the API tags them) ---

const KEY = 'aifactory.chat-web.stage-chats.v1'

type Store = Record<string, Record<string, string[]>>

function readStore(storage: StorageLike): Store {
  try {
    const raw = storage.getItem(KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Store : {}
  } catch {
    return {}
  }
}

export function loadStageChats(storage: StorageLike, projectId: string, stage: string): string[] {
  const list = readStore(storage)[projectId]?.[stage]
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []
}

export function saveStageChats(storage: StorageLike, projectId: string, stage: string, sessionIds: readonly string[]): void {
  try {
    const store = readStore(storage)
    store[projectId] = { ...(store[projectId] ?? {}), [stage]: [...new Set(sessionIds)] }
    storage.setItem(KEY, JSON.stringify(store))
  } catch {
    // Storage unavailable: tabs simply won't be remembered.
  }
}

/** Every session id already assigned to some stage of this project. */
export function assignedSessionIds(storage: StorageLike, projectId: string): Set<string> {
  return new Set(Object.values(readStore(storage)[projectId] ?? {}).flat())
}
