// Browser smoke against a running Chat Web and mock API (no DSH needed).
// Set PLAYWRIGHT_MODULE to the absolute path of a cached Playwright package if
// it isn't installed locally; set PLAYWRIGHT_BROWSERS_PATH to its browser cache.
// Optional: UI=http://127.0.0.1:5173 API=http://127.0.0.1:8788
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const api = process.env.API ?? 'http://127.0.0.1:8788'
const ui = process.env.UI ?? 'http://127.0.0.1:5173'

async function call(method, path, body) {
  const response = await fetch(new URL(path, api), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${response.ok ? '' : await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}

const health = await call('GET', '/api/health')
assert.match(health.version, /-mock$/, 'The browser smoke must use the mock API')
const created = await call('POST', '/api/projects', {
  name: 'Requirements browser smoke', rootPath: `/mock/requirements-${randomUUID()}`, status: 'active',
})
const project = `/api/projects/${created.project.id}`
try {
  const { run: planning } = await call('POST', `${project}/stages/planning/runs`, { brief: 'Record requests.' })
  const planRun = `/api/stage-runs/${planning.id}`
  await call('POST', `${planRun}/execute`)
  for (let i = 0; i < 120; i++) {
    const { run } = await call('GET', planRun)
    if (run.status === 'awaiting_human') break
    assert.ok(i < 119 && run.status !== 'failed', run.summaryMarkdown ?? 'Planning did not reach the gate')
    await sleep(200)
  }
  await call('POST', `${planRun}/decision`, { decision: 'go' })
  await call('PATCH', `${project}/stage`, { stage: 'requirements' })

  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(15_000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript((url) => localStorage.setItem('aifactory.chat-web.settings.v1', JSON.stringify({ apiBaseUrl: url, apiToken: '' })), api)
    const stageUrl = new URL(`/#/projects/${created.project.id}/stages/requirements`, ui)
    await page.goto(stageUrl.href)
    const start = async (brief) => {
      await page.getByRole('textbox', { name: 'Requirements brief', exact: true }).fill(brief)
      await page.getByRole('button', { name: 'Start requirements run' }).click()
      await page.waitForURL('**/stages/requirements/runs/*')
      return `/api/stage-runs/${page.url().split('/').at(-1)}`
    }
    const runPath = await start('COVERAGE Record operator requests.')
    const gate = page.getByRole('region', { name: 'Requirements approval' })
    const approve = gate.getByRole('button', { name: 'Approve requirements', exact: true })
    await gate.getByText('Ordinary approval is blocked.', { exact: false }).waitFor()
    assert.ok(await approve.isDisabled())
    await gate.getByText('Preview draft', { exact: true }).click()
    await gate.getByRole('heading', { name: '5. Acceptance criteria' }).waitFor()
    await gate.getByLabel('Decision note').fill('Add an acceptance criterion.')
    await gate.getByRole('button', { name: 'Reject draft' }).click()
    await page.getByRole('button', { name: 'Record rejection' }).click()
    await gate.getByText('Rejection recorded.', { exact: true }).waitFor()
    assert.deepEqual((await call('GET', runPath)).run.documents, [])
    await page.reload()
    await gate.getByText('Rejection recorded.', { exact: true }).waitFor()
    await gate.getByRole('button', { name: 'Refine further' }).click()
    await gate.getByText('No blocking coverage findings.', { exact: true }).waitFor()
    await approve.click()
    await gate.waitFor({ state: 'hidden' })
    const approved = (await call('GET', runPath)).run
    assert.equal(approved.status, 'completed')
    assert.equal(approved.documents[0].kind, 'requirements_spec')
    await page.getByRole('heading', { name: /Requirements specification/i }).first().waitFor()

    await page.goto(stageUrl.href)
    const waiverRunPath = await start('COVERAGE_STICKY Record operator requests.')
    await gate.getByText('Request a coverage waiver', { exact: true }).click()
    const startWaiver = gate.getByRole('button', { name: 'Approve with coverage waiver' })
    assert.ok(await startWaiver.isDisabled())
    await gate.getByLabel('Coverage waiver reason').fill('Deferred this criterion to beta.')
    await startWaiver.click()
    await page.getByRole('button', { name: 'Approve with waiver', exact: true }).click()
    await gate.waitFor({ state: 'hidden' })
    const waived = (await call('GET', waiverRunPath)).run
    assert.equal(waived.status, 'completed')
    assert.match(waived.summaryMarkdown, /Deferred this criterion to beta\./)
    assert.deepEqual(errors, [])
    console.log('Requirements browser smoke passed: blocked approval, reject + reload, refine, approve, artifact, and audited waiver.')
  } finally {
    await browser.close()
  }
} finally {
  await call('DELETE', project)
}
