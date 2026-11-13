/**
 * Planning & Feasibility stage specialization.
 *
 * The planning phase produces exactly one document: a TELOS feasibility
 * report. TELOS covers Technical, Economic, Legal, Operational and Schedule
 * feasibility. Business ideas, stakeholder goals and the go/no-go decision are
 * captured as stage checklist evidence around that document.
 */

import type { ProjectStage } from './sdlc.ts'

export const TELOS_DOCUMENT_KIND = 'telos_report'

export const TELOS_TEMPLATE = `# TELOS Feasibility Report — {{project_name}}

## 1. Executive summary

State the business idea in two or three sentences, the decision requested, and
the overall recommendation.

## 2. Business idea and context

- Problem or opportunity:
- Proposed product or service:
- Target users and market:
- Why now:
- Out of scope:

## 3. Stakeholder goals and success measures

| Stakeholder | Goal | Success measure | Priority |
|---|---|---|---|
| | | | |

Record constraints, non-goals and decision-makers.

## 4. Technical feasibility

- Required capabilities and integrations:
- Data, security and privacy implications:
- Technology maturity and availability:
- Technical dependencies and unknowns:
- Initial technical risks:

## 5. Economic feasibility

- Estimated costs: build, run, licences, support:
- Expected benefits and revenue:
- Funding source and budget range:
- Break-even or ROI assumptions:
- Cost risks and sensitivities:

## 6. Legal feasibility

- Regulatory and compliance obligations:
- Contracts, licensing and intellectual property:
- Data protection and retention:
- Accessibility or industry-specific requirements:
- Open legal questions:

## 7. Operational feasibility

- Operating model and ownership:
- Team, skills and capacity:
- Support and maintenance:
- Process and change impact:
- Operational risks:

## 8. Schedule feasibility

- Target start and launch dates:
- Major milestones and dependencies:
- Critical path and externally imposed dates:
- Staffing or procurement lead times:
- Schedule risks:

## 9. Risks, assumptions and constraints

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| | | | | |

List assumptions that must remain true and constraints that shape the solution.

## 10. Recommendation

Decision: **Go / Conditional go / No-go**

Rationale:

Conditions to proceed, if any:

## 11. Open questions

| Question | Owner | Needed by |
|---|---|---|
| | | |
`

export interface StageDocumentRequirement {
  stage: ProjectStage
  kind: string
  label: string
  description: string
  cardinality: 'one' | 'many'
  required: boolean
  templateMarkdown?: string
}

/**
 * Required documents per stage. Planning deliberately has one document slot,
 * not a set of SRS/functional-spec documents.
 */
export const STAGE_DOCUMENT_REQUIREMENTS: StageDocumentRequirement[] = [
  {
    stage: 'planning',
    kind: TELOS_DOCUMENT_KIND,
    label: 'TELOS feasibility report',
    description: 'A single feasibility report covering Technical, Economic, Legal, Operational and Schedule feasibility.',
    cardinality: 'one',
    required: true,
    templateMarkdown: TELOS_TEMPLATE,
  },
]
