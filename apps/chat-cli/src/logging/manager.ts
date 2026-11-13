/**
 * Runtime control plane for logging: persisted settings, live reconfiguration
 * (hot-add/remove of the PostgreSQL sink, level, retention), temporary level
 * overrides with TTL, and diagnostics for the admin API.
 */

import type { Logger, Logging, LoggingDiagnostics } from './logging.ts'
import { LEVEL_NAMES, isLevel, type Level, type LevelSnapshot } from './levels.ts'
import type { PostgresLogStore } from './log-store.ts'
import {
  DEFAULT_LOGGING_SETTINGS,
  LoggingSettingsError,
  mergeLoggingSettings,
  type LoggingSettings,
  type LoggingSettingsStore,
} from './settings.ts'
import { PostgresSink } from './sinks/postgres.ts'
import type { FileSink } from './sinks/file.ts'

export interface LoggingManagerOptions {
  logging: Logging
  /** Level used when settings do not pin one (from AIFACTORY_LOG_LEVEL). */
  environmentLevel: Level
  settingsStore?: LoggingSettingsStore
  logStore?: PostgresLogStore
  databaseUrl?: string
  fileSink?: FileSink
}

export interface LoggingAdminView {
  settings: LoggingSettings
  levels: LevelSnapshot
  environmentLevel: Level
  postgresAvailable: boolean
  postgresActive: boolean
  fileSink: { active: boolean; path: string | null }
  diagnostics: LoggingDiagnostics
}

const MAX_TTL_SECONDS = 24 * 60 * 60

export class LoggingManager {
  private readonly logging: Logging
  private readonly log: Logger
  private readonly environmentLevel: Level
  private readonly settingsStore?: LoggingSettingsStore
  private readonly logStore?: PostgresLogStore
  private readonly databaseUrl?: string
  private readonly fileSink?: FileSink
  private current: LoggingSettings = { ...DEFAULT_LOGGING_SETTINGS }
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: LoggingManagerOptions) {
    this.logging = options.logging
    this.log = options.logging.logger.child({ component: 'logging' })
    this.environmentLevel = options.environmentLevel
    if (options.settingsStore !== undefined) this.settingsStore = options.settingsStore
    if (options.logStore !== undefined) this.logStore = options.logStore
    if (options.databaseUrl !== undefined) this.databaseUrl = options.databaseUrl
    if (options.fileSink !== undefined) this.fileSink = options.fileSink
  }

  get postgresAvailable(): boolean {
    return this.databaseUrl !== undefined && this.settingsStore !== undefined
  }

  /** Load persisted settings and apply them. Never throws: failures keep defaults. */
  async init(): Promise<void> {
    try {
      if (this.settingsStore !== undefined) this.current = await this.settingsStore.load()
    } catch (error) {
      this.log.warn({ event: 'logging.settings_load_failed', err: error }, 'using default logging settings')
    }
    await this.apply(this.current)
  }

  settings(): LoggingSettings {
    return { ...this.current, postgres: { ...this.current.postgres }, file: { ...this.current.file } }
  }

  /** Validate, persist and apply a partial settings update. */
  update(input: unknown): Promise<LoggingSettings> {
    return this.serialized(async () => {
      const next = mergeLoggingSettings(this.current, input)
      if (next.postgres.enabled && !this.postgresAvailable) {
        throw new LoggingSettingsError(409, 'POSTGRES_UNAVAILABLE', 'PostgreSQL log storage needs DATABASE_URL and the settings store')
      }
      const saved = this.settingsStore === undefined ? next : await this.settingsStore.save(next)
      this.current = saved
      await this.apply(saved)
      this.log.info({
        event: 'logging.settings_changed',
        level: saved.level,
        postgresEnabled: saved.postgres.enabled,
        postgresMinLevel: saved.postgres.minLevel,
        postgresRetentionDays: saved.postgres.retentionDays,
        fileRetentionDays: saved.file.retentionDays,
      })
      return this.settings()
    })
  }

  /**
   * Temporary or runtime-only level change. Global changes with `ttlSeconds`
   * revert automatically; component overrides last until cleared or restart.
   */
  setRuntimeLevel(input: { level: Level | null; ttlSeconds?: number; component?: string }): LevelSnapshot {
    const { level, ttlSeconds, component } = input
    if (level !== null && !isLevel(level)) {
      throw new LoggingSettingsError(400, 'INVALID_LOG_LEVEL', `level must be one of ${LEVEL_NAMES.join(', ')} or null`)
    }
    if (ttlSeconds !== undefined && (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS)) {
      throw new LoggingSettingsError(400, 'INVALID_TTL', `ttlSeconds must be an integer between 1 and ${MAX_TTL_SECONDS}`)
    }
    if (component !== undefined) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(component)) {
        throw new LoggingSettingsError(400, 'INVALID_COMPONENT', 'component must be 1-64 characters of letters, digits, . _ -')
      }
      if (ttlSeconds !== undefined) {
        throw new LoggingSettingsError(400, 'TTL_NOT_SUPPORTED', 'ttlSeconds applies to the global level only')
      }
      this.logging.levels.setOverride(component, level ?? undefined)
    } else if (level === null) {
      this.logging.levels.setLevel(this.current.level ?? this.environmentLevel)
    } else {
      this.logging.levels.setLevel(level, ttlSeconds === undefined ? {} : { ttlMs: ttlSeconds * 1000 })
    }
    this.log.warn({ event: 'logging.level_changed', level, component: component ?? null, ttlSeconds: ttlSeconds ?? null })
    return this.logging.levels.snapshot()
  }

  view(): LoggingAdminView {
    const diagnostics = this.logging.diagnostics()
    return {
      settings: this.settings(),
      levels: diagnostics.levels,
      environmentLevel: this.environmentLevel,
      postgresAvailable: this.postgresAvailable,
      postgresActive: diagnostics.sinks.some((sink) => sink.name === 'postgres'),
      fileSink: { active: this.fileSink !== undefined && diagnostics.sinks.some((sink) => sink.name === 'file'), path: this.fileSink?.currentPath ?? null },
      diagnostics,
    }
  }

  private async apply(settings: LoggingSettings): Promise<void> {
    try {
      this.logging.levels.setLevel(settings.level ?? this.environmentLevel)
      this.fileSink?.setRetentionDays(settings.file.retentionDays)
      const active = this.logging.diagnostics().sinks.some((sink) => sink.name === 'postgres')
      if (settings.postgres.enabled && this.databaseUrl !== undefined) {
        // Replace rather than mutate so minLevel/retention changes take effect.
        if (active) await this.logging.removeSink('postgres')
        this.logging.addSink(new PostgresSink({
          connectionString: this.databaseUrl,
          minLevel: settings.postgres.minLevel,
          retentionDays: settings.postgres.retentionDays,
        }))
      } else if (active) {
        await this.logging.removeSink('postgres')
      }
    } catch (error) {
      this.log.error({ event: 'logging.apply_failed', err: error }, 'could not apply logging settings')
    }
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }
}
