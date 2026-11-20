export interface RevisionFinding {
  readonly id: string
  readonly severity: string
  readonly section: string
  readonly problem: string
  readonly change: string
  /** Keep the original review payload for byte-compatible legacy prompts. */
  readonly legacyPayload: unknown
}

/** Translate permissive legacy review data only at the revision-role boundary. */
export function normalizeRevisionFindings(payload: readonly unknown[]): RevisionFinding[] {
  return payload.map((legacyPayload, index) => {
    const record = legacyPayload !== null && typeof legacyPayload === 'object' ? legacyPayload as Record<string, unknown> : {}
    return {
      id: revisionFeedbackId(index),
      severity: String(record.severity ?? 'major'),
      section: String(record.section ?? 'unspecified'),
      problem: String(record.finding ?? record.message ?? JSON.stringify(legacyPayload)),
      change: String(record.required_change ?? record.requiredChange ?? 'address it'),
      legacyPayload,
    }
  })
}

function revisionFeedbackId(index: number): string {
  return `R-${index + 1}`
}

/** A model's disposition is a claim, not evidence that the defect was fixed. */
export function inspectRevision(raw: string, previous: string, feedback: { readonly length: number }, maxGrowthRatio = 1.25) {
  const envelope = raw.trimStart().match(/^<revision-plan>\s*([\s\S]*?)\s*<\/revision-plan>\s*/)
  const document = envelope ? raw.trimStart().slice(envelope[0].length) : raw
  const expected = new Set(Array.from({ length: feedback.length }, (_, index) => revisionFeedbackId(index)))
  const dispositions = new Map<string, { id: string; status: 'addressed' | 'unaddressed'; note: string }>()
  let valid = envelope !== null
  if (envelope) {
    try {
      const input: unknown = JSON.parse(envelope[1]!)
      if (!Array.isArray(input)) throw new Error('Expected an array')
      for (const row of input) {
        if (!row || !expected.has(row.id) || dispositions.has(row.id) ||
            (row.status !== 'addressed' && row.status !== 'unaddressed') ||
            typeof row.note !== 'string' || !row.note.trim()) { valid = false; continue }
        dispositions.set(row.id, { id: row.id, status: row.status, note: row.note.trim().slice(0, 500) })
      }
    } catch { valid = false }
  }
  return { document, report: {
    planValid: valid && expected.size === dispositions.size,
    missing: [...expected].filter((id) => !dispositions.has(id)),
    dispositions: [...dispositions.values()],
    previousChars: previous.length,
    revisedChars: document.trim().length,
    grewOverBudget: previous.length > 0 && document.trim().length > previous.length * maxGrowthRatio,
  } }
}
