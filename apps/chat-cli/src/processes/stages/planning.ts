import type { Project } from '../../projects.ts'
import type { StageContextPacket } from '../../stage-runtime.ts'
import { DEFAULT_PLANNING_STAGE_SETTINGS, settingsFromContext, type PlanningStageSettings } from '../../stage-settings.ts'
import { TELOS_TEMPLATE } from '../../telos.ts'
import { attachmentSection, contextWithoutAttachmentText } from '../context.ts'
import { renderPrompt } from '../render.ts'
import type { PromptRoleSpec } from '../spec.ts'
import type { PromptSection } from '../sections.ts'

interface BaseInput { project: Project; context: StageContextPacket }
interface AuthorInput extends BaseInput { analysis: string }
interface ReviewerInput extends BaseInput { draft: string; settings?: PlanningStageSettings }
// Legacy findings are opaque until review output validation is migrated.
interface RevisionInput extends AuthorInput { draft: string; findings: unknown[] }

function section(order: number, id: string, body: string, kind: NonNullable<PromptSection['source']>['kind'] = 'spec'): PromptSection {
  return { order, id, body, source: { kind } }
}

export const planningAnalyzer: PromptRoleSpec<BaseInput> = {
  id: 'planning/analyzer',
  version: '1.0.0',
  sections({project, context}) {
    return [
      section(0, 'task', `STAGE_ROLE: analyzer
You are the Planning & Feasibility analyzer for an AI software delivery factory.

Analyze the project facts and the requester's input for a single TELOS feasibility report. Do not write the report itself. Identify:
1. the high-level business idea, problem and proposed product;
2. stakeholder goals, success measures and constraints;
3. available evidence for Technical, Economic, Legal, Operational and Schedule feasibility;
4. gaps, ambiguities and questions that must be resolved before a go/no-go recommendation.

Use only the facts below. Mark missing evidence as a gap; do not invent budgets, dates or approvals.
Return concise Markdown with headings for the five TELOS dimensions.`),
      section(1, 'project', `PROJECT: ${project.name}`, 'context'),
      section(2, 'attachments', `${attachmentSection(context)}`, 'attachment'),
      section(3, 'context', `CONTEXT:
${JSON.stringify(contextWithoutAttachmentText(context), null, 2)}`, 'context'),
    ]
  },
}

export function buildAnalyzerPrompt(project: Project, context: StageContextPacket): string {
  return renderPrompt(planningAnalyzer.sections({ project, context })).text
}

export const planningAuthor: PromptRoleSpec<AuthorInput> = {
  id: 'planning/author',
  version: '1.0.0',
  sections({project, context, analysis}) {
    return [
      section(0, 'task', `STAGE_ROLE: author
You are the Planning & Feasibility author for ${project.name}.

Write the ONE TELOS feasibility report. Follow the template exactly. Use the analysis and facts below; do not invent evidence. Where evidence is missing, state the gap and the question that must be answered. End with a clear Go, Conditional go or No-go recommendation and conditions.

Return only the Markdown report, without a code fence and without an SRS or functional specification.`),
      section(1, 'analysis', `ANALYSIS:
${analysis}`, 'analysis'),
      section(2, 'template', `TEMPLATE:
${TELOS_TEMPLATE}`),
      section(3, 'attachments', `${attachmentSection(context)}`, 'attachment'),
      section(4, 'context', `CONTEXT:
${JSON.stringify(contextWithoutAttachmentText(context), null, 2)}`, 'context'),
    ]
  },
}

export function buildAuthorPrompt(
  project: Project,
  context: StageContextPacket,
  analysis: string,
): string {
  return renderPrompt(planningAuthor.sections({ project, context, analysis })).text
}

export const planningReviewer: PromptRoleSpec<ReviewerInput> = {
  id: 'planning/reviewer',
  version: '1.0.0',
  sections({project, context, draft, settings}) {
    const criteria = settings ?? { ...DEFAULT_PLANNING_STAGE_SETTINGS, ...settingsFromContext(context) }
    const ratingRule = `Rate the document 0-100 for whether it is ready to send to the sponsor. The run stops revising as soon as ALL of these hold:
- overall rating >= ${criteria.minRating}
- blocker findings <= ${criteria.maxBlockers}
- major findings <= ${criteria.maxMajor}`
    const reviewContext = {
      project: {
        name: project.name,
        organization: project.organization,
        ownerEmail: project.ownerEmail,
      },
      stage: {
        key: context.stage.key,
        checklist: context.stage.checklist,
        input: context.input,
        constraints: context.constraints,
      },
      priorStages: context.priorStages,
      documents: context.documents.map((document) => ({
        kind: document.kind,
        title: document.title,
        storagePath: document.storagePath,
        status: document.status,
      })),
      attachments: context.attachments.map(({ text: _text, ...meta }) => meta),
    }

    return [
      section(0, 'task', `STAGE_ROLE: reviewer
You are the independent Planning & Feasibility reviewer for ${project.name}. You did not write this draft.

Evaluate the single TELOS report against the template and evidence. Check that:
- business idea, stakeholder goals and success measures are explicit;
- each of Technical, Economic, Legal, Operational and Schedule feasibility is addressed;
- assumptions, risks and missing evidence are not hidden;
- the recommendation is justified by the evidence;
- no SRS/functional specification has been substituted for the feasibility report.`),
      section(1, 'rating', `${ratingRule}`),
      section(2, 'output', `Return ONLY JSON:
{
  "decision": "approved" | "needs_revision" | "rejected",
  "rating": <integer 0-100>,
  "findings": [
    {
      "id": "F-001",
      "severity": "blocker" | "major" | "minor",
      "section": "...",
      "finding": "...",
      "required_change": "..."
    }
  ]
}

Approve only if there are no blocker or major findings. If not approved, include actionable required changes.`),
      section(3, 'draft', `DRAFT:
${draft}`, 'draft'),
      section(4, 'attachments', `${attachmentSection(context)}`, 'attachment'),
      section(5, 'context', `REVIEW CONTEXT:
${JSON.stringify(reviewContext, null, 2)}`, 'context'),
    ]
  },
}

export function buildReviewerPrompt(
  project: Project,
  context: StageContextPacket,
  draft: string,
  settings?: PlanningStageSettings,
): string {
  return renderPrompt(planningReviewer.sections({ project, context, draft, ...(settings === undefined ? {} : { settings }) })).text
}

export const planningRevision: PromptRoleSpec<RevisionInput> = {
  id: 'planning/revision',
  version: '1.0.0',
  sections({project, context, analysis, draft, findings}) {
    return [
      section(0, 'task', `STAGE_ROLE: author
Revise the one TELOS feasibility report for ${project.name} using the reviewer findings below.

Address every blocker and major finding. Keep the template structure. Do not add evidence that does not exist. Return only the complete revised Markdown report, without a code fence.`),
      section(1, 'findings', `FINDINGS:
${JSON.stringify(findings, null, 2)}`, 'findings'),
      section(2, 'draft', `CURRENT DRAFT:
${draft}`, 'draft'),
      section(3, 'analysis', `ANALYSIS:
${analysis}`, 'analysis'),
      section(4, 'attachments', `${attachmentSection(context)}`, 'attachment'),
      section(5, 'context', `CONTEXT:
${JSON.stringify(contextWithoutAttachmentText(context), null, 2)}`, 'context'),
    ]
  },
}

export function buildRevisionPrompt(
  project: Project,
  context: StageContextPacket,
  analysis: string,
  draft: string,
  findings: unknown[],
): string {
  return renderPrompt(planningRevision.sections({ project, context, analysis, draft, findings })).text
}
