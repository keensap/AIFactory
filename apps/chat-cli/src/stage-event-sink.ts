/**
 * Ordered, best-effort event persistence for one stage role.
 *
 * DSH invokes the event callback synchronously while it consumes NDJSON. We
 * queue writes on one promise chain so database insertion order matches the
 * model's event order, without blocking or failing the model turn on a logging
 * error.
 */

import { noopLogger, type Logger } from './logging/index.ts'
import type { LogLevel, StageRunEventInput, PostgresProjectWorkspace } from './workspace.ts'

export interface StageEventSinkOptions {
  workspace: PostgresProjectWorkspace
  projectId: string
  stageRunId: string
  role: string
  logger?: Logger
}

export class StageEventSink {
  private readonly workspace: PostgresProjectWorkspace
  private readonly projectId: string
  private readonly stageRunId: string
  private readonly role: string
  private readonly log: Logger
  private chain: Promise<void> = Promise.resolve()

  constructor(options: StageEventSinkOptions) {
    this.workspace = options.workspace
    this.projectId = options.projectId
    this.stageRunId = options.stageRunId
    this.role = options.role
    this.log = options.logger ?? noopLogger
  }

  append(type: string, payload: unknown, phase?: string | null): Promise<void> {
    const input: StageRunEventInput = {
      projectId: this.projectId,
      stageRunId: this.stageRunId,
      role: this.role,
      agentId: this.role,
      type,
      ...(phase !== undefined && phase !== null ? { phase } : {}),
      level: logLevel(type, payload),
      payload: payload ?? {},
    }
    this.chain = this.chain.then(async () => {
      try {
        await this.workspace.appendStageRunEvent(input)
      } catch (error) {
        this.log.warn({ event: 'stage.event.write_failed', eventType: type, err: error })
      }
    })
    return this.chain
  }

  async flush(): Promise<void> {
    await this.chain
  }
}


export function logLevel(type: string, payload: unknown): LogLevel {
  if (type === 'role_error' || type === 'error') return 'error'
  if (type === 'run_recovered') return 'warn'
  if (type === 'review_decision') {
    const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    return record.decision === 'needs_revision' || record.decision === 'rejected' ? 'warn' : 'info'
  }
  if (type === 'thinking' || type === 'status') return 'debug'
  return 'info'
}
