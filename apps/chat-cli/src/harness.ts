/**
 * A thin, dependency-free transport over the DeepSeek Harness headless mode.
 *
 * One `run()` is one `dsh --profile headless --json` process. Conversation
 * continuity comes from the harness Session id reported in the opening
 * `session` event and passed back with `--session-id` on the next run.
 *
 * The prompt is written to stdin rather than passed as argv: that avoids
 * option-parsing edge cases for prompts that start with `-`, and keeps long
 * prompts clear of the operating system's argv limit.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  parseHarnessEvent,
  reasonKind,
  type ErrorEvent,
  type HarnessEvent,
  type TurnReason,
} from './protocol.ts'

const MAX_STDERR_BYTES = 64 * 1024
const SIGKILL_GRACE_MS = 2_000

export interface DshHarnessOptions {
  /** Executable to launch. Defaults to `dsh` from PATH. */
  command?: string
  /** Arguments placed before the harness flags, e.g. for a JS entrypoint. */
  commandArgs?: string[]
  /** Harness profile. Defaults to `headless`. */
  profile?: string
  /** Working directory for the child process. */
  cwd?: string
  /** Wall-clock limit for one turn. Defaults to two minutes. */
  timeoutMs?: number
  /** Optional permission preset passed through to headless. */
  permissionMode?: string
  /** Extra environment variables for the child. */
  env?: Record<string, string | undefined>
  /** Environment variables removed from the child (after merging `env`). */
  envDelete?: string[]
  /** Config overlays applied with `--patch`, in order. */
  patches?: string[]
}

export interface RunOptions {
  /** Adopt an existing harness Session instead of starting a new one. */
  sessionId?: string
  /** Abort the child process. */
  signal?: AbortSignal
  /** Observe events as they are committed. */
  onEvent?: (event: HarnessEvent) => void
}

export interface RunResult {
  sessionId: string
  text: string
  reason: TurnReason | null
  events: HarnessEvent[]
  stderr: string
  exitCode: number
  /** Lines on stdout that were not valid harness events. */
  warnings: number
}

export class HarnessError extends Error {
  readonly code?: string
  readonly exitCode?: number
  readonly stderr?: string

  constructor(
    message: string,
    options: { code?: string; exitCode?: number; stderr?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'HarnessError'
    if (options.code !== undefined) this.code = options.code
    if (options.exitCode !== undefined) this.exitCode = options.exitCode
    if (options.stderr !== undefined) this.stderr = options.stderr
  }
}

interface ActiveRun {
  child: ChildProcess
  cancel(): void
}

/** Extract the structured failure a turn reason may carry. */
function reasonFailure(reason: TurnReason | null): { message: string; code?: string } | undefined {
  if (reason === null) return undefined
  const error = reason.error
  if (error === null || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message : undefined
  const code = typeof record.code === 'string' ? record.code : undefined
  if (message === undefined && code === undefined) return undefined
  return {
    message: message ?? `harness turn failed (${code ?? 'unknown'})`,
    ...(code !== undefined ? { code } : {}),
  }
}

/**
 * Read the `tool-*` row ids the configured harness profile declares.
 *
 * Used to verify an agent's tool allowlist against the profile actually in use,
 * so a harness upgrade that adds a tool is noticed instead of silently granted.
 * Returns the ids in profile order; throws when the profile cannot be read.
 */
export async function readProfileToolRows(options: {
  command?: string
  commandArgs?: string[]
  profile?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
} = {}): Promise<string[]> {
  const command = options.command ?? 'dsh'
  const commandArgs = options.commandArgs ?? []
  const profile = options.profile ?? 'headless'
  const timeoutMs = options.timeoutMs ?? 30_000
  return new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const finish = (error: Error | null, rows: string[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== null) reject(error)
      else resolve(rows)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new HarnessError(`reading the ${profile} profile timed out after ${timeoutMs}ms`), [])
    }, timeoutMs)
    timer.unref?.()
    const child = spawn(command, [...commandArgs, '--profile', profile, '--dump-config'], {
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', (error: Error) => finish(new HarnessError(`could not read the ${profile} profile: ${error.message}`), []))
    child.once('close', (code: number | null) => {
      if (code !== 0) {
        // Node writes the message first and the stack after, so the head is more
        // useful than the tail for diagnosing a failed config read.
        const detail = stderr.trim().split('\n').filter((line) => line.trim() !== '').slice(0, 3).join(' ').slice(0, 400)
        finish(new HarnessError(`dsh --dump-config failed (exit ${code ?? 'signal'}): ${detail}`), [])
        return
      }
      const rows: string[] = []
      for (const line of stdout.split('\n')) {
        const match = /^- id: (tool-[a-z0-9-]+)\s*$/.exec(line)
        if (match?.[1] !== undefined && !rows.includes(match[1])) rows.push(match[1])
      }
      finish(null, rows)
    })
  })
}

export class DshHarness {
  private readonly command: string
  private readonly commandArgs: string[]
  private readonly profile: string
  private readonly cwd: string
  private readonly timeoutMs: number
  private readonly permissionMode?: string
  private readonly env?: Record<string, string | undefined>
  private readonly envDelete?: string[]
  private readonly patches?: string[]
  private active: ActiveRun | null = null

  constructor(options: DshHarnessOptions = {}) {
    this.command = options.command ?? 'dsh'
    this.commandArgs = options.commandArgs ?? []
    this.profile = options.profile ?? 'headless'
    this.cwd = options.cwd ?? process.cwd()
    this.timeoutMs = options.timeoutMs ?? 120_000
    if (options.permissionMode !== undefined) this.permissionMode = options.permissionMode
    if (options.env !== undefined) this.env = options.env
    if (options.envDelete !== undefined) this.envDelete = options.envDelete
    if (options.patches !== undefined) this.patches = options.patches
  }

  /** Ask the in-flight turn to stop. Safe to call when idle. */
  cancel(): void {
    this.active?.cancel()
  }

  async run(prompt: string, options: RunOptions = {}): Promise<RunResult> {
    if (prompt.trim() === '') throw new HarnessError('prompt is empty')

    const args = [
      ...this.commandArgs,
      '--profile',
      this.profile,
      ...(this.patches ?? []).flatMap((path) => ['--patch', path]),
      '--json',
    ]
    if (options.sessionId !== undefined && options.sessionId !== '') {
      args.push('--session-id', options.sessionId)
    }
    if (this.permissionMode !== undefined) {
      args.push('--permission-mode', this.permissionMode)
    }

    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...this.env }
    for (const key of this.envDelete ?? []) delete childEnv[key]
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let spawnError: Error | undefined
    let timedOut = false
    let cancelled = false
    let exitCode: number | null = null
    let exitSignal: string | null = null

    const exit = new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      child.once('close', (code, signal) => {
        exitCode = code
        exitSignal = signal
        finish()
      })
      child.once('error', (error) => {
        spawnError = error
        // A failed spawn may not emit `close`; the missing pid distinguishes it.
        if (child.pid === undefined) finish()
      })
    })

    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length >= MAX_STDERR_BYTES) return
      stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length)
    })

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const stopChild = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, SIGKILL_GRACE_MS)
      killTimer.unref()
    }

    const cancel = (): void => {
      cancelled = true
      stopChild()
    }

    this.active = { child, cancel }

    const onAbort = (): void => {
      cancelled = true
      stopChild()
    }
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    if (this.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        stopChild()
      }, this.timeoutMs)
      timeoutTimer.unref()
    }

    child.stdin?.on('error', () => {
      // The child may exit before consuming stdin; the exit code is authoritative.
    })
    child.stdin?.end(prompt.endsWith('\n') ? prompt : `${prompt}\n`)

    const events: HarnessEvent[] = []
    const textParts: string[] = []
    let warnings = 0
    let sessionId = options.sessionId ?? ''
    let finalText: string | undefined
    let finalReason: TurnReason | null = null
    let errorEvent: ErrorEvent | undefined

    const consume = (event: HarnessEvent): void => {
      events.push(event)
      options.onEvent?.(event)

      switch (event.type) {
        case 'session':
          if (typeof event.sessionId === 'string' && event.sessionId !== '') {
            sessionId = event.sessionId
          }
          break
        case 'text':
          if (typeof event.text === 'string' && event.text !== '') textParts.push(event.text)
          break
        case 'final':
          if (typeof event.sessionId === 'string' && event.sessionId !== '') {
            sessionId = event.sessionId
          }
          if (typeof event.text === 'string' && event.text !== '') finalText = event.text
          finalReason = (event.reason ?? null) as TurnReason | null
          break
        case 'error':
          if (typeof event.message === 'string') errorEvent = event as ErrorEvent
          break
        default:
          break
      }
    }

    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        const event = parseHarnessEvent(line)
        if (event === null) {
          if (line.trim() !== '') warnings += 1
          continue
        }
        consume(event)
      }
    } catch (error) {
      // A renderer failure must not leave an orphaned harness process.
      child.kill('SIGKILL')
      throw error
    } finally {
      lines.close()
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      if (this.active?.child === child) this.active = null
    }

    await exit

    if (spawnError !== undefined) {
      throw new HarnessError(
        `cannot start "${this.command}" in ${this.cwd}: ${spawnError.message}. `
          + 'Set AIFACTORY_DSH_BIN in the workspace .env, export DSH_BIN, or pass --dsh-bin.',
        { cause: spawnError, stderr },
      )
    }
    if (timedOut) {
      throw new HarnessError(`harness turn timed out after ${this.timeoutMs} ms`, { stderr })
    }
    if (cancelled) {
      throw new HarnessError('harness turn cancelled', { stderr })
    }
    if (errorEvent !== undefined) {
      throw new HarnessError(errorEvent.message, {
        ...(errorEvent.code !== undefined ? { code: errorEvent.code } : {}),
        ...(exitCode !== null ? { exitCode } : {}),
        stderr,
      })
    }

    const code = Number(exitCode ?? -1)
    const failure = reasonFailure(finalReason)
    if (code !== 0) {
      if (failure !== undefined) {
        throw new HarnessError(failure.message, {
          ...(failure.code !== undefined ? { code: failure.code } : {}),
          exitCode: code,
          stderr,
        })
      }
      const suffix = exitSignal === null ? '' : ` (${exitSignal})`
      throw new HarnessError(`harness exited with code ${code}${suffix}`, {
        exitCode: code,
        stderr,
      })
    }

    const kind = reasonKind(finalReason)
    if (kind !== undefined && kind !== 'completed') {
      throw new HarnessError(failure?.message ?? `harness turn ended with "${kind}"`, {
        ...(failure?.code !== undefined ? { code: failure.code } : {}),
        exitCode: code,
        stderr,
      })
    }
    if (sessionId === '') {
      throw new HarnessError('harness did not report a session id', { exitCode: code, stderr })
    }

    return {
      sessionId,
      text: finalText ?? textParts.join(''),
      reason: finalReason,
      events,
      stderr,
      exitCode: code,
      warnings,
    }
  }
}
