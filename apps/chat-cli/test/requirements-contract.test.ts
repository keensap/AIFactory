import assert from 'node:assert/strict'
import test from 'node:test'
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
  moscowPriority,
  optionalSubsection,
  renderContractRules,
  renderContractTemplate,
} from '../src/stages/requirements-contract.ts'
import { inspectRequirementsValidation } from '../src/stages/requirements-validation.ts'
import { stageDefinition } from '../src/stages/index.ts'
import { inspectRequirementsDocument, requirementsDocumentPasses } from '../src/stages/requirements-checks.ts'
import { REALISTIC_REQUIREMENTS } from './support/requirements-fixture.ts'
import type { StageContextPacket } from '../src/stage-runtime.ts'
import type { Project } from '../src/projects.ts'

/**
 * A specification that satisfies the contract. Tests mutate one thing at a time
 * so a failure names the exact rule that stopped holding.
 */
const COMPLETE = `# Requirements Specification — Shop

## 1. Purpose and scope

Sell catalogue items online.

| Boundary | Items |
|---|---|
| In scope | Catalogue, checkout |
| Out of scope | Warehouse robotics |
| Deferred | Loyalty points |

## 2. Actors and permissions

| Actor | Goal | Permissions |
|---|---|---|
| Shopper | Buy items | browse, checkout |

## 3. Functional requirements

| id | actor | trigger | behaviour | inputs | outputs | error cases | priority | acceptance criteria |
|---|---|---|---|---|---|---|---|---|
| \`FR-001\` | Shopper | checkout pressed | order is placed | cart, address | order id | payment declined shows retry | must | \`AC-001\` |

## 4. Non-functional requirements

| domain | id | target | verification |
|---|---|---|---|
${NFR_ROWS()}

## 5. Acceptance criteria

| id | requirement | Given | When | Then |
|---|---|---|---|---|
| \`AC-001\` | \`FR-001\` | a cart | checkout | an order exists |

## 6. Assumptions, constraints and open questions

| id | type | statement | owner | impact if wrong | resolve by | status |
|---|---|---|---|---|---|---|
| \`A-001\` | assumption | card payments allowed | Finance | checkout blocked | 2026-12-31 | open |

## 7. Traceability

| requirement | source |
|---|---|
| \`FR-001\` | planning baseline doc b7 v1 |
`

function NFR_ROWS(): string {
  return NFR_DOMAINS.map(({ domain, verification }) => `| ${domain} | \`NFR-001\` | 99th percentile 300 ms | ${verification} |`).join('\n')
}

// The deterministic contract check is `inspectRequirementsDocument`, the same
// function the runtime gates on. (An earlier R3-only checker disagreed with it
// and was retired in R8.) Each test breaks one rule of a complete document.

function blockingCodes(markdown: string): string[] {
  return inspectRequirementsDocument(markdown).findings.filter((finding) => finding.severity === 'blocking').map((finding) => finding.code)
}

test('a complete specification passes the deterministic contract check', () => {
  const report = inspectRequirementsDocument(REALISTIC_REQUIREMENTS)
  assert.deepEqual(report.findings, [])
  assert.equal(requirementsDocumentPasses(report), true)
})

test('each missing section is reported by name and blocks', () => {
  for (const section of REQUIRED_SECTIONS) {
    const broken = REALISTIC_REQUIREMENTS.replace(new RegExp(`^## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm'), '')
    const report = inspectRequirementsDocument(broken)
    assert.ok(report.findings.some((finding) => finding.code === 'CONTRACT_MISSING_SECTION' && finding.message.includes(section) && finding.severity === 'blocking'), `${section} must be required`)
  }
})

test('a requirement whose acceptance criterion row is removed is uncovered and blocks', () => {
  const broken = REALISTIC_REQUIREMENTS.split('\n').filter((line) => !line.startsWith('| `AC-001` | `FR-001`')).join('\n')
  const report = inspectRequirementsDocument(broken)
  assert.ok(report.findings.some((finding) => finding.code === 'UNCOVERED_REQUIREMENT' && finding.requirementId === 'FR-001' && finding.severity === 'blocking'))
  assert.equal(requirementsDocumentPasses(report), false)
})

test('a deleted NFR domain blocks, and a reasoned not-applicable domain does not', () => {
  assert.ok(blockingCodes(REALISTIC_REQUIREMENTS.split('\n').filter((line) => !line.startsWith('| localisation |')).join('\n')).includes('CONTRACT_MISSING_NFR_DOMAIN'))
  // The realistic fixture already marks localisation not applicable with a reason.
  assert.ok(REALISTIC_REQUIREMENTS.includes('| localisation | not applicable — '))
  assert.deepEqual(blockingCodes(REALISTIC_REQUIREMENTS), [])
})

test('scope boundaries must be stated', () => {
  const broken = REALISTIC_REQUIREMENTS.split('\n').filter((line) => !line.startsWith('| Deferred |')).join('\n')
  assert.ok(blockingCodes(broken).includes('CONTRACT_MISSING_SCOPE_BOUNDARY'))
})

test('the unfilled author skeleton is never approvable', () => {
  // Placeholders such as <actor> are not values; a model that echoes the
  // template must not pass the gate.
  assert.equal(requirementsDocumentPasses(inspectRequirementsDocument(renderContractTemplate('Shop'))), false)
})

test('the author prompt states every contract element it must produce', () => {
  const context = { input: 'brief', priorStages: [], documents: [], attachments: [], baselineEvidence: [] } as unknown as StageContextPacket
  const project = { name: 'Shop' } as Project
  const prompt = stageDefinition('requirements')!.prompts.author(project, context, 'analysis')
  for (const section of REQUIRED_SECTIONS) assert.ok(prompt.includes(section), `missing section ${section}`)
  for (const field of FUNCTIONAL_REQUIREMENT_FIELDS) assert.ok(prompt.includes(field), `missing field ${field}`)
  for (const { domain } of NFR_DOMAINS) assert.ok(prompt.includes(domain), `missing NFR domain ${domain}`)
  for (const boundary of ['In scope', 'Out of scope', 'Deferred']) assert.ok(prompt.includes(boundary))
  assert.match(prompt, /owner/)
  assert.match(prompt, /impact if wrong/)
  assert.match(prompt, /AC-001/)
})

test('the reviewer and revision prompts carry the same contract', () => {
  const context = { input: 'brief', priorStages: [], documents: [], attachments: [], baselineEvidence: [] } as unknown as StageContextPacket
  const project = { name: 'Shop' } as Project
  const definition = stageDefinition('requirements')!
  const settings = { maxReviewCycles: 2, minRating: 0, maxBlockers: 0, maxMajor: 0, gateReminderHours: 72 }
  const reviewer = definition.prompts.reviewer(project, context, COMPLETE, settings)
  const revision = definition.prompts.revision(project, context, 'analysis', COMPLETE, [{ severity: 'major', finding: 'x' }])
  const rules = renderContractRules()
  for (const prompt of [reviewer, revision]) {
    for (const section of REQUIRED_SECTIONS) assert.ok(prompt.includes(section), `missing ${section}`)
    for (const { domain } of NFR_DOMAINS) assert.ok(prompt.includes(domain), `missing ${domain}`)
  }
  assert.ok(rules.includes('not applicable'))
})

test('the template is valid Markdown that already names the required structure', () => {
  const template = renderContractTemplate('Shop')
  for (const section of REQUIRED_SECTIONS) assert.ok(template.includes(section))
  for (const { domain } of NFR_DOMAINS) assert.ok(template.includes(domain))
  assert.match(template, /AC-001/)
  assert.match(template, /impact if wrong/)
})

// ---- R9: FR-206, FR-207, FR-208, FR-210 in the template and rules

test('the template names every register column, business-rule and glossary column, and both optional subsections', () => {
  const template = renderContractTemplate('Shop')
  assert.ok(template.includes(`| ${REGISTER_FIELDS.join(' | ')} |`), 'register header')
  assert.ok(template.includes(`| ${BUSINESS_RULE_FIELDS.join(' | ')} |`), 'business rules header')
  assert.ok(template.includes(`| ${GLOSSARY_FIELDS.join(' | ')} |`), 'glossary header')
  for (const value of [...REGISTER_TYPES, ...REGISTER_STATUSES, ...BUSINESS_RULE_TYPES]) assert.ok(template.includes(value), value)
  assert.match(template, /must\/should\/could\/won't/)
  assert.match(template, /YYYY-MM-DD/)
  assert.match(template, /`BR-001`/)
  assert.match(template, /SRC-###/)
  assert.match(template, /^### Business rules$/m)
  assert.match(template, /^### Glossary$/m)
  assert.match(template, /Omit this subsection if the evidence contains no business rules/)
  assert.match(template, /Omit this subsection if the evidence introduces no domain terms/)
  // Each subsection sits inside its section: glossary after the scope table, rules after the FR table.
  const at = (text: string): number => template.indexOf(text)
  assert.ok(at('| Boundary | Items |') < at('### Glossary') && at('### Glossary') < at('## 2. Actors'))
  assert.ok(at('| id | actor |') < at('### Business rules') && at('### Business rules') < at('## 4. Non-functional'))
  // The subsections do not break section detection or masquerade as the FR or scope tables.
  const structural = inspectRequirementsValidation(template).filter(({ code }) => /SECTION|TABLE/.test(code))
  assert.deepEqual(structural, [])
})

test('the rules text states every new rule concisely', () => {
  const rules = renderContractRules()
  for (const text of ['MoSCoW', "won't", 'resolve by', 'YYYY-MM-DD', 'none', 'Business rules', 'BR-###', 'Glossary', 'SRC-###', 'source register', ...REGISTER_TYPES, ...REGISTER_STATUSES, ...BUSINESS_RULE_TYPES]) {
    assert.ok(rules.includes(text), text)
  }
  assert.ok(rules.length < 3000, `rules stay compact (${rules.length} chars)`)
})

test('moscowPriority and optionalSubsection normalise their input', () => {
  assert.deepEqual(['must', 'SHOULD', ' could ', "Won't", 'wont', 'won’t', '`must`', 'high', 'none', ''].map(moscowPriority),
    ['must', 'should', 'could', 'wont', 'wont', 'wont', 'must', undefined, undefined, undefined])
  assert.equal(optionalSubsection(2, 'Business rules'), 'business rules')
  assert.equal(optionalSubsection(2, '3.1 Business Rules'), 'business rules')
  assert.equal(optionalSubsection(0, 'Glossary'), 'glossary')
  assert.equal(optionalSubsection(0, 'Business rules'), undefined, 'rules belong to section 3')
  assert.equal(optionalSubsection(2, 'Glossary'), undefined, 'the glossary belongs to section 1')
  assert.equal(optionalSubsection(2, 'Business rulesets'), undefined)
})

test('the realistic fixture uses every new element and still passes without its optional subsections', () => {
  const report = inspectRequirementsDocument(REALISTIC_REQUIREMENTS)
  assert.deepEqual(report.findings, [])
  assert.equal(report.counts.businessRules, 2)
  assert.match(REALISTIC_REQUIREMENTS, /\| decision table \|/)
  assert.match(REALISTIC_REQUIREMENTS, /^### Glossary$/m)
  const plain = REALISTIC_REQUIREMENTS
    .replace(/\n### Glossary\n[\s\S]*?(?=\n## 2\.)/, '\n')
    .replace(/\n### Business rules\n[\s\S]*?(?=\n## 4\.)/, '\n')
    .replace(/^\| `AC-01[56]` .*\n/gm, '')
  assert.ok(!plain.includes('### ') && !plain.includes('BR-0'))
  const without = inspectRequirementsDocument(plain)
  assert.deepEqual(without.findings, [])
  assert.equal(without.counts.businessRules, 0)
  assert.deepEqual(without.counts.priorities, report.counts.priorities)
})
