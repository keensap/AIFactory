/**
 * Session ↔ project association.
 *
 * Newer Chat APIs bind a session to a registry project (`session.projectId`)
 * and that binding always wins. Sessions without one (local-placeholder mode,
 * chats started without a project, or older APIs) are filed through this
 * browser-local map; unmapped sessions fall back to the default project.
 */

import type { SessionSummary } from '../api/types.ts'
import { readJson, writeJson, type StorageLike } from '../lib/storage.ts'
import { DEFAULT_PROJECT_ID, type Project } from './projects.ts'

export type AssignmentMap = Record<string, string>

export const ASSIGNMENTS_KEY = 'aifactory.chat-web.assignments.v1'

export function loadAssignments(storage: StorageLike): AssignmentMap {
  const parsed = readJson<unknown>(storage, ASSIGNMENTS_KEY, {})
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const assignments: AssignmentMap = {}
  for (const [sessionId, projectId] of Object.entries(parsed)) {
    if (typeof projectId === 'string' && sessionId !== '') assignments[sessionId] = projectId
  }
  return assignments
}

export function saveAssignments(storage: StorageLike, assignments: AssignmentMap): void {
  writeJson(storage, ASSIGNMENTS_KEY, assignments)
}

/** The project a session belongs to: server binding first, then the local map. */
export function sessionProjectId(
  session: SessionSummary,
  assignments: AssignmentMap,
  known: ReadonlySet<string>,
): string | undefined {
  if (session.projectId !== undefined && known.has(session.projectId)) return session.projectId
  const assigned = assignments[session.id]
  return assigned !== undefined && known.has(assigned) ? assigned : undefined
}

export function assignSession(
  assignments: AssignmentMap,
  sessionId: string,
  projectId: string,
): AssignmentMap {
  if (assignments[sessionId] === projectId) return assignments
  return { ...assignments, [sessionId]: projectId }
}

export function removeAssignment(
  assignments: AssignmentMap,
  sessionId: string,
): AssignmentMap {
  if (!(sessionId in assignments)) return assignments
  const next = { ...assignments }
  delete next[sessionId]
  return next
}

/** Move every chat assigned to `from` onto `to` (used when deleting a project). */
export function reassignProject(
  assignments: AssignmentMap,
  from: string,
  to: string,
): AssignmentMap {
  let changed = false
  const next: AssignmentMap = {}
  for (const [sessionId, projectId] of Object.entries(assignments)) {
    if (projectId === from) {
      next[sessionId] = to
      changed = true
    } else {
      next[sessionId] = projectId
    }
  }
  return changed ? next : assignments
}

/**
 * File every known session into a real project. Existing valid assignments are
 * kept; missing or stale ones land on the fallback project.
 */
export function reconcileAssignments(
  sessions: readonly SessionSummary[],
  projects: readonly Project[],
  assignments: AssignmentMap,
  fallbackProjectId: string = DEFAULT_PROJECT_ID,
): { assignments: AssignmentMap; changed: boolean } {
  const known = new Set(projects.map((project) => project.id))
  const fallback = known.has(fallbackProjectId)
    ? fallbackProjectId
    : projects[0]?.id
  if (fallback === undefined) return { assignments, changed: false }

  let changed = false
  const next: AssignmentMap = {}
  for (const session of sessions) {
    const current = sessionProjectId(session, assignments, known)
    if (current !== undefined) {
      next[session.id] = current
      if (assignments[session.id] !== current) changed = true
    } else {
      next[session.id] = fallback
      changed = true
    }
  }
  // Drop assignments for sessions the server no longer knows about.
  if (Object.keys(next).length !== Object.keys(assignments).length) changed = true
  return { assignments: next, changed }
}

export function groupSessionsByProject(
  projects: readonly Project[],
  sessions: readonly SessionSummary[],
  assignments: AssignmentMap,
): Map<string, SessionSummary[]> {
  const groups = new Map<string, SessionSummary[]>()
  for (const project of projects) groups.set(project.id, [])
  const known = new Set(projects.map((project) => project.id))
  const fallback = projects[0]?.id

  for (const session of sessions) {
    const projectId = sessionProjectId(session, assignments, known) ?? fallback
    if (projectId === undefined) continue
    groups.get(projectId)?.push(session)
  }

  for (const list of groups.values()) {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  return groups
}

export function countProjectSessions(
  projects: readonly Project[],
  sessions: readonly SessionSummary[],
  assignments: AssignmentMap,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const [projectId, list] of groupSessionsByProject(projects, sessions, assignments)) {
    counts.set(projectId, list.length)
  }
  return counts
}
