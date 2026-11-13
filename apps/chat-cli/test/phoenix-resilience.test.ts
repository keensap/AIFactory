import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshHarness } from '../src/harness.ts'
import { createChatServer, serverPort } from '../src/server.ts'
import { SessionStore } from '../src/store.ts'

test('project deletion does not wait for a dead or hung Phoenix', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-phoenix-delete-'))
  const removed: string[] = []
  let phoenixDeleteCalls = 0
  const server = createChatServer({
    harnessFactory: () => new DshHarness({ command: process.execPath, commandArgs: ['-e', ''] }),
    store: new SessionStore({ dataDir }),
    version: 'test',
    projects: {
      remove: async (id: string) => { removed.push(id) },
    } as never,
    observability: {
      // Simulates the monitor accepting the request and never answering.
      deleteProject: () => { phoenixDeleteCalls += 1; return new Promise<void>(() => {}) },
    } as never,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const started = Date.now()
    const response = await fetch(`http://127.0.0.1:${serverPort(server)}/api/projects/p1`, { method: 'DELETE' })
    const elapsed = Date.now() - started
    assert.equal(response.status, 204)
    assert.deepEqual(removed, ['p1'])
    assert.ok(elapsed < 500, `project deletion blocked for ${elapsed}ms`)
    assert.equal(phoenixDeleteCalls, 1, 'Phoenix cleanup is still attempted in the background')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  }
})
