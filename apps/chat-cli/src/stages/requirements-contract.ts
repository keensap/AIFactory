/**
 * The requirements specification contract.
 *
 * One source of truth for what a requirements document must contain: the author
 * prompt renders it, the reviewer rubric checks it, and `inspectRequirementsDocument`
 * (requirements-checks.ts) verifies the machine-checkable parts without a model. Keeping it here means a
 * prompt change and its review criteria cannot drift apart (R3).
 *
 * Everything exported is data or a pure function, so the contract is testable
 * and reusable by the coverage report (R4).
 */

/** Sections every requirements specification must contain, in order. */
export const REQUIRED_SECTIONS = [
  '1. Purpose and scope',
  '2. Actors and permissions',
  '3. Functional requirements',
  '4. Non-functional requirements',
  '5. Acceptance criteria',
  '6. Assumptions, constraints and open questions',
  '7. Traceability',
] as const

/** Fields every functional requirement must state. */
export const FUNCTIONAL_REQUIREMENT_FIELDS = [
  'id',
  'actor',
  'trigger',
  'behaviour',
  'inputs',
  'outputs',
  'error cases',
  'priority',
  'acceptance criteria',
] as const

/**
 * NFR domains and the verification method each needs. The catalogue is fixed:
 * a domain may be marked "not applicable" with a reason, but it cannot be
 * silently omitted.
 */
export const NFR_DOMAINS = [
  { domain: 'performance', verification: 'measured target (e.g. p95 latency, throughput)' },
  { domain: 'scalability', verification: 'load/target capacity' },
  { domain: 'availability', verification: 'uptime target and recovery objective' },
  { domain: 'security', verification: 'control plus its test or audit' },
  { domain: 'privacy', verification: 'data handling rule plus its check' },
  { domain: 'accessibility', verification: 'standard level (e.g. WCAG 2.2 AA) plus audit' },
  { domain: 'localisation', verification: 'locale/format coverage plus check' },
  { domain: 'observability', verification: 'signal retained plus its alert or review' },
  { domain: 'maintainability', verification: 'structural limit plus measurement' },
  { domain: 'portability', verification: 'supported environment plus test' },
  { domain: 'compliance', verification: 'obligation plus evidence' },
] as const

/** Scope must be stated three ways, not as prose. */
export const SCOPE_BOUNDARIES = ['In scope', 'Out of scope', 'Deferred'] as const

/** The register of unknowns (FR-208): its columns, in order. Every column is required. */
export const REGISTER_FIELDS = ['id', 'type', 'statement', 'owner', 'impact if wrong', 'resolve by', 'status'] as const

/** What a register entry is. */
export const REGISTER_TYPES = ['assumption', 'constraint', 'dependency', 'question'] as const

/** Where a register entry stands; an `open` entry needs a `resolve by` date. */
export const REGISTER_STATUSES = ['open', 'confirmed', 'closed'] as const

/** MoSCoW priorities (FR-210). `won't` is also accepted as `wont` or `won’t`, in any case. */
export const PRIORITIES = ['must', 'should', 'could', "won't"] as const

export type Priority = 'must' | 'should' | 'could' | 'wont'

/** The MoSCoW priority a cell states, or undefined when it states none. */
export function moscowPriority(cell: string): Priority | undefined {
  const value = cell.trim().replace(/^(`+|\*\*|__)(.+)\1$/, '$2').trim().toLowerCase().replace(/[’']/g, '')
  return value === 'must' || value === 'should' || value === 'could' || value === 'wont' ? value : undefined
}

/**
 * Optional business-rule table (FR-206), a `### Business rules` subsection of
 * section 3. Rules are tested directly: each names the FRs it constrains and the
 * acceptance criteria that prove it.
 */
export const BUSINESS_RULE_FIELDS = ['id', 'type', 'rule', 'applies to', 'acceptance criteria'] as const
export const BUSINESS_RULE_TYPES = ['decision table', 'formula', 'state transition', 'validation', 'policy'] as const

/** Optional glossary table (FR-207), a `### Glossary` subsection of section 1. */
export const GLOSSARY_FIELDS = ['term', 'definition', 'source'] as const

/** The optional subsections, by the required section (index) that contains them. */
export const OPTIONAL_SUBSECTIONS = [
  { kind: 'glossary', title: 'Glossary', section: 0 },
  { kind: 'business rules', title: 'Business rules', section: 2 },
] as const

export type SubsectionKind = (typeof OPTIONAL_SUBSECTIONS)[number]['kind']

/**
 * The optional subsection a heading opens inside required section `section`,
 * e.g. "Business rules" or "3.1 Business rules" in section 3. Other headings
 * nested in a section are ordinary subsections and change nothing.
 */
export function optionalSubsection(section: number, heading: string): SubsectionKind | undefined {
  const title = heading.trim().replace(/^(`+|\*\*|__)(.+)\1$/, '$2').replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/^\d+(?:\.\d+)*\.?\s+/, '')
  return OPTIONAL_SUBSECTIONS.find((entry) => entry.section === section && (title === entry.kind || title.startsWith(`${entry.kind} `)))?.kind
}

/** A complete skeleton the author fills in; also the shape tests assert. */
export function renderContractTemplate(projectName: string): string {
  const nfrRows = NFR_DOMAINS
    .map(({ domain, verification }) => `| ${domain} | \`NFR-xxx\` | <measurable target> | ${verification} |`)
    .join('\n')
  const scopeRows = SCOPE_BOUNDARIES.map((boundary) => `| ${boundary} | <items or "none"> |`).join('\n')
  return `# Requirements Specification — ${projectName}

## 1. Purpose and scope

<one paragraph: the problem and the outcome>

| Boundary | Items |
|---|---|
${scopeRows}

### Glossary

Omit this subsection if the evidence introduces no domain terms. Define each term once and use it with that one meaning.

| term | definition | source |
|---|---|---|
| <domain term> | <the one meaning used throughout> | <source, or "none"> |

## 2. Actors and permissions

| Actor | Goal | Permissions |
|---|---|---|
| <actor> | <what they need> | <what they may do> |

## 3. Functional requirements

One table row per requirement. Every row states every field; write "none" rather than leaving a cell empty.

| id | actor | trigger | behaviour | inputs | outputs | error cases | priority | acceptance criteria |
|---|---|---|---|---|---|---|---|---|
| \`FR-001\` | <actor> | <what starts it> | <single testable behaviour> | <input data> | <observable result> | <failure behaviour> | must/should/could/won't | \`AC-001\` |

### Business rules

Omit this subsection if the evidence contains no business rules. One row per rule, stated so it can be tested directly.

| id | type | rule | applies to | acceptance criteria |
|---|---|---|---|---|
| \`BR-001\` | ${BUSINESS_RULE_TYPES.join('/')} | <the rule, decision table, formula or transition> | \`FR-001\` | \`AC-002\` |

## 4. Non-functional requirements

| domain | id | target | verification |
|---|---|---|---|
${nfrRows}

Mark a domain \`not applicable — <reason>\` rather than deleting the row.

## 5. Acceptance criteria

| id | requirement | Given | When | Then |
|---|---|---|---|---|
| \`AC-001\` | \`FR-001\` | <precondition> | <action> | <observable outcome> |
| \`AC-002\` | \`BR-001\` | <precondition> | <action> | <outcome the rule requires> |

## 6. Assumptions, constraints and open questions

| ${REGISTER_FIELDS.join(' | ')} |
|${REGISTER_FIELDS.map(() => '---').join('|')}|
| \`A-001\` | ${REGISTER_TYPES.join('/')} | <statement> | <who decides> | <what changes> | <YYYY-MM-DD; "none" once confirmed/closed> | ${REGISTER_STATUSES.join('/')} |

## 7. Traceability

| requirement | source | goal |
|---|---|---|
| \`FR-001\` | <SRC-### from the source register, with section if useful; without a register: planning baseline document id/version, input document, or brief> | <stakeholder or project goal> |
`
}

export interface ContractFinding {
  code: string
  message: string
}

/** The contract as prompt text, shared by author and reviewer. */
export function renderContractRules(): string {
  return `Contract (every point is checked):
- Sections: ${REQUIRED_SECTIONS.join('; ')}.
- Each functional requirement row states: ${FUNCTIONAL_REQUIREMENT_FIELDS.join(', ')}. Use "none" rather than an empty cell. Priority is MoSCoW: ${PRIORITIES.join(', ')}.
- Every NFR domain appears: ${NFR_DOMAINS.map((entry) => entry.domain).join(', ')}. Each needs a measurable target and a verification method; a domain that does not apply is marked \`not applicable — <reason>\`.
- Scope states In scope, Out of scope and Deferred explicitly.
- Register columns: ${REGISTER_FIELDS.join(', ')}. Type is ${REGISTER_TYPES.join(', ')}; status is ${REGISTER_STATUSES.join(', ')}. Every entry has an owner and an "impact if wrong"; an open entry's resolve by is a YYYY-MM-DD date, a confirmed or closed one may say none.
- Optional "### Business rules" in section 3 (omit if the evidence has none): ${BUSINESS_RULE_FIELDS.join(', ')}; id \`BR-###\`, type ${BUSINESS_RULE_TYPES.join(', ')}; applies to names declared FR ids.
- Optional "### Glossary" in section 1 (omit if no domain terms): ${GLOSSARY_FIELDS.join(', ')}; each term defined once, with one meaning; source may be none.
- Every declared FR, NFR and BR is named in the requirement column of at least one \`AC-###\` row. The acceptance criterion IDs an FR or BR lists must name it in the acceptance table.
- Traceability names the source and the stakeholder or project goal for each FR and NFR. Cite the source by its \`SRC-###\` id from the source register when one is listed (a section or page may follow), otherwise the planning baseline (document id and version), an input document, or the brief. Use an open question rather than inventing missing evidence.`
}
