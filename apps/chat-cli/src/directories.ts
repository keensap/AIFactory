/**
 * Read-only directory browser for UIs that need a real absolute path (for
 * example a project's root directory). Browsers cannot reveal local paths, so
 * the API host lists its own directories. Only directory names are returned —
 * never file names or contents.
 */

import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export const MAX_DIRECTORY_ENTRIES = 1000

export interface DirectoryEntry {
  name: string
  path: string
}

export interface DirectoryListing {
  /** Canonical absolute path that was listed. */
  path: string
  /** Parent directory, or null at the filesystem root. */
  parent: string | null
  /** The API host's home directory, a convenient starting point. */
  home: string
  entries: DirectoryEntry[]
  /** True when more than MAX_DIRECTORY_ENTRIES subdirectories exist. */
  truncated: boolean
}

export class DirectoryError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'DirectoryError'
    this.status = status
    this.code = code
  }
}

export async function listDirectories(
  requested: string | undefined,
  options: { showHidden?: boolean } = {},
): Promise<DirectoryListing> {
  const home = homedir()
  const target = requested === undefined || requested.trim() === '' ? home : requested.trim()
  if (!isAbsolute(target)) {
    throw new DirectoryError(400, 'INVALID_PATH', 'path must be absolute')
  }

  let canonical: string
  try {
    canonical = await realpath(target)
  } catch {
    throw new DirectoryError(404, 'PATH_NOT_FOUND', `${target} does not exist`)
  }
  const info = await stat(canonical)
  if (!info.isDirectory()) {
    throw new DirectoryError(400, 'NOT_A_DIRECTORY', `${canonical} is not a directory`)
  }

  let dirents
  try {
    dirents = await readdir(canonical, { withFileTypes: true })
  } catch {
    throw new DirectoryError(403, 'PATH_NOT_READABLE', `${canonical} cannot be read`)
  }

  const names: string[] = []
  for (const dirent of dirents) {
    if (options.showHidden !== true && dirent.name.startsWith('.')) continue
    if (dirent.isDirectory()) {
      names.push(dirent.name)
    } else if (dirent.isSymbolicLink()) {
      // Follow links so linked project folders are selectable.
      const linked = await stat(join(canonical, dirent.name)).catch(() => undefined)
      if (linked?.isDirectory() === true) names.push(dirent.name)
    }
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))

  const parent = dirname(canonical)
  return {
    path: canonical,
    parent: parent === canonical ? null : parent,
    home,
    entries: names.slice(0, MAX_DIRECTORY_ENTRIES).map((name) => ({ name, path: join(canonical, name) })),
    truncated: names.length > MAX_DIRECTORY_ENTRIES,
  }
}
