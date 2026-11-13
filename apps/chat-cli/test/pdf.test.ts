import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PdfReviewService, parsePdfAnalysis } from '../src/pdf-review.ts'
import { extractPdfText } from '../src/pdf.ts'
import { ProjectService } from '../src/projects.ts'
import { SettingsService } from '../src/settings.ts'
import { SessionStore } from '../src/store.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const fixture = readFileSync(new URL('./fixtures/requirements.pdf', import.meta.url))

test('extracts requirement text from a PDF', async () => {
  const result = await extractPdfText(fixture)
  assert.equal(result.pages, 1)
  assert.ok(result.characters > 100)
  assert.match(result.text, /Customer Portal Requirements/)
  assert.match(result.text, /Customers can pay an invoice by card/)
  assert.equal(result.truncated, false)
})

test('parses review, question and fallback analysis shapes', () => {
  const review = parsePdfAnalysis(JSON.stringify({
    type: 'review',
    decision: 'complete',
    markdown: '# Review\n\nLooks complete.',
  }))
  assert.equal(review.type, 'review')
  assert.equal(review.decision, 'complete')

  const fenced = parsePdfAnalysis('```json\n{"type":"questions","questions":["Who are the users?","What is out of scope?"]}\n```')
  assert.equal(fenced.type, 'questions')
  if (fenced.type === 'questions') {
    assert.equal(fenced.questions.length, 2)
    assert.match(fenced.markdown, /Open Questions/)
  }

  const fallback = parsePdfAnalysis('# Plain review\n\nA useful answer.')
  assert.equal(fallback.type, 'review')
  assert.equal(fallback.decision, 'needs_revision')
  assert.match(fallback.markdown, /Plain review/)
})

test('reviews a PDF with project context and binds an unbound session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-pdf-project-'))
  try {
    const projects = new ProjectService(
      new MemoryProjectStore(),
      new SettingsService(new MemorySettingsStore()),
    )
    const project = await projects.create({ name: 'Portal', rootPath: root, status: 'active' })
    const sessions = new SessionStore()
    sessions.recordTurn('session-pdf-1', 'Earlier chat', 'Earlier answer')

    let seenPrompt = ''
    const service = new PdfReviewService({
      projects,
      sessions,
      harnessFactory: () => { throw new Error('harness should not be used when runPrompt is injected') },
      runPrompt: async (prompt) => {
        seenPrompt = prompt
        return JSON.stringify({
          type: 'review',
          decision: 'needs_revision',
          markdown: '# Requirement Review\n\n## Summary\n\nNeeds a payment provider decision.',
        })
      },
    })

    const result = await service.review({
      projectId: project.id,
      sessionId: 'session-pdf-1',
      message: 'Please review this requirement document.',
      filename: 'requirements.pdf',
      pdf: fixture,
    })

    assert.equal(result.analysis.type, 'review')
    assert.equal(result.document.pages, 1)
    assert.equal(sessions.get('session-pdf-1')?.projectId, project.id)
    assert.equal(sessions.get('session-pdf-1')?.messages.length, 4)
    assert.match(seenPrompt, /Portal/)
    assert.match(seenPrompt, /Customer Portal Requirements/)
    assert.match(seenPrompt, /untrusted data/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('returns questions instead of inventing requirements', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-pdf-questions-'))
  try {
    const projects = new ProjectService(
      new MemoryProjectStore(),
      new SettingsService(new MemorySettingsStore()),
    )
    const project = await projects.create({ name: 'Vague', rootPath: root })
    const sessions = new SessionStore()
    sessions.recordTurn('session-pdf-2', 'Earlier', 'Earlier answer', { projectId: project.id })

    const service = new PdfReviewService({
      projects,
      sessions,
      harnessFactory: () => { throw new Error('unused') },
      runPrompt: async () => JSON.stringify({
        type: 'questions',
        questions: ['Who is the target user?', 'What is explicitly out of scope?'],
      }),
    })

    const result = await service.review({
      projectId: project.id,
      sessionId: 'session-pdf-2',
      message: 'Review this.',
      filename: 'vague.pdf',
      pdf: fixture,
    })

    assert.equal(result.analysis.type, 'questions')
    if (result.analysis.type === 'questions') {
      assert.equal(result.analysis.questions.length, 2)
      assert.equal(result.analysis.decision, 'questions_required')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
