/**
 * SDLC stage tracking for a project.
 *
 * The Chat API has no stage field yet, so the current stage is kept per
 * project in browser storage. Stages before the current one count as
 * completed. Swap `loadStage`/`saveStage` for API calls once the registry
 * stores a stage.
 */

import { readJson, writeJson, type StorageLike } from '../lib/storage.ts'

export interface SdlcStage {
  id: string
  label: string
  description: string
}

export const SDLC_STAGES: readonly SdlcStage[] = [
  { id: 'planning', label: 'Planning', description: 'Scope, goals, feasibility and schedule' },
  { id: 'requirements', label: 'Requirements', description: 'Gather and analyse what the system must do' },
  { id: 'design', label: 'Design', description: 'Architecture, data model and interfaces' },
  { id: 'development', label: 'Development', description: 'Build and review the code' },
  { id: 'testing', label: 'Testing', description: 'Verify behaviour and fix defects' },
  { id: 'deployment', label: 'Deployment', description: 'Release to the target environment' },
  { id: 'maintenance', label: 'Maintenance', description: 'Operate, monitor and improve' },
]

export const SDLC_KEY = 'aifactory.chat-web.sdlc.v1'

export type StageState = 'completed' | 'current' | 'upcoming'

export function stageState(index: number, currentIndex: number): StageState {
  if (index < currentIndex) return 'completed'
  return index === currentIndex ? 'current' : 'upcoming'
}

/** Index of the project's current stage; new projects start at Planning. */
export function loadStage(storage: StorageLike, projectId: string): number {
  const map = readJson<unknown>(storage, SDLC_KEY, {})
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return 0
  const id = (map as Record<string, unknown>)[projectId]
  const index = SDLC_STAGES.findIndex((stage) => stage.id === id)
  return index === -1 ? 0 : index
}

export function saveStage(storage: StorageLike, projectId: string, index: number): void {
  const stage = SDLC_STAGES[index]
  if (stage === undefined) return
  const current = readJson<unknown>(storage, SDLC_KEY, {})
  const map = current !== null && typeof current === 'object' && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {}
  map[projectId] = stage.id
  writeJson(storage, SDLC_KEY, map)
}
