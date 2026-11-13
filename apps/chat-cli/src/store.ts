/**
 * Lightweight session registry for the HTTP API.
 *
 * The harness Session remains the canonical transcript. This store exists so a
 * UI can list conversations and render history without understanding the
 * harness session format. It is deliberately small: one JSON file, one writer,
 * no database.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  at: string
}

export interface ChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /** Registry project the session runs in; fixed at the first turn. */
  projectId?: string
  messages: ChatMessage[]
}

export interface SessionSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  projectId?: string
}

export class SessionBusyError extends Error {
  constructor(id: string) {
    super(`session ${id} already has a turn in progress`)
    this.name = 'SessionBusyError'
  }
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`session ${id} was not found`)
    this.name = 'SessionNotFoundError'
  }
}

export class SessionProjectMismatchError extends Error {
  constructor(id: string, projectId: string, boundProjectId: string) {
    super(`session ${id} belongs to project ${boundProjectId}, not ${projectId}`)
    this.name = 'SessionProjectMismatchError'
  }
}

interface StoreFile {
  version: 1
  sessions: ChatSession[]
}

export interface SessionStoreOptions {
  /** Directory for sessions.json. Omit for an in-memory store. */
  dataDir?: string
  /** Optional sink for load/persist warnings. */
  warn?: (message: string) => void
}

export class SessionStore {
  private readonly sessions = new Map<string, ChatSession>()
  private readonly active = new Set<string>()
  private readonly filePath?: string
  private readonly warn: (message: string) => void

  constructor(options: SessionStoreOptions = {}) {
    this.warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`))
    if (options.dataDir !== undefined) {
      mkdirSync(options.dataDir, { recursive: true })
      this.filePath = join(options.dataDir, 'sessions.json')
      this.load()
    }
  }

  list(filter: { projectId?: string } = {}): SessionSummary[] {
    return [...this.sessions.values()]
      .filter((session) => filter.projectId === undefined || session.projectId === filter.projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        ...(session.projectId !== undefined ? { projectId: session.projectId } : {}),
      }))
  }

  get(id: string): ChatSession | undefined {
    return this.sessions.get(id)
  }

  isBusy(id: string): boolean {
    return this.active.has(id)
  }

  /**
   * Reserve a session for one turn. The returned function is idempotent, so a
   * `finally` block can always call it.
   */
  acquire(id: string): () => void {
    if (this.active.has(id)) throw new SessionBusyError(id)
    this.active.add(id)
    let released = false
    return () => {
      if (released) return
      released = true
      this.active.delete(id)
    }
  }

  recordTurn(
    id: string,
    userText: string,
    assistantText: string,
    meta: { projectId?: string } = {},
  ): ChatSession {
    const now = new Date().toISOString()
    let session = this.sessions.get(id)
    if (session === undefined) {
      session = {
        id,
        title: titleFrom(userText),
        createdAt: now,
        updatedAt: now,
        ...(meta.projectId !== undefined ? { projectId: meta.projectId } : {}),
        messages: [],
      }
      this.sessions.set(id, session)
    } else if (meta.projectId !== undefined) {
      if (session.projectId !== undefined && session.projectId !== meta.projectId) {
        throw new SessionProjectMismatchError(id, meta.projectId, session.projectId)
      }
      session.projectId = meta.projectId
    }
    session.messages.push({ role: 'user', content: userText, at: now })
    session.messages.push({ role: 'assistant', content: assistantText, at: now })
    session.updatedAt = now
    this.persist()
    return session
  }

  /** Bind an existing, unbound session to a project. */
  bindProject(id: string, projectId: string): ChatSession {
    const session = this.sessions.get(id)
    if (session === undefined) throw new SessionNotFoundError(id)
    if (session.projectId !== undefined && session.projectId !== projectId) {
      throw new SessionProjectMismatchError(id, projectId, session.projectId)
    }
    if (session.projectId === undefined) {
      session.projectId = projectId
      this.persist()
    }
    return session
  }

  delete(id: string): boolean {
    if (this.active.has(id)) throw new SessionBusyError(id)
    const removed = this.sessions.delete(id)
    if (removed) this.persist()
    return removed
  }

  private load(): void {
    if (this.filePath === undefined || !existsSync(this.filePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreFile
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        throw new Error('unsupported sessions.json shape')
      }
      for (const session of parsed.sessions) {
        if (isSession(session)) this.sessions.set(session.id, session)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.warn(`warning: could not load ${this.filePath}: ${message}`)
    }
  }

  private persist(): void {
    if (this.filePath === undefined) return
    const payload: StoreFile = { version: 1, sessions: [...this.sessions.values()] }
    const temporary = `${this.filePath}.tmp`
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.filePath)
  }
}

function titleFrom(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return 'Untitled chat'
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}…` : collapsed
}

function isSession(value: unknown): value is ChatSession {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.title === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    && (record.projectId === undefined || typeof record.projectId === 'string')
    && Array.isArray(record.messages)
}
