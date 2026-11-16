/**
 * A deliberately small Markdown parser for generated stage documents.
 *
 * The stage prompts ask the model for plain Markdown with a fixed report shape,
 * so this supports exactly what those documents use: headings, paragraphs,
 * bullet and numbered lists, tables, fenced code, block quotes and rules, with
 * inline bold, italic and code.
 *
 * It is not a general Markdown implementation and does not try to be: anything
 * outside that subset is treated as paragraph text, which degrades to readable
 * output instead of silently disappearing.
 */

export interface Run {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
}

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: string[] }
  | { type: 'table'; header: string[]; rows: string[][]; align: Array<'left' | 'center' | 'right'> }
  | { type: 'code'; language: string | null; text: string }
  | { type: 'quote'; text: string }
  | { type: 'rule' }

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*\S)\s*$/
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_ROW = /^\s{0,3}\|(.+)\|\s*$/
const TABLE_SEPARATOR = /^\s{0,3}\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** Split a table row into trimmed cells. */
export function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  let escaped = false
  let inCode = false
  for (const char of trimmed) {
    if (escaped) {
      current += char
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === '`') {
      // A pipe inside an inline code span is content, not a column separator.
      inCode = !inCode
      current += char
    } else if (char === '|' && !inCode) {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

function alignmentOf(separator: string): Array<'left' | 'center' | 'right'> {
  return splitTableRow(separator).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!

    if (line.trim() === '') {
      index += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[1]!
      const language = fence[2] === '' ? null : fence[2]!
      index += 1
      const body: string[] = []
      while (index < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[index]!)) {
        body.push(lines[index]!)
        index += 1
      }
      index += 1 // closing fence (or end of input)
      blocks.push({ type: 'code', language, text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = Math.min(4, Math.max(1, heading[1]!.length)) as 1 | 2 | 3 | 4
      blocks.push({ type: 'heading', level, text: heading[2]!.trim() })
      index += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    // A table needs a header row followed by a separator row.
    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]!)) {
      const header = splitTableRow(line)
      const align = alignmentOf(lines[index + 1]!)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && TABLE_ROW.test(lines[index]!)) {
        rows.push(splitTableRow(lines[index]!))
        index += 1
      }
      blocks.push({ type: 'table', header, rows, align })
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (index < lines.length) {
        const quote = QUOTE.exec(lines[index]!)
        if (quote === null) break
        body.push(quote[1]!)
        index += 1
      }
      blocks.push({ type: 'quote', text: body.join('\n').trim() })
      continue
    }

    const bullet = BULLET.exec(line)
    if (bullet !== null) {
      const items: string[] = []
      while (index < lines.length) {
        const match = BULLET.exec(lines[index]!)
        if (match !== null) {
          items.push(match[1]!.trim())
          index += 1
          continue
        }
        // A continuation line (indented, not a new bullet) belongs to the item.
        if (items.length > 0 && /^\s{2,}\S/.test(lines[index]!) && !BULLET.test(lines[index]!)) {
          items[items.length - 1] = `${items[items.length - 1]} ${lines[index]!.trim()}`
          index += 1
          continue
        }
        break
      }
      blocks.push({ type: 'list', ordered: false, start: 1, items })
      continue
    }

    const numbered = NUMBERED.exec(line)
    if (numbered !== null) {
      const start = Number.parseInt(numbered[1]!, 10)
      const items: string[] = []
      while (index < lines.length) {
        const match = NUMBERED.exec(lines[index]!)
        if (match !== null) {
          items.push(match[2]!.trim())
          index += 1
          continue
        }
        if (items.length > 0 && /^\s{2,}\S/.test(lines[index]!) && !NUMBERED.test(lines[index]!)) {
          items[items.length - 1] = `${items[items.length - 1]} ${lines[index]!.trim()}`
          index += 1
          continue
        }
        break
      }
      blocks.push({ type: 'list', ordered: true, start: Number.isFinite(start) ? start : 1, items })
      continue
    }

    // Paragraph: consecutive non-blank, non-structural lines.
    const paragraph: string[] = [line.trim()]
    index += 1
    while (index < lines.length) {
      const next = lines[index]!
      if (next.trim() === '' || HEADING.test(next) || FENCE.test(next) || RULE.test(next)
        || BULLET.test(next) || NUMBERED.test(next) || QUOTE.test(next)) {
        break
      }
      paragraph.push(next.trim())
      index += 1
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ').replace(/\s+/g, ' ') })
  }

  return blocks
}

/**
 * Split inline Markdown into styled runs.
 *
 * `**bold**`, `*italic*` / `_italic_` and `` `code` `` are supported. Backslash
 * escapes a marker. Unbalanced markers stay literal text.
 */
export function parseInline(text: string): Run[] {
  const runs: Run[] = []
  let buffer = ''
  let bold = false
  let italic = false

  const flush = (): void => {
    if (buffer === '') return
    const run: Run = { text: buffer }
    if (bold) run.bold = true
    if (italic) run.italic = true
    runs.push(run)
    buffer = ''
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!

    if (char === '\\' && index + 1 < text.length && '\\`*_{}[]()#+-.!|'.includes(text[index + 1]!)) {
      buffer += text[index + 1]!
      index += 1
      continue
    }

    if (char === '`') {
      const end = text.indexOf('`', index + 1)
      if (end > index) {
        flush()
        runs.push({ text: text.slice(index + 1, end), code: true })
        index = end
        continue
      }
    }

    if (text.startsWith('**', index)) {
      flush()
      bold = !bold
      index += 1
      continue
    }

    if (char === '*' || char === '_') {
      const next = text[index + 1]
      // Close an open span unconditionally; open one only when it is followed by
      // content, so "2 * 3" and a trailing marker stay literal.
      if (italic || (next !== undefined && next !== ' ' && next !== char)) {
        flush()
        italic = !italic
        continue
      }
    }

    buffer += char
  }
  flush()

  if (runs.length === 0) return [{ text: '' }]
  return runs
}

/** Plain text of a Markdown string, for widths and filenames. */
export function plainText(markdown: string): string {
  return parseInline(markdown.replace(/[*_`]/g, '')).map((run) => run.text).join('')
}
