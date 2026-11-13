import { useState } from 'react'
import type { UiMessage, TurnState } from '../data/chat.ts'
import { copyText } from '../lib/clipboard.ts'
import { formatClockTime } from '../lib/format.ts'
import {
  AlertIcon,
  BrandMark,
  CheckIcon,
  CopyIcon,
  SparklesIcon,
} from './Icons.tsx'
import { Markdown } from './Markdown.tsx'

export interface MessageListProps {
  messages: UiMessage[]
  turn: TurnState
  onCopy: (message: string) => void
}

export function MessageList({ messages, turn, onCopy }: MessageListProps) {
  return (
    <div className="transcript" role="log" aria-relevant="additions text">
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} turn={turn} onCopy={onCopy} />
      ))}
      <div className="transcript-tail" aria-hidden="true" />
    </div>
  )
}

function MessageRow({
  message,
  turn,
  onCopy,
}: {
  message: UiMessage
  turn: TurnState
  onCopy: (message: string) => void
}) {
  const [copied, setCopied] = useState(false)

  if (message.role === 'user') {
    return (
      <article className="message message-user">
        <div className="user-bubble">{message.content}</div>
        <div className="user-meta">
          <span>{formatClockTime(message.at)}</span>
          <CopyButton
            text={message.content}
            copied={copied}
            onCopied={() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1600)
              onCopy('Message copied')
            }}
            label="Copy message"
          />
        </div>
      </article>
    )
  }

  const isActive = message.streaming === true && turn.status !== 'idle'
  return (
    <article className="message message-assistant" data-streaming={isActive || undefined}>
      <div className="assistant-avatar" aria-hidden="true">
        <BrandMark size={28} />
      </div>
      <div className="assistant-body">
        <header className="assistant-head">
          <span className="assistant-name">AI Factory</span>
          <span className="assistant-sep" aria-hidden="true">·</span>
          <span className="assistant-time">{formatClockTime(message.at)}</span>
          {message.stopped === true && <span className="stopped-chip">Stopped</span>}
        </header>

        {message.content !== '' && (
          <Markdown onCopy={onCopy}>{message.content}</Markdown>
        )}

        {message.error !== undefined && (
          <div className="message-error" role="alert">
            <AlertIcon size={17} />
            <div>
              <strong>Couldn’t complete that response</strong>
              <p>{message.error}</p>
            </div>
          </div>
        )}

        {isActive && (
          <StreamingIndicator
            turn={turn}
            hasContent={message.content !== ''}
          />
        )}

        {message.content !== '' && !isActive && (
          <div className="assistant-actions">
            <CopyButton
              text={message.content}
              copied={copied}
              onCopied={() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1600)
                onCopy('Response copied')
              }}
              label="Copy response"
            />
          </div>
        )}
      </div>
    </article>
  )
}

function StreamingIndicator({ turn, hasContent }: { turn: TurnState; hasContent: boolean }) {
  if (turn.tools.length > 0) {
    return (
      <div className="stream-activity" aria-live="polite">
        {turn.tools.map((tool, index) => (
          <span
            key={`${tool.name}-${index}`}
            className="tool-chip"
            data-status={tool.status}
            title={tool.error}
          >
            {tool.status === 'running'
              ? <span className="tiny-spinner" />
              : tool.status === 'done' ? <CheckIcon size={12} /> : <AlertIcon size={12} />}
            {tool.name}
          </span>
        ))}
        <span className="stream-label">
          <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
          {turn.label}
        </span>
      </div>
    )
  }

  return (
    <div className={`stream-status${hasContent ? ' stream-status-inline' : ''}`} aria-live="polite">
      <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
      <span>{turn.status === 'stopping' ? 'Stopping…' : turn.label}</span>
      <SparklesIcon size={14} className="stream-spark" />
    </div>
  )
}

function CopyButton({
  text,
  copied,
  onCopied,
  label,
}: {
  text: string
  copied: boolean
  onCopied: () => void
  label: string
}) {
  return (
    <button
      type="button"
      className="message-copy"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (ok) onCopied()
        })
      }}
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}
