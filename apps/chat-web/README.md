# AI Factory chat web

A separate, projects-first web UI for the [AI Factory Chat API](../../apps/chat-cli/API.md).
It is deliberately decoupled from `apps/chat-cli`: this folder is a standalone
Vite + React application that only talks to the documented HTTP/SSE surface at
`http://127.0.0.1:8787`.

Three screens:

1. **Home** (`#/`): an app header, a *Create project* banner, **active
   projects as large cards**, and inactive/archived projects listed below.
   There's no sidebar.
2. **Create project** (`#/projects/new`): name and project directory
   (required, with a **Browse…** folder dialog served by the API), plus
   organization, owner email and status.
3. **Project workspace** (`#/projects/:id`): the chat window, with a left
   sidebar for project settings. Chats are deep-linkable
   (`#/projects/:id/chats/:sessionId`), and the header's *Chats* menu lists the
   project's history.

![Home](.screens/20-landing.png)

> Screenshots in `.screens/` were captured against the bundled mock API.

## What it does

- **Project home page**: active projects as cards (directory, organization,
  chat count, last activity) and the rest as a compact list.
- **Create-project page** with a server-side **directory picker**
  (`GET /api/fs/directories`). Browsers can't expose real paths, so the API
  host lists its own folders.
- **Stage workspace** (registry projects): opening a project shows its SDLC
  stages (a stage bar above the stage: completed stages are viewable read-only, the current one is highlighted, later ones are disabled), a project panel (info, links, settings), the checklist and a bottom status bar (model, tokens, cost, context). **Planning & Feasibility** runs end to end: business brief →
  stage run → analyzer / TELOS author / reviewer pipeline (polled) → review
  findings → TELOS feasibility report (rendered, downloadable with auth) →
  a final go / conditional-go / no-go decision → *Advance to Requirements*. **Requirements** supports brief and PDF inputs, automatic review and revision, then a final gate with coverage findings and Approve, Reject, and Refine actions. Coverage blockers require an explicit waiver reason to approve; rejection publishes nothing. Approval publishes the requirements specification and PDF. The stage catalogue controls runtime availability; unsupported stages remain read-only.
- **Project log viewer** (`#/projects/:id/logs`, registry projects): newest-first logs of one project with level / stage / run /
  role / type / text filters, shareable filter URLs, live tail, "load older", row detail (payload, ids, link to the run), secret
  masking and JSONL/CSV export. Logs are isolated per project. A collapsible **Traces** card shows the project's
  Phoenix summary (spans, errors, tokens, latency, per-role breakdown) when Phoenix is enabled on the API.
- **Project chat** (`#/projects/:id/chats`, local projects only; registry projects chat inside their stages via the docked stage chat): a project-settings sidebar (details, status, edit,
  delete) and a *Chats* history menu with deep links.
- **Real streaming** from `POST /api/chat/stream` using `fetch` + a small SSE
  parser (no `EventSource`; POST bodies and auth headers work).
- **Session continuity** — the harness session id returned by the API is kept
  and sent on the next turn.
- **Stop a response** with an inline stop control; aborted turns are marked
  stopped rather than failed.
- **Markdown** responses with GFM tables, task lists, inline code, syntax
  highlighting and copy buttons.
- **Project details rail** with workspace, branch, created date, recent chats
  and local-project actions.
- **Connection settings** for API base URL and optional bearer token, with a
  test-connection action.
- **Light / dark / system themes**, responsive drawer sidebar, tablet overlay
  panel and mobile layout.
- **Projects registry** — when the API has `DATABASE_URL`, projects come from
  `/api/projects` (PostgreSQL): name, root path, organization, owner and
  status, with a one-click status switch. New chats are sent with `projectId`,
  so the harness runs in the project's root and the API binds the session to
  the project. Archived projects are listed last and cannot start new chats.
- **Local fallback** — if the registry is unavailable (no database, older API,
  network/auth error) projects and chat grouping fall back to browser storage,
  and the UI labels that mode.

## Quick start

Requirements: Node.js 20.19+ and a running Chat API.

```sh
cd apps/chat-web
npm install
npm run dev
```

Open the URL Vite prints, normally <http://localhost:5173>. The UI defaults to
the API at <http://127.0.0.1:8787>.

Start the API from the repository root:

```sh
cd apps/chat-cli
node src/api.ts
```

The API allows all browser origins by default, so the Vite origin works without
extra configuration. If you run the API elsewhere, set the URL in **Settings**
inside the app, or create `.env`:

```dotenv
VITE_API_BASE_URL=http://127.0.0.1:8787
# Optional, and embedded into the build if set. Prefer the Settings dialog.
# VITE_API_TOKEN=
```

### UI development without a model

A mock API is included for layout work and end-to-end UI testing. It implements
health, sessions, the projects registry (including status and project-scoped
streaming) and delete, with deterministic seed data.

```sh
# terminal 1
npm run mock                # http://127.0.0.1:8788

# terminal 2
npm run dev
```

Then set **Settings → API base URL** to `http://127.0.0.1:8788` (the mock is an
in-memory process; restart it to reset its fixtures).

### Production build

```sh
npm run build
npm run preview             # http://localhost:4173
```

`dist/` is static. Serve it from any static host and point **Settings → API base
URL** at the Chat API. Because the API is a separate origin, keep its CORS
allowlist in mind:

```sh
AIFACTORY_CORS_ORIGIN=https://your-ui.example node apps/chat-cli/src/api.ts
```

## Projects: registry first, local fallback

`src/hooks/useProjects.ts` calls `GET /api/projects` on load and whenever the
API settings change:

| Mode | When | Projects | Chat ↔ project |
| --- | --- | --- | --- |
| **Registry** (`api`) | `/api/projects` answers | PostgreSQL via `/api/projects` | Bound server-side: new chats send `projectId`, sessions return `projectId` |
| **Local** (`local`) | 404 / 503 / network or token failure | `localStorage` (`src/data/projects.ts`), seeded General / Atlas / Forge | Browser map (`src/data/assignments.ts`) |

Grouping rule (`sessionProjectId` in `src/data/assignments.ts`): a server
binding always wins; otherwise the browser map; otherwise the fallback project.
Sessions started without a project (for example from the CLI) are filed under
the fallback project.

Registry rules enforced by the API:

- A session stays in the project of its first turn; continuing it never sends
  `projectId` again (a different one is `409 SESSION_PROJECT_MISMATCH`).
- Archived projects cannot start new chats (`409 PROJECT_ARCHIVED`); the UI
  disables the composer for them and hides their "new chat" button.
- Removing a project deletes only the registry row, never the root directory.
  Its chats move to the fallback project in the sidebar.

In local mode, deleting a project reassigns its chats to General, which cannot
be deleted.

Local storage keys (useful for resetting a demo):

```text
aifactory.chat-web.projects.v1
aifactory.chat-web.assignments.v1
aifactory.chat-web.settings.v1
aifactory.chat-web.theme.v1
aifactory.chat-web.sidebar-collapsed.v1
```

## API contract used

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Connection state and harness profile shown in the sidebar. |
| `GET /api/sessions` | Chat list, newest first. |
| `GET /api/sessions/:id/messages` | Transcript for the selected chat. |
| `DELETE /api/sessions/:id` | Delete the API's local chat record. |
| `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id` | Project registry CRUD. |
| `PATCH /api/projects/:id/status` | Status switch in Project details. |
| `GET /api/sdlc/stages` | Stage display names (local fallback if it fails). |
| `GET /api/projects/:id` | Project + SDLC state (stages, checklist) + documents. |
| `PATCH /api/projects/:id/stage` | Advance to the next stage (409 `STAGE_CHECKLIST_INCOMPLETE` lists open items). |
| `GET/POST /api/projects/:id/stages/:stage/runs` | Run history / start a planning run with `{ brief }`. |
| `GET /api/stage-runs/:id`, `/reviews`, `POST …/execute`, `POST …/decision` | Poll a run, reviews, start execution (202), record the human decision. |
| `GET /api/projects/:id/documents/:docId/content` | TELOS report body (fetched with the bearer token, downloaded via a Blob URL). |
| `GET /api/projects/:id/logs` | Project log viewer (filters: `level`, `stage`, `runId`, `role`, `type`, `q`; paging: `before`). |
| `GET /api/projects/:id/observability` | Phoenix trace summary card in the log viewer (`503` when Phoenix is off). |
| `POST /api/chat/stream` | Run one turn (`message`, `sessionId?`, `projectId?`) and consume `session`, `status`, `text`, `thinking`, `tool_call`, `tool_result`, `final`, `done` and `error`. |

Implementation details:

- `src/api/client.ts` — typed fetch client, bearer token support, error envelope
  mapping and SSE orchestration.
- `src/api/sse.ts` — dependency-free SSE frame parser tolerant of chunk
  boundaries, CRLF, comments and multi-line data.
- `src/api/types.ts` — wire types matching [the API docs](../../apps/chat-cli/API.md).
- A stream that closes without `done` becomes `STREAM_INCOMPLETE` and is shown
  as a recoverable error. `error` events become structured `ApiError`s.
- Committed `text` blocks are appended; `done.text` is treated as authoritative
  once the turn finishes.

Authentication is optional. If the API is started with `AIFACTORY_API_TOKEN`,
enter the token under **Settings**. It is sent as `Authorization: Bearer …` on
chat/history requests and kept in `localStorage` — use it only on a trusted
machine.

## Architecture

```text
apps/chat-web/
  index.html                  app shell + pre-paint theme boot
  public/favicon.svg
  scripts/mock-api.mjs        deterministic dev API
  src/
    main.tsx
    App.tsx                   router + shared state (projects, sessions, dialogs)
    pages/
      LandingPage.tsx         #/ — banner, active cards, other projects
      CreateProjectPage.tsx   #/projects/new — form + DirectoryPicker
      ProjectWorkspace.tsx    #/projects/:id[/chats/:sid] — chat state + layout
    api/
      client.ts               JSON + SSE transport
      sse.ts                  frame parser
      types.ts                wire types
    data/
      projects.ts             Project model, local ProjectRepository, API mapping
      assignments.ts          session ↔ project mapping + grouping
      settings.ts             API URL/token, theme preference
      chat.ts                 transcript view model and tool-call state
    hooks/
      useApiHealth.ts         health polling
      useTheme.ts             system/light/dark resolution
      useAutoScroll.ts        pinned transcript + jump-to-latest
      useToasts.ts
    components/
      AppHeader, ProjectSidebar, ChatHeader, DirectoryPicker, ChatView,
      MessageList, Composer, EmptyState, ProjectDialog (edit), SettingsDialog,
      ConfirmDialog, Modal, Markdown, Icons, ToastViewport
    lib/                      router, formatting, storage, clipboard, ids
    styles/tokens.css         harness-inspired light/dark token sheets
    styles/app.css            shared components + chat
    styles/pages.css          landing, create page, picker, workspace shell
  test/                       Vitest unit tests
```

The dependency direction is one-way: pages → components → hooks/data → api/lib. There
are no imports from `apps/chat-cli` or the harness checkout, so the UI can be
developed, built and deployed independently.

## Scripts

| Command | Effect |
| --- | --- |
| `npm run dev` | Vite dev server on port 5173. |
| `npm run build` | Typecheck, then build `dist/`. |
| `npm run preview` | Serve the production build on port 4173. |
| `npm run typecheck` | TypeScript only. |
| `npm test` | Vitest unit suite. |
| `npm run test:watch` | Vitest watch mode. |
| `npm run mock` | Mock Chat API on port 8788 (`PORT`/`HOST` overridable). |

## Tests

```sh
npm test
```

The suite covers SSE chunking and framing, API client streaming/errors/auth,
project repository persistence and protection, session↔project reconciliation,
grouping/sorting, formatting and tool-call state. It uses no network and no
model credentials.

The UI was also exercised end-to-end against the mock API with a headless
browser for: first-turn streaming, stopping a response, project create/edit/
delete, settings and theme persistence, search, chat deletion, collapsed
sidebar, tablet overlay panel, and a read-only load against the real API on
port 8787.

## Known limits

- In local fallback mode projects are browser-only; there is no cross-device
  sync, and two tabs can overwrite each other's local project edits.
- The Chat API emits committed text blocks, not token deltas. The UI appends
  blocks and pauses while tools run; it does not animate tokens.
- No attachments: the composer's paperclip is intentionally disabled until the
  API supports uploads.
- No tool-approval UI; the API does not expose an approval channel yet.
- The bearer token is stored in `localStorage` because this is a local developer
  tool. A shared deployment should use a proper session/auth boundary.
- Deleting a chat removes the API's local record only; the harness transcript
  remains on disk, matching the API's documented semantics.
