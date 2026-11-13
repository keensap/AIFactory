#!/usr/bin/env node
/**
 * HTTP entrypoint for the chat service.
 *
 * Start with `node src/api.ts` (or `npm run api`). The CLI and the API share
 * the same harness configuration and the same DshHarness transport.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  findLaunchOnlyDotEnvKeys,
  loadDotEnv,
  parsePositiveInt,
  resolveHarnessConfig,
} from './config.ts'
import { ProjectBriefingService } from './briefing.ts'
import { EmbeddingClient } from './embeddings.ts'
import { DshHarness } from './harness.ts'
import {
  ConsoleSink,
  FileSink,
  OtlpLogsSink,
  LoggingManager,
  PostgresLogStore,
  PostgresLoggingSettingsStore,
  createLogging,
  isLevel,
  type Level,
  type LogSink,
} from './logging/index.ts'
import { PdfReviewService } from './pdf-review.ts'
import { PostgresProjectStore, ProjectService, type Project } from './projects.ts'
import { createChatServer } from './server.ts'
import { PostgresSettingsStore, SettingsService } from './settings.ts'
import { PlanningStageRuntime } from './stage-runtime.ts'
import { SemanticIndexService } from './semantic-index.ts'
import { PostgresVectorStore } from './vector-store.ts'
import { ModelRuntime, ModelService, PostgresModelCatalog, PostgresModelSettingsStore } from './models/index.ts'
import { createObservabilityProvider } from './observability/registry/index.ts'
import { CachedObservabilityReader, type ObservabilityProvider, type ObservabilityReader, type TraceRecorder } from './observability/index.ts'
import { PostgresProjectWorkspace, type ProjectDocument } from './workspace.ts'
import { SessionStore } from './store.ts'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

const DEFAULT_PORT = 8787
const DEFAULT_HOST = '127.0.0.1'

function helpText(): string {
  return `AI Factory chat API

Usage:
  node src/api.ts [options]

Options:
  --port <n>              listen port (default: $AIFACTORY_API_PORT or 8787)
  --host <addr>           bind address (default: $AIFACTORY_API_HOST or 127.0.0.1)
  --cors <origins>        "*" or comma-separated origins
                          (default: $AIFACTORY_CORS_ORIGIN or "*")
  --data-dir <path>       session registry directory
                          (default: $AIFACTORY_DATA_DIR or ./.data)
  --token <token>         require Authorization: Bearer <token>
                          (default: $AIFACTORY_API_TOKEN)
  --dsh-bin <path>        harness executable (default: $AIFACTORY_DSH_BIN,
                          then $DSH_BIN, then "dsh")
  --profile <name>        harness profile (default: $AIFACTORY_PROFILE or "headless")
  --permission-mode <p>   pass a permission preset through to headless
  --timeout <ms>          per-turn timeout (default: 120000)
  --show-thinking         forward reasoning events over SSE (off by default)
  --quiet                 disable request logging
  -h, --help              show this help
  -v, --version           print the API version

Endpoints:
  GET    /docs                     live interactive console
  GET    /openapi.yaml             machine-readable contract
  GET    /api                      JSON index
  GET    /api/health
  GET    /api/sessions
  GET    /api/sessions/:id
  GET    /api/sessions/:id/messages
  DELETE /api/sessions/:id
  POST   /api/chat                 { "message": "...", "sessionId": "..." }
  POST   /api/chat/stream          same body, Server-Sent Events

Authentication is disabled when no token is configured. Keep the default
loopback bind unless the API is behind an authenticated reverse proxy.
`
}

function parseCors(value: string): string[] | '*' {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '*') return '*'
  return trimmed.split(',').map((origin) => origin.trim()).filter(Boolean)
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: false,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        cors: { type: 'string' },
        'data-dir': { type: 'string' },
        token: { type: 'string' },
        'dsh-bin': { type: 'string' },
        profile: { type: 'string' },
        'permission-mode': { type: 'string' },
        timeout: { type: 'string' },
        'show-thinking': { type: 'boolean' },
        quiet: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    })
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`)
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

  const cwd = process.cwd()
  const launchOnly = findLaunchOnlyDotEnvKeys(cwd)
  if (launchOnly.length > 0) {
    process.stderr.write(
      `error: ${launchOnly.join(', ')} must be set in the launching shell, not in .env.\n`
        + 'Use AIFACTORY_DSH_BIN / AIFACTORY_TIMEOUT_MS in .env, or export DSH_* in the shell.\n',
    )
    process.exitCode = 2
    return
  }
  loadDotEnv(cwd)

  let harness
  try {
    harness = resolveHarnessConfig({
      ...(typeof parsed.values['dsh-bin'] === 'string' ? { dshBin: parsed.values['dsh-bin'] } : {}),
      ...(typeof parsed.values.profile === 'string' ? { profile: parsed.values.profile } : {}),
      ...(typeof parsed.values.timeout === 'string' ? { timeoutMs: parsed.values.timeout } : {}),
      ...(typeof parsed.values['permission-mode'] === 'string'
        ? { permissionMode: parsed.values['permission-mode'] }
        : {}),
      cwd,
    })
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`)
    process.exitCode = 2
    return
  }

  let port: number
  try {
    port = parsePositiveInt(
      typeof parsed.values.port === 'string' ? parsed.values.port : process.env.AIFACTORY_API_PORT,
      DEFAULT_PORT,
      '--port',
    )
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`)
    process.exitCode = 2
    return
  }
  if (port > 65535) {
    process.stderr.write(`error: --port must be <= 65535, got ${port}\n`)
    process.exitCode = 2
    return
  }

  const host = String(parsed.values.host ?? process.env.AIFACTORY_API_HOST ?? DEFAULT_HOST)
  const cors = parseCors(String(parsed.values.cors ?? process.env.AIFACTORY_CORS_ORIGIN ?? '*'))
  const dataDir = String(
    parsed.values['data-dir']
      ?? process.env.AIFACTORY_DATA_DIR
      ?? join(cwd, '.data'),
  )
  const tokenValue = parsed.values.token ?? process.env.AIFACTORY_API_TOKEN
  const apiToken = typeof tokenValue === 'string' && tokenValue !== '' ? tokenValue : undefined
  const quiet = parsed.values.quiet === true

  const logFormat = (process.env.AIFACTORY_LOG_FORMAT ?? 'pretty').toLowerCase() === 'json' ? 'json' : 'pretty'
  const configuredLevel = process.env.AIFACTORY_LOG_LEVEL?.toLowerCase()
  const logDirectory = process.env.AIFACTORY_LOG_DIR ?? join(dataDir, 'logs')
  const logSinks: LogSink[] = [new ConsoleSink({ format: logFormat, color: process.stdout.isTTY === true })]
  let fileSink: FileSink | undefined
  if (process.env.AIFACTORY_LOG_FILE !== '0') {
    const retention = Number.parseInt(process.env.AIFACTORY_LOG_RETENTION_DAYS ?? '7', 10)
    fileSink = new FileSink({
      directory: logDirectory,
      retentionDays: Number.isSafeInteger(retention) && retention >= 0 ? retention : 7,
    })
    logSinks.push(fileSink)
  }
  const otlpLogsUrl = process.env.AIFACTORY_OTLP_LOGS_URL?.trim()
  let otlpHeaders: Record<string, string> | undefined
  if (process.env.AIFACTORY_OTLP_LOGS_HEADERS !== undefined && process.env.AIFACTORY_OTLP_LOGS_HEADERS !== '') {
    try {
      const parsed = JSON.parse(process.env.AIFACTORY_OTLP_LOGS_HEADERS) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        otlpHeaders = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      }
    } catch {
      // Invalid headers must not prevent startup; the sink will run without them.
    }
  }
  if (otlpLogsUrl !== undefined && otlpLogsUrl !== '') {
    logSinks.push(new OtlpLogsSink({
      endpoint: otlpLogsUrl,
      serviceName: 'aifactory-api',
      environment: process.env.AIFACTORY_ENV ?? process.env.NODE_ENV ?? 'local',
      ...(otlpHeaders !== undefined ? { headers: otlpHeaders } : {}),
      ...(process.env.AIFACTORY_OTLP_LOGS_TIMEOUT_MS !== undefined
        ? { timeoutMs: Number.parseInt(process.env.AIFACTORY_OTLP_LOGS_TIMEOUT_MS, 10) }
        : {}),
    }))
  }
  const spoolMb = Number.parseInt(process.env.AIFACTORY_LOG_SPOOL_MB ?? '64', 10)
  const environmentLevel: Level = isLevel(configuredLevel) ? configuredLevel as Level : quiet ? 'warn' : 'info'
  let traces: TraceRecorder | undefined
  const logging = createLogging({
    service: 'aifactory-api',
    version: packageJson.version,
    env: process.env.AIFACTORY_ENV ?? process.env.NODE_ENV ?? 'local',
    level: environmentLevel,
    sinks: logSinks,
    traceContext: () => traces?.currentTraceContext(),
    spool: {
      directory: process.env.AIFACTORY_LOG_SPOOL_DIR ?? join(logDirectory, 'spool'),
      maxBytes: (Number.isSafeInteger(spoolMb) && spoolMb > 0 ? spoolMb : 64) * 1024 * 1024,
    },
  })
  const log = logging.logger.child({ component: 'api' })
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    // Observe only: Node's default crash policy still applies.
    logging.emergency({ event: 'process.uncaught', origin, err: error })
  })

  const databaseUrl = process.env.DATABASE_URL
  let projectStore: PostgresProjectStore | undefined
  let settingsStore: PostgresSettingsStore | undefined
  let workspaceStore: PostgresProjectWorkspace | undefined
  let vectorStore: PostgresVectorStore | undefined
  let semanticIndex: SemanticIndexService | undefined
  let observability: ObservabilityProvider | undefined
  let observabilityReader: ObservabilityReader | undefined
  let modelCatalog: PostgresModelCatalog | undefined
  let modelService: ModelService | undefined
  let projects: ProjectService | undefined
  let settings: SettingsService | undefined
  let maxActiveProjects = 0
  if (databaseUrl !== undefined && databaseUrl !== '') {
    projectStore = new PostgresProjectStore(databaseUrl)
    settingsStore = new PostgresSettingsStore(databaseUrl)
    workspaceStore = new PostgresProjectWorkspace(databaseUrl)
    try {
      await projectStore.migrate()
      await settingsStore.migrate()
      await workspaceStore.migrate()
      const recovered = await workspaceStore.recoverStrandedRuns()
      if (recovered > 0) log.warn({ event: 'stage.run.recovered_stranded', count: recovered })
      settings = new SettingsService(settingsStore)
      projects = new ProjectService(projectStore, settings)
      maxActiveProjects = (await settings.get()).maxActiveProjects

      const embeddingUrl = process.env.AIFACTORY_EMBEDDING_URL?.trim()
      const embeddingModel = process.env.AIFACTORY_EMBEDDING_MODEL?.trim()
      const embeddingDimensions = Number.parseInt(process.env.AIFACTORY_EMBEDDING_DIMENSIONS ?? '1024', 10)
      if (embeddingUrl !== undefined && embeddingUrl !== '' && embeddingModel !== undefined && embeddingModel !== '') {
        try {
          const embeddings = new EmbeddingClient({
            baseUrl: embeddingUrl,
            model: embeddingModel,
            dimensions: Number.isSafeInteger(embeddingDimensions) && embeddingDimensions > 0 ? embeddingDimensions : 1024,
            ...(process.env.AIFACTORY_EMBEDDING_API_KEY !== undefined && process.env.AIFACTORY_EMBEDDING_API_KEY !== ''
              ? { apiKey: process.env.AIFACTORY_EMBEDDING_API_KEY }
              : {}),
            ...(process.env.AIFACTORY_EMBEDDING_TIMEOUT_MS !== undefined
              ? { timeoutMs: Number.parseInt(process.env.AIFACTORY_EMBEDDING_TIMEOUT_MS, 10) }
              : {}),
            ...(process.env.AIFACTORY_EMBEDDING_BATCH_SIZE !== undefined
              ? { batchSize: Number.parseInt(process.env.AIFACTORY_EMBEDDING_BATCH_SIZE, 10) }
              : {}),
          })
          vectorStore = new PostgresVectorStore(databaseUrl, Number.isSafeInteger(embeddingDimensions) && embeddingDimensions > 0 ? embeddingDimensions : 1024)
          await vectorStore.migrate()
          semanticIndex = new SemanticIndexService({
            projects,
            workspace: workspaceStore,
            embeddings,
            vectors: vectorStore,
          })
        } catch (error) {
          await vectorStore?.close().catch(() => {})
          vectorStore = undefined
          semanticIndex = undefined
          log.warn({ event: 'retrieval.disabled', err: error }, 'semantic indexing disabled')
        }
      } else if (embeddingUrl !== undefined && embeddingUrl !== '') {
        log.warn({ event: 'retrieval.disabled' }, 'AIFACTORY_EMBEDDING_MODEL is not set; semantic indexing disabled')
      }
    } catch (error) {
      log.fatal({ event: 'app.database_init_failed', err: error }, 'could not initialize PostgreSQL')
      await projectStore.close().catch(() => {})
      await settingsStore.close().catch(() => {})
      await workspaceStore.close().catch(() => {})
      await logging.shutdown({ timeoutMs: 1000 })
      process.exitCode = 1
      return
    }
  } else {
    log.warn({ event: 'app.database_disabled' }, 'DATABASE_URL is not set; project and settings routes are disabled')
  }

  const store = new SessionStore({
    dataDir,
    warn: (message) => log.warn({ event: 'session_store.warning' }, message),
  })
  let modelRuntime: ModelRuntime | undefined
  // Every harness run goes through the runtime, so the global model target
  // applies to stage roles, chat and briefings alike.
  const harnessFactory = (projectCwd?: string, timeoutMs?: number): DshHarness => modelRuntime !== undefined
    ? modelRuntime.harness(projectCwd, timeoutMs)
    : new DshHarness({
        ...harness,
        ...(projectCwd !== undefined ? { cwd: projectCwd } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      })
  const stageRoleTimeoutMs = (() => {
    const value = Number(process.env.AIFACTORY_STAGE_ROLE_TIMEOUT_MS)
    return Number.isSafeInteger(value) && value > 0 ? value : 300_000
  })()
  const pdfReview = projects === undefined
    ? undefined
    : new PdfReviewService({
        projects,
        sessions: store,
        harnessFactory,
        ...(workspaceStore !== undefined ? { workspace: workspaceStore } : {}),
      })
  const briefing = projects === undefined || workspaceStore === undefined
    ? undefined
    : new ProjectBriefingService({ projects, workspace: workspaceStore, harnessFactory })
  if (projects !== undefined) {
    observability = createObservabilityProvider()
    traces = observability.recorder
    observabilityReader = new CachedObservabilityReader(observability.reader, {
      ttlMs: positiveInt(process.env.AIFACTORY_OBSERVABILITY_CACHE_TTL_MS, 15_000),
      deadlineMs: positiveInt(process.env.AIFACTORY_OBSERVABILITY_DEADLINE_MS, 3000),
    })
  }

  const stageRuntime = projects === undefined || workspaceStore === undefined
    ? undefined
    : new PlanningStageRuntime({
        projects,
        workspace: workspaceStore,
        harnessFactory,
        roleTimeoutMs: stageRoleTimeoutMs,
        ...(semanticIndex !== undefined
          ? { indexDocument: (project: Project, document: ProjectDocument) => semanticIndex!.indexDocument(project, document) }
          : {}),
        ...(traces !== undefined ? { traces } : {}),
        logger: logging.logger,
      })

  // Logging control plane: persisted settings, live PostgreSQL sink toggle, admin API.
  const logStore = databaseUrl !== undefined && databaseUrl !== '' && projects !== undefined
    ? new PostgresLogStore(databaseUrl)
    : undefined
  const loggingSettingsStore = databaseUrl !== undefined && databaseUrl !== '' && projects !== undefined
    ? new PostgresLoggingSettingsStore(databaseUrl)
    : undefined
  const loggingManager = new LoggingManager({
    logging,
    environmentLevel,
    ...(loggingSettingsStore !== undefined ? { settingsStore: loggingSettingsStore } : {}),
    ...(logStore !== undefined ? { logStore } : {}),
    ...(loggingSettingsStore !== undefined && databaseUrl !== undefined ? { databaseUrl } : {}),
    ...(fileSink !== undefined ? { fileSink } : {}),
  })
  await loggingManager.init()

  if (databaseUrl !== undefined && databaseUrl !== '' && projects !== undefined) {
    modelCatalog = new PostgresModelCatalog(databaseUrl)
    try {
      await modelCatalog.migrate()
      modelService = new ModelService({
        catalog: modelCatalog,
        store: new PostgresModelSettingsStore(databaseUrl),
        env: process.env,
      })
      modelRuntime = new ModelRuntime({
        service: modelService,
        command: harness.command,
        profile: harness.profile,
        ...(harness.permissionMode !== undefined ? { permissionMode: harness.permissionMode } : {}),
        patchDir: join(dataDir, 'model-patches'),
        logger: logging.logger,
        validate: process.env.AIFACTORY_MODEL_PATCH_VALIDATE !== '0',
      })
      modelService.setTargetChangeHandler(async () => { await modelRuntime?.refresh() })
      const applied = await modelRuntime.refresh()
      log.info({
        event: 'models.runtime_ready',
        applied: applied.applied,
        provider: applied.provider,
        model: applied.model,
        source: applied.source,
        warnings: applied.warnings.length,
      })
    } catch (error) {
      log.warn({ event: 'models.catalog_init_failed', err: error }, 'model catalogue unavailable')
      await modelCatalog.close().catch(() => {})
      modelCatalog = undefined
    }
  }

  const recoveryTimer = workspaceStore === undefined
    ? undefined
    : setInterval(() => {
        void workspaceStore.recoverStrandedRuns().then((recovered) => {
          if (recovered > 0) log.warn({ event: 'stage.run.recovered_stranded', count: recovered })
        }).catch((error: unknown) => {
          log.error({ event: 'stage.run.recovery_failed', err: error })
        })
      }, 60_000)
  recoveryTimer?.unref()

  const server = createChatServer({
    harnessFactory,
    store,
    version: packageJson.version,
    ...(apiToken !== undefined ? { apiToken } : {}),
    corsOrigins: cors,
    includeThinking: parsed.values['show-thinking'] === true,
    ...(projects !== undefined ? { projects } : {}),
    ...(settings !== undefined ? { settings } : {}),
    ...(pdfReview !== undefined ? { pdfReview } : {}),
    ...(workspaceStore !== undefined ? { workspace: workspaceStore } : {}),
    ...(briefing !== undefined ? { briefing } : {}),
    ...(stageRuntime !== undefined ? { stageRuntime } : {}),
    ...(semanticIndex !== undefined ? { semanticIndex } : {}),
    ...(observabilityReader !== undefined ? { observability: observabilityReader } : {}),
    ...(modelService !== undefined ? { models: modelService } : {}),
    ...(modelRuntime !== undefined ? { modelRuntime } : {}),
    ...(traces !== undefined ? { observabilityRecorder: traces } : {}),
    loggingManager,
    ...(logStore !== undefined ? { logStore } : {}),
    harnessInfo: { command: harness.command, profile: harness.profile },
    logger: logging.logger,
  })

  server.on('error', (error) => {
    log.fatal({ event: 'app.server_error', err: error })
    process.exitCode = 1
    void logging.shutdown({ timeoutMs: 1000 })
  })

  server.listen(port, host, () => {
    const address = server.address()
    const boundPort = typeof address === 'object' && address !== null ? address.port : port
    process.stdout.write(`AI Factory chat API\n`)
    process.stdout.write(`  url       http://${host}:${boundPort}\n`)
    process.stdout.write(`  harness   ${harness.command} --profile ${harness.profile}\n`)
    process.stdout.write(`  data      ${dataDir}\n`)
    process.stdout.write(`  database  ${projects === undefined ? 'disabled' : 'postgres'}\n`)
    if (projects !== undefined) process.stdout.write(`  max active ${maxActiveProjects}\n`)
    process.stdout.write(`  pdf review ${pdfReview === undefined ? 'disabled' : 'enabled'}\n`)
    process.stdout.write(`  sdlc       ${workspaceStore === undefined ? 'disabled' : 'enabled'}\n`)
    process.stdout.write(`  briefing   ${briefing === undefined ? 'disabled' : 'enabled'}\n`)
    process.stdout.write(`  stage runs ${stageRuntime === undefined ? 'disabled' : 'enabled'}\n`)
    if (stageRuntime !== undefined) process.stdout.write(`  stage role timeout ${stageRoleTimeoutMs}ms\n`)
    process.stdout.write(`  retrieval  ${semanticIndex === undefined ? 'disabled' : 'pgvector'}\n`)
    process.stdout.write(`  observability ${observability === undefined ? 'disabled' : observability.name}\n`)
    process.stdout.write(`  models     ${modelService === undefined ? 'disabled' : 'catalogue'}\n`)
    process.stdout.write(`  cors      ${cors === '*' ? '*' : cors.join(', ')}\n`)
    process.stdout.write(`  auth      ${apiToken === undefined ? 'none' : 'bearer token required'}\n`)
    if (modelService !== undefined) {
      void modelService.resolveForRun().then((resolved) => {
        log.info({
          event: 'models.target',
          source: resolved.source,
          provider: resolved.target?.provider ?? null,
          model: resolved.target?.model ?? null,
          warnings: resolved.warnings.length,
        })
      }).catch(() => {})
    }
    log.info({
      event: 'app.started',
      url: `http://${host}:${boundPort}`,
      database: projects !== undefined,
      stageRuns: stageRuntime !== undefined,
      retrieval: semanticIndex !== undefined,
      observability: observability?.name ?? null,
      auth: apiToken !== undefined,
      logLevel: logging.levels.snapshot().level,
      logSinks: logging.diagnostics().sinks.map((sink) => sink.name),
    })
    if (!isLoopback(host) && apiToken === undefined) {
      log.warn({ event: 'app.insecure_bind', host }, 'bound to a non-loopback address without AIFACTORY_API_TOKEN')
    }
  })

  const shutdown = (signal: string): void => {
    log.info({ event: 'app.shutting_down', signal })
    server.close(async () => {
      if (recoveryTimer !== undefined) clearInterval(recoveryTimer)
      await projectStore?.close().catch(() => {})
      await settingsStore?.close().catch(() => {})
      await workspaceStore?.close().catch(() => {})
      await vectorStore?.close().catch(() => {})
      await logStore?.close().catch(() => {})
      await loggingSettingsStore?.close().catch(() => {})
      await modelRuntime?.shutdown().catch(() => {})
      await modelService?.close().catch(() => {})
      await observability?.shutdown().catch(() => {})
      await logging.shutdown({ timeoutMs: 2000 })
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 5_000).unref()
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
