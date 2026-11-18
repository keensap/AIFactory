/**
 * The stage registry.
 *
 * Adding a stage means adding a definition here; the engine needs no change. A
 * stage absent from this map has no runtime yet, and its settings and run routes
 * answer `501` rather than pretending.
 */

import type { StageDefinition } from '../stage-definition.ts'
import { PLANNING_DEFINITION } from './planning.ts'
import { REQUIREMENTS_DEFINITION } from './requirements.ts'

export const STAGE_DEFINITIONS: readonly StageDefinition[] = [
  PLANNING_DEFINITION,
  REQUIREMENTS_DEFINITION,
]

const byStage = new Map<string, StageDefinition>(
  STAGE_DEFINITIONS.map((definition) => [definition.stage, definition]),
)

/** The definition for a stage, or undefined when it has no runtime yet. */
export function stageDefinition(stage: string): StageDefinition | undefined {
  return byStage.get(stage)
}

/** Stages that can run today. */
export function executableStages(): string[] {
  return STAGE_DEFINITIONS.map((definition) => definition.stage)
}

export { PLANNING_DEFINITION, REQUIREMENTS_DEFINITION }
