import { useCallback, useEffect, useState } from 'react'
import type { ChatApi } from '../api/client.ts'
import type { ProjectStatus, SessionSummary } from '../api/types.ts'
import { ChatHeader } from '../components/ChatHeader.tsx'
import { ChatView } from '../components/ChatView.tsx'
import { ProjectSidebar } from '../components/ProjectSidebar.tsx'
import { RequirementsIntake } from '../components/RequirementsIntake.tsx'
import { SdlcBar } from '../components/SdlcBar.tsx'
import { loadStage, saveStage, type SdlcStage as LocalStage } from '../data/sdlc.ts'
import { FALLBACK_STAGES } from '../data/stages.ts'
import type { StorageLike } from '../lib/storage.ts'
import type { Project } from '../data/projects.ts'
import type { ApiHealthController } from '../hooks/useApiHealth.ts'
import { useProjectChat } from '../hooks/useProjectChat.ts'
import type { ProjectsMode } from '../hooks/useProjects.ts'
import { truncate } from '../lib/format.ts'
import { navigate } from '../lib/router.ts'

/** API stage keys for the bar, with short labels that fit 30px. */
const REGISTRY_STAGES: readonly LocalStage[] = FALLBACK_STAGES.map((stage) => ({
  id: stage.key,
  label: stage.key === 'planning' ? 'Planning' : stage.name,
  description: stage.name,
}))

export interface ProjectWorkspaceProps {
  api: ChatApi
  storage: StorageLike
  project: Project
  routeSessionId: string | null
  sessions: SessionSummary[]
  projectsMode: ProjectsMode
  health: ApiHealthController
  theme: 'light' | 'dark'
  canDelete: boolean
  onToggleTheme: () => void
  onOpenSettings: () => void
  onSessionStarted: (session: SessionSummary, projectId: string) => void
  onRefreshSessions: () => Promise<void>
  onRequestDeleteSession: (session: SessionSummary) => void
  onSetStatus: (status: ProjectStatus) => void
  onEditProject: () => void
  onDeleteProject: () => void
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
}

export function ProjectWorkspace({
  api,
  storage,
  project,
  routeSessionId,
  sessions,
  projectsMode,
  health,
  theme,
  canDelete,
  onToggleTheme,
  onOpenSettings,
  onSessionStarted,
  onRefreshSessions,
  onRequestDeleteSession,
  onSetStatus,
  onEditProject,
  onDeleteProject,
  onNotify,
}: ProjectWorkspaceProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [stageIndex, setStageIndex] = useState(() => loadStage(storage, project.id))

  const activeSessionId = routeSessionId
  const onSessionChange = useCallback((sessionId: string | null, options?: { replace?: boolean }) => {
    navigate({ name: 'project', projectId: project.id, sessionId }, options ?? {})
  }, [project.id])

  const chat = useProjectChat({
    api,
    project,
    sessionId: routeSessionId,
    sessions,
    onSessionChange,
    onSessionStarted,
    onRefreshSessions,
    onNotify,
  })
  const { messages, messagesStatus, messagesError, turn, streaming, streamingSessionId, sessionTitle, conversationKey, archived, startNewChat } = chat

  // Switching chats closes the mobile sidebar.
  useEffect(() => setSidebarOpen(false), [project.id, routeSessionId])

  useEffect(() => {
    document.title = `${sessionTitle === null ? 'New chat' : truncate(sessionTitle, 42)} · ${project.name} — AI Factory`
  }, [project.name, sessionTitle])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        startNewChat()
      } else if (event.key === 'Escape' && sidebarOpen) {
        setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sidebarOpen, startNewChat])

  return (
    <div className="project-shell">
      <ProjectSidebar
        project={project}
        canDelete={canDelete}
        mobileOpen={sidebarOpen}
        onCloseMobile={() => setSidebarOpen(false)}
        onSetStatus={onSetStatus}
        onEdit={onEditProject}
        onDelete={onDeleteProject}
      />
      {sidebarOpen && (
        <div className="scrim project-sidebar-scrim" role="presentation" onClick={() => setSidebarOpen(false)} />
      )}

      <main className="workspace">
        <ChatHeader
          project={project}
          sessionTitle={sessionTitle}
          sessions={sessions}
          activeSessionId={activeSessionId}
          streamingSessionId={streamingSessionId}
          canStartChat={!archived}
          theme={theme}
          health={health.state}
          onOpenSidebar={() => setSidebarOpen(true)}
          onNewChat={startNewChat}
          onDeleteSession={onRequestDeleteSession}
          onOpenSettings={onOpenSettings}
          onToggleTheme={onToggleTheme}
        />
        {project.currentStage !== undefined ? (
          // Registry project: the stage comes from the API; clicking opens the stage workspace.
          <SdlcBar
            stages={REGISTRY_STAGES}
            currentIndex={Math.max(0, REGISTRY_STAGES.findIndex((stage) => stage.id === project.currentStage))}
            selectHint="open the stage workspace"
            selectCurrent
            onSelect={(index) => {
              const stage = REGISTRY_STAGES[index]
              if (stage !== undefined) navigate({ name: 'stage', projectId: project.id, stage: stage.id, runId: null })
            }}
          />
        ) : (
          <SdlcBar
            currentIndex={stageIndex}
            onSelect={(index) => {
              setStageIndex(index)
              saveStage(storage, project.id, index)
            }}
          />
        )}
        <ChatView
          project={project}
          projectsMode={projectsMode}
          conversationKey={conversationKey}
          messages={messages}
          messagesStatus={messagesStatus}
          messagesError={messagesError}
          turn={turn}
          telemetry={chat.telemetry}
          telemetryStale={chat.telemetryStale}
          streaming={streaming}
          health={health.state}
          onSend={(text) => void chat.sendMessage(text)}
          onStop={chat.stopStreaming}
          onRetryLoad={chat.retryLoad}
          onNewChat={startNewChat}
          onRefreshHealth={health.refresh}
          onOpenSettings={onOpenSettings}
          onCreateProject={() => navigate({ name: 'create-project' })}
          newChatBlocked={archived && activeSessionId === null}
          {...(chat.showIntake ? {
            intake: (
              <RequirementsIntake
                project={project}
                pdfSupported={project.source === 'api'}
                busy={chat.intakeBusy}
                onSubmit={(submission) => void chat.submitRequirements(submission)}
                onSkip={chat.skipIntake}
              />
            ),
          } : {})}
          onCopy={(message) => onNotify(message, 'success')}
        />
      </main>
    </div>
  )
}
