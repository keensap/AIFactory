/**
 * Project registry: validation, service and PostgreSQL persistence.
 *
 * A project is a named root directory the Factory is allowed to work in.
 * Multiple projects may be active at once; there is deliberately no
 * single-active constraint. `root_path` is unique so two projects cannot
 * claim the same directory.
 *
 * Removing a project deletes the database row only. It never deletes the
 * user's root directory.
 */

import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Pool } from 'pg'
import { DEFAULT_MAX_ACTIVE_PROJECTS, type SettingsReader } from './settings.ts'
import type { ProjectStage } from './sdlc.ts'

export const PROJECT_STATUSES = ['active', 'inactive', 'archived', 'completed', 'on_hold'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export interface Project {
  id: string
  name: string
  rootPath: string
  organization: string | null
  ownerEmail: string | null
  status: ProjectStatus
  currentStage: ProjectStage
  stageUpdatedAt: string
  createdAt: string
  updatedAt: string
}

export interface CreateProjectInput {
  name: string
  rootPath: string
  organization: string | null
  ownerEmail: string | null
  status: ProjectStatus
}

export interface UpdateProjectInput {
  name?: string
  rootPath?: string
  organization?: string | null
  ownerEmail?: string | null
  status?: ProjectStatus
}

export interface ProjectListFilter {
  status?: ProjectStatus
  organization?: string
}

export interface ProjectStore {
  create(input: CreateProjectInput, maxActiveProjects?: number): Promise<Project>
  get(id: string): Promise<Project | undefined>
  list(filter: ProjectListFilter): Promise<Project[]>
  update(id: string, patch: UpdateProjectInput, maxActiveProjects?: number): Promise<Project | undefined>
  remove(id: string): Promise<boolean>
  countActive(): Promise<number>
}

export class ProjectError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ProjectError'
    this.status = status
    this.code = code
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_NAME = 200
const MAX_ORGANIZATION = 200
const MAX_EMAIL = 320

export class ProjectService {
  private readonly store: ProjectStore
  private readonly settings: SettingsReader

  constructor(store: ProjectStore, settings: SettingsReader) {
    this.store = store
    this.settings = settings
  }

  async create(input: unknown): Promise<Project> {
    const record = asRecord(input)
    const status = readStatus(record.status, 'inactive')
    const maxActiveProjects = status === 'active'
      ? (await this.settings.get()).maxActiveProjects
      : undefined
    return this.store.create({
      name: readRequiredString(record.name, 'name', MAX_NAME),
      rootPath: await readRootPath(record.rootPath),
      organization: readOptionalString(record.organization, 'organization', MAX_ORGANIZATION),
      ownerEmail: readOwnerEmail(record.ownerEmail),
      status,
    }, maxActiveProjects)
  }

  async get(id: string): Promise<Project> {
    assertId(id)
    const project = await this.store.get(id)
    if (project === undefined) throw notFound(id)
    return project
  }

  async list(filter: ProjectListFilter = {}): Promise<Project[]> {
    const normalized: ProjectListFilter = {}
    if (filter.status !== undefined) normalized.status = readStatus(filter.status)
    if (filter.organization !== undefined && filter.organization.trim() !== '') {
      normalized.organization = filter.organization.trim()
    }
    return this.store.list(normalized)
  }

  async update(id: string, input: unknown): Promise<Project> {
    assertId(id)
    const record = asRecord(input)
    const patch: UpdateProjectInput = {}

    if (record.name !== undefined) patch.name = readRequiredString(record.name, 'name', MAX_NAME)
    if (record.rootPath !== undefined) patch.rootPath = await readRootPath(record.rootPath)
    if (record.organization !== undefined) {
      patch.organization = readOptionalString(record.organization, 'organization', MAX_ORGANIZATION)
    }
    if (record.ownerEmail !== undefined) patch.ownerEmail = readOwnerEmail(record.ownerEmail)
    if (record.status !== undefined) patch.status = readStatus(record.status)

    if (Object.keys(patch).length === 0) {
      throw new ProjectError(400, 'NO_FIELDS', 'at least one updatable field is required')
    }

    const maxActiveProjects = patch.status === 'active'
      ? (await this.settings.get()).maxActiveProjects
      : undefined
    const project = await this.store.update(id, patch, maxActiveProjects)
    if (project === undefined) throw notFound(id)
    return project
  }

  async changeStatus(id: string, status: unknown): Promise<Project> {
    assertId(id)
    const next = readStatus(status)
    const maxActiveProjects = next === 'active'
      ? (await this.settings.get()).maxActiveProjects
      : undefined
    const project = await this.store.update(id, { status: next }, maxActiveProjects)
    if (project === undefined) throw notFound(id)
    return project
  }

  async countActive(): Promise<number> {
    return this.store.countActive()
  }

  async remove(id: string): Promise<void> {
    assertId(id)
    const removed = await this.store.remove(id)
    if (!removed) throw notFound(id)
  }
}

/** PostgreSQL-backed store used by the API. */
export class PostgresProjectStore implements ProjectStore {
  private readonly pool: Pool

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 })
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        organization TEXT,
        owner_email TEXT,
        status TEXT NOT NULL DEFAULT 'inactive'
          CHECK (status IN ('active', 'inactive', 'archived', 'completed', 'on_hold')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
      ALTER TABLE projects ADD CONSTRAINT projects_status_check
        CHECK (status IN ('active', 'inactive', 'archived', 'completed', 'on_hold'));
      CREATE INDEX IF NOT EXISTS projects_status_idx ON projects (status);
      CREATE INDEX IF NOT EXISTS projects_organization_idx ON projects (organization);
    `)
  }

  async create(input: CreateProjectInput, maxActiveProjects?: number): Promise<Project> {
    const id = randomUUID()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (input.status === 'active') {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('aifactory:active-projects'))")
        const limit = await readActiveLimit(client)
        const count = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM projects WHERE status = 'active'",
        )
        if (count.rows[0]!.count >= limit) {
          throw new ProjectError(
            409,
            'ACTIVE_PROJECT_LIMIT_REACHED',
            `the maximum of ${limit} active projects has been reached`,
          )
        }
      }
      const result = await client.query<ProjectRow>(
        `INSERT INTO projects (id, name, root_path, organization, owner_email, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${PROJECT_COLUMNS}`,
        [id, input.name, input.rootPath, input.organization, input.ownerEmail, input.status],
      )
      await client.query('COMMIT')
      return mapRow(result.rows[0]!)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (isUniqueViolation(error)) {
        throw new ProjectError(409, 'ROOT_PATH_CONFLICT', 'another project already uses this root path')
      }
      throw error
    } finally {
      client.release()
    }
  }

  async get(id: string): Promise<Project | undefined> {
    const result = await this.pool.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`,
      [id],
    )
    return result.rows[0] === undefined ? undefined : mapRow(result.rows[0])
  }

  async list(filter: ProjectListFilter): Promise<Project[]> {
    const clauses: string[] = []
    const values: unknown[] = []
    if (filter.status !== undefined) {
      values.push(filter.status)
      clauses.push(`status = $${values.length}`)
    }
    if (filter.organization !== undefined) {
      values.push(filter.organization)
      clauses.push(`organization = $${values.length}`)
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const result = await this.pool.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM projects ${where} ORDER BY created_at DESC`,
      values,
    )
    return result.rows.map(mapRow)
  }

  async update(
    id: string,
    patch: UpdateProjectInput,
    maxActiveProjects?: number,
  ): Promise<Project | undefined> {
    const sets: string[] = []
    const values: unknown[] = []

    if (patch.name !== undefined) {
      values.push(patch.name)
      sets.push(`name = $${values.length}`)
    }
    if (patch.rootPath !== undefined) {
      values.push(patch.rootPath)
      sets.push(`root_path = $${values.length}`)
    }
    if (patch.organization !== undefined) {
      values.push(patch.organization)
      sets.push(`organization = $${values.length}`)
    }
    if (patch.ownerEmail !== undefined) {
      values.push(patch.ownerEmail)
      sets.push(`owner_email = $${values.length}`)
    }
    if (patch.status !== undefined) {
      values.push(patch.status)
      sets.push(`status = $${values.length}`)
    }
    if (sets.length === 0) return this.get(id)

    sets.push('updated_at = now()')
    values.push(id)

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (patch.status === 'active') {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('aifactory:active-projects'))")
        const limit = await readActiveLimit(client)
        const count = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM projects WHERE status = 'active' AND id <> $1",
          [id],
        )
        if (count.rows[0]!.count >= limit) {
          throw new ProjectError(
            409,
            'ACTIVE_PROJECT_LIMIT_REACHED',
            `the maximum of ${limit} active projects has been reached`,
          )
        }
      }
      const result = await client.query<ProjectRow>(
        `UPDATE projects SET ${sets.join(', ')}
         WHERE id = $${values.length}
         RETURNING ${PROJECT_COLUMNS}`,
        values,
      )
      await client.query('COMMIT')
      return result.rows[0] === undefined ? undefined : mapRow(result.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (isUniqueViolation(error)) {
        throw new ProjectError(409, 'ROOT_PATH_CONFLICT', 'another project already uses this root path')
      }
      throw error
    } finally {
      client.release()
    }
  }

  async countActive(): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM projects WHERE status = 'active'",
    )
    return result.rows[0]!.count
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM projects WHERE id = $1 RETURNING id', [id])
    return (result.rowCount ?? 0) > 0
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

interface ProjectRow {
  id: string
  name: string
  rootPath: string
  organization: string | null
  ownerEmail: string | null
  status: ProjectStatus
  currentStage: ProjectStage
  stageUpdatedAt: Date | string
  createdAt: Date | string
  updatedAt: Date | string
}

const PROJECT_COLUMNS = `
  id, name, root_path AS "rootPath", organization, owner_email AS "ownerEmail",
  status, current_stage AS "currentStage", stage_updated_at AS "stageUpdatedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`

function mapRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    organization: row.organization,
    ownerEmail: row.ownerEmail,
    status: row.status,
    currentStage: row.currentStage,
    stageUpdatedAt: toIso(row.stageUpdatedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

async function readActiveLimit(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }): Promise<number> {
  const result = await client.query(
    "SELECT value FROM settings WHERE key = 'max_active_projects'",
  )
  const value = result.rows[0]?.value
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ACTIVE_PROJECTS
}

function isUniqueViolation(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: string }).code === '23505'
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectError(400, 'INVALID_BODY', 'request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function assertId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new ProjectError(400, 'INVALID_PROJECT_ID', 'project id must be a UUID')
  }
}

function notFound(id: string): ProjectError {
  return new ProjectError(404, 'PROJECT_NOT_FOUND', `project ${id} was not found`)
}

function readRequiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProjectError(400, `INVALID_${field.toUpperCase()}`, `${field} is required`)
  }
  const trimmed = value.trim()
  if (trimmed.length > max) {
    throw new ProjectError(400, `INVALID_${field.toUpperCase()}`, `${field} must be at most ${max} characters`)
  }
  return trimmed
}

function readOptionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new ProjectError(400, `INVALID_${field.toUpperCase()}`, `${field} must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > max) {
    throw new ProjectError(400, `INVALID_${field.toUpperCase()}`, `${field} must be at most ${max} characters`)
  }
  return trimmed
}

function readOwnerEmail(value: unknown): string | null {
  const email = readOptionalString(value, 'owner_email', MAX_EMAIL)
  if (email !== null && !EMAIL_PATTERN.test(email)) {
    throw new ProjectError(400, 'INVALID_OWNER_EMAIL', 'ownerEmail must be a valid email address')
  }
  return email
}

function readStatus(value: unknown, fallback?: ProjectStatus): ProjectStatus {
  if (value === undefined) {
    if (fallback !== undefined) return fallback
    throw new ProjectError(400, 'INVALID_STATUS', `status must be one of ${PROJECT_STATUSES.join(', ')}`)
  }
  if (typeof value !== 'string' || !PROJECT_STATUSES.includes(value as ProjectStatus)) {
    throw new ProjectError(400, 'INVALID_STATUS', `status must be one of ${PROJECT_STATUSES.join(', ')}`)
  }
  return value as ProjectStatus
}

async function readRootPath(value: unknown): Promise<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProjectError(400, 'INVALID_ROOT_PATH', 'rootPath is required')
  }
  const requested = value.trim()
  if (!isAbsolute(requested)) {
    throw new ProjectError(400, 'INVALID_ROOT_PATH', 'rootPath must be an absolute path')
  }

  const resolved = resolve(requested)
  let details
  try {
    details = await stat(resolved)
  } catch {
    throw new ProjectError(400, 'INVALID_ROOT_PATH', `rootPath does not exist: ${resolved}`)
  }
  if (!details.isDirectory()) {
    throw new ProjectError(400, 'INVALID_ROOT_PATH', `rootPath is not a directory: ${resolved}`)
  }

  try {
    return await realpath(resolved)
  } catch {
    return resolved
  }
}
