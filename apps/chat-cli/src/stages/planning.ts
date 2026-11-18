/**
 * The planning stage's definition: the TELOS feasibility report.
 *
 * Everything here is planning-specific. The engine drives it, so this file is the
 * only place a change to planning's prompts, artifact or checklist lives.
 */

import { TELOS_DOCUMENT_KIND } from '../telos.ts'
import {
  buildAnalyzerPrompt,
  buildAuthorPrompt,
  buildRevisionPrompt,
  buildReviewerPrompt,
  parseStageReview,
} from '../stage-runtime.ts'
import type { StageDefinition } from '../stage-definition.ts'

export const PLANNING_DEFINITION: StageDefinition = {
  stage: 'planning',
  processes: ['analyzer', 'author', 'reviewer'],
  prompts: {
    analyzer: (project, context) => buildAnalyzerPrompt(project, context),
    author: (project, context, analysis) => buildAuthorPrompt(project, context, analysis),
    reviewer: (project, context, draft, settings) => buildReviewerPrompt(project, context, draft, settings),
    revision: (project, context, analysis, draft, findings) =>
      buildRevisionPrompt(project, context, analysis, draft, findings),
  },
  artifact: {
    kind: TELOS_DOCUMENT_KIND,
    title: 'TELOS feasibility report',
    fileStem: 'telos',
    // The feasibility report is the evidence for the planning checklist.
    checklistKeys: ['business_idea', 'stakeholder_goals', 'feasibility_decision'],
  },
  parseReview: (raw) => parseStageReview(raw),
  humanDecision: 'feasibility',
}