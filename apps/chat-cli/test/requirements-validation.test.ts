import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NFR_DOMAINS } from '../src/stages/requirements-contract.ts'
import { inspectRequirementsCoverage } from '../src/stages/requirements-coverage.ts'
import { inspectRequirementsValidation } from '../src/stages/requirements-validation.ts'

const scope = `## 1. Purpose and scope

Customers need to view their orders.

| Boundary | Items |
|---|---|
| In scope | Order history |
| Out of scope | None |
| Deferred | Not applicable |
`

const register = `## 6. Assumptions, constraints and open questions

| id | type | statement | owner | impact if wrong | resolve by | status |
|---|---|---|---|---|---|---|
| A-001 | assumption | Order history is retained | Operations | History may be incomplete | 2026-12-31 | open |
`

const spec = `# Requirements Specification — Test

${scope}
## 2. Actors and permissions

| Actor | Goal | Permissions |
|---|---|---|
| Customer | View orders | Own account only |

## 3. Functional requirements

| id | actor | trigger | behaviour | inputs | outputs | error cases | priority | acceptance criteria |
|---|---|---|---|---|---|---|---|---|
| FR-001 | Customer | Opens portal | Shows orders | None | Order list | None | must | AC-001 |

## 4. Non-functional requirements

| domain | id | target | verification |
|---|---|---|---|
| performance | NFR-001 | p95 below 300 ms | Load test |
${NFR_DOMAINS.filter(({ domain }) => domain !== 'performance').map(({ domain }) => `| ${domain} | not applicable — outside this test fixture | — | — |`).join('\n')}

## 5. Acceptance criteria

| id | requirement | Given | When | Then |
|---|---|---|---|---|
| AC-001 | FR-001 | Customer has orders | Portal opens | Orders appear |
| AC-002 | NFR-001 | Test dataset | Load test runs | p95 is below 300 ms |

${register}
## 7. Traceability

| requirement | source | goal |
|---|---|---|
| FR-001 | Brief | Customers can see orders |
| NFR-001 | Brief | Portal responds promptly |
`

const has = (markdown: string, code: string, text: string): boolean => inspectRequirementsValidation(markdown)
  .some((finding) => finding.code === code && finding.message.includes(text))

test('accepts the complete contract, escaped pipes and aligned tables', () => {
  const markdown = spec
    .replace('## 3. Functional requirements', '   ### 3. FUNCTIONAL REQUIREMENTS ###')
    .replace('| Actor | Goal | Permissions |', ' **Actor** | Goal | Permissions ')
    .replace('|---|---|---|\n| Customer', ':--- | :---: | ---:\n| Customer')
    .replace('Order list | None', 'Order \\| list | None')
    .replaceAll('\n', '\r\n')
  assert.deepEqual(inspectRequirementsValidation(spec), [])
  assert.deepEqual(inspectRequirementsValidation(markdown), [])
})

test('requires the contract headings to be visible and ordered', () => {
  const absent = spec.replace(scope, `\`\`\`md\n${scope}\`\`\`\n`).replace(register, `<!--\n${register}-->\n`)
  assert.equal(has(absent, 'MISSING_SECTION', '1. Purpose and scope'), true)
  assert.equal(has(absent, 'MISSING_SECTION', '6. Assumptions'), true)
  const swapped = spec.replace(scope, register).replace(`${register}\n## 7.`, `${scope}\n## 7.`)
  assert.equal(has(swapped, 'SECTION_OUT_OF_ORDER', '1. Purpose and scope'), true)
})

test('requires actual FR headers and non-placeholder cells independently of R4 coverage', () => {
  const broken = spec
    .replace('| outputs | error cases', '| result | error cases')
    .replace('Opens portal | Shows orders | None', '   | <single testable behaviour> | None')
    .replace('| must | AC-001', '| TBD | AC-001')
  assert.deepEqual(inspectRequirementsCoverage(broken).findings, [])
  assert.equal(has(broken, 'MISSING_TABLE_COLUMN', '"outputs"'), true)
  for (const field of ['trigger', 'behaviour', 'priority']) {
    assert.equal(has(broken, 'MISSING_REQUIRED_FIELD', `"${field}"`), true)
  }
})

test('requires explicit scope boundaries with items, actor permissions and AC outcomes', () => {
  const broken = spec
    .replace('| Out of scope | None |', '| Not considered | None |')
    .replace('| Deferred | Not applicable |', '| Deferred | |')
    .replace('| Customer | View orders | Own account only |', '| Customer | View orders | |')
    .replace('| Portal opens | Orders appear |', '| Portal opens | |')
  assert.equal(has(broken, 'MISSING_SCOPE_BOUNDARY', 'Out of scope'), true)
  assert.equal(has(broken, 'MISSING_REQUIRED_FIELD', '"items"'), true)
  assert.equal(has(broken, 'MISSING_REQUIRED_FIELD', '"permissions"'), true)
  assert.equal(has(broken, 'MISSING_REQUIRED_FIELD', '"then"'), true)
})

test('requires each NFR domain in its own table and a target or an explicit reason', () => {
  const broken = spec
    .replace('| performance | NFR-001 | p95 below 300 ms |', '| performance | NFR-001 | |')
    .replace('| compliance | not applicable — outside this test fixture | — | — |', 'compliance — not applicable')
    .replace('| security | not applicable — outside this test fixture | — | — |', '| security | not applicable — TBD | — | — |')
  assert.equal(has(broken, 'MISSING_NFR_DOMAIN', 'compliance'), true)
  assert.equal(inspectRequirementsValidation(broken).filter(({ code, message }) => code === 'MISSING_REQUIRED_FIELD' && message.includes('"target"')).length, 2)
  const explicit = spec.replace('| security | not applicable — outside this test fixture | — | — |', '| security | — | not applicable: No protected resources | — |')
  assert.deepEqual(inspectRequirementsValidation(explicit), [])
  const allNotApplicable = explicit
    .replace('| performance | NFR-001 | p95 below 300 ms | Load test |', '| performance | not applicable — no latency budget | | |')
    .replace('| AC-002 | NFR-001 | Test dataset | Load test runs | p95 is below 300 ms |\n', '')
    .replace('| NFR-001 | Brief | Portal responds promptly |\n', '')
  assert.deepEqual(inspectRequirementsValidation(allNotApplicable), [])
  assert.deepEqual(inspectRequirementsCoverage(allNotApplicable).findings, [])
})

test('register entries need an owner and impact, but explicitly empty registers are valid', () => {
  const broken = spec.replace('| Operations | History may be incomplete |', '| | — |')
  assert.equal(has(broken, 'MISSING_REQUIRED_FIELD', '"owner"'), true)
  assert.equal(has(broken, 'MISSING_REQUIRED_FIELD', '"impact if wrong"'), true)
  assert.deepEqual(inspectRequirementsValidation(spec.replace(register, '## 6. Assumptions, constraints and open questions\n\n**None.**\n')), [])
  assert.deepEqual(inspectRequirementsValidation(spec.replace('| A-001 | assumption | Order history is retained | Operations | History may be incomplete | 2026-12-31 | open |', '| — | — | None | — | — | — | — |')), [])
})

test('leaves links, verification, and source and goal findings to R4', () => {
  const broken = spec
    .replace('| None | must | AC-001 |', '| None | must | AC-999 |')
    .replace('| p95 below 300 ms | Load test |', '| p95 below 300 ms | |')
    .replace('| FR-001 | Brief | Customers can see orders |', '| FR-001 | | |')
  assert.deepEqual(inspectRequirementsValidation(broken), [])
  for (const code of ['DANGLING_ACCEPTANCE_ID', 'MISSING_NFR_VERIFICATION', 'MISSING_SOURCE', 'MISSING_GOAL']) {
    assert.ok(inspectRequirementsCoverage(broken).findings.some((finding) => finding.code === code))
  }
})

// ---- R9: FR-208 register, FR-210 priority, FR-206 business rules, FR-207 glossary

const codesOf = (markdown: string): string[] => inspectRequirementsValidation(markdown).map(({ code }) => code)
const REGISTER_ROW = '| A-001 | assumption | Order history is retained | Operations | History may be incomplete | 2026-12-31 | open |'
const withRegisterRows = (...rows: string[]): string => spec.replace(REGISTER_ROW, rows.join('\n'))

test('FR-208: register entries are typed, have a status, and an open entry has an ISO resolve-by date', () => {
  const valid = withRegisterRows(
    '| A-001 | Assumption | Order history is retained | Operations | History may be incomplete | 2026-12-31 | Open |',
    '| C-001 | constraint | Hosting stays in the EU | Legal | Vendor must change | none | confirmed |',
    '| D-001 | dependency | Payments API v2 is available | Platform | Checkout slips | 2026-03-01 | closed |',
    '| Q-001 | `question` | Are guest orders shown? | Product | FR-001 changes | N/A | closed |',
  )
  assert.deepEqual(inspectRequirementsValidation(valid), [])

  assert.equal(has(withRegisterRows('| A-001 | risk | Order history is retained | Operations | History may be incomplete | 2026-12-31 | open |'), 'INVALID_REGISTER_TYPE', '"risk"'), true)
  assert.equal(has(withRegisterRows('| A-001 | assumption | Order history is retained | Operations | History may be incomplete | 2026-12-31 | pending |'), 'INVALID_REGISTER_STATUS', '"pending"'), true)
  for (const missing of ['none', '—', '', 'TBD']) {
    const broken = withRegisterRows(`| A-001 | assumption | Order history is retained | Operations | History may be incomplete | ${missing} | open |`)
    assert.deepEqual(codesOf(broken), ['MISSING_RESOLVE_BY'], `open entry with resolve by "${missing}"`)
  }
  for (const invalid of ['next sprint', '31/12/2026', '2026-02-30', '2026-13-01']) {
    const broken = withRegisterRows(`| A-001 | assumption | Order history is retained | Operations | History may be incomplete | ${invalid} | open |`)
    assert.deepEqual(codesOf(broken), ['INVALID_RESOLVE_BY'], `open entry with resolve by "${invalid}"`)
  }
  assert.deepEqual(codesOf(withRegisterRows('| A-001 | assumption | Order history is retained | Operations | History may be incomplete | soon | closed |')), ['INVALID_RESOLVE_BY'])
  assert.deepEqual(codesOf(withRegisterRows('| A-001 | assumption | Order history is retained | Operations | History may be incomplete |  | confirmed |')), ['MISSING_RESOLVE_BY'])
  assert.deepEqual(codesOf(withRegisterRows('| A-001 | — | Order history is retained | Operations | History may be incomplete | 2026-12-31 | — |')), ['MISSING_REQUIRED_FIELD', 'MISSING_REQUIRED_FIELD'])
})

test('FR-208: a register without the type and resolve-by columns is incomplete; an explicitly empty register is still valid', () => {
  const legacy = spec.replace(`| id | type | statement | owner | impact if wrong | resolve by | status |
|---|---|---|---|---|---|---|
${REGISTER_ROW}`, `| id | statement | owner | impact if wrong | status |
|---|---|---|---|---|
| A-001 | Order history is retained | Operations | History may be incomplete | open |`)
  assert.equal(has(legacy, 'MISSING_TABLE_COLUMN', '"type"'), true)
  assert.equal(has(legacy, 'MISSING_TABLE_COLUMN', '"resolve by"'), true)
  assert.deepEqual(inspectRequirementsValidation(spec.replace(register, '## 6. Assumptions, constraints and open questions\n\nNo assumptions, constraints and open questions recorded.\n')), [])
})

test('FR-210: FR priority is MoSCoW in any case and spelling of won\'t; anything else blocks', () => {
  for (const priority of ['must', 'Should', 'COULD', "won't", 'wont', 'Won’t', '`must`', '**should**']) {
    assert.deepEqual(inspectRequirementsValidation(spec.replace('| None | must | AC-001 |', `| None | ${priority} | AC-001 |`)), [], priority)
  }
  for (const priority of ['high', 'P1', 'none', 'must have', 'mandatory']) {
    assert.equal(has(spec.replace('| None | must | AC-001 |', `| None | ${priority} | AC-001 |`), 'INVALID_PRIORITY', `"${priority}"`), true, priority)
  }
  assert.deepEqual(codesOf(spec.replace('| None | must | AC-001 |', '| None |  | AC-001 |')), ['MISSING_REQUIRED_FIELD'], 'an empty priority is a missing field, not an invalid one')
})

const RULES = `
### Business rules

| id | type | rule | applies to | acceptance criteria |
|---|---|---|---|---|
| BR-001 | decision table | Orders older than 2 years: archived; otherwise: listed | FR-001 | AC-003 |
| BR-002 | Formula | Order total = sum of line totals minus discount | FR-001 | AC-003 |
`
const withRules = (rules = RULES): string => spec
  .replace('| None | must | AC-001 |\n', `| None | must | AC-001 |\n${rules}`)
  .replace('| AC-002 | NFR-001 |', '| AC-003 | BR-001, BR-002 | Two orders | Portal opens | Archived and listed orders appear with totals |\n| AC-002 | NFR-001 |')

test('FR-206: an optional business-rules subsection in section 3 is checked for fields and type, not as an FR table', () => {
  assert.deepEqual(inspectRequirementsValidation(withRules()), [])
  assert.deepEqual(inspectRequirementsCoverage(withRules()).findings, [])
  assert.deepEqual(inspectRequirementsValidation(withRules(RULES.replace('### Business rules', '#### 3.1 Business rules'))), [], 'numbered and deeper headings work')
  assert.deepEqual(inspectRequirementsValidation(withRules(RULES.replace('| decision table |', '| decision-table |'))), [])
  for (const type of ['state transition', 'validation', 'policy']) {
    assert.deepEqual(inspectRequirementsValidation(withRules(RULES.replace('| Formula |', `| ${type} |`))), [], type)
  }

  assert.equal(has(withRules(RULES.replace('| Formula |', '| heuristic |')), 'INVALID_BUSINESS_RULE_TYPE', '"heuristic"'), true)
  assert.deepEqual(codesOf(withRules(RULES.replace('| Formula |', '|  |'))), ['MISSING_REQUIRED_FIELD'])
  for (const [from, field] of [['| FR-001 | AC-003 |\n| BR-002', 'applies to'], ['Orders older than 2 years: archived; otherwise: listed', 'rule']] as const) {
    const broken = withRules(RULES.replace(from, from.replace(field === 'rule' ? from : 'FR-001', 'none')))
    assert.equal(has(broken, 'MISSING_REQUIRED_FIELD', `"${field}"`), true, field)
  }
  assert.equal(has(withRules(RULES.replace('| FR-001 | AC-003 |\n| BR-002', '| FR-001 | none |\n| BR-002')), 'MISSING_REQUIRED_FIELD', '"acceptance criteria"'), true)
  assert.equal(has(withRules(RULES.replace('| applies to |', '| scope |')), 'MISSING_TABLE_COLUMN', '"applies to"'), true)
  // Nothing about the rule table is reported against the FR table.
  assert.ok(!inspectRequirementsValidation(withRules(RULES.replace('| Formula |', '| heuristic |'))).some(({ code }) => code === 'MISSING_TABLE_COLUMN'))
})

const GLOSSARY = `
### Glossary

| term | definition | source |
|---|---|---|
| Order | A purchase confirmed by the customer | Brief |
| Order history | All orders of one account, newest first | none |
`
const withGlossary = (glossary = GLOSSARY): string => spec.replace('| Deferred | Not applicable |\n', `| Deferred | Not applicable |\n${glossary}`)

test('FR-207: an optional glossary in section 1 defines each term once with one meaning', () => {
  assert.deepEqual(inspectRequirementsValidation(withGlossary()), [])
  const repeated = GLOSSARY.replace('| Order history |', '| order  HISTORY |').replace('| none |', '| none |\n| Order History | all orders of one account, newest first. | Interview |')
  assert.deepEqual(codesOf(withGlossary(repeated)), ['DUPLICATE_GLOSSARY_TERM'])
  const conflicting = `${GLOSSARY.trimEnd()}\n| ORDER | A cart the customer has not paid for | Support notes |\n`
  assert.deepEqual(codesOf(withGlossary(conflicting)), ['INCONSISTENT_GLOSSARY_TERM'])
  assert.equal(has(withGlossary(conflicting), 'INCONSISTENT_GLOSSARY_TERM', '"ORDER"'), true)
  assert.deepEqual(codesOf(withGlossary(GLOSSARY.replace('All orders of one account, newest first', '<definition>'))), ['MISSING_REQUIRED_FIELD'])
  assert.deepEqual(codesOf(withGlossary(GLOSSARY.replace('| Order |', '| none |'))), ['MISSING_REQUIRED_FIELD'])
  assert.equal(has(withGlossary(GLOSSARY.replace('| source |', '| origin |')), 'MISSING_TABLE_COLUMN', '"source"'), true)
})

test('optional subsections stay inside their section and do not disturb section or table detection', () => {
  const both = withRules().replace('| Deferred | Not applicable |\n', `| Deferred | Not applicable |\n${GLOSSARY}`)
  assert.ok(both.includes('### Glossary') && both.includes('### Business rules'))
  assert.deepEqual(inspectRequirementsValidation(both), [])
  assert.deepEqual(inspectRequirementsCoverage(both).findings, [])
  // A glossary placed before the scope table does not hide it; an ordinary subsection is not optional.
  const glossaryFirst = spec.replace('Customers need to view their orders.\n', `Customers need to view their orders.\n${GLOSSARY}\n### Boundaries\n`)
  assert.deepEqual(inspectRequirementsValidation(glossaryFirst), [])
  // The scope table is still required when only a glossary is present.
  const glossaryOnly = withGlossary().replace(/\| Boundary \| Items \|\n\|---\|---\|\n(?:\|.*\n){3}/, '')
  assert.equal(has(glossaryOnly, 'MISSING_REQUIRED_TABLE', '1. Purpose and scope'), true)
  // A rules table alone does not satisfy the FR table.
  const rulesOnly = withRules().replace(/^\| id \| actor .*\n\|---.*\n\| FR-001 .*\n/m, '')
  assert.equal(has(rulesOnly, 'MISSING_REQUIRED_TABLE', '3. Functional requirements'), true)
})

test('a document without the optional business-rules and glossary subsections passes', () => {
  assert.ok(!spec.includes('Business rules') && !spec.includes('Glossary'))
  assert.deepEqual(inspectRequirementsValidation(spec), [])
  assert.deepEqual(inspectRequirementsCoverage(spec).findings, [])
})
