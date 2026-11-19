/**
 * The one deterministic check of a requirements specification.
 *
 * Coverage (ids, links, verification, sources, goals) and contract shape
 * (sections, tables, fields, NFR domains, scope, register, priorities, business
 * rules, glossary) are separate modules; this is the combination the runtime
 * gates on and the tests assert. Shape findings are prefixed `CONTRACT_` and are
 * always blocking.
 *
 * When the run recorded a source register (FR-201), citations of `SRC-###` ids
 * are checked against it. Those findings are advisory: a citation can be wrong
 * without the specification being structurally incomplete.
 */

import type { SourceRecord } from '../stage-evidence.ts'
import { inspectRequirementsCoverage, type RequirementsCoverageFinding, type RequirementsCoverageReport } from './requirements-coverage.ts'
import { inspectRequirementsValidation } from './requirements-validation.ts'

const SOURCE_ID = /(?<![\w-])SRC-\d{3}(?![\w-])/g

export function inspectRequirementsDocument(
  markdown: string,
  options: { sources?: readonly SourceRecord[] } = {},
): RequirementsCoverageReport {
  const coverage = inspectRequirementsCoverage(markdown)
  return {
    ...coverage,
    findings: [
      ...coverage.findings,
      ...inspectRequirementsValidation(markdown).map(({ code, message }) => ({
        code: `CONTRACT_${code}` as const,
        message,
        severity: 'blocking' as const,
      })),
      ...(options.sources === undefined ? [] : sourceFindings(markdown, options.sources)),
    ],
  }
}

/** Advisory: cited ids must exist in the register; listed sources should be cited. */
function sourceFindings(markdown: string, sources: readonly SourceRecord[]): RequirementsCoverageFinding[] {
  const known = new Set(sources.map((source) => source.id))
  const cited = new Set(markdown.match(SOURCE_ID) ?? [])
  const findings: RequirementsCoverageFinding[] = []
  for (const id of [...cited].sort()) {
    if (!known.has(id)) {
      findings.push({ code: 'UNKNOWN_SOURCE', message: `${id} is cited but is not in this run's source register.`, severity: 'advisory' })
    }
  }
  for (const source of sources) {
    if (!cited.has(source.id)) {
      findings.push({ code: 'UNCITED_SOURCE', message: `${source.id} (${source.kind}: ${source.title}) is never cited; check whether its content is covered.`, severity: 'advisory' })
    }
  }
  return findings
}

/** True when nothing blocks approval (advisory findings may remain). */
export function requirementsDocumentPasses(report: RequirementsCoverageReport): boolean {
  return !report.findings.some((finding) => finding.severity === 'blocking')
}
