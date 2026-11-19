/**
 * Unsent briefs, per project and stage, so the text survives navigation and
 * reloads. The planning key stays compatible with existing drafts.
 */

import { readJson, writeJson, type StorageLike } from '../lib/storage.ts'

export const BRIEFS_KEY = 'aifactory.chat-web.briefs.v1'

function readMap(storage: StorageLike): Record<string, string> {
  const value = readJson<unknown>(storage, BRIEFS_KEY, {})
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function briefKey(projectId: string, stage: string): string {
  return stage === 'planning' ? projectId : `${projectId}:${stage}`
}

export function loadBrief(storage: StorageLike, projectId: string, stage = 'planning'): string | null {
  return readMap(storage)[briefKey(projectId, stage)] ?? null
}

export function saveBrief(storage: StorageLike, projectId: string, brief: string | null, stage = 'planning'): void {
  const map = readMap(storage)
  const key = briefKey(projectId, stage)
  if (brief === null || brief === '') delete map[key]
  else map[key] = brief
  writeJson(storage, BRIEFS_KEY, map)
}
