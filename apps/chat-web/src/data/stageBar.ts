/**
 * Pure state for the stage bar. A stage is `done` (completed, viewable but
 * read-only), `current` (highlighted, the only one that can be worked on) or
 * `todo` (disabled). Anything before the project's current stage is history.
 */

import type { SdlcStage, StageState } from '../api/types.ts'
import { isExecutableStage } from './stages.ts'

export type StageBarStatus = 'done' | 'current' | 'todo'

export interface StageBarItem {
  key: string
  name: string
  number: number
  status: StageBarStatus
  /** Can be opened: done and current stages only. */
  enabled: boolean
  /** Whether the API provides a runtime, independent of navigation/read-only status. */
  executable: boolean
  /** The stage on screen. */
  selected: boolean
}

export function buildStageBar(
  stages: readonly SdlcStage[],
  states: readonly StageState[],
  currentStage: string,
  selectedStage: string,
): StageBarItem[] {
  const currentIndex = stages.findIndex((stage) => stage.key === currentStage)
  return stages.map((stage, index) => {
    const completed = states.find((state) => state.stage === stage.key)?.status === 'completed'
    const status: StageBarStatus = stage.key === currentStage
      ? 'current'
      : completed || (currentIndex !== -1 && index < currentIndex)
        ? 'done'
        : 'todo'
    return { key: stage.key, name: stage.name, number: index + 1, status, executable: isExecutableStage(stages, stage.key), enabled: status !== 'todo', selected: stage.key === selectedStage }
  })
}

/** Viewing a finished stage: show everything, change nothing. */
export function isHistoricalStage(items: readonly StageBarItem[], stageKey: string): boolean {
  return items.find((item) => item.key === stageKey)?.status === 'done'
}

export function stageBarSummary(items: readonly StageBarItem[], selectedStage: string): string {
  const position = items.findIndex((item) => item.key === selectedStage) + 1
  const done = items.filter((item) => item.status === 'done').length
  return `Stage ${Math.max(1, position)} of ${items.length} · ${done} completed`
}
