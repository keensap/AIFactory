import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DshHarness, HarnessError } from '../src/harness.ts'

const fakeHarness = fileURLToPath(new URL('../scripts/fake-dsh.mjs', import.meta.url))

function makeHarness(timeoutMs = 5_000): DshHarness {
  return new DshHarness({
    command: process.execPath,
    commandArgs: [fakeHarness],
    cwd: process.cwd(),
    timeoutMs,
  })
}

test('runs one turn and reports the harness session', async () => {
  const result = await makeHarness().run('hello')

  assert.equal(result.sessionId, 'session-fake-1')
  assert.equal(result.text, 'echo: hello')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.reason, { kind: 'completed' })
  assert.ok(result.events.some((event) => event.type === 'text'))
  assert.ok(result.events.some((event) => event.type === 'final'))
})

test('resumes a session by id', async () => {
  const harness = makeHarness()
  const first = await harness.run('hello')
  const second = await harness.run('again', { sessionId: first.sessionId })

  assert.equal(second.sessionId, first.sessionId)
  assert.equal(second.text, 'echo: again (resumed)')
})

test('ignores non-JSON lines but counts them', async () => {
  const result = await makeHarness().run('GARBAGE')

  assert.equal(result.warnings, 1)
  assert.equal(result.text, 'echo: GARBAGE')
})

test('surfaces harness error events', async () => {
  await assert.rejects(
    () => makeHarness().run('FAIL'),
    (error: unknown) => {
      assert.ok(error instanceof HarnessError)
      assert.equal(error.message, 'synthetic failure')
      assert.equal(error.code, 'FAKE_ERROR')
      return true
    },
  )
})

test('surfaces a structured final-reason failure', async () => {
  await assert.rejects(
    () => makeHarness().run('REASON_FAIL'),
    (error: unknown) => {
      assert.ok(error instanceof HarnessError)
      assert.equal(error.message, 'reason failure')
      assert.equal(error.code, 'REASON_CODE')
      return true
    },
  )
})

test('times out a hung turn', async () => {
  await assert.rejects(
    () => makeHarness(150).run('SLEEP'),
    /timed out after 150 ms/,
  )
})

test('rejects an empty prompt before spawning', async () => {
  await assert.rejects(() => makeHarness().run('   '), /prompt is empty/)
})
