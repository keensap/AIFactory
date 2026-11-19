import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, isAbortError, type ChatApi } from '../api/client.ts'
import type { RunTelemetry, SessionSummary } from '../api/types.ts'
import type { MessagesStatus } from '../components/ChatView.tsx'
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
import {
  composePdfInstruction,
  composePdfIntro,
  composeTextRequirement,
  formatBytes,
  type RequirementSubmission,
} from '../data/requirements.ts'
import { truncate } from '../lib/format.ts'
import { withStageContext } from '../data/stageChat.ts'
import { newId } from '../lib/id.ts'

export interface UseProjectChatOptions {
  api: ChatApi
  project: Project
  /** The open chat, or null for a draft. The caller owns it (URL on the chat page, local state when embedded). */
  sessionId: string | null
  sessions: SessionSummary[]
  /** Ask the owner to show another chat. `replace` is set when a draft just became a real session. */
  onSessionChange: (sessionId: string | null, options?: { replace?: boolean }) => void
  onSessionStarted: (session: SessionSummary, projectId: string) => void
  onRefreshSessions: () => Promise<void>
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
  /** Stage chats: context block added (hidden in the transcript) to the first message of a new session. */
  contextForNewSession?: () => string | null
  /** Show the requirements intake on an empty project (default true; stage chats turn it off). */
  intake?: boolean
}

/**
 * Chat state for one project: messages, the streamed turn and the optional
 * requirements intake. Shared by the full chat page and the stage workspace's
 * Chat tab so there is only one implementation.
 */
export function useProjectChat({
  api,
  project,
  sessionId: routeSessionId,
  sessions,
  onSessionChange,
  onSessionStarted,
  onRefreshSessions,
  onNotify,
  contextForNewSession,
  intake = true,
}: UseProjectChatOptions) {
  const contextRef = useRef(contextForNewSession)
  contextRef.current = contextForNewSession
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [messagesStatus, setMessagesStatus] = useState<MessagesStatus>('ready')
  const [messagesError, setMessagesError] = useState<string | undefined>()
  const [turn, setTurn] = useState<TurnState>(IDLE_TURN)
  // Latest API telemetry snapshot of the open conversation (replaced, never summed).
  const [telemetry, setTelemetry] = useState<RunTelemetry | null>(null)
  const [telemetryStale, setTelemetryStale] = useState(false)
  const [streamingSessionId, setStreamingSessionId] = useState<string | null>(null)
  const [draftKey, setDraftKey] = useState(0)

  const streamAbortRef = useRef<AbortController | null>(null)
  const streamingRef = useRef(false)
  /** Session id announced by the running stream; its change must not reload. */
  const streamSessionRef = useRef<string | null>(null)
  const loadAbortRef = useRef<AbortController | null>(null)
  const loadTokenRef = useRef(0)

  const activeSession = sessions.find((session) => session.id === routeSessionId)
  const firstUserMessage = messages.find((message) => message.role === 'user')
  const sessionTitle = activeSession?.title
    ?? (firstUserMessage === undefined ? null : truncate(firstUserMessage.content, 80))
  const conversationKey = routeSessionId ?? `draft:${project.id}:${draftKey}`
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

  // The owner's session id decides which chat is shown.
  useEffect(() => {
    if (routeSessionId !== null && routeSessionId === streamSessionRef.current) return
    if (streamingRef.current) {
      streamAbortRef.current?.abort()
      onNotify('Stopped the running response to switch chats.', 'info')
    }
    streamSessionRef.current = null
    setTelemetry(null)
    setTelemetryStale(false)
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
    // onNotify is intentionally not a dependency: only session changes reload.
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
    onSessionChange(null)
  }, [archived, onSessionChange, routeSessionId])

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
    setTelemetryStale(false)
    setStreamingSessionId(sessionId)

    let outcome: string | null = null
    const finish = (): void => {
      setTurn(IDLE_TURN)
      setStreamingSessionId(null)
      void onRefreshSessions()
    }

    const context = sessionId === null ? (contextRef.current?.() ?? null) : null
    return api.streamChat({
      message: context === null ? text : withStageContext(context, text),
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
              onSessionChange(nextSessionId, { replace: true })
            }
            break
          }
          case 'status':
            setTurn((current) => ({ ...current, label: statusLabel(event.data.phase) }))
            break
          case 'telemetry':
            setTelemetry(event.data)
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
        setTelemetryStale(true)
        patchMessage(assistantId, { streaming: false, error: message })
        onNotify(message, 'error')
      }
      finish()
    }).finally(() => {
      streamingRef.current = false
      streamAbortRef.current = null
    }).then(() => outcome)
  }, [api, onNotify, onRefreshSessions, onSessionChange, onSessionStarted, patchMessage, project.id, project.source, routeSessionId])

  const [intakeSkipped, setIntakeSkipped] = useState(false)
  const [intakeBusy, setIntakeBusy] = useState(false)
  const showIntake = intake && sessions.length === 0 && routeSessionId === null && !archived && !intakeSkipped

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

  // Leaving the chat stops any running turn.
  useEffect(() => () => {
    streamAbortRef.current?.abort()
    loadAbortRef.current?.abort()
  }, [])

  const retryLoad = useCallback(() => {
    if (routeSessionId === null) void onRefreshSessions()
    else void loadSession(routeSessionId)
  }, [loadSession, onRefreshSessions, routeSessionId])

  return {
    messages,
    messagesStatus,
    messagesError,
    turn,
    telemetry,
    telemetryStale,
    streaming,
    streamingSessionId,
    sessionTitle,
    conversationKey,
    archived,
    sendMessage,
    stopStreaming,
    startNewChat,
    retryLoad,
    showIntake,
    intakeBusy,
    submitRequirements,
    skipIntake: () => setIntakeSkipped(true),
  }
}
