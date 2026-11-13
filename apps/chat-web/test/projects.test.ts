import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROJECT_ID,
  PROJECTS_KEY,
  ProjectRepository,
  apiProjectToProject,
  defaultProjects,
  projectColorForId,
} from '../src/data/projects.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

describe('ProjectRepository', () => {
  it('seeds the placeholder projects when storage is empty', () => {
    const repo = new ProjectRepository(createMemoryStorage())
    const projects = repo.list()
    expect(projects.map((project) => project.name)).toEqual([
      'General',
      'Atlas Console',
      'Forge Agents',
    ])
    expect(repo.getDefault().id).toBe(DEFAULT_PROJECT_ID)
    expect(projects.every((project) => project.seeded === true)).toBe(true)
    expect(projects.every((project) => project.source === 'local')).toBe(true)
  })

  it('creates and persists a project', () => {
    const storage = createMemoryStorage()
    const repo = new ProjectRepository(storage)
    const created = repo.create({
      name: '  Release   train  ',
      description: 'Ship weekly.',
      color: 'teal',
      workspace: '/work/release',
      branch: 'main',
    })
    expect(created.name).toBe('Release train')
    expect(created.description).toBe('Ship weekly.')
    expect(created.seeded).toBeUndefined()

    const reloaded = new ProjectRepository(storage)
    expect(reloaded.list()[0]?.id).toBe(created.id)
    expect(reloaded.list()[0]?.name).toBe('Release train')
  })

  it('updates a project without losing its identity', () => {
    const repo = new ProjectRepository(createMemoryStorage())
    const updated = repo.update('project-atlas', { name: 'Atlas Ops', color: 'rose' })
    expect(updated?.id).toBe('project-atlas')
    expect(updated?.name).toBe('Atlas Ops')
    expect(updated?.color).toBe('rose')
    expect(updated?.updatedAt).not.toBe(updated?.createdAt)
  })

  it('protects General and allows deleting other projects', () => {
    const repo = new ProjectRepository(createMemoryStorage())
    expect(repo.canDelete(DEFAULT_PROJECT_ID)).toBe(false)
    expect(repo.remove(DEFAULT_PROJECT_ID)).toBe(false)
    expect(repo.canDelete('project-atlas')).toBe(true)
    expect(repo.remove('project-atlas')).toBe(true)
    expect(repo.list().map((project) => project.id)).not.toContain('project-atlas')
  })

  it('restores the seeds after a reset', () => {
    const repo = new ProjectRepository(createMemoryStorage())
    repo.remove('project-atlas')
    repo.reset()
    expect(repo.list().map((project) => project.id)).toEqual(
      defaultProjects().map((project) => project.id),
    )
  })

  it('falls back to seeds when stored data is malformed', () => {
    const storage = createMemoryStorage({ [PROJECTS_KEY]: 'not-json' })
    expect(new ProjectRepository(storage).list()).toHaveLength(3)

    const wrongShape = createMemoryStorage({ [PROJECTS_KEY]: JSON.stringify({ nope: true }) })
    expect(new ProjectRepository(wrongShape).list()).toHaveLength(3)
  })

  it('ensures General exists when stored projects omit it', () => {
    const storage = createMemoryStorage({
      [PROJECTS_KEY]: JSON.stringify([
        {
          id: 'project-solo',
          name: 'Solo',
          description: '',
          color: 'green',
          workspace: '',
          branch: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    })
    const repo = new ProjectRepository(storage)
    expect(repo.list()[0]?.id).toBe(DEFAULT_PROJECT_ID)
    expect(repo.list()[1]?.id).toBe('project-solo')
  })
})


describe('registry project mapping', () => {
  it('maps the API record into the UI model', () => {
    const project = apiProjectToProject({
      id: '7e8fb883-4e1d-4c13-ab77-566bf4b2e178',
      name: 'customer-portal',
      rootPath: '/srv/projects/customer-portal',
      organization: 'Acme',
      ownerEmail: 'owner@acme.example',
      status: 'active',
      createdAt: '2026-11-10T04:49:18.845Z',
      updatedAt: '2026-11-10T04:50:18.845Z',
    })
    expect(project).toMatchObject({
      id: '7e8fb883-4e1d-4c13-ab77-566bf4b2e178',
      name: 'customer-portal',
      workspace: '/srv/projects/customer-portal',
      organization: 'Acme',
      ownerEmail: 'owner@acme.example',
      status: 'active',
      source: 'api',
      description: '',
      branch: '',
    })
    expect(project.color).toBe(projectColorForId(project.id))
  })

  it('derives a stable accent from the project id', () => {
    expect(projectColorForId('same-id')).toBe(projectColorForId('same-id'))
    expect(['indigo', 'sky', 'teal', 'amber', 'rose', 'violet', 'green'])
      .toContain(projectColorForId('anything'))
  })
})
