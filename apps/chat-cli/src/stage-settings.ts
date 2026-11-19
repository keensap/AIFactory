/**
 * Planning-stage review settings.
 *
 * Review continues automatically until acceptance criteria are met or the
 * revision-cycle budget is exhausted. In either case, the run pauses at a final
 * human gate; only a human decision completes the stage and produces its PDF.
 * `maxReviewCycles` counts revision cycles after the initial review.
 *
 * Values resolve **project override → Factory default**. A run snapshots the
 * resolved values into its context, so changing settings mid-run cannot alter a
 * run that is already in progress.
 */

import { Pool } from 'pg'
import { sharedPool } from './db.ts'
import { runMigrations } from './migrations.ts'
import { SDLC_STAGES, STAGE_LABELS, type ProjectStage } from './sdlc.ts'

export const MIN_REVIEW_CYCLES = 1
export const MAX_REVIEW_CYCLES = 10
export const MAX_BLOCKERS_LIMIT = 20
export const MAX_MAJOR_LIMIT = 50

export interface PlanningStageSettings {
  maxReviewCycles: number
  /** Minimum overall document rating (0–100) for the run to stop revising. */
  minRating: number
  /** Blockers tolerated before the run keeps revising. */
  maxBlockers: number
  /** Major findings tolerated before the run keeps revising. */
  maxMajor: number
  /**
   * Hours a gate may wait before it is reported as stale (AR-16).
   *
   * Stale is a reminder, never an action: nothing is auto-approved, because
   * completion must stay a human decision.
   */
  gateReminderHours: number
}

/**
 * Defaults preserve the previous behaviour: the reviewer's own approval decides,
 * and any blocker or major finding keeps the run revising.
 */
export const DEFAULT_PLANNING_STAGE_SETTINGS: PlanningStageSettings = {
  maxReviewCycles: 3,
  minRating: 0,
  maxBlockers: 0,
  maxMajor: 0,
  gateReminderHours: 72,
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
  if (input.gateReminderHours !== undefined) {
    const value = input.gateReminderHours
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 720) {
      throw new StageSettingsError(400, 'INVALID_GATE_REMINDER_HOURS', 'gateReminderHours must be an integer between 1 and 720')
    }
    out.gateReminderHours = value
  }
  if (input.maxMajor !== undefined) {
    const value = input.maxMajor
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_MAJOR_LIMIT) {
      throw new StageSettingsError(400, 'INVALID_MAX_MAJOR', `maxMajor must be an integer between 0 and ${MAX_MAJOR_LIMIT}`)
    }
    out.maxMajor = value
  }

  if (options.partial !== true && out.maxReviewCycles === undefined) {
    throw new StageSettingsError(400, 'INVALID_SETTINGS', 'maxReviewCycles is required')
  }
  return out
}

/** The settings a run uses, read from its snapshotted context. */
export function settingsFromContext(context: unknown): PlanningStageSettings {
  const record = isRecord(context) ? context : {}
  const constraints = isRecord(record.constraints) ? record.constraints : {}
  const cycles = typeof constraints.maxReviewCycles === 'number' && Number.isInteger(constraints.maxReviewCycles)
    ? Math.min(MAX_REVIEW_CYCLES, Math.max(MIN_REVIEW_CYCLES, constraints.maxReviewCycles))
    : DEFAULT_PLANNING_STAGE_SETTINGS.maxReviewCycles
  const int = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback
  return {
    maxReviewCycles: cycles,
    minRating: int(constraints.minRating, DEFAULT_PLANNING_STAGE_SETTINGS.minRating, 0, 100),
    maxBlockers: int(constraints.maxBlockers, DEFAULT_PLANNING_STAGE_SETTINGS.maxBlockers, 0, MAX_BLOCKERS_LIMIT),
    maxMajor: int(constraints.maxMajor, DEFAULT_PLANNING_STAGE_SETTINGS.maxMajor, 0, MAX_MAJOR_LIMIT),
    gateReminderHours: int(constraints.gateReminderHours, DEFAULT_PLANNING_STAGE_SETTINGS.gateReminderHours, 1, 720),
  }
}


// ---------------------------------------------------------------------------
// Per-stage definitions
// ---------------------------------------------------------------------------

/**
 * Settings are heterogeneous per stage, so each stage owns a definition: its
 * defaults and a validator. A stage without a runtime has no definition and
 * therefore no editable settings — storage is still per stage, so adding one
 * later is code, not a migration.
 */
export interface StageSettingsDefinition {
  stage: ProjectStage
  label: string
  defaults: Record<string, unknown>
  /** Validate a partial update; throws `StageSettingsError`. */
  validate(input: unknown): Record<string, unknown>
  /** Read the stage's snapshot out of a run context's constraints, tolerantly. */
  fromContext(constraints: unknown): Record<string, unknown>
}

const PLANNING_DEFINITION: StageSettingsDefinition = {
  stage: 'planning',
  label: STAGE_LABELS.planning,
  defaults: { ...DEFAULT_PLANNING_STAGE_SETTINGS },
  validate(input: unknown): Record<string, unknown> {
    return { ...parseStageSettings(input, { partial: true }) }
  },
  fromContext(constraints: unknown): Record<string, unknown> {
    return { ...settingsFromContext({ constraints }) }
  },
}

/**
 * The requirements stage asks the same review questions as planning, so it reuses
 * the same validator. It has no go/no-go decision, so `gateReminderHours` still
 * applies but `convergence` is a plain approval.
 */
const REQUIREMENTS_DEFINITION: StageSettingsDefinition = {
  stage: 'requirements',
  label: STAGE_LABELS.requirements,
  defaults: { ...DEFAULT_PLANNING_STAGE_SETTINGS },
  validate(input: unknown): Record<string, unknown> {
    return { ...parseStageSettings(input, { partial: true }) }
  },
  fromContext(constraints: unknown): Record<string, unknown> {
    return { ...settingsFromContext({ constraints }) }
  },
}

export const STAGE_SETTINGS_DEFINITIONS: Partial<Record<ProjectStage, StageSettingsDefinition>> = {
  planning: PLANNING_DEFINITION,
  requirements: REQUIREMENTS_DEFINITION,
}

export function stageSettingsDefinition(stage: string): StageSettingsDefinition | undefined {
  if (!(SDLC_STAGES as readonly string[]).includes(stage)) {
    throw new StageSettingsError(400, 'INVALID_STAGE', `unknown SDLC stage ${stage}`)
  }
  return STAGE_SETTINGS_DEFINITIONS[stage as ProjectStage]
}

/** Effective settings for one stage: definition defaults ← Factory ← project. */
export function mergeStageSettings(
  stage: string,
  ...layers: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(stageSettingsDefinition(stage)?.defaults ?? {}) }
  for (const layer of layers) {
    if (layer === undefined) continue
    for (const [key, value] of Object.entries(layer)) {
      // Ignore retired or unknown persisted fields rather than exposing them again.
      if (value !== undefined && Object.hasOwn(merged, key)) merged[key] = value
    }
  }
  return merged
}

/** The planning settings a run uses, read from its snapshotted context. */
export function planningSettingsFromContext(context: unknown): PlanningStageSettings {
  return settingsFromContext(context)
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export type SettingsSource = 'project' | 'factory' | 'defaults'

export interface ResolvedStageSettings {
  stage: ProjectStage
  settings: Record<string, unknown>
  source: SettingsSource
}

export interface StageSettingsStore {
  migrate?(): Promise<void>
  /** Factory defaults per stage, as stored (not merged with definitions). */
  loadFactory(): Promise<Record<string, Record<string, unknown>>>
  saveFactory(stage: ProjectStage, settings: Record<string, unknown>): Promise<void>
  getProject(projectId: string, stage: ProjectStage): Promise<Record<string, unknown> | undefined>
  setProject(projectId: string, stage: ProjectStage, settings: Record<string, unknown> | null): Promise<void>
  close?(): Promise<void>
}

export class PostgresStageSettingsStore implements StageSettingsStore {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = sharedPool(connectionString)
  }

  async migrate(): Promise<void> {
    await runMigrations(this.pool)
  }


  async loadFactory(): Promise<Record<string, Record<string, unknown>>> {
    const result = await this.pool.query<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'stage_defaults'`)
    const value = result.rows[0]?.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    const out: Record<string, Record<string, unknown>> = {}
    for (const [stage, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        out[stage] = entry as Record<string, unknown>
      }
    }
    return out
  }

  async saveFactory(stage: ProjectStage, settings: Record<string, unknown>): Promise<void> {
    const current = await this.loadFactory()
    current[stage] = settings
    await this.pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('stage_defaults', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(current)],
    )
  }

  async getProject(projectId: string, stage: ProjectStage): Promise<Record<string, unknown> | undefined> {
    const result = await this.pool.query<{ settings: unknown }>(
      `SELECT settings FROM project_stage_settings WHERE project_id = $1 AND stage = $2`,
      [projectId, stage],
    )
    const value = result.rows[0]?.settings
    return value === null || typeof value !== 'object' || Array.isArray(value)
      ? undefined
      : (value as Record<string, unknown>)
  }

  async setProject(projectId: string, stage: ProjectStage, settings: Record<string, unknown> | null): Promise<void> {
    if (settings === null) {
      await this.pool.query(`DELETE FROM project_stage_settings WHERE project_id = $1 AND stage = $2`, [projectId, stage])
      return
    }
    await this.pool.query(
      `INSERT INTO project_stage_settings (project_id, stage, settings, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (project_id, stage) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`,
      [projectId, stage, JSON.stringify(settings)],
    )
  }

  async close(): Promise<void> {
    // The pool is shared and closed once at shutdown (db.closeSharedPools).
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class StageSettingsService {
  private readonly store: StageSettingsStore

  constructor(store: StageSettingsStore) {
    this.store = store
  }

  async migrate(): Promise<void> {
    await this.store.migrate?.()
  }

  /** Factory defaults for one stage, merged with its definition defaults. */
  async factoryDefaultFor(stage: string): Promise<Record<string, unknown>> {
    stageSettingsDefinition(stage)
    const stored = await this.store.loadFactory()
    return mergeStageSettings(stage, stored[stage])
  }

  /** Factory defaults for every stage, merged with each definition's defaults. */
  async factoryDefaults(): Promise<Record<string, Record<string, unknown>>> {
    const stored = await this.store.loadFactory()
    const out: Record<string, Record<string, unknown>> = {}
    for (const stage of SDLC_STAGES) out[stage] = mergeStageSettings(stage, stored[stage])
    return out
  }

  async updateFactoryDefaults(stage: string, input: unknown): Promise<Record<string, unknown>> {
    const definition = this.requireDefinition(stage)
    const patch = definition.validate(input)
    if (Object.keys(patch).length === 0) {
      throw new StageSettingsError(400, 'NO_FIELDS', 'no recognised settings were provided')
    }
    const stored = await this.store.loadFactory()
    const next = mergeStageSettings(stage, stored[stage], patch)
    await this.store.saveFactory(stage as ProjectStage, next)
    return next
  }

  async resolve(projectId: string, stage: string): Promise<ResolvedStageSettings> {
    stageSettingsDefinition(stage)
    const project = await this.store.getProject(projectId, stage as ProjectStage)
    if (project !== undefined) {
      return { stage: stage as ProjectStage, settings: mergeStageSettings(stage, project), source: 'project' }
    }
    const factory = (await this.store.loadFactory())[stage]
    if (factory !== undefined) {
      return { stage: stage as ProjectStage, settings: mergeStageSettings(stage, factory), source: 'factory' }
    }
    return { stage: stage as ProjectStage, settings: mergeStageSettings(stage), source: 'defaults' }
  }

  async setProject(projectId: string, stage: string, input: unknown): Promise<ResolvedStageSettings> {
    const definition = this.requireDefinition(stage)
    if (input === null) {
      await this.store.setProject(projectId, stage as ProjectStage, null)
      return this.resolve(projectId, stage)
    }
    const patch = definition.validate(input)
    if (Object.keys(patch).length === 0) {
      throw new StageSettingsError(400, 'NO_FIELDS', 'no recognised settings were provided')
    }
    const current = await this.resolve(projectId, stage)
    await this.store.setProject(projectId, stage as ProjectStage, { ...current.settings, ...patch })
    return this.resolve(projectId, stage)
  }

  /** The planning settings a run should start with. */
  async planning(projectId: string): Promise<PlanningStageSettings> {
    return this.effective(projectId, 'planning')
  }

  /**
   * The settings in force for any stage (AR-15).
   *
   * A stage with a definition gets its own defaults and overrides; a stage without
   * one still answers with the planning defaults, which is what the routes relied
   * on before stages existed.
   */
  async effective(projectId: string, stage: ProjectStage = 'planning'): Promise<PlanningStageSettings> {
    const resolved = await this.resolve(projectId, stage)
    const defaults = STAGE_SETTINGS_DEFINITIONS[stage]?.defaults ?? DEFAULT_PLANNING_STAGE_SETTINGS
    return { ...DEFAULT_PLANNING_STAGE_SETTINGS, ...defaults, ...(resolved.settings as Partial<PlanningStageSettings>) }
  }

  async close(): Promise<void> {
    await this.store.close?.()
  }

  private requireDefinition(stage: string): StageSettingsDefinition {
    const definition = stageSettingsDefinition(stage)
    if (definition === undefined) {
      throw new StageSettingsError(
        501,
        'STAGE_SETTINGS_NOT_IMPLEMENTED',
        `settings exist only for stages with a runtime; the ${stage} stage has no settings yet`,
      )
    }
    return definition
  }
}
