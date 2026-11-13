import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage, type ChatApi } from '../api/client.ts'
import {
  apiProjectInput,
  apiProjectToProject,
  ProjectRepository,
  type Project,
  type ProjectDraft,
} from '../data/projects.ts'
import type { ProjectStatus } from '../api/types.ts'
import type { StorageLike } from '../lib/storage.ts'

export type ProjectsMode = 'loading' | 'api' | 'local'

export interface ProjectsController {
  projects: Project[]
  mode: ProjectsMode
  loading: boolean
  error?: string
  refresh: () => Promise<void>
  create: (draft: ProjectDraft) => Promise<Project>
  update: (id: string, draft: ProjectDraft) => Promise<Project>
  remove: (id: string) => Promise<void>
  /** Registry-only: change status via `PATCH /api/projects/:id/status`. */
  setStatus: (id: string, status: ProjectStatus) => Promise<Project>
  canDelete: (project: Project) => boolean
}

/**
 * Use the PostgreSQL project registry when the API exposes it, otherwise fall
 * back to browser-local placeholder projects. The fallback is explicit: the
 * sidebar, project panel and settings all show which mode is active.
 */
export function useProjects(api: ChatApi, storage: StorageLike): ProjectsController {
  const localRepo = useMemo(() => new ProjectRepository(storage), [storage])
  const [projects, setProjects] = useState<Project[]>(() => localRepo.list())
  const [mode, setMode] = useState<ProjectsMode>('loading')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const requestRef = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    try {
      const remote = await api.listProjects()
      if (request !== requestRef.current) return
      setProjects(remote.map(apiProjectToProject))
      setMode('api')
      setError(undefined)
    } catch (caught) {
      if (request !== requestRef.current) return
      // A disabled registry (503), an old API (404) or a network/token failure
      // all leave chat usable. Keep project CRUD local rather than dead-ending.
      setProjects(localRepo.list())
      setMode('local')
      setError(errorMessage(caught))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [api, localRepo])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = useCallback(async (draft: ProjectDraft): Promise<Project> => {
    if (mode === 'loading') throw new Error('The projects registry is still loading.')
    if (mode === 'api') {
      if (draft.kind !== 'api') throw new Error('The registry requires a root path.')
      const saved = apiProjectToProject(await api.createProject(apiProjectInput(draft)))
      setProjects((current) => [saved, ...current])
      return saved
    }

    if (draft.kind !== 'local') throw new Error('Local projects cannot be sent to the API.')
    const saved = localRepo.create({
      name: draft.name,
      description: draft.description,
      color: draft.color,
      workspace: draft.workspace,
      branch: draft.branch,
    })
    setProjects(localRepo.list())
    return saved
  }, [api, localRepo, mode])

  const update = useCallback(async (id: string, draft: ProjectDraft): Promise<Project> => {
    if (mode === 'loading') throw new Error('The projects registry is still loading.')
    if (mode === 'api') {
      if (draft.kind !== 'api') throw new Error('The registry requires a root path.')
      const saved = apiProjectToProject(await api.updateProject(id, apiProjectInput(draft)))
      setProjects((current) => current.map((project) => (
        project.id === id ? saved : project
      )))
      return saved
    }

    if (draft.kind !== 'local') throw new Error('Local projects cannot be sent to the API.')
    const saved = localRepo.update(id, {
      name: draft.name,
      description: draft.description,
      color: draft.color,
      workspace: draft.workspace,
      branch: draft.branch,
    })
    if (saved === undefined) throw new Error('That local project no longer exists.')
    setProjects(localRepo.list())
    return { ...saved }
  }, [api, localRepo, mode])

  const remove = useCallback(async (id: string): Promise<void> => {
    if (mode === 'loading') throw new Error('The projects registry is still loading.')
    if (mode === 'api') {
      await api.deleteProject(id)
      setProjects((current) => current.filter((project) => project.id !== id))
      return
    }
    if (!localRepo.remove(id)) {
      throw new Error('General is the fallback project and cannot be deleted.')
    }
    setProjects(localRepo.list())
  }, [api, localRepo, mode])

  const setStatus = useCallback(async (id: string, status: ProjectStatus): Promise<Project> => {
    if (mode !== 'api') throw new Error('Project status is only available with the projects registry.')
    const saved = apiProjectToProject(await api.setProjectStatus(id, status))
    setProjects((current) => current.map((project) => (project.id === id ? saved : project)))
    return saved
  }, [api, mode])

  const canDelete = useCallback((project: Project): boolean => {
    if (project.source === 'unfiled') return false
    if (mode === 'api') return project.source === 'api'
    return localRepo.canDelete(project.id)
  }, [localRepo, mode])

  return {
    projects,
    mode,
    loading,
    ...(error === undefined ? {} : { error }),
    refresh,
    create,
    update,
    remove,
    setStatus,
    canDelete,
  }
}
