import { DOCUMENT_KINDS } from '../stage-prerequisites.ts'
import { requirementsPromptBundleV1, requirementsRevisionPlanRepair } from '../processes/stages/requirements.ts'
import type { StageDefinition } from '../stage-definition.ts'

export const REQUIREMENTS_DEFINITION: StageDefinition = {
  stage: 'requirements',
  baselineDocumentKinds: [DOCUMENT_KINDS.telosReport],
  processes: ['analyzer', 'author', 'reviewer'],
  prompts: {
    analyzer: (...args) => requirementsPromptBundleV1.analyzer(...args).text,
    author: (...args) => requirementsPromptBundleV1.author(...args).text,
    reviewer: (...args) => requirementsPromptBundleV1.reviewer(...args).text,
    revision: (...args) => requirementsPromptBundleV1.revision(...args).text,
  },
  revisionPlanRepair: requirementsRevisionPlanRepair,
  promptBundles: { current: '1.0.0', versions: { '1.0.0': requirementsPromptBundleV1 } },
  artifact: {
    kind: DOCUMENT_KINDS.requirementsSpec,
    title: 'Requirements specification',
    fileStem: 'requirements-specification',
    checklistKeys: ['requirement_document', 'acceptance_criteria', 'requirements_review'],
  },
  humanDecision: 'approval',
}
