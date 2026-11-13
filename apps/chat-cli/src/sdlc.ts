/**
 * Phase-level SDLC model used by the project dashboard.
 *
 * These eight stages are deliberately coarser than the full delivery
 * specification: they answer "where is this project and what is the next
 * concrete action?" rather than enumerating every delivery task.
 */

export const SDLC_STAGES = [
  'planning',
  'requirements',
  'design',
  'architecture',
  'development',
  'testing',
  'deployment',
  'maintenance',
] as const

export type ProjectStage = (typeof SDLC_STAGES)[number]
export type StageStatus = 'not_started' | 'in_progress' | 'completed' | 'blocked' | 'skipped'
export type ChecklistStatus = 'open' | 'done' | 'waived'
export type DocumentStatus = 'uploaded' | 'in_review' | 'approved' | 'rejected' | 'superseded'

export const STAGE_LABELS: Record<ProjectStage, string> = {
  planning: 'Planning & Feasibility',
  requirements: 'Requirements',
  design: 'Design',
  architecture: 'Architecture',
  development: 'Development',
  testing: 'Testing',
  deployment: 'Deployment',
  maintenance: 'Maintenance',
}

export interface ChecklistDefinition {
  key: string
  label: string
  required: boolean
}

export const STAGE_CHECKLISTS: Record<ProjectStage, ChecklistDefinition[]> = {
  planning: [
    { key: 'business_idea', label: 'High-level business idea and problem statement are captured', required: true },
    { key: 'stakeholder_goals', label: 'Stakeholder goals, success measures and constraints are captured', required: true },
    { key: 'telos_report', label: 'Single TELOS feasibility report is provided', required: true },
    { key: 'feasibility_decision', label: 'Go, conditional-go or no-go decision and conditions are recorded', required: true },
  ],
  requirements: [
    { key: 'requirement_document', label: 'Requirement document is provided', required: true },
    { key: 'acceptance_criteria', label: 'Acceptance criteria are defined', required: true },
    { key: 'requirements_review', label: 'Requirements have been reviewed and baselined', required: true },
  ],
  design: [
    { key: 'design_document', label: 'Design or wireframe document is provided', required: true },
    { key: 'ux_review', label: 'UX review is complete', required: false },
  ],
  architecture: [
    { key: 'architecture_document', label: 'Architecture document is provided', required: true },
    { key: 'technology_decisions', label: 'Technology and data decisions are recorded', required: true },
  ],
  development: [
    { key: 'implementation_plan', label: 'Implementation plan and task breakdown exist', required: true },
    { key: 'code_review_setup', label: 'Repository and code-review process are ready', required: true },
  ],
  testing: [
    { key: 'test_plan', label: 'Test plan is provided', required: true },
    { key: 'test_results', label: 'Test results meet the agreed threshold', required: true },
  ],
  deployment: [
    { key: 'deployment_plan', label: 'Deployment and rollback plan are provided', required: true },
    { key: 'release_approval', label: 'Release approval is recorded', required: true },
  ],
  maintenance: [
    { key: 'monitoring_plan', label: 'Monitoring and support plan are provided', required: true },
    { key: 'support_owner', label: 'A support owner is assigned', required: true },
  ],
}

/** Document kinds that satisfy a stage checklist item when uploaded. */
export const DOCUMENT_CHECKLIST_MAP: Partial<Record<string, string>> = {
  telos_report: 'telos_report',
  feasibility_report: 'telos_report',
  requirement_pdf: 'requirement_document',
  requirements_doc: 'requirement_document',
  design_document: 'design_document',
  architecture_document: 'architecture_document',
  test_plan: 'test_plan',
  deployment_plan: 'deployment_plan',
  monitoring_plan: 'monitoring_plan',
}

export function isProjectStage(value: string): value is ProjectStage {
  return (SDLC_STAGES as readonly string[]).includes(value)
}

export function nextStage(stage: ProjectStage): ProjectStage | undefined {
  const index = SDLC_STAGES.indexOf(stage)
  return index >= 0 && index < SDLC_STAGES.length - 1 ? SDLC_STAGES[index + 1] : undefined
}

export function stageLabel(stage: string): string {
  return isProjectStage(stage) ? STAGE_LABELS[stage] : stage
}
