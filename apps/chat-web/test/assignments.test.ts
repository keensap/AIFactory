import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../src/api/types.ts'
import {
  ASSIGNMENTS_KEY,
  assignSession,
  groupSessionsByProject,
  loadAssignments,
  reassignProject,
  reconcileAssignments,
  removeAssignment,
  saveAssignments,
  sessionProjectId,
} from '../src/data/assignments.ts'
import { defaultProjects } from '../src/data/projects.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

const projects = defaultProjects()

function session(id: string, updatedAt: string): SessionSummary {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 2,
  }
}

describe('assignments', () => {
  it('round-trips through storage', () => {
    const storage = createMemoryStorage()
    saveAssignments(storage, { 'session-1': 'project-atlas' })
    expect(loadAssignments(storage)).toEqual({ 'session-1': 'project-atlas' })
  })

  it('ignores malformed stored assignments', () => {
    expect(loadAssignments(createMemoryStorage({ [ASSIGNMENTS_KEY]: 'null' }))).toEqual({})
    expect(loadAssignments(createMemoryStorage({
      [ASSIGNMENTS_KEY]: JSON.stringify({ a: 1, b: 'project-atlas' }),
    }))).toEqual({ b: 'project-atlas' })
  })

  it('files unknown sessions under the fallback project', () => {
    const result = reconcileAssignments(
      [session('a', '2026-01-01T00:00:00.000Z'), session('b', '2026-01-02T00:00:00.000Z')],
      projects,
      { a: 'project-atlas' },
    )
    expect(result.changed).toBe(true)
    expect(result.assignments).toEqual({
      a: 'project-atlas',
      b: 'project-general',
    })
  })

  it('re-files assignments whose project no longer exists and drops stale sessions', () => {
    const result = reconcileAssignments(
      [session('a', '2026-01-01T00:00:00.000Z')],
      projects,
      { a: 'project-deleted', b: 'project-atlas' },
    )
    expect(result.assignments).toEqual({ a: 'project-general' })
    expect(result.changed).toBe(true)
  })

  it('reports no change when every assignment is valid', () => {
    const assignments = { a: 'project-atlas' }
    const result = reconcileAssignments(
      [session('a', '2026-01-01T00:00:00.000Z')],
      projects,
      assignments,
    )
    expect(result.changed).toBe(false)
    expect(result.assignments).toEqual(assignments)
  })

  it('groups and sorts sessions per project', () => {
    const groups = groupSessionsByProject(
      projects,
      [
        session('old', '2026-01-01T00:00:00.000Z'),
        session('new', '2026-01-03T00:00:00.000Z'),
        session('other', '2026-01-02T00:00:00.000Z'),
      ],
      { old: 'project-atlas', new: 'project-atlas', other: 'project-forge' },
    )
    expect(groups.get('project-atlas')?.map((entry) => entry.id)).toEqual(['new', 'old'])
    expect(groups.get('project-forge')?.map((entry) => entry.id)).toEqual(['other'])
    expect(groups.get('project-general')).toEqual([])
  })

  it('moves all chats off a deleted project', () => {
    expect(reassignProject(
      { a: 'project-atlas', b: 'project-forge' },
      'project-atlas',
      'project-general',
    )).toEqual({ a: 'project-general', b: 'project-forge' })
  })

  it('adds and removes exactly one assignment', () => {
    const base = { a: 'project-general' }
    expect(assignSession(base, 'b', 'project-atlas')).toEqual({
      a: 'project-general',
      b: 'project-atlas',
    })
    expect(removeAssignment(base, 'a')).toEqual({})
    expect(removeAssignment(base, 'missing')).toBe(base)
  })

  it('prefers the server-side project binding over the local map', () => {
    const [first, second] = projects
    const bound = { ...session('bound', '2026-01-02T00:00:00Z'), projectId: second!.id }
    const known = new Set(projects.map((project) => project.id))
    expect(sessionProjectId(bound, { bound: first!.id }, known)).toBe(second!.id)

    const groups = groupSessionsByProject(projects, [bound], { bound: first!.id })
    expect(groups.get(second!.id)?.map((entry) => entry.id)).toEqual(['bound'])
    expect(groups.get(first!.id)).toEqual([])

    const next = reconcileAssignments([bound], projects, { bound: first!.id }, first!.id)
    expect(next.changed).toBe(true)
    expect(next.assignments.bound).toBe(second!.id)
  })

  it('falls back to the local map when the bound project is unknown', () => {
    const [first] = projects
    const orphan = { ...session('orphan', '2026-01-02T00:00:00Z'), projectId: 'gone' }
    const known = new Set(projects.map((project) => project.id))
    expect(sessionProjectId(orphan, { orphan: first!.id }, known)).toBe(first!.id)
  })
})
