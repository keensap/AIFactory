/**
 * Map stage API failures to the states in the stage UI spec. Messages are
 * short and safe: no stack traces, prompts or tokens.
 */

import { ApiError } from '../api/client.ts'

export type StageErrorKind =
  | 'offline'
  | 'unauthorized'
  | 'not-found'
  | 'running'
  | 'terminal'
  | 'awaiting-human'
  | 'gate-stale'
  | 'cycle-limit'
  | 'root-unavailable'
  | 'checklist-incomplete'
  | 'invalid-transition'
  | 'not-implemented'
  | 'harness'
  | 'disabled'
  | 'other'

export interface StageErrorView {
  kind: StageErrorKind
  title: string
  message: string
  /** A plain retry of the same request makes sense. */
  retryable: boolean
}

const MAX_MESSAGE = 400

function safe(message: string): string {
  const firstLines = message.split('\n').filter((line) => !/^\s+at\s/.test(line)).join('\n').trim()
  return firstLines.length > MAX_MESSAGE ? `${firstLines.slice(0, MAX_MESSAGE - 1)}…` : firstLines
}

const ROLE_TITLE: Record<string, string> = { analyzer: 'Analyzer', author: 'TELOS author', reviewer: 'Reviewer' }

export function describeStageError(error: unknown, stage?: string): StageErrorView {
  if (!(error instanceof ApiError)) {
    return { kind: 'other', title: 'Something went wrong', message: safe(error instanceof Error ? error.message : String(error)), retryable: true }
  }
  const message = safe(error.message)
  switch (error.code) {
    case 'STAGE_RUN_RUNNING':
      return { kind: 'running', title: 'This run is already executing', message: 'Progress below keeps updating.', retryable: false }
    case 'STAGE_RUN_TERMINAL':
      return { kind: 'terminal', title: 'This run has finished', message: 'A finished run can’t be executed again. Start a new attempt instead.', retryable: false }
    case 'STAGE_RUN_AWAITING_HUMAN':
    case 'STAGE_RUN_NOT_AWAITING_HUMAN':
      return { kind: 'awaiting-human', title: 'The run changed state', message, retryable: false }
    case 'STAGE_RUN_NOT_AT_REVIEW_GATE':
    case 'STAGE_RUN_NOT_AWAITING_DECISION':
      return { kind: 'gate-stale', title: 'The gate changed', message: 'This question was already answered or has moved on. Showing the latest state.', retryable: false }
    case 'INVALID_HUMAN_DECISION':
      return { kind: 'other', title: 'Choose a decision', message: message || 'Choose one of the decisions offered at this gate.', retryable: false }
    case 'REQUIREMENTS_COVERAGE_BLOCKED':
      return { kind: 'other', title: 'Approval blocked by coverage findings', message: 'Refine the draft, or use the audited waiver when blocking findings are shown.', retryable: false }
    case 'INVALID_COVERAGE_WAIVER':
      return { kind: 'other', title: 'Coverage waiver not accepted', message: 'Enter a nonblank reason of at most 2,000 characters and confirm approval with a waiver.', retryable: false }
    case 'INVALID_GATE_ACTION':
      return { kind: 'other', title: 'That answer wasn’t accepted', message: 'Refresh the run and try again.', retryable: false }
    case 'REVIEW_CYCLE_LIMIT':
      return { kind: 'cycle-limit', title: 'Cycle limit reached', message, retryable: false }
    case 'PROJECT_ROOT_UNAVAILABLE':
      return { kind: 'root-unavailable', title: 'Project directory is unavailable', message, retryable: false }
    case 'STAGE_CHECKLIST_INCOMPLETE':
      return { kind: 'checklist-incomplete', title: 'Checklist incomplete', message, retryable: false }
    case 'INVALID_STAGE_TRANSITION':
      return { kind: 'invalid-transition', title: 'That stage change isn’t allowed', message, retryable: false }
    case 'STAGE_RUNTIME_NOT_IMPLEMENTED':
      return { kind: 'not-implemented', title: 'Runtime not implemented yet', message: 'This stage can’t be executed yet.', retryable: false }
    case 'STAGE_ROLE_FAILED': {
      const match = /^(analyzer|author|reviewer) failed:\s*([\s\S]*)$/i.exec(message)
      const key = match?.[1]?.toLowerCase()
      const role = key === 'author' && stage === 'requirements' ? 'Requirements author' : key === undefined ? null : ROLE_TITLE[key]
      return {
        kind: 'harness',
        title: role === undefined || role === null ? 'The model run failed' : `${role} failed`,
        message: match === null ? message : match[2]!.trim() || message,
        retryable: false,
      }
    }
    case 'STAGE_RUNTIME_DISABLED':
    case 'WORKSPACE_NOT_CONFIGURED':
    case 'DATABASE_NOT_CONFIGURED':
      return { kind: 'disabled', title: 'Stage runtime is disabled on this server', message, retryable: false }
    default:
      break
  }
  if (error.status === 0) {
    return { kind: 'offline', title: 'API unavailable', message, retryable: true }
  }
  if (error.status === 401) {
    return { kind: 'unauthorized', title: 'Session expired or token missing', message: 'Add a valid bearer token in Settings, then retry.', retryable: false }
  }
  if (error.status === 403 || error.status === 404) {
    return { kind: 'not-found', title: 'Project or run not found', message, retryable: false }
  }
  if (error.status === 501) {
    return { kind: 'not-implemented', title: 'Runtime not implemented yet', message, retryable: false }
  }
  if (error.status === 502) {
    return { kind: 'harness', title: 'The model run failed', message, retryable: false }
  }
  if (error.status === 503) {
    return { kind: 'disabled', title: 'Stage runtime is disabled on this server', message, retryable: true }
  }
  return { kind: 'other', title: 'Request failed', message, retryable: error.status >= 500 }
}
