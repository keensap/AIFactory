/**
 * Stage input attachments: PDFs the requester supplies alongside the brief.
 *
 * Text is extracted once at upload time and cached next to the file, so a stage
 * run never pays extraction cost and a re-run sees exactly the same input as the
 * first attempt.
 *
 * Only PDFs are accepted. Images are rejected explicitly rather than stored and
 * ignored: the harness consumes text only, so accepting an image would imply an
 * influence on the analysis that does not exist.
 */

import type { ProjectStage } from './sdlc.ts'

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_UPLOAD = 10
export const MAX_ATTACHMENTS_PER_RUN = 20
/** Extracted text kept per document (also the per-prompt allowance). */
export const PROMPT_CHARS_PER_ATTACHMENT = 20_000
/** Total extracted text put into one prompt. */
export const PROMPT_CHARS_TOTAL = 60_000

export class AttachmentError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AttachmentError'
    this.status = status
    this.code = code
  }
}

export interface ProjectAttachment {
  id: string
  projectId: string
  stage: ProjectStage | null
  kind: 'input'
  title: string
  filename: string
  /** Relative to the project root. */
  storagePath: string
  textPath: string
  mimeType: string
  sizeBytes: number
  sha256: string
  pages: number
  characters: number
  truncated: boolean
  createdAt: string
}

/** The minimum an attachment needs to be rendered into a prompt. */
export interface PromptAttachment {
  title: string
  filename: string
  pages: number
  characters: number
  text: string
}

/** Reject anything that is not a PDF, with a message that says why. */
export function assertSupportedUpload(input: { filename: string; mimeType: string; size: number }): void {
  const looksPdf = /\.pdf$/i.test(input.filename) || input.mimeType === 'application/pdf'
  if (!looksPdf) {
    const isImage = /^image\//i.test(input.mimeType)
    throw new AttachmentError(
      415,
      'UNSUPPORTED_FILE_TYPE',
      isImage
        ? `"${input.filename}" is an image. Images are not used by stage analysis yet, so attaching one would not affect the result; attach the source as a PDF instead.`
        : `"${input.filename}" is not a PDF. Stage inputs accept PDF files only.`,
    )
  }
  if (input.size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      413,
      'ATTACHMENT_TOO_LARGE',
      `"${input.filename}" is ${Math.round(input.size / 1024 / 1024)} MB; the limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`,
    )
  }
  if (input.size === 0) {
    throw new AttachmentError(400, 'EMPTY_ATTACHMENT', `"${input.filename}" is empty`)
  }
}

/**
 * Trim and label an attachment's text for a prompt.
 *
 * Each document is capped and the whole set is capped, so a large corpus cannot
 * crowd the brief out of the context window. Truncation is stated in the text
 * itself: a silently shortened document would misrepresent the evidence.
 */
export function renderAttachmentPrompt(attachments: PromptAttachment[]): string {
  if (attachments.length === 0) return ''
  const sections: string[] = []
  let remaining = PROMPT_CHARS_TOTAL

  attachments.forEach((meta, index) => {
    const header = [
      `### Input document ${index + 1}: ${meta.title}`,
      `file: ${meta.filename} · pages: ${meta.pages} · characters: ${meta.characters}`,
    ].join('\n')
    if (remaining <= 0) {
      sections.push(`${header}\n[Omitted: the prompt document budget is exhausted.]`)
      return
    }
    const allowance = Math.min(PROMPT_CHARS_PER_ATTACHMENT, remaining)
    const body = meta.text.slice(0, allowance)
    remaining -= body.length
    const cut = body.length < meta.text.length
    sections.push(`${header}\n\n${body}${cut ? '\n\n[Truncated for the prompt; the full text is stored with the attachment.]' : ''}`)
  })

  return [
    'INPUT DOCUMENTS',
    'The requester attached the PDF documents below. Treat them as primary evidence for this stage, quote them where it matters, and cite them by their title.',
    ...sections,
  ].join('\n\n')
}

/** Extract text for a prompt with the same per-document cap. */
export function attachmentTextForPrompt(text: string): string {
  return text.slice(0, PROMPT_CHARS_PER_ATTACHMENT)
}
