/**
 * Project model, the browser-local placeholder repository and the mapping from
 * the Chat API's PostgreSQL registry (`/api/projects`).
 *
 * `useProjects` picks the source: registry projects (`source: 'api'`) when the
 * API exposes them, otherwise the local `ProjectRepository` defined here.
 */

import type { ApiProject, ApiProjectInput, ProjectStatus } from '../api/types.ts'
import { newId } from '../lib/id.ts'
import { readJson, writeJson, type StorageLike } from '../lib/storage.ts'

export type ProjectColor = 'indigo' | 'sky' | 'teal' | 'amber' | 'rose' | 'violet' | 'green'

export interface ProjectColorOption {
  id: ProjectColor
  label: string
}

export const PROJECT_COLORS: readonly ProjectColorOption[] = [
  { id: 'indigo', label: 'Indigo' },
  { id: 'sky', label: 'Sky' },
  { id: 'teal', label: 'Teal' },
  { id: 'amber', label: 'Amber' },
  { id: 'rose', label: 'Rose' },
  { id: 'violet', label: 'Violet' },
  { id: 'green', label: 'Green' },
]

export type ProjectSource = 'local' | 'api' | 'unfiled'

export interface Project {
  id: string
  name: string
  description: string
  color: ProjectColor
  workspace: string
  branch: string
  createdAt: string
  updatedAt: string
  /** Where the project record lives. Older local records omit this. */
  source?: ProjectSource
  /** Registry fields, present for projects loaded from `/api/projects`. */
  status?: ProjectStatus
  organization?: string | null
  ownerEmail?: string | null
  /** SDLC stage key from the registry (stage-runtime APIs only). */
  currentStage?: string
  /** True for the seeded placeholder projects, shown in the project panel. */
  seeded?: boolean
}

export interface ProjectDraftLocal {
  kind: 'local'
  name: string
  description: string
  color: ProjectColor
  workspace: string
  branch: string
}

export interface ProjectDraftApi {
  kind: 'api'
  name: string
  rootPath: string
  organization: string | null
  ownerEmail: string | null
  status: ProjectStatus
}

export type ProjectDraft = ProjectDraftLocal | ProjectDraftApi

export interface ProjectInput {
  name: string
  description?: string
  color?: ProjectColor
  workspace?: string
  branch?: string
}

export const DEFAULT_PROJECT_ID = 'project-general'
export const PROJECTS_KEY = 'aifactory.chat-web.projects.v1'
export const UNFILED_PROJECT_ID = 'project-unfiled'

/** Synthetic group for chats that have no registered project to live in. */
export const UNFILED_PROJECT: Project = {
  id: UNFILED_PROJECT_ID,
  name: 'Unfiled',
  description: 'Chats that are not assigned to a registered project.',
  color: 'indigo',
  workspace: '',
  branch: '',
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
  source: 'unfiled',
}

const DEFAULT_WORKSPACE = '/data/AIFactory2'

/** Deterministic seeds keep local demos familiar across reloads. */
export function defaultProjects(): Project[] {
  return [
    {
      id: DEFAULT_PROJECT_ID,
      name: 'General',
      description: 'A shared home for cross-cutting conversations and quick experiments.',
      color: 'indigo',
      workspace: DEFAULT_WORKSPACE,
      branch: 'main',
      createdAt: '2026-11-01T09:00:00.000Z',
      updatedAt: '2026-11-01T09:00:00.000Z',
      source: 'local',
      seeded: true,
    },
    {
      id: 'project-atlas',
      name: 'Atlas Console',
      description: 'Operator console for the AI Factory delivery pipeline — intake, approvals and release visibility.',
      color: 'sky',
      workspace: '/workspace/atlas-console',
      branch: 'feature/operator-console',
      createdAt: '2026-11-03T10:30:00.000Z',
      updatedAt: '2026-11-03T10:30:00.000Z',
      source: 'local',
      seeded: true,
    },
    {
      id: 'project-forge',
      name: 'Forge Agents',
      description: 'Agent workflows, tool approvals and evaluation loops for autonomous delivery.',
      color: 'amber',
      workspace: '/workspace/forge-agents',
      branch: 'main',
      createdAt: '2026-11-05T14:15:00.000Z',
      updatedAt: '2026-11-05T14:15:00.000Z',
      source: 'local',
      seeded: true,
    },
  ]
}

export function projectColor(color: ProjectColor): ProjectColor {
  return PROJECT_COLORS.some((option) => option.id === color) ? color : 'indigo'
}

function limit(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function normalizeName(name: string): string {
  return limit(name.replace(/\s+/g, ' ').trim(), 60)
}

/** Stable accent palette for registry projects, which have no color field. */
export function projectColorForId(id: string): ProjectColor {
  let hash = 2166136261
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  const index = Math.abs(hash) % PROJECT_COLORS.length
  return PROJECT_COLORS[index]!.id
}

/** Map a project API record into the UI's presentation model. */
export function apiProjectToProject(project: ApiProject): Project {
  return {
    id: project.id,
    name: project.name,
    description: '',
    color: projectColorForId(project.id),
    workspace: project.rootPath,
    branch: '',
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    source: 'api',
    status: project.status,
    organization: project.organization,
    ownerEmail: project.ownerEmail,
    ...(project.currentStage === undefined ? {} : { currentStage: project.currentStage }),
  }
}

export function apiProjectInput(draft: ProjectDraftApi): ApiProjectInput {
  return {
    name: draft.name,
    rootPath: draft.rootPath,
    organization: draft.organization,
    ownerEmail: draft.ownerEmail,
    status: draft.status,
  }
}

export function projectStatusLabel(status: ProjectStatus | undefined): string {
  switch (status) {
    case 'active':
      return 'Active'
    case 'inactive':
      return 'Inactive'
    case 'archived':
      return 'Archived'
    default:
      return '—'
  }
}

function isColor(value: unknown): value is ProjectColor {
  return typeof value === 'string' && PROJECT_COLORS.some((option) => option.id === value)
}

function isProject(value: unknown): value is Project {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.description === 'string'
    && isColor(record.color)
    && typeof record.workspace === 'string'
    && typeof record.branch === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
}

export class ProjectRepository {
  private readonly storage: StorageLike
  private readonly key: string
  private projects: Project[]

  constructor(storage: StorageLike, key = PROJECTS_KEY) {
    this.storage = storage
    this.key = key
    this.projects = this.load()
  }

  list(): Project[] {
    return this.projects.map((project) => ({ ...project }))
  }

  get(id: string): Project | undefined {
    const project = this.projects.find((entry) => entry.id === id)
    return project === undefined ? undefined : { ...project }
  }

  getDefault(): Project {
    return this.get(DEFAULT_PROJECT_ID) ?? this.list()[0] ?? defaultProjects()[0]!
  }

  canDelete(id: string): boolean {
    return id !== DEFAULT_PROJECT_ID && this.projects.length > 1
  }

  create(input: ProjectInput): Project {
    const now = new Date().toISOString()
    const project: Project = {
      id: newId('project'),
      name: normalizeName(input.name) || 'Untitled project',
      description: limit((input.description ?? '').trim(), 240),
      color: projectColor(input.color ?? 'teal'),
      workspace: limit((input.workspace ?? '').trim(), 200),
      branch: limit((input.branch ?? '').trim(), 80),
      createdAt: now,
      updatedAt: now,
      source: 'local',
    }
    this.projects = [project, ...this.projects]
    this.persist()
    return { ...project }
  }

  update(id: string, patch: Partial<ProjectInput>): Project | undefined {
    const index = this.projects.findIndex((project) => project.id === id)
    if (index === -1) return undefined
    const current = this.projects[index]!
    const next: Project = {
      ...current,
      ...(patch.name !== undefined ? { name: normalizeName(patch.name) || current.name } : {}),
      ...(patch.description !== undefined
        ? { description: limit(patch.description.trim(), 240) }
        : {}),
      ...(patch.color !== undefined ? { color: projectColor(patch.color) } : {}),
      ...(patch.workspace !== undefined
        ? { workspace: limit(patch.workspace.trim(), 200) }
        : {}),
      ...(patch.branch !== undefined ? { branch: limit(patch.branch.trim(), 80) } : {}),
      updatedAt: new Date().toISOString(),
    }
    this.projects = this.projects.map((project, at) => (at === index ? next : project))
    this.persist()
    return { ...next }
  }

  remove(id: string): boolean {
    if (!this.canDelete(id)) return false
    const next = this.projects.filter((project) => project.id !== id)
    if (next.length === this.projects.length) return false
    this.projects = next
    this.persist()
    return true
  }

  /** Forget local projects and restore the seeds. Does not touch server chats. */
  reset(): Project[] {
    this.projects = defaultProjects()
    this.persist()
    return this.list()
  }

  private load(): Project[] {
    const parsed = readJson<unknown>(this.storage, this.key, null)
    if (!Array.isArray(parsed)) return defaultProjects()
    const projects: Project[] = parsed
      .filter(isProject)
      .map((project) => ({ ...project, source: project.source ?? 'local' }))
    if (projects.length === 0) return defaultProjects()
    if (!projects.some((project) => project.id === DEFAULT_PROJECT_ID)) {
      projects.unshift(defaultProjects()[0]!)
    }
    return projects
  }

  private persist(): void {
    writeJson(this.storage, this.key, this.projects)
  }
}
