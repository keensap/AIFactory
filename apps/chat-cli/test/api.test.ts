import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DshHarness } from '../src/harness.ts'
import { PdfReviewService } from '../src/pdf-review.ts'
import { ProjectService } from '../src/projects.ts'
import { createChatServer, serverPort } from '../src/server.ts'
import { SettingsService } from '../src/settings.ts'
import { SessionStore } from '../src/store.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

const fakeHarness = fileURLToPath(new URL('../scripts/fake-dsh.mjs', import.meta.url))

interface TestServer {
  base: string
  store: SessionStore
}

async function withServer(
  run: (server: TestServer) => Promise<void>,
  options: {
    apiToken?: string
    projects?: ProjectService
    settings?: SettingsService
    pdfReviewFactory?: (store: SessionStore) => PdfReviewService
  } = {},
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-api-'))
  const store = new SessionStore({ dataDir })
  const pdfReview = options.pdfReviewFactory?.(store)
  const server = createChatServer({
    harnessFactory: (cwd) => new DshHarness({
      command: process.execPath,
      commandArgs: [fakeHarness],
      timeoutMs: 5_000,
      ...(cwd !== undefined ? { cwd } : {}),
    }),
    store,
    version: 'test',
    corsOrigins: '*',
    ...(options.apiToken !== undefined ? { apiToken: options.apiToken } : {}),
    ...(options.projects !== undefined ? { projects: options.projects } : {}),
    ...(options.settings !== undefined ? { settings: options.settings } : {}),
    ...(pdfReview !== undefined ? { pdfReview } : {}),
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  try {
    await run({ base: `http://127.0.0.1:${serverPort(server)}`, store })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dataDir, { recursive: true, force: true })
  }
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

test('reports health and CORS headers', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/health`, {
      headers: { Origin: 'http://ui.example' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    const body = await response.json() as { ok: boolean; version: string }
    assert.equal(body.ok, true)
    assert.equal(body.version, 'test')
  })
})

test('serves live docs, the API index and the OpenAPI contract', async () => {
  await withServer(async ({ base }) => {
    const docs = await fetch(`${base}/docs`)
    assert.equal(docs.status, 200)
    assert.match(docs.headers.get('content-type') ?? '', /text\/html/)
    const html = await docs.text()
    assert.match(html, /live documentation/i)
    assert.match(html, /\/api\/chat\/stream/)

    const root = await fetch(`${base}/`)
    assert.equal(root.status, 200)

    const contract = await fetch(`${base}/openapi.yaml`)
    assert.equal(contract.status, 200)
    assert.match(contract.headers.get('content-type') ?? '', /application\/yaml/)
    assert.match(await contract.text(), /openapi: 3\.1\.0/)

    const index = await fetch(`${base}/api`)
    assert.equal(index.status, 200)
    const body = await index.json() as { docs: string; openapi: string }
    assert.equal(body.docs, '/docs')
    assert.equal(body.openapi, '/openapi.yaml')
  }, { apiToken: 'secret' })
})

test('creates a session, resumes it and returns history', async () => {
  await withServer(async ({ base, store }) => {
    const first = await post(base, '/api/chat', { message: 'hello' })
    assert.equal(first.status, 200)
    const firstBody = await first.json() as { sessionId: string; reply: string }
    assert.equal(firstBody.reply, 'echo: hello')

    const second = await post(base, '/api/chat', {
      message: 'again',
      sessionId: firstBody.sessionId,
    })
    const secondBody = await second.json() as { sessionId: string; reply: string }
    assert.equal(secondBody.sessionId, firstBody.sessionId)
    assert.equal(secondBody.reply, 'echo: again (resumed)')

    assert.equal(store.list().length, 1)
    const history = await fetch(`${base}/api/sessions/${firstBody.sessionId}/messages`)
    assert.equal(history.status, 200)
    const historyBody = await history.json() as { messages: Array<{ role: string; content: string }> }
    assert.equal(historyBody.messages.length, 4)
    assert.equal(historyBody.messages[0]?.content, 'hello')
    assert.equal(historyBody.messages[3]?.content, 'echo: again (resumed)')
  })
})

test('streams events over Server-Sent Events', async () => {
  await withServer(async ({ base }) => {
    const response = await post(base, '/api/chat/stream', { message: 'stream' })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const text = await response.text()
    assert.match(text, /event: session/)
    assert.match(text, /event: text/)
    assert.match(text, /event: done/)
    assert.match(text, /echo: stream/)
  })
})

test('creates, lists, updates, changes status and removes projects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-project-'))
  const secondRoot = mkdtempSync(join(root, 'second-'))
  const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
  try {
    await withServer(async ({ base }) => {
      const created = await post(base, '/api/projects', {
        name: 'Alpha',
        rootPath: root,
        organization: 'Acme',
        ownerEmail: 'owner@example.com',
        status: 'active',
      })
      assert.equal(created.status, 201)
      const createdBody = await created.json() as { project: { id: string; status: string } }
      assert.equal(createdBody.project.status, 'active')

      const second = await post(base, '/api/projects', {
        name: 'Beta',
        rootPath: secondRoot,
        status: 'active',
      })
      assert.equal(second.status, 201)

      const list = await fetch(`${base}/api/projects?status=active`)
      assert.equal(list.status, 200)
      const listBody = await list.json() as { projects: unknown[] }
      assert.equal(listBody.projects.length, 2)

      const fetched = await fetch(`${base}/api/projects/${createdBody.project.id}`)
      assert.equal(fetched.status, 200)

      const updated = await fetch(`${base}/api/projects/${createdBody.project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Alpha 2' }),
      })
      assert.equal(updated.status, 200)

      const status = await fetch(`${base}/api/projects/${createdBody.project.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'inactive' }),
      })
      assert.equal(status.status, 200)

      const tools = await fetch(`${base}/api/tools`)
      assert.equal(tools.status, 200)
      const toolsBody = await tools.json() as { tools: Array<{ name: string }> }
      assert.deepEqual(toolsBody.tools.map((tool) => tool.name).sort(), [
        'change_project_status',
        'create_project',
        'get_project',
        'list_projects',
        'remove_project',
        'update_project',
      ])

      const duplicate = await post(base, '/api/projects', { name: 'Duplicate', rootPath: root })
      assert.equal(duplicate.status, 409)

      const removed = await fetch(`${base}/api/projects/${createdBody.project.id}`, { method: 'DELETE' })
      assert.equal(removed.status, 204)

      const missing = await fetch(`${base}/api/projects/${createdBody.project.id}`)
      assert.equal(missing.status, 404)
    }, { projects })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('views and updates chat settings, enforcing the active limit', async () => {
  const firstRoot = mkdtempSync(join(tmpdir(), 'aifactory-settings-a-'))
  const secondRoot = mkdtempSync(join(tmpdir(), 'aifactory-settings-b-'))
  const settings = new SettingsService(new MemorySettingsStore())
  const projects = new ProjectService(new MemoryProjectStore(), settings)
  try {
    await withServer(async ({ base }) => {
      const initial = await fetch(`${base}/api/settings`)
      assert.equal(initial.status, 200)
      assert.equal((await initial.json() as { settings: { maxActiveProjects: number } }).settings.maxActiveProjects, 3)

      const lowered = await fetch(`${base}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxActiveProjects: 1 }),
      })
      assert.equal(lowered.status, 200)

      const first = await post(base, '/api/projects', {
        name: 'First',
        rootPath: firstRoot,
        status: 'active',
      })
      assert.equal(first.status, 201)

      const second = await post(base, '/api/projects', {
        name: 'Second',
        rootPath: secondRoot,
        status: 'active',
      })
      assert.equal(second.status, 409)
      assert.equal((await second.json() as { error: { code: string } }).error.code, 'ACTIVE_PROJECT_LIMIT_REACHED')

      const invalid = await fetch(`${base}/api/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxActiveProjects: 0 }),
      })
      assert.equal(invalid.status, 400)
    }, { projects, settings })
  } finally {
    rmSync(firstRoot, { recursive: true, force: true })
    rmSync(secondRoot, { recursive: true, force: true })
  }
})

test('reviews an uploaded PDF scoped to a project session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-pdf-api-'))
  const settings = new SettingsService(new MemorySettingsStore())
  const projects = new ProjectService(new MemoryProjectStore(), settings)
  const fixture = readFileSync(new URL('./fixtures/requirements.pdf', import.meta.url))
  try {
    await withServer(async ({ base }) => {
      const projectResponse = await post(base, '/api/projects', {
        name: 'PDF Project',
        rootPath: root,
        status: 'active',
      })
      const project = (await projectResponse.json() as { project: { id: string } }).project

      const chat = await post(base, '/api/chat', { message: 'Context', projectId: project.id })
      const sessionId = (await chat.json() as { sessionId: string }).sessionId

      const form = new FormData()
      form.set('message', 'Review this requirement document.')
      form.set('file', new Blob([fixture], { type: 'application/pdf' }), 'requirements.pdf')

      const response = await fetch(
        `${base}/api/projects/${project.id}/sessions/${sessionId}/pdf-review`,
        { method: 'POST', body: form },
      )
      assert.equal(response.status, 200)
      const body = await response.json() as {
        project: { id: string }
        sessionId: string
        document: { pages: number; filename: string }
        analysis: { type: string; decision?: string }
      }
      assert.equal(body.project.id, project.id)
      assert.equal(body.sessionId, sessionId)
      assert.equal(body.document.pages, 1)
      assert.equal(body.document.filename, 'requirements.pdf')
      assert.equal(body.analysis.type, 'review')

      const history = await fetch(`${base}/api/sessions/${sessionId}/messages`)
      const messages = (await history.json() as { messages: unknown[] }).messages
      assert.equal(messages.length, 4)
    }, {
      projects,
      settings,
      pdfReviewFactory: (store) => new PdfReviewService({
        projects,
        sessions: store,
        harnessFactory: () => { throw new Error('unused harness') },
        runPrompt: async () => JSON.stringify({
          type: 'review',
          decision: 'complete',
          markdown: '# Review\n\nComplete enough to baseline.',
        }),
      }),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects an occupied session with 409', async () => {
  await withServer(async ({ base, store }) => {
    const first = await post(base, '/api/chat', { message: 'hello' })
    const { sessionId } = await first.json() as { sessionId: string }
    const release = store.acquire(sessionId)
    try {
      const response = await post(base, '/api/chat', { message: 'second', sessionId })
      assert.equal(response.status, 409)
      const body = await response.json() as { error: { code: string } }
      assert.equal(body.error.code, 'SESSION_BUSY')
    } finally {
      release()
    }
  })
})

test('requires a bearer token when configured', async () => {
  await withServer(async ({ base }) => {
    const unauthorized = await fetch(`${base}/api/sessions`)
    assert.equal(unauthorized.status, 401)

    const health = await fetch(`${base}/api/health`)
    assert.equal(health.status, 200)

    const authorized = await post(base, '/api/chat', { message: 'hello' }, {
      Authorization: 'Bearer secret',
    })
    assert.equal(authorized.status, 200)
  }, { apiToken: 'secret' })
})

test('validates request bodies and unknown sessions', async () => {
  await withServer(async ({ base }) => {
    const invalid = await post(base, '/api/chat', { message: '' })
    assert.equal(invalid.status, 400)

    const badJson = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })
    assert.equal(badJson.status, 400)

    const missing = await fetch(`${base}/api/sessions/session-missing`)
    assert.equal(missing.status, 404)
  })
})

test('persists the session registry across restarts', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aifactory-store-'))
  try {
    const first = new SessionStore({ dataDir })
    first.recordTurn('session-persist', 'hello', 'hi')
    const second = new SessionStore({ dataDir })
    assert.equal(second.list().length, 1)
    assert.equal(second.get('session-persist')?.messages.length, 2)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('scopes a chat to a project root and binds the session to it', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aifactory-scoped-')))
  const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aifactory-scoped-other-')))
  const projects = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
  try {
    await withServer(async ({ base }) => {
      const create = async (name: string, rootPath: string, status = 'active'): Promise<string> => {
        const response = await post(base, '/api/projects', { name, rootPath, status })
        assert.equal(response.status, 201)
        return ((await response.json()) as { project: { id: string } }).project.id
      }
      const projectId = await create('Scoped', root)
      const otherId = await create('Other', otherRoot, 'archived')

      const stream = await post(base, '/api/chat/stream', { message: 'hello', projectId })
      assert.equal(stream.status, 200)
      const text = await stream.text()
      const session = /event: session\ndata: (.*)\n/.exec(text)
      assert.ok(session)
      const sessionEvent = JSON.parse(session[1]!) as { sessionId: string; cwd: string }
      assert.equal(sessionEvent.cwd, root)

      const listed = await (await fetch(`${base}/api/sessions?projectId=${projectId}`)).json() as {
        sessions: { id: string; projectId?: string }[]
      }
      assert.equal(listed.sessions.length, 1)
      assert.equal(listed.sessions[0]!.projectId, projectId)
      const none = await (await fetch(`${base}/api/sessions?projectId=${otherId}`)).json() as { sessions: unknown[] }
      assert.equal(none.sessions.length, 0)

      // Continuing without projectId stays in the bound project.
      const resumed = await post(base, '/api/chat', { message: 'again', sessionId: sessionEvent.sessionId })
      assert.equal(resumed.status, 200)

      const moved = await post(base, '/api/chat', {
        message: 'move', sessionId: sessionEvent.sessionId, projectId: otherId,
      })
      assert.equal(moved.status, 409)
      assert.equal(((await moved.json()) as { error: { code: string } }).error.code, 'SESSION_PROJECT_MISMATCH')

      const archived = await post(base, '/api/chat', { message: 'x', projectId: otherId })
      assert.equal(archived.status, 409)
      assert.equal(((await archived.json()) as { error: { code: string } }).error.code, 'PROJECT_ARCHIVED')

      const missing = await post(base, '/api/chat', {
        message: 'x', projectId: '00000000-0000-4000-8000-000000000000',
      })
      assert.equal(missing.status, 404)
    }, { projects })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(otherRoot, { recursive: true, force: true })
  }
})

test('rejects a projectId when the registry is disabled', async () => {
  await withServer(async ({ base }) => {
    const response = await post(base, '/api/chat', {
      message: 'x', projectId: '00000000-0000-4000-8000-000000000000',
    })
    assert.equal(response.status, 503)
  })
})

test('lists subdirectories for the directory picker', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aifactory-dirs-')))
  mkdirSync(join(root, 'beta'))
  mkdirSync(join(root, 'alpha'))
  mkdirSync(join(root, '.hidden'))
  writeFileSync(join(root, 'file.txt'), 'x')
  try {
    await withServer(async ({ base }) => {
      const response = await fetch(`${base}/api/fs/directories?path=${encodeURIComponent(root)}`)
      assert.equal(response.status, 200)
      const body = await response.json() as { path: string; parent: string; entries: { name: string; path: string }[] }
      assert.equal(body.path, root)
      assert.deepEqual(body.entries.map((entry) => entry.name), ['alpha', 'beta'])
      assert.equal(body.entries[0]!.path, join(root, 'alpha'))

      const hidden = await (await fetch(`${base}/api/fs/directories?hidden=1&path=${encodeURIComponent(root)}`)).json() as { entries: { name: string }[] }
      assert.ok(hidden.entries.some((entry) => entry.name === '.hidden'))

      const relative = await fetch(`${base}/api/fs/directories?path=relative/dir`)
      assert.equal(relative.status, 400)
      const missing = await fetch(`${base}/api/fs/directories?path=${encodeURIComponent(join(root, 'nope'))}`)
      assert.equal(missing.status, 404)
      const file = await fetch(`${base}/api/fs/directories?path=${encodeURIComponent(join(root, 'file.txt'))}`)
      assert.equal(((await file.json()) as { error: { code: string } }).error.code, 'NOT_A_DIRECTORY')

      const home = await (await fetch(`${base}/api/fs/directories`)).json() as { path: string; home: string }
      assert.equal(home.path, realpathSync(home.home))
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('protects the directory browser with the bearer token', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/fs/directories`)
    assert.equal(response.status, 401)
  }, { apiToken: 'secret' })
})

test('allows PATCH in CORS preflight so browsers can edit projects', async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(`${base}/api/projects/x`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PATCH' },
    })
    assert.match(response.headers.get('access-control-allow-methods') ?? '', /PATCH/)
  })
})
