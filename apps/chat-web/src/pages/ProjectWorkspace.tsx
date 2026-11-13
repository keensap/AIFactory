import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage, isAbortError, type ChatApi } from '../api/client.ts'
import type { ProjectStatus, SessionSummary } from '../api/types.ts'
import { ChatHeader } from '../components/ChatHeader.tsx'
import { ChatView, type MessagesStatus } from '../components/ChatView.tsx'
import { ProjectSidebar } from '../components/ProjectSidebar.tsx'
import { RequirementsIntake } from '../components/RequirementsIntake.tsx'
import { SdlcBar } from '../components/SdlcBar.tsx'
import {
  composePdfInstruction,
  composePdfIntro,
  composeTextRequirement,
  formatBytes,
  type RequirementSubmission,
} from '../data/requirements.ts'
import { loadStage, saveStage, type SdlcStage as LocalStage } from '../data/sdlc.ts'
import { FALLBACK_STAGES } from '../data/stages.ts'
import type { StorageLike } from '../lib/storage.ts'
import {
  addToolCall,
  completeToolCall,
  IDLE_TURN,
  statusLabel,
  toUiMessages,
  type TurnState,
  type UiMessage,
} from '../data/chat.ts'
import type { Project } from '../data/projects.ts'
import type { ApiHealthController } from '../hooks/useApiHealth.ts'
import type { ProjectsMode } from '../hooks/useProjects.ts'
import { truncate } from '../lib/format.ts'
import { newId } from '../lib/id.ts'
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
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [messagesStatus, setMessagesStatus] = useState<MessagesStatus>('ready')
  const [messagesError, setMessagesError] = useState<string | undefined>()
  const [turn, setTurn] = useState<TurnState>(IDLE_TURN)
  const [streamingSessionId, setStreamingSessionId] = useState<string | null>(null)
  const [draftKey, setDraftKey] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [stageIndex, setStageIndex] = useState(() => loadStage(storage, project.id))

  const streamAbortRef = useRef<AbortController | null>(null)
  const streamingRef = useRef(false)
  /** Session id announced by the running stream; its route change must not reload. */
  const streamSessionRef = useRef<string | null>(null)
  const loadAbortRef = useRef<AbortController | null>(null)
  const loadTokenRef = useRef(0)

  const activeSessionId = routeSessionId
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const firstUserMessage = useMemo(() => messages.find((message) => message.role === 'user'), [messages])
  const sessionTitle = activeSession?.title
    ?? (firstUserMessage === undefined ? null : truncate(firstUserMessage.content, 80))
  const conversationKey = activeSessionId ?? `draft:${project.id}:${draftKey}`
  const streaming = turn.status !== 'idle'
  const archived = project.status === 'archived'

  const patchMessage = useCallback((id: string, patch: Partial<UiMessage>) => {
    setMessages((current) => current.map((message) => (message.id === id ? { ...message, ...patch } : message)))
  }, [])

  const loadSession = useCallback(async (sessionId: string) => {
    loadAbortRef.current?.abort()
    const controller = new AbortController()
    loadAbortRef.current = controller
    const token = ++loadTokenRef.current
    setMessages([])
    setMessagesStatus('loading')
    setMessagesError(undefined)
    try {
      const records = await api.getMessages(sessionId, controller.signal)
      if (token !== loadTokenRef.current) return
      setMessages(toUiMessages(records))
      setMessagesStatus('ready')
    } catch (error) {
      if (isAbortError(error) || token !== loadTokenRef.current) return
      setMessagesStatus('error')
      setMessagesError(errorMessage(error))
    }
  }, [api])

  // The route decides which chat is shown.
  useEffect(() => {
    if (routeSessionId !== null && routeSessionId === streamSessionRef.current) return
    if (streamingRef.current) {
      streamAbortRef.current?.abort()
      onNotify('Stopped the running response to switch chats.', 'info')
    }
    streamSessionRef.current = null
    setSidebarOpen(false)
    if (routeSessionId === null) {
      loadAbortRef.current?.abort()
      loadTokenRef.current += 1
      setMessages([])
      setMessagesStatus('ready')
      setMessagesError(undefined)
      setTurn(IDLE_TURN)
      setDraftKey((key) => key + 1)
    } else {
      void loadSession(routeSessionId)
    }
    // onNotify is intentionally not a dependency: only route changes reload.
  }, [project.id, routeSessionId, loadSession]) // eslint-disable-line react-hooks/exhaustive-deps

  const startNewChat = useCallback(() => {
    if (archived) return
    if (routeSessionId === null) {
      // Already on a draft: just reset it.
      if (streamingRef.current) return
      setMessages([])
      setMessagesStatus('ready')
      setMessagesError(undefined)
      setDraftKey((key) => key + 1)
      return
    }
    navigate({ name: 'project', projectId: project.id, sessionId: null })
  }, [archived, project.id, routeSessionId])

  const stopStreaming = useCallback(() => {
    if (streamAbortRef.current === null) return
    setTurn((current) => (current.status === 'running' ? { ...current, status: 'stopping', label: 'Stopping' } : current))
    streamAbortRef.current.abort()
  }, [])

  /** Run one streamed turn. Resolves with the session id, or null if it failed or was stopped. */
  const sendMessage = useCallback((text: string): Promise<string | null> => {
    if (streamingRef.current) return Promise.resolve(null)
    const projectId = project.id
    const now = new Date().toISOString()
    const assistantId = newId('msg')
    streamingRef.current = true
    const controller = new AbortController()
    streamAbortRef.current = controller
    let sessionId = routeSessionId
    let assistantText = ''
    // Registry projects scope a new session to their root path; a continued
    // session is already bound server-side, so projectId is sent only once.
    const scopedProjectId = sessionId === null && project.source === 'api' ? projectId : undefined

    setMessages((current) => [
      ...current,
      { id: newId('msg'), role: 'user', content: text, at: now },
      { id: assistantId, role: 'assistant', content: '', at: now, streaming: true },
    ])
    setMessagesStatus('ready')
    setMessagesError(undefined)
    setTurn({ status: 'running', label: 'Thinking', startedAt: Date.now(), tools: [] })
    setStreamingSessionId(sessionId)

    let outcome: string | null = null
    const finish = (): void => {
      setTurn(IDLE_TURN)
      setStreamingSessionId(null)
      void onRefreshSessions()
    }

    return api.streamChat({
      message: text,
      ...(sessionId === null ? {} : { sessionId }),
      ...(scopedProjectId === undefined ? {} : { projectId: scopedProjectId }),
      signal: controller.signal,
      onEvent: (event) => {
        switch (event.event) {
          case 'session': {
            const nextSessionId = event.data.sessionId
            if (sessionId !== nextSessionId) {
              sessionId = nextSessionId
              streamSessionRef.current = nextSessionId
              setStreamingSessionId(nextSessionId)
              onSessionStarted({
                id: nextSessionId,
                title: truncate(text, 80),
                createdAt: now,
                updatedAt: now,
                messageCount: 2,
                ...(scopedProjectId === undefined ? {} : { projectId: scopedProjectId }),
              }, projectId)
              navigate({ name: 'project', projectId, sessionId: nextSessionId }, { replace: true })
            }
            break
          }
          case 'status':
            setTurn((current) => ({ ...current, label: statusLabel(event.data.phase) }))
            break
          case 'text':
            assistantText = assistantText === '' ? event.data.text : `${assistantText}\n\n${event.data.text}`
            patchMessage(assistantId, { content: assistantText })
            setTurn((current) => (current.status === 'running' ? { ...current, label: 'Writing' } : current))
            break
          case 'tool_call': {
            const name = event.data.name ?? 'tool'
            setTurn((current) => ({ ...current, label: `Running ${name}`, tools: addToolCall(current.tools, name) }))
            break
          }
          case 'tool_result':
            setTurn((current) => ({
              ...current,
              label: 'Working',
              tools: completeToolCall(current.tools, event.data.name, event.data.status, event.data.error),
            }))
            break
          case 'final':
            if (assistantText === '' && event.data.text !== '') {
              assistantText = event.data.text
              patchMessage(assistantId, { content: assistantText })
            }
            break
          case 'done':
            if (event.data.text !== '') assistantText = event.data.text
            patchMessage(assistantId, { content: assistantText, streaming: false })
            break
          default:
            break
        }
      },
    }).then(() => {
      patchMessage(assistantId, { content: assistantText, streaming: false })
      outcome = sessionId
      finish()
    }).catch((error: unknown) => {
      if (isAbortError(error)) {
        patchMessage(assistantId, { streaming: false, stopped: true })
      } else {
        const message = errorMessage(error)
        patchMessage(assistantId, { streaming: false, error: message })
        onNotify(message, 'error')
      }
      finish()
    }).finally(() => {
      streamingRef.current = false
      streamAbortRef.current = null
    }).then(() => outcome)
  }, [api, onNotify, onRefreshSessions, onSessionStarted, patchMessage, project.id, project.source, routeSessionId])

  const [intakeSkipped, setIntakeSkipped] = useState(false)
  const [intakeBusy, setIntakeBusy] = useState(false)
  const showIntake = sessions.length === 0 && routeSessionId === null && !archived && !intakeSkipped

  const submitRequirements = useCallback(async (submission: RequirementSubmission) => {
    if (streamingRef.current) return
    setIntakeBusy(true)
    try {
      if (submission.kind === 'text') {
        await sendMessage(composeTextRequirement(submission.text, submission.message))
        return
      }

      // pdf-review needs an existing session: open it with a short intro turn.
      const file = submission.file
      const sessionId = await sendMessage(composePdfIntro(project.name, file.name, submission.message))
      if (sessionId === null) return

      const now = new Date().toISOString()
      const assistantId = newId('msg')
      streamingRef.current = true
      const controller = new AbortController()
      streamAbortRef.current = controller
      setMessages((current) => [
        ...current,
        {
          id: newId('msg'),
          role: 'user',
          content: `📎 ${file.name} (${formatBytes(file.size)})${submission.message.trim() === '' ? '' : `\n\n${submission.message.trim()}`}`,
          at: now,
        },
        { id: assistantId, role: 'assistant', content: '', at: now, streaming: true },
      ])
      setTurn({ status: 'running', label: 'Reviewing requirements', startedAt: Date.now(), tools: [] })
      setStreamingSessionId(sessionId)
      try {
        const result = await api.reviewPdf({
          projectId: project.id,
          sessionId,
          file,
          filename: file.name,
          message: composePdfInstruction(submission.message),
          signal: controller.signal,
        })
        const pages = `${result.document.pages} page${result.document.pages === 1 ? '' : 's'}`
        const note = result.document.truncated ? ' The document was long, so only part of its text was reviewed.' : ''
        patchMessage(assistantId, {
          content: `${result.analysis.markdown}\n\n---\n_Reviewed “${result.document.filename}” (${pages}).${note}_`,
          streaming: false,
        })
      } catch (error) {
        if (isAbortError(error)) {
          patchMessage(assistantId, { streaming: false, stopped: true })
        } else {
          const message = errorMessage(error)
          patchMessage(assistantId, { streaming: false, error: message })
          onNotify(message, 'error')
        }
      } finally {
        streamingRef.current = false
        streamAbortRef.current = null
        setTurn(IDLE_TURN)
        setStreamingSessionId(null)
        void onRefreshSessions()
      }
    } finally {
      setIntakeBusy(false)
    }
  }, [api, onNotify, onRefreshSessions, patchMessage, project.id, project.name, sendMessage])

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

  // Leaving the project stops any running turn.
  useEffect(() => () => {
    streamAbortRef.current?.abort()
    loadAbortRef.current?.abort()
  }, [])

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
          streaming={streaming}
          health={health.state}
          onSend={sendMessage}
          onStop={stopStreaming}
          onRetryLoad={() => {
            if (activeSessionId === null) void onRefreshSessions()
            else void loadSession(activeSessionId)
          }}
          onNewChat={startNewChat}
          onRefreshHealth={health.refresh}
          onOpenSettings={onOpenSettings}
          onCreateProject={() => navigate({ name: 'create-project' })}
          newChatBlocked={archived && activeSessionId === null}
          {...(showIntake ? {
            intake: (
              <RequirementsIntake
                project={project}
                pdfSupported={project.source === 'api'}
                busy={intakeBusy}
                onSubmit={(submission) => void submitRequirements(submission)}
                onSkip={() => setIntakeSkipped(true)}
              />
            ),
          } : {})}
          onCopy={(message) => onNotify(message, 'success')}
        />
      </main>
    </div>
  )
}
