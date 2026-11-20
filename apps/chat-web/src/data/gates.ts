/**
 * Pure helpers for final gates and stage review settings.
 * The API decides what a paused run is asking (`pendingGate.kind`); these
 * helpers only coerce, order and label what it sent.
 */

import type { Finding, GateOutcome, PendingGate, PlanningStageSettings, RequirementsCoverageFinding, RequirementsCoverageReport, RequirementsDecisionInput, ResolvedStageSettings, StageRun } from '../api/types.ts'

export const MIN_REVIEW_CYCLES = 1
export const MAX_REVIEW_CYCLES = 10

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Coerce an untrusted `pendingGate`; null for anything that isn't a known gate kind. */
export function normalizeGate(raw: unknown): PendingGate | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const kind = record.kind
  if (kind !== 'final') return null
  const findings = Array.isArray(record.findings)
    ? record.findings.filter((entry): entry is Finding => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    : []
  return {
    kind,
    question: text(record.question) ?? '',
    cycle: int(record.cycle),
    maxReviewCycles: int(record.maxReviewCycles),
    reviewDecision: text(record.reviewDecision),
    findings,
    waitingSince: text(record.waitingSince),
    outcome: normalizeOutcome(record),
    coverage: normalizeRequirementsCoverage(record.coverage),
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Missing or malformed reports are not equivalent to a report with zero blockers. */
export function normalizeRequirementsCoverage(raw: unknown): RequirementsCoverageReport | null {
  const report = object(raw)
  const counts = object(report?.counts)
  const totalRequirements = int(counts?.totalRequirements)
  const withAcceptanceCriteria = int(counts?.withAcceptanceCriteria)
  const withSource = int(counts?.withSource)
  const withGoal = int(counts?.withGoal)
  if (!Array.isArray(report?.findings) || totalRequirements === null || withAcceptanceCriteria === null
      || withSource === null || withGoal === null || Math.max(withAcceptanceCriteria, withSource, withGoal) > totalRequirements) return null
  const findings: RequirementsCoverageFinding[] = []
  for (const rawFinding of report.findings) {
    const finding = object(rawFinding)
    const code = text(finding?.code)?.trim()
    const message = text(finding?.message)?.trim()
    const severity = finding?.severity
    if (!code || !message || (severity !== 'blocking' && severity !== 'advisory')) return null
    const requirementId = text(finding?.requirementId)?.trim()
    findings.push({ code, message, severity, ...(requirementId ? { requirementId } : {}) })
  }
  // Optional, newer fields: ignored unless every part is a valid count.
  const tally = object(counts?.priorities)
  const priorities = tally === null ? null : { must: int(tally.must), should: int(tally.should), could: int(tally.could), wont: int(tally.wont) }
  const businessRules = int(counts?.businessRules)
  return {
    counts: {
      totalRequirements, withAcceptanceCriteria, withSource, withGoal,
      ...(priorities !== null && Object.values(priorities).every((value) => value !== null)
        ? { priorities: priorities as { must: number; should: number; could: number; wont: number } }
        : {}),
      ...(businessRules === null ? {} : { businessRules }),
    },
    findings,
  }
}

export const MAX_COVERAGE_WAIVER_CHARS = 2000

export function parseCoverageWaiver(value: string): string | null {
  const reason = value.trim()
  return reason.length > 0 && reason.length <= MAX_COVERAGE_WAIVER_CHARS ? reason : null
}

/** Null means the requested approval must not be submitted. A note never doubles as a waiver. */
export function requirementsDecisionInput(
  action: 'approve' | 'reject' | 'waive',
  coverage: RequirementsCoverageReport | null,
  note: string,
  waiverReason = '',
): RequirementsDecisionInput | null {
  const trimmed = note.trim()
  const optionalNote = trimmed === '' ? {} : { note: trimmed }
  if (action === 'reject') return { decision: 'rejected', ...optionalNote }
  const blocked = coverage?.findings.some((finding) => finding.severity === 'blocking') ?? false
  if (action === 'approve') return blocked ? null : { decision: 'approved', ...optionalNote }
  const reason = parseCoverageWaiver(waiverReason)
  if (!blocked || reason === null) return null
  return { decision: 'approved', ...optionalNote, coverageWaiverReason: reason }
}

/** Live rejections are stored in the run summary (and audited in the event log), not on pendingGate. */
export function requirementsRejectionRecorded(run: Pick<StageRun, 'stage' | 'status' | 'summaryMarkdown'>): boolean {
  return run.stage === 'requirements' && run.status === 'awaiting_human'
    && /^## Human decision\r?\n\s*Decision: \*\*(?:rejected|no-go)\*\* — the stage was not completed\.$/m.test(run.summaryMarkdown ?? '')
}

function normalizeOutcome(record: Record<string, unknown>): GateOutcome | null {
  const counts = typeof record.counts === 'object' && record.counts !== null ? (record.counts as Record<string, unknown>) : null
  const criteria = typeof record.criteria === 'object' && record.criteria !== null ? (record.criteria as Record<string, unknown>) : null
  if (typeof record.accepted !== 'boolean' && counts === null && criteria === null) return null
  const blockers = int(counts?.blockers)
  const major = int(counts?.major)
  const minor = int(counts?.minor)
  const minRating = int(criteria?.minRating)
  const maxBlockers = int(criteria?.maxBlockers)
  const maxMajor = int(criteria?.maxMajor)
  return {
    accepted: record.accepted === true,
    rating: typeof record.rating === 'number' && Number.isFinite(record.rating) ? record.rating : null,
    counts: blockers !== null && major !== null ? { blockers, major, minor: minor ?? 0 } : null,
    criteria: minRating !== null && maxBlockers !== null && maxMajor !== null ? { minRating, maxBlockers, maxMajor } : null,
  }
}

/** The gate a run is paused at: only while `awaiting_human`, never guessed from status alone. */
export function gateOf(run: Pick<StageRun, 'status' | 'pendingGate'>): PendingGate | null {
  return run.status === 'awaiting_human' ? normalizeGate(run.pendingGate) : null
}

const SEVERITY_ORDER: Record<string, number> = { blocker: 0, major: 1, minor: 2 }

/** Blockers first, then major, minor, anything else; stable within a severity. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const rank = (finding: Finding): number =>
    typeof finding.severity === 'string' ? (SEVERITY_ORDER[finding.severity.toLowerCase()] ?? 3) : 3
  return findings.map((finding, index) => ({ finding, index }))
    .sort((a, b) => rank(a.finding) - rank(b.finding) || a.index - b.index)
    .map((entry) => entry.finding)
}

/** "cycle 1 of 3" (cycle shown 1-based when a review cycle is in progress); '' when unknown. */
export function cycleLabel(gate: Pick<PendingGate, 'cycle' | 'maxReviewCycles'>): string {
  if (gate.cycle === null || gate.maxReviewCycles === null) return ''
  return `cycle ${gate.cycle} of ${gate.maxReviewCycles}`
}

/** 409s that mean the panel on screen is out of date: refresh the run, don't toast. */
export const STALE_GATE_CODES: ReadonlySet<string> = new Set(['STAGE_RUN_NOT_AWAITING_DECISION'])

/** Parse the cycles input; returns the integer or an error message for the field. */
export function parseReviewCycles(value: string): { value: number } | { error: string } {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return { error: `Enter a whole number from ${MIN_REVIEW_CYCLES} to ${MAX_REVIEW_CYCLES}.` }
  const number = Number(trimmed)
  if (number < MIN_REVIEW_CYCLES || number > MAX_REVIEW_CYCLES) {
    return { error: `Review cycles must be between ${MIN_REVIEW_CYCLES} and ${MAX_REVIEW_CYCLES}.` }
  }
  return { value: number }
}

export const DEFAULT_STAGE_SETTINGS: PlanningStageSettings = {
  maxReviewCycles: 4,
  minRating: 94,
  maxBlockers: 0,
  maxMajor: 0,
}

export type SettingField = 'maxReviewCycles' | 'minRating' | 'maxBlockers' | 'maxMajor' | 'maxFindings'

/** Inclusive limits, matching the API's validation. */
export const SETTING_LIMITS: Record<SettingField, { min: number; max: number; label: string }> = {
  maxReviewCycles: { min: MIN_REVIEW_CYCLES, max: MAX_REVIEW_CYCLES, label: 'Review cycles' },
  minRating: { min: 0, max: 100, label: 'Rating threshold' },
  maxBlockers: { min: 0, max: 20, label: 'Blockers allowed' },
  maxMajor: { min: 0, max: 50, label: 'Major issues allowed' },
  maxFindings: { min: 1, max: 12, label: 'Maximum review findings' },
}

/** Whole number within the field's limits, else a message for the field. */
export function parseSettingField(field: SettingField, value: string): { value: number } | { error: string } {
  const { min, max, label } = SETTING_LIMITS[field]
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return { error: `${label}: enter a whole number from ${min} to ${max}.` }
  const number = Number(trimmed)
  if (number < min || number > max) return { error: `${label} must be between ${min} and ${max}.` }
  return { value: number }
}

/** Maps API validation codes to the field they belong to. */
export const SETTING_ERROR_FIELDS: Record<string, SettingField> = {
  INVALID_REVIEW_CYCLES: 'maxReviewCycles',
  INVALID_MIN_RATING: 'minRating',
  INVALID_MAX_BLOCKERS: 'maxBlockers',
  INVALID_MAX_MAJOR: 'maxMajor',
}

export function normalizeStageSettings(raw: unknown): ResolvedStageSettings {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const pick = (field: SettingField, fallback: number): number => {
    const value = int(record[field])
    const { min, max } = SETTING_LIMITS[field]
    return value !== null && value >= min && value <= max ? value : fallback
  }
  const params = record.processParams as { review?: { maxFindings?: unknown } } | null | undefined
  const cap = int(params?.review?.maxFindings)
  const { min, max } = SETTING_LIMITS.maxFindings
  return {
    ...(cap !== null && cap >= min && cap <= max ? { processParams: { review: { maxFindings: cap } } } : {}),
    maxReviewCycles: pick('maxReviewCycles', DEFAULT_STAGE_SETTINGS.maxReviewCycles),
    minRating: pick('minRating', DEFAULT_STAGE_SETTINGS.minRating),
    maxBlockers: pick('maxBlockers', DEFAULT_STAGE_SETTINGS.maxBlockers),
    maxMajor: pick('maxMajor', DEFAULT_STAGE_SETTINGS.maxMajor),
    source: record.source === 'project' || record.source === 'factory' || record.source === 'defaults' ? record.source : null,
  }
}

export function sameSettings(a: PlanningStageSettings, b: PlanningStageSettings): boolean {
  return a.maxReviewCycles === b.maxReviewCycles
    && a.minRating === b.minRating
    && a.maxBlockers === b.maxBlockers
    && a.maxMajor === b.maxMajor
    && a.processParams?.review?.maxFindings === b.processParams?.review?.maxFindings
}

/** PATCH only fields the user changed; in particular, never pin an inherited cap by accident. */
export function reviewSettingsPatch(saved: PlanningStageSettings, draft: PlanningStageSettings): Partial<PlanningStageSettings> {
  const patch: Partial<PlanningStageSettings> = {}
  for (const field of ['maxReviewCycles', 'minRating', 'maxBlockers', 'maxMajor'] as const) {
    if (draft[field] !== saved[field]) patch[field] = draft[field]
  }
  const cap = draft.processParams?.review?.maxFindings
  if (cap !== undefined && cap !== saved.processParams?.review?.maxFindings) {
    patch.processParams = { review: { maxFindings: cap } }
  }
  return patch
}
