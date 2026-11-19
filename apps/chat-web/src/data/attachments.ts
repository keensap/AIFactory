/**
 * Stage input PDFs: client-side limits that mirror the API, error wording and
 * small formatters. The API stays the authority; these only avoid obviously
 * doomed uploads and explain failures.
 */

import { ApiError } from '../api/client.ts'
import type { StageAttachment } from '../api/types.ts'
import { formatBytes } from './requirements.ts'

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_FILES_PER_UPLOAD = 10
export const MAX_ATTACHMENTS_PER_RUN = 20
/** Characters of extracted text analysed per document. */
export const ATTACHMENT_TEXT_LIMIT = 20_000

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function normalizeAttachment(raw: unknown): StageAttachment | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return null
  const filename = typeof record.filename === 'string' ? record.filename : ''
  return {
    id: record.id,
    title: typeof record.title === 'string' && record.title !== '' ? record.title : filename || 'Untitled PDF',
    filename,
    pages: num(record.pages),
    characters: num(record.characters),
    truncated: record.truncated === true,
    sizeBytes: num(record.sizeBytes),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
  }
}

export interface FileLike {
  name: string
  size: number
  type: string
}

export interface FileCheck<T extends FileLike> {
  accepted: T[]
  /** One line per refused file: "<name>: <reason>". */
  rejected: string[]
}

/**
 * Pre-flight: PDFs only, non-empty, ≤ 20 MB, ≤ 10 per upload, ≤ 20 per run.
 * Images are named as unsupported so the limitation is never hidden.
 */
export function checkInputFiles<T extends FileLike>(files: readonly T[], existingCount: number): FileCheck<T> {
  const accepted: T[] = []
  const rejected: string[] = []
  for (const file of files) {
    const name = file.name.toLowerCase()
    if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|heic)$/.test(name)) {
      rejected.push(`${file.name}: images aren’t used by stage analysis yet. Only PDFs with a text layer are accepted.`)
    } else if (!name.endsWith('.pdf') || (file.type !== '' && file.type !== 'application/pdf')) {
      rejected.push(`${file.name}: only PDF files are accepted.`)
    } else if (file.size === 0) {
      rejected.push(`${file.name}: the file is empty.`)
    } else if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push(`${file.name}: ${formatBytes(file.size)} is over the 20 MB limit.`)
    } else if (accepted.length >= MAX_FILES_PER_UPLOAD) {
      rejected.push(`${file.name}: at most ${MAX_FILES_PER_UPLOAD} files can be added at once.`)
    } else if (existingCount + accepted.length >= MAX_ATTACHMENTS_PER_RUN) {
      rejected.push(`${file.name}: a run accepts at most ${MAX_ATTACHMENTS_PER_RUN} input documents.`)
    } else {
      accepted.push(file)
    }
  }
  return { accepted, rejected }
}

/** User-facing text for an upload / list / delete failure. */
export function describeAttachmentError(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : String(error)
  switch (error.code) {
    case 'UNSUPPORTED_FILE_TYPE': return error.message
    case 'ATTACHMENT_TOO_LARGE': return `A file is over the 20 MB limit. ${error.message}`.trim()
    case 'PDF_HAS_NO_TEXT': return 'This looks like a scanned PDF. The stage can only read PDFs with a text layer; run OCR first.'
    case 'INVALID_PDF': return 'This file could not be read as a PDF.'
    case 'FILES_REQUIRED': return 'Choose at least one PDF.'
    case 'TOO_MANY_FILES': return `At most ${MAX_FILES_PER_UPLOAD} files can be uploaded at once.`
    case 'ATTACHMENT_NOT_FOUND': return 'One of the input documents no longer exists. The list was refreshed; check it and try again.'
    default: return error.message
  }
}

/** "4 pages · 89 KB" */
export function attachmentMeta(attachment: Pick<StageAttachment, 'pages' | 'sizeBytes'>): string {
  const parts: string[] = []
  if (attachment.pages !== null) parts.push(`${attachment.pages} ${attachment.pages === 1 ? 'page' : 'pages'}`)
  if (attachment.sizeBytes !== null) parts.push(formatBytes(attachment.sizeBytes))
  return parts.join(' · ')
}

/** Message of the newest `document_export_failed` event, or null (also null once a later export succeeded). */
export function exportFailure(
  events: readonly { type: string; payload: Record<string, unknown> }[],
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'document_exported') return null
    if (event.type === 'document_export_failed') {
      const message = event.payload.message
      return typeof message === 'string' && message.trim() !== '' ? message : 'The renderer reported an error.'
    }
  }
  return null
}
