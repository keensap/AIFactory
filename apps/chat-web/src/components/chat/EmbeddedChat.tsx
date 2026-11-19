import type { ChatApi } from '../../api/client.ts'
import type { SessionSummary } from '../../api/types.ts'
import type { Project } from '../../data/projects.ts'
import type { ApiHealthState } from '../../hooks/useApiHealth.ts'
import { useProjectChat } from '../../hooks/useProjectChat.ts'
import { ChatView } from '../ChatView.tsx'

export interface ChatPaneProps {
  api: ChatApi
  project: Project
  /** The conversation shown by this pane; null is a draft. Owned by the dock. */
  sessionId: string | null
  onSessionChange: (sessionId: string | null) => void
  sessions: SessionSummary[]
  health: ApiHealthState
  stageLabel: string
  /** Context block added (hidden) to the first message of a new conversation. */
  contextForNewSession: () => string | null
  onSessionStarted: (session: SessionSummary, projectId: string) => void
  onRefreshSessions: () => Promise<void>
  onRefreshHealth: () => Promise<void>
  onOpenSettings: () => void
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
}

/**
 * One stage conversation. Same chat engine as the legacy full page
 * (`useProjectChat`); the dock decides which conversation each pane shows.
 */
export function ChatPane({
  api,
  project,
  sessionId,
  onSessionChange,
  sessions,
  health,
  stageLabel,
  contextForNewSession,
  onSessionStarted,
  onRefreshSessions,
  onRefreshHealth,
  onOpenSettings,
  onNotify,
}: ChatPaneProps) {
  const chat = useProjectChat({
    api,
    project,
    sessionId,
    sessions,
    onSessionChange,
    onSessionStarted,
    onRefreshSessions,
    onNotify,
    contextForNewSession,
    intake: false,
  })

  return (
    <ChatView
      project={project}
      projectsMode="api"
      conversationKey={chat.conversationKey}
      messages={chat.messages}
      messagesStatus={chat.messagesStatus}
      messagesError={chat.messagesError}
      turn={chat.turn}
      telemetry={chat.telemetry}
      telemetryStale={chat.telemetryStale}
      streaming={chat.streaming}
      health={health}
      onSend={(text) => void chat.sendMessage(text)}
      onStop={chat.stopStreaming}
      onRetryLoad={chat.retryLoad}
      onNewChat={chat.startNewChat}
      onRefreshHealth={onRefreshHealth}
      onOpenSettings={onOpenSettings}
      onCreateProject={() => undefined}
      newChatBlocked={chat.archived && sessionId === null}
      onCopy={(message) => onNotify(message, 'success')}
      compactEmpty={{
        title: `Ask about ${stageLabel}`,
        hint: 'This chat knows the stage, its latest run, checklist and documents.',
        prompts: [
          'Summarize where this stage stands.',
          'What is still blocking the next step?',
          'Explain the latest document in plain language.',
        ],
      }}
    />
  )
}
