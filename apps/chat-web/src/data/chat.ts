/** View-model types shared by the transcript and composer. */

import type { ChatRecord } from '../api/types.ts'
import { stripStageContext } from './stageChat.ts'

export interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  at: string
  streaming?: boolean
  stopped?: boolean
  error?: string
}

export interface ToolActivity {
  name: string
  status: 'running' | 'done' | 'error'
  error?: string
}

export interface TurnState {
  status: 'idle' | 'running' | 'stopping'
  label: string
  startedAt?: number
  tools: ToolActivity[]
}

export const IDLE_TURN: TurnState = {
  status: 'idle',
  label: '',
  tools: [],
}

export function toUiMessages(records: readonly ChatRecord[]): UiMessage[] {
  return records.map((record, index) => ({
    id: `${record.role}-${record.at}-${index}`,
    role: record.role,
    content: record.role === 'user' ? stripStageContext(record.content) : record.content,
    at: record.at,
  }))
}

export function statusLabel(phase: string): string {
  switch (phase) {
    case 'turn_start':
      return 'Thinking'
    case 'step_start':
      return 'Working'
    case 'step_end':
      return 'Working'
    case 'turn_end':
      return 'Finishing'
    default: {
      const words = phase.replace(/[_-]+/g, ' ').trim()
      return words === '' ? 'Working' : words.charAt(0).toUpperCase() + words.slice(1)
    }
  }
}

export function addToolCall(tools: readonly ToolActivity[], name: string | undefined): ToolActivity[] {
  const tool = name === undefined || name === '' ? 'tool' : name
  return [...tools, { name: tool, status: 'running' }]
}

export function completeToolCall(
  tools: readonly ToolActivity[],
  name: string | undefined,
  status: string | undefined,
  error: string | undefined,
): ToolActivity[] {
  const tool = name === undefined || name === '' ? 'tool' : name
  let matched = false
  const next = tools.map((entry) => {
    if (!matched && entry.name === tool && entry.status === 'running') {
      matched = true
      return {
        ...entry,
        status: error !== undefined || status === 'error' ? 'error' as const : 'done' as const,
        ...(error === undefined ? {} : { error }),
      }
    }
    return entry
  })
  if (!matched) {
    next.push({
      name: tool,
      status: error !== undefined || status === 'error' ? 'error' : 'done',
      ...(error === undefined ? {} : { error }),
    })
  }
  return next
}
