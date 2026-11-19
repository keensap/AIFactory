import { describe, expect, it } from 'vitest'
import {
  assignedSessionIds,
  buildStageContext,
  loadStageChats,
  saveStageChats,
  stripStageContext,
  withStageContext,
} from '../src/data/stageChat.ts'
import type { ProjectDocument } from '../src/api/types.ts'

const doc = { id: 'd1', projectId: 'p 1', stage: 'planning', kind: 'x', title: 'TELOS report', storagePath: '', mimeType: 'text/markdown', status: 'approved', version: 2, createdAt: '', updatedAt: '' } as ProjectDocument

function memory() {
  const map = new Map<string, string>()
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) }
}

describe('stage context', () => {
  const context = buildStageContext({
    projectName: 'Atlas', stageKey: 'planning', stageLabel: 'Planning & Feasibility', stageStatus: 'in_progress', readOnly: false,
    run: { attempt: 2, status: 'awaiting_human', id: 'r1' },
    checklist: [
      { id: 'a', stage: 'planning', key: 'a', label: 'Idea captured', required: true, status: 'done', evidenceDocumentId: null, completedAt: null },
      { id: 'b', stage: 'planning', key: 'b', label: 'Decision recorded', required: true, status: 'open', evidenceDocumentId: null, completedAt: null },
    ],
    documents: [doc],
    history: [{ key: 'planning', label: 'Planning', state: { stage: 'planning', status: 'in_progress', startedAt: null, completedAt: null, notes: null } }, { key: 'design', label: 'Design', state: undefined }],
  })

  it('lists run, checklist, document links and history compactly', () => {
    expect(context).toContain('attempt 2, awaiting_human')
    expect(context).toContain('1/2 required done; open: Decision recorded')
    expect(context).toContain('/api/projects/p%201/documents/d1/content')
    expect(context).toContain('Planning: in_progress')
    expect(context).not.toContain('Design:')
  })

  it('is hidden again when a stored message is shown', () => {
    expect(stripStageContext(withStageContext(context, 'what is blocking us?'))).toBe('what is blocking us?')
    expect(stripStageContext('plain text')).toBe('plain text')
  })
})

describe('stage chat membership', () => {
  it('remembers sessions per project and stage', () => {
    const storage = memory()
    saveStageChats(storage, 'p', 'planning', ['s1', 's2', 's1'])
    saveStageChats(storage, 'p', 'design', ['s3'])
    expect(loadStageChats(storage, 'p', 'planning')).toEqual(['s1', 's2'])
    expect(loadStageChats(storage, 'q', 'planning')).toEqual([])
    expect([...assignedSessionIds(storage, 'p')].sort()).toEqual(['s1', 's2', 's3'])
  })

  it('survives corrupt storage', () => {
    const storage = memory()
    storage.setItem('aifactory.chat-web.stage-chats.v1', '{nope')
    expect(loadStageChats(storage, 'p', 'planning')).toEqual([])
  })
})
