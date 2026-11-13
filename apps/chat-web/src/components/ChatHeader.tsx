import { useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '../api/types.ts'
import type { ApiHealthState } from '../hooks/useApiHealth.ts'
import type { Project } from '../data/projects.ts'
import { formatRelativeTime, truncate } from '../lib/format.ts'
import { routeHref } from '../lib/router.ts'
import {
  ChevronDownIcon,
  ClockIcon,
  MessageIcon,
  MoonIcon,
  PanelLeftIcon,
  PlusIcon,
  SunIcon,
  TrashIcon,
  WifiOffIcon,
} from './Icons.tsx'

export interface ChatHeaderProps {
  project: Project
  sessionTitle: string | null
  sessions: SessionSummary[]
  activeSessionId: string | null
  streamingSessionId: string | null
  canStartChat: boolean
  theme: 'light' | 'dark'
  health: ApiHealthState
  onOpenSidebar: () => void
  onNewChat: () => void
  onDeleteSession: (session: SessionSummary) => void
  onOpenSettings: () => void
  onToggleTheme: () => void
}

export function ChatHeader({
  project,
  sessionTitle,
  sessions,
  activeSessionId,
  streamingSessionId,
  canStartChat,
  theme,
  health,
  onOpenSidebar,
  onNewChat,
  onDeleteSession,
  onOpenSettings,
  onToggleTheme,
}: ChatHeaderProps) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const showApiWarning = health.status === 'offline' || health.status === 'unauthorized'

  useEffect(() => {
    if (!historyOpen) return
    const onPointer = (event: PointerEvent): void => {
      if (menuRef.current !== null && event.target instanceof Node && !menuRef.current.contains(event.target)) {
        setHistoryOpen(false)
      }
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setHistoryOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [historyOpen])

  // Close the menu after navigating to another chat.
  useEffect(() => setHistoryOpen(false), [activeSessionId])

  return (
    <header className="topbar">
      <div className="topbar-leading">
        <button
          type="button"
          className="icon-button mobile-menu"
          aria-label="Open project settings"
          onClick={onOpenSidebar}
        >
          <PanelLeftIcon size={18} />
        </button>
        <div className="breadcrumbs">
          <span className="crumb-project">
            <span className="crumb-dot" data-color={project.color} aria-hidden="true" />
            <span>{truncate(project.name, 34)}</span>
          </span>
          <span className="crumb-sep" aria-hidden="true">/</span>
          <span className="crumb-title">{sessionTitle === null ? 'New chat' : truncate(sessionTitle, 52)}</span>
        </div>
      </div>

      <div className="topbar-actions">
        {showApiWarning && (
          <button
            type="button"
            className="api-warning"
            data-status={health.status}
            onClick={onOpenSettings}
            title={health.error ?? 'Check the API connection'}
          >
            <WifiOffIcon size={14} />
            <span>{health.status === 'unauthorized' ? 'Token required' : 'API offline'}</span>
          </button>
        )}

        <div className="history" ref={menuRef}>
          <button
            type="button"
            className="button button-ghost button-sm history-toggle"
            aria-haspopup="true"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <ClockIcon size={14} /> Chats <span className="history-count">{sessions.length}</span>
            <ChevronDownIcon size={13} />
          </button>
          {historyOpen && (
            <div className="history-menu" role="menu" aria-label={`Chats in ${project.name}`}>
              {sessions.length === 0 ? (
                <p className="history-empty">No chats in this project yet.</p>
              ) : (
                <ul>
                  {sessions.map((session) => {
                    const running = streamingSessionId === session.id
                    return (
                      <li key={session.id} className="history-row" data-active={session.id === activeSessionId || undefined}>
                        <a
                          role="menuitem"
                          className="history-item"
                          href={routeHref({ name: 'project', projectId: project.id, sessionId: session.id })}
                          title={session.title}
                        >
                          {running ? <span className="tiny-spinner" /> : <MessageIcon size={14} />}
                          <span className="history-title">{truncate(session.title, 54)}</span>
                          <span className="history-time">{running ? 'working' : formatRelativeTime(session.updatedAt)}</span>
                        </a>
                        <button
                          type="button"
                          className="history-delete"
                          aria-label={`Delete chat “${session.title}”`}
                          title="Delete chat"
                          onClick={() => {
                            setHistoryOpen(false)
                            onDeleteSession(session)
                          }}
                        >
                          <TrashIcon size={13} />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          className="button button-secondary button-sm"
          onClick={onNewChat}
          disabled={!canStartChat}
          title={canStartChat ? 'New chat (⌘⇧O)' : 'Archived projects cannot start new chats'}
        >
          <PlusIcon size={14} /> New chat
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <SunIcon size={17} /> : <MoonIcon size={17} />}
        </button>
      </div>
    </header>
  )
}
