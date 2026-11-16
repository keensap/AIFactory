import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshHarness } from '../src/harness.ts'
import { ProjectService } from '../src/projects.ts'
import { PostgresProjectStore } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import { createChatServer, serverPort } from '../src/server.ts'
import { PlanningStageRuntime } from '../src/stage-runtime.ts'
import { SessionStore } from '../src/store.ts'
import { PostgresProjectWorkspace } from '../src/workspace.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'
import { makePdf } from './support/pdf-fixtures.ts'

const url = process.env.AIFACTORY_TEST_DATABASE_URL
const skip = url === undefined || url === '' ? 'AIFACTORY_TEST_DATABASE_URL is not set' : false

async function withApi(run: (context: { base: string; projectId: string; root: string }) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-attach-api-'))
  const root = mkdtempSync(join(tmpdir(), 'aifactory-attach-project-'))
  const store = new PostgresProjectStore(url!)
  const workspace = new PostgresProjectWorkspace(url!)
  await store.migrate()
  await workspace.migrate()
  const projects = new ProjectService(store, new SettingsService(new MemorySettingsStore()))
  const project = await projects.create({ name: 'ABCClothing', rootPath: root, organization: null, ownerEmail: null, status: 'inactive' })
  const runtime = new PlanningStageRuntime({
    projects,
    workspace,
    harnessFactory: () => { throw new Error('not used') },
    runPrompt: async (role) => {
      if (role === 'analyzer') return '# Analysis'
      if (role === 'author') return '# TELOS Feasibility Report\n\n## 10. Recommendation\n\nDecision: **Go**\n'
      return '{"decision":"approved","findings":[]}'
    },
  })
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    projects,
    workspace,
    stageRuntime: runtime,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    await run({ base: `http://127.0.0.1:${serverPort(server)}`, projectId: project.id, root })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await workspace.close()
    await store.close()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}

async function upload(base: string, projectId: string, files: Array<{ name: string; bytes: Buffer; type: string }>, field = 'files'): Promise<Response> {
  const form = new FormData()
  for (const file of files) form.append(field, new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name)
  return fetch(`${base}/api/projects/${projectId}/attachments`, { method: 'POST', body: form })
}

test('several PDFs upload in one request', { skip }, async () => {
  await withApi(async ({ base, projectId }) => {
    const first = await makePdf(['Requirements: the portal must show invoices.'])
    const second = await makePdf(['Constraints: launch in Q2.'])
    const response = await upload(base, projectId, [
      { name: 'requirements brief.pdf', bytes: first, type: 'application/pdf' },
      { name: 'constraints.pdf', bytes: second, type: 'application/pdf' },
    ])
    assert.equal(response.status, 201)
    const body = await response.json() as { attachments: Array<{ id: string; title: string; pages: number; filename: string }> }
    assert.equal(body.attachments.length, 2)
    assert.deepEqual(body.attachments.map((entry) => entry.title).sort(), ['constraints', 'requirements brief'])
    assert.ok(body.attachments.every((entry) => entry.pages >= 1))

    const listed = await (await fetch(`${base}/api/projects/${projectId}/attachments`)).json() as { attachments: unknown[] }
    assert.equal(listed.attachments.length, 2)

    const content = await fetch(`${base}/api/projects/${projectId}/attachments/${body.attachments[0]!.id}/content`)
    assert.equal(content.status, 200)
    assert.equal(Buffer.from(await content.arrayBuffer()).subarray(0, 5).toString(), '%PDF-')

    const removed = await fetch(`${base}/api/projects/${projectId}/attachments/${body.attachments[0]!.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 204)
    const after = await (await fetch(`${base}/api/projects/${projectId}/attachments`)).json() as { attachments: unknown[] }
    assert.equal(after.attachments.length, 1)
  })
})

test('an image is rejected with an actionable message', { skip }, async () => {
  await withApi(async ({ base, projectId }) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const response = await upload(base, projectId, [{ name: 'diagram.png', bytes: png, type: 'image/png' }])
    assert.equal(response.status, 415)
    const body = await response.json() as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'UNSUPPORTED_FILE_TYPE')
    assert.match(body.error.message, /not used by stage analysis/)
  })
})

test('a run consumes its attachments and exports the PDF into the project documents tree', { skip }, async () => {
  await withApi(async ({ base, projectId, root }) => {
    const pdf = await makePdf(['The portal must show invoices and accept card payments.'])
    const uploaded = await upload(base, projectId, [{ name: 'requirements brief.pdf', bytes: pdf, type: 'application/pdf' }])
    const attachment = (await uploaded.json() as { attachments: Array<{ id: string }> }).attachments[0]!

    const created = await fetch(`${base}/api/projects/${projectId}/stages/planning/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief: 'Build a customer portal', attachmentIds: [attachment.id] }),
    })
    assert.equal(created.status, 201)
    const runId = (await created.json() as { run: { id: string } }).run.id

    const executed = await fetch(`${base}/api/stage-runs/${runId}/execute?wait=1`, { method: 'POST' })
    assert.equal(executed.status, 200)
    const gated = await executed.json() as { run: { pendingGate: { kind: string } | null } }
    assert.equal(gated.run.pendingGate?.kind, 'final')

    const decided = await fetch(`${base}/api/stage-runs/${runId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'go' }),
    })
    assert.equal(decided.status, 200)

    const expected = join(root, 'documents', 'planning', 'TELOS Feasibility Report — ABCClothing.pdf')
    assert.ok(existsSync(expected), `expected ${expected}`)
    assert.equal(readFileSync(expected).subarray(0, 5).toString(), '%PDF-')

    const detail = await (await fetch(`${base}/api/stage-runs/${runId}`)).json() as {
      run: { documents: Array<{ exportPath?: string }> }
    }
    assert.equal(detail.run.documents[0]?.exportPath, 'documents/planning/TELOS Feasibility Report — ABCClothing.pdf')

    const reexport = await fetch(`${base}/api/stage-runs/${runId}/export`, { method: 'POST' })
    assert.equal(reexport.status, 200)
    const body = await reexport.json() as { export: { path: string; bytes: number } }
    assert.equal(body.export.path, 'documents/planning/TELOS Feasibility Report — ABCClothing.pdf')
    assert.ok(body.export.bytes > 1000)
  })
})

test('a run referencing an attachment from another project is rejected', { skip }, async () => {
  await withApi(async ({ base, projectId }) => {
    const response = await fetch(`${base}/api/projects/${projectId}/stages/planning/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief: 'x', attachmentIds: ['00000000-0000-0000-0000-000000000000'] }),
    })
    assert.equal(response.status, 404)
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'ATTACHMENT_NOT_FOUND')
  })
})

test('attachment ids must be an array of strings', { skip }, async () => {
  await withApi(async ({ base, projectId }) => {
    const response = await fetch(`${base}/api/projects/${projectId}/stages/planning/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief: 'x', attachmentIds: [1, 2] }),
    })
    assert.equal(response.status, 400)
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'INVALID_ATTACHMENTS')
  })
})
