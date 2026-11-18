/**
 * The requirements stage's definition: a requirements specification.
 *
 * The second stage, and the proof that the engine is stage-independent: nothing
 * here is a copy of the planning code, and the engine was not changed to add it.
 *
 * Its prompts ask for what a requirements specification must contain (numbered
 * functional and non-functional requirements, actors, acceptance criteria,
 * traceability to the planning baseline) rather than the TELOS questions.
 */

import { DOCUMENT_KINDS } from '../stage-prerequisites.ts'
import { attachmentSection } from '../stage-runtime.ts'
import type { StageDefinition } from '../stage-definition.ts'
import type { Project } from '../projects.ts'
import type { StageContextPacket } from '../stage-runtime.ts'
import type { PlanningStageSettings } from '../stage-settings.ts'

const MAX_ATTACHMENT_CHARS = 60_000

function evidence(context: StageContextPacket): string {
  const prior = context.priorStages
    .filter((stage) => stage.summary.trim() !== '')
    .map((stage) => `### ${stage.stage}\n${stage.summary.trim()}`)
    .join('\n\n')
  const documents = context.documents
    .filter((document) => document.stage !== 'requirements')
    .map((document) => `- ${document.kind}: ${document.title}`)
    .join('\n')
  return [
    prior === '' ? '' : `## Prior stage summaries\n\n${prior}`,
    documents === '' ? '' : `## Available documents\n\n${documents}`,
  ].filter((part) => part !== '').join('\n\n')
}

function analyzerPrompt(project: Project, context: StageContextPacket): string {
  return `You are gathering requirements for the project "${project.name}".

## Input
${context.input ?? '(no brief was supplied; work from the evidence below)'}

${evidence(context)}

${attachmentSection(context)}

Read the evidence and produce a requirements analysis:

1. **Actors** — every role that uses the system, and what each needs.
2. **Functional requirements** — what the system must do, derived from the input.
3. **Non-functional requirements** — performance, security, accessibility, scale.
4. **Constraints and assumptions** — technology, budget, policy, unknowns.
5. **Open questions** — what the evidence does not answer. Do not invent answers;
   state the assumption you would need.

Be specific and testable. "The page should be fast" is not a requirement; "the
catalogue page renders in under 2 seconds on a 3G connection" is.

Output Markdown only.`
}

function authorPrompt(project: Project, context: StageContextPacket, analysis: string): string {
  return `You are writing the requirements specification for "${project.name}".

## Analysis
${analysis}

${evidence(context)}

${attachmentSection(context)}

Write a requirements specification in Markdown with these sections:

# Requirements Specification — ${project.name}

## 1. Purpose and scope
## 2. Actors and permissions
## 3. Functional requirements
   Number each requirement \`FR-001\`, \`FR-002\`, … Each states one behaviour and is
   independently testable.
## 4. Non-functional requirements
   Number each \`NFR-001\`, …. Give a measurable target for each.
## 5. Acceptance criteria
   For each requirement group, the condition that proves it is done.
## 6. Assumptions, constraints and open questions
## 7. Traceability
   Which prior artefact each requirement comes from (planning report, supplied
   document, or the brief).

Rules:
- Do not invent requirements the evidence does not support; list them as open questions.
- Every functional requirement has an id, and its acceptance criterion refers to that id.
- No placeholders, no "TBD" left silent — an open question is written down as one.

Output Markdown only.`
}

function reviewerPrompt(
  project: Project,
  context: StageContextPacket,
  draft: string,
  settings: PlanningStageSettings,
): string {
  return `You are reviewing the requirements specification for "${project.name}".

## Document
${draft}

${evidence(context)}

Judge it against these tests:
- Every functional requirement is numbered, atomic and testable.
- Every non-functional requirement has a measurable target.
- Every actor in the analysis appears in the permissions section.
- Acceptance criteria reference requirement ids.
- Nothing is invented: unsupported claims are listed as open questions.

Rate the document 0-100 for whether it is ready to hand to design. The run stops
revising as soon as ALL of these hold:
- overall rating >= ${settings.minRating}
- blocker findings <= ${settings.maxBlockers}
- major findings <= ${settings.maxMajor}

Return ONLY JSON:
{
  "decision": "approved" | "needs_revision" | "rejected",
  "rating": <integer 0-100>,
  "findings": [
    { "id": "F-001", "severity": "blocker" | "major" | "minor",
      "section": "<section heading>", "finding": "<what is wrong>",
      "required_change": "<what to do>" }
  ]
}`
}

function revisionPrompt(
  project: Project,
  context: StageContextPacket,
  analysis: string,
  draft: string,
  findings: unknown[],
): string {
  const list = findings
    .map((finding) => {
      const record = finding !== null && typeof finding === 'object' ? finding as Record<string, unknown> : {}
      const severity = String(record.severity ?? 'major')
      const section = String(record.section ?? 'unspecified')
      const problem = String(record.finding ?? record.message ?? JSON.stringify(finding))
      const change = String(record.required_change ?? record.requiredChange ?? 'address it')
      return `- [${severity}] ${section}: ${problem} → ${change}`
    })
    .join('\n')

  // Keep the prompt bounded: a long specification should not be truncated silently,
  // so the tail is cut at a section boundary with an explicit marker.
  const limit = MAX_ATTACHMENT_CHARS
  const body = draft.length > limit
    ? `${draft.slice(0, limit)}\n\n<!-- truncated: document continues -->\n`
    : draft

  return `You are revising the requirements specification for "${project.name}".

## Current document
${body}

## Analysis you started from
${analysis}

## Reviewer findings
${findings.length === 0 ? '- none' : list}

Apply each finding. Keep everything the reviewer did not raise. Renumber new
requirements so the sequence stays contiguous, and update the acceptance criteria
and traceability for anything you add.

Output the complete revised Markdown document only, without a code fence.`
}

export const REQUIREMENTS_DEFINITION: StageDefinition = {
  stage: 'requirements',
  processes: ['analyzer', 'author', 'reviewer'],
  prompts: {
    analyzer: (project, context) => analyzerPrompt(project, context),
    author: (project, context, analysis) => authorPrompt(project, context, analysis),
    reviewer: (project, context, draft, settings) => reviewerPrompt(project, context, draft, settings),
    revision: (project, context, analysis, draft, findings) =>
      revisionPrompt(project, context, analysis, draft, findings),
  },
  artifact: {
    kind: DOCUMENT_KINDS.requirementsSpec,
    title: 'Requirements specification',
    fileStem: 'requirements-specification',
    checklistKeys: ['requirement_document', 'acceptance_criteria', 'requirements_review'],
  },
  humanDecision: 'approval',
}
