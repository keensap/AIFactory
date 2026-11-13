#!/usr/bin/env node
/**
 * Development-only stand-in for the AI Factory Chat API.
 *
 * It implements the documented endpoints in memory so the web UI can be built,
 * tested and screenshotted without a model key or a harness process. It is not
 * part of the shipped UI and is never used automatically.
 *
 *   node scripts/mock-api.mjs           # http://127.0.0.1:8788
 *   PORT=9000 node scripts/mock-api.mjs
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { handleStageRoutes, withStage } from './mock-stages.mjs'

const PORT = Number(process.env.PORT ?? 8788)
const HOST = process.env.HOST ?? '127.0.0.1'
const PROJECTS_DISABLED = process.env.PROJECTS_DISABLED === '1'
const startedAt = Date.now()

const now = Date.now()
const minutesAgo = (minutes) => new Date(now - minutes * 60_000).toISOString()

const sessions = new Map()
const projects = new Map()

function seedProject(id, name, rootPath, organization, ownerEmail, status, createdMinutes) {
  const createdAt = minutesAgo(createdMinutes)
  projects.set(id, {
    id,
    name,
    rootPath,
    organization,
    ownerEmail,
    status,
    createdAt,
    updatedAt: createdAt,
  })
}

if (!PROJECTS_DISABLED) {
  seedProject(
    '11111111-1111-4111-8111-111111111111',
    'General',
    '/data/AIFactory2',
    'AI Factory',
    'owner@aifactory.local',
    'active',
    2,
  )
  seedProject(
    '22222222-2222-4222-8222-222222222222',
    'Atlas Console',
    '/workspace/atlas-console',
    'AI Factory',
    'atlas@aifactory.local',
    'active',
    12,
  )
  seedProject(
    '33333333-3333-4333-8333-333333333333',
    'Forge Agents',
    '/workspace/forge-agents',
    'AI Factory',
    'forge@aifactory.local',
    'inactive',
    24,
  )
}

function seed(id, title, updatedMinutes, messages) {
  const createdAt = minutesAgo(updatedMinutes + 35)
  const updatedAt = minutesAgo(updatedMinutes)
  sessions.set(id, {
    id,
    title,
    createdAt,
    updatedAt,
    messages: messages.map((message, index) => ({
      role: message.role,
      content: message.content,
      at: new Date(Date.parse(updatedAt) - (messages.length - index) * 45_000).toISOString(),
    })),
  })
}

seed('session-mock-atlas-1', 'Streaming contract review', 4, [
  {
    role: 'user',
    content: 'Review the streaming contract before we wire the new UI. What should the client treat as authoritative?',
  },
  {
    role: 'assistant',
    content: `## What the client can trust

The SSE surface exposes two terminal signals, and they are not the same thing:

- **\`final\`** is the harness-level answer. Its \`reason.kind\` is the transport’s success signal.
- **\`done\`** is the API-level signal. It is sent only after the turn is persisted, so it is the right moment to refresh the session list.

Treat \`text\` events as append-only blocks and \`done.text\` as the authoritative answer:

\`\`\`ts
type TurnResult = { sessionId: string; text: string; durationMs: number }

async function streamTurn(body: { message: string; sessionId?: string }) {
  const response = await fetch('/api/chat/stream', { method: 'POST', body: JSON.stringify(body) })
  if (!response.ok) throw new Error(await response.text())
  // parse frames, append text, resolve on "done"
}
\`\`\`

### Failure precedence

| Signal | UI behaviour |
| --- | --- |
| HTTP error | Show the error envelope; do not create a local transcript |
| \`error\` event | Keep any committed text, mark the turn failed |
| stream close without \`done\` | Treat as incomplete, offer retry |
| \`done\` | Refresh history, clear the running state |

One more detail: **\`session\` arrives before the answer**. Use it to attach the turn to a project immediately, even if the response later fails.`,
  },
  {
    role: 'user',
    content: 'And if the browser sleeps mid-turn?',
  },
  {
    role: 'assistant',
    content: `A sleeping tab usually means the fetch is aborted by the browser. The safe design is:

1. Mark the local assistant block **stopped**, not failed.
2. Call \`GET /api/sessions/:id\` on focus. If the API persisted the turn, replace the local block with the stored messages.
3. Never assume an aborted turn consumed a project quota or changed the harness transcript.

The UI should keep **one running turn per session** and rely on the API's \`409 SESSION_BUSY\` as the backstop when two tabs race.`,
  },
])

seed('session-mock-atlas-2', 'Approvals surface for tool calls', 52, [
  {
    role: 'user',
    content: 'Sketch the approvals surface for tool calls. We need allow, deny and always, without making the transcript noisy.',
  },
  {
    role: 'assistant',
    content: `Keep approvals **inline but not interleaved** with prose. A single card at the tool boundary works best:

- Tool name and a one-line intent.
- The exact command or path, truncated with an expand control.
- \`Allow once\`, \`Always allow for this project\`, \`Deny\`.

Once the decision is recorded, collapse the card to a one-line receipt. This preserves the audit trail without turning the conversation into a log viewer.`,
  },
])

seed('session-mock-atlas-3', 'Intake screen information architecture', 180, [
  {
    role: 'user',
    content: 'Propose an information architecture for the intake screen. It has to support a long requirements document and human review gates at the same time.',
  },
  {
    role: 'assistant',
    content: `A three-pane intake workspace:

1. **Source** — uploaded documents, pasted briefs and linked Jira epics.
2. **Working set** — the extracted requirements with confidence and provenance.
3. **Review rail** — gate status, reviewers and the decision log.

The important constraint is that the review rail never overlays the source. Reviewers need to quote the original while recording a decision.`,
  },
])

seed('session-mock-forge-1', 'Evaluation loop for coder adapters', 18, [
  {
    role: 'user',
    content: 'How should we compare coder adapters without letting one bad run dominate the score?',
  },
  {
    role: 'assistant',
    content: `Use a **paired rubric with bounded influence**:

- Run every adapter on the same task and fixture commit.
- Score on acceptance, regression safety and review cost separately.
- Winsorize each dimension before weighting; one catastrophic run should not erase a strong median.
- Require at least three runs before promoting an adapter, and keep the raw traces for audit.

The comparison should be reproducible from the task id, fixture hash and adapter version alone.`,
  },
])

seed('session-mock-forge-2', 'Cost guardrails for long sessions', 240, [
  {
    role: 'user',
    content: 'What guardrails should we add before letting sessions run for hours?',
  },
  {
    role: 'assistant',
    content: `Start with **visible budgets** rather than hard stops:

- per-turn token ceiling, surfaced before the turn starts;
- per-session rolling budget with a warning at 70%;
- a hard stop that produces a structured \`BUDGET_EXCEEDED\` event and leaves a resumable checkpoint.

The UI should display the budget next to the model chip so users can see the cost of a long tool loop while it is happening.`,
  },
])

seed('session-mock-general-1', 'Quick notes on the projects placeholder', 75, [
  {
    role: 'user',
    content: 'How should the UI behave before we have a Projects API?',
  },
  {
    role: 'assistant',
    content: `Treat projects as a **presentation layer over sessions** for now:

- Keep project metadata and session assignments in local storage.
- Mark the surface as a placeholder in settings and project details.
- Keep the repository seam narrow, so swapping in a real Projects API does not touch the chat transport.
- Map unassigned sessions to General rather than dropping them.

That gives us the right interaction model today without inventing a second session store.`,
  },
])

const richReply = `Here’s a compact plan for that:

1. **Keep the transport thin.** One turn is one request; the harness session stays canonical.
2. **Make project grouping local.** Sessions are already returned by the API, so the UI can overlay project assignments until a Projects API exists.
3. **Let the transcript carry the state.** Optimistic user blocks and committed assistant blocks should render through the same component.

\`\`\`ts
const projectId = assignments[sessionId] ?? DEFAULT_PROJECT_ID
const visible = groupSessionsByProject(projects, sessions, assignments)
\`\`\`

A useful rule: if a feature would need a second copy of the conversation, it belongs behind the API, not in the browser.`

function listProjects() {
  return [...projects.values()].map(withStage).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function projectInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  return body
}

function listSessions(projectId) {
  return [...sessions.values()]
    .filter((session) => !projectId || session.projectId === projectId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(({ messages, ...session }) => ({
      ...session,
      messageCount: messages.length,
    }))
}

// Mirrors POST /api/projects/:id/sessions/:sid/pdf-review without a real PDF parser.
async function pdfReview(request, response, projectId, sessionId) {
  const project = projects.get(projectId)
  if (project === undefined) return sendError(response, 404, 'project not found', 'PROJECT_NOT_FOUND')
  const session = sessions.get(sessionId)
  if (session === undefined) return sendError(response, 404, `session ${sessionId} was not found`, 'SESSION_NOT_FOUND')
  if (session.projectId !== undefined && session.projectId !== projectId) {
    return sendError(response, 409, 'session belongs to another project', 'SESSION_PROJECT_MISMATCH')
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  if (body.length > 20 * 1024 * 1024) return sendError(response, 413, 'PDF too large', 'PDF_TOO_LARGE')
  const text = body.toString('latin1')
  if (!text.includes('%PDF-')) return sendError(response, 400, 'file is not a PDF', 'INVALID_PDF')
  const filename = /filename="([^"]+)"/.exec(text)?.[1] ?? 'document.pdf'
  const message = /name="message"\r\n\r\n([\s\S]*?)\r\n--/.exec(text)?.[1] ?? ''
  await sleep(600)
  const markdown = [
    '# Requirement Review',
    '',
    `**${filename}** was reviewed for completeness.`,
    '',
    '## Gaps',
    '- Non-functional requirements (performance, availability) are not specified.',
    '- User roles and permissions need to be listed explicitly.',
    '',
    '## Questions',
    '1. Which platforms must the first release support?',
    '2. What is out of scope for v1?',
  ].join('\n')
  const now = new Date().toISOString()
  session.messages.push({ role: 'user', content: message, at: now }, { role: 'assistant', content: markdown, at: now })
  session.updatedAt = now
  session.projectId = projectId
  sendJson(response, 200, {
    project,
    sessionId,
    document: { filename, pages: 3, characters: 4200, truncated: false },
    analysis: { type: 'review', decision: 'needs_revision', markdown, questions: [] },
    durationMs: 600,
  })
}

// Mirrors GET /api/fs/directories using this machine's real filesystem.
async function listDirectories(url, response) {
  const { readdir, realpath, stat } = await import('node:fs/promises')
  const { homedir } = await import('node:os')
  const { dirname, isAbsolute, join } = await import('node:path')
  const requested = url.searchParams.get('path') || homedir()
  if (!isAbsolute(requested)) return sendError(response, 400, 'path must be absolute', 'INVALID_PATH')
  let path
  try {
    path = await realpath(requested)
  } catch {
    return sendError(response, 404, `${requested} does not exist`, 'PATH_NOT_FOUND')
  }
  if (!(await stat(path)).isDirectory()) return sendError(response, 400, `${path} is not a directory`, 'NOT_A_DIRECTORY')
  const showHidden = url.searchParams.get('hidden') === '1'
  let dirents
  try {
    dirents = await readdir(path, { withFileTypes: true })
  } catch {
    return sendError(response, 403, `${path} cannot be read`, 'PATH_NOT_READABLE')
  }
  const names = dirents
    .filter((entry) => entry.isDirectory() && (showHidden || !entry.name.startsWith('.')))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
  const parent = dirname(path)
  sendJson(response, 200, {
    path,
    parent: parent === path ? null : parent,
    home: homedir(),
    entries: names.slice(0, 1000).map((name) => ({ name, path: join(path, name) })),
    truncated: names.length > 1000,
  })
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
  })
  response.end(text)
}

function sendError(response, status, message, code) {
  sendJson(response, status, { error: { message, code, status } })
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function streamTurn(request, response) {
  let input
  try {
    input = await readBody(request)
  } catch {
    sendError(response, 400, 'request body is not valid JSON', 'INVALID_JSON')
    return
  }
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (message === '') {
    sendError(response, 400, '"message" must be a non-empty string', 'INVALID_MESSAGE')
    return
  }

  const requested = typeof input.sessionId === 'string' ? input.sessionId : undefined
  const existing = requested === undefined ? undefined : sessions.get(requested)
  if (requested !== undefined && existing === undefined) {
    sendError(response, 404, 'session not found', 'SESSION_NOT_FOUND')
    return
  }
  // Mirror the real API: a session is bound to the project of its first turn.
  const requestedProject = typeof input.projectId === 'string' ? input.projectId : undefined
  if (existing !== undefined && requestedProject !== undefined && requestedProject !== existing.projectId) {
    sendError(response, 409, 'session belongs to another project', 'SESSION_PROJECT_MISMATCH')
    return
  }
  const boundProjectId = existing?.projectId ?? requestedProject
  const project = boundProjectId === undefined ? undefined : projects.get(boundProjectId)
  if (boundProjectId !== undefined && project === undefined) {
    sendError(response, 404, 'project not found', 'PROJECT_NOT_FOUND')
    return
  }
  if (existing === undefined && project?.status === 'archived') {
    sendError(response, 409, 'archived projects cannot start new chats', 'PROJECT_ARCHIVED')
    return
  }
  const sessionId = existing?.id ?? `session-mock-${randomUUID()}`
  const title = existing?.title ?? message.replace(/\s+/g, ' ').slice(0, 80)
  const createdAt = existing?.createdAt ?? new Date().toISOString()

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  })

  let closed = false
  response.on('close', () => {
    closed = true
  })
  const send = (event, data) => {
    if (closed || response.writableEnded) return
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const started = Date.now()
  send('session', { sessionId, cwd: project?.rootPath ?? '/data/AIFactory2/apps/chat-web' })
  send('status', { phase: 'turn_start', turn: 1 })
  await sleep(260)
  if (closed) return
  send('status', { phase: 'step_start', turn: 1, step: 1 })
  send('tool_call', { name: 'read_file', callId: 'call_mock_1' })
  await sleep(520)
  if (closed) return
  send('tool_result', { name: 'read_file', status: 'ok' })
  send('text', { text: richReply.split('\n\n')[0] + '\n\n' + richReply.split('\n\n')[1] })
  await sleep(420)
  if (closed) return
  send('text', { text: richReply.split('\n\n').slice(2).join('\n\n') })
  await sleep(220)
  if (closed) return
  send('final', {
    sessionId,
    text: richReply,
    reason: { kind: 'completed' },
  })
  const updatedAt = new Date().toISOString()
  const turnMessages = [
    ...(existing?.messages ?? []),
    { role: 'user', content: message, at: createdAt },
    { role: 'assistant', content: richReply, at: updatedAt },
  ]
  sessions.set(sessionId, {
    id: sessionId,
    title,
    createdAt,
    updatedAt,
    ...(boundProjectId === undefined ? {} : { projectId: boundProjectId }),
    messages: turnMessages,
  })
  send('done', { sessionId, text: richReply, durationMs: Date.now() - started })
  response.end()
}

async function handleProjects(request, response, url) {
  const segments = url.pathname.split('/').filter(Boolean)
  const id = segments[2] === undefined ? undefined : decodeURIComponent(segments[2])

  if (segments.length === 2) {
    if (request.method === 'GET') {
      sendJson(response, 200, { projects: listProjects() })
      return
    }
    if (request.method === 'POST') {
      let body
      try {
        body = projectInput(await readBody(request))
      } catch {
        sendError(response, 400, 'request body is not valid JSON', 'INVALID_JSON')
        return
      }
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      const rootPath = typeof body?.rootPath === 'string' ? body.rootPath.trim() : ''
      if (name === '') {
        sendError(response, 400, 'name is required', 'INVALID_NAME')
        return
      }
      if (!rootPath.startsWith('/')) {
        sendError(response, 400, 'rootPath must be an absolute directory', 'INVALID_ROOT_PATH')
        return
      }
      if ([...projects.values()].some((project) => project.rootPath === rootPath)) {
        sendError(response, 409, 'another project already uses this root path', 'ROOT_PATH_CONFLICT')
        return
      }
      const now = new Date().toISOString()
      const project = {
        id: randomUUID(),
        name,
        rootPath,
        organization: typeof body?.organization === 'string' && body.organization !== ''
          ? body.organization
          : null,
        ownerEmail: typeof body?.ownerEmail === 'string' && body.ownerEmail !== ''
          ? body.ownerEmail
          : null,
        status: ['active', 'inactive', 'archived'].includes(body?.status)
          ? body.status
          : 'inactive',
        createdAt: now,
        updatedAt: now,
      }
      withStage(project)
      projects.set(project.id, project)
      sendJson(response, 201, { project })
      return
    }
  }

  if (segments.length === 3 && id !== undefined) {
    const existing = projects.get(id)
    if (request.method === 'GET') {
      if (existing === undefined) {
        sendError(response, 404, 'project not found', 'PROJECT_NOT_FOUND')
        return
      }
      sendJson(response, 200, { project: existing })
      return
    }
    if (request.method === 'PATCH') {
      if (existing === undefined) {
        sendError(response, 404, 'project not found', 'PROJECT_NOT_FOUND')
        return
      }
      let body
      try {
        body = projectInput(await readBody(request))
      } catch {
        sendError(response, 400, 'request body is not valid JSON', 'INVALID_JSON')
        return
      }
      if (body === null) {
        sendError(response, 400, 'request body must be a JSON object', 'INVALID_BODY')
        return
      }
      const next = { ...existing }
      if (typeof body.name === 'string') next.name = body.name.trim()
      if (typeof body.rootPath === 'string') next.rootPath = body.rootPath.trim()
      if ('organization' in body) next.organization = typeof body.organization === 'string' ? body.organization : null
      if ('ownerEmail' in body) next.ownerEmail = typeof body.ownerEmail === 'string' ? body.ownerEmail : null
      if (['active', 'inactive', 'archived'].includes(body.status)) next.status = body.status
      if ([...projects.values()].some((project) => project.id !== id && project.rootPath === next.rootPath)) {
        sendError(response, 409, 'another project already uses this root path', 'ROOT_PATH_CONFLICT')
        return
      }
      next.updatedAt = new Date().toISOString()
      projects.set(id, next)
      sendJson(response, 200, { project: next })
      return
    }
    if (request.method === 'DELETE') {
      if (existing === undefined) {
        sendError(response, 404, 'project not found', 'PROJECT_NOT_FOUND')
        return
      }
      projects.delete(id)
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
      response.end()
      return
    }
  }

  if (segments.length === 4 && segments[3] === 'status' && request.method === 'PATCH' && id !== undefined) {
    const existing = projects.get(id)
    if (existing === undefined) {
      sendError(response, 404, 'project not found', 'PROJECT_NOT_FOUND')
      return
    }
    let body
    try {
      body = await readBody(request)
    } catch {
      sendError(response, 400, 'request body is not valid JSON', 'INVALID_JSON')
      return
    }
    if (!['active', 'inactive', 'archived'].includes(body?.status)) {
      sendError(response, 400, 'invalid status', 'INVALID_STATUS')
      return
    }
    const next = { ...existing, status: body.status, updatedAt: new Date().toISOString() }
    projects.set(id, next)
    sendJson(response, 200, { project: next })
    return
  }

  sendError(response, 404, 'not found', 'NOT_FOUND')
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const segments = url.pathname.split('/').filter(Boolean)

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
    })
    response.end()
    return
  }

  try {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        version: '0.1.0-mock',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        harness: { command: '/mock/dsh', profile: 'headless' },
        database: PROJECTS_DISABLED ? 'disabled' : 'postgres',
      })
      return
    }

    const review = /^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/pdf-review$/.exec(url.pathname)
    if (request.method === 'POST' && review !== null) {
      await pdfReview(request, response, decodeURIComponent(review[1]), decodeURIComponent(review[2]))
      return
    }

    if (!PROJECTS_DISABLED && (url.pathname.startsWith('/api/sdlc/') || url.pathname.startsWith('/api/stage-runs/') || url.pathname.startsWith('/api/projects/'))) {
      if (await handleStageRoutes(request, response, url, projects, { sendJson, sendError })) return
    }

    if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')) {
      if (PROJECTS_DISABLED) {
        sendError(
          response,
          503,
          'project registry is disabled; set DATABASE_URL',
          'DATABASE_NOT_CONFIGURED',
        )
        return
      }
      await handleProjects(request, response, url)
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/fs/directories') {
      await listDirectories(url, response)
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      sendJson(response, 200, { sessions: listSessions(url.searchParams.get('projectId')) })
      return
    }

    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2] !== undefined) {
      const id = decodeURIComponent(segments[2])
      const session = sessions.get(id)
      if (request.method === 'GET' && session !== undefined) {
        if (segments[3] === 'messages') {
          sendJson(response, 200, { messages: session.messages })
        } else if (segments.length === 3) {
          sendJson(response, 200, {
            session: { ...session, messageCount: session.messages.length },
          })
        } else {
          sendError(response, 404, 'not found', 'NOT_FOUND')
        }
        return
      }
      if (request.method === 'DELETE' && session !== undefined) {
        sessions.delete(id)
        response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
        response.end()
        return
      }
      if (request.method === 'GET' || request.method === 'DELETE') {
        sendError(response, 404, 'session not found', 'SESSION_NOT_FOUND')
        return
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/chat/stream') {
      await streamTurn(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      const input = await readBody(request)
      const message = typeof input.message === 'string' ? input.message : ''
      const sessionId = `session-mock-${randomUUID()}`
      const at = new Date().toISOString()
      sessions.set(sessionId, {
        id: sessionId,
        title: message.slice(0, 80),
        createdAt: at,
        updatedAt: at,
        messages: [
          { role: 'user', content: message, at },
          { role: 'assistant', content: richReply, at },
        ],
      })
      sendJson(response, 200, {
        sessionId,
        reply: richReply,
        reason: { kind: 'completed' },
        durationMs: 900,
      })
      return
    }

    sendError(response, 404, 'not found', 'NOT_FOUND')
  } catch (error) {
    if (!response.headersSent) {
      sendError(response, 500, error instanceof Error ? error.message : 'internal error', 'INTERNAL_ERROR')
    } else if (!response.writableEnded) {
      response.end()
    }
  }
})

server.listen(PORT, HOST, () => {
  process.stdout.write(`Mock Chat API listening on http://${HOST}:${PORT}\n`)
})
