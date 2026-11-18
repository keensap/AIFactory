/**
 * What each SDLC stage needs before it can run.
 *
 * The point is that a project may **start at any stage** — an existing codebase
 * can enter at Development, a client can supply requirements directly — so a
 * prerequisite is evidence, not "the previous stage ran". Each prerequisite is
 * satisfied by any one of its accepted sources:
 *
 *  - a brief/input text on a run of that stage,
 *  - one or more input attachments (PDFs),
 *  - a project document of a given kind,
 *  - or a human **waiver with a reason**, recorded and attributed.
 *
 * The catalogue lives in the database (seeded from the definitions below) so it
 * can evolve without code changes; evaluation is pure and testable.
 */

import { Pool } from 'pg'
import { sharedPool } from './db.ts'
import { runMigrations } from './migrations.ts'
import { SDLC_STAGES, STAGE_LABELS, type ProjectStage } from './sdlc.ts'

/** Document kinds the pipeline recognises. Uploads may use any kind; these are the ones prerequisites look for. */
export const DOCUMENT_KINDS = {
  telosReport: 'telos_report',
  businessBrief: 'business_brief',
  requirementsSpec: 'requirements_spec',
  designSpec: 'design_spec',
  architectureSpec: 'architecture_spec',
  techStack: 'tech_stack',
  testPlan: 'test_plan',
  deploymentPlan: 'deployment_plan',
} as const

export type EvidenceSource =
  | { kind: 'brief'; label: string }
  | { kind: 'attachment'; min: number; label: string }
  | { kind: 'document'; documentKinds: string[]; label: string }

export interface StagePrerequisite {
  stage: ProjectStage
  key: string
  label: string
  description: string
  /** Any one of these satisfies the prerequisite. */
  accepts: EvidenceSource[]
  required: boolean
}

export class PrerequisiteError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'PrerequisiteError'
    this.status = status
    this.code = code
  }
}

const brief = (label = 'a written brief'): EvidenceSource => ({ kind: 'brief', label })
const attachments = (min = 1): EvidenceSource => ({ kind: 'attachment', min, label: min === 1 ? 'an uploaded document' : `${min} uploaded documents` })
const documents = (documentKinds: string[], label: string): EvidenceSource => ({ kind: 'document', documentKinds, label })

/**
 * The catalogue. Later stages accept the outputs of earlier ones **or** imported
 * equivalents, which is what makes entering mid-SDLC work.
 */
export const STAGE_PREREQUISITE_SEEDS: readonly StagePrerequisite[] = [
  {
    stage: 'planning', key: 'project-brief', label: 'Project brief',
    description: 'A description of the business idea, or documents describing it.',
    accepts: [brief('the business brief on a run'), attachments(), documents([DOCUMENT_KINDS.businessBrief], 'a business brief document')],
    required: true,
  },
  {
    stage: 'requirements', key: 'planning-baseline', label: 'Planning baseline or requirements input',
    description: 'The approved feasibility report, or the requirements supplied directly.',
    accepts: [
      documents([DOCUMENT_KINDS.telosReport], 'the TELOS feasibility report'),
      attachments(),
      brief('requirements text on a run'),
    ],
    required: true,
  },
  {
    stage: 'design', key: 'requirements-baseline', label: 'Requirements specification',
    description: 'A requirements specification to design against.',
    accepts: [documents([DOCUMENT_KINDS.requirementsSpec], 'a requirements specification')],
    required: true,
  },
  {
    stage: 'architecture', key: 'design-baseline', label: 'Design specification',
    description: 'A design specification to architect against.',
    accepts: [documents([DOCUMENT_KINDS.designSpec], 'a design specification')],
    required: true,
  },
  {
    stage: 'development', key: 'requirements-approved', label: 'Requirements',
    description: 'Requirements to implement.',
    accepts: [documents([DOCUMENT_KINDS.requirementsSpec], 'a requirements specification')],
    required: true,
  },
  {
    stage: 'development', key: 'design-approved', label: 'Design',
    description: 'Design to implement against.',
    accepts: [documents([DOCUMENT_KINDS.designSpec], 'a design specification')],
    required: true,
  },
  {
    stage: 'development', key: 'architecture-approved', label: 'Architecture',
    description: 'Architecture and technical decisions.',
    accepts: [documents([DOCUMENT_KINDS.architectureSpec], 'an architecture specification')],
    required: true,
  },
  {
    stage: 'development', key: 'tech-stack', label: 'Technology stack',
    description: 'The chosen languages, frameworks and platforms (or the Existing codebase to reverse-engineer).',
    accepts: [documents([DOCUMENT_KINDS.techStack], 'a technology stack document')],
    required: true,
  },
  {
    stage: 'testing', key: 'test-plan', label: 'Test plan',
    description: 'A test plan or acceptance criteria to test against.',
    accepts: [documents([DOCUMENT_KINDS.testPlan], 'a test plan'), documents([DOCUMENT_KINDS.requirementsSpec], 'the requirements specification')],
    required: true,
  },
  {
    stage: 'deployment', key: 'testing-baseline', label: 'Test evidence',
    description: 'Evidence that testing has been planned or completed.',
    accepts: [documents([DOCUMENT_KINDS.testPlan], 'a test plan')],
    required: true,
  },
  {
    stage: 'maintenance', key: 'deployment-baseline', label: 'Deployment plan',
    description: 'The deployment or operations plan.',
    accepts: [documents([DOCUMENT_KINDS.deploymentPlan], 'a deployment plan')],
    required: true,
  },
]

/**
 * Document statuses that count as real evidence.
 *
 * A rejected or superseded document must never satisfy a prerequisite: that would
 * admit exactly the evidence the gate exists to reject (AR-07). Imported documents
 * count, because entering mid-SDLC depends on them.
 */
export const EVIDENCE_DOCUMENT_STATUSES = ['uploaded', 'in_review', 'approved'] as const

/** Run statuses whose brief counts as evidence; a failed run produced nothing. */
export const EVIDENCE_RUN_EXCLUSIONS = ['failed', 'cancelled'] as const

/** What satisfied a prerequisite, for the audit trail. */
export type EvidenceRef =
  | { kind: 'brief'; runId: string }
  | { kind: 'attachment'; count: number }
  | { kind: 'document'; documentId: string; documentKind: string; status: string }
  | { kind: 'waiver'; reason: string; createdAt: string }

/** Evidence available for one project/stage. */
export interface PrerequisiteEvidence {
  /** Latest non-failed run of this stage that carries a brief. */
  brief: { runId: string } | null
  hasBrief: boolean
  attachmentCount: number
  documentKinds: Set<string>
  /** Document kind → the newest acceptable document of that kind. */
  documents: Map<string, { documentId: string; status: string }>
  waivers: Map<string, { reason: string; createdAt: string }>
}

export interface PrerequisiteStatus extends StagePrerequisite {
  satisfied: boolean
  /** How it was satisfied, when it was. */
  via: 'brief' | 'attachment' | 'document' | 'waiver' | null
  detail: string | null
  /** The specific thing that satisfied it, so readiness can be audited. */
  evidence: EvidenceRef | null
}

export interface StageReadiness {
  projectId: string
  stage: ProjectStage
  ready: boolean
  prerequisites: PrerequisiteStatus[]
  missing: Array<{ key: string; label: string; accepts: string[] }>
  /** When it was evaluated; a run snapshots this so the gate can be audited. */
  evaluatedAt: string
}

/** Evaluate one prerequisite against the evidence. Pure. */
export function evaluatePrerequisite(prerequisite: StagePrerequisite, evidence: PrerequisiteEvidence): PrerequisiteStatus {
  const waiver = evidence.waivers.get(prerequisite.key)
  if (waiver !== undefined) {
    return {
      ...prerequisite,
      satisfied: true,
      via: 'waiver',
      detail: `waived: ${waiver.reason}`,
      evidence: { kind: 'waiver', reason: waiver.reason, createdAt: waiver.createdAt },
    }
  }
  for (const source of prerequisite.accepts) {
    if (source.kind === 'brief' && evidence.hasBrief) {
      return {
        ...prerequisite,
        satisfied: true,
        via: 'brief',
        detail: 'a brief was supplied',
        evidence: evidence.brief === null ? null : { kind: 'brief', runId: evidence.brief.runId },
      }
    }
    if (source.kind === 'attachment' && evidence.attachmentCount >= source.min) {
      return {
        ...prerequisite,
        satisfied: true,
        via: 'attachment',
        detail: `${evidence.attachmentCount} attachment(s) uploaded`,
        evidence: { kind: 'attachment', count: evidence.attachmentCount },
      }
    }
    if (source.kind === 'document') {
      // Only a document whose status still counts as evidence may satisfy this.
      const found = source.documentKinds.find((kind) => evidence.documents.has(kind))
      if (found !== undefined) {
        const document = evidence.documents.get(found)!
        return {
          ...prerequisite,
          satisfied: true,
          via: 'document',
          detail: `document kind "${found}" (${document.status})`,
          evidence: { kind: 'document', documentId: document.documentId, documentKind: found, status: document.status },
        }
      }
    }
  }
  return {
    ...prerequisite,
    satisfied: false,
    via: null,
    detail: null,
    evidence: null,
  }
}

export function evaluateStageReadiness(input: {
  projectId: string
  stage: ProjectStage
  catalogue: StagePrerequisite[]
  evidence: PrerequisiteEvidence
  evaluatedAt?: string
}): StageReadiness {
  const prerequisites = input.catalogue
    .filter((prerequisite) => prerequisite.stage === input.stage)
    .map((prerequisite) => evaluatePrerequisite(prerequisite, input.evidence))
  const missing = prerequisites
    .filter((prerequisite) => prerequisite.required && !prerequisite.satisfied)
    .map((prerequisite) => ({
      key: prerequisite.key,
      label: prerequisite.label,
      accepts: prerequisite.accepts.map((source) => source.label),
    }))
  return {
    projectId: input.projectId,
    stage: input.stage,
    ready: missing.length === 0,
    prerequisites,
    missing,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
  }
}

function isProjectStage(value: string): value is ProjectStage {
  return (SDLC_STAGES as readonly string[]).includes(value)
}

export function assertStage(value: string): asserts value is ProjectStage {
  if (!isProjectStage(value)) {
    throw new PrerequisiteError(400, 'INVALID_STAGE', `unknown SDLC stage ${value}`)
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface PrerequisiteStore {
  migrate?(): Promise<void>
  catalogue(stage?: ProjectStage): Promise<StagePrerequisite[]>
  evidence(projectId: string, stage: ProjectStage): Promise<PrerequisiteEvidence>
  addWaiver(input: { projectId: string; stage: ProjectStage; key: string; reason: string }): Promise<void>
  removeWaiver(projectId: string, stage: ProjectStage, key: string): Promise<boolean>
  close?(): Promise<void>
}

interface CatalogueRow {
  stage: string
  key: string
  label: string
  description: string
  accepts: EvidenceSource[]
  required: boolean
}

export class PostgresPrerequisiteStore implements PrerequisiteStore {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = sharedPool(connectionString)
  }

  async migrate(): Promise<void> {
    await runMigrations(this.pool)
    // The catalogue is data, not schema: seeded here so it can be edited later.
    for (const seed of STAGE_PREREQUISITE_SEEDS) {
      await this.pool.query(
        `INSERT INTO stage_prerequisites (stage, key, label, description, accepts, required)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (stage, key) DO NOTHING`,
        [seed.stage, seed.key, seed.label, seed.description, JSON.stringify(seed.accepts), seed.required],
      )
    }
  }


  async catalogue(stage?: ProjectStage): Promise<StagePrerequisite[]> {
    const result = await this.pool.query<CatalogueRow>(
      `SELECT stage, key, label, description, accepts, required
       FROM stage_prerequisites ${stage === undefined ? '' : 'WHERE stage = $1'}
       ORDER BY stage, key`,
      stage === undefined ? [] : [stage],
    )
    const position = (value: ProjectStage): number => SDLC_STAGES.indexOf(value)
    return result.rows
      .map((row) => ({
        stage: row.stage as ProjectStage,
        key: row.key,
        label: row.label,
        description: row.description,
        accepts: Array.isArray(row.accepts) ? row.accepts : [],
        required: row.required,
      }))
      .sort((a, b) => position(a.stage) - position(b.stage) || a.key.localeCompare(b.key))
  }

  async evidence(projectId: string, stage: ProjectStage): Promise<PrerequisiteEvidence> {
    const [brief, attachments, documents, waivers] = await Promise.all([
      // A failed or cancelled run produced nothing, so its brief must not satisfy
      // a prerequisite permanently (AR-07).
      this.pool.query<{ id: string }>(
        `SELECT id FROM project_stage_runs
         WHERE project_id = $1 AND stage = $2
           AND input_text IS NOT NULL AND btrim(input_text) <> ''
           AND status <> ALL($3::text[])
         ORDER BY created_at DESC LIMIT 1`,
        [projectId, stage, [...EVIDENCE_RUN_EXCLUSIONS]],
      ),
      this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM project_attachments
         WHERE project_id = $1 AND (stage IS NULL OR stage = $2)`,
        [projectId, stage],
      ),
      // Take the newest version of each kind first, then require an acceptable
      // status: a rejected newest version must not be bypassed by an older draft.
      this.pool.query<{ kind: string; id: string; status: string }>(
        `SELECT kind, id, status FROM (
           SELECT DISTINCT ON (kind) kind, id, status, version
           FROM project_documents
           WHERE project_id = $1
           ORDER BY kind, version DESC, created_at DESC
         ) newest
         WHERE status = ANY($2::text[])`,
        [projectId, [...EVIDENCE_DOCUMENT_STATUSES]],
      ),
      this.pool.query<{ key: string; reason: string; createdAt: Date | string }>(
        `SELECT key, reason, created_at AS "createdAt" FROM project_stage_evidence
         WHERE project_id = $1 AND stage = $2 AND kind = 'waiver'`,
        [projectId, stage],
      ),
    ])
    const briefRow = brief.rows[0]
    return {
      brief: briefRow === undefined ? null : { runId: briefRow.id },
      hasBrief: briefRow !== undefined,
      attachmentCount: Number(attachments.rows[0]?.count ?? 0),
      documentKinds: new Set(documents.rows.map((row) => row.kind)),
      documents: new Map(documents.rows.map((row) => [row.kind, { documentId: row.id, status: row.status }])),
      waivers: new Map(waivers.rows.map((row) => [
        row.key,
        {
          reason: row.reason,
          createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString(),
        },
      ])),
    }
  }


  async addWaiver(input: { projectId: string; stage: ProjectStage; key: string; reason: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_stage_evidence (project_id, stage, key, kind, reason)
       VALUES ($1, $2, $3, 'waiver', $4)
       ON CONFLICT (project_id, stage, key) DO UPDATE SET reason = EXCLUDED.reason, created_at = now()`,
      [input.projectId, input.stage, input.key, input.reason],
    )
  }

  async removeWaiver(projectId: string, stage: ProjectStage, key: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM project_stage_evidence WHERE project_id = $1 AND stage = $2 AND key = $3 AND kind = 'waiver'`,
      [projectId, stage, key],
    )
    return (result.rowCount ?? 0) > 0
  }

  async close(): Promise<void> {
    // The pool is shared and closed once at shutdown (db.closeSharedPools).
  }
}

/** Readiness for one project/stage. */
export class StagePrerequisiteService {
  private readonly store: PrerequisiteStore

  constructor(store: PrerequisiteStore) {
    this.store = store
  }

  async migrate(): Promise<void> {
    await this.store.migrate?.()
  }

  async catalogue(stage?: ProjectStage): Promise<Array<StagePrerequisite & { stageLabel: string }>> {
    const entries = await this.store.catalogue(stage)
    return entries.map((entry) => ({ ...entry, stageLabel: STAGE_LABELS[entry.stage] }))
  }

  /**
   * `incomingBrief` is the text the caller is about to submit with a new run: it
   * is evidence for this stage even though no run row exists yet.
   */
  async readiness(projectId: string, stage: string, options: { incomingBrief?: boolean } = {}): Promise<StageReadiness> {
    assertStage(stage)
    const [catalogue, stored] = await Promise.all([
      this.store.catalogue(stage),
      this.store.evidence(projectId, stage),
    ])
    const evidence: PrerequisiteEvidence = options.incomingBrief === true
      ? { ...stored, hasBrief: true, brief: stored.brief }
      : stored
    return evaluateStageReadiness({ projectId, stage, catalogue, evidence })
  }

  /** Used by a stage runtime before it starts: throws when required evidence is missing. */
  async ensureReady(projectId: string, stage: ProjectStage, options: { incomingBrief?: boolean } = {}): Promise<StageReadiness> {
    const readiness = await this.readiness(projectId, stage, options)
    if (readiness.ready) return readiness
    const detail = readiness.missing.map((entry) => `${entry.label} (${entry.key})`).join(', ')
    throw new PrerequisiteError(
      409,
      'STAGE_PREREQUISITES_MISSING',
      `the ${stage} stage needs: ${detail}. Provide the evidence or waive it with a reason.`,
    )
  }

  async waive(input: { projectId: string; stage: string; key: string; reason: string }): Promise<StageReadiness> {
    assertStage(input.stage)
    const reason = input.reason.trim()
    if (reason.length < 3) {
      throw new PrerequisiteError(400, 'INVALID_WAIVER_REASON', 'a waiver needs a reason (at least 3 characters)')
    }
    const catalogue = await this.store.catalogue(input.stage)
    if (!catalogue.some((entry) => entry.key === input.key)) {
      throw new PrerequisiteError(404, 'PREREQUISITE_NOT_FOUND', `no prerequisite "${input.key}" for the ${input.stage} stage`)
    }
    await this.store.addWaiver({ projectId: input.projectId, stage: input.stage, key: input.key, reason })
    return this.readiness(input.projectId, input.stage)
  }

  async unwaive(projectId: string, stage: string, key: string): Promise<StageReadiness> {
    assertStage(stage)
    const removed = await this.store.removeWaiver(projectId, stage, key)
    if (!removed) throw new PrerequisiteError(404, 'WAIVER_NOT_FOUND', `no waiver for "${key}" on the ${stage} stage`)
    return this.readiness(projectId, stage)
  }

  async close(): Promise<void> {
    await this.store.close?.()
  }
}
