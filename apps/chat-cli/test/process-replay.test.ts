import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { recordReplay, ReplayRunner } from '../src/processes/replay.ts'

async function fixture(t: TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), 'process-replay-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  return { workspace, root: join(workspace, 'captures') }
}

test('replay uses exact sequential inputs and allows repeated inputs with different replies', async (t) => {
  const { root } = await fixture(t)
  const entry = { runId: '../synthetic/run', role: 'author', prompt: 'Draft 🧪\n' }
  await recordReplay(root, { ...entry, reply: 'first\n' })
  await recordReplay(root, { ...entry, role: 'reviewer', reply: '' })
  await recordReplay(root, { ...entry, reply: 'third' })
  await recordReplay(root, { ...entry, runId: 'other', reply: 'isolated' })

  const { runPrompt } = new ReplayRunner(root, entry.runId)
  await assert.rejects(runPrompt('author', entry.prompt.trimEnd(), '/unused'), /mismatch at entry 1/)
  await assert.rejects(runPrompt('reviewer', entry.prompt, '/unused'), /mismatch at entry 1/)
  assert.deepEqual(await Promise.all([
    runPrompt('author', entry.prompt, '/one'),
    runPrompt('reviewer', entry.prompt, '/two'),
    runPrompt('author', entry.prompt, '/three'),
  ]), ['first\n', '', 'third'])
  await assert.rejects(runPrompt('author', entry.prompt, '/unused'), /exhausted at entry 4/)
  assert.equal(await new ReplayRunner(root, 'other').runPrompt('author', entry.prompt, '/unused'), 'isolated')
})

test('capture is private, preserves full entries, and does not overwrite under concurrent writes', async (t) => {
  const { root } = await fixture(t)
  const input = { runId: 'concurrent', role: 'author', prompt: 'synthetic data' }
  await recordReplay(root, { ...input, reply: 'original' })
  const [run] = await readdir(root)
  const directory = join(root, run)
  const firstFile = join(directory, '0000.json')
  const before = await readFile(firstFile, 'utf8')
  await Promise.all(['one', 'two', 'three'].map((reply) => recordReplay(root, { ...input, reply })))
  assert.equal(await readFile(firstFile, 'utf8'), before)
  assert.equal(JSON.parse(before).prompt, input.prompt)
  assert.equal((await stat(root)).mode & 0o077, 0)
  assert.equal((await stat(directory)).mode & 0o077, 0)
  const slots = (await readdir(directory)).sort()
  assert.deepEqual(slots, ['0000.json', '0001.json', '0002.json', '0003.json'])
  for (const slot of slots) assert.equal((await stat(join(directory, slot))).mode & 0o077, 0)
  const runner = new ReplayRunner(root, input.runId)
  const replies = await Promise.all(slots.map(() => runner.runPrompt(input.role, input.prompt, '/unused')))
  assert.equal(replies[0], 'original')
  assert.deepEqual(replies.slice(1).sort(), ['one', 'three', 'two'])
})

test('oversized entries are rejected without truncation or partial publication', async (t) => {
  const { root } = await fixture(t)
  await assert.rejects(recordReplay(root, {
    runId: 'oversize', role: 'author', prompt: 'synthetic', reply: '\u0000'.repeat(200_000),
  }), /size limit/)
  await assert.rejects(stat(root), { code: 'ENOENT' })
})

test('replay rejects corrupt hashes and capture rejects a symlink root', async (t) => {
  const { root, workspace } = await fixture(t)
  const input = { runId: 'corrupt', role: 'author', prompt: 'synthetic', reply: 'response' }
  await symlink(workspace, root)
  await assert.rejects(recordReplay(root, input), /non-symlink/)
  const safe = join(workspace, 'safe')
  await recordReplay(safe, input)
  const [run] = await readdir(safe)
  const file = join(safe, run, '0000.json')
  const original = await readFile(file, 'utf8')
  await writeFile(file, JSON.stringify({ ...JSON.parse(original), inputHash: 'corrupt' }))
  const runner = new ReplayRunner(safe, input.runId)
  await assert.rejects(runner.runPrompt(input.role, input.prompt, '/unused'), /Invalid replay entry 1/)
})
