/**
 * PDF text extraction for requirement reviews.
 *
 * `unpdf` wraps a serverless build of PDF.js, so this works without native
 * dependencies or a running browser. Scanned PDFs produce little or no text;
 * the caller reports that rather than silently analyzing an empty document.
 */

import { extractText, getDocumentProxy } from 'unpdf'

export const MAX_PDF_BYTES = 20 * 1024 * 1024
export const MAX_PDF_PAGES = 300
export const MAX_PDF_TEXT_CHARS = 120_000

export class PdfError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'PdfError'
    this.status = status
    this.code = code
  }
}

export interface ExtractedPdf {
  text: string
  pages: number
  characters: number
  truncated: boolean
}

export interface ExtractPdfOptions {
  maxPages?: number
  maxChars?: number
}

export async function extractPdfText(
  buffer: Uint8Array,
  options: ExtractPdfOptions = {},
): Promise<ExtractedPdf> {
  const maxPages = options.maxPages ?? MAX_PDF_PAGES
  const maxChars = options.maxChars ?? MAX_PDF_TEXT_CHARS

  let pdf
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer))
  } catch (error) {
    throw new PdfError(400, 'INVALID_PDF', describe(error, 'the file is not a readable PDF'))
  }

  if (pdf.numPages > maxPages) {
    throw new PdfError(413, 'PDF_TOO_MANY_PAGES', `the PDF has ${pdf.numPages} pages; the limit is ${maxPages}`)
  }

  let pageTexts: string[]
  try {
    const result = await extractText(pdf, { mergePages: false })
    pageTexts = Array.isArray(result.text) ? result.text : [result.text]
  } catch (error) {
    throw new PdfError(400, 'INVALID_PDF', describe(error, 'the PDF text could not be extracted'))
  }

  const pages: string[] = []
  for (let index = 0; index < pageTexts.length; index++) {
    const text = pageTexts[index]!.replace(/\r\n/g, '\n').trim()
    if (text !== '') pages.push(`--- Page ${index + 1} ---\n${text}`)
  }

  const fullText = pages.join('\n\n')
  if (fullText.trim() === '') {
    throw new PdfError(
      422,
      'PDF_HAS_NO_TEXT',
      'the PDF contains no extractable text; scanned documents need OCR before review',
    )
  }

  const truncated = fullText.length > maxChars
  return {
    text: truncated
      ? `${fullText.slice(0, maxChars)}\n\n[Document truncated at ${maxChars} characters.]`
      : fullText,
    pages: pdf.numPages,
    characters: fullText.length,
    truncated,
  }
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? `${fallback}: ${error.message}` : fallback
}
