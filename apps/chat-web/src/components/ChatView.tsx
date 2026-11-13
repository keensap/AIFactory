import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ApiHealthState } from '../hooks/useApiHealth.ts'
import type { ProjectsMode } from '../hooks/useProjects.ts'
import type { Project } from '../data/projects.ts'
import type { TurnState, UiMessage } from '../data/chat.ts'
import { useAutoScroll } from '../hooks/useAutoScroll.ts'
import { AlertIcon, ArrowDownIcon, RefreshIcon, WifiOffIcon } from './Icons.tsx'
import { Composer } from './Composer.tsx'
import { EmptyState } from './EmptyState.tsx'
import { MessageList } from './MessageList.tsx'

export type MessagesStatus = 'loading' | 'ready' | 'error'

export interface ChatViewProps {
  project: Project
  projectsMode: ProjectsMode
  conversationKey: string
  messages: UiMessage[]
  messagesStatus: MessagesStatus
  messagesError: string | undefined
  turn: TurnState
  streaming: boolean
  health: ApiHealthState
  onSend: (message: string) => void
  onStop: () => void
  onRetryLoad: () => void
  onNewChat: () => void
  onRefreshHealth: () => Promise<void>
  onOpenSettings: () => void
  onCreateProject: () => void
  /** True when the project is archived and no existing chat is open. */
  newChatBlocked?: boolean
  /** Replaces the empty state (and the composer) while the chat is empty. */
  intake?: ReactNode
  onCopy: (message: string) => void
}

export function ChatView({
  project,
  projectsMode,
  conversationKey,
  messages,
  messagesStatus,
  messagesError,
  turn,
  streaming,
  health,
  onSend,
  onStop,
  onRetryLoad,
  onNewChat,
  onRefreshHealth,
  onOpenSettings,
  onCreateProject,
  newChatBlocked = false,
  intake,
  onCopy,
}: ChatViewProps) {
  const [draft, setDraft] = useState('')
  const [focusToken, setFocusToken] = useState(0)
  const scroller = useAutoScroll([
    conversationKey,
    messages,
    messagesStatus,
    turn.status,
    turn.tools.length,
  ])

  useEffect(() => {
    setDraft('')
    setFocusToken((token) => token + 1)
    scroller.scrollToBottom('auto')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationKey])

  useEffect(() => {
    if (messagesStatus === 'ready' && messages.length > 0) {
      scroller.scrollToBottom('auto')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesStatus])

  const empty = messagesStatus === 'ready' && messages.length === 0 && !streaming
  const showConnectionBanner = (health.status === 'offline' || health.status === 'unauthorized')
    && !empty

  const submit = (): void => {
    const text = draft.trim()
    if (text === '' || streaming || messagesStatus === 'loading' || newChatBlocked) return
    setDraft('')
    onSend(text)
    setFocusToken((token) => token + 1)
  }

  const useSuggestion = (prompt: string): void => {
    setDraft(prompt)
    setFocusToken((token) => token + 1)
  }

  return (
    <section className="chat-view" data-empty={empty || undefined}>
      {showConnectionBanner && (
        <div className="connection-banner" data-status={health.status}>
          <WifiOffIcon size={17} />
          <div className="connection-copy">
            <strong>
              {health.status === 'unauthorized' ? 'The API requires a token' : 'The Chat API is offline'}
            </strong>
            <span>{health.error ?? 'Check the connection settings and try again.'}</span>
          </div>
          <div className="connection-actions">
            {health.status === 'offline' && (
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => void onRefreshHealth()}
              >
                <RefreshIcon size={14} /> Retry
              </button>
            )}
            <button type="button" className="button button-secondary button-sm" onClick={onOpenSettings}>
              Settings
            </button>
          </div>
        </div>
      )}

      <div className="transcript-scroll" ref={scroller.ref}>
        {messagesStatus === 'loading' && <TranscriptSkeleton />}

        {messagesStatus === 'error' && (
          <ChatState
            tone="error"
            title="Couldn’t load this chat"
            message={messagesError ?? 'The API did not return the conversation.'}
            actions={(
              <>
                <button type="button" className="button button-secondary button-sm" onClick={onRetryLoad}>
                  <RefreshIcon size={14} /> Try again
                </button>
                <button type="button" className="button button-ghost button-sm" onClick={onNewChat}>
                  Start a new chat
                </button>
              </>
            )}
          />
        )}

        {empty && intake !== undefined && intake}

        {empty && intake === undefined && (
          <EmptyState
            project={project}
            projectsMode={projectsMode}
            health={health}
            onSuggestion={useSuggestion}
            onOpenSettings={onOpenSettings}
            onRetryHealth={() => void onRefreshHealth()}
            onCreateProject={onCreateProject}
          />
        )}

        {messages.length > 0 && (
          <MessageList messages={messages} turn={turn} onCopy={onCopy} />
        )}
      </div>

      {!scroller.atBottom && messages.length > 0 && (
        <button
          type="button"
          className="jump-latest"
          onClick={() => scroller.scrollToBottom('smooth')}
          aria-label="Jump to latest message"
        >
          <ArrowDownIcon size={15} />
          <span>Latest</span>
        </button>
      )}

      {!(empty && intake !== undefined) && newChatBlocked && (
        <p className="composer-notice" role="status">
          {project.name} is archived. Reactivate it in Project details to start a new chat.
        </p>
      )}
      {!(empty && intake !== undefined) && (
      <Composer
        value={draft}
        onChange={setDraft}
        project={project}
        streaming={streaming}
        disabled={messagesStatus === 'loading' || newChatBlocked}
        focusToken={focusToken}
        onSend={submit}
        onStop={onStop}
      />
      )}
    </section>
  )
}

function TranscriptSkeleton() {
  return (
    <div className="transcript-skeleton" aria-label="Loading chat" aria-busy="true">
      <div className="skeleton-row">
        <span className="skeleton skeleton-avatar" />
        <div className="skeleton-lines">
          <span className="skeleton skeleton-line skeleton-w40" />
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line skeleton-w80" />
        </div>
      </div>
      <div className="skeleton-row skeleton-row-user">
        <span className="skeleton skeleton-bubble" />
      </div>
      <div className="skeleton-row">
        <span className="skeleton skeleton-avatar" />
        <div className="skeleton-lines">
          <span className="skeleton skeleton-line skeleton-w60" />
          <span className="skeleton skeleton-line" />
        </div>
      </div>
    </div>
  )
}

function ChatState({
  tone,
  title,
  message,
  actions,
}: {
  tone: 'error' | 'empty'
  title: string
  message: string
  actions: ReactNode
}) {
  return (
    <div className={`chat-state chat-state-${tone}`} role="alert">
      <span className="chat-state-icon"><AlertIcon size={19} /></span>
      <h2>{title}</h2>
      <p>{message}</p>
      <div className="chat-state-actions">{actions}</div>
    </div>
  )
}
