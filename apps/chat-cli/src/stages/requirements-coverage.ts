import { NFR_DOMAINS, REQUIRED_SECTIONS, moscowPriority, optionalSubsection, type Priority } from './requirements-contract.ts'

export type RequirementsCoverageFindingCode =
  | 'NO_FUNCTIONAL_REQUIREMENTS'
  | 'NO_NFR'
  | 'NO_ACCEPTANCE_CRITERIA'
  | 'MISSING_REQUIREMENT_ID'
  | 'MISSING_ACCEPTANCE_ID'
  | 'DUPLICATE_REQUIREMENT_ID'
  | 'DUPLICATE_ACCEPTANCE_ID'
  | 'MISSING_ACCEPTANCE_REQUIREMENT'
  | 'DANGLING_REQUIREMENT_ID'
  | 'DANGLING_ACCEPTANCE_ID'
  | 'MISMATCHED_ACCEPTANCE_REFERENCE'
  | 'UNCOVERED_REQUIREMENT'
  | 'MISSING_NFR_VERIFICATION'
  | 'MISSING_SOURCE'
  | 'MISSING_GOAL'
  | 'MISSING_BUSINESS_RULE_REQUIREMENT'
  | 'UNKNOWN_SOURCE'
  | 'UNCITED_SOURCE'
  | `CONTRACT_${string}`

export interface RequirementsCoverageFinding {
  code: RequirementsCoverageFindingCode
  requirementId?: string
  message: string
  severity: 'blocking' | 'advisory'
}

export interface RequirementsCoverageReport {
  counts: {
    /** Declared FRs and NFRs; business rules are counted separately. */
    totalRequirements: number
    withAcceptanceCriteria: number
    withSource: number
    withGoal: number
    /** MoSCoW tally of declared FRs (FR-210); an FR without a valid priority is not counted. */
    priorities: Record<Priority, number>
    /** Declared `BR-###` business rules (FR-206). */
    businessRules: number
  }
  findings: RequirementsCoverageFinding[]
}

type Section = 'fr' | 'br' | 'nfr' | 'ac' | 'trace'
type Row = { section: Section; cells: Map<string, string>; line: number }

const SECTION_TITLES: ReadonlyArray<readonly [string, Section]> = [
  [REQUIRED_SECTIONS[2], 'fr'],
  [REQUIRED_SECTIONS[3], 'nfr'],
  [REQUIRED_SECTIONS[4], 'ac'],
  [REQUIRED_SECTIONS[6], 'trace'],
]

const FR_ID = /^FR-\d{3}$/
const NFR_ID = /^NFR-\d{3}$/
const AC_ID = /^AC-\d{3}$/
const BR_ID = /^BR-\d{3}$/
const REQUIREMENT_REFS = /(?<![\w-])(?:FR|NFR|BR)-\d{3}(?![\w-])/g
const FR_REFS = /(?<![\w-])FR-\d{3}(?![\w-])/g
const ACCEPTANCE_REFS = /(?<![\w-])AC-\d{3}(?![\w-])/g

function unformat(cell: string): string {
  return cell.trim().replace(/^(`+|\*\*|__)(.+)\1$/, '$2').trim()
}

function hasValue(cell: string): boolean {
  const value = unformat(cell)
  return value !== '' && !/^(?:none|n\/?a|not applicable|tbd|todo|unknown|pending|[-–—?]+|<[^>]+>)[.!]?$/i.test(value)
}

function refs(cell: string, pattern: RegExp): string[] {
  return [...new Set(cell.match(pattern) ?? [])]
}

// In GFM tables a literal pipe is escaped, including inside an inline code span.
function tableCells(line: string): string[] | undefined {
  if (/^(?: {4}|\t)/.test(line)) return undefined
  const text = line.trim()
  const cells: string[] = []
  const hasLeadingPipe = text.startsWith('|')
  let start = hasLeadingPipe ? 1 : 0
  let backslashes = 0
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (char === '|' && backslashes % 2 === 0) {
      cells.push(text.slice(start, i).trim())
      start = i + 1
    }
    backslashes = char === '\\' ? backslashes + 1 : 0
  }
  if (start < text.length) cells.push(text.slice(start).trim())
  return cells.length >= 2 || (cells.length === 1 && (hasLeadingPipe || start === text.length)) ? cells : undefined
}

function* scopedRows(markdown: string): Generator<Row> {
  let section: Section | undefined
  let sectionDepth = 0
  // Rows under the optional "Business rules" subsection of section 3 are rules, not FRs.
  let rules = false
  let fence: string | undefined
  let inComment = false
  const lines = markdown.split(/\r?\n/).map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence !== undefined) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && marker[2]!.trim() === '') fence = undefined
      return ''
    }
    if (!inComment && marker) {
      fence = marker[1]
      return ''
    }
    let visible = ''
    let offset = 0
    while (offset < line.length) {
      const end = line.indexOf(inComment ? '-->' : '<!--', offset)
      if (end < 0) return inComment ? visible : visible + line.slice(offset)
      if (!inComment) visible += line.slice(offset, end)
      offset = end + (inComment ? 3 : 4)
      inComment = !inComment
    }
    return visible
  })

  for (let i = 0; i < lines.length; i++) {
    const heading = /^ {0,3}(#{1,6})\s+(.+)$/.exec(lines[i]!)
    if (heading) {
      const depth = heading[1]!.length
      const title = heading[2]!.replace(/\s+#+\s*$/, '').trim().toLowerCase()
      const match = depth === 2 || depth === 3
        ? SECTION_TITLES.find(([name]) => name.toLowerCase() === title)
        : undefined
      if (match) {
        section = match[1]
        sectionDepth = depth
        rules = false
      } else if (depth <= sectionDepth) {
        section = undefined
      } else if (section === 'fr' || section === 'br') {
        rules = optionalSubsection(2, title) === 'business rules'
        section = rules ? 'br' : 'fr'
      }
      continue
    }
    if (!section) continue

    const header = tableCells(lines[i]!)?.map((cell) => unformat(cell).toLowerCase())
    const delimiter = tableCells(lines[i + 1] ?? '')
    if (!header || header.length !== delimiter?.length || !delimiter.every((cell) => /^:?-+:?$/.test(cell))) continue

    // A new table needs its own header and separator. A pipe-prefixed line by
    // itself, or an ID mentioned in prose or in an unrelated section, is not a row.
    for (i += 2; i < lines.length; i++) {
      if (/^ {0,3}#{1,6}\s/.test(lines[i]!)) break
      const cells = tableCells(lines[i]!)
      if (!cells) break
      yield { section, cells: new Map(header.map((name, column) => [name, cells[column] ?? ''])), line: i + 1 }
    }
    i--
  }
}

/**
 * Check explicit links in the R3 Markdown tables; this is not a semantic review.
 * Missing declarations, broken ID links, missing AC coverage and missing NFR
 * verification block approval. Missing source and goal cells are advisory to
 * support legacy source-only tables and leave the evidence to reviewer judgment.
 * Traceability can name goals or link to them, but does not validate their content.
 */
export function inspectRequirementsCoverage(markdown: string): RequirementsCoverageReport {
  const findings: RequirementsCoverageFinding[] = []
  const reported = new Set<string>()
  const add = (code: RequirementsCoverageFindingCode, message: string, requirementId?: string): void => {
    const key = JSON.stringify([code, requirementId, message])
    if (reported.has(key)) return
    reported.add(key)
    const severity = code === 'MISSING_SOURCE' || code === 'MISSING_GOAL' ? 'advisory' : 'blocking'
    findings.push({ code, ...(requirementId === undefined ? {} : { requirementId }), message, severity })
  }

  const requirements = new Set<string>()
  const businessRules = new Set<string>()
  const ruleTargets = new Map<string, string[]>()
  const priorities: Record<Priority, number> = { must: 0, should: 0, could: 0, wont: 0 }
  const nonApplicable = new Set<string>()
  const forwardLinks = new Map<string, Set<string>>()
  const criteria = new Map<string, Set<string>>()
  const traces: Row[] = []

  for (const row of scopedRows(markdown)) {
    const { section, cells, line } = row
    if (section === 'trace') {
      if (cells.has('requirement')) traces.push(row)
      continue
    }
    if (!cells.has('id')) continue
    const id = unformat(cells.get('id') ?? '')
    if (section === 'ac') {
      if (!AC_ID.test(id)) {
        add('MISSING_ACCEPTANCE_ID', `Acceptance criterion row at line ${line} needs an AC-### id.`)
        continue
      }
      if (criteria.has(id)) add('DUPLICATE_ACCEPTANCE_ID', `${id} is declared more than once.`)
      const links = refs(cells.get('requirement') ?? '', REQUIREMENT_REFS)
      if (links.length === 0) add('MISSING_ACCEPTANCE_REQUIREMENT', `${id} does not name a requirement.`)
      const existing = criteria.get(id) ?? new Set<string>()
      for (const link of links) existing.add(link)
      criteria.set(id, existing)
      continue
    }
    if (section === 'br') {
      if (!BR_ID.test(id)) {
        add('MISSING_REQUIREMENT_ID', `Business rule row at line ${line} needs a BR-### id.`)
        continue
      }
      if (businessRules.has(id)) add('DUPLICATE_REQUIREMENT_ID', `${id} is declared more than once.`, id)
      else ruleTargets.set(id, refs(cells.get('applies to') ?? '', FR_REFS))
      businessRules.add(id)
      const links = forwardLinks.get(id) ?? new Set<string>()
      for (const ac of refs(cells.get('acceptance criteria') ?? '', ACCEPTANCE_REFS)) links.add(ac)
      forwardLinks.set(id, links)
      continue
    }
    if (section === 'nfr' && !NFR_ID.test(id)) {
      // Only an explicit not-applicable domain with a reason can replace an NFR.
      const reason = [id, unformat(cells.get('target') ?? '')]
        .map((cell) => /^not applicable\s*[—–:-]\s*(.+)$/i.exec(cell)?.[1] ?? '')
        .find(hasValue)
      if (reason) {
        nonApplicable.add(unformat(cells.get('domain') ?? '').toLowerCase())
        continue
      }
    }
    if (!(section === 'fr' ? FR_ID : NFR_ID).test(id)) {
      add('MISSING_REQUIREMENT_ID', `Requirement row at line ${line} needs an ${section === 'fr' ? 'FR' : 'NFR'}-### id.`)
      continue
    }
    if (requirements.has(id)) add('DUPLICATE_REQUIREMENT_ID', `${id} is declared more than once.`, id)
    else if (section === 'fr') {
      const priority = moscowPriority(cells.get('priority') ?? '')
      if (priority) priorities[priority] += 1
    }
    requirements.add(id)
    if (section === 'nfr' && !hasValue(cells.get('verification') ?? '')) {
      add('MISSING_NFR_VERIFICATION', `${id} has no verification method.`, id)
    }
    const links = forwardLinks.get(id) ?? new Set<string>()
    for (const ac of refs(cells.get('acceptance criteria') ?? '', ACCEPTANCE_REFS)) links.add(ac)
    forwardLinks.set(id, links)
  }

  if (![...requirements].some((id) => FR_ID.test(id))) {
    add('NO_FUNCTIONAL_REQUIREMENTS', 'No functional requirements are declared.')
  }
  if (![...requirements].some((id) => NFR_ID.test(id)) && !NFR_DOMAINS.every(({ domain }) => nonApplicable.has(domain))) {
    add('NO_NFR', 'No non-functional requirements are declared and not all domains are marked not applicable.')
  }
  if (criteria.size === 0) add('NO_ACCEPTANCE_CRITERIA', 'No acceptance criteria are declared.')

  const covered = new Set<string>()
  const coveredRules = new Set<string>()
  for (const [ac, links] of criteria) {
    for (const id of links) {
      if (requirements.has(id)) covered.add(id)
      else if (businessRules.has(id)) coveredRules.add(id)
      else add('DANGLING_REQUIREMENT_ID', `${ac} references undeclared requirement ${id}.`, id)
    }
  }
  for (const [id, links] of forwardLinks) {
    for (const ac of links) {
      if (!criteria.has(ac)) add('DANGLING_ACCEPTANCE_ID', `${id} references undeclared acceptance criterion ${ac}.`, id)
      else if (!criteria.get(ac)!.has(id)) {
        add('MISMATCHED_ACCEPTANCE_REFERENCE', `${id} references ${ac}, but that criterion does not name ${id}.`, id)
      }
    }
  }

  for (const [id, targets] of ruleTargets) {
    if (targets.length === 0) add('MISSING_BUSINESS_RULE_REQUIREMENT', `${id} does not name the FR it applies to.`, id)
    for (const fr of targets) {
      if (!requirements.has(fr)) add('DANGLING_REQUIREMENT_ID', `${id} applies to undeclared requirement ${fr}.`, fr)
    }
  }

  const sourced = new Set<string>()
  const linkedToGoal = new Set<string>()
  for (const { cells } of traces) {
    for (const id of refs(cells.get('requirement') ?? '', REQUIREMENT_REFS)) {
      // A business rule may be traced, but needs no source or goal of its own.
      if (businessRules.has(id)) continue
      if (!requirements.has(id)) add('DANGLING_REQUIREMENT_ID', `Traceability references undeclared requirement ${id}.`, id)
      else {
        if (hasValue(cells.get('source') ?? '')) sourced.add(id)
        if (hasValue(cells.get('goal') ?? '')) linkedToGoal.add(id)
      }
    }
  }
  for (const id of requirements) {
    if (!covered.has(id)) add('UNCOVERED_REQUIREMENT', `${id} has no acceptance criterion that names it.`, id)
    if (!sourced.has(id)) add('MISSING_SOURCE', `${id} has no traceability source.`, id)
    if (!linkedToGoal.has(id)) add('MISSING_GOAL', `${id} has no traceability goal.`, id)
  }
  for (const id of businessRules) {
    if (!coveredRules.has(id)) add('UNCOVERED_REQUIREMENT', `${id} has no acceptance criterion that names it.`, id)
  }
  return {
    counts: {
      totalRequirements: requirements.size,
      withAcceptanceCriteria: covered.size,
      withSource: sourced.size,
      withGoal: linkedToGoal.size,
      priorities,
      businessRules: businessRules.size,
    },
    findings,
  }
}
