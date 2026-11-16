/**
 * Markdown → PDF report renderer built on `pdf-lib`.
 *
 * Pure JavaScript on purpose: no browser, no LibreOffice, no Python. That keeps
 * generation deterministic and available wherever the API runs, which matters
 * because the final stage document is a deliverable, not a best-effort extra.
 *
 * Layout is A4 with a title page, running header/footer with page numbers, and
 * typography for the report subset: headings, paragraphs, lists, tables, fenced
 * code and quotes. Text is left-aligned (ragged right), which wraps correctly
 * with the standard fonts available without embedding font files.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { parseInline, parseMarkdown, type Block, type Run } from './markdown.ts'

export class ReportPdfError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ReportPdfError'
    this.code = code
  }
}

export interface ReportPdfInput {
  /** Document title, without the project name. */
  title: string
  projectName: string
  /** Human label of the stage, e.g. "Planning & Feasibility". */
  stageLabel: string
  /** ISO timestamp shown on the title page. */
  generatedAt: string
  markdown: string
  /** Optional note printed under the title (e.g. "Awaiting human decision"). */
  statusNote?: string
}

// A4 in PostScript points.
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN_LEFT = 56
const MARGIN_RIGHT = 56
const MARGIN_TOP = 64
const MARGIN_BOTTOM = 60
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT

const BODY_SIZE = 10
const BODY_LINE = 14.5
const CODE_SIZE = 8.5
const CODE_LINE = 11.5
const TABLE_SIZE = 8.8
const TABLE_LINE = 11.5

const INK = rgb(0.12, 0.13, 0.16)
const MUTED = rgb(0.42, 0.45, 0.5)
const ACCENT = rgb(0.11, 0.29, 0.5)
const RULE = rgb(0.78, 0.8, 0.84)
const TABLE_HEAD = rgb(0.93, 0.95, 0.97)
const CODE_BG = rgb(0.96, 0.97, 0.98)

interface Fonts {
  regular: PDFFont
  bold: PDFFont
  italic: PDFFont
  boldItalic: PDFFont
  mono: PDFFont
}

/**
 * Characters the standard WinAnsi fonts can encode. Anything else would throw at
 * draw time, so it is mapped or replaced up front instead of failing the export.
 */
const WIN_ANSI_EXTRA = new Set<number>([
  0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc,
  0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e,
  0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
])

const CHAR_MAP: Record<string, string> = {
  '✓': 'x', '✔': 'x', '✗': 'x', '✘': 'x',
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '≥': '>=', '≤': '<=', '≈': '~', '≠': '!=',
  '×': 'x', '÷': '/', '−': '-', '☐': '[ ]', '☑': '[x]', '★': '*', '☆': '*',
  '│': '|', '─': '-', '━': '-', '•': '*',
}

/** Make a string safe for the standard PDF fonts. */
export function sanitizeForPdf(text: string): string {
  let out = ''
  for (const char of text.replace(/\r\n?/g, '\n')) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\n' || char === '\t') {
      out += char === '\t' ? '  ' : '\n'
      continue
    }
    if (code === 0x20 || (code >= 0x21 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(code)) {
      out += char
      continue
    }
    // Control characters are dropped; known look-alikes are mapped; the rest
    // become '?' so nothing silently disappears from the document.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue
    out += CHAR_MAP[char] ?? '?'
  }
  return out
}

interface Word {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
  width: number
}

interface Line {
  words: Word[]
  width: number
}

class ReportLayout {
  private readonly doc: PDFDocument
  private readonly fonts: Fonts
  private readonly input: ReportPdfInput
  private page!: PDFPage
  private y = 0
  private pageIndex = 0
  /** Pages that get the running header (all but the title page). */
  private readonly bodyPages: PDFPage[] = []

  constructor(doc: PDFDocument, fonts: Fonts, input: ReportPdfInput) {
    this.doc = doc
    this.fonts = fonts
    this.input = input
  }

  private fontFor(word: { bold?: boolean; italic?: boolean; code?: boolean }, size = BODY_SIZE): PDFFont {
    if (word.code) return this.fonts.mono
    if (word.bold && word.italic) return this.fonts.boldItalic
    if (word.bold) return this.fonts.bold
    if (word.italic) return this.fonts.italic
    return this.fonts.regular
  }

  private newPage(withHeader = true): void {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    this.pageIndex += 1
    this.y = PAGE_HEIGHT - MARGIN_TOP
    if (withHeader) {
      this.bodyPages.push(this.page)
      this.drawRunningHeader()
    }
  }

  private drawRunningHeader(): void {
    const title = sanitizeForPdf(this.input.title)
    const size = 8
    const width = this.fonts.regular.widthOfTextAtSize(title, size)
    this.page.drawText(title, {
      x: PAGE_WIDTH - MARGIN_RIGHT - Math.min(width, CONTENT_WIDTH * 0.6),
      y: PAGE_HEIGHT - 34,
      size,
      font: this.fonts.regular,
      color: MUTED,
    })
    this.page.drawLine({
      start: { x: MARGIN_LEFT, y: PAGE_HEIGHT - 42 },
      end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: PAGE_HEIGHT - 42 },
      thickness: 0.5,
      color: RULE,
    })
  }

  /** Draw footers once the page count is known. */
  finish(): void {
    const pages = this.doc.getPages()
    pages.forEach((page, index) => {
      const left = sanitizeForPdf(`${this.input.projectName} · ${this.input.stageLabel}`)
      page.drawText(left, { x: MARGIN_LEFT, y: 32, size: 8, font: this.fonts.regular, color: MUTED })
      const label = `Page ${index + 1} of ${pages.length}`
      const width = this.fonts.regular.widthOfTextAtSize(label, 8)
      page.drawText(label, { x: PAGE_WIDTH - MARGIN_RIGHT - width, y: 32, size: 8, font: this.fonts.regular, color: MUTED })
      page.drawLine({
        start: { x: MARGIN_LEFT, y: 44 },
        end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: 44 },
        thickness: 0.5,
        color: RULE,
      })
    })
  }

  private ensure(space: number): void {
    if (this.y - space >= MARGIN_BOTTOM) return
    this.newPage()
  }

  private toWords(runs: Run[], size: number): Word[] {
    const words: Word[] = []
    for (const run of runs) {
      const text = sanitizeForPdf(run.text)
      const parts = text.split(/(\s+)/)
      for (const part of parts) {
        if (part === '') continue
        if (/^\s+$/.test(part)) continue
        const font = this.fontFor(run, size)
        words.push({
          text: part,
          bold: run.bold === true,
          italic: run.italic === true,
          code: run.code === true,
          width: font.widthOfTextAtSize(part, size),
        })
      }
    }
    return words
  }

  private wrap(runs: Run[], size: number, maxWidth: number): Line[] {
    const words = this.toWords(runs, size)
    const lines: Line[] = []
    let current: Line = { words: [], width: 0 }
    const spaceWidth = this.fonts.regular.widthOfTextAtSize(' ', size)

    for (const word of words) {
      // A single word wider than the line is broken by characters.
      if (word.width > maxWidth) {
        if (current.words.length > 0) {
          lines.push(current)
          current = { words: [], width: 0 }
        }
        const font = this.fontFor(word, size)
        let chunk = ''
        for (const char of word.text) {
          const next = chunk + char
          if (font.widthOfTextAtSize(next, size) > maxWidth && chunk !== '') {
            lines.push({ words: [{ ...word, text: chunk, width: font.widthOfTextAtSize(chunk, size) }], width: font.widthOfTextAtSize(chunk, size) })
            chunk = char
          } else {
            chunk = next
          }
        }
        if (chunk !== '') {
          current = { words: [{ ...word, text: chunk, width: font.widthOfTextAtSize(chunk, size) }], width: font.widthOfTextAtSize(chunk, size) }
        }
        continue
      }

      const extra = current.words.length === 0 ? word.width : spaceWidth + word.width
      if (current.width + extra > maxWidth && current.words.length > 0) {
        lines.push(current)
        current = { words: [word], width: word.width }
      } else {
        current.words.push(word)
        current.width += extra
      }
    }
    if (current.words.length > 0) lines.push(current)
    return lines
  }

  /**
   * Draw a line word by word, but coalesce neighbouring words that share a style
   * into one string. Drawing real space characters (rather than only advancing
   * the cursor) keeps text extraction and screen readers correct.
   */
  private drawWordLine(words: Word[], x: number, baselineY: number, size: number, color = INK): number {
    const space = ' '
    const spaceWidth = this.fonts.regular.widthOfTextAtSize(space, size)
    let cursor = x
    let index = 0
    while (index < words.length) {
      const style = words[index]!
      const group: Word[] = []
      while (index < words.length) {
        const candidate = words[index]!
        if (candidate.bold !== style.bold || candidate.italic !== style.italic || candidate.code !== style.code) break
        group.push(candidate)
        index += 1
      }
      const text = group.map((word) => word.text).join(space)
      this.page.drawText(text, {
        x: cursor,
        y: baselineY,
        size,
        font: this.fontFor(style, size),
        color: style.code ? rgb(0.2, 0.24, 0.3) : color,
      })
      const width = this.fonts.regular.widthOfTextAtSize('', size)
      cursor += group.reduce((sum, word) => sum + word.width, 0) + spaceWidth * (group.length - 1) + width
      if (index < words.length) cursor += spaceWidth
    }
    return cursor - x
  }

  private drawLines(lines: Line[], size: number, lineHeight: number, x: number, color = INK): void {
    for (const line of lines) {
      this.ensure(lineHeight)
      this.drawWordLine(line.words, x, this.y - size, size, color)
      this.y -= lineHeight
    }
  }

  // ---- title page -------------------------------------------------------

  titlePage(): void {
    this.newPage(false)
    const top = PAGE_HEIGHT - 150
    this.page.drawText(sanitizeForPdf(this.input.projectName.toUpperCase()), {
      x: MARGIN_LEFT, y: top + 40, size: 10, font: this.fonts.bold, color: ACCENT,
    })
    this.page.drawLine({
      start: { x: MARGIN_LEFT, y: top + 30 }, end: { x: MARGIN_LEFT + 120, y: top + 30 }, thickness: 2, color: ACCENT,
    })

    const titleLines = this.wrap(parseInline(this.input.title), 26, CONTENT_WIDTH)
    let y = top - 40
    for (const line of titleLines) {
      this.drawWordLine(line.words, MARGIN_LEFT, y, 26, INK)
      y -= 34
    }

    const subtitle = `${this.input.stageLabel} · Stage document`
    this.page.drawText(sanitizeForPdf(subtitle), { x: MARGIN_LEFT, y: y - 6, size: 12, font: this.fonts.regular, color: MUTED })

    if (this.input.statusNote !== undefined && this.input.statusNote !== '') {
      this.page.drawText(sanitizeForPdf(this.input.statusNote), {
        x: MARGIN_LEFT, y: y - 30, size: 10, font: this.fonts.italic, color: MUTED,
      })
    }

    const date = new Date(this.input.generatedAt)
    const stamp = Number.isNaN(date.getTime()) ? this.input.generatedAt : date.toISOString().slice(0, 16).replace('T', ' ')
    this.page.drawLine({
      start: { x: MARGIN_LEFT, y: 150 }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: 150 }, thickness: 0.5, color: RULE,
    })
    this.page.drawText(sanitizeForPdf(`Generated by AI Factory · ${stamp} UTC`), {
      x: MARGIN_LEFT, y: 132, size: 9, font: this.fonts.regular, color: MUTED,
    })

    this.newPage()
  }

  // ---- blocks -----------------------------------------------------------

  heading(level: 1 | 2 | 3 | 4, text: string): void {
    const size = level === 1 ? 18 : level === 2 ? 14 : level === 3 ? 11.5 : 10.5
    const before = level === 1 ? 18 : level === 2 ? 16 : 12
    const after = level === 2 ? 6 : 4
    // Keep a heading with at least a few lines of what follows it.
    if (this.y - (before + size + after + BODY_LINE * 3) < MARGIN_BOTTOM) this.newPage()
    this.y -= before
    const runs = parseInline(text).map((run) => ({ ...run, bold: true }))
    this.drawLines(this.wrap(runs, size, CONTENT_WIDTH), size, size * 1.25, MARGIN_LEFT, level <= 2 ? ACCENT : INK)
    this.y -= after
    if (level <= 2) {
      this.page.drawLine({
        start: { x: MARGIN_LEFT, y: this.y + 2 }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: this.y + 2 }, thickness: 0.5, color: RULE,
      })
      this.y -= 4
    }
  }

  paragraph(text: string, options: { italic?: boolean } = {}): void {
    const runs = parseInline(text).map((run) => (options.italic === true ? { ...run, italic: true } : run))
    this.drawLines(this.wrap(runs, BODY_SIZE, CONTENT_WIDTH), BODY_SIZE, BODY_LINE, MARGIN_LEFT)
    this.y -= 6
  }

  list(ordered: boolean, start: number, items: string[]): void {
    const indent = 18
    items.forEach((item, index) => {
      const marker = ordered ? `${start + index}.` : '•'
      const markerWidth = this.fonts.regular.widthOfTextAtSize(`${marker} `, BODY_SIZE)
      const markerSpace = Math.max(indent, markerWidth + 4)
      this.ensure(BODY_LINE)
      this.page.drawText(marker, { x: MARGIN_LEFT, y: this.y - BODY_SIZE, size: BODY_SIZE, font: this.fonts.regular, color: INK })
      this.drawLines(this.wrap(parseInline(item), BODY_SIZE, CONTENT_WIDTH - markerSpace), BODY_SIZE, BODY_LINE, MARGIN_LEFT + markerSpace)
    })
    this.y -= 4
  }

  quote(text: string): void {
    const lines = this.wrap(parseInline(text).map((run) => ({ ...run, italic: true })), BODY_SIZE, CONTENT_WIDTH - 16)
    const height = lines.length * BODY_LINE + 6
    this.ensure(height)
    const top = this.y
    this.y -= 3
    this.drawLines(lines, BODY_SIZE, BODY_LINE, MARGIN_LEFT + 16, rgb(0.3, 0.33, 0.38))
    this.page.drawLine({
      start: { x: MARGIN_LEFT + 4, y: top }, end: { x: MARGIN_LEFT + 4, y: this.y + 2 }, thickness: 2, color: RULE,
    })
    this.y -= 6
  }

  rule(): void {
    this.ensure(12)
    this.page.drawLine({
      start: { x: MARGIN_LEFT, y: this.y - 4 }, end: { x: PAGE_WIDTH - MARGIN_RIGHT, y: this.y - 4 }, thickness: 0.5, color: RULE,
    })
    this.y -= 12
  }

  code(text: string): void {
    const maxWidth = CONTENT_WIDTH - 16
    const lines: string[] = []
    for (const raw of sanitizeForPdf(text).split('\n')) {
      if (raw === '') {
        lines.push('')
        continue
      }
      let chunk = ''
      for (const char of raw) {
        const next = chunk + char
        if (this.fonts.mono.widthOfTextAtSize(next, CODE_SIZE) > maxWidth && chunk !== '') {
          lines.push(chunk)
          chunk = char
        } else {
          chunk = next
        }
      }
      lines.push(chunk)
    }
    for (const line of lines) {
      this.ensure(CODE_LINE)
      this.page.drawRectangle({
        x: MARGIN_LEFT, y: this.y - CODE_LINE + 3, width: CONTENT_WIDTH, height: CODE_LINE, color: CODE_BG,
      })
      if (line !== '') {
        this.page.drawText(line, { x: MARGIN_LEFT + 8, y: this.y - CODE_SIZE, size: CODE_SIZE, font: this.fonts.mono, color: rgb(0.2, 0.24, 0.3) })
      }
      this.y -= CODE_LINE
    }
    this.y -= 6
  }

  table(header: string[], rows: string[][], align: Array<'left' | 'center' | 'right'>): void {
    const columns = Math.max(header.length, ...rows.map((row) => row.length), 1)
    const cellPadding = 4
    const available = CONTENT_WIDTH
    // Natural widths from unwrapped content, then scale to fit the page.
    const natural: number[] = []
    for (let column = 0; column < columns; column++) {
      let widest = 0
      const cells = [header[column] ?? '', ...rows.map((row) => row[column] ?? '')]
      for (const cell of cells) {
        for (const word of this.toWords(parseInline(cell), TABLE_SIZE)) {
          widest = Math.max(widest, word.width)
        }
      }
      natural.push(Math.min(Math.max(widest + cellPadding * 2, 40), available * 0.6))
    }
    const total = natural.reduce((sum, width) => sum + width, 0)
    const widths = total > available ? natural.map((width) => (width / total) * available) : natural
    const used = widths.reduce((sum, width) => sum + width, 0)
    if (used < available) {
      // Spread the slack proportionally so the table fills the text block.
      const factor = available / used
      for (let index = 0; index < widths.length; index++) widths[index] = widths[index]! * factor
    }

    const drawRow = (cells: string[], isHeader: boolean, shade: boolean): void => {
      const wrapped = widths.map((width, column) => this.wrap(parseInline(cells[column] ?? ''), TABLE_SIZE, width - cellPadding * 2))
      const height = Math.max(...wrapped.map((lines) => lines.length), 1) * TABLE_LINE + cellPadding * 2
      if (this.y - height < MARGIN_BOTTOM) {
        this.newPage()
        if (!isHeader) drawRow(header, true, true)
      }
      let x = MARGIN_LEFT
      if (shade) {
        this.page.drawRectangle({ x, y: this.y - height, width: available, height, color: TABLE_HEAD })
      }
      for (let column = 0; column < columns; column++) {
        const width = widths[column]!
        const lines = wrapped[column]!
        let lineY = this.y - cellPadding - TABLE_SIZE
        for (const line of lines) {
          let cursor = x + cellPadding
          if (align[column] === 'right' || align[column] === 'center') {
            const lineWidth = line.words.reduce((sum, word) => sum + word.width, 0)
              + Math.max(0, line.words.length - 1) * this.fonts.regular.widthOfTextAtSize(' ', TABLE_SIZE)
            cursor = align[column] === 'center'
              ? x + (width - lineWidth) / 2
              : x + width - cellPadding - lineWidth
          }
          const cells = line.words.map((word) => (isHeader ? { ...word, bold: true } : word))
          this.drawWordLine(cells, cursor, lineY, TABLE_SIZE, INK)
          lineY -= TABLE_LINE
        }
        this.page.drawLine({
          start: { x: x + width, y: this.y - height }, end: { x: x + width, y: this.y }, thickness: 0.5, color: RULE,
        })
        x += width
      }
      this.page.drawLine({ start: { x: MARGIN_LEFT, y: this.y - height }, end: { x: MARGIN_LEFT + available, y: this.y - height }, thickness: 0.5, color: RULE })
      this.y -= height
    }

    drawRow(header, true, true)
    for (const row of rows) drawRow(row, false, false)
    this.y -= 8
  }

  render(blocks: Block[]): void {
    for (const block of blocks) {
      switch (block.type) {
        case 'heading': this.heading(block.level, block.text); break
        case 'paragraph': this.paragraph(block.text); break
        case 'list': this.list(block.ordered, block.start, block.items); break
        case 'table': this.table(block.header, block.rows, block.align); break
        case 'code': this.code(block.text); break
        case 'quote': this.quote(block.text); break
        case 'rule': this.rule(); break
      }
    }
  }
}

/** Render a stage document to PDF bytes. */
export async function renderReportPdf(input: ReportPdfInput): Promise<Uint8Array> {
  try {
    const doc = await PDFDocument.create()
    doc.setTitle(sanitizeForPdf(input.title))
    doc.setAuthor('AI Factory')
    doc.setSubject(sanitizeForPdf(`${input.stageLabel} — ${input.projectName}`))
    doc.setProducer('AI Factory')
    doc.setCreator('AI Factory')

    const fonts: Fonts = {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
      italic: await doc.embedFont(StandardFonts.HelveticaOblique),
      boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
      mono: await doc.embedFont(StandardFonts.Courier),
    }

    const layout = new ReportLayout(doc, fonts, input)
    layout.titlePage()
    layout.render(parseMarkdown(input.markdown))
    layout.finish()
    return await doc.save()
  } catch (error) {
    throw new ReportPdfError('PDF_RENDER_FAILED', `could not render the report PDF: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
