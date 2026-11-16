import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AttachmentError,
  MAX_ATTACHMENT_BYTES,
  PROMPT_CHARS_PER_ATTACHMENT,
  PROMPT_CHARS_TOTAL,
  assertSupportedUpload,
  renderAttachmentPrompt,
} from '../src/attachments.ts'

const pdf = { filename: 'brief.pdf', mimeType: 'application/pdf', size: 1024 }

test('a PDF is accepted by extension or by content type', () => {
  assert.doesNotThrow(() => assertSupportedUpload(pdf))
  assert.doesNotThrow(() => assertSupportedUpload({ filename: 'noext', mimeType: 'application/pdf', size: 1 }))
  assert.doesNotThrow(() => assertSupportedUpload({ filename: 'BRIEF.PDF', mimeType: 'application/octet-stream', size: 1 }))
})

test('images are rejected with an explanation, not silently ignored', () => {
  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
    assert.throws(
      () => assertSupportedUpload({ filename: 'diagram.png', mimeType, size: 10 }),
      (error: unknown) => error instanceof AttachmentError
        && error.status === 415
        && error.code === 'UNSUPPORTED_FILE_TYPE'
        && /image/i.test(error.message)
        && /not used by stage analysis/i.test(error.message),
      mimeType,
    )
  }
})

test('other non-PDF files are rejected', () => {
  for (const [filename, mimeType] of [['notes.txt', 'text/plain'], ['spec.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['sheet.csv', 'text/csv']]) {
    assert.throws(
      () => assertSupportedUpload({ filename: filename!, mimeType: mimeType!, size: 10 }),
      (error: unknown) => error instanceof AttachmentError && error.code === 'UNSUPPORTED_FILE_TYPE' && /PDF files only/.test(error.message),
      filename,
    )
  }
})

test('oversized and empty files are rejected', () => {
  assert.throws(
    () => assertSupportedUpload({ ...pdf, size: MAX_ATTACHMENT_BYTES + 1 }),
    (error: unknown) => error instanceof AttachmentError && error.status === 413 && error.code === 'ATTACHMENT_TOO_LARGE',
  )
  assert.throws(
    () => assertSupportedUpload({ ...pdf, size: 0 }),
    (error: unknown) => error instanceof AttachmentError && error.code === 'EMPTY_ATTACHMENT',
  )
})

test('the prompt section names each document and includes its text', () => {
  const rendered = renderAttachmentPrompt([
    { title: 'Requirements brief', filename: 'brief.pdf', pages: 3, characters: 20, text: 'The portal must show invoices.' },
  ])
  assert.ok(rendered.startsWith('INPUT DOCUMENTS'))
  assert.ok(rendered.includes('Input document 1: Requirements brief'))
  assert.ok(rendered.includes('file: brief.pdf · pages: 3'))
  assert.ok(rendered.includes('The portal must show invoices.'))
  assert.ok(!rendered.includes('[Truncated'))
})

test('no attachments renders nothing, so prompts can say so themselves', () => {
  assert.equal(renderAttachmentPrompt([]), '')
})

test('a long document is truncated per document and says so', () => {
  const text = 'x'.repeat(PROMPT_CHARS_PER_ATTACHMENT + 5000)
  const rendered = renderAttachmentPrompt([{ title: 'Big', filename: 'big.pdf', pages: 100, characters: text.length, text }])
  const body = rendered.split('\n\n').slice(2).join('\n\n')
  assert.ok(body.length < text.length + 200, 'the body is capped')
  assert.ok(rendered.includes('[Truncated for the prompt'))
})

test('the total budget across documents is respected', () => {
  const each = 'y'.repeat(PROMPT_CHARS_PER_ATTACHMENT)
  const many = Array.from({ length: 5 }, (_, index) => ({
    title: `Doc ${index + 1}`, filename: `d${index}.pdf`, pages: 1, characters: each.length, text: each,
  }))
  const rendered = renderAttachmentPrompt(many)
  const included = rendered.split('\n\n').filter((part) => /^y+$/.test(part)).join('')
  assert.ok(included.length <= PROMPT_CHARS_TOTAL, `included ${included.length}`)
  assert.ok(rendered.includes('[Omitted: the prompt document budget is exhausted.]'))
})

test('every document gets a heading even when the budget is exhausted', () => {
  const big = 'z'.repeat(PROMPT_CHARS_PER_ATTACHMENT)
  const docs = Array.from({ length: 4 }, (_, index) => ({ title: `Doc ${index + 1}`, filename: `d${index}.pdf`, pages: 1, characters: big.length, text: big }))
  const rendered = renderAttachmentPrompt(docs)
  for (let index = 1; index <= 4; index++) assert.ok(rendered.includes(`Input document ${index}: Doc ${index}`))
})
