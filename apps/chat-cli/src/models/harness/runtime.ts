/**
 * Applies the global model target to every harness run.
 *
 * One patch file is generated per target revision and passed to every
 * `dsh --profile <p> --patch <file>` invocation, so stage roles, chat and
 * briefings all use the same provider/model.
 *
 * Refreshing is explicit: at startup and whenever the target changes. A failure
 * to build or write the patch is logged and leaves the harness on its profile
 * default; it never stops the Factory.
 */

import { spawn } from 'node:child_process'
import { chmod, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DshHarness } from '../../harness.ts'
import { noopLogger, type Logger } from '../../logging/index.ts'
import { buildModelPatch, keysToScrub, type ModelPatch } from './patch.ts'
import type { ModelService } from '../service.ts'
import type { ResolvedTarget } from '../settings.ts'

export interface ModelRuntimeOptions {
  service: ModelService
  /** Harness launcher, usually resolved from configuration. */
  command: string
  commandArgs?: string[]
  profile: string
  permissionMode?: string
  /** Directory for generated patch files. */
  patchDir: string
  env?: Record<string, string | undefined>
  logger?: Logger
  /** Validate the generated patch with `dsh --dump-config` (default true). */
  validate?: boolean
  validateTimeoutMs?: number
  now?: () => number
}

export interface ModelRuntimeStatus {
  applied: boolean
  provider: string | null
  model: string | null
  source: string | null
  patchPath: string | null
  warnings: string[]
  lastError: string | null
}

const KEEP_PATCH_FILES = 5

export class ModelRuntime {
  private readonly service: ModelService
  private readonly command: string
  private readonly commandArgs: string[]
  private readonly profile: string
  private readonly permissionMode?: string
  private readonly patchDir: string
  private readonly env: Record<string, string | undefined>
  private readonly log: Logger
  private readonly validate: boolean
  private readonly validateTimeoutMs: number
  private readonly now: () => number
  private patchPath: string | null = null
  private requiredEnv: string[] = []
  private warnings: string[] = []
  private lastError: string | null = null
  private resolved: ResolvedTarget | null = null
  private patch: ModelPatch | null = null

  constructor(options: ModelRuntimeOptions) {
    this.service = options.service
    this.command = options.command
    this.commandArgs = options.commandArgs ?? []
    this.profile = options.profile
    if (options.permissionMode !== undefined) this.permissionMode = options.permissionMode
    this.patchDir = options.patchDir
    this.env = options.env ?? process.env
    this.log = (options.logger ?? noopLogger).child({ component: 'models' })
    this.validate = options.validate ?? true
    this.validateTimeoutMs = options.validateTimeoutMs ?? 10_000
    this.now = options.now ?? Date.now
  }

  status(): ModelRuntimeStatus {
    return {
      applied: this.patchPath !== null,
      provider: this.resolved?.target?.provider ?? null,
      model: this.resolved?.target?.model ?? null,
      source: this.resolved?.source ?? null,
      patchPath: this.patchPath,
      warnings: [...this.warnings],
      lastError: this.lastError,
    }
  }

  /** Rebuild the patch from the current target. Never throws. */
  async refresh(): Promise<ModelRuntimeStatus> {
    try {
      const resolved = await this.service.resolveForRun()
      this.resolved = resolved
      this.warnings = [...resolved.warnings]
      if (resolved.target === null) {
        await this.removePatch()
        this.lastError = null
        return this.status()
      }
      const { providers, models } = await this.service.snapshot()
      const patch = buildModelPatch({ target: resolved.target, providers, models })
      const path = await this.writePatch(patch.content)
      this.patch = patch
      this.requiredEnv = patch.requiredEnv
      this.patchPath = path
      this.lastError = null
      if (this.validate) {
        const problem = await this.validatePatch(path)
        if (problem !== null) {
          this.warnings.push(problem)
          this.log.warn({ event: 'models.patch_validation_failed', provider: patch.provider, model: patch.model, problem })
        }
      }
      this.log.info({
        event: 'models.target_applied',
        provider: patch.provider,
        model: patch.model,
        routes: Object.keys(patch.routes),
        source: resolved.source,
      })
      return this.status()
    } catch (error) {
      // Keep the last good patch applied: a failed refresh must not break runs.
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log.warn({ event: 'models.patch_failed', err: error }, 'could not apply the model target; keeping the previous patch')
      return this.status()
    }
  }

  /** Harness for one run, carrying the current patch and a minimised environment. */
  harness(cwd?: string, timeoutMs?: number): DshHarness {
    const scrub = keysToScrub(this.env, this.requiredEnv)
    return new DshHarness({
      command: this.command,
      ...(this.commandArgs.length > 0 ? { commandArgs: this.commandArgs } : {}),
      profile: this.profile,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(this.permissionMode !== undefined ? { permissionMode: this.permissionMode } : {}),
      ...(this.patchPath !== null ? { patches: [this.patchPath] } : {}),
      ...(scrub.length > 0 ? { envDelete: scrub } : {}),
    })
  }

  /** The patch currently applied (tests and diagnostics). */
  currentPatch(): ModelPatch | null {
    return this.patch
  }

  async shutdown(): Promise<void> {
    await this.removePatch()
  }

  private async writePatch(content: string): Promise<string> {
    await mkdir(this.patchDir, { recursive: true, mode: 0o700 })
    const finalPath = join(this.patchDir, `model-target-${this.now()}.json`)
    const tempPath = `${finalPath}.tmp`
    await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 })
    await chmod(tempPath, 0o600).catch(() => {})
    await rename(tempPath, finalPath)
    // The previous patch stays on disk until pruning: a harness spawned with it
    // may still be reading it while the new target is written.
    await this.prune()
    return finalPath
  }

  private async removePatch(): Promise<void> {
    const path = this.patchPath
    this.patchPath = null
    this.patch = null
    this.requiredEnv = []
    if (path !== null) await unlink(path).catch(() => {})
  }

  /** Keep the directory small; oldest patch files are removed. */
  private async prune(): Promise<void> {
    const names = (await readdir(this.patchDir).catch(() => [] as string[]))
      .filter((name) => name.startsWith('model-target-') && name.endsWith('.json'))
      .sort()
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_PATCH_FILES))) {
      await unlink(join(this.patchDir, name)).catch(() => {})
    }
  }

  /** Run `dsh --dump-config --patch <file>` and return a problem description. */
  private async validatePatch(path: string): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false
      let output = ''
      const finish = (problem: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(problem)
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(`patch validation timed out after ${this.validateTimeoutMs}ms`)
      }, this.validateTimeoutMs)
      timer.unref?.()
      const child = spawn(this.command, [...this.commandArgs, '--profile', this.profile, '--dump-config', '--patch', path], {
        env: { ...process.env, ...this.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error: Error) => finish(`patch validation could not start: ${error.message}`))
      child.once('close', (code: number | null) => {
        if (code === 0) return finish(null)
        const tail = output.trim().split('\n').slice(-3).join(' ').slice(0, 400)
        finish(`dsh rejected the generated patch (exit ${code ?? 'signal'}): ${tail}`)
      })
    })
  }
}
