import { describe, expect, it } from 'vitest'
import {
  composePdfInstruction,
  composePdfIntro,
  composeTextRequirement,
  formatBytes,
  hasPdfSignature,
  MAX_PDF_BYTES,
  validatePdfFile,
} from '../src/data/requirements.ts'

describe('requirement intake', () => {
  it('accepts PDFs up to 5 MB', () => {
    expect(validatePdfFile({ name: 'spec.PDF', size: MAX_PDF_BYTES, type: 'application/pdf' })).toBeUndefined()
    expect(validatePdfFile({ name: 'spec.pdf', size: 10, type: '' })).toBeUndefined()
  })

  it('rejects wrong extensions, types, empty and oversized files', () => {
    expect(validatePdfFile({ name: 'spec.docx', size: 10, type: 'application/pdf' })).toMatch(/\.pdf/)
    expect(validatePdfFile({ name: 'spec.pdf', size: 10, type: 'image/png' })).toMatch(/not a PDF/)
    expect(validatePdfFile({ name: 'spec.pdf', size: 0, type: 'application/pdf' })).toMatch(/empty/)
    expect(validatePdfFile({ name: 'spec.pdf', size: MAX_PDF_BYTES + 1, type: 'application/pdf' })).toMatch(/5 MB/)
  })

  it('checks the %PDF- signature', () => {
    expect(hasPdfSignature(new TextEncoder().encode('%PDF-1.7'))).toBe(true)
    expect(hasPdfSignature(new TextEncoder().encode('PK\u0003\u0004'))).toBe(false)
    expect(hasPdfSignature(new Uint8Array())).toBe(false)
  })

  it('composes the first messages', () => {
    expect(composeTextRequirement(' Build a todo app ', '')).toBe(
      'Here are the requirements for this project.\n\n## Project requirements\n\nBuild a todo app',
    )
    expect(composeTextRequirement('X', 'Focus on mobile')).toMatch(/^Focus on mobile\n\n## Project requirements/)
    expect(composePdfIntro('Alpha', 'spec.pdf', '')).toContain('“spec.pdf”')
    expect(composePdfIntro('Alpha', 'spec.pdf', 'Hi')).toMatch(/^Hi\n\n/)
    expect(composePdfInstruction('')).not.toContain('Notes from the user')
    expect(composePdfInstruction('Due Friday')).toContain('Notes from the user: Due Friday')
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
  })
})
