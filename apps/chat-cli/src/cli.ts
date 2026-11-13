#!/usr/bin/env node
/**
 * A deliberately small interactive chat client for DeepSeek Harness.
 *
 * The first iteration keeps one concern per file:
 *   - `protocol.ts` describes the headless NDJSON events.
 *   - `harness.ts` owns process lifecycle and session continuity.
 *   - this file owns the terminal loop and presentation.
 *
 * It is intentionally not a framework yet. The next iterations can add a
 * long-lived SDK transport, tool-approval prompts and token accounting without
 * changing the command surface.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import {
  DEFAULT_TIMEOUT_MS,
  findLaunchOnlyDotEnvKeys,
  loadDotEnv,
  resolveHarnessConfig,
  type HarnessConfig,
} from './config.ts'
import { DshHarness, HarnessError } from './harness.ts'
import type { HarnessEvent } from './protocol.ts'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

interface ChatConfig extends HarnessConfig {
  resume?: string
  showThinking: boolean
  debug: boolean
  color: boolean
}

interface DoctorConfig {
  command: string
  profile: string
  cwd: string
  color: boolean
}

function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
}

function paint(text: string, code: string, enabled: boolean): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text
}

function dim(text: string, color: boolean): string {
  return paint(text, '2', color)
}

function red(text: string, color: boolean): string {
  return paint(text, '31', color)
}

function cyan(text: string, color: boolean): string {
  return paint(text, '36', color)
}

function helpText(): string {
  return `AI Factory chat — a minimal DeepSeek Harness client

Usage:
  node src/cli.ts [chat] [options]
  node src/cli.ts doctor [options]

Options:
  --dsh-bin <path>        harness executable (default: $AIFACTORY_DSH_BIN,
                          then $DSH_BIN, then "dsh")
  --profile <name>        harness profile (default: $AIFACTORY_PROFILE or "headless")
  --permission-mode <p>   pass a permission preset through to headless
  --resume <session-id>   continue an existing harness session
  --timeout <ms>          per-turn timeout (default: ${DEFAULT_TIMEOUT_MS})
  --show-thinking         print the harness "thinking" events
  --debug                 print tool calls and child stderr on failure
  --no-color              disable ANSI colour
  -h, --help              show this help
  -v, --version           print the CLI version

Inside the chat:
  /help                   show commands
  /new                    start a fresh harness session
  /session                print the current session id
  /exit, /quit            leave the chat

Examples:
  DSH_BIN=/path/to/dsh node src/cli.ts
  node src/cli.ts --resume session-abc123
  node src/cli.ts doctor
`
}

function readConfig(values: Record<string, unknown>): ChatConfig {
  const harness = resolveHarnessConfig({
    ...(typeof values['dsh-bin'] === 'string' ? { dshBin: values['dsh-bin'] } : {}),
    ...(typeof values.profile === 'string' ? { profile: values.profile } : {}),
    ...(typeof values.timeout === 'string' ? { timeoutMs: values.timeout } : {}),
    ...(typeof values['permission-mode'] === 'string'
      ? { permissionMode: values['permission-mode'] }
      : {}),
  })

  const config: ChatConfig = {
    ...harness,
    showThinking: values['show-thinking'] === true,
    debug: values.debug === true,
    color: supportsColor() && values['no-color'] !== true,
  }
  if (typeof values.resume === 'string') config.resume = values.resume
  return config
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        'dsh-bin': { type: 'string' },
        profile: { type: 'string' },
        'permission-mode': { type: 'string' },
        resume: { type: 'string' },
        timeout: { type: 'string' },
        'show-thinking': { type: 'boolean' },
        debug: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    })
  } catch (error) {
    process.stderr.write(`${red('error:', supportsColor())} ${(error as Error).message}\n`)
    process.stderr.write('Run with --help for usage.\n')
    process.exitCode = 2
    return
  }

  if (parsed.values.help === true) {
    process.stdout.write(helpText())
    return
  }
  if (parsed.values.version === true) {
    process.stdout.write(`${packageJson.version}\n`)
    return
  }

  const command = parsed.positionals[0] ?? 'chat'
  const launchOnlyKeys = findLaunchOnlyDotEnvKeys(process.cwd())
  if (launchOnlyKeys.length > 0) {
    process.stderr.write(
      `${red('error:', supportsColor())} ${launchOnlyKeys.join(', ')} must be set in the launching shell, not in .env.\n`,
    )
    process.stderr.write('The harness rejects DSH_* variables in .env. Remove them and either:\n')
    process.stderr.write('  export DSH_BIN=/fs22/deepseek-harness/apps/cli/lib/bin.js\n')
    process.stderr.write('or use the .env-safe names:\n')
    process.stderr.write('  AIFACTORY_DSH_BIN=/fs22/deepseek-harness/apps/cli/lib/bin.js\n')
    process.stderr.write('  AIFACTORY_TIMEOUT_MS=120000\n')
    process.exitCode = 2
    return
  }
  loadDotEnv(process.cwd())

  let config: ChatConfig
  try {
    config = readConfig(parsed.values as Record<string, unknown>)
  } catch (error) {
    process.stderr.write(`${red('error:', supportsColor())} ${(error as Error).message}\n`)
    process.exitCode = 2
    return
  }

  if (command === 'doctor') {
    await runDoctor({
      command: config.command,
      profile: config.profile,
      cwd: config.cwd,
      color: config.color,
    })
    return
  }
  if (command !== 'chat') {
    process.stderr.write(`${red('error:', config.color)} unknown command "${command}"\n`)
    process.stderr.write('Run with --help for usage.\n')
    process.exitCode = 2
    return
  }

  await runChat(config)
}

async function runChat(config: ChatConfig): Promise<void> {
  const harness = new DshHarness({
    command: config.command,
    profile: config.profile,
    ...(config.permissionMode !== undefined ? { permissionMode: config.permissionMode } : {}),
    cwd: config.cwd,
    timeoutMs: config.timeoutMs,
  })

  let sessionId = config.resume
  let busy = false
  let closed = false

  process.stdout.write(`${cyan('AI Factory chat', config.color)} ${dim(`· ${config.command} --profile ${config.profile}`, config.color)}\n`)
  if (sessionId !== undefined) {
    process.stdout.write(`${dim(`resuming session ${sessionId}`, config.color)}\n`)
  }
  process.stdout.write(`${dim('Type /help for commands, /exit to leave.', config.color)}\n\n`)

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  })

  rl.on('SIGINT', () => {
    if (busy) {
      process.stderr.write(`\n${dim('cancelling…', config.color)}\n`)
      harness.cancel()
      return
    }
    process.stdout.write('\n')
    rl.close()
  })

  const prompt = (): void => {
    if (!closed) rl.prompt()
  }

  rl.on('close', () => {
    closed = true
  })

  rl.setPrompt(`${cyan('you>', config.color)} `)
  prompt()

  for await (const raw of rl) {
    const input = raw.trim()
    if (input === '') {
      prompt()
      continue
    }

    if (input.startsWith('/')) {
      const keepGoing = handleCommand(input, {
        color: config.color,
        getSession: () => sessionId,
        clearSession: () => {
          sessionId = undefined
        },
        close: () => rl.close(),
      })
      if (!keepGoing) break
      prompt()
      continue
    }

    busy = true
    try {
      const nextSession = await runTurn(harness, input, sessionId, config)
      if (nextSession !== undefined) sessionId = nextSession
    } finally {
      busy = false
    }
    process.stdout.write('\n')
    prompt()
  }

  process.stdout.write(`${dim('bye.', config.color)}\n`)
}

interface CommandContext {
  color: boolean
  getSession(): string | undefined
  clearSession(): void
  close(): void
}

function handleCommand(input: string, context: CommandContext): boolean {
  const [command] = input.split(/\s+/, 1)
  switch (command) {
    case '/exit':
    case '/quit':
      context.close()
      return false
    case '/help':
      process.stdout.write(`\n${dim('Commands:', context.color)}\n`)
      process.stdout.write('  /help      show this list\n')
      process.stdout.write('  /new       start a fresh harness session\n')
      process.stdout.write('  /session   print the current session id\n')
      process.stdout.write('  /exit      leave the chat (also /quit)\n\n')
      return true
    case '/new':
      context.clearSession()
      process.stdout.write(`${dim('new session will start on the next message.', context.color)}\n`)
      return true
    case '/session':
      process.stdout.write(`${context.getSession() ?? '(no session yet)'}\n`)
      return true
    default:
      process.stdout.write(`${red('unknown command:', context.color)} ${command}\n`)
      process.stdout.write(`${dim('Try /help.', context.color)}\n`)
      return true
  }
}

async function runTurn(
  harness: DshHarness,
  prompt: string,
  sessionId: string | undefined,
  config: ChatConfig,
): Promise<string | undefined> {
  let wroteText = false
  let openLine = false
  const spinner = createSpinner(config.color)

  try {
    const result = await harness.run(prompt, {
      ...(sessionId !== undefined ? { sessionId } : {}),
      onEvent: (event: HarnessEvent) => {
        if (event.type === 'status' || event.type === 'session') return
        spinner.stop()

        if (event.type === 'text') {
          if (typeof event.text !== 'string' || event.text === '') return
          if (!wroteText) {
            process.stdout.write(`${cyan('ai>', config.color)} `)
            wroteText = true
          }
          process.stdout.write(event.text)
          openLine = !event.text.endsWith('\n')
          return
        }

        if (event.type === 'thinking' && config.showThinking) {
          if (typeof event.text === 'string' && event.text !== '') {
            process.stderr.write(`${dim(event.text, config.color)}\n`)
          }
          return
        }

        if (event.type === 'tool_call' && config.debug) {
          const name = typeof event.name === 'string' ? event.name : 'unknown'
          process.stderr.write(`${dim(`[tool] ${name}`, config.color)}\n`)
          return
        }

        if (event.type === 'tool_result' && config.debug && event.error !== undefined) {
          process.stderr.write(`${dim('[tool] failed', config.color)}\n`)
        }
      },
    })

    spinner.stop()

    if (!wroteText && result.text !== '') {
      process.stdout.write(`${cyan('ai>', config.color)} ${result.text}`)
      wroteText = true
      openLine = !result.text.endsWith('\n')
    }
    if (!wroteText) {
      process.stdout.write(`${cyan('ai>', config.color)} ${dim('(no answer)', config.color)}\n`)
      return result.sessionId
    }
    if (openLine) process.stdout.write('\n')
    return result.sessionId
  } catch (error) {
    spinner.stop()
    if (openLine) process.stdout.write('\n')
    printError(error, config)
    return sessionId
  }
}

function createSpinner(color: boolean): { stop(): void } {
  if (!process.stderr.isTTY) return { stop() {} }
  process.stderr.write(dim('thinking…', color))
  let stopped = false
  return {
    stop() {
      if (stopped) return
      stopped = true
      process.stderr.write('\r\x1b[2K')
    },
  }
}

function printError(error: unknown, config: ChatConfig): void {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${red('error:', config.color)} ${message}\n`)
  if (error instanceof HarnessError) {
    if (error.code !== undefined) process.stderr.write(`${dim(`code: ${error.code}`, config.color)}\n`)
    if (config.debug && error.stderr !== undefined && error.stderr.trim() !== '') {
      process.stderr.write(`${dim('--- harness stderr ---', config.color)}\n`)
      process.stderr.write(`${error.stderr.trimEnd()}\n`)
      process.stderr.write(`${dim('---------------------', config.color)}\n`)
    }
  }
}

interface ProbeResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

function probe(command: string, args: string[], timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: '', error: (error as Error).message })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, stdout, stderr, error: `timed out after ${timeoutMs} ms` })
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish({ ok: false, stdout, stderr, error: error.message })
    })
    child.on('close', (code) => {
      finish({
        ok: code === 0,
        stdout,
        stderr,
        ...(code === 0 ? {} : { error: `exit ${code}` }),
      })
    })
  })
}

async function runDoctor(config: DoctorConfig): Promise<void> {
  const color = config.color
  const version = await probe(config.command, ['--version'], 10_000)
  const envKey = process.env.DEEPSEEK_API_KEY
  const cwdEnv = existsSync(`${config.cwd}/.env`)
  const dshHome = process.env.DSH_HOME
  const homeEnv = dshHome !== undefined && existsSync(`${dshHome}/.env`)

  const row = (label: string, value: string): void => {
    process.stdout.write(`${label.padEnd(20)} ${value}\n`)
  }

  process.stdout.write(`${cyan('AI Factory chat doctor', color)}\n\n`)
  row('node', process.version)
  row('working directory', config.cwd)
  row('harness command', config.command)
  row('harness profile', config.profile)
  const versionLine = version.stdout.trim().split(/\r?\n/, 1)[0] ?? ''
  row(
    'harness version',
    version.ok
      ? versionLine || '(no output)'
      : `${red('failed', color)} ${version.error ?? ''}`.trim(),
  )
  row('DEEPSEEK_API_KEY', envKey !== undefined && envKey !== '' ? 'present' : `${red('absent', color)}`)
  row('.env in workspace', cwdEnv ? 'present' : 'absent')
  row('DSH_HOME', dshHome ?? '(not set)')
  row('.env in DSH_HOME', homeEnv ? 'present' : 'absent')

  process.stdout.write(`\n${dim('Hints', color)}\n`)
  process.stdout.write('  Headless reads DEEPSEEK_API_KEY from the environment,\n')
  process.stdout.write('  <workspace>/.env, then $DSH_HOME/.env.\n')
  process.stdout.write('  It does not use sign-ins saved by the web GUI.\n')
  process.stdout.write('  Install the harness with: npm i -g @deepseek-ai/dsh\n')
  process.stdout.write('  Or point --dsh-bin at an existing dsh executable.\n')
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
