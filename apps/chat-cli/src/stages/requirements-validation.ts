import {
  BUSINESS_RULE_FIELDS,
  BUSINESS_RULE_TYPES,
  FUNCTIONAL_REQUIREMENT_FIELDS,
  GLOSSARY_FIELDS,
  NFR_DOMAINS,
  REGISTER_FIELDS,
  REGISTER_STATUSES,
  REGISTER_TYPES,
  REQUIRED_SECTIONS,
  SCOPE_BOUNDARIES,
  moscowPriority,
  optionalSubsection,
  type ContractFinding,
  type SubsectionKind,
} from './requirements-contract.ts'

type Row = { line: number; cells: Map<string, string> }
/** `subsection` is set for a table under an optional subsection (glossary, business rules). */
type Table = { line: number; columns: string[]; rows: Row[]; subsection?: SubsectionKind }
type Section = { index: number; line: number; tables: Table[]; prose: string[] }

function plain(text: string): string {
  return text.trim().replace(/^(`+|\*\*|__)(.+)\1$/, '$2').trim()
}

function key(text: string): string {
  return plain(text).replace(/\s+/g, ' ').toLowerCase()
}

// A literal pipe must be escaped in GFM tables, including in code spans.
function cells(line: string): string[] | undefined {
  if (/^(?: {4}|\t)/.test(line)) return undefined
  const text = line.trim()
  const parts: string[] = []
  const leadingPipe = text.startsWith('|')
  let offset = leadingPipe ? 1 : 0
  let slashes = 0
  for (let i = offset; i < text.length; i++) {
    const char = text[i]
    if (char === '|' && slashes % 2 === 0) {
      parts.push(text.slice(offset, i).trim())
      offset = i + 1
    }
    slashes = char === '\\' ? slashes + 1 : 0
  }
  if (offset < text.length) parts.push(text.slice(offset).trim())
  return parts.length >= 2 || (parts.length === 1 && (leadingPipe || offset === text.length)) ? parts : undefined
}

/** Scope tables to actual R3 headings, not examples in fences or comments. */
function parse(markdown: string): Section[] {
  let fence: string | undefined
  let inComment = false
  const lines = markdown.split(/\r?\n/).map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
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

  const sections: Section[] = []
  let section: Section | undefined
  let sectionDepth = 0
  let subsection: SubsectionKind | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const heading = /^ {0,3}(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      const depth = heading[1]!.length
      const title = key(heading[2]!.replace(/\s+#+\s*$/, ''))
      const index = depth === 2 || depth === 3 ? REQUIRED_SECTIONS.findIndex((name) => key(name) === title) : -1
      if (index >= 0) {
        section = { index, line: i + 1, tables: [], prose: [] }
        sectionDepth = depth
        sections.push(section)
        subsection = undefined
      } else if (depth <= sectionDepth) section = undefined
      // A deeper heading stays in its section; it may open an optional subsection.
      else if (section) subsection = optionalSubsection(section.index, title)
      continue
    }
    if (!section) continue

    const columns = cells(line)?.map(key)
    const delimiter = cells(lines[i + 1] ?? '')
    if (!columns || columns.length !== delimiter?.length || !delimiter.every((cell) => /^:?-+:?$/.test(cell))) {
      if (line.trim()) section.prose.push(line)
      continue
    }

    const table: Table = { line: i + 1, columns, rows: [], ...(subsection ? { subsection } : {}) }
    section.tables.push(table)
    for (i += 2; i < lines.length; i++) {
      if (/^ {0,3}#{1,6}\s/.test(lines[i]!)) break
      const values = cells(lines[i]!)
      if (!values) break
      const rowCells = new Map<string, string>()
      for (const [column, name] of columns.entries()) {
        if (!rowCells.has(name)) rowCells.set(name, values[column] ?? '')
      }
      table.rows.push({ line: i + 1, cells: rowCells })
    }
    i--
  }
  return sections
}

const EMPTY = /^(?:[-–—?]+|tbd|todo|<\s*[a-z][^<>]*>)[.!]?$/i
const NON_APPLICABLE = /^(?:none|n\/?a|not applicable)(?:[.!]|\s*[—–:-]\s*.+)?$/i
const NFR_NOT_APPLICABLE = /^not applicable\s*[—–:-]\s*(.+)$/i
const NFR_REASON_PLACEHOLDER = /^(?:unknown|pending)[.!]?$/i
const EMPTY_REGISTER = /^no assumptions,?\s+constraints,?\s*(?:and|or)\s*open questions(?:\s+recorded)?[.!]?$/i
const NFR_ID = /^NFR-\d{3}$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function isoDate(value: string): boolean {
  const match = ISO_DATE.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === value
}

/** Lower-case, whitespace- and hyphen-insensitive enumeration value. */
function choice(value: string | undefined): string {
  return key(value ?? '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
}

function stated(value: string | undefined, allowNone = false): boolean {
  const text = plain(value ?? '')
  return text !== '' && !EMPTY.test(text) && (allowNone || !NON_APPLICABLE.test(text))
}

function emptyRegister(value: string): boolean {
  const text = plain(value.trim().replace(/^(?:[-*+]\s+)/, ''))
  return NON_APPLICABLE.test(text) || EMPTY_REGISTER.test(text)
}

/** Check deterministic contract shape; acceptance links, verification and traceability belong to R4. */
export function inspectRequirementsValidation(markdown: string): ContractFinding[] {
  const findings: ContractFinding[] = []
  const add = (code: string, message: string): void => { findings.push({ code, message }) }
  const sections = parse(markdown)
  const seen = new Set<number>()
  let last = -1
  for (const { index, line } of sections) {
    seen.add(index)
    if (index < last) {
      add('SECTION_OUT_OF_ORDER', `Section "${REQUIRED_SECTIONS[index]}" at line ${line} must appear before "${REQUIRED_SECTIONS[last]}".`)
    }
    last = Math.max(last, index)
  }
  for (const [index, section] of REQUIRED_SECTIONS.entries()) {
    if (!seen.has(index)) add('MISSING_SECTION', `Missing required section "${section}".`)
  }

  const tablesIn = (index: number, subsection?: SubsectionKind): Table[] => sections
    .filter((section) => section.index === index)
    .flatMap((section) => section.tables)
    .filter((table) => table.subsection === subsection)
  const sectionTables = (index: number, required: readonly string[], identifying: readonly string[] = required): Table[] => {
    if (!seen.has(index)) return []
    const name = REQUIRED_SECTIONS[index]
    const matching = tablesIn(index).filter(({ columns }) => identifying.some((column) => columns.includes(column)))
    if (!matching.length) add('MISSING_REQUIRED_TABLE', `Section "${name}" needs a table with columns: ${required.join(', ')}.`)
    checkColumns(matching, name!, required)
    return matching
  }
  const checkColumns = (tables: Table[], name: string, required: readonly string[]): void => {
    for (const { columns, line } of tables) {
      for (const column of required) {
        if (!columns.includes(column)) add('MISSING_TABLE_COLUMN', `Table at line ${line} in "${name}" is missing column "${column}".`)
      }
    }
  }
  const rowsFor = (tables: Table[]): Row[] => tables.flatMap(({ rows }) => rows)
  const checkFields = (row: Row, label: string, fields: readonly string[], allowNone: boolean | readonly string[] = false): void => {
    for (const field of fields) {
      if (row.cells.has(field) && !stated(row.cells.get(field), allowNone === true || (Array.isArray(allowNone) && allowNone.includes(field)))) {
        add('MISSING_REQUIRED_FIELD', `${label} at line ${row.line} must state "${field}".`)
      }
    }
  }
  const checkEntries = (tables: Table[], index: number): void => {
    if (tables.length && !tables.some(({ rows }) => rows.length)) {
      add('MISSING_TABLE_ROWS', `Section "${REQUIRED_SECTIONS[index]}" has a table but no entries.`)
    }
  }

  const scopeTables = sectionTables(0, ['boundary', 'items'])
  const boundaries = new Set<string>()
  for (const row of rowsFor(scopeTables)) {
    const boundary = key(row.cells.get('boundary') ?? '')
    if (!SCOPE_BOUNDARIES.some((name) => key(name) === boundary)) continue
    boundaries.add(boundary)
    checkFields(row, 'Scope entry', ['items'], true)
  }
  if (scopeTables.some(({ columns }) => columns.includes('boundary'))) {
    for (const name of SCOPE_BOUNDARIES) {
      if (!boundaries.has(key(name))) add('MISSING_SCOPE_BOUNDARY', `Missing scope boundary "${name}" in the scope table.`)
    }
  }

  // FR-207: an optional glossary defines each term once, with one meaning.
  const glossaryTables = seen.has(0) ? tablesIn(0, 'glossary') : []
  checkColumns(glossaryTables, 'Glossary', GLOSSARY_FIELDS)
  const glossary = new Map<string, string>()
  for (const row of rowsFor(glossaryTables)) {
    checkFields(row, 'Glossary entry', GLOSSARY_FIELDS, ['source'])
    const term = key(row.cells.get('term') ?? '')
    const definition = key(row.cells.get('definition') ?? '').replace(/[.!]$/, '')
    if (!stated(term) || !stated(definition)) continue
    const earlier = glossary.get(term)
    if (earlier === undefined) glossary.set(term, definition)
    else if (earlier === definition) add('DUPLICATE_GLOSSARY_TERM', `Glossary term "${plain(row.cells.get('term')!)}" at line ${row.line} is defined more than once; define it once.`)
    else add('INCONSISTENT_GLOSSARY_TERM', `Glossary term "${plain(row.cells.get('term')!)}" at line ${row.line} has conflicting definitions; give it one meaning.`)
  }

  const actorFields = ['actor', 'goal', 'permissions']
  const actorTables = sectionTables(1, actorFields)
  checkEntries(actorTables, 1)
  for (const row of rowsFor(actorTables)) checkFields(row, 'Actor', actorFields, ['permissions'])

  const frFields = FUNCTIONAL_REQUIREMENT_FIELDS.filter((field) => field !== 'id')
  for (const row of rowsFor(sectionTables(2, FUNCTIONAL_REQUIREMENT_FIELDS))) {
    checkFields(row, 'Functional requirement', frFields, true)
    const priority = row.cells.get('priority')
    if (priority !== undefined && stated(priority, true) && !moscowPriority(priority)) {
      add('INVALID_PRIORITY', `Functional requirement at line ${row.line} has priority "${plain(priority)}"; use must, should, could or won't.`)
    }
  }

  // FR-206: optional business rules; ids and links are checked by coverage.
  const ruleTables = seen.has(2) ? tablesIn(2, 'business rules') : []
  checkColumns(ruleTables, 'Business rules', BUSINESS_RULE_FIELDS)
  for (const row of rowsFor(ruleTables)) {
    checkFields(row, 'Business rule', BUSINESS_RULE_FIELDS.filter((field) => field !== 'id'))
    const type = row.cells.get('type')
    if (type !== undefined && stated(type) && !(BUSINESS_RULE_TYPES as readonly string[]).includes(choice(type))) {
      add('INVALID_BUSINESS_RULE_TYPE', `Business rule at line ${row.line} has type "${plain(type)}"; use ${BUSINESS_RULE_TYPES.join(', ')}.`)
    }
  }

  const nfrTables = sectionTables(3, ['domain', 'id', 'target'], ['domain', 'id', 'target', 'verification'])
  const domains = new Set<string>()
  for (const row of rowsFor(nfrTables)) {
    const domain = key(row.cells.get('domain') ?? '')
    if (stated(domain)) domains.add(domain)
    checkFields(row, 'Non-functional requirement', ['domain'])
    const id = plain(row.cells.get('id') ?? '')
    const target = plain(row.cells.get('target') ?? '')
    const hasReason = [id, target].some((value) => {
      const reason = plain(NFR_NOT_APPLICABLE.exec(value)?.[1] ?? '')
      return stated(reason) && !NFR_REASON_PLACEHOLDER.test(reason)
    })
    if (!NFR_ID.test(id) && hasReason) continue
    if (NFR_NOT_APPLICABLE.test(target)) {
      add('MISSING_REQUIRED_FIELD', `Non-functional requirement at line ${row.line} must state "target"; a not-applicable domain must replace the requirement, not its target alone.`)
    } else {
      checkFields(row, 'Non-functional requirement', ['target'])
    }
  }
  if (nfrTables.some(({ columns }) => columns.includes('domain'))) {
    for (const { domain } of NFR_DOMAINS) {
      if (!domains.has(domain)) add('MISSING_NFR_DOMAIN', `Missing NFR domain "${domain}" in the NFR table.`)
    }
  }

  const acFields = ['given', 'when', 'then']
  for (const row of rowsFor(sectionTables(4, ['id', 'requirement', ...acFields]))) {
    checkFields(row, 'Acceptance criterion', acFields, ['given'])
  }

  const registerSections = sections.filter(({ index }) => index === 5)
  const registerTables = registerSections.some(({ tables }) => tables.length) || !registerSections.some(({ prose }) => prose.some(emptyRegister))
    ? sectionTables(5, REGISTER_FIELDS)
    : []
  for (const row of rowsFor(registerTables)) {
    const statement = plain(row.cells.get('statement') ?? '')
    // A placeholder row declaring that the register has no entries needs no owner or impact.
    if (emptyRegister(statement) && [...row.cells].every(([column, value]) => column === 'statement' || !stated(value))) continue
    checkFields(row, 'Register entry', REGISTER_FIELDS.filter((field) => field !== 'resolve by'), ['impact if wrong'])
    const type = row.cells.get('type')
    if (type !== undefined && stated(type) && !(REGISTER_TYPES as readonly string[]).includes(choice(type))) {
      add('INVALID_REGISTER_TYPE', `Register entry at line ${row.line} has type "${plain(type)}"; use ${REGISTER_TYPES.join(', ')}.`)
    }
    const status = row.cells.get('status')
    if (status === undefined || !stated(status)) continue
    if (!(REGISTER_STATUSES as readonly string[]).includes(choice(status))) {
      add('INVALID_REGISTER_STATUS', `Register entry at line ${row.line} has status "${plain(status)}"; use ${REGISTER_STATUSES.join(', ')}.`)
      continue
    }
    if (!row.cells.has('resolve by')) continue
    // FR-208: an open entry needs a resolution date; a settled one may say none.
    const resolveBy = plain(row.cells.get('resolve by') ?? '')
    const open = choice(status) === 'open'
    if (!stated(resolveBy, !open)) {
      add('MISSING_RESOLVE_BY', `Register entry at line ${row.line} must state "resolve by"${open ? ' as a YYYY-MM-DD date while it is open' : ' (a YYYY-MM-DD date or "none")'}.`)
    } else if (!isoDate(resolveBy) && (open || !NON_APPLICABLE.test(resolveBy))) {
      add('INVALID_RESOLVE_BY', `Register entry at line ${row.line} has "resolve by" "${resolveBy}"; use a YYYY-MM-DD date${open ? '' : ' or "none"'}.`)
    }
  }
  if (!registerSections.some(({ prose }) => prose.some(emptyRegister))) checkEntries(registerTables, 5)
  return findings
}
