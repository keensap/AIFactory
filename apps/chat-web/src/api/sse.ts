/**
 * Minimal Server-Sent Events parser for `fetch` streaming.
 *
 * `EventSource` cannot POST, so the client reads `response.body` and feeds
 * decoded text here. The parser is deliberately dependency-free and tolerant
 * of chunk boundaries, CRLF, comments and multi-line `data:` fields.
 */

export interface SseFrame {
  event: string
  data: string
  id?: string
}

export class SseParser {
  private buffer = ''

  push(chunk: string): SseFrame[] {
    this.buffer += chunk
    const frames: SseFrame[] = []
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer)
      if (match === null) break
      const raw = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      const frame = parseFrame(raw)
      if (frame !== null) frames.push(frame)
    }
    return frames
  }

  /** Parse a trailing frame when the server closes without a blank line. */
  flush(): SseFrame[] {
    const raw = this.buffer
    this.buffer = ''
    if (raw.trim() === '') return []
    const frame = parseFrame(raw)
    return frame === null ? [] : [frame]
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = 'message'
  let id: string | undefined
  const data: string[] = []

  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'event':
        if (value !== '') event = value
        break
      case 'data':
        data.push(value)
        break
      case 'id':
        id = value
        break
      default:
        break
    }
  }

  if (data.length === 0) return null
  return {
    event,
    data: data.join('\n'),
    ...(id === undefined ? {} : { id }),
  }
}
