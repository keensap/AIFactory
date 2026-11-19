import assert from 'node:assert/strict'
import test from 'node:test'
import { NFR_DOMAINS } from '../src/stages/requirements-contract.ts'
import { inspectRequirementsCoverage } from '../src/stages/requirements-coverage.ts'

const COMPLETE = `# Requirements Specification — Shop

## 3. Functional requirements

| id | actor | trigger | behaviour | inputs | outputs | error cases | priority | acceptance criteria |
|---|---|---|---|---|---|---|---|---|
| \`FR-001\` | Shopper | checkout | place order | cart | order | retry | must | \`AC-001\` |

## 4. Non-functional requirements

| domain | id | target | verification |
|---|---|---|---|
| performance | \`NFR-001\` | p95 below 300 ms | load test with 50 concurrent shoppers |

## 5. Acceptance criteria

| id | requirement | Given | When | Then |
|---|---|---|---|---|
| \`AC-001\` | \`FR-001\` | a cart | checkout | an order exists |
| \`AC-002\` | \`NFR-001\` | 50 shoppers | checkout | p95 is below 300 ms |

## 7. Traceability

| requirement | source | goal |
|---|---|---|
| \`FR-001\` | brief §1 | place orders online |
| \`NFR-001\` | baseline b7 v1 | [responsive checkout](#checkout) |
`

const COUNTS = { priorities: { must: 1, should: 0, could: 0, wont: 0 }, businessRules: 0 }

function codes(markdown: string) {
  return inspectRequirementsCoverage(markdown).findings.map(({ code, requirementId, severity }) => [code, requirementId, severity])
}

test('valid scoped FR, NFR, AC, source and goal rows have no findings', () => {
  assert.deepEqual(inspectRequirementsCoverage(COMPLETE), {
    counts: { ...COUNTS, totalRequirements: 2, withAcceptanceCriteria: 2, withSource: 2, withGoal: 2 },
    findings: [],
  })
})

test('only declaration columns in actual scoped tables count; prose and examples do not', () => {
  const markdown = COMPLETE.replaceAll(/^.*\| `(?:FR-001|NFR-001|AC-00[12])`.*\n/gm, '')
    + `
## 3. Functional requirements
FR-001, NFR-001 and AC-001 are mentioned in prose.
| FR-001 | AC-001 |

\`\`\`markdown
${COMPLETE}
\`\`\`

<!--
${COMPLETE}
-->

## Appendix
| id | actor | acceptance criteria |
|---|---|---|
| FR-001 | shopper | AC-001 |
`
  assert.deepEqual(codes(markdown), [
    ['NO_FUNCTIONAL_REQUIREMENTS', undefined, 'blocking'],
    ['NO_NFR', undefined, 'blocking'],
    ['NO_ACCEPTANCE_CRITERIA', undefined, 'blocking'],
  ])
})

test('repeated FR, NFR and AC declarations report a single blocker per duplicate, not per mention', () => {
  const duplicate = COMPLETE.replaceAll(/^\| (?:performance \| )?`(?:FR-001|NFR-001|AC-001)` \|.*$/gm, (row) => `${row}\n${row}\n${row}`)
  assert.deepEqual(codes(duplicate), [
    ['DUPLICATE_REQUIREMENT_ID', 'FR-001', 'blocking'],
    ['DUPLICATE_REQUIREMENT_ID', 'NFR-001', 'blocking'],
    ['DUPLICATE_ACCEPTANCE_ID', undefined, 'blocking'],
  ])
})

test('dangling IDs in AC and traceability columns and in forward links block', () => {
  const dangling = COMPLETE.replace('| must | `AC-001` |', '| must | `AC-001`, `AC-900` |')
    .replace('| `AC-001` | `FR-001` |', '| `AC-001` | `FR-001`, `FR-900` |')
    .replace('| `NFR-001` | baseline b7', '| `NFR-001`, `NFR-900` | baseline b7')
  assert.deepEqual(codes(dangling), [
    ['DANGLING_REQUIREMENT_ID', 'FR-900', 'blocking'],
    ['DANGLING_ACCEPTANCE_ID', 'FR-001', 'blocking'],
    ['DANGLING_REQUIREMENT_ID', 'NFR-900', 'blocking'],
  ])
})

test('AC prose and an FR forward link to an AC proving another requirement do not provide coverage', () => {
  const wrongAc = COMPLETE.replace('| `AC-001` | `FR-001` | a cart | checkout | an order exists |',
    '| `AC-001` | `NFR-001` | a cart | checkout | FR-001 exists |')
  assert.deepEqual(codes(wrongAc), [
    ['MISMATCHED_ACCEPTANCE_REFERENCE', 'FR-001', 'blocking'],
    ['UNCOVERED_REQUIREMENT', 'FR-001', 'blocking'],
  ])
  const noNfrLink = COMPLETE.replace('| `AC-002` | `NFR-001` |', '| `AC-002` | none |')
  assert.deepEqual(codes(noNfrLink), [
    ['MISSING_ACCEPTANCE_REQUIREMENT', undefined, 'blocking'],
    ['UNCOVERED_REQUIREMENT', 'NFR-001', 'blocking'],
  ])
  assert.deepEqual(inspectRequirementsCoverage(noNfrLink).counts,
    { ...COUNTS, totalRequirements: 2, withAcceptanceCriteria: 1, withSource: 2, withGoal: 2 })
})

test('missing verification blocks; missing/placeholder trace sources and goals are advisory', () => {
  const incomplete = COMPLETE.replace('load test with 50 concurrent shoppers', '`TBD`')
    .replace('brief §1 | place orders online', 'none | —')
    .replace('| `NFR-001` | baseline b7 v1 | [responsive checkout](#checkout) |', '')
  assert.deepEqual(codes(incomplete), [
    ['MISSING_NFR_VERIFICATION', 'NFR-001', 'blocking'],
    ['MISSING_SOURCE', 'FR-001', 'advisory'],
    ['MISSING_GOAL', 'FR-001', 'advisory'],
    ['MISSING_SOURCE', 'NFR-001', 'advisory'],
    ['MISSING_GOAL', 'NFR-001', 'advisory'],
  ])
})

test('legacy source-only tables still supply source links', () => {
  const legacy = COMPLETE.replace(/\| requirement \| source \| goal \|\n\|---\|---\|---\|/, '| requirement | source |\n|---|---|')
    .replace(' | place orders online |', ' |').replace(' | [responsive checkout](#checkout) |', ' |')
  assert.deepEqual(codes(legacy), [
    ['MISSING_GOAL', 'FR-001', 'advisory'],
    ['MISSING_GOAL', 'NFR-001', 'advisory'],
  ])
})

test('catalog domains explicitly not applicable with reasons are not NFR declarations', () => {
  const notApplicable = COMPLETE.replace(/^.*\| performance \|.*$/m,
    NFR_DOMAINS.map(({ domain }) => `| ${domain} | | not applicable — outside scope | |`).join('\n'))
    .replace(/^.*\| `(?:AC-002|NFR-001)` \|.*\n/gm, '')
  assert.deepEqual(codes(notApplicable), [])
  assert.deepEqual(codes(notApplicable.replace('not applicable — outside scope', 'not applicable')), [
    ['MISSING_REQUIREMENT_ID', undefined, 'blocking'],
    ['NO_NFR', undefined, 'blocking'],
  ])
})

test('invalid declaration IDs cannot be rescued by an ID in a descriptive cell', () => {
  const malformed = COMPLETE.replace('| `FR-001` | Shopper', '| FR-xxx | FR-001 Shopper')
    .replace('| `AC-001` | `FR-001` | a cart', '| AC-xxx | `FR-001` | AC-001 a cart')
  assert.deepEqual(codes(malformed), [
    ['MISSING_REQUIREMENT_ID', undefined, 'blocking'],
    ['MISSING_ACCEPTANCE_ID', undefined, 'blocking'],
    ['NO_FUNCTIONAL_REQUIREMENTS', undefined, 'blocking'],
    ['DANGLING_REQUIREMENT_ID', 'FR-001', 'blocking'],
  ])
})

test('column order, plain IDs, CRLF, escaped pipes and optional table borders work', () => {
  const formatted = COMPLETE.replace('Shopper | checkout', 'Shopper \\| customer | checkout')
    .replace(/\| requirement \| source \| goal \|\n\|---\|---\|---\|\n\| `FR-001` \| brief §1 \| place orders online \|\n\| `NFR-001` \| baseline b7 v1 \| \[responsive checkout\]\(#checkout\) \|/,
      'Goal | Requirement | Source\n:--- | ---: | :---:\nplace orders online | **FR-001** | brief §1\nresponsive checkout | NFR-001 | baseline b7 v1')
    .replaceAll('\n', '\r\n')
  assert.deepEqual(codes(formatted), [])
})

// ---- R9: FR-210 priorities, FR-206 business rules

test('FR-210: counts tally the MoSCoW priority of each declared FR once', () => {
  const rows = [
    '| `FR-002` | Shopper | a | b | c | d | e | Should | `AC-001` |',
    "| `FR-003` | Shopper | a | b | c | d | e | won't | `AC-001` |",
    '| `FR-004` | Shopper | a | b | c | d | e | Won’t | `AC-001` |',
    '| `FR-005` | Shopper | a | b | c | d | e | could | `AC-001` |',
    '| `FR-006` | Shopper | a | b | c | d | e | high | `AC-001` |',
    '| `FR-002` | Shopper | a | b | c | d | e | must | `AC-001` |',
  ]
  const markdown = COMPLETE.replace('| must | `AC-001` |\n', `| must | \`AC-001\` |\n${rows.join('\n')}\n`)
    .replace('| `AC-001` | `FR-001` |', '| `AC-001` | `FR-001`, `FR-002`, `FR-003`, `FR-004`, `FR-005`, `FR-006` |')
  const report = inspectRequirementsCoverage(markdown)
  // FR-006's invalid priority is a CONTRACT_INVALID_PRIORITY blocker from validation; it is not counted here.
  assert.deepEqual(report.counts.priorities, { must: 1, should: 1, could: 1, wont: 2 })
  assert.equal(report.counts.totalRequirements, 7)
  assert.deepEqual(codes(markdown).filter(([, , severity]) => severity === 'blocking'), [['DUPLICATE_REQUIREMENT_ID', 'FR-002', 'blocking']], 'the duplicate is counted by its first declaration only')
})

const RULES = `
### Business rules

| id | type | rule | applies to | acceptance criteria |
|---|---|---|---|---|
| \`BR-001\` | decision table | card declined: retry; card expired: ask for a new card | \`FR-001\` | \`AC-003\` |
`
const AC_003 = '| `AC-003` | `BR-001` | an expired card | checkout | a new card is requested |\n'
function withRule(rules = RULES, ac = AC_003): string {
  return COMPLETE.replace('| must | `AC-001` |\n', `| must | \`AC-001\` |\n${rules}`).replace('\n## 7. Traceability', `${ac}\n## 7. Traceability`)
}

test('FR-206: a covered business rule has no findings, is counted separately and needs no source or goal', () => {
  const report = inspectRequirementsCoverage(withRule())
  assert.deepEqual(report, {
    counts: { ...COUNTS, totalRequirements: 2, withAcceptanceCriteria: 2, withSource: 2, withGoal: 2, businessRules: 1 },
    findings: [],
  })
  // Tracing a rule is allowed but not required; a source register id is not a requirement id.
  const traced = withRule().replace('| `NFR-001` | baseline b7 v1 |', '| `NFR-001` | SRC-002 §3 |') + '| `BR-001` | SRC-001 | fewer failed checkouts |\n'
  assert.deepEqual(codes(traced), [])
  // An ordinary subsection of section 3 is still a functional requirements table.
  assert.deepEqual(codes(withRule(RULES.replace('### Business rules', '### Checkout'))), [
    ['MISSING_REQUIREMENT_ID', undefined, 'blocking'],
    ['DANGLING_REQUIREMENT_ID', 'BR-001', 'blocking'],
  ])
  assert.deepEqual(codes(withRule(RULES.replace('### Business rules', '#### 3.2 Business rules and decision tables'))), [])
})

test('FR-206: business rules are checked like requirements for ids, duplicates, links and coverage', () => {
  assert.deepEqual(codes(withRule(RULES, '')), [
    ['DANGLING_ACCEPTANCE_ID', 'BR-001', 'blocking'],
    ['UNCOVERED_REQUIREMENT', 'BR-001', 'blocking'],
  ])
  assert.deepEqual(codes(withRule(RULES.replace('| `AC-003` |', '| none |'), AC_003.replace('`BR-001`', '`BR-009`'))), [
    ['DANGLING_REQUIREMENT_ID', 'BR-009', 'blocking'],
    ['UNCOVERED_REQUIREMENT', 'BR-001', 'blocking'],
  ])
  assert.deepEqual(codes(withRule(RULES.replace('| `AC-003` |', '| `AC-001` |'), AC_003.replace('`BR-001`', '`FR-001`'))), [
    ['MISMATCHED_ACCEPTANCE_REFERENCE', 'BR-001', 'blocking'],
    ['UNCOVERED_REQUIREMENT', 'BR-001', 'blocking'],
  ])
  assert.deepEqual(codes(withRule(RULES.replace('| `FR-001` | `AC-003` |', '| `FR-001`, `FR-009` | `AC-003` |'))), [
    ['DANGLING_REQUIREMENT_ID', 'FR-009', 'blocking'],
  ])
  assert.deepEqual(codes(withRule(RULES.replace('| `FR-001` | `AC-003` |', '| checkout | `AC-003` |'))), [
    ['MISSING_BUSINESS_RULE_REQUIREMENT', 'BR-001', 'blocking'],
  ])
  const duplicate = RULES.replace(/^\| `BR-001`.*$/m, (row) => `${row}\n${row}`)
  assert.deepEqual(codes(withRule(duplicate)), [['DUPLICATE_REQUIREMENT_ID', 'BR-001', 'blocking']])
  assert.deepEqual(codes(withRule(RULES.replace('`BR-001`', 'RULE-1'))), [
    ['MISSING_REQUIREMENT_ID', undefined, 'blocking'],
    ['DANGLING_REQUIREMENT_ID', 'BR-001', 'blocking'],
  ])
  // A BR id in the FR table is not a rule declaration.
  const misplaced = COMPLETE.replace('| must | `AC-001` |\n', '| must | `AC-001` |\n| `BR-001` | Shopper | a | b | c | d | e | must | `AC-003` |\n')
    .replace('\n## 7. Traceability', `${AC_003}\n## 7. Traceability`)
  assert.deepEqual(codes(misplaced), [
    ['MISSING_REQUIREMENT_ID', undefined, 'blocking'],
    ['DANGLING_REQUIREMENT_ID', 'BR-001', 'blocking'],
  ])
})
