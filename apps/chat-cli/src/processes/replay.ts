import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface ReplayEntry {
  runId: string
  role: string
  prompt: string
  reply: string
}

const MAX_ENTRY_BYTES = 1024 * 1024
const MAX_ENTRIES = 1024

function digest(value: unknown): string {
  // JSON preserves tuple boundaries and distinguishes lone surrogates from U+FFFD.
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function runDirectory(root: string, runId: string): string {
  if (typeof runId !== 'string' || runId.length === 0 || Buffer.byteLength(runId) > 256) {
    throw new Error('Invalid replay run ID')
  }
  return join(root, digest(runId))
}

function replayRoot(root: string): string {
  if (typeof root !== 'string' || root.trim() === '') throw new Error('Replay root must be configured')
  return resolve(root)
}

function codeIs(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

async function requirePrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new Error('Replay directories must be private, non-symlink directories')
  }
}

function slot(directory: string, index: number): string {
  return join(directory, `${String(index).padStart(4, '0')}.json`)
}

/** Opt-in capture. The caller supplies a dedicated root below a trusted workspace directory. */
export async function recordReplay(root: string, entry: ReplayEntry): Promise<void> {
  root = replayRoot(root)
  const { runId, role, prompt, reply } = entry
  const directory = runDirectory(root, runId)
  if (typeof role !== 'string' || typeof prompt !== 'string' || typeof reply !== 'string') {
    throw new Error('Invalid replay entry')
  }
  if (Buffer.byteLength(role) + Buffer.byteLength(prompt) + Buffer.byteLength(reply) > MAX_ENTRY_BYTES) {
    throw new Error('Replay entry exceeds the capture size limit')
  }
  const data = JSON.stringify({ version: 1, runId, role, prompt, reply, inputHash: digest([role, prompt]) })
  if (Buffer.byteLength(data) > MAX_ENTRY_BYTES) throw new Error('Replay entry exceeds the capture size limit')

  await mkdir(root, { recursive: true, mode: 0o700 })
  await requirePrivateDirectory(root)
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if (!codeIs(error, 'EEXIST')) throw error
  }
  await requirePrivateDirectory(directory)

  const temporary = join(directory, `${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(data, 'utf8')
    } finally {
      await handle.close()
    }

    // Publish only a complete file. A hard link fails if the slot already exists,
    // so concurrent writers never replace entries. Order is publication order.
    for (let i = 0; i < MAX_ENTRIES; i++) {
      try {
        await link(temporary, slot(directory, i))
        return
      } catch (error) {
        if (!codeIs(error, 'EEXIST')) throw error
      }
    }
    throw new Error('Replay run exceeds the capture entry limit')
  } finally {
    await unlink(temporary)
  }
}

async function readEntry(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > MAX_ENTRY_BYTES) {
      throw new Error('Replay entry must be a private regular file within the size limit')
    }
    const data = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== info.size) throw new Error('Replay entry changed while being read')
    try {
      return JSON.parse(data.toString('utf8', 0, offset))
    } catch {
      throw new Error('Invalid replay entry JSON')
    }
  } finally {
    await handle.close()
  }
}

/** A single-use cursor over a capture; no model, cwd access, or fallback. */
export class ReplayRunner {
  private readonly root: string
  private readonly directory: string
  private readonly runId: string
  private index = 0
  private pending: Promise<void> = Promise.resolve()

  constructor(root: string, runId: string) {
    this.root = replayRoot(root)
    this.directory = runDirectory(this.root, runId)
    this.runId = runId
  }

  readonly runPrompt = (role: string, prompt: string, _cwd: string): Promise<string> => {
    const next = this.pending.then(() => this.consume(role, prompt))
    this.pending = next.then(() => undefined, () => undefined)
    return next
  }

  private async consume(role: string, prompt: string): Promise<string> {
    await requirePrivateDirectory(this.root)
    await requirePrivateDirectory(this.directory)
    const index = this.index
    if (index >= MAX_ENTRIES) throw new Error(`Replay exhausted at entry ${index + 1}`)
    let value: unknown
    try {
      value = await readEntry(slot(this.directory, index))
    } catch (error) {
      if (codeIs(error, 'ENOENT')) throw new Error(`Replay exhausted at entry ${index + 1}`)
      throw error
    }
    const entry = value as Partial<ReplayEntry & { version: number; inputHash: string }> | null
    if (entry?.version !== 1 || entry.runId !== this.runId || typeof entry.role !== 'string' ||
        typeof entry.prompt !== 'string' || typeof entry.reply !== 'string' ||
        entry.inputHash !== digest([entry.role, entry.prompt])) {
      throw new Error(`Invalid replay entry ${index + 1}`)
    }
    if (role !== entry.role || prompt !== entry.prompt || entry.inputHash !== digest([role, prompt])) {
      throw new Error(`Replay input mismatch at entry ${index + 1}`)
    }
    this.index++
    return entry.reply
  }
}
