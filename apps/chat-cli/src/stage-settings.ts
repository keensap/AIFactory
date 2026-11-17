/**
 * Planning-stage review settings.
 *
 * Two knobs decide how much review happens before a human is asked:
 *
 *  - `gateAfterEachReview`: pause after **every** review and ask whether to
 *    apply its changes. The operator controls each cycle.
 *  - `maxReviewCycles`: how many revision cycles run automatically when gating
 *    is off, counted *after* the first review.
 *
 * Whichever mode is used, the run ends at a final gate where a human decides
 * whether to refine further; only then is the stage completed and the PDF
 * produced.
 *
 * Values resolve **project override → Factory default**. A run snapshots the
 * resolved values into its context, so changing settings mid-run cannot alter a
 * run that is already in progress.
 */

import { Pool } from 'pg'

export const MIN_REVIEW_CYCLES = 1
export const MAX_REVIEW_CYCLES = 10
export const MAX_BLOCKERS_LIMIT = 20
export const MAX_MAJOR_LIMIT = 50

export interface PlanningStageSettings {
  gateAfterEachReview: boolean
  maxReviewCycles: number
  /** Minimum overall document rating (0–100) for the run to stop revising. */
  minRating: number
  /** Blockers tolerated before the run keeps revising. */
  maxBlockers: number
  /** Major findings tolerated before the run keeps revising. */
  maxMajor: number
}

/**
 * Defaults preserve the previous behaviour: the reviewer's own approval decides,
 * and any blocker or major finding keeps the run revising.
 */
export const DEFAULT_PLANNING_STAGE_SETTINGS: PlanningStageSettings = {
  gateAfterEachReview: false,
  maxReviewCycles: 3,
  minRating: 0,
  maxBlockers: 0,
  maxMajor: 0,
}

export type SettingsSource = 'project' | 'factory'

export interface ResolvedStageSettings extends PlanningStageSettings {
  source: SettingsSource
}

export class StageSettingsError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'StageSettingsError'
    this.status = status
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate a full or partial settings payload. Unknown keys are ignored. */
export function parseStageSettings(input: unknown, options: { partial?: boolean } = {}): Partial<PlanningStageSettings> {
  if (!isRecord(input)) throw new StageSettingsError(400, 'INVALID_BODY', 'request body must be a JSON object')
  const out: Partial<PlanningStageSettings> = {}

  if (input.gateAfterEachReview !== undefined) {
    if (typeof input.gateAfterEachReview !== 'boolean') {
      throw new StageSettingsError(400, 'INVALID_GATE_SETTING', 'gateAfterEachReview must be true or false')
    }
    out.gateAfterEachReview = input.gateAfterEachReview
  }
  if (input.maxReviewCycles !== undefined) {
    const value = input.maxReviewCycles
    if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_REVIEW_CYCLES || value > MAX_REVIEW_CYCLES) {
      throw new StageSettingsError(
        400,
        'INVALID_REVIEW_CYCLES',
        `maxReviewCycles must be an integer between ${MIN_REVIEW_CYCLES} and ${MAX_REVIEW_CYCLES}`,
      )
    }
    out.maxReviewCycles = value
  }

  if (input.minRating !== undefined) {
    const value = input.minRating
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
      throw new StageSettingsError(400, 'INVALID_MIN_RATING', 'minRating must be an integer between 0 and 100')
    }
    out.minRating = value
  }
  if (input.maxBlockers !== undefined) {
    const value = input.maxBlockers
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_BLOCKERS_LIMIT) {
      throw new StageSettingsError(400, 'INVALID_MAX_BLOCKERS', `maxBlockers must be an integer between 0 and ${MAX_BLOCKERS_LIMIT}`)
    }
    out.maxBlockers = value
  }
  if (input.maxMajor !== undefined) {
    const value = input.maxMajor
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_MAJOR_LIMIT) {
      throw new StageSettingsError(400, 'INVALID_MAX_MAJOR', `maxMajor must be an integer between 0 and ${MAX_MAJOR_LIMIT}`)
    }
    out.maxMajor = value
  }

  if (options.partial !== true && (out.gateAfterEachReview === undefined || out.maxReviewCycles === undefined)) {
    throw new StageSettingsError(400, 'INVALID_SETTINGS', 'gateAfterEachReview and maxReviewCycles are both required')
  }
  return out
}

/** The settings a run uses, read from its snapshotted context. */
export function settingsFromContext(context: unknown): PlanningStageSettings {
  const record = isRecord(context) ? context : {}
  const constraints = isRecord(record.constraints) ? record.constraints : {}
  const gate = typeof constraints.gateAfterEachReview === 'boolean'
    ? constraints.gateAfterEachReview
    : DEFAULT_PLANNING_STAGE_SETTINGS.gateAfterEachReview
  const cycles = typeof constraints.maxReviewCycles === 'number' && Number.isInteger(constraints.maxReviewCycles)
    ? Math.min(MAX_REVIEW_CYCLES, Math.max(MIN_REVIEW_CYCLES, constraints.maxReviewCycles))
    : DEFAULT_PLANNING_STAGE_SETTINGS.maxReviewCycles
  const int = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback
  return {
    gateAfterEachReview: gate,
    maxReviewCycles: cycles,
    minRating: int(constraints.minRating, DEFAULT_PLANNING_STAGE_SETTINGS.minRating, 0, 100),
    maxBlockers: int(constraints.maxBlockers, DEFAULT_PLANNING_STAGE_SETTINGS.maxBlockers, 0, MAX_BLOCKERS_LIMIT),
    maxMajor: int(constraints.maxMajor, DEFAULT_PLANNING_STAGE_SETTINGS.maxMajor, 0, MAX_MAJOR_LIMIT),
  }
}

export interface StageSettingsStore {
  migrate?(): Promise<void>
  loadDefaults(): Promise<PlanningStageSettings>
  saveDefaults(settings: PlanningStageSettings): Promise<PlanningStageSettings>
  getProject(projectId: string): Promise<PlanningStageSettings | undefined>
  setProject(projectId: string, settings: PlanningStageSettings | null): Promise<void>
  close?(): Promise<void>
}

export class PostgresStageSettingsStore implements StageSettingsStore {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 2 })
    this.pool.on('error', () => {})
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS project_stage_settings (
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        gate_after_each_review BOOLEAN NOT NULL,
        max_review_cycles INTEGER NOT NULL,
        min_rating INTEGER NOT NULL DEFAULT 0,
        max_blockers INTEGER NOT NULL DEFAULT 0,
        max_major INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, stage)
      );
    `)
    // Existing installations predate the acceptance criteria columns.
    for (const [column, definition] of [
      ['min_rating', 'INTEGER NOT NULL DEFAULT 0'],
      ['max_blockers', 'INTEGER NOT NULL DEFAULT 0'],
      ['max_major', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      const existing = await this.pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'project_stage_settings' AND column_name = $1`,
        [column],
      )
      if ((existing.rowCount ?? 0) === 0) await this.pool.query(`ALTER TABLE project_stage_settings ADD COLUMN ${column} ${definition}`)
    }
  }

  async loadDefaults(): Promise<PlanningStageSettings> {
    const result = await this.pool.query<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'stage_defaults'`)
    const value = result.rows[0]?.value
    if (!isRecord(value) || !isRecord(value.planning)) return { ...DEFAULT_PLANNING_STAGE_SETTINGS }
    try {
      const parsed = parseStageSettings({ ...DEFAULT_PLANNING_STAGE_SETTINGS, ...value.planning }, { partial: true })
      return { ...DEFAULT_PLANNING_STAGE_SETTINGS, ...parsed }
    } catch {
      // Corrupt settings must not stop the Factory; defaults are safe.
      return { ...DEFAULT_PLANNING_STAGE_SETTINGS }
    }
  }

  async saveDefaults(settings: PlanningStageSettings): Promise<PlanningStageSettings> {
    await this.pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('stage_defaults', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ planning: settings })],
    )
    return settings
  }

  async getProject(projectId: string): Promise<PlanningStageSettings | undefined> {
    const result = await this.pool.query<{ gate: boolean; cycles: number; minRating: number; maxBlockers: number; maxMajor: number }>(
      `SELECT gate_after_each_review AS "gate", max_review_cycles AS "cycles",
              min_rating AS "minRating", max_blockers AS "maxBlockers", max_major AS "maxMajor"
       FROM project_stage_settings WHERE project_id = $1 AND stage = 'planning'`,
      [projectId],
    )
    const row = result.rows[0]
    return row === undefined
      ? undefined
      : {
          gateAfterEachReview: row.gate,
          maxReviewCycles: row.cycles,
          minRating: row.minRating,
          maxBlockers: row.maxBlockers,
          maxMajor: row.maxMajor,
        }
  }

  async setProject(projectId: string, settings: PlanningStageSettings | null): Promise<void> {
    if (settings === null) {
      await this.pool.query(`DELETE FROM project_stage_settings WHERE project_id = $1 AND stage = 'planning'`, [projectId])
      return
    }
    await this.pool.query(
      `INSERT INTO project_stage_settings
         (project_id, stage, gate_after_each_review, max_review_cycles, min_rating, max_blockers, max_major, updated_at)
       VALUES ($1, 'planning', $2, $3, $4, $5, $6, now())
       ON CONFLICT (project_id, stage) DO UPDATE SET
         gate_after_each_review = EXCLUDED.gate_after_each_review,
         max_review_cycles = EXCLUDED.max_review_cycles,
         min_rating = EXCLUDED.min_rating,
         max_blockers = EXCLUDED.max_blockers,
         max_major = EXCLUDED.max_major,
         updated_at = now()`,
      [projectId, settings.gateAfterEachReview, settings.maxReviewCycles, settings.minRating, settings.maxBlockers, settings.maxMajor],
    )
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {})
  }
}

/** Resolve and edit planning-stage settings. */
export class StageSettingsService {
  private readonly store: StageSettingsStore

  constructor(store: StageSettingsStore) {
    this.store = store
  }

  async migrate(): Promise<void> {
    await this.store.migrate?.()
  }

  async factoryDefaults(): Promise<PlanningStageSettings> {
    return this.store.loadDefaults()
  }

  async updateFactoryDefaults(input: unknown): Promise<PlanningStageSettings> {
    const patch = parseStageSettings(input, { partial: true })
    if (Object.keys(patch).length === 0) {
      throw new StageSettingsError(400, 'NO_FIELDS', 'no recognised settings were provided')
    }
    return this.store.saveDefaults({ ...(await this.store.loadDefaults()), ...patch })
  }

  /** Project override, or the Factory default when the project has none. */
  async resolve(projectId: string): Promise<ResolvedStageSettings> {
    const project = await this.store.getProject(projectId)
    if (project !== undefined) return { ...project, source: 'project' }
    return { ...(await this.store.loadDefaults()), source: 'factory' }
  }

  async setProject(projectId: string, input: unknown): Promise<ResolvedStageSettings> {
    if (input === null) {
      await this.store.setProject(projectId, null)
    } else {
      const patch = parseStageSettings(input, { partial: true })
      if (Object.keys(patch).length === 0) {
        throw new StageSettingsError(400, 'NO_FIELDS', 'no recognised settings were provided')
      }
      const current = (await this.store.getProject(projectId)) ?? (await this.store.loadDefaults())
      const next: PlanningStageSettings = { ...current, ...patch }
      await this.store.setProject(projectId, next)
    }
    return this.resolve(projectId)
  }

  async close(): Promise<void> {
    await this.store.close?.()
  }
}
