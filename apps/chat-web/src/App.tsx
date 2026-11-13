import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError, ChatApi, errorMessage, isAbortError } from './api/client.ts'
import type { SessionSummary } from './api/types.ts'
import { ConfirmDialog } from './components/ConfirmDialog.tsx'
import { ProjectDialog } from './components/ProjectDialog.tsx'
import { SettingsDialog, type TestResult } from './components/SettingsDialog.tsx'
import { ToastViewport } from './components/ToastViewport.tsx'
import {
  assignSession,
  loadAssignments,
  reconcileAssignments,
  removeAssignment,
  saveAssignments,
  sessionProjectId,
  type AssignmentMap,
} from './data/assignments.ts'
import { DEFAULT_PROJECT_ID, type Project, type ProjectDraft } from './data/projects.ts'
import { loadSettings, saveSettings, type AppSettings, type ThemePreference } from './data/settings.ts'
import { useApiHealth } from './hooks/useApiHealth.ts'
import { useProjects } from './hooks/useProjects.ts'
import { useTheme } from './hooks/useTheme.ts'
import { useToasts } from './hooks/useToasts.ts'
import { truncate } from './lib/format.ts'
import { navigate, routeProjectId, useRoute } from './lib/router.ts'
import { browserStorage } from './lib/storage.ts'
import { CreateProjectPage } from './pages/CreateProjectPage.tsx'
import { LandingPage, type ProjectActivity } from './pages/LandingPage.tsx'
import { ProjectWorkspace } from './pages/ProjectWorkspace.tsx'
import { LogsPage } from './pages/LogsPage.tsx'
import { StageWorkspace } from './pages/StageWorkspace.tsx'
import { AppHeader } from './components/AppHeader.tsx'
import { ArrowLeftIcon } from './components/Icons.tsx'
import { routeHref } from './lib/router.ts'

function upsertSession(list: SessionSummary[], summary: SessionSummary): SessionSummary[] {
  return [summary, ...list.filter((session) => session.id !== summary.id)]
}

/**
 * Router + shared state. Pages:
 *   #/                 LandingPage (project list)
 *   #/projects/new     CreateProjectPage
 *   #/projects/:id     ProjectWorkspace (chat), optionally /chats/:sessionId
 */
export function App() {
  const storage = useMemo(() => browserStorage(), [])
  const theme = useTheme(storage)
  const toasts = useToasts()
  const route = useRoute()

  const [settings, setSettings] = useState<AppSettings>(() => loadSettings(storage))
  const api = useMemo(
    () => new ChatApi({ baseUrl: settings.apiBaseUrl, token: settings.apiToken }),
    [settings],
  )
  const health = useApiHealth(api)
  const {
    projects,
    mode: projectsMode,
    loading: projectsLoading,
    error: projectsError,
    refresh: refreshProjects,
    create: createProject,
    update: updateProject,
    remove: removeProject,
    setStatus: setProjectStatus,
    canDelete: canDeleteProject,
  } = useProjects(api, storage)

  const [assignments, setAssignments] = useState<AssignmentMap>(() => loadAssignments(storage))
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsStatus, setSessionsStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [pendingDeleteSession, setPendingDeleteSession] = useState<SessionSummary | null>(null)
  const [pendingDeleteProject, setPendingDeleteProject] = useState<Project | null>(null)
  const [deletingSession, setDeletingSession] = useState(false)
  const [deletingProject, setDeletingProject] = useState(false)

  const refreshSessions = useCallback(async (options: { silent?: boolean } = {}) => {
    if (options.silent !== true) setSessionsStatus('loading')
    try {
      setSessions(await api.listSessions())
      setSessionsStatus('ready')
    } catch (error) {
      if (isAbortError(error)) return
      setSessionsStatus((current) => (options.silent === true && current === 'ready' ? current : 'error'))
    }
  }, [api])

  useEffect(() => {
    setSessions([])
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => saveAssignments(storage, assignments), [assignments, storage])

  // Local mode only: file older chats under General. In registry mode a chat
  // belongs to a project only if the API bound it (or it was started here).
  useEffect(() => {
    if (sessionsStatus !== 'ready' || projectsMode !== 'local') return
    setAssignments((current) => {
      const next = reconcileAssignments(sessions, projects, current, DEFAULT_PROJECT_ID)
      return next.changed ? next.assignments : current
    })
  }, [projects, projectsMode, sessions, sessionsStatus])

  const sessionsByProject = useMemo(() => {
    const known = new Set(projects.map((project) => project.id))
    const groups = new Map<string, SessionSummary[]>()
    for (const project of projects) groups.set(project.id, [])
    for (const session of sessions) {
      const projectId = sessionProjectId(session, assignments, known)
      if (projectId !== undefined) groups.get(projectId)?.push(session)
    }
    for (const list of groups.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return groups
  }, [assignments, projects, sessions])

  const activity = useMemo(() => {
    const map = new Map<string, ProjectActivity>()
    for (const [projectId, list] of sessionsByProject) {
      map.set(projectId, {
        chats: list.length,
        ...(list[0] === undefined ? {} : { lastActivity: list[0].updatedAt }),
      })
    }
    return map
  }, [sessionsByProject])

  const routeProjectKey = routeProjectId(route)
  const routeProject = routeProjectKey === null
    ? undefined
    : projects.find((project) => project.id === routeProjectKey)

  // A link to a project created elsewhere (another tab, the CLI): refresh the
  // project list once before showing "not found".
  const [refreshedFor, setRefreshedFor] = useState<string | null>(null)
  const missingProjectId = routeProjectKey !== null && routeProject === undefined && projectsMode !== 'loading'
    ? routeProjectKey
    : null

  // `#/projects/:id` opens the current stage for registry projects, the chat otherwise.
  useEffect(() => {
    if (routeProject === undefined || projectsMode === 'loading') return
    if ((route.name === 'stage' || route.name === 'logs') && projectsMode !== 'api') {
      // Local projects have no stage runtime: use the chat workspace.
      navigate({ name: 'project', projectId: routeProject.id, sessionId: null }, { replace: true })
      return
    }
    if (route.name !== 'project-home') return
    if (projectsMode === 'api') {
      navigate({ name: 'stage', projectId: routeProject.id, stage: routeProject.currentStage ?? 'planning', runId: null }, { replace: true })
    } else {
      navigate({ name: 'project', projectId: routeProject.id, sessionId: null }, { replace: true })
    }
  }, [route, routeProject, projectsMode])
  useEffect(() => {
    if (missingProjectId === null || missingProjectId === refreshedFor) return
    setRefreshedFor(missingProjectId)
    void refreshProjects()
  }, [missingProjectId, refreshProjects, refreshedFor])

  useEffect(() => {
    if (route.name === 'home') document.title = 'Projects — AI Factory Chat'
    else if (route.name === 'create-project') document.title = 'Create project — AI Factory Chat'
  }, [route.name])

  const onSessionStarted = useCallback((summary: SessionSummary, projectId: string) => {
    setAssignments((current) => assignSession(current, summary.id, projectId))
    setSessions((current) => upsertSession(current, summary))
  }, [])

  const silentRefresh = useCallback(() => refreshSessions({ silent: true }), [refreshSessions])

  const confirmDeleteSession = useCallback(async () => {
    if (pendingDeleteSession === null) return
    const target = pendingDeleteSession
    setDeletingSession(true)
    try {
      await api.deleteSession(target.id)
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        toasts.push(errorMessage(error), 'error')
        setDeletingSession(false)
        return
      }
    }
    setSessions((current) => current.filter((session) => session.id !== target.id))
    setAssignments((current) => removeAssignment(current, target.id))
    if (route.name === 'project' && route.sessionId === target.id) {
      navigate({ name: 'project', projectId: route.projectId, sessionId: null }, { replace: true })
    }
    setPendingDeleteSession(null)
    setDeletingSession(false)
    toasts.push('Chat deleted', 'success')
  }, [api, pendingDeleteSession, route, toasts])

  const confirmDeleteProject = useCallback(async () => {
    if (pendingDeleteProject === null) return
    setDeletingProject(true)
    try {
      await removeProject(pendingDeleteProject.id)
      setPendingDeleteProject(null)
      navigate({ name: 'home' }, { replace: true })
      toasts.push(`Deleted “${pendingDeleteProject.name}”. Its directory was not touched.`, 'success')
    } catch (error) {
      toasts.push(errorMessage(error), 'error')
    } finally {
      setDeletingProject(false)
    }
  }, [pendingDeleteProject, removeProject, toasts])

  const saveEditedProject = useCallback(async (draft: ProjectDraft): Promise<string | undefined> => {
    if (editingProject === null) return undefined
    try {
      await updateProject(editingProject.id, draft)
      toasts.push('Project updated', 'success')
      return undefined
    } catch (error) {
      return errorMessage(error)
    }
  }, [editingProject, toasts, updateProject])

  const saveConnectionSettings = useCallback((next: AppSettings, nextTheme: ThemePreference) => {
    const apiChanged = next.apiBaseUrl !== settings.apiBaseUrl || next.apiToken !== settings.apiToken
    saveSettings(storage, next)
    theme.setPreference(nextTheme)
    if (apiChanged) setSettings(next)
    setSettingsOpen(false)
    toasts.push(apiChanged ? 'Connection settings saved' : 'Settings saved', 'success')
  }, [settings, storage, theme, toasts])

  const testConnection = useCallback(async (candidate: AppSettings): Promise<TestResult> => {
    const client = new ChatApi({ baseUrl: candidate.apiBaseUrl, token: candidate.apiToken })
    try {
      const result = await client.health()
      return {
        ok: true,
        message: `Connected to v${result.version}${result.harness === null ? '' : ` · ${result.harness.profile}`}`,
      }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }, [])

  const openSettings = useCallback(() => setSettingsOpen(true), [])

  let page
  if (route.name === 'create-project') {
    page = (
      <CreateProjectPage
        api={api}
        projectsMode={projectsMode}
        health={health.state}
        theme={theme.resolved}
        onOpenSettings={openSettings}
        onToggleTheme={theme.toggle}
        onCreate={createProject}
        onCreated={(project) => {
          toasts.push(`Created “${project.name}”`, 'success')
          navigate({ name: 'project-home', projectId: project.id }, { replace: true })
        }}
      />
    )
  } else if (route.name === 'project' && routeProject !== undefined) {
    page = (
      <ProjectWorkspace
        key={routeProject.id}
        api={api}
        storage={storage}
        project={routeProject}
        routeSessionId={route.sessionId}
        sessions={sessionsByProject.get(routeProject.id) ?? []}
        projectsMode={projectsMode}
        health={health}
        theme={theme.resolved}
        canDelete={canDeleteProject(routeProject)}
        onToggleTheme={theme.toggle}
        onOpenSettings={openSettings}
        onSessionStarted={onSessionStarted}
        onRefreshSessions={silentRefresh}
        onRequestDeleteSession={setPendingDeleteSession}
        onSetStatus={(status) => {
          setProjectStatus(routeProject.id, status)
            .then((saved) => toasts.push(`${saved.name} is now ${status}`, 'success'))
            .catch((error: unknown) => toasts.push(errorMessage(error), 'error'))
        }}
        onEditProject={() => setEditingProject(routeProject)}
        onDeleteProject={() => setPendingDeleteProject(routeProject)}
        onNotify={toasts.push}
      />
    )
  } else if (route.name === 'stage' && routeProject !== undefined && projectsMode === 'api') {
    page = (
      <StageWorkspace
        key={routeProject.id}
        api={api}
        storage={storage}
        project={routeProject}
        routeStage={route.stage}
        routeRunId={route.runId}
        health={health}
        theme={theme.resolved}
        onToggleTheme={theme.toggle}
        onOpenSettings={openSettings}
        onEditProject={() => setEditingProject(routeProject)}
        onProjectChanged={() => void refreshProjects()}
        onNotify={toasts.push}
      />
    )
  } else if (route.name === 'logs' && routeProject !== undefined && projectsMode === 'api') {
    page = (
      <LogsPage
        key={routeProject.id}
        api={api}
        storage={storage}
        project={routeProject}
        initialSearch={route.search}
        health={health}
        theme={theme.resolved}
        onToggleTheme={theme.toggle}
        onOpenSettings={openSettings}
        onNotify={toasts.push}
      />
    )
  } else if ((route.name === 'stage' || route.name === 'logs' || route.name === 'project-home') && routeProject !== undefined) {
    // Redirecting (see the effect above).
    page = null
  } else if (routeProjectKey !== null) {
    page = (
      <div className="page">
        <AppHeader health={health.state} theme={theme.resolved} onOpenSettings={openSettings} onToggleTheme={theme.toggle} />
        <main className="page-main page-narrow">
          {projectsMode === 'loading' || projectsLoading ? (
            <p className="section-empty">Loading project…</p>
          ) : (
            <div className="section-empty">
              <p>This project doesn’t exist or was removed.</p>
              <a className="back-link" href={routeHref({ name: 'home' })}><ArrowLeftIcon size={15} /> All projects</a>
            </div>
          )}
        </main>
      </div>
    )
  } else {
    page = (
      <LandingPage
        projects={projects}
        projectsMode={projectsMode}
        {...(projectsError === undefined ? {} : { projectsError })}
        activity={activity}
        health={health.state}
        theme={theme.resolved}
        onOpenSettings={openSettings}
        onToggleTheme={theme.toggle}
      />
    )
  }

  return (
    <>
      {page}

      <ProjectDialog
        open={editingProject !== null}
        mode={editingProject?.source === 'api' ? 'api' : 'local'}
        {...(editingProject === null ? {} : { project: editingProject })}
        onClose={() => setEditingProject(null)}
        onSave={saveEditedProject}
      />
      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        theme={theme.preference}
        health={health.state}
        projectsMode={projectsMode}
        {...(projectsError === undefined ? {} : { projectsError })}
        projectsLoading={projectsLoading}
        onClose={() => setSettingsOpen(false)}
        onSave={saveConnectionSettings}
        onTest={testConnection}
        onRefreshProjects={refreshProjects}
      />
      <ConfirmDialog
        open={pendingDeleteSession !== null}
        title="Delete chat?"
        description={pendingDeleteSession === null ? '' : (
          <>
            <strong>“{truncate(pendingDeleteSession.title, 70)}”</strong> will be removed from
            the API’s chat history. The harness transcript on disk is not deleted.
          </>
        )}
        confirmLabel="Delete chat"
        busy={deletingSession}
        onConfirm={() => void confirmDeleteSession()}
        onClose={() => {
          if (!deletingSession) setPendingDeleteSession(null)
        }}
      />
      <ConfirmDialog
        open={pendingDeleteProject !== null}
        title="Delete project?"
        description={pendingDeleteProject === null ? '' : (
          <>
            <strong>“{truncate(pendingDeleteProject.name, 70)}”</strong>{' '}
            {pendingDeleteProject.source === 'api'
              ? 'will be removed from the project registry. Its directory and chat transcripts are not deleted.'
              : 'will be removed from this browser. Its chats are not deleted.'}
          </>
        )}
        confirmLabel="Delete project"
        busy={deletingProject}
        onConfirm={() => void confirmDeleteProject()}
        onClose={() => {
          if (!deletingProject) setPendingDeleteProject(null)
        }}
      />

      <ToastViewport {...toasts} />
    </>
  )
}
