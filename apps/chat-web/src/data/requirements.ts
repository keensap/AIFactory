/**
 * Requirement intake for a newly started project: either typed text or a PDF
 * requirement document, plus an optional message from the user.
 *
 * Text goes out as the first chat turn. A PDF needs an existing session for
 * `POST /api/projects/:id/sessions/:sid/pdf-review`, so the UI first opens the
 * session with a short intro turn and then sends the PDF for review.
 */

export const MAX_PDF_BYTES = 5 * 1024 * 1024
/** Leaves headroom under the API's 64 KiB message limit for the wrapper text. */
export const MAX_REQUIREMENT_CHARS = 60_000

export type RequirementSubmission =
  | { kind: 'text'; text: string; message: string }
  | { kind: 'pdf'; file: File; message: string }

export interface FileLike {
  name: string
  size: number
  type: string
}

/** Validate name, MIME type and size. Returns an error message or undefined. */
export function validatePdfFile(file: FileLike): string | undefined {
  if (!file.name.toLowerCase().endsWith('.pdf')) return 'Choose a file with a .pdf extension.'
  if (file.type !== '' && file.type !== 'application/pdf') return 'That file is not a PDF document.'
  if (file.size === 0) return 'That file is empty.'
  if (file.size > MAX_PDF_BYTES) return `The PDF is ${formatBytes(file.size)}; the limit is 5 MB.`
  return undefined
}

/** True when the bytes start with the PDF signature `%PDF-`. */
export function hasPdfSignature(bytes: Uint8Array): boolean {
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]
  return signature.every((byte, index) => bytes[index] === byte)
}

export async function readPdfSignature(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer())
  return hasPdfSignature(head)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** First chat message for typed requirements. */
export function composeTextRequirement(text: string, message: string): string {
  const note = message.trim()
  return `${note === '' ? 'Here are the requirements for this project.' : note}\n\n## Project requirements\n\n${text.trim()}`
}

/** Intro turn that opens the session before the PDF review. */
export function composePdfIntro(projectName: string, filename: string, message: string): string {
  const note = message.trim()
  const intro = `I'm starting the project “${projectName}”. Its requirements document “${filename}” is being sent next for review.`
  return note === '' ? intro : `${note}\n\n${intro}`
}

/** Reviewer instruction sent with the PDF. */
export function composePdfInstruction(message: string): string {
  const base = 'Review this requirement document for completeness, ambiguities and risks, and list any questions that must be answered before design starts.'
  const note = message.trim()
  return note === '' ? base : `${base}\n\nNotes from the user: ${note}`
}
