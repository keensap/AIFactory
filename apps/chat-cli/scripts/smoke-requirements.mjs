#!/usr/bin/env node
/**
 * Opt-in live smoke test: Planning → Requirements against a running AI Factory
 * API with a working generation model. Not part of `npm test` (it spends model
 * tokens and takes minutes); run it by hand or in a gated CI job.
 *
 *   AIFACTORY_SMOKE_API      API base URL (default http://127.0.0.1:8787)
 *   AIFACTORY_API_TOKEN      bearer token, when the API requires one
 *   AIFACTORY_SMOKE_ROOT     project root to create (default: a new temp dir);
 *                            must be readable and writable by the API process
 *   AIFACTORY_SMOKE_BRIEF    brief for both stages (default: a clinic booking portal)
 *   AIFACTORY_SMOKE_REFINES  extra refine passes allowed at the requirements gate (default 1)
 *   AIFACTORY_SMOKE_WAIVER   if set, approve remaining coverage blockers with this audited reason;
 *                            otherwise remaining blockers fail the smoke and leave the run at its gate
 *   AIFACTORY_SMOKE_TIMEOUT_MS  per-run wait (default 45 min)
 *   AIFACTORY_SMOKE_KEEP=1   keep the registry project afterwards (default: delete it; files stay)
 *
 * Exit codes: 0 pass, 1 quality or lifecycle failure, 2 environment/setup failure.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const api = (process.env.AIFACTORY_SMOKE_API ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const token = process.env.AIFACTORY_API_TOKEN
const timeoutMs = Number(process.env.AIFACTORY_SMOKE_TIMEOUT_MS ?? 45 * 60_000)
const refines = Number(process.env.AIFACTORY_SMOKE_REFINES ?? 1)
const waiver = process.env.AIFACTORY_SMOKE_WAIVER?.trim() || undefined
const keep = process.env.AIFACTORY_SMOKE_KEEP === '1'
const brief = process.env.AIFACTORY_SMOKE_BRIEF ?? `Build a web portal for a small chain of three physiotherapy clinics.
Patients book, reschedule and cancel appointments online and receive email and SMS reminders.
Front-desk staff manage practitioner calendars and walk-ins; practitioners see their day list and record attendance.
Clinic managers want fewer no-shows (target: from 12% to under 6%) and a weekly utilisation report.
Constraints: GDPR applies (patients in the EU), the existing practice-management system exposes a REST API for patient records,
budget is two developers for four months, and the portal must work on mobile browsers.`

const report = { api, startedAt: new Date().toISOString(), steps: [], checks: [] }
const log = (message) => process.stdout.write(`[smoke] ${message}\n`)
const step = (name, data = {}) => { report.steps.push({ at: new Date().toISOString(), name, ...data }); log(name) }
const check = (name, ok, detail) => { report.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`); return ok }

class SetupError extends Error {}

async function call(method, path, body, { allow = [] } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  const json = text === '' ? {} : JSON.parse(text)
  if (!response.ok && !allow.includes(response.status)) {
    const error = new Error(`${method} ${path} → ${response.status} ${json.error?.code ?? ''}: ${json.error?.message ?? text.slice(0, 300)}`)
    error.status = response.status
    error.code = json.error?.code
    throw error
  }
  return { status: response.status, body: json }
}

async function waitForGate(runId, label) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const { run } = (await call('GET', `/api/stage-runs/${runId}`)).body
    if (run.status !== last) { log(`${label}: ${run.status}`); last = run.status }
    if (['awaiting_human', 'completed', 'failed', 'cancelled'].includes(run.status)) return run
    await sleep(5000)
  }
  throw new Error(`${label} did not reach a gate within ${Math.round(timeoutMs / 60_000)} min`)
}

async function events(runId) {
  const all = []
  let after = '0'
  for (;;) {
    const { events: page, nextAfter } = (await call('GET', `/api/stage-runs/${runId}/events?after=${after}&limit=500`)).body
    all.push(...page)
    if (page.length < 500) return all
    after = nextAfter
  }
}

function blocking(run) {
  return (run.pendingGate?.coverage?.findings ?? []).filter((finding) => finding.severity === 'blocking')
}

async function main() {
  const health = await call('GET', '/api/health').catch((error) => { throw new SetupError(`API unreachable at ${api}: ${error.message}`) })
  if (health.body.database !== 'postgres') throw new SetupError('the API has no database; stage runs need PostgreSQL')
  const stages = (await call('GET', '/api/sdlc/stages')).body.stages
  for (const key of ['planning', 'requirements']) {
    if (stages.find((stage) => stage.key === key)?.executable !== true) throw new SetupError(`the API cannot execute the ${key} stage`)
  }
  const models = (await call('GET', '/api/settings/models', undefined, { allow: [404, 503] })).body
  step('environment', { version: health.body.version, harness: health.body.harness?.profile ?? null, modelSource: models.source ?? null, model: models.target ?? null })

  const root = process.env.AIFACTORY_SMOKE_ROOT ?? mkdtempSync(join(tmpdir(), 'aifactory-smoke-'))
  mkdirSync(root, { recursive: true })
  const out = join(root, 'smoke-report')
  mkdirSync(out, { recursive: true })
  report.root = root

  const { project } = (await call('POST', '/api/projects', {
    name: `Requirements smoke ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    rootPath: root,
    status: 'inactive',
  })).body
  report.projectId = project.id
  step('project created', { projectId: project.id, root })

  try {
    // ---- planning: the baseline the requirements stage starts from -------------
    const { run: planningStart } = (await call('POST', `/api/projects/${project.id}/stages/planning/runs`, { brief })).body
    await call('POST', `/api/stage-runs/${planningStart.id}/execute`)
    const planning = await waitForGate(planningStart.id, 'planning')
    if (!check('planning reaches its final gate', planning.status === 'awaiting_human', planning.status === 'failed' ? planning.summaryMarkdown : planning.status)) return false
    const planned = (await call('POST', `/api/stage-runs/${planning.id}/decision`, { decision: 'go', note: 'Live smoke test' })).body.run
    check('planning completes with a TELOS report', planned.status === 'completed' && planned.documents.some((document) => document.kind === 'telos_report'))
    await call('PATCH', `/api/projects/${project.id}/stage`, { stage: 'requirements' })
    step('advanced to requirements', { planningRunId: planning.id })

    // ---- requirements ---------------------------------------------------------
    const { run: reqStart } = (await call('POST', `/api/projects/${project.id}/stages/requirements/runs`, { brief })).body
    report.requirementsRunId = reqStart.id
    const baseline = reqStart.context?.baselineEvidence ?? []
    check('the approved planning baseline is frozen into the run', baseline.some((entry) => entry.status === 'available'))
    await call('POST', `/api/stage-runs/${reqStart.id}/execute`)
    let run = await waitForGate(reqStart.id, 'requirements')
    if (!check('requirements reaches its final gate', run.status === 'awaiting_human', run.status === 'failed' ? run.summaryMarkdown : run.status)) return false

    const record = (label, current) => {
      const gate = current.pendingGate
      const counts = gate?.coverage?.counts
      step(`requirements gate (${label})`, {
        cycle: gate?.cycle, rating: gate?.rating, accepted: gate?.accepted, reviewDecision: gate?.reviewDecision,
        reviewCounts: gate?.counts, coverage: counts,
        blocking: blocking(current).map((finding) => `${finding.code}${finding.requirementId ? ` ${finding.requirementId}` : ''}`),
        advisory: (gate?.coverage?.findings ?? []).filter((finding) => finding.severity === 'advisory').length,
      })
      writeFileSync(join(out, `requirements-draft-${label}.md`), current.draftMarkdown ?? '')
    }
    record('initial', run)
    check('the gate carries a coverage report', run.pendingGate?.coverage?.counts !== undefined)
    check('the draft declares requirements', (run.pendingGate?.coverage?.counts?.totalRequirements ?? 0) > 0)

    for (let pass = 1; pass <= refines && blocking(run).length > 0; pass++) {
      run = (await call('POST', `/api/stage-runs/${run.id}/decision`, { refine: true })).body.run
      if (run.status !== 'awaiting_human') run = await waitForGate(run.id, `requirements refine ${pass}`)
      record(`refine-${pass}`, run)
    }

    // Ordinary approval must be refused while deterministic blockers remain.
    const remaining = blocking(run)
    if (remaining.length > 0) {
      const refused = await call('POST', `/api/stage-runs/${run.id}/decision`, { decision: 'approved' }, { allow: [409] })
      check('ordinary approval is refused while coverage blockers remain', refused.status === 409 && refused.body.error?.code === 'REQUIREMENTS_COVERAGE_BLOCKED')
      if (waiver === undefined) {
        return check('the model produced a contract-complete specification', false, `${remaining.length} blocking finding(s) remain; set AIFACTORY_SMOKE_WAIVER to approve with an audited waiver`)
      }
    }
    // Model findings do not block approval (only deterministic coverage does), so
    // an unaccepted review is reported for the human, not failed by the smoke.
    if (run.pendingGate?.accepted !== true) {
      report.warnings = [...(report.warnings ?? []), `model review not accepted at the gate: rating ${run.pendingGate?.rating}, ${JSON.stringify(run.pendingGate?.counts)}; approving because a human would decide here`]
      log(`WARN ${report.warnings.at(-1)}`)
    }
    const decided = (await call('POST', `/api/stage-runs/${run.id}/decision`, {
      decision: 'approved',
      note: 'Live smoke test',
      ...(remaining.length > 0 ? { coverageWaiverReason: waiver } : {}),
    })).body.run
    check(remaining.length > 0 ? 'approval with an audited waiver completes' : 'approval completes', decided.status === 'completed')
    const spec = decided.documents.find((document) => document.kind === 'requirements_spec')
    check('a requirements_spec document is published', spec !== undefined, spec?.storagePath)

    const runEvents = await events(decided.id)
    const exported = runEvents.find((event) => event.type === 'document_exported')
    const exportFailed = runEvents.find((event) => event.type === 'document_export_failed')
    check('the PDF is exported', exported !== undefined && exportFailed === undefined, exported?.payload?.path ?? exportFailed?.payload?.message)
    const human = runEvents.find((event) => event.type === 'human_decision')
    if (remaining.length > 0) check('the waiver is recorded with the decision', human?.payload?.coverageWaiver?.reason === waiver)
    check('the run summary is titled for requirements, not planning', !/^# .*(Planning|TELOS)/m.test(decided.summaryMarkdown ?? ''), (decided.summaryMarkdown ?? '').split('\n')[0])
    if (typeof exported?.payload?.path === 'string') check('the PDF is named for the requirements specification', !/TELOS/i.test(exported.payload.path), exported.payload.path)
    writeFileSync(join(out, 'requirements-summary.md'), decided.summaryMarkdown ?? '')
    return report.checks.every((entry) => entry.ok)
  } finally {
    report.finishedAt = new Date().toISOString()
    writeFileSync(join(out, 'smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    log(`report: ${join(out, 'smoke-report.json')}`)
    if (!keep) {
      await call('DELETE', `/api/projects/${project.id}`, undefined, { allow: [404, 409] }).catch((error) => log(`cleanup: ${error.message}`))
    }
  }
}

main().then(
  (passed) => { log(passed ? 'smoke PASSED' : 'smoke FAILED'); process.exitCode = passed ? 0 : 1 },
  (error) => { log(`${error instanceof SetupError ? 'setup' : 'error'}: ${error.message}`); process.exitCode = error instanceof SetupError ? 2 : 1 },
)
