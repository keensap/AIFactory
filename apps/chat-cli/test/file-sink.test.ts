import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FileSink, createLogging } from '../src/logging/index.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'aifactory-filesink-'))
}

test('writes JSONL files per day with private permissions', async () => {
  const dir = join(tempDir(), 'nested', 'logs')
  let now = new Date('2026-11-12T10:00:00Z')
  const sink = new FileSink({ directory: dir, now: () => now })
  const logging = createLogging({ service: 't', sinks: [sink] })
  logging.logger.info({ event: 'one' })
  await logging.flush()
  now = new Date('2026-11-13T00:00:01Z')
  logging.logger.info({ event: 'two' })
  await logging.shutdown()
  const files = readdirSync(dir).sort()
  assert.deepEqual(files, ['aifactory-2026-11-12.jsonl', 'aifactory-2026-11-13.jsonl'])
  const first = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8').trim())
  assert.equal(first.event, 'one')
  assert.equal(statSync(join(dir, files[0]!)).mode & 0o077, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('rotates to numbered segments at the size limit', async () => {
  const dir = tempDir()
  const sink = new FileSink({ directory: dir, maxFileBytes: 1024, now: () => new Date('2026-11-12T10:00:00Z') })
  const logging = createLogging({ service: 't', sinks: [sink], batchSize: 1 })
  for (let i = 0; i < 20; i++) {
    logging.logger.info({ event: 'bulk', i, pad: 'x'.repeat(200) })
    await logging.flush()
  }
  await logging.shutdown()
  const files = readdirSync(dir)
  assert.ok(files.length >= 3, `expected rotation, got ${files.join(',')}`)
  let lines = 0
  for (const file of files) lines += readFileSync(join(dir, file), 'utf8').trim().split('\n').length
  assert.equal(lines, 20)
  rmSync(dir, { recursive: true, force: true })
})

test('deletes files older than the retention window only', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'aifactory-2026-11-01.jsonl'), '{}\n')
  writeFileSync(join(dir, 'aifactory-2026-11-10.jsonl'), '{}\n')
  writeFileSync(join(dir, 'unrelated.txt'), 'keep')
  utimesSync(join(dir, 'unrelated.txt'), new Date(), new Date())
  const sink = new FileSink({ directory: dir, retentionDays: 7, now: () => new Date('2026-11-12T10:00:00Z') })
  const logging = createLogging({ service: 't', sinks: [sink] })
  logging.logger.info({ event: 'trigger' })
  await logging.flush()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await logging.shutdown()
  const files = readdirSync(dir).sort()
  assert.ok(!files.includes('aifactory-2026-11-01.jsonl'))
  assert.ok(files.includes('aifactory-2026-11-10.jsonl'))
  assert.ok(files.includes('unrelated.txt'))
  rmSync(dir, { recursive: true, force: true })
})

test('an unwritable directory degrades only the file sink', async () => {
  const dir = tempDir()
  const blocker = join(dir, 'file-not-dir')
  writeFileSync(blocker, 'x')
  const memory: string[] = []
  const logging = createLogging({
    service: 't',
    sinks: [
      new FileSink({ directory: join(blocker, 'logs') }),
      { name: 'memory', write: (batch) => { memory.push(...batch.map((e) => e.line)) } },
    ],
    emergency: { write: () => {}, ratePerSecond: 100 },
    sinkRetry: { retries: 0 },
  })
  assert.doesNotThrow(() => logging.logger.info({ event: 'still.works' }))
  await logging.flush()
  assert.equal(memory.length, 1)
  const stats = logging.diagnostics().sinks.find((s) => s.name === 'file')!
  assert.equal(stats.state, 'degraded')
  await logging.shutdown()
  rmSync(dir, { recursive: true, force: true })
})
