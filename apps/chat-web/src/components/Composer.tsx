import { useEffect, useRef } from 'react'
import type { Project } from '../data/projects.ts'
import {
  PaperclipIcon,
  SendIcon,
  SparklesIcon,
  StopIcon,
} from './Icons.tsx'

export interface ComposerProps {
  value: string
  onChange: (value: string) => void
  project: Project
  streaming: boolean
  disabled: boolean
  focusToken: number
  onSend: () => void
  onStop: () => void
}

const MAX_MESSAGE_BYTES = 64 * 1024
const SHOW_COUNT_AFTER = 55 * 1024

export function Composer({
  value,
  onChange,
  project,
  streaming,
  disabled,
  focusToken,
  onSend,
  onStop,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const element = textareaRef.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`
  }, [value])

  useEffect(() => {
    if (disabled) return
    textareaRef.current?.focus()
  }, [focusToken, disabled])

  const bytes = new TextEncoder().encode(value).length
  const tooLarge = bytes > MAX_MESSAGE_BYTES
  const canSend = value.trim() !== '' && !tooLarge && !streaming && !disabled

  const submit = (): void => {
    if (!canSend) return
    onSend()
  }

  return (
    <div className="composer-wrap">
      <div className="composer" data-streaming={streaming || undefined}>
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={value}
          rows={1}
          placeholder={`Message ${project.name}…`}
          aria-label="Message"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            if (event.nativeEvent.isComposing) return
            event.preventDefault()
            submit()
          }}
        />

        <div className="composer-toolbar">
          <button
            type="button"
            className="composer-tool"
            disabled
            title="Attachments are not supported by the Chat API yet"
            aria-label="Attach a file (not supported yet)"
          >
            <PaperclipIcon size={17} />
          </button>
          <span className="composer-model" title="The API runs DeepSeek Harness in headless mode">
            <SparklesIcon size={14} />
            Harness · headless
          </span>

          <span className="composer-spacer" />

          {tooLarge && (
            <span className="composer-warning" role="alert">
              Message is too large
            </span>
          )}
          {!tooLarge && bytes > SHOW_COUNT_AFTER && (
            <span className="composer-count">
              {Math.ceil((MAX_MESSAGE_BYTES - bytes) / 1024)} KB left
            </span>
          )}

          {streaming ? (
            <button
              type="button"
              className="send-button stop-button"
              onClick={onStop}
              aria-label="Stop response"
              title="Stop response"
            >
              <StopIcon size={17} />
            </button>
          ) : (
            <button
              type="button"
              className="send-button"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send message"
              title="Send message (Enter)"
            >
              <SendIcon size={18} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">
        <span><kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span>
        <span className="composer-hint-project">{project.name}</span>
      </div>
    </div>
  )
}
