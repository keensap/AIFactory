import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChatApi } from '../../api/client.ts'
import type { SessionSummary } from '../../api/types.ts'
import type { Project } from '../../data/projects.ts'
import { assignedSessionIds, loadStageChats, saveStageChats } from '../../data/stageChat.ts'
import type { ApiHealthState } from '../../hooks/useApiHealth.ts'
import { truncate } from '../../lib/format.ts'
import { newId } from '../../lib/id.ts'
import type { StorageLike } from '../../lib/storage.ts'
import { ChevronDownIcon, ChevronRightIcon, ClockIcon, CloseIcon, MessageIcon, PlusIcon } from '../Icons.tsx'
import { ChatPane } from './EmbeddedChat.tsx'

interface ChatTab {
  /** Local identity; stable while a draft becomes a real session. */
  id: string
  sessionId: string | null
}

export interface StageChatDockProps {
  api: ChatApi
  storage: StorageLike
  project: Project
  stageKey: string
  stageLabel: string
  sessions: SessionSummary[]
  health: ApiHealthState
  /** Builds the stage context for the first message of a new conversation. */
  getContext: () => string | null
  onSessionStarted: (session: SessionSummary, projectId: string) => void
  onRefreshSessions: () => Promise<void>
  onRefreshHealth: () => Promise<void>
  onOpenSettings: () => void
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
}

/**
 * The stage's conversation, docked at the bottom of the main column. The first
 * chat is the default; "+" opens another one in the same stage. Panes stay
 * mounted once opened so a running reply survives collapsing or switching tabs.
 */
export function StageChatDock({
  api,
  storage,
  project,
  stageKey,
  stageLabel,
  sessions,
  health,
  getContext,
  onSessionStarted,
  onRefreshSessions,
  onRefreshHealth,
  onOpenSettings,
  onNotify,
}: StageChatDockProps) {
  const [tabs, setTabs] = useState<ChatTab[]>(() => {
    const saved = loadStageChats(storage, project.id, stageKey).map((sessionId) => ({ id: newId('tab'), sessionId }))
    return saved.length > 0 ? saved : [{ id: newId('tab'), sessionId: null }]
  })
  const [activeId, setActiveId] = useState(() => tabs[0]!.id)
  const [expanded, setExpanded] = useState(false)
  /** Panes mount on first expand and are then kept. */
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set())
  const [earlierOpen, setEarlierOpen] = useState(false)

  const sessionTitle = useCallback((sessionId: string | null): string => {
    if (sessionId === null) return 'New chat'
    return truncate(sessions.find((session) => session.id === sessionId)?.title ?? 'Chat', 28)
  }, [sessions])

  // Remember which conversations belong to this stage.
  useEffect(() => {
    saveStageChats(storage, project.id, stageKey, tabs.flatMap((tab) => (tab.sessionId === null ? [] : [tab.sessionId])))
  }, [project.id, stageKey, storage, tabs])

  const show = useCallback((id: string) => {
    setActiveId(id)
    setExpanded(true)
    setMounted((current) => (current.has(id) ? current : new Set(current).add(id)))
  }, [])

  const addTab = useCallback((sessionId: string | null = null) => {
    const id = newId('tab')
    setTabs((current) => [...current, { id, sessionId }])
    show(id)
  }, [show])

  const closeTab = useCallback((id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id)
    const rest = tabs.filter((tab) => tab.id !== id)
    if (rest.length === 0) {
      const fresh: ChatTab = { id: newId('tab'), sessionId: null }
      setTabs([fresh])
      setActiveId(fresh.id)
      setMounted(new Set([fresh.id]))
      return
    }
    setTabs(rest)
    setMounted((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
    if (id === activeId) setActiveId(rest[Math.max(0, index - 1)]!.id)
  }, [activeId, tabs])

  const setTabSession = useCallback((id: string, sessionId: string | null) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, sessionId } : tab)))
  }, [])

  // Chats of this project that no stage has claimed (project-level chats from before stage chats).
  const earlier = useMemo(() => {
    const assigned = assignedSessionIds(storage, project.id)
    const open = new Set(tabs.flatMap((tab) => (tab.sessionId === null ? [] : [tab.sessionId])))
    return sessions.filter((session) => !assigned.has(session.id) && !open.has(session.id))
    // `tabs` changes whenever assignments change.
  }, [project.id, sessions, storage, tabs])

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]!

  return (
    <section className="chat-dock" data-expanded={expanded || undefined} aria-label={`${stageLabel} chat`}>
      <div className="chat-dock-bar">
        <button
          type="button"
          className="chat-dock-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse chat' : 'Expand chat'}
          onClick={() => (expanded ? setExpanded(false) : show(active.id))}
        >
          {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          <MessageIcon size={14} />
        </button>

        <div className="chat-tabs" role="tablist" aria-label={`${stageLabel} conversations`}>
          {tabs.map((tab) => (
            <span key={tab.id} className="chat-tab" data-active={(expanded && tab.id === active.id) || undefined}>
              <button
                type="button"
                role="tab"
                aria-selected={expanded && tab.id === active.id}
                className="chat-tab-label"
                data-icon-only={!expanded || undefined}
                aria-label={sessionTitle(tab.sessionId)}
                title={sessionTitle(tab.sessionId)}
                onClick={() => show(tab.id)}
              >
                {expanded ? sessionTitle(tab.sessionId) : <MessageIcon size={14} />}
              </button>
              {(tabs.length > 1 || tab.sessionId !== null) && (
                <button type="button" className="chat-tab-close" aria-label={`Close ${sessionTitle(tab.sessionId)}`} onClick={() => closeTab(tab.id)}>
                  <CloseIcon size={12} />
                </button>
              )}
            </span>
          ))}
        </div>

        <button type="button" className="icon-button chat-dock-add" aria-label="New chat in this stage" title="New chat in this stage" onClick={() => addTab()}>
          <PlusIcon size={15} />
        </button>

        {earlier.length > 0 && (
          <div className="chat-earlier">
            {expanded ? (
              <button type="button" className="text-button" aria-expanded={earlierOpen} onClick={() => setEarlierOpen((value) => !value)}>
                Earlier project chats ({earlier.length})
              </button>
            ) : (
              <button
                type="button"
                className="icon-button"
                aria-expanded={earlierOpen}
                aria-label={`Earlier project chats (${earlier.length})`}
                title={`Earlier project chats (${earlier.length})`}
                onClick={() => setEarlierOpen((value) => !value)}
              >
                <ClockIcon size={15} />
              </button>
            )}
            {earlierOpen && (
              <ul className="chat-earlier-menu">
                {earlier.map((session) => (
                  <li key={session.id}>
                    <button type="button" onClick={() => { setEarlierOpen(false); addTab(session.id) }}>
                      {truncate(session.title, 48)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {!expanded && (
          <button type="button" className="chat-dock-prompt" aria-label={`Ask about ${stageLabel}`} title={`Ask about ${stageLabel}`} onClick={() => show(active.id)} />
        )}
      </div>

      <div className="chat-dock-body" hidden={!expanded}>
        {tabs.filter((tab) => mounted.has(tab.id)).map((tab) => (
          <div key={tab.id} className="chat-dock-pane" hidden={tab.id !== active.id}>
            <ChatPane
              api={api}
              project={project}
              sessionId={tab.sessionId}
              onSessionChange={(sessionId) => setTabSession(tab.id, sessionId)}
              sessions={sessions}
              health={health}
              stageLabel={stageLabel}
              contextForNewSession={getContext}
              onSessionStarted={onSessionStarted}
              onRefreshSessions={onRefreshSessions}
              onRefreshHealth={onRefreshHealth}
              onOpenSettings={onOpenSettings}
              onNotify={onNotify}
            />
          </div>
        ))}
      </div>
    </section>
  )
}
