/**
 * What makes one SDLC stage different from another.
 *
 * The engine (leases, the analyze -> author -> review -> gate loop, the acceptance
 * rule, completion, export) is identical for every stage. Everything that is not
 * identical lives here, so adding a stage is a definition rather than a copy of a
 * thousand lines (AR-15).
 *
 * A definition supplies:
 *  - the stage key and the processes its roles run (which is also what agent
 *    assignments are keyed by);
 *  - the prompt builders for those roles;
 *  - what its artifact is: document kind, title and file name;
 *  - which checklist items the artifact satisfies;
 *  - how its settings are validated and read from a run's context.
 */

import type { Project } from './projects.ts'
import type { ProjectStage } from './sdlc.ts'
import type { StageContextPacket, StageReviewResult } from './stage-runtime.ts'
import type { PlanningStageSettings } from './stage-settings.ts'

export type StageRoleName = 'analyzer' | 'author' | 'reviewer'

export interface StageArtifact {
  /** Document kind stored in `project_documents`. */
  kind: string
  /** Human title, used for the document and the PDF. */
  title: string
  /** File name stem for the stored Markdown, without the run id. */
  fileStem: string
  /** Checklist keys this artifact evidences. */
  checklistKeys: string[]
}

export interface StagePrompts {
  analyzer(project: Project, context: StageContextPacket): string
  author(project: Project, context: StageContextPacket, analysis: string): string
  reviewer(project: Project, context: StageContextPacket, draft: string, settings: PlanningStageSettings): string
  revision(
    project: Project,
    context: StageContextPacket,
    analysis: string,
    draft: string,
    findings: unknown[],
  ): string
}

export interface StageDefinition {
  /** The SDLC stage this definition drives. */
  stage: ProjectStage
  /** Processes the stage runs, in agent-assignment terms. */
  processes: readonly StageRoleName[]
  prompts: StagePrompts
  artifact: StageArtifact
  /** Parse a reviewer response. Defaults to `parseStageReview`. */
  parseReview?(raw: string): StageReviewResult
  /**
   * Whether an approval means "go / conditional go / no go" (planning's
   * feasibility decision) or a plain approval. Only planning asks for a decision.
   */
  humanDecision: 'feasibility' | 'approval'
}

/** The definition for a stage, or undefined when the stage has no runtime yet. */
export type StageDefinitionLookup = (stage: string) => StageDefinition | undefined