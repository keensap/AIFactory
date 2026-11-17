/**
 * Project workspace state: SDLC stages, documents, checklist and AI briefings.
 *
 * This is deliberately relational rather than a JSON blob on `projects`.
 * Stage transitions, next actions and document links are all queryable and
 * auditable.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { Pool } from 'pg'
import type { Project } from './projects.ts'
import {
  AttachmentError,
  type ProjectAttachment,
} from './attachments.ts'
import { extractPdfText, MAX_PDF_PAGES } from './pdf.ts'
import { STAGE_DOCUMENT_REQUIREMENTS } from './telos.ts'
import {
  buildFactoryUsage,
  buildProjectStats,
  type DayAggRow,
  type FactoryUsage,
  type ModelAggRow,
  type ProjectAggRow,
  type ProjectStats,
  type StatsRoleRow,
  type StatsRunRow,
  type StatsTokenRow,
  type UsageAggRow,
} from './stats.ts'
import {
  DOCUMENT_CHECKLIST_MAP,
  SDLC_STAGES,
  STAGE_CHECKLISTS,
  STAGE_LABELS,
  isProjectStage,
  nextStage,
  type ChecklistStatus,
  type DocumentStatus,
  type ProjectStage,
  type StageStatus,
} from './sdlc.ts'

export interface StageState {
  stage: ProjectStage
  status: StageStatus
  startedAt: string | null
  completedAt: string | null
  notes: string | null
}

export interface ProjectDocument {
  id: string
  projectId: string
  stage: ProjectStage
  kind: string
  title: string
  storagePath: string
  mimeType: string
  sizeBytes: number
  sha256: string
  status: DocumentStatus
  version: number
  /** Where the PDF export was written, relative to the project root. */
  exportPath?: string | null
  createdAt: string
  updatedAt: string
}

export interface ChecklistItem {
  id: string
  stage: ProjectStage
  key: string
  label: string
  required: boolean
  status: ChecklistStatus
  evidenceDocumentId: string | null
  completedAt: string | null
}

export interface NextAction {
  kind: 'checklist' | 'advance_stage' | 'complete_project'
  stage: ProjectStage
  key: string
  label: string
  required: boolean
}

export interface SdlcStageRecord {
  key: string
  name: string
  position: number
}

export interface ProjectWorkspaceSnapshot {
  currentStage: ProjectStage
  stages: StageState[]
  documents: ProjectDocument[]
  checklist: ChecklistItem[]
  nextActions: NextAction[]
  progress: {
    completedStages: number
    totalStages: number
    completedRequiredItems: number
    totalRequiredItems: number
  }
}

export type StageRunStatus =
  | 'pending'
  | 'analyzing'
  | 'drafting'
  | 'reviewing'
  | 'revising'
  | 'awaiting_human'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type StageReviewDecision = 'approved' | 'needs_revision' | 'rejected'

/**
 * A run waiting for a human answer between roles.
 *
 * `review_changes` asks whether to apply a review's findings; `final` asks
 * whether to stop refining and complete the stage (with go / conditional go /
 * no-go). Both pause the run: it releases its lease and resumes on the answer.
 */
export interface PendingGate {
  kind: 'review_changes' | 'final'
  question: string
  /** Revision cycles completed when the gate was raised. */
  cycle: number
  maxReviewCycles: number
  gateAfterEachReview: boolean
  reviewDecision: string
  findings: unknown[]
  /** Overall document rating from the review, when the reviewer provided one. */
  rating: number | null
  /** Findings by severity. */
  counts: { blockers: number; major: number; minor: number }
  /** Whether the review met the acceptance criteria (the run could stop). */
  accepted: boolean
  /** The criteria in force when the gate was raised. */
  criteria: { minRating: number; maxBlockers: number; maxMajor: number }
  waitingSince: string
}

export interface StageRun {
  id: string
  projectId: string
  stage: ProjectStage
  attempt: number
  sessionId: string | null
  status: StageRunStatus
  contextHash: string | null
  context: unknown
  inputText: string | null
  analysisMarkdown: string | null
  draftMarkdown: string | null
  summaryMarkdown: string | null
  /** The question a paused run is waiting on, or null when it is not paused. */
  pendingGate: PendingGate | null
  /** Revision cycles applied so far (counted after the first review). */
  reviewCycles: number
  startedAt: string | null
  completedAt: string | null
  lockedBy: string | null
  leaseExpiresAt: string | null
  executionAttempts: number
  createdAt: string
  updatedAt: string
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface StageRunEvent {
  id: string
  projectId: string
  stageRunId: string
  role: string | null
  agentId: string | null
  type: string
  phase: string | null
  level: LogLevel
  payload: unknown
  createdAt: string
}

export interface ProjectLog extends StageRunEvent {
  stage: ProjectStage
  attempt: number
  message: string
  preview: string | null
}

export interface StageRunEventInput {
  projectId: string
  stageRunId: string
  role?: string | null
  agentId?: string | null
  type: string
  phase?: string | null
  level?: LogLevel
  payload: unknown
}

export interface StageReview {
  id: string
  stageRunId: string
  reviewerRole: string
  decision: StageReviewDecision
  findings: unknown[]
  createdAt: string
}

export interface StageRunDetail extends StageRun {
  reviews: StageReview[]
  documents: ProjectDocument[]
}

export interface StageRunPatch {
  pendingGate?: PendingGate | null
  reviewCycles?: number
  status?: StageRunStatus
  sessionId?: string | null
  summaryMarkdown?: string | null
  analysisMarkdown?: string | null
  draftMarkdown?: string | null
  contextHash?: string | null
}

export interface ProjectBriefing {
  projectId: string
  inputHash: string
  markdown: string
  risks: string[]
  generatedAt: string
  model: string | null
}

export class WorkspaceError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'WorkspaceError'
    this.status = status
    this.code = code
  }
}

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
const DOCUMENT_STATUSES: DocumentStatus[] = ['uploaded', 'in_review', 'approved', 'rejected', 'superseded']
const CHECKLIST_STATUSES: ChecklistStatus[] = ['open', 'done', 'waived']
const STAGE_RUN_STATUSES: StageRunStatus[] = [
  'pending', 'analyzing', 'drafting', 'reviewing', 'revising',
  'awaiting_human', 'completed', 'failed', 'cancelled',
]
const STAGE_REVIEW_DECISIONS: StageReviewDecision[] = ['approved', 'needs_revision', 'rejected']
const STAGE_RUN_ACTIVE_STATUSES = ['analyzing', 'drafting', 'reviewing', 'revising'] as const

export class PostgresProjectWorkspace {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 })
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS current_stage TEXT NOT NULL DEFAULT 'planning';
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS stage_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

      CREATE TABLE IF NOT EXISTS sdlc_stages (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS project_stages (
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'not_started'
          CHECK (status IN ('not_started', 'in_progress', 'completed', 'blocked', 'skipped')),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        notes TEXT,
        PRIMARY KEY (project_id, stage)
      );

      CREATE TABLE IF NOT EXISTS project_stage_runs (
        id UUID PRIMARY KEY,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN (
            'pending', 'analyzing', 'drafting', 'reviewing', 'revising',
            'awaiting_human', 'completed', 'failed', 'cancelled'
          )),
        pending_gate JSONB,
        review_cycles INTEGER NOT NULL DEFAULT 0,
        context_hash TEXT,
        context_json JSONB,
        input_text TEXT,
        analysis_markdown TEXT,
        draft_markdown TEXT,
        summary_markdown TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        locked_by TEXT,
        lease_expires_at TIMESTAMPTZ,
        execution_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS project_documents (
        id UUID PRIMARY KEY,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'uploaded'
          CHECK (status IN ('uploaded', 'in_review', 'approved', 'rejected', 'superseded')),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      ALTER TABLE project_stage_runs
        ADD COLUMN IF NOT EXISTS context_json JSONB;
      ALTER TABLE project_stage_runs
        ADD COLUMN IF NOT EXISTS input_text TEXT;
      ALTER TABLE project_stage_runs
        ADD COLUMN IF NOT EXISTS analysis_markdown TEXT;
      ALTER TABLE project_stage_runs
        ADD COLUMN IF NOT EXISTS draft_markdown TEXT;
      ALTER TABLE project_stage_runs
        ADD COLUMN IF NOT EXISTS locked_by TEXT;
      ALTER TABLE project_stage_runs
        ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
      ALTER TABLE project_stage_runs
        ADD COLUMN IF NOT EXISTS execution_attempts INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE project_documents
        ADD COLUMN IF NOT EXISTS stage_run_id UUID REFERENCES project_stage_runs(id) ON DELETE SET NULL;
      ALTER TABLE project_documents
        ADD COLUMN IF NOT EXISTS parent_document_id UUID REFERENCES project_documents(id) ON DELETE SET NULL;

      CREATE TABLE IF NOT EXISTS project_checklist_items (
        id UUID PRIMARY KEY,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        required BOOLEAN NOT NULL DEFAULT true,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK (status IN ('open', 'done', 'waived')),
        evidence_document_id UUID REFERENCES project_documents(id) ON DELETE SET NULL,
        completed_at TIMESTAMPTZ,
        active BOOLEAN NOT NULL DEFAULT true,
        UNIQUE (project_id, stage, key)
      );

      ALTER TABLE project_checklist_items
        ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

      CREATE TABLE IF NOT EXISTS project_briefings (
        project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        input_hash TEXT NOT NULL,
        markdown TEXT NOT NULL,
        risks JSONB NOT NULL DEFAULT '[]'::jsonb,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        model TEXT
      );

      CREATE TABLE IF NOT EXISTS stage_reviews (
        id UUID PRIMARY KEY,
        stage_run_id UUID NOT NULL REFERENCES project_stage_runs(id) ON DELETE CASCADE,
        reviewer_role TEXT NOT NULL,
        decision TEXT NOT NULL
          CHECK (decision IN ('approved', 'needs_revision', 'rejected')),
        findings JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS stage_run_events (
        id BIGSERIAL PRIMARY KEY,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stage_run_id UUID NOT NULL REFERENCES project_stage_runs(id) ON DELETE CASCADE,
        role TEXT,
        agent_id TEXT,
        type TEXT NOT NULL,
        phase TEXT,
        level TEXT NOT NULL DEFAULT 'info'
          CHECK (level IN ('debug', 'info', 'warn', 'error')),
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      ALTER TABLE stage_run_events
        ADD COLUMN IF NOT EXISTS level TEXT NOT NULL DEFAULT 'info';

      CREATE TABLE IF NOT EXISTS stage_document_requirements (
        stage TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        cardinality TEXT NOT NULL DEFAULT 'one'
          CHECK (cardinality IN ('one', 'many')),
        required BOOLEAN NOT NULL DEFAULT true,
        template_markdown TEXT,
        PRIMARY KEY (stage, kind)
      );

      CREATE TABLE IF NOT EXISTS stage_role_configs (
        role TEXT PRIMARY KEY,
        agent_preset TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        reasoning_effort TEXT,
        max_tokens INTEGER,
        temperature NUMERIC,
        skills JSONB NOT NULL DEFAULT '[]'::jsonb,
        tools JSONB NOT NULL DEFAULT '[]'::jsonb,
        system_prompt TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS project_role_overrides (
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        config JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, role)
      );

      -- Requester-supplied stage inputs (PDF only). Text is extracted at upload.
      CREATE TABLE IF NOT EXISTS project_attachments (
        id UUID PRIMARY KEY,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stage TEXT,
        kind TEXT NOT NULL DEFAULT 'input',
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        text_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        sha256 TEXT NOT NULL,
        pages INTEGER NOT NULL DEFAULT 0,
        characters INTEGER NOT NULL DEFAULT 0,
        truncated BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Which inputs a stage run consumed, so a re-run can reuse the same set.
      CREATE TABLE IF NOT EXISTS stage_run_attachments (
        stage_run_id UUID NOT NULL REFERENCES project_stage_runs(id) ON DELETE CASCADE,
        attachment_id UUID NOT NULL REFERENCES project_attachments(id) ON DELETE CASCADE,
        PRIMARY KEY (stage_run_id, attachment_id)
      );

      -- Exported PDFs live outside .aifactory, in the project's own documents tree.
      CREATE TABLE IF NOT EXISTS stage_document_exports (
        document_id UUID PRIMARY KEY REFERENCES project_documents(id) ON DELETE CASCADE,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        bytes BIGINT NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Review gating columns are added by ensureColumn() below: an unconditional
      -- ALTER takes an exclusive lock on every startup, which stalls parallel migrations.

      CREATE TABLE IF NOT EXISTS project_stage_settings (
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        gate_after_each_review BOOLEAN NOT NULL,
        max_review_cycles INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, stage)
      );

      CREATE INDEX IF NOT EXISTS project_attachments_project_idx ON project_attachments (project_id, stage, created_at DESC);
      CREATE INDEX IF NOT EXISTS project_documents_project_idx ON project_documents (project_id, stage);
      CREATE INDEX IF NOT EXISTS project_checklist_project_idx ON project_checklist_items (project_id, stage);
      CREATE INDEX IF NOT EXISTS project_stage_runs_project_stage_idx ON project_stage_runs (project_id, stage, created_at DESC);
      CREATE INDEX IF NOT EXISTS project_stage_runs_lease_idx ON project_stage_runs (lease_expires_at)
        WHERE status IN ('analyzing', 'drafting', 'reviewing', 'revising');
      CREATE INDEX IF NOT EXISTS stage_reviews_run_idx ON stage_reviews (stage_run_id, created_at);
      CREATE INDEX IF NOT EXISTS stage_run_events_run_idx ON stage_run_events (stage_run_id, id);
    `)

    await this.ensureColumn('project_stage_runs', 'pending_gate', 'JSONB')
    await this.ensureColumn('project_stage_runs', 'review_cycles', 'INTEGER NOT NULL DEFAULT 0')

    for (const [position, stage] of SDLC_STAGES.entries()) {
      await this.pool.query(
        `INSERT INTO sdlc_stages (key, name, position)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO NOTHING`,
        [stage, STAGE_LABELS[stage], position],
      )
    }

    // Preserve a custom rename, but migrate the original default label.
    await this.pool.query(
      `UPDATE sdlc_stages SET name = $2, updated_at = now()
       WHERE key = $1 AND name = 'Planning'`,
      ['planning', STAGE_LABELS.planning],
    )

    for (const requirement of STAGE_DOCUMENT_REQUIREMENTS) {
      await this.pool.query(
        `INSERT INTO stage_document_requirements
           (stage, kind, label, description, cardinality, required, template_markdown)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (stage, kind) DO UPDATE
           SET template_markdown = COALESCE(stage_document_requirements.template_markdown, EXCLUDED.template_markdown)`,
        [
          requirement.stage,
          requirement.kind,
          requirement.label,
          requirement.description,
          requirement.cardinality,
          requirement.required,
          requirement.templateMarkdown ?? null,
        ],
      )
    }

    const projects = await this.pool.query<{ id: string }>('SELECT id FROM projects')
    for (const project of projects.rows) await this.ensureProject(project.id)
  }

  async listSdlcStages(): Promise<SdlcStageRecord[]> {
    const result = await this.pool.query<SdlcStageRecord>(
      'SELECT key, name, position FROM sdlc_stages ORDER BY position',
    )
    return result.rows
  }

  /** Create any missing stage/checklist rows. Safe to call on every read. */
  async ensureProject(projectId: string): Promise<void> {
    const project = await this.pool.query<{ currentStage: string }>(
      `SELECT current_stage AS "currentStage" FROM projects WHERE id = $1`,
      [projectId],
    )
    const row = project.rows[0]
    if (row === undefined) throw new WorkspaceError(404, 'PROJECT_NOT_FOUND', 'project was not found')

    const currentStage = isProjectStage(row.currentStage) ? row.currentStage : 'planning'
    const currentIndex = SDLC_STAGES.indexOf(currentStage)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const [index, stage] of SDLC_STAGES.entries()) {
        await client.query(
          `INSERT INTO project_stages (project_id, stage, status, started_at)
           VALUES ($1, $2, $3, CASE WHEN $3 = 'in_progress' THEN now() ELSE NULL END)
           ON CONFLICT (project_id, stage) DO NOTHING`,
          [projectId, stage, index === currentIndex ? 'in_progress' : index < currentIndex ? 'completed' : 'not_started'],
        )
        const definitions = STAGE_CHECKLISTS[stage]
        const activeKeys = definitions.map((item) => item.key)
        await client.query(
          `UPDATE project_checklist_items
           SET active = (key = ANY($3::text[]))
           WHERE project_id = $1 AND stage = $2`,
          [projectId, stage, activeKeys],
        )
        for (const item of definitions) {
          await client.query(
            `INSERT INTO project_checklist_items
               (id, project_id, stage, key, label, required, status, completed_at, active)
             VALUES ($1, $2, $3, $4, $5, $6, 'open', NULL, true)
             ON CONFLICT (project_id, stage, key) DO UPDATE
               SET label = EXCLUDED.label,
                   required = EXCLUDED.required,
                   active = true`,
            [randomUUID(), projectId, stage, item.key, item.label, item.required],
          )
        }
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Add a column only when it is missing.
   *
   * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` still takes an ACCESS EXCLUSIVE
   * lock even when the column exists, so running it on every startup serialises
   * concurrent migrations. A catalog lookup is cheap and lock-free.
   */
  private async ensureColumn(table: string, column: string, definition: string): Promise<void> {
    const existing = await this.pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      [table, column],
    )
    if ((existing.rowCount ?? 0) > 0) return
    // Identifiers and the definition come from code, never from user input.
    await this.pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`)
  }

  async getSnapshot(projectId: string): Promise<ProjectWorkspaceSnapshot> {
    await this.ensureProject(projectId)
    const stages = await this.pool.query<StageRow>(
      `SELECT stage, status, started_at AS "startedAt", completed_at AS "completedAt", notes
       FROM project_stages WHERE project_id = $1`,
      [projectId],
    )
    const documents = await this.listDocuments(projectId)
    const checklist = await this.pool.query<ChecklistRow>(
      `SELECT id, stage, key, label, required, status,
              evidence_document_id AS "evidenceDocumentId", completed_at AS "completedAt"
       FROM project_checklist_items WHERE project_id = $1 AND active = true ORDER BY stage, key`,
      [projectId],
    )
    const project = await this.pool.query<{ currentStage: string }>(
      `SELECT current_stage AS "currentStage" FROM projects WHERE id = $1`,
      [projectId],
    )
    const currentStage = normalizeStage(project.rows[0]?.currentStage)
    const stageRows = SDLC_STAGES.map((stage) => {
      const found = stages.rows.find((item) => item.stage === stage)
      return {
        stage,
        status: found?.status ?? 'not_started',
        startedAt: toIsoOrNull(found?.startedAt),
        completedAt: toIsoOrNull(found?.completedAt),
        notes: found?.notes ?? null,
      } satisfies StageState
    })

    const nextActions = buildNextActions(currentStage, stageRows, checklist.rows)
    const completedStages = stageRows.filter((stage) => stage.status === 'completed').length
    const required = checklist.rows.filter((item) => item.required)
    return {
      currentStage,
      stages: stageRows,
      documents,
      checklist: checklist.rows.map((item) => ({
        id: item.id,
        stage: normalizeStage(item.stage),
        key: item.key,
        label: item.label,
        required: item.required,
        status: item.status,
        evidenceDocumentId: item.evidenceDocumentId,
        completedAt: toIsoOrNull(item.completedAt),
      })),
      nextActions,
      progress: {
        completedStages,
        totalStages: SDLC_STAGES.length,
        completedRequiredItems: required.filter((item) => item.status !== 'open').length,
        totalRequiredItems: required.length,
      },
    }
  }

  async listDocuments(projectId: string): Promise<ProjectDocument[]> {
    const result = await this.pool.query<DocumentRow>(
      `SELECT id, project_id AS "projectId", stage, kind, title,
              storage_path AS "storagePath", mime_type AS "mimeType",
              size_bytes AS "sizeBytes", sha256, status, version,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM project_documents WHERE project_id = $1
       ORDER BY created_at DESC`,
      [projectId],
    )
    return result.rows.map(mapDocument)
  }

  async getDocument(projectId: string, documentId: string): Promise<ProjectDocument | undefined> {
    const result = await this.pool.query<DocumentRow>(
      `SELECT id, project_id AS "projectId", stage, kind, title,
              storage_path AS "storagePath", mime_type AS "mimeType",
              size_bytes AS "sizeBytes", sha256, status, version,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM project_documents WHERE project_id = $1 AND id = $2`,
      [projectId, documentId],
    )
    return result.rows[0] === undefined ? undefined : mapDocument(result.rows[0])
  }

  /**
   * Store a requester-supplied PDF and extract its text once.
   *
   * The original file and the extracted text are kept together under
   * `.aifactory/attachments/<id>/`, so a stage run reads text without paying for
   * extraction again and the same input can be re-used by a later run.
   */
  async addAttachment(input: {
    project: Project
    stage?: ProjectStage | null
    title?: string
    filename: string
    mimeType: string
    buffer: Uint8Array
  }): Promise<ProjectAttachment> {
    if (input.stage !== undefined && input.stage !== null && !isProjectStage(input.stage)) {
      throw new AttachmentError(400, 'INVALID_STAGE', `unknown SDLC stage ${input.stage}`)
    }

    const id = randomUUID()
    const safeName = basename(input.filename).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'attachment.pdf'
    const directory = join('.aifactory', 'attachments', id)
    const storagePath = join(directory, safeName)
    const textPath = join(directory, 'text.txt')
    const root = resolve(input.project.rootPath)
    const absolute = resolve(root, storagePath)
    if (!absolute.startsWith(`${root}/`)) {
      throw new AttachmentError(400, 'INVALID_ATTACHMENT_PATH', 'attachment path escapes the project root')
    }

    const extracted = await extractPdfText(input.buffer, { maxPages: MAX_PDF_PAGES })
    await mkdir(resolve(root, directory), { recursive: true })
    await writeFile(absolute, input.buffer, { flag: 'wx' })
    await writeFile(resolve(root, textPath), extracted.text, { encoding: 'utf8', flag: 'wx' })
    const sha256 = createHash('sha256').update(input.buffer).digest('hex')

    const result = await this.pool.query<AttachmentRow>(
      `INSERT INTO project_attachments
         (id, project_id, stage, kind, title, filename, storage_path, text_path, mime_type,
          size_bytes, sha256, pages, characters, truncated)
       VALUES ($1, $2, $3, 'input', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${ATTACHMENT_COLUMNS}`,
      [
        id,
        input.project.id,
        input.stage ?? null,
        input.title ?? input.filename.replace(/\.pdf$/i, ''),
        input.filename,
        storagePath,
        textPath,
        input.mimeType,
        input.buffer.byteLength,
        sha256,
        extracted.pages,
        extracted.characters,
        extracted.truncated,
      ],
    )
    return mapAttachment(result.rows[0]!)
  }

  async listAttachments(projectId: string, stage?: ProjectStage): Promise<ProjectAttachment[]> {
    const result = await this.pool.query<AttachmentRow>(
      `SELECT ${ATTACHMENT_COLUMNS} FROM project_attachments
       WHERE project_id = $1 ${stage === undefined ? '' : 'AND (stage = $2 OR stage IS NULL)'}
       ORDER BY created_at DESC`,
      stage === undefined ? [projectId] : [projectId, stage],
    )
    return result.rows.map(mapAttachment)
  }

  async getAttachment(projectId: string, id: string): Promise<ProjectAttachment | undefined> {
    const result = await this.pool.query<AttachmentRow>(
      `SELECT ${ATTACHMENT_COLUMNS} FROM project_attachments WHERE project_id = $1 AND id = $2`,
      [projectId, id],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : mapAttachment(row)
  }

  async deleteAttachment(projectId: string, id: string, rootPath: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM project_attachments WHERE project_id = $1 AND id = $2', [projectId, id])
    if ((result.rowCount ?? 0) === 0) return false
    await rm(resolve(rootPath, '.aifactory', 'attachments', id), { recursive: true, force: true }).catch(() => {})
    return true
  }

  /** Read an attachment's extracted text (empty when the file is gone). */
  async readAttachmentText(attachment: ProjectAttachment, rootPath: string): Promise<string> {
    try {
      return await readFile(resolve(rootPath, attachment.textPath), 'utf8')
    } catch {
      return ''
    }
  }

  /** Attach inputs to a stage run; ignores ids already linked. */
  async linkRunAttachments(stageRunId: string, attachmentIds: string[]): Promise<void> {
    for (const attachmentId of attachmentIds) {
      await this.pool.query(
        `INSERT INTO stage_run_attachments (stage_run_id, attachment_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [stageRunId, attachmentId],
      )
    }
  }

  async listRunAttachments(stageRunId: string): Promise<ProjectAttachment[]> {
    const result = await this.pool.query<AttachmentRow>(
      `SELECT ${ATTACHMENT_COLUMNS} FROM project_attachments a
       JOIN stage_run_attachments l ON l.attachment_id = a.id
       WHERE l.stage_run_id = $1
       ORDER BY a.created_at ASC`,
      [stageRunId],
    )
    return result.rows.map(mapAttachment)
  }

  /** Record where a stage document was exported, for the API and re-export. */
  async recordDocumentExport(input: { documentId: string; projectId: string; path: string; bytes: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO stage_document_exports (document_id, project_id, path, bytes, generated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (document_id) DO UPDATE SET path = EXCLUDED.path, bytes = EXCLUDED.bytes, generated_at = now()`,
      [input.documentId, input.projectId, input.path, input.bytes],
    )
  }

  async listDocumentExports(documentIds: string[]): Promise<Map<string, { path: string; bytes: number; generatedAt: string }>> {
    const out = new Map<string, { path: string; bytes: number; generatedAt: string }>()
    if (documentIds.length === 0) return out
    const result = await this.pool.query<{ documentId: string; path: string; bytes: string; generatedAt: Date | string }>(
      `SELECT document_id AS "documentId", path, bytes, generated_at AS "generatedAt"
       FROM stage_document_exports WHERE document_id = ANY($1::uuid[])`,
      [documentIds],
    )
    for (const row of result.rows) {
      out.set(row.documentId, { path: row.path, bytes: Number(row.bytes), generatedAt: toIso(row.generatedAt) })
    }
    return out
  }

  async addDocument(input: {
    project: Project
    stage: ProjectStage
    kind: string
    title: string
    filename: string
    mimeType: string
    buffer: Uint8Array
    stageRunId?: string | null
    parentDocumentId?: string | null
    /**
     * Complete the owning run in the same transaction as the document, so a
     * partial failure cannot leave a document without a completed run (or the
     * reverse). Requires `stageRunId`.
     */
    completeRun?: { summaryMarkdown: string }
  }): Promise<ProjectDocument> {
    if (input.buffer.byteLength > MAX_DOCUMENT_BYTES) {
      throw new WorkspaceError(413, 'DOCUMENT_TOO_LARGE', `document exceeds ${MAX_DOCUMENT_BYTES} bytes`)
    }
    if (!isProjectStage(input.stage)) {
      throw new WorkspaceError(400, 'INVALID_STAGE', `unknown SDLC stage ${input.stage}`)
    }

    const id = randomUUID()
    const safeName = basename(input.filename).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'document.pdf'
    const relativePath = join('.aifactory', 'documents', input.stage, `${id}-${safeName}`)
    const absolutePath = resolve(input.project.rootPath, relativePath)
    const root = resolve(input.project.rootPath)
    if (!absolutePath.startsWith(`${root}/`)) {
      throw new WorkspaceError(400, 'INVALID_DOCUMENT_PATH', 'document path escapes the project root')
    }

    await mkdir(join(input.project.rootPath, '.aifactory', 'documents', input.stage), { recursive: true })
    await writeFile(absolutePath, input.buffer, { flag: 'wx' })
    const sha256 = createHash('sha256').update(input.buffer).digest('hex')

    try {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        const result = await client.query<DocumentRow>(
          `INSERT INTO project_documents
             (id, project_id, stage, kind, title, storage_path, mime_type, size_bytes, sha256, status,
              stage_run_id, parent_document_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'uploaded', $10, $11)
           RETURNING id, project_id AS "projectId", stage, kind, title,
                     storage_path AS "storagePath", mime_type AS "mimeType",
                     size_bytes AS "sizeBytes", sha256, status, version,
                     created_at AS "createdAt", updated_at AS "updatedAt"`,
          [
            id,
            input.project.id,
            input.stage,
            input.kind,
            input.title,
            relativePath,
            input.mimeType,
            input.buffer.byteLength,
            sha256,
            input.stageRunId ?? null,
            input.parentDocumentId ?? null,
          ],
        )
        if (input.completeRun !== undefined) {
          if (input.stageRunId === undefined || input.stageRunId === null) {
            throw new WorkspaceError(400, 'INVALID_COMPLETION', 'completeRun requires stageRunId')
          }
          // The document is the artifact of an approved decision, so it is
          // approved, its checklist evidence is set, and the run completes here.
          await client.query(`UPDATE project_documents SET status = 'approved', updated_at = now() WHERE id = $1`, [id])
          const completed = await client.query(
            `UPDATE project_stage_runs
             SET status = 'completed', pending_gate = NULL, summary_markdown = $2,
                 completed_at = now(), updated_at = now(),
                 locked_by = NULL, lease_expires_at = NULL
             WHERE id = $1 AND status <> 'completed'
             RETURNING id`,
            [input.stageRunId, input.completeRun.summaryMarkdown],
          )
          if ((completed.rowCount ?? 0) === 0) {
            throw new WorkspaceError(409, 'STAGE_RUN_NOT_COMPLETABLE', 'the stage run is already completed')
          }
        }
        const checklistKey = DOCUMENT_CHECKLIST_MAP[input.kind]
        if (checklistKey !== undefined) {
          await client.query(
            `UPDATE project_checklist_items
             SET status = 'done', completed_at = now(), evidence_document_id = $1
             WHERE project_id = $2 AND stage = $3 AND key = $4 AND status = 'open' AND active = true`,
            [id, input.project.id, input.stage, checklistKey],
          )
        }
        if (input.completeRun !== undefined) {
          for (const key of ['business_idea', 'stakeholder_goals', 'feasibility_decision']) {
            await client.query(
              `UPDATE project_checklist_items
               SET status = 'done', completed_at = COALESCE(completed_at, now()), evidence_document_id = $1
               WHERE project_id = $2 AND stage = $3 AND key = $4 AND active = true`,
              [id, input.project.id, input.stage, key],
            )
          }
        }
        await client.query('COMMIT')
        return mapDocument(result.rows[0]!)
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      await unlink(absolutePath).catch(() => {})
      throw error
    }
  }

  async updateDocumentStatus(
    projectId: string,
    documentId: string,
    status: unknown,
  ): Promise<ProjectDocument> {
    if (typeof status !== 'string' || !DOCUMENT_STATUSES.includes(status as DocumentStatus)) {
      throw new WorkspaceError(400, 'INVALID_DOCUMENT_STATUS', `status must be one of ${DOCUMENT_STATUSES.join(', ')}`)
    }
    const result = await this.pool.query<DocumentRow>(
      `UPDATE project_documents SET status = $3, updated_at = now()
       WHERE project_id = $1 AND id = $2
       RETURNING id, project_id AS "projectId", stage, kind, title,
                 storage_path AS "storagePath", mime_type AS "mimeType",
                 size_bytes AS "sizeBytes", sha256, status, version,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [projectId, documentId, status],
    )
    if (result.rows[0] === undefined) throw new WorkspaceError(404, 'DOCUMENT_NOT_FOUND', 'document not found')
    return mapDocument(result.rows[0])
  }

  async updateChecklistItem(
    projectId: string,
    stage: string,
    key: string,
    status: unknown,
    evidenceDocumentId?: string | null,
  ): Promise<ChecklistItem> {
    if (!isProjectStage(stage)) {
      throw new WorkspaceError(400, 'INVALID_STAGE', `unknown SDLC stage ${stage}`)
    }
    if (typeof status !== 'string' || !CHECKLIST_STATUSES.includes(status as ChecklistStatus)) {
      throw new WorkspaceError(400, 'INVALID_CHECKLIST_STATUS', `status must be one of ${CHECKLIST_STATUSES.join(', ')}`)
    }
    const result = await this.pool.query<ChecklistRow>(
      `UPDATE project_checklist_items
       SET status = $4,
           completed_at = CASE WHEN $4 IN ('done','waived') THEN now() ELSE NULL END,
           evidence_document_id = COALESCE($5, evidence_document_id)
       WHERE project_id = $1 AND stage = $2 AND key = $3 AND active = true
       RETURNING id, stage, key, label, required, status,
                 evidence_document_id AS "evidenceDocumentId", completed_at AS "completedAt"`,
      [projectId, stage, key, status, evidenceDocumentId ?? null],
    )
    if (result.rows[0] === undefined) throw new WorkspaceError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'checklist item not found')
    return mapChecklist(result.rows[0])
  }

  async advanceStage(projectId: string, targetStage: string): Promise<ProjectWorkspaceSnapshot> {
    if (!isProjectStage(targetStage)) {
      throw new WorkspaceError(400, 'INVALID_STAGE', `unknown SDLC stage ${targetStage}`)
    }
    await this.ensureProject(projectId)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const project = await client.query<{ currentStage: string }>(
        `SELECT current_stage AS "currentStage" FROM projects WHERE id = $1 FOR UPDATE`,
        [projectId],
      )
      const current = normalizeStage(project.rows[0]?.currentStage)
      if (targetStage === current) {
        await client.query('COMMIT')
        return await this.getSnapshot(projectId)
      }
      if (nextStage(current) !== targetStage) {
        throw new WorkspaceError(
          409,
          'INVALID_STAGE_TRANSITION',
          `the next stage after ${current} is ${nextStage(current) ?? '(none)'}`,
        )
      }

      const open = await client.query<{ label: string }>(
        `SELECT label FROM project_checklist_items
         WHERE project_id = $1 AND stage = $2 AND required = true AND status = 'open' AND active = true
         ORDER BY key`,
        [projectId, current],
      )
      if (open.rows.length > 0) {
        throw new WorkspaceError(
          409,
          'STAGE_CHECKLIST_INCOMPLETE',
          `complete required items for ${current}: ${open.rows.map((row) => row.label).join('; ')}`,
        )
      }

      await client.query(
        `UPDATE project_stages SET status = 'completed', completed_at = now()
         WHERE project_id = $1 AND stage = $2`,
        [projectId, current],
      )
      await client.query(
        `UPDATE project_stages SET status = 'in_progress', started_at = COALESCE(started_at, now())
         WHERE project_id = $1 AND stage = $2`,
        [projectId, targetStage],
      )
      await client.query(
        `UPDATE projects SET current_stage = $2, stage_updated_at = now(), updated_at = now()
         WHERE id = $1`,
        [projectId, targetStage],
      )
      await client.query('COMMIT')
      return await this.getSnapshot(projectId)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async createStageRun(input: {
    projectId: string
    stage: ProjectStage
    inputText?: string | null
    context: unknown
    contextHash: string
  }): Promise<StageRun> {
    if (!isProjectStage(input.stage)) {
      throw new WorkspaceError(400, 'INVALID_STAGE', `unknown SDLC stage ${input.stage}`)
    }
    await this.ensureProject(input.projectId)
    const result = await this.pool.query<StageRunRow>(
      `INSERT INTO project_stage_runs
         (id, project_id, stage, attempt, status, context_hash, context_json, input_text)
       VALUES (
         $1, $2, $3,
         COALESCE((SELECT max(attempt) + 1 FROM project_stage_runs WHERE project_id = $2 AND stage = $3), 1),
         'pending', $4, $5::jsonb, $6
       )
       RETURNING id, project_id AS "projectId", stage, attempt, session_id AS "sessionId",
                 status, context_hash AS "contextHash", context_json AS "context",
                 input_text AS "inputText", analysis_markdown AS "analysisMarkdown",
                 draft_markdown AS "draftMarkdown", summary_markdown AS "summaryMarkdown",
              pending_gate AS "pendingGate", review_cycles AS "reviewCycles",
                 started_at AS "startedAt", completed_at AS "completedAt",
                 locked_by AS "lockedBy", lease_expires_at AS "leaseExpiresAt",
                 execution_attempts AS "executionAttempts",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        randomUUID(),
        input.projectId,
        input.stage,
        input.contextHash,
        JSON.stringify(input.context),
        input.inputText ?? null,
      ],
    )
    return mapStageRun(result.rows[0]!)
  }

  async getStageRun(runId: string): Promise<StageRun | undefined> {
    const result = await this.pool.query<StageRunRow>(
      `SELECT id, project_id AS "projectId", stage, attempt, session_id AS "sessionId",
              status, context_hash AS "contextHash", context_json AS "context",
              input_text AS "inputText", analysis_markdown AS "analysisMarkdown",
              draft_markdown AS "draftMarkdown", summary_markdown AS "summaryMarkdown",
              pending_gate AS "pendingGate", review_cycles AS "reviewCycles",
              started_at AS "startedAt", completed_at AS "completedAt",
              locked_by AS "lockedBy", lease_expires_at AS "leaseExpiresAt",
              execution_attempts AS "executionAttempts",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM project_stage_runs WHERE id = $1`,
      [runId],
    )
    return result.rows[0] === undefined ? undefined : mapStageRun(result.rows[0])
  }

  async listStageRuns(projectId: string, stage: ProjectStage): Promise<StageRun[]> {
    const result = await this.pool.query<StageRunRow>(
      `SELECT id, project_id AS "projectId", stage, attempt, session_id AS "sessionId",
              status, context_hash AS "contextHash", context_json AS "context",
              input_text AS "inputText", analysis_markdown AS "analysisMarkdown",
              draft_markdown AS "draftMarkdown", summary_markdown AS "summaryMarkdown",
              pending_gate AS "pendingGate", review_cycles AS "reviewCycles",
              started_at AS "startedAt", completed_at AS "completedAt",
              locked_by AS "lockedBy", lease_expires_at AS "leaseExpiresAt",
              execution_attempts AS "executionAttempts",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM project_stage_runs
       WHERE project_id = $1 AND stage = $2
       ORDER BY created_at DESC`,
      [projectId, stage],
    )
    return result.rows.map(mapStageRun)
  }

  async claimStageRun(runId: string, workerId: string, leaseMs: number): Promise<StageRun | undefined> {
    if (workerId.trim() === '') throw new WorkspaceError(400, 'INVALID_WORKER_ID', 'workerId must not be empty')
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new WorkspaceError(400, 'INVALID_LEASE', 'leaseMs must be a positive integer')
    }
    const result = await this.pool.query<StageRunRow>(
      `UPDATE project_stage_runs
       SET locked_by = $1,
           lease_expires_at = now() + ($3::int * interval '1 millisecond'),
           execution_attempts = execution_attempts + 1,
           updated_at = now()
       WHERE id = $2
         -- awaiting_human is claimable: a run pauses at a review/final gate and
         -- resumes when the answer arrives (the runtime decides which endpoint may resume it).
         AND status NOT IN ('completed', 'failed', 'cancelled')
         AND (locked_by IS NULL OR lease_expires_at IS NULL OR lease_expires_at < now())
       RETURNING id, project_id AS "projectId", stage, attempt, session_id AS "sessionId",
                 status, context_hash AS "contextHash", context_json AS "context",
                 input_text AS "inputText", analysis_markdown AS "analysisMarkdown",
                 draft_markdown AS "draftMarkdown", summary_markdown AS "summaryMarkdown",
              pending_gate AS "pendingGate", review_cycles AS "reviewCycles",
                 started_at AS "startedAt", completed_at AS "completedAt",
                 locked_by AS "lockedBy", lease_expires_at AS "leaseExpiresAt",
                 execution_attempts AS "executionAttempts",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [workerId, runId, leaseMs],
    )
    return result.rows[0] === undefined ? undefined : mapStageRun(result.rows[0])
  }

  async heartbeatStageRun(runId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE project_stage_runs
       SET lease_expires_at = now() + ($3::int * interval '1 millisecond'),
           updated_at = now()
       WHERE id = $1 AND locked_by = $2
       RETURNING id`,
      [runId, workerId, leaseMs],
    )
    return result.rowCount === 1
  }

  async releaseStageRun(runId: string, workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE project_stage_runs
       SET locked_by = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND locked_by = $2`,
      [runId, workerId],
    )
  }

  async recoverStrandedRuns(): Promise<number> {
    const client = await this.pool.connect()
    const recovered: Array<{
      id: string
      projectId: string
      previousStatus: string
      lockedBy: string | null
    }> = []
    try {
      await client.query('BEGIN')
      const rows = await client.query<{
        id: string
        projectId: string
        status: string
        lockedBy: string | null
        summaryMarkdown: string | null
      }>(
        `SELECT id, project_id AS "projectId", status, locked_by AS "lockedBy",
                summary_markdown AS "summaryMarkdown"
         FROM project_stage_runs
         WHERE status = ANY($1::text[])
           AND (
             (lease_expires_at IS NOT NULL AND lease_expires_at < now())
             OR (lease_expires_at IS NULL AND updated_at < now() - interval '15 minutes')
           )
         FOR UPDATE SKIP LOCKED`,
        [[...STAGE_RUN_ACTIVE_STATUSES]],
      )
      for (const row of rows.rows) {
        const message = `# Stage run interrupted

Worker lease expired (previous status: ${row.status}). Start a new attempt.`
        const summary = `${row.summaryMarkdown ?? ''}

${message}`
        await client.query(
          `UPDATE project_stage_runs
           SET status = 'failed', completed_at = COALESCE(completed_at, now()),
               locked_by = NULL, lease_expires_at = NULL,
               summary_markdown = $2, updated_at = now()
           WHERE id = $1`,
          [row.id, summary],
        )
        recovered.push({
          id: row.id,
          projectId: row.projectId,
          previousStatus: row.status,
          lockedBy: row.lockedBy,
        })
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    for (const run of recovered) {
      await this.appendStageRunEvent({
        projectId: run.projectId,
        stageRunId: run.id,
        type: 'run_recovered',
        level: 'warn',
        payload: { previousStatus: run.previousStatus, lockedBy: run.lockedBy },
      }).catch(() => {})
    }
    return recovered.length
  }

  async updateStageRun(runId: string, patch: StageRunPatch): Promise<StageRun> {
    if (patch.status !== undefined && !STAGE_RUN_STATUSES.includes(patch.status)) {
      throw new WorkspaceError(400, 'INVALID_STAGE_RUN_STATUS', 'invalid stage run status')
    }
    const fields: string[] = []
    const values: unknown[] = [runId]
    if (patch.status !== undefined) {
      const index = values.length + 1
      values.push(patch.status)
      fields.push(`status = $${index}`)
      fields.push(
        `started_at = CASE WHEN $${index} = ANY(ARRAY['analyzing','drafting','reviewing','revising','awaiting_human'])
          THEN COALESCE(started_at, now()) ELSE started_at END`,
      )
      fields.push(
        `completed_at = CASE WHEN $${index} = ANY(ARRAY['completed','failed','cancelled'])
          THEN COALESCE(completed_at, now()) ELSE completed_at END`,
      )
    }
    if (patch.sessionId !== undefined) {
      values.push(patch.sessionId)
      fields.push(`session_id = $${values.length}`)
    }
    if (patch.summaryMarkdown !== undefined) {
      values.push(patch.summaryMarkdown)
      fields.push(`summary_markdown = $${values.length}`)
    }
    if (patch.analysisMarkdown !== undefined) {
      values.push(patch.analysisMarkdown)
      fields.push(`analysis_markdown = $${values.length}`)
    }
    if (patch.draftMarkdown !== undefined) {
      values.push(patch.draftMarkdown)
      fields.push(`draft_markdown = $${values.length}`)
    }
    if (patch.pendingGate !== undefined) {
      values.push(patch.pendingGate === null ? null : JSON.stringify(patch.pendingGate))
      fields.push(`pending_gate = $${values.length}::jsonb`)
    }
    if (patch.reviewCycles !== undefined) {
      values.push(patch.reviewCycles)
      fields.push(`review_cycles = $${values.length}`)
    }
    if (patch.contextHash !== undefined) {
      values.push(patch.contextHash)
      fields.push(`context_hash = $${values.length}`)
    }
    fields.push('updated_at = now()')
    const result = await this.pool.query<StageRunRow>(
      `UPDATE project_stage_runs SET ${fields.join(', ')}
       WHERE id = $1
       RETURNING id, project_id AS "projectId", stage, attempt, session_id AS "sessionId",
                 status, context_hash AS "contextHash", context_json AS "context",
                 input_text AS "inputText", analysis_markdown AS "analysisMarkdown",
                 draft_markdown AS "draftMarkdown", summary_markdown AS "summaryMarkdown",
              pending_gate AS "pendingGate", review_cycles AS "reviewCycles",
                 started_at AS "startedAt", completed_at AS "completedAt",
                 locked_by AS "lockedBy", lease_expires_at AS "leaseExpiresAt",
                 execution_attempts AS "executionAttempts",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      values,
    )
    if (result.rows[0] === undefined) throw new WorkspaceError(404, 'STAGE_RUN_NOT_FOUND', 'stage run not found')
    return mapStageRun(result.rows[0])
  }

  async addStageReview(input: {
    stageRunId: string
    reviewerRole: string
    decision: StageReviewDecision
    findings: unknown[]
  }): Promise<StageReview> {
    if (!STAGE_REVIEW_DECISIONS.includes(input.decision)) {
      throw new WorkspaceError(400, 'INVALID_REVIEW_DECISION', 'invalid review decision')
    }
    const result = await this.pool.query<StageReviewRow>(
      `INSERT INTO stage_reviews (id, stage_run_id, reviewer_role, decision, findings)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, stage_run_id AS "stageRunId", reviewer_role AS "reviewerRole",
                 decision, findings, created_at AS "createdAt"`,
      [randomUUID(), input.stageRunId, input.reviewerRole, input.decision, JSON.stringify(input.findings)],
    )
    return mapStageReview(result.rows[0]!)
  }

  async listStageReviews(runId: string): Promise<StageReview[]> {
    const result = await this.pool.query<StageReviewRow>(
      `SELECT id, stage_run_id AS "stageRunId", reviewer_role AS "reviewerRole",
              decision, findings, created_at AS "createdAt"
       FROM stage_reviews WHERE stage_run_id = $1 ORDER BY created_at`,
      [runId],
    )
    return result.rows.map(mapStageReview)
  }

  async getStageRunDetail(runId: string): Promise<StageRunDetail | undefined> {
    const run = await this.getStageRun(runId)
    if (run === undefined) return undefined
    const [reviews, documents] = await Promise.all([
      this.listStageReviews(runId),
      this.listStageRunDocuments(run.projectId, runId),
    ])
    const exported = await this.listDocumentExports(documents.map((document) => document.id))
    return {
      ...run,
      reviews,
      documents: documents.map((document) => {
        const entry = exported.get(document.id)
        return entry === undefined ? document : { ...document, exportPath: entry.path }
      }),
    }
  }

  async listStageRunDocuments(projectId: string, runId: string): Promise<ProjectDocument[]> {
    const result = await this.pool.query<DocumentRow>(
      `SELECT id, project_id AS "projectId", stage, kind, title,
              storage_path AS "storagePath", mime_type AS "mimeType",
              size_bytes AS "sizeBytes", sha256, status, version,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM project_documents
       WHERE project_id = $1 AND stage_run_id = $2
       ORDER BY created_at DESC`,
      [projectId, runId],
    )
    return result.rows.map(mapDocument)
  }

  async getPriorStageSummaries(projectId: string, currentStage: ProjectStage): Promise<Array<{
    stage: ProjectStage
    summary: string
    completedAt: string | null
  }>> {
    const result = await this.pool.query<{
      stage: string
      summaryMarkdown: string | null
      completedAt: Date | string | null
    }>(
      `SELECT DISTINCT ON (stage)
              stage, summary_markdown AS "summaryMarkdown", completed_at AS "completedAt"
       FROM project_stage_runs
       WHERE project_id = $1 AND status = 'completed'
       ORDER BY stage, created_at DESC`,
      [projectId],
    )
    const currentIndex = SDLC_STAGES.indexOf(currentStage)
    return result.rows
      .filter((row) => isProjectStage(row.stage) && SDLC_STAGES.indexOf(row.stage) < currentIndex)
      .map((row) => ({
        stage: row.stage as ProjectStage,
        summary: row.summaryMarkdown ?? '',
        completedAt: toIsoOrNull(row.completedAt),
      }))
      .sort((a, b) => SDLC_STAGES.indexOf(a.stage) - SDLC_STAGES.indexOf(b.stage))
  }

  async appendStageRunEvent(input: StageRunEventInput): Promise<StageRunEvent> {
    const result = await this.pool.query<StageRunEventRow>(
      `INSERT INTO stage_run_events
         (project_id, stage_run_id, role, agent_id, type, phase, level, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING id::text AS id, project_id AS "projectId", stage_run_id AS "stageRunId",
                 role, agent_id AS "agentId", type, phase, level, payload, created_at AS "createdAt"`,
      [
        input.projectId,
        input.stageRunId,
        input.role ?? null,
        input.agentId ?? null,
        input.type,
        input.phase ?? null,
        input.level ?? 'info',
        JSON.stringify(input.payload ?? {}),
      ],
    )
    return mapStageRunEvent(result.rows[0]!)
  }

  async listStageRunEvents(stageRunId: string, after = '0', limit = 200): Promise<StageRunEvent[]> {
    const parsedAfter = Number.parseInt(after, 10)
    const parsedLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 200, 1), 1000)
    const result = await this.pool.query<StageRunEventRow>(
      `SELECT id::text AS id, project_id AS "projectId", stage_run_id AS "stageRunId",
              role, agent_id AS "agentId", type, phase, level, payload, created_at AS "createdAt"
       FROM stage_run_events
       WHERE stage_run_id = $1 AND id > $2::bigint
       ORDER BY stage_run_events.id
       LIMIT $3`,
      [stageRunId, Number.isFinite(parsedAfter) ? parsedAfter : 0, parsedLimit],
    )
    return result.rows.map(mapStageRunEvent)
  }

  async listProjectLogs(input: {
    projectId: string
    limit?: number
    before?: string
    /** ISO timestamp cursor (used by the merged events + app view). */
    beforeTs?: string
    level?: string
    type?: string
    role?: string
    runId?: string
    stage?: string
    query?: string
  }): Promise<{ logs: ProjectLog[]; nextBefore: string | null }> {
    if (input.level !== undefined && !['debug', 'info', 'warn', 'error'].includes(input.level)) {
      throw new WorkspaceError(400, 'INVALID_LOG_LEVEL', 'level must be debug, info, warn or error')
    }
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500)
    const where: string[] = ['e.project_id = $1']
    const values: unknown[] = [input.projectId]
    if (input.before !== undefined && /^\d+$/.test(input.before)) {
      values.push(input.before)
      where.push(`e.id < $${values.length}::bigint`)
    }
    if (input.beforeTs !== undefined) {
      values.push(input.beforeTs)
      where.push(`e.created_at < $${values.length}::timestamptz`)
    }
    if (input.level !== undefined) {
      values.push(input.level)
      where.push(`e.level = $${values.length}`)
    }
    if (input.type !== undefined && input.type !== '') {
      values.push(input.type)
      where.push(`e.type = $${values.length}`)
    }
    if (input.role !== undefined && input.role !== '') {
      values.push(input.role)
      where.push(`e.role = $${values.length}`)
    }
    if (input.runId !== undefined && input.runId !== '') {
      values.push(input.runId)
      where.push(`e.stage_run_id = $${values.length}`)
    }
    if (input.stage !== undefined && input.stage !== '') {
      values.push(input.stage)
      where.push(`r.stage = $${values.length}`)
    }
    if (input.query !== undefined && input.query.trim() !== '') {
      values.push(`%${input.query.trim()}%`)
      where.push(`(e.payload::text ILIKE $${values.length} OR e.type ILIKE $${values.length} OR e.role ILIKE $${values.length})`)
    }
    values.push(limit)
    const result = await this.pool.query<{
      id: string
      projectId: string
      stageRunId: string
      stage: string
      attempt: number
      role: string | null
      agentId: string | null
      type: string
      phase: string | null
      level: LogLevel
      payload: unknown
      createdAt: Date | string
    }>(
      `SELECT e.id::text AS id, e.project_id AS "projectId", e.stage_run_id AS "stageRunId",
              r.stage, r.attempt, e.role, e.agent_id AS "agentId", e.type, e.phase,
              e.level, e.payload, e.created_at AS "createdAt"
       FROM stage_run_events e
       JOIN project_stage_runs r ON r.id = e.stage_run_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.id DESC
       LIMIT $${values.length}`,
      values,
    )
    const logs = result.rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      stageRunId: row.stageRunId,
      stage: normalizeStage(row.stage),
      attempt: row.attempt,
      role: row.role,
      agentId: row.agentId,
      type: row.type,
      phase: row.phase,
      level: row.level,
      payload: row.payload,
      message: logMessage(row.type, row.level, row.payload),
      preview: logPreview(row.payload),
      createdAt: toIso(row.createdAt),
    }))
    return {
      logs,
      nextBefore: logs.length === limit ? logs.at(-1)?.id ?? null : null,
    }
  }

  /** Validate and resolve a stats time range (shared by project and factory reports). */
  private resolveRange(input: { from?: string; to?: string; days?: number }): { from: Date; to: Date } {
    const to = input.to === undefined ? new Date() : new Date(input.to)
    if (Number.isNaN(to.getTime())) throw new WorkspaceError(400, 'INVALID_TIME', 'to must be an ISO-8601 timestamp')
    if (input.days !== undefined && (!Number.isSafeInteger(input.days) || input.days < 1 || input.days > 365)) {
      throw new WorkspaceError(400, 'INVALID_DAYS', 'days must be an integer between 1 and 365')
    }
    const from = input.from === undefined
      ? new Date(to.getTime() - (input.days ?? 30) * 24 * 60 * 60 * 1000)
      : new Date(input.from)
    if (Number.isNaN(from.getTime())) throw new WorkspaceError(400, 'INVALID_TIME', 'from must be an ISO-8601 timestamp')
    if (from.getTime() >= to.getTime()) throw new WorkspaceError(400, 'INVALID_TIME', 'from must be before to')
    return { from, to }
  }

  /**
   * Usage and cost across every project, from the durable event log. Cost is the
   * value recorded with each event when it was written, so it never changes when
   * prices change later.
   */
  async modelUsage(input: { from?: string; to?: string; days?: number } = {}): Promise<FactoryUsage> {
    const { from, to } = this.resolveRange(input)
    const fromIso = from.toISOString()
    const toIsoString = to.toISOString()

    // One CTE normalises each usage event; the three reports group it differently.
    const base = `
      WITH u AS (
        SELECT e.stage_run_id, e.project_id, e.created_at,
               e.payload->'model'->>'provider' AS provider,
               e.payload->'model'->>'model' AS model,
               COALESCE((e.payload->'usage'->>'inputTokens')::numeric, 0) AS input,
               COALESCE((e.payload->'usage'->>'outputTokens')::numeric, 0) AS output,
               COALESCE((e.payload->'usage'->>'cacheReadTokens')::numeric, 0) AS cache_read,
               COALESCE((e.payload->'usage'->>'cacheWriteTokens')::numeric, 0) AS cache_write,
               COALESCE((e.payload->'usage'->>'totalTokens')::numeric, 0) AS total_raw,
               CASE WHEN jsonb_typeof(e.payload->'costUsd') = 'number'
                    THEN (e.payload->>'costUsd')::numeric END AS cost
        FROM stage_run_events e
        WHERE e.type = 'status' AND e.payload ? 'usage'
          AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz
      ), n AS (
        SELECT u.*,
               CASE WHEN total_raw > 0 THEN total_raw ELSE input + output + cache_read + cache_write END AS total
        FROM u
      )`
    const measures = `
      COUNT(*)::int AS calls,
      COUNT(DISTINCT stage_run_id)::int AS runs,
      COALESCE(SUM(input), 0)::bigint AS input,
      COALESCE(SUM(output), 0)::bigint AS output,
      COALESCE(SUM(total), 0)::bigint AS total,
      COALESCE(SUM(cache_read), 0)::bigint AS "cacheRead",
      COALESCE(SUM(cache_write), 0)::bigint AS "cacheWrite",
      (COUNT(*) FILTER (WHERE cost IS NOT NULL))::int AS "pricedCalls",
      SUM(cost)::float8 AS "costUsd",
      COALESCE(SUM(total) FILTER (WHERE cost IS NULL), 0)::bigint AS "unpricedTokens"`

    type RawAgg = Record<string, string | number | null>
    const [models, projects, days] = await Promise.all([
      this.pool.query<RawAgg>(`${base} SELECT provider, model, ${measures} FROM n GROUP BY provider, model`, [fromIso, toIsoString]),
      this.pool.query<RawAgg>(`${base} SELECT project_id::text AS "projectId", ${measures} FROM n GROUP BY project_id ORDER BY SUM(total) DESC LIMIT 200`, [fromIso, toIsoString]),
      this.pool.query<RawAgg>(`${base} SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, ${measures} FROM n GROUP BY 1`, [fromIso, toIsoString]),
    ])
    const measure = (row: RawAgg): UsageAggRow => ({
      input: Number(row.input),
      output: Number(row.output),
      total: Number(row.total),
      cacheRead: Number(row.cacheRead),
      cacheWrite: Number(row.cacheWrite),
      calls: Number(row.calls),
      runs: Number(row.runs),
      pricedCalls: Number(row.pricedCalls),
      costUsd: row.costUsd === null || row.costUsd === undefined ? null : Number(row.costUsd),
      unpricedTokens: Number(row.unpricedTokens),
    })
    const projectIds = projects.rows.map((row) => String(row.projectId))
    const names = new Map<string, string>()
    if (projectIds.length > 0) {
      const named = await this.pool.query<{ id: string; name: string }>(
        'SELECT id::text AS id, name FROM projects WHERE id = ANY($1::uuid[])',
        [projectIds],
      )
      for (const row of named.rows) names.set(row.id, row.name)
    }
    return buildFactoryUsage({
      from: fromIso,
      to: toIsoString,
      byModel: models.rows.map((row): ModelAggRow => ({ provider: (row.provider as string | null) ?? null, model: (row.model as string | null) ?? null, ...measure(row) })),
      byProject: projects.rows.map((row): ProjectAggRow => ({ projectId: String(row.projectId), ...measure(row) })),
      daily: days.rows.map((row): DayAggRow => ({ date: String(row.date), ...measure(row) })),
      projectNames: names,
    })
  }

  /**
   * Token and duration statistics for a project, derived from the durable
   * harness event log. Independent of Phoenix availability/retention.
   */
  async projectStats(input: {
    projectId: string
    from?: string
    to?: string
    days?: number
    stage?: string
    role?: string
  }): Promise<ProjectStats> {
    const { from, to } = this.resolveRange(input)
    if (input.stage !== undefined && !isProjectStage(input.stage)) {
      throw new WorkspaceError(400, 'INVALID_STAGE', `unknown stage: ${input.stage}`)
    }
    const fromIso = from.toISOString()
    const toIsoString = to.toISOString()
    const stage = input.stage ?? null
    const role = input.role ?? null

    const runsResult = await this.pool.query<{
      id: string
      stage: string
      attempt: number
      status: string
      createdAt: Date | string
      startedAt: Date | string | null
      completedAt: Date | string | null
      updatedAt: Date | string
    }>(
      `SELECT id::text AS id, stage, attempt, status,
              created_at AS "createdAt", started_at AS "startedAt",
              completed_at AS "completedAt", updated_at AS "updatedAt"
       FROM project_stage_runs
       WHERE project_id = $1
         AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
         AND ($4::text IS NULL OR stage = $4)
         AND ($5::text IS NULL OR EXISTS (
           SELECT 1 FROM stage_run_events e WHERE e.stage_run_id = project_stage_runs.id AND e.role = $5
         ))
       ORDER BY created_at DESC`,
      [input.projectId, fromIso, toIsoString, stage, role],
    )
    const tokensResult = await this.pool.query<{
      stageRunId: string
      stage: string
      role: string
      provider: string | null
      model: string | null
      priced: boolean
      calls: number
      input: string
      output: string
      total: string
      cacheRead: string
      cacheWrite: string
      costUsd: number | null
    }>(
      // Grouped by model and by whether the event was priced, so a partly
      // priced run reports its cost *and* how much usage the cost leaves out.
      `SELECT e.stage_run_id::text AS "stageRunId", r.stage, e.role,
              e.payload->'model'->>'provider' AS provider,
              e.payload->'model'->>'model' AS model,
              COALESCE(jsonb_typeof(e.payload->'costUsd') = 'number', false) AS priced,
              COUNT(*)::int AS calls,
              COALESCE(SUM((e.payload->'usage'->>'inputTokens')::numeric), 0)::bigint AS input,
              COALESCE(SUM((e.payload->'usage'->>'outputTokens')::numeric), 0)::bigint AS output,
              COALESCE(SUM((e.payload->'usage'->>'totalTokens')::numeric), 0)::bigint AS total,
              COALESCE(SUM((e.payload->'usage'->>'cacheReadTokens')::numeric), 0)::bigint AS "cacheRead",
              COALESCE(SUM((e.payload->'usage'->>'cacheWriteTokens')::numeric), 0)::bigint AS "cacheWrite",
              SUM((e.payload->>'costUsd')::numeric) FILTER (WHERE jsonb_typeof(e.payload->'costUsd') = 'number')::float8 AS "costUsd"
       FROM stage_run_events e
       JOIN project_stage_runs r ON r.id = e.stage_run_id
       WHERE e.project_id = $1
         AND e.type = 'status' AND e.payload ? 'usage'
         AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz
         AND ($4::text IS NULL OR r.stage = $4)
         AND ($5::text IS NULL OR e.role = $5)
       GROUP BY e.stage_run_id, r.stage, e.role, 4, 5, 6`,
      [input.projectId, fromIso, toIsoString, stage, role],
    )
    const rolesResult = await this.pool.query<{
      stageRunId: string
      stage: string
      role: string
      attempts: number
      durationMs: string
    }>(
      `SELECT e.stage_run_id::text AS "stageRunId", r.stage, e.role,
              COUNT(*) FILTER (WHERE e.type = 'role_end')::int AS attempts,
              COALESCE(SUM(CASE
                WHEN e.type = 'role_end' AND jsonb_typeof(e.payload->'durationMs') = 'number'
                THEN (e.payload->>'durationMs')::bigint ELSE 0 END), 0)::bigint AS "durationMs"
       FROM stage_run_events e
       JOIN project_stage_runs r ON r.id = e.stage_run_id
       WHERE e.project_id = $1
         AND e.type IN ('role_start', 'role_end')
         AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz
         AND ($4::text IS NULL OR r.stage = $4)
         AND ($5::text IS NULL OR e.role = $5)
       GROUP BY e.stage_run_id, r.stage, e.role`,
      [input.projectId, fromIso, toIsoString, stage, role],
    )

    const runs: StatsRunRow[] = runsResult.rows.map((row) => ({
      id: row.id,
      stage: row.stage,
      attempt: row.attempt,
      status: row.status,
      createdAt: toIso(row.createdAt),
      startedAt: toIsoOrNull(row.startedAt),
      completedAt: toIsoOrNull(row.completedAt),
      updatedAt: toIso(row.updatedAt),
    }))
    const tokens: StatsTokenRow[] = tokensResult.rows.map((row) => ({
      stageRunId: row.stageRunId,
      stage: row.stage,
      role: row.role,
      input: Number(row.input),
      output: Number(row.output),
      total: Number(row.total),
      cacheRead: Number(row.cacheRead),
      cacheWrite: Number(row.cacheWrite),
      provider: row.provider,
      model: row.model,
      priced: row.priced,
      calls: row.calls,
      costUsd: row.costUsd === null ? 0 : Number(row.costUsd),
    }))
    const roles: StatsRoleRow[] = rolesResult.rows.map((row) => ({
      stageRunId: row.stageRunId,
      stage: row.stage,
      role: row.role,
      attempts: row.attempts,
      durationMs: Number(row.durationMs),
    }))
    return buildProjectStats({ projectId: input.projectId, from: fromIso, to: toIsoString, runs, tokens, roles })
  }

  async getBriefing(projectId: string): Promise<ProjectBriefing | undefined> {
    const result = await this.pool.query<BriefingRow>(
      `SELECT project_id AS "projectId", input_hash AS "inputHash", markdown, risks,
              generated_at AS "generatedAt", model
       FROM project_briefings WHERE project_id = $1`,
      [projectId],
    )
    const row = result.rows[0]
    if (row === undefined) return undefined
    return {
      projectId: row.projectId,
      inputHash: row.inputHash,
      markdown: row.markdown,
      risks: Array.isArray(row.risks) ? row.risks.filter((item): item is string => typeof item === 'string') : [],
      generatedAt: toIso(row.generatedAt),
      model: row.model,
    }
  }

  async saveBriefing(input: {
    projectId: string
    inputHash: string
    markdown: string
    risks: string[]
    model?: string
  }): Promise<ProjectBriefing> {
    const result = await this.pool.query<BriefingRow>(
      `INSERT INTO project_briefings (project_id, input_hash, markdown, risks, model, generated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, now())
       ON CONFLICT (project_id) DO UPDATE
         SET input_hash = EXCLUDED.input_hash, markdown = EXCLUDED.markdown,
             risks = EXCLUDED.risks, model = EXCLUDED.model, generated_at = now()
       RETURNING project_id AS "projectId", input_hash AS "inputHash", markdown, risks,
                 generated_at AS "generatedAt", model`,
      [input.projectId, input.inputHash, input.markdown, JSON.stringify(input.risks), input.model ?? null],
    )
    const row = result.rows[0]!
    return {
      projectId: row.projectId,
      inputHash: row.inputHash,
      markdown: row.markdown,
      risks: Array.isArray(row.risks) ? row.risks.filter((item): item is string => typeof item === 'string') : [],
      generatedAt: toIso(row.generatedAt),
      model: row.model,
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

interface StageRunRow {
  id: string
  projectId: string
  stage: string
  attempt: number
  sessionId: string | null
  status: StageRunStatus
  contextHash: string | null
  context: unknown
  inputText: string | null
  analysisMarkdown: string | null
  draftMarkdown: string | null
  summaryMarkdown: string | null
  pendingGate: PendingGate | null
  reviewCycles: number
  startedAt: Date | string | null
  completedAt: Date | string | null
  lockedBy: string | null
  leaseExpiresAt: Date | string | null
  executionAttempts: number
  createdAt: Date | string
  updatedAt: Date | string
}

interface StageRunEventRow {
  id: string
  projectId: string
  stageRunId: string
  role: string | null
  agentId: string | null
  type: string
  phase: string | null
  level: LogLevel
  payload: unknown
  createdAt: Date | string
}

interface StageReviewRow {
  id: string
  stageRunId: string
  reviewerRole: string
  decision: StageReviewDecision
  findings: unknown
  createdAt: Date | string
}

interface StageRow {
  stage: string
  status: StageStatus
  startedAt: Date | string | null
  completedAt: Date | string | null
  notes: string | null
}

interface AttachmentRow {
  id: string
  projectId: string
  stage: ProjectStage | null
  kind: 'input'
  title: string
  filename: string
  storagePath: string
  textPath: string
  mimeType: string
  sizeBytes: string
  sha256: string
  pages: number
  characters: number
  truncated: boolean
  createdAt: Date | string
}

const ATTACHMENT_COLUMNS = `id, project_id AS "projectId", stage, kind, title, filename,
  storage_path AS "storagePath", text_path AS "textPath", mime_type AS "mimeType",
  size_bytes AS "sizeBytes", sha256, pages, characters, truncated, created_at AS "createdAt"`

function mapAttachment(row: AttachmentRow): ProjectAttachment {
  return {
    id: row.id,
    projectId: row.projectId,
    stage: row.stage,
    kind: 'input',
    title: row.title,
    filename: row.filename,
    storagePath: row.storagePath,
    textPath: row.textPath,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    pages: row.pages,
    characters: row.characters,
    truncated: row.truncated,
    createdAt: toIso(row.createdAt),
  }
}

interface DocumentRow {
  id: string
  projectId: string
  stage: string
  kind: string
  title: string
  storagePath: string
  mimeType: string
  sizeBytes: string | number
  sha256: string
  status: DocumentStatus
  version: number
  createdAt: Date | string
  updatedAt: Date | string
}

interface ChecklistRow {
  id: string
  stage: string
  key: string
  label: string
  required: boolean
  status: ChecklistStatus
  evidenceDocumentId: string | null
  completedAt: Date | string | null
}

interface BriefingRow {
  projectId: string
  inputHash: string
  markdown: string
  risks: unknown
  generatedAt: Date | string
  model: string | null
}

function mapStageRun(row: StageRunRow): StageRun {
  return {
    id: row.id,
    projectId: row.projectId,
    stage: normalizeStage(row.stage),
    attempt: row.attempt,
    sessionId: row.sessionId,
    status: row.status,
    contextHash: row.contextHash,
    context: row.context,
    inputText: row.inputText,
    analysisMarkdown: row.analysisMarkdown,
    draftMarkdown: row.draftMarkdown,
    summaryMarkdown: row.summaryMarkdown,
    pendingGate: row.pendingGate ?? null,
    reviewCycles: row.reviewCycles ?? 0,
    startedAt: toIsoOrNull(row.startedAt),
    completedAt: toIsoOrNull(row.completedAt),
    lockedBy: row.lockedBy,
    leaseExpiresAt: toIsoOrNull(row.leaseExpiresAt),
    executionAttempts: row.executionAttempts,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }
}

function logMessage(type: string, level: LogLevel, payload: unknown): string {
  const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  if (type === 'role_error') return String(record.message ?? 'Role failed')
  if (type === 'role_start') return `${String(record.role ?? 'role')} started`
  if (type === 'role_end') return `${String(record.role ?? 'role')} completed in ${String(record.durationMs ?? '?')}ms`
  if (type === 'tool_call') {
    const input = record.input !== null && typeof record.input === 'object' ? record.input as Record<string, unknown> : {}
    const command = typeof input.command === 'string' ? `: ${input.command}` : ''
    return `Tool ${String(record.tool ?? record.name ?? 'unknown')}${command}`
  }
  if (type === 'tool_result') return `Tool ${String(record.status ?? 'completed')}`
  if (type === 'review_decision') return `Review ${String(record.decision ?? 'unknown')}`
  if (type === 'document_created') return `Document created: ${String(record.kind ?? 'document')}`
  if (type === 'human_decision') return `Human decision: ${String(record.decision ?? 'unknown')}`
  if (type === 'run_recovered') return `Run recovered from ${String(record.previousStatus ?? 'unknown')}`
  if (type === 'error') return String(record.message ?? 'Error')
  return type.replaceAll('_', ' ')
}

function logPreview(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text : typeof record.result === 'string' ? record.result : undefined
  if (text === undefined) return null
  return text.length <= 240 ? text : `${text.slice(0, 240)}…`
}

function mapStageRunEvent(row: StageRunEventRow): StageRunEvent {
  return {
    id: row.id,
    projectId: row.projectId,
    stageRunId: row.stageRunId,
    role: row.role,
    agentId: row.agentId,
    type: row.type,
    phase: row.phase,
    level: row.level,
    payload: row.payload,
    createdAt: toIso(row.createdAt),
  }
}

function mapStageReview(row: StageReviewRow): StageReview {
  return {
    id: row.id,
    stageRunId: row.stageRunId,
    reviewerRole: row.reviewerRole,
    decision: row.decision,
    findings: Array.isArray(row.findings) ? row.findings : [],
    createdAt: toIso(row.createdAt),
  }
}

function mapDocument(row: DocumentRow): ProjectDocument {
  return {
    id: row.id,
    projectId: row.projectId,
    stage: normalizeStage(row.stage),
    kind: row.kind,
    title: row.title,
    storagePath: row.storagePath,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    status: row.status,
    version: row.version,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }
}

function mapChecklist(row: ChecklistRow): ChecklistItem {
  return {
    id: row.id,
    stage: normalizeStage(row.stage),
    key: row.key,
    label: row.label,
    required: row.required,
    status: row.status,
    evidenceDocumentId: row.evidenceDocumentId,
    completedAt: toIsoOrNull(row.completedAt),
  }
}

function buildNextActions(
  currentStage: ProjectStage,
  stages: StageState[],
  checklist: ChecklistRow[],
): NextAction[] {
  const open = checklist.filter((item) => item.stage === currentStage && item.status === 'open')
  const required = open.filter((item) => item.required)
  if (required.length > 0) {
    return required.map((item) => ({
      kind: 'checklist',
      stage: currentStage,
      key: item.key,
      label: item.label,
      required: true,
    }))
  }
  const next = nextStage(currentStage)
  if (next !== undefined) {
    return [{
      kind: 'advance_stage',
      stage: next,
      key: 'advance_stage',
      label: `Advance to ${next}`,
      required: true,
    }]
  }
  return [{
    kind: 'complete_project',
    stage: currentStage,
    key: 'complete_project',
    label: 'All stages are complete',
    required: false,
  }]
}

function normalizeStage(value: string | undefined): ProjectStage {
  return value !== undefined && isProjectStage(value) ? value : 'planning'
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : toIso(value)
}
