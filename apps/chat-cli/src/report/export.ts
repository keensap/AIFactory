/**
 * Where stage deliverables are written.
 *
 * The PDF is a user-facing artifact, so it goes **outside** `.aifactory`, into
 * the project's own tree:
 *
 *   <project-root>/documents/<stage>/<Document Title> — <Project Name>.pdf
 *
 * `.aifactory` keeps the Markdown source and the versioned history; the
 * documents tree holds the deliverable. Re-running a stage overwrites the same
 * canonical file so the path stays predictable.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const EXPORT_ROOT = 'documents'

export class ExportError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ExportError'
    this.code = code
  }
}

/**
 * Filename-safe stem.
 *
 * Keeps human title characters (including the em dash and accents) so the file
 * reads like the document it contains, and removes only what a filesystem or a
 * URL cannot carry: path separators, Windows-reserved characters, control
 * characters, and leading/trailing dots or spaces.
 */
export function safeFileStem(text: string, maxLength = 120): string {
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  const stem = cleaned === '' ? 'document' : cleaned
  if (stem.length <= maxLength) return stem
  return stem.slice(0, maxLength).trim().replace(/[.\s]+$/g, '') || 'document'
}

/** The canonical file name, e.g. `TELOS Feasibility Report — ABCClothing.pdf`. */
export function exportFileName(title: string, projectName: string, maxLength = 120): string {
  return `${safeFileStem(`${title} — ${projectName}`, maxLength)}.pdf`
}

export interface ExportTarget {
  /** Path relative to the project root, using forward slashes for the API. */
  relativePath: string
  absolutePath: string
}

/**
 * Resolve where a stage document belongs, refusing anything that would escape
 * the project's `documents/` directory.
 */
export function exportTarget(input: { projectRoot: string; stage: string; title: string; projectName: string }): ExportTarget {
  const root = resolve(input.projectRoot)
  const documentsRoot = join(root, EXPORT_ROOT)
  const absolutePath = join(documentsRoot, input.stage, exportFileName(input.title, input.projectName))
  if (!absolutePath.startsWith(`${documentsRoot}${sep}`)) {
    throw new ExportError('EXPORT_PATH_ESCAPE', 'the export path escapes the project documents directory')
  }
  return {
    relativePath: relative(root, absolutePath).split(sep).join('/'),
    absolutePath,
  }
}

/** Write the PDF, creating `documents/<stage>/` when needed. Overwrites. */
export async function writeExport(target: ExportTarget, bytes: Uint8Array): Promise<{ relativePath: string; absolutePath: string; bytes: number }> {
  try {
    await mkdir(dirname(target.absolutePath), { recursive: true })
    await writeFile(target.absolutePath, bytes)
    return { relativePath: target.relativePath, absolutePath: target.absolutePath, bytes: bytes.byteLength }
  } catch (error) {
    throw new ExportError(
      'EXPORT_WRITE_FAILED',
      `could not write ${target.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}
