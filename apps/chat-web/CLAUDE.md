# CLAUDE.md — apps/chat-web

Projects-first React web UI for the **AI Factory Chat API** (`apps/chat-cli`,
default `http://127.0.0.1:8787`). Standalone Vite + React 18 + TypeScript app;
it talks to the API only over HTTP/SSE and must never import from `apps/chat-cli`
or the harness checkout.

## Commands

```sh
npm run dev        # Vite on :5173 (strictPort)
npm run build      # tsc --noEmit + vite build → dist/
npm run preview    # serve dist on :4173
npm run typecheck
npm test           # vitest, no network (104 tests as of 2026-11-12)
npm run mock       # deterministic mock Chat API on :8788 (in-memory; restart to reset)
                   # MOCK_STAGE_STEP_MS=500 speeds up simulated stage runs
```

Real API: `cd ../chat-cli && node src/api.ts`. Live docs/console at
`http://127.0.0.1:8787/docs`, contract at `/openapi.yaml` (identical to
`../chat-cli/openapi.yaml`), human docs in `../chat-cli/API.md`. Check the
contract there before changing `src/api/types.ts`.

Always run `npm run typecheck && npm test` after changes.

## API surface (as of 2026-11-10)

All endpoints below are used by the UI except `POST /api/chat` (non-streaming)
and `GET /api/tools`.

- `GET /api/health` — returns `database: "postgres" | "disabled"`.
- `GET /api/sessions[?projectId=]`, `GET /api/sessions/:id[/messages]`,
  `DELETE /api/sessions/:id` — summaries carry `projectId` when bound.
- `POST /api/chat/stream` — body `{ message, sessionId?, projectId? }`; SSE
  events session, status, text, thinking, tool_call, tool_result, final, done, error.
- `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id`,
  `PATCH /api/projects/:id/status` — PostgreSQL registry (needs `DATABASE_URL`).
  The API also enforces a max-active-projects setting (default 3).

**Project scoping** (added to `apps/chat-cli` on 2026-11-10): `projectId` on a
new chat runs the harness with `cwd = project.rootPath` and binds the session
to that project (stored in `.data/sessions.json`). Continuing a session reuses
the bound project; a different `projectId` → `409 SESSION_PROJECT_MISMATCH`;
archived project starting a new chat → `409 PROJECT_ARCHIVED`. The UI sends
`projectId` **only on the first turn** of a registry-project chat.

Errors use `{ error: { message, code, status } }`. Body limit 1 MiB, message
limit 64 KiB.

## Pages (hash routes, `src/lib/router.ts`)

| Route | Page | Layout |
| --- | --- | --- |
| `#/` | `pages/LandingPage.tsx` | `AppHeader` only (no sidebar). Create-project banner, then **active** projects as big cards, then inactive/archived as a list. |
| `#/projects/new` | `pages/CreateProjectPage.tsx` | Name + directory (required, **Browse…** opens `DirectoryPicker`), organization, owner email, status (optional). |
| `#/projects/:id` | redirect | Registry mode → `stages/<currentStage>`; local mode → `chats`. |
| `#/projects/:id/stages/:stage[/runs/:runId]` | `pages/StageWorkspace.tsx` | **Stage workspace** (registry projects only): project header, `StageRail`, stage main (Workspace / Chat tabs), `ContextPanel`. |
| `#/projects/:id/logs[?level=&role=&stage=&run=&type=&q=]` | `pages/LogsPage.tsx` | **Project log viewer** (registry projects only; local projects are redirected to chat). Full-height page: stage-style header, `LogToolbar` filters, status bar (live state, export), scrollable `LogRow` list. |
| `#/projects/:id/chats[/:sessionId]` | `pages/ProjectWorkspace.tsx` | Left `ProjectSidebar` (project **settings only**: details, status, edit, delete, placeholder for future settings) + `ChatHeader` (chat history menu, new chat) + `SdlcBar` + `ChatView`. |

- The route is the source of truth for the open chat. A stream's new session id
  is written with `navigate(..., { replace: true })`; `streamSessionRef` stops
  that route change from reloading the transcript. Switching chats mid-stream
  aborts the stream.
- `SdlcBar` on the chat page: for registry projects it shows the API stage
  (`project.currentStage`, 8 stages) and clicking opens the stage workspace. The
  localStorage behaviour below applies to **local-mode projects only**.
- `SdlcBar` (`components/SdlcBar.tsx`, data in `data/sdlc.ts`): a 30px strip
  directly under the chat header with 7 stages: Planning, Requirements, Design,
  Development, Testing, Deployment, Maintenance. Earlier stages are green
  (completed), the current one glows (`sdlc-glow` animation; static under
  reduced motion), later ones are grey. Clicking a stage makes it current.
  **The stage is stored per project in localStorage** (`aifactory.chat-web.sdlc.v1`)
  because the API has no stage field; swap `loadStage`/`saveStage` for API calls when it gets one.
- **Requirements intake** (`components/RequirementsIntake.tsx`, logic in
  `data/requirements.ts`): a project with **no chats** shows it instead of the
  empty state and the composer (via ChatView's `intake` prop). It has a
  "Skip and start a blank chat" link.
  - Text tab: large textarea (≤ 60,000 chars) + optional message → first
    streamed turn: `<message or default>\n\n## Project requirements\n\n<text>`.
  - PDF tab (registry projects only): `.pdf` only, ≤ 5 MB, `%PDF-` signature
    checked client-side, plus an optional message. `pdf-review` requires an
    **existing session**, so the UI first streams a short intro turn (opens and
    binds the session), then `POST /api/projects/:id/sessions/:sid/pdf-review`
    (multipart `file` + `message`, added by another contributor). The API
    extracts the text, reviews it in the project root and records the turn; the
    UI shows `analysis.markdown`. The API itself accepts up to 20 MB; the 5 MB
    limit is a UI rule.
### Stage workspace (spec: `../../docs/ui/STAGE-UI-PROMPT.md`, design: `../../docs/design/STAGE-RUNTIME.md`)

The stage run, not the chat, is the primary object. Only `planning` executes;
other stages show a read-only "Runtime not implemented yet" card plus their
checklist/documents.

- API (`client.ts`): `listSdlcStages`, `getProjectDetail` (`{project, sdlc{currentStage,stages,checklist}, documents}`),
  `listStageRuns`, `createStageRun` (201), `executeStageRun` (202, **never `?wait=1`**),
  `getStageRun`, `listStageReviews`, `decideStageRun`, `advanceStage` (`PATCH /projects/:id/stage`),
  `getDocumentContent` (Blob with bearer auth → object URL download, revoked).
- Flow: brief → `POST runs` → navigate to run route → `execute` → poll.
  `hooks/useStageRun.ts` polls one request at a time: 1.5 s, 3 s after 30 s, stop at
  `awaiting_human|completed|failed|cancelled`, pause while hidden, 30-min cap, abort on unmount.
  `execute` only calls `resume()` when polling has stopped (avoids a second poller).
- Pure logic in `data/stages.ts` (pipeline mapping, severity/revision counts, failure text
  and cycle limit read from `summaryMarkdown`, recorded decision parsed from the
  `## Human decision` section, advance gate, `STAGE_CHECKLIST_INCOMPLETE` label parsing,
  poll cadence) and `data/stageErrors.ts` (API code → UI state). Tests: `test/stages.test.ts`.
- The execute call is backgrounded, so a failed run's error only appears in
  `summaryMarkdown` (`# … failed\n\n<message>`); `REVIEW_CYCLE_LIMIT` is detected from that text.
  `STAGE_ROLE_FAILED` messages start with the role (`analyzer|author|reviewer failed: …`);
  `failedRole` turns that into the notice title ("TELOS author failed") and `failedStep`
  marks the pipeline (role in message → last seen step → what was persisted).
- Failed/cancelled runs show `PartialOutputCard` (RunPanels): the persisted
  `analysisMarkdown` / `draftMarkdown` read-only, sanitized, with a `.md` download. Both
  fields are optional in the types (older APIs omit them).
- Brief drafts persist per project in `aifactory.chat-web.briefs.v1`; a retry is prefilled
  from the last run's `inputText` when there's no draft.
- Reviewer findings render as plain text; TELOS/summary Markdown goes through
  react-markdown without raw HTML (sanitized). The Chat tab is a placeholder; the stage
  UI never calls `/api/chat`.
- **Log viewer** (`GET /api/projects/:id/logs`, newest first, project-scoped; contract in `../chat-cli/API.md` "Project log viewer"):
  - Isolation: the project id is in every request path; `ChatApi.listProjectLogs` also drops entries whose `projectId` differs;
    `LogsPage` is keyed by project id in `App` (remount = all state dropped); `useProjectLogs` aborts + resets on project/filter change.
  - Filters (server side): level (single — the API takes one), stage, run (`runId`), role, type, `q` (300 ms debounce). Filters live in the
    URL query (`filtersToSearch`/`filtersFromSearch` in `data/logs.ts`); URL updates use `replaceState` (no re-route), a real navigation to
    different filters is adopted via the `initialSearch` effect.
  - `hooks/useProjectLogs.ts`: first page (100) → "Load older" with `before=nextBefore` → cap 2,000 rows (`trimmed` notice, no more paging).
    Live tail is a separate effect: one poll at a time every 3 s, paused while the tab is hidden, backoff 3/6/12/20 s on network errors,
    stops on 400/401/403/404/503; chases up to 5 pages to close gaps. At the top of the list new rows merge in; scrolled away they are
    buffered and shown via the "N new logs" pill.
  - `message`/`preview`/`payload` are untrusted: plain text only, `redactSecrets` unless "Mask secrets" is unticked (also applied to JSONL/CSV
    export; CSV cells starting with `= + - @` are prefixed with `'`).
  - Entry points: stage workspace header "Logs", chat sidebar "View project logs", row action "Open run" links back to the run.
  - **Trace card** (`components/logs/ObservabilityCard.tsx`, `hooks/useObservability.ts`, pure `data/observability.ts`;
    `GET /api/projects/:id/observability?hours=`): aggregates only (traces, spans, errors + rate, tool calls, tokens, p50/p95/max,
    per-role table). Window 1/6/24/72/168 h and collapsed state persist in `aifactory.chat-web.logs.v1`. Refreshes every 60 s while
    visible. States: `503 PHOENIX_DISABLED` or 404 → one quiet line (polling stops); `available:false` → warning with `reason`
    ("Logs are unaffected"); 401/403 → token message; other errors keep the previous data. The Errors value and role names are
    buttons that set the log filters (level=error / role=…). It never blocks or fails the log list. `normalizeObservability`
    coerces every field. Mock: `MOCK_PHOENIX=off` → 503; the Forge project answers `available:false`.
  - **"View in logs"** in the Activity drawer header: `runLogsHref` (`data/logs.ts`) links to `#/projects/:id/logs?run=<runId>`, adding
    `role=` / `level=error` when the drawer is filtered on a role / errors only.
  - Not done yet: system-wide (non-project) logs.
  - Mock: `scripts/mock-stages.mjs` serves `/api/projects/:id/logs` derived from its event store. E2E: `.pw-logs.cjs` (fresh mock with
    `MOCK_STAGE_STEP_MS=150`, runs seeded for Atlas incl. a `FAIL` brief, and one for Forge; `npm run build && npm run preview`).
- **Activity drawer** (spec: `../../docs/ui/EVENT-ACTIVITY-INTEGRATION-PROMPT.md`): the persisted
  stage-run event log (`GET /api/stage-runs/:id/events`, SSE `/events/stream`).
  - `api/stageEvents.ts` `followStageRunEvents`: JSON backlog (pages of 500) → SSE from the last id
    (fetch + ReadableStream, bearer in header, `?after=`), reconnect 1/2/5/10/10 s then stop,
    one retry after `event: error`, stop on 401/403/404/503. Terminal runs load the backlog only;
    `awaiting_human` keeps the stream open for `human_decision`. `event: end` → refresh the run.
  - `hooks/useRunEvents.ts`: one reader per run (lives in `StageWorkspace`, not the drawer, so the
    current-activity line works while closed), 100 ms batching, merge by numeric id, 2,000 cap.
  - `data/activity.ts` (pure): chronological role groups (new group per `role_start`, "Author · pass 2"),
    status collapse, tool call/result pairing by `callId` (supports old `name`/`arguments`), filters,
    current-activity line, client-side secret redaction, per-role totals for the pipeline badges.
  - `components/stage/Activity.tsx`: `CurrentActivityLine`, `ActivityDrawer` (fixed right panel below
    the sticky header, resizable, width in `aifactory.chat-web.activity.v1`; full-screen sheet ≤820px;
    Esc closes from anywhere and restores focus). **Pipeline steps are buttons** that open the drawer
    filtered to that role. Payload text renders as plain text only; raw JSON behind "Raw events".
- Components: `components/logs/{LogToolbar,LogRow}.tsx`, `components/stage/{StageBits,StageRail,RunPanels,TelosDocument,ContextPanel,Activity}.tsx`;
  styles in `styles/stage.css` (three columns ≥1181px, context below main ≤1180px,
  horizontal stepper ≤820px).

- `DirectoryPicker` needs `GET /api/fs/directories` (it lists directories on the API host,
  because browsers can't reveal local paths). On older APIs it says so and the
  path is typed by hand.
- Local fallback mode: the landing page shows a notice, and the create page saves to
  localStorage (name + directory + description).

## Architecture

Dependency direction is one-way: `pages → components → hooks/data → api/lib`.

- `src/App.tsx` — router + shared state: API client, health, projects,
  sessions, session→project grouping, settings/edit/delete dialogs, toasts.
- `src/pages/ProjectWorkspace.tsx` — chat state (messages, streaming turn,
  stop, load) for one project; keyed by project id.
- `src/api/client.ts` — typed fetch client (`ChatApi`), bearer auth, error
  mapping (`ApiError`), SSE orchestration. A stream ending without `done` →
  `STREAM_INCOMPLETE`. Abort = "stopped", not an error.
- `src/api/sse.ts` — dependency-free SSE parser (chunk boundaries, CRLF, comments).
- `src/hooks/useProjects.ts` — **dual mode**: tries `GET /api/projects`; on
  success uses the Postgres registry (`mode: 'api'`), on 404/503/network/auth
  failure falls back to browser-local projects (`mode: 'local'`).
- `src/data/projects.ts` — local `ProjectRepository` (localStorage, seeded
  General/Atlas/Forge; General can't be deleted) + `apiProjectToProject` mapping.
- `src/data/assignments.ts` — `sessionProjectId`: server `session.projectId`
  wins, then the browser-local map. In registry mode, chats not bound to a project
  (e.g. started from the CLI) don't appear in any project. In local mode they're
  filed under General.
- `src/data/settings.ts` — API base URL + token (localStorage), theme.
- `src/data/chat.ts` — transcript view model / tool-call state.
- `scripts/mock-stages.mjs` — mock stage runtime (SDLC stages, checklist, documents,
  simulated planning runs; saves analysis/draft like the real controller). Brief containing
  every role turn writes realistic events (role_start, session, status+usage, thinking, tool_call/result,
  text, final, role_end/role_error; review_decision, document_created, human_decision) and serves
  `/events` + SSE `/events/stream`; brief `DROP` cuts the first stream after 4 events (reconnect test).
  `FAIL` → author `STAGE_ROLE_FAILED` (analysis kept), `REVIEWERFAIL` → reviewer failure (analysis + draft kept), `CYCLE` →
  `REVIEW_CYCLE_LIMIT`; rootPath containing `missing` → `PROJECT_ROOT_UNAVAILABLE`.
  The fake TELOS report and findings contain `<script>`/`<img onerror>` to prove sanitizing.
- `scripts/mock-api.mjs` — mock that mirrors the real API (projects, status,
  projectId scoping, 409s, `/api/fs/directories` over the real filesystem).
  In-memory: restart it for fresh seed data.

localStorage keys: `aifactory.chat-web.{projects,assignments,settings,theme,sdlc,briefs,activity,logs}.v1`.

## Conventions

- Strict TS; imports use explicit `.ts`/`.tsx` extensions.
- Styling: plain CSS with design tokens in `src/styles/tokens.css` (light/dark);
  no CSS framework. `app.css` = shared components + chat; `pages.css` = landing,
  create page, directory picker, workspace shell. Theme is set pre-paint in
  `index.html`. `app.css` still has rules for the removed old sidebar/panel
  (`.sidebar`, `.project-panel`, `.app` grid); they're safe to prune.
- Modal: `src/components/Modal.tsx` keeps `onClose` in a ref so the effect only
  depends on `open` (fixes a bug where Cancel/X/overlay didn't close dialogs).
- Keep components consuming `Project`/`SessionSummary` only — transport details
  stay in `api/` and `data/`.

## E2E / screenshots

Ad-hoc Playwright scripts live at the root as `.pw-*.cjs` (gitignored, not a
test suite). They load Playwright from `.npm-cache/_npx/...` and need
`PLAYWRIGHT_BROWSERS_PATH=$PWD/.pw-browsers`, a **fresh** mock on :8788 and
`npm run build && npm run preview` on :4173. Stage workspace: `.pw-stages.cjs` (needs `MOCK_STAGE_STEP_MS=500` mock; full planning
flow, activity drawer incl. reviewer step expand/filters/redaction/reconnect, failure, cycle limit,
no-go, reload, keyboard, mobile, dark, token/poll/one-stream rules). A live run keeps the SSE stream
open, so don't use `waitUntil: 'networkidle'` on a run page that's still running or awaiting a decision.
Main one: `.pw-pages.cjs`
(landing → create project via directory picker → requirements intake → chat →
history → deep link → mobile → dark) and `.pw-intake.cjs` (text + PDF intake,
file validation, skip, mobile). Older `.pw-*` scripts target the removed sidebar layout.
Screenshots go to `.screens/` (tracked; the README links one).

Careful: `pkill -f <pattern>` also kills your own shell if the pattern's text
appears anywhere in that command line (e.g. `mock-api.mjs`, `vite preview`).
Use bracket patterns like `pkill -f "node scripts/[m]ock-api"`, and don't put
the plain text in the same command.

## Known gaps / TODO (as of 2026-11-10)

1. Project settings sidebar: only details/status/edit/delete so far; more
   settings are planned (the placeholder card marks the spot).
2. Chats not bound to a project (CLI sessions, pre-registry chats) are hidden in
   registry mode; the API forbids rebinding a session to a project.
3. `useProjects` / page logic isn't unit tested (no React testing library);
   covered by `.pw-pages.cjs`.
4. The API has `GET/PATCH /api/settings` (max active projects, added by another
   contributor); the UI doesn't expose it yet.
5. PDF intake costs two model turns (intro + review), because `pdf-review`
   needs an existing session. A session-less variant
   (`POST /api/projects/:id/pdf-review`) would cut it to one.
   `pdf-review` answers 500 for a zero-byte file (multipart edge case in
   chat-cli; the UI never sends one).
6. Stage runtime: only Planning executes; no stage chat yet (placeholder tab); the
   API exposes no per-role progress, so the pipeline is derived from run status only.
   Advancing past a stage other than Planning isn't offered in the UI yet (no runtime).
   The `PATCH /projects/:id/checklist/...` and document upload endpoints aren't used.
   Activity: no "Load older" past the 2,000-event cap (a trimmed notice is shown). Event payloads were
   verified against the mock and the chat-cli source; runs on the real API created before the event
   table have no events.
7. Not a git repo yet.
8. From README: no attachments, no tool-approval UI, token kept in localStorage,
   no token-level streaming (API sends blocks).
