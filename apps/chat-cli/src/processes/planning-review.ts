import type { StageReviewResult } from '../stage-runtime.ts'

export class PlanningReviewFormatError extends Error {}

export function parsePlanningReview(raw: string): StageReviewResult {
  const text = raw.trim()
  const json = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? text
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new PlanningReviewFormatError('Expected one JSON review object') }
  if (!record(value)) throw new PlanningReviewFormatError('Expected a review object')
  const { decision, rating, findings } = value
  if (decision !== 'approved' && decision !== 'needs_revision' && decision !== 'rejected') {
    throw new PlanningReviewFormatError('Invalid review decision')
  }
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 0 || rating > 100) {
    throw new PlanningReviewFormatError('Rating must be an integer from 0 to 100')
  }
  if (!Array.isArray(findings)) throw new PlanningReviewFormatError('Findings must be an array')
  const ids = new Set<string>()
  for (const [i, row] of findings.entries()) {
    if (!record(row) || (row.severity !== 'blocker' && row.severity !== 'major' && row.severity !== 'minor') ||
        !['id', 'section', 'finding', 'required_change'].every((key) => typeof row[key] === 'string' && row[key].trim())) {
      throw new PlanningReviewFormatError(`Invalid finding at index ${i}`)
    }
    const id = (row.id as string).trim()
    if (ids.has(id)) throw new PlanningReviewFormatError(`Duplicate finding ID at index ${i}`)
    ids.add(id)
  }
  return { decision, rating, findings }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
