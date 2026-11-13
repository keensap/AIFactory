import { describe, expect, it } from 'vitest'
import {
  formatDuration,
  formatRelativeTime,
  pluralize,
  truncate,
} from '../src/lib/format.ts'

const now = Date.parse('2026-11-10T12:00:00.000Z')

describe('formatRelativeTime', () => {
  it('formats recent times', () => {
    expect(formatRelativeTime('2026-11-10T11:59:40.000Z', now)).toBe('just now')
    expect(formatRelativeTime('2026-11-10T11:55:00.000Z', now)).toBe('5m ago')
    expect(formatRelativeTime('2026-11-10T09:00:00.000Z', now)).toBe('3h ago')
    expect(formatRelativeTime('2026-11-09T11:00:00.000Z', now)).toBe('yesterday')
    expect(formatRelativeTime('2026-11-07T12:00:00.000Z', now)).toBe('3d ago')
  })

  it('falls back to a date and tolerates invalid input', () => {
    expect(formatRelativeTime('2026-10-01T12:00:00.000Z', now)).toMatch(/Oct/)
    expect(formatRelativeTime('not-a-date', now)).toBe('')
  })
})

describe('formatDuration', () => {
  it('scales units', () => {
    expect(formatDuration(250)).toBe('250 ms')
    expect(formatDuration(2400)).toBe('2.4 s')
    expect(formatDuration(120_000)).toBe('2 min')
  })
})

describe('text helpers', () => {
  it('truncates and collapses whitespace', () => {
    expect(truncate('  hello   world  ', 20)).toBe('hello world')
    expect(truncate('abcdefghij', 6)).toBe('abcde…')
  })

  it('pluralizes', () => {
    expect(pluralize(1, 'chat')).toBe('1 chat')
    expect(pluralize(2, 'chat')).toBe('2 chats')
    expect(pluralize(2, 'entry', 'entries')).toBe('2 entries')
  })
})
