import { describe, expect, it } from 'vitest'
import {
  addToolCall,
  completeToolCall,
  statusLabel,
  toUiMessages,
} from '../src/data/chat.ts'

describe('chat view model', () => {
  it('maps stored records to stable UI ids', () => {
    expect(toUiMessages([
      { role: 'user', content: 'hi', at: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: 'hello', at: '2026-01-01T00:00:01.000Z' },
    ])).toEqual([
      {
        id: 'user-2026-01-01T00:00:00.000Z-0',
        role: 'user',
        content: 'hi',
        at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'assistant-2026-01-01T00:00:01.000Z-1',
        role: 'assistant',
        content: 'hello',
        at: '2026-01-01T00:00:01.000Z',
      },
    ])
  })

  it('turns harness phases into human labels', () => {
    expect(statusLabel('turn_start')).toBe('Thinking')
    expect(statusLabel('step_start')).toBe('Working')
    expect(statusLabel('turn_end')).toBe('Finishing')
    expect(statusLabel('waiting_on_approval')).toBe('Waiting on approval')
    expect(statusLabel('')).toBe('Working')
  })

  it('tracks tool lifecycle by name', () => {
    let tools = addToolCall([], 'read_file')
    expect(tools).toEqual([{ name: 'read_file', status: 'running' }])
    tools = completeToolCall(tools, 'read_file', 'ok', undefined)
    expect(tools).toEqual([{ name: 'read_file', status: 'done' }])
    tools = addToolCall(tools, 'write_file')
    tools = completeToolCall(tools, 'write_file', 'error', 'permission denied')
    expect(tools[1]).toEqual({
      name: 'write_file',
      status: 'error',
      error: 'permission denied',
    })
  })

  it('adds a completed entry when no matching running tool exists', () => {
    expect(completeToolCall([], 'shell', 'ok', undefined)).toEqual([
      { name: 'shell', status: 'done' },
    ])
  })
})
