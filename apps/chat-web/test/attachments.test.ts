import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/api/client.ts'
import { attachmentMeta, checkInputFiles, describeAttachmentError, exportFailure, normalizeAttachment } from '../src/data/attachments.ts'

const pdf = (name: string, size = 1000) => ({ name, size, type: 'application/pdf' })

describe('attachments', () => {
  it('accepts PDFs and names every refusal', () => {
    const check = checkInputFiles([
      pdf('a.pdf'),
      { name: 'shot.PNG', size: 10, type: 'image/png' },
      { name: 'notes.docx', size: 10, type: '' },
      pdf('empty.pdf', 0),
      pdf('huge.pdf', 21 * 1024 * 1024),
    ], 0)
    expect(check.accepted.map((file) => file.name)).toEqual(['a.pdf'])
    expect(check.rejected).toHaveLength(4)
    expect(check.rejected[0]).toMatch(/images aren’t used by stage analysis/)
    expect(check.rejected[3]).toMatch(/20 MB/)
  })

  it('enforces 10 per upload and 20 per run', () => {
    const many = Array.from({ length: 12 }, (_, index) => pdf(`f${index}.pdf`))
    expect(checkInputFiles(many, 0).accepted).toHaveLength(10)
    expect(checkInputFiles(many.slice(0, 5), 18).accepted).toHaveLength(2)
    expect(checkInputFiles(many.slice(0, 5), 18).rejected[0]).toMatch(/at most 20/)
  })

  it('normalizes API attachments and formats their meta', () => {
    expect(normalizeAttachment(null)).toBeNull()
    expect(normalizeAttachment({ title: 'x' })).toBeNull()
    const item = normalizeAttachment({ id: 'a', filename: 'req.pdf', pages: 4, sizeBytes: 91234, truncated: true })!
    expect(item.title).toBe('req.pdf')
    expect(item.truncated).toBe(true)
    expect(attachmentMeta(item)).toBe('4 pages · 89 KB')
    expect(attachmentMeta({ pages: 1, sizeBytes: null })).toBe('1 page')
    expect(attachmentMeta({ pages: null, sizeBytes: null })).toBe('')
  })

  it('words upload errors the way the spec asks', () => {
    expect(describeAttachmentError(new ApiError(422, 'PDF_HAS_NO_TEXT', 'x'))).toMatch(/run OCR first/)
    expect(describeAttachmentError(new ApiError(415, 'UNSUPPORTED_FILE_TYPE', 'images are not used'))).toBe('images are not used')
    expect(describeAttachmentError(new ApiError(400, 'INVALID_PDF', 'x'))).toMatch(/could not be read as a PDF/)
    expect(describeAttachmentError(new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'x'))).toMatch(/refreshed/)
  })

  it('reads the newest export failure and clears it after a success', () => {
    const failed = { type: 'document_export_failed', payload: { message: 'boom' } }
    expect(exportFailure([])).toBeNull()
    expect(exportFailure([failed])).toBe('boom')
    expect(exportFailure([failed, { type: 'document_exported', payload: {} }])).toBeNull()
    expect(exportFailure([{ type: 'document_export_failed', payload: {} }])).toBe('The renderer reported an error.')
  })
})
