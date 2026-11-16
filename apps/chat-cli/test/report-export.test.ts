import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EXPORT_ROOT, ExportError, exportFileName, exportTarget, safeFileStem, writeExport } from '../src/report/export.ts'

test('the file name matches the requested convention', () => {
  assert.equal(exportFileName('TELOS Feasibility Report', 'ABCClothing'), 'TELOS Feasibility Report — ABCClothing.pdf')
})

test('unsafe characters are removed but the title stays readable', () => {
  assert.equal(safeFileStem('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j')
  assert.equal(safeFileStem('  leading and trailing  '), 'leading and trailing')
  assert.equal(safeFileStem('...dots...'), 'dots')
  assert.equal(safeFileStem('café — Ünïcode'), 'café — Ünïcode', 'accents and the em dash survive')
  assert.equal(safeFileStem('x'.repeat(200)).length, 120)
  assert.equal(safeFileStem('   '), 'document')
  assert.equal(safeFileStem('tab\tnewline\nhere'), 'tab newline here')
})

test('the target lives under documents/<stage>/ outside .aifactory', () => {
  const root = '/tmp/project'
  const target = exportTarget({ projectRoot: root, stage: 'planning', title: 'TELOS Feasibility Report', projectName: 'ABCClothing' })
  assert.equal(target.relativePath, 'documents/planning/TELOS Feasibility Report — ABCClothing.pdf')
  assert.equal(target.absolutePath, join(root, EXPORT_ROOT, 'planning', 'TELOS Feasibility Report — ABCClothing.pdf'))
  assert.ok(!target.relativePath.includes('.aifactory'))
})

test('a stage that tries to escape the documents tree is rejected', () => {
  for (const stage of ['../../etc', '..', 'planning/../../x']) {
    assert.throws(
      () => exportTarget({ projectRoot: '/tmp/project', stage, title: 'T', projectName: 'P' }),
      (error: unknown) => error instanceof ExportError && error.code === 'EXPORT_PATH_ESCAPE',
      stage,
    )
  }
})

test('writeExport creates the directory, writes the file and overwrites on re-run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-export-'))
  try {
    const target = exportTarget({ projectRoot: root, stage: 'planning', title: 'Report', projectName: 'P' })
    const first = await writeExport(target, new Uint8Array([1, 2, 3]))
    assert.equal(first.relativePath, 'documents/planning/Report — P.pdf')
    assert.deepEqual([...readFileSync(target.absolutePath)], [1, 2, 3])

    const second = await writeExport(target, new Uint8Array([9]))
    assert.equal(second.absolutePath, target.absolutePath)
    assert.deepEqual([...readFileSync(target.absolutePath)], [9], 'the canonical file is overwritten')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unwritable destination becomes an ExportError, not a crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-export-bad-'))
  try {
    // A file where the directory should be makes mkdir fail.
    writeFileSync(join(root, 'documents'), 'not a directory')
    const target = exportTarget({ projectRoot: root, stage: 'planning', title: 'Report', projectName: 'P' })
    assert.ok(target.absolutePath.startsWith(root))
    await assert.rejects(() => writeExport(target, new Uint8Array([1])), (error: unknown) => error instanceof ExportError && error.code === 'EXPORT_WRITE_FAILED')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
