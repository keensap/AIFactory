/**
 * Shared launch configuration for the terminal client and the HTTP API.
 *
 * Keeping this in one place matters because both surfaces must resolve the
 * harness executable, profile and timeout identically; otherwise "it works in
 * the CLI but not in the API" becomes a configuration bug rather than a code
 * bug.
 */

import { existsSync, readFileSync } from 'node:fs'

export const DEFAULT_TIMEOUT_MS = 120_000

export interface HarnessConfig {
  command: string
  profile: string
  cwd: string
  timeoutMs: number
  permissionMode?: string
}

export interface HarnessConfigInput {
  dshBin?: string
  profile?: string
  timeoutMs?: string | number
  permissionMode?: string
  cwd?: string
}

export function parsePositiveInt(
  value: string | number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number, got "${String(value)}"`)
  }
  return Math.floor(parsed)
}

/**
 * Resolve harness settings with one precedence order:
 * explicit argument > AIFACTORY_* environment > DSH_* environment > default.
 */
export function resolveHarnessConfig(input: HarnessConfigInput = {}): HarnessConfig {
  const command = String(
    input.dshBin
      ?? process.env.AIFACTORY_DSH_BIN
      ?? process.env.DSH_BIN
      ?? 'dsh',
  )

  if (command.startsWith('=')) {
    throw new Error(
      `DSH_BIN begins with "=" ("${command}"). Use a single "=": DSH_BIN=/path/to/dsh`,
    )
  }

  const profile = String(input.profile ?? process.env.AIFACTORY_PROFILE ?? 'headless')
  const timeoutMs = parsePositiveInt(
    input.timeoutMs ?? process.env.AIFACTORY_TIMEOUT_MS ?? process.env.DSH_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    'timeout',
  )

  const config: HarnessConfig = {
    command,
    profile,
    cwd: input.cwd ?? process.cwd(),
    timeoutMs,
  }
  const permissionMode = input.permissionMode ?? process.env.AIFACTORY_PERMISSION_MODE
  if (permissionMode !== undefined && permissionMode !== '') {
    config.permissionMode = permissionMode
  }
  return config
}

/**
 * DSH treats every `DSH_*` key as launch-only and refuses to boot when one
 * appears in a `.env` layer. Detect that early so both entrypoints can print a
 * one-line fix instead of a child-process stack trace.
 */
export function findLaunchOnlyDotEnvKeys(cwd: string): string[] {
  const path = `${cwd}/.env`
  if (!existsSync(path)) return []
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const keys = new Set<string>()
  for (const match of text.matchAll(/^\s*(DSH_[A-Z0-9_]+)\s*=/gm)) {
    if (match[1] !== undefined) keys.add(match[1])
  }
  return [...keys]
}

/**
 * Load workspace `.env`. The harness also reads this file for provider
 * credentials; loading it here makes the `.env`-safe CLI names
 * (AIFACTORY_DSH_BIN, AIFACTORY_PROFILE, AIFACTORY_TIMEOUT_MS,
 * AIFACTORY_PERMISSION_MODE) available to both entrypoints.
 * Existing environment variables win, matching Node's loadEnvFile semantics.
 */
export function loadDotEnv(cwd: string): void {
  const path = `${cwd}/.env`
  if (!existsSync(path)) return
  try {
    process.loadEnvFile(path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`warning: could not read ${path}: ${message}\n`)
  }
}
