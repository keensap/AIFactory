import {
  DEFAULT_MAX_ACTIVE_PROJECTS,
  type ChatSettings,
  type SettingsStore,
} from '../../src/settings.ts'

export class MemorySettingsStore implements SettingsStore {
  private maxActiveProjects = DEFAULT_MAX_ACTIVE_PROJECTS
  private updatedAt = new Date().toISOString()

  async get(): Promise<ChatSettings> {
    return { maxActiveProjects: this.maxActiveProjects, updatedAt: this.updatedAt }
  }

  async update(maxActiveProjects: number): Promise<ChatSettings> {
    this.maxActiveProjects = maxActiveProjects
    this.updatedAt = new Date().toISOString()
    return this.get()
  }
}
