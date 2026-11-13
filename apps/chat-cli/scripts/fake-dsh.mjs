#!/usr/bin/env node
/**
 * Deterministic stand-in for `dsh --profile headless --json`.
 *
 * Tests use it to exercise process lifecycle, NDJSON parsing, session
 * continuity and failure mapping without a model provider or API key.
 */

const args = process.argv.slice(2)

function valueOf(flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

const resumedSession = valueOf('--session-id')
const sessionId = resumedSession ?? 'session-fake-1'

let input = ''
for await (const chunk of process.stdin) input += chunk
const prompt = input.trim()

if (prompt === 'SLEEP') {
  await new Promise((resolve) => setTimeout(resolve, 5_000))
}

if (prompt.includes('REASON_FAIL')) {
  const failure = {
    type: 'final',
    sessionId,
    reason: { kind: 'error', error: { message: 'reason failure', code: 'REASON_CODE' } },
    text: '',
  }
  process.stdout.write(`${JSON.stringify({ type: 'session', sessionId, cwd: process.cwd() })}\n`)
  process.stdout.write(`${JSON.stringify(failure)}\n`)
  process.exit(1)
}

if (prompt.includes('FAIL')) {
  process.stdout.write(`${JSON.stringify({ type: 'error', message: 'synthetic failure', code: 'FAKE_ERROR' })}\n`)
  process.exit(1)
}

if (prompt.includes('GARBAGE')) {
  process.stdout.write('this line is not json\n')
}

let text = `echo: ${prompt}${resumedSession === undefined ? '' : ' (resumed)'}`

if (prompt.includes('STAGE_ROLE: analyzer')) {
  text = `# Planning analysis\n\n- Business idea: customer portal for invoices.\n- Stakeholder goals: self-service payments.\n- TELOS: technical, economic, legal, operational and schedule evidence is available.\n`
} else if (prompt.includes('STAGE_ROLE: reviewer')) {
  text = JSON.stringify({
    decision: 'approved',
    findings: [],
  })
} else if (prompt.includes('STAGE_ROLE: author')) {
  text = `# TELOS Feasibility Report — Fake Project\n\n## 1. Executive summary\n\nA customer portal is feasible.\n\n## 4. Technical feasibility\n\nExisting stack can support it.\n\n## 5. Economic feasibility\n\nBudget is approved.\n\n## 6. Legal feasibility\n\nNo blockers.\n\n## 7. Operational feasibility\n\nSupport team is ready.\n\n## 8. Schedule feasibility\n\nSix weeks.\n\n## 10. Recommendation\n\nDecision: **Go**\n`
}

process.stdout.write(`${JSON.stringify({ type: 'session', sessionId, cwd: process.cwd() })}\n`)
process.stdout.write(`${JSON.stringify({ type: 'status', phase: 'turn_start', turn: resumedSession === undefined ? 1 : 2 })}\n`)
process.stdout.write(`${JSON.stringify({ type: 'text', text })}\n`)
process.stdout.write(`${JSON.stringify({ type: 'final', sessionId, reason: { kind: 'completed' }, text })}\n`)
