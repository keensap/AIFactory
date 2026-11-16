import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PostgresProjectStore } from '../src/projects.ts'
import { PostgresProjectWorkspace } from '../src/workspace.ts'
import { makePdf } from './support/pdf-fixtures.ts'

const url = process.env.AIFACTORY_TEST_DATABASE_URL
const skip = url === undefined || url === '' ? 'AIFACTORY_TEST_DATABASE_URL is not set' : false

async function setup() {
  const store = new PostgresProjectStore(url!)
  const workspace = new PostgresProjectWorkspace(url!)
  await store.migrate()
  await workspace.migrate()
  const root = mkdtempSync(join(tmpdir(), 'aifactory-attach-'))
  const project = await store.create({ name: `Attach ${Date.now()}`, rootPath: root, organization: null, ownerEmail: null, status: 'inactive' })
  return {
    store, workspace, project, root,
    cleanup: async () => {
      await workspace.close()
      await store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('a PDF attachment is stored outside the documents tree and its text is cached', { skip }, async () => {
  const t = await setup()
  try {
    const pdf = await makePdf(['The portal must show invoices.', 'Customers want card payments.'])
    const attachment = await t.workspace.addAttachment({
      project: t.project, stage: 'planning', filename: 'requirements brief.pdf', mimeType: 'application/pdf', buffer: pdf,
    })
    assert.equal(attachment.title, 'requirements brief', 'title defaults to the file name without .pdf')
    assert.ok(attachment.pages >= 1)
    assert.ok(attachment.characters > 20)
    assert.equal(attachment.truncated, false)
    assert.ok(attachment.storagePath.startsWith('.aifactory/attachments/'), attachment.storagePath)
    assert.ok(existsSync(join(t.root, attachment.storagePath)))
    assert.ok(existsSync(join(t.root, attachment.textPath)))

    const text = await t.workspace.readAttachmentText(attachment, t.root)
    assert.match(text, /portal must show invoices/)

    const listed = await t.workspace.listAttachments(t.project.id)
    assert.equal(listed.length, 1)
    assert.equal((await t.workspace.getAttachment(t.project.id, attachment.id))?.id, attachment.id)
    assert.equal(await t.workspace.getAttachment('00000000-0000-0000-0000-000000000000', attachment.id), undefined)
  } finally {
    await t.cleanup()
  }
})

test('attachments link to a run and deleting one removes its files', { skip }, async () => {
  const t = await setup()
  try {
    const pdf = await makePdf(['Attachment content'])
    const attachment = await t.workspace.addAttachment({ project: t.project, filename: 'a.pdf', mimeType: 'application/pdf', buffer: pdf })
    const run = await t.workspace.createStageRun({ projectId: t.project.id, stage: 'planning', context: {}, contextHash: 'h' })
    await t.workspace.linkRunAttachments(run.id, [attachment.id])
    await t.workspace.linkRunAttachments(run.id, [attachment.id]) // idempotent
    assert.deepEqual((await t.workspace.listRunAttachments(run.id)).map((entry) => entry.id), [attachment.id])

    const directory = join(t.root, '.aifactory', 'attachments', attachment.id)
    assert.ok(existsSync(directory))
    assert.equal(await t.workspace.deleteAttachment(t.project.id, attachment.id, t.root), true)
    assert.equal(existsSync(directory), false)
    assert.equal(await t.workspace.deleteAttachment(t.project.id, attachment.id, t.root), false)
    assert.deepEqual(await t.workspace.listRunAttachments(run.id), [])
  } finally {
    await t.cleanup()
  }
})

test('an export path is recorded and surfaces on the run detail', { skip }, async () => {
  const t = await setup()
  try {
    const run = await t.workspace.createStageRun({ projectId: t.project.id, stage: 'planning', context: {}, contextHash: 'h' })
    const document = await t.workspace.addDocument({
      project: t.project, stage: 'planning', kind: 'telos_report', title: 'TELOS feasibility report',
      filename: 'telos.md', mimeType: 'text/markdown', buffer: Buffer.from('# TELOS'), stageRunId: run.id,
    })
    assert.equal((await t.workspace.getStageRunDetail(run.id))?.documents[0]?.exportPath, undefined)

    await t.workspace.recordDocumentExport({ documentId: document.id, projectId: t.project.id, path: 'documents/planning/TELOS.pdf', bytes: 1234 })
    const detail = await t.workspace.getStageRunDetail(run.id)
    assert.equal(detail?.documents[0]?.exportPath, 'documents/planning/TELOS.pdf')
    const exports = await t.workspace.listDocumentExports([document.id])
    assert.equal(exports.get(document.id)?.bytes, 1234)

    // Re-exporting replaces the record rather than duplicating it.
    await t.workspace.recordDocumentExport({ documentId: document.id, projectId: t.project.id, path: 'documents/planning/TELOS.pdf', bytes: 2000 })
    assert.equal((await t.workspace.listDocumentExports([document.id])).get(document.id)?.bytes, 2000)
  } finally {
    await t.cleanup()
  }
})

test('a PDF with no extractable text is rejected at upload', { skip }, async () => {
  const t = await setup()
  try {
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    doc.addPage([595, 842])
    const blank = Buffer.from(await doc.save())
    await assert.rejects(
      () => t.workspace.addAttachment({ project: t.project, filename: 'scan.pdf', mimeType: 'application/pdf', buffer: blank }),
      (error: unknown) => (error as { code?: string }).code === 'PDF_HAS_NO_TEXT',
    )
    assert.deepEqual(await t.workspace.listAttachments(t.project.id), [])
  } finally {
    await t.cleanup()
  }
})
