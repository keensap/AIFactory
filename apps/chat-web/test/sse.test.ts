import { describe, expect, it } from 'vitest'
import { SseParser } from '../src/api/sse.ts'

describe('SseParser', () => {
  it('parses a frame split across chunks', () => {
    const parser = new SseParser()
    expect(parser.push('event: session\ndata: {"sessionId":"')).toEqual([])
    expect(parser.push('session-1"}\n\n')).toEqual([
      { event: 'session', data: '{"sessionId":"session-1"}' },
    ])
  })

  it('handles CRLF and a CR/LF split across chunks', () => {
    const parser = new SseParser()
    expect(parser.push('event: text\r')).toEqual([])
    expect(parser.push('\ndata: hello\r\n\r\n')).toEqual([
      { event: 'text', data: 'hello' },
    ])
  })

  it('joins multi-line data fields and ignores comments', () => {
    const parser = new SseParser()
    const frames = parser.push(': keepalive\nevent: text\ndata: line one\ndata: line two\n\n')
    expect(frames).toEqual([{ event: 'text', data: 'line one\nline two' }])
  })

  it('ignores frames with no data', () => {
    const parser = new SseParser()
    expect(parser.push('event: ping\n\n')).toEqual([])
  })

  it('parses an id and defaults the event name', () => {
    const parser = new SseParser()
    expect(parser.push('id: 42\ndata: payload\n\n')).toEqual([
      { event: 'message', data: 'payload', id: '42' },
    ])
  })

  it('flushes a trailing frame when the stream closes without a blank line', () => {
    const parser = new SseParser()
    expect(parser.push('event: done\ndata: {"ok":true}')).toEqual([])
    expect(parser.flush()).toEqual([{ event: 'done', data: '{"ok":true}' }])
    expect(parser.flush()).toEqual([])
  })
})
