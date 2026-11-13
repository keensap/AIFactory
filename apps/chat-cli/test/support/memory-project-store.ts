import { randomUUID } from 'node:crypto'
import {
  ProjectError,
  type CreateProjectInput,
  type Project,
  type ProjectListFilter,
  type ProjectStore,
  type UpdateProjectInput,
} from '../../src/projects.ts'

export class MemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<string, Project>()

  async create(input: CreateProjectInput, maxActiveProjects?: number): Promise<Project> {
    for (const project of this.projects.values()) {
      if (project.rootPath === input.rootPath) {
        throw new ProjectError(409, 'ROOT_PATH_CONFLICT', 'another project already uses this root path')
      }
    }
    if (input.status === 'active' && maxActiveProjects !== undefined
      && await this.countActive() >= maxActiveProjects) {
      throw new ProjectError(
        409,
        'ACTIVE_PROJECT_LIMIT_REACHED',
        `the maximum of ${maxActiveProjects} active projects has been reached`,
      )
    }
    const now = new Date().toISOString()
    const project: Project = {
      id: randomUUID(),
      ...input,
      currentStage: 'planning',
      stageUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    }
    this.projects.set(project.id, project)
    return project
  }

  async get(id: string): Promise<Project | undefined> {
    return this.projects.get(id)
  }

  async list(filter: ProjectListFilter): Promise<Project[]> {
    return [...this.projects.values()].filter((project) =>
      (filter.status === undefined || project.status === filter.status)
      && (filter.organization === undefined || project.organization === filter.organization))
  }

  async update(
    id: string,
    patch: UpdateProjectInput,
    maxActiveProjects?: number,
  ): Promise<Project | undefined> {
    const current = this.projects.get(id)
    if (current === undefined) return undefined
    for (const project of this.projects.values()) {
      if (project.id !== id && patch.rootPath !== undefined && project.rootPath === patch.rootPath) {
        throw new ProjectError(409, 'ROOT_PATH_CONFLICT', 'another project already uses this root path')
      }
    }
    if (patch.status === 'active' && maxActiveProjects !== undefined) {
      const activeOthers = [...this.projects.values()]
        .filter((project) => project.id !== id && project.status === 'active')
        .length
      if (activeOthers >= maxActiveProjects) {
        throw new ProjectError(
          409,
          'ACTIVE_PROJECT_LIMIT_REACHED',
          `the maximum of ${maxActiveProjects} active projects has been reached`,
        )
      }
    }
    const next: Project = { ...current, ...patch, updatedAt: new Date().toISOString() }
    this.projects.set(id, next)
    return next
  }

  async remove(id: string): Promise<boolean> {
    return this.projects.delete(id)
  }

  async countActive(): Promise<number> {
    return [...this.projects.values()].filter((project) => project.status === 'active').length
  }
}
