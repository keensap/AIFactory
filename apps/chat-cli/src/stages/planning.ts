import { renderPrompt } from '../processes/render.ts'
import { preparePrompt } from '../processes/spec.ts'
import { planningAnalyzer, planningAuthor, planningReviewer, planningRevision, planningStructuredReview } from '../processes/stages/planning.ts'
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
  buildReviewerPrompt,
} from '../processes/stages/planning.ts'
import type { StageDefinition } from '../stage-definition.ts'

const planningPrompts: import('../stage-definition.ts').PreparedStagePrompts = {
    analyzer: (project, context) => preparePrompt(planningAnalyzer, { project, context }, context.processParams),
    author: (project, context, analysis) => preparePrompt(planningAuthor, { project, context, analysis }, context.processParams),
    reviewer: (project, context, draft, settings) => preparePrompt(planningReviewer, { project, context, draft, settings }, context.processParams),
    revision: (project, context, analysis, draft, findings) => preparePrompt(planningRevision, { project, context, analysis, draft, findings }, context.processParams),
}

export const PLANNING_DEFINITION: StageDefinition = {
  stage: 'planning',
  processes: ['analyzer', 'author', 'reviewer'],
  prompts: {
    analyzer: (project, context) => buildAnalyzerPrompt(project, context),
    author: (project, context, analysis) => buildAuthorPrompt(project, context, analysis),
    reviewer: (project, context, draft, settings) => buildReviewerPrompt(project, context, draft, settings),
    revision: (project, context, analysis, draft, findings) =>
      renderPrompt(planningRevision.sections({ project, context, analysis, draft, findings })).text,
  },
  structuredReview: planningStructuredReview,
  promptBundles: { current: '2.0.0', versions: { '1.0.0': planningPrompts, '2.0.0': planningPrompts } },
  artifact: {
    kind: TELOS_DOCUMENT_KIND,
    title: 'TELOS feasibility report',
    fileStem: 'telos',
    // The feasibility report is the evidence for the planning checklist.
    checklistKeys: ['business_idea', 'stakeholder_goals', 'feasibility_decision'],
  },
  humanDecision: 'feasibility',
}