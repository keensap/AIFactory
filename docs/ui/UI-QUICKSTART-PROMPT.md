# UI Coder Quick Prompt — Stage Workspace, Logs, Observability, Search

Build the AI Factory UI against the API at `http://127.0.0.1:8787` (contract: `/openapi.yaml`, console: `/docs`). Send `Authorization: Bearer <token>` if a token is configured. Never put the token in a URL.

Detailed specs, if you need them: [STAGE-UI-PROMPT.md](STAGE-UI-PROMPT.md) (stage workspace) and [EVENT-ACTIVITY-INTEGRATION-PROMPT.md](EVENT-ACTIVITY-INTEGRATION-PROMPT.md) (live activity + logs).

## 1. Stage workspace (Planning & Feasibility first)

- Stage rail from `GET /api/sdlc/stages`; project data from `GET /api/projects/:id` (`sdlc`, `documents`).
- Only `planning` is executable. Other stages: read-only "runtime not implemented".
- Flow: brief → `POST /api/projects/:id/stages/planning/runs` → `POST /api/stage-runs/:runId/execute` (returns 202; never use `?wait=1` in the browser) → poll `GET /api/stage-runs/:runId` every 1.5–3 s until `awaiting_human`, `completed`, `failed` or `cancelled`.
- Show pipeline (analyzer → author → reviewer), review findings, TELOS document (sanitized Markdown, authenticated download), then the human gate `POST /api/stage-runs/:runId/decision` (`go` | `conditional_go` | `no_go`). Advancing the stage is a separate explicit action: `PATCH /api/projects/:id/stage`.
- A failed run is terminal: offer "new attempt" (new `POST .../runs`), keep the brief, show `analysisMarkdown` / `draftMarkdown` as partial output.
- Handle errors by `error.code`: `STAGE_RUN_LEASED`, `STAGE_RUN_LEASE_LOST`, `STAGE_ROLE_FAILED`, `REVIEW_CYCLE_LIMIT`, `PROJECT_ROOT_NOT_WRITABLE`, `DOCUMENT_WRITE_FAILED`, `STAGE_CHECKLIST_INCOMPLETE`, `501 STAGE_RUNTIME_NOT_IMPLEMENTED`.

## 2. Live Activity (per run)

- `GET /api/stage-runs/:runId/events?after=<id>` for history; `GET .../events/stream?after=<id>` for SSE.
- Use `fetch` + `ReadableStream` (not `EventSource` — it cannot send the bearer header). Parse SSE incrementally; reconnect with the last event id and backoff; stop on `event: end`.
- Order events by numeric `id`, de-duplicate on replay, batch renders (~100 ms).
- Drawer UI: group by role; collapse `thinking`, `status` and `tool_result` by default; show tool commands in monospace with copy; keep `awaiting_human` streams open.

## 3. Logs (project view, global view, settings)

- **Project Logs**: `GET /api/projects/:id/logs?source=events|app|all&limit=100&level=&role=&runId=&stage=&type=&q=&before=<cursor>`. Default `events` is the stage audit trail; `app` is application logs; `all` merges both. Newest first. For `events`/`app` page with `before=nextBefore` (numeric id); for `all`, `nextBefore` is an ISO timestamp. Dedupe on `source:id`. Show a source badge.
- Show `message` as the main line, `preview` for text, `payload` behind a disclosure. Color by `level` (`trace|debug|info|warn|error|fatal`) and also label it. Clicking a row opens its run (`stageRunId`); show `requestId` with a copy button and a "show everything for this request" action (`GET /api/logs?requestId=`).
- `source=app|all` returns `503 LOG_STORE_NOT_CONFIGURED` without a database; if `postgresEnabled` is `false` show "Enable database logs in Settings → Logging to search application logs here" and fall back to `events`.
- **Global Logs** (operators): `GET /api/logs` with `level`/`minLevel`, `event` (prefix with `stage.*`), `component`, `projectId`, `stageRunId`, `requestId`, `q`, `from`, `to`.
- **Settings → Logging**: `GET/PATCH /api/settings/logging` — toggle `postgres.enabled` (default off), `postgres.minLevel`, `postgres.retentionDays`, `file.retentionDays`, `level`. Applies live; handle `409 POSTGRES_UNAVAILABLE` and `400` validation codes. There is no signal toggle.
- **Logging health** (operators): `GET /api/admin/logging` — queue drops, per-sink `state` (`healthy|degraded|open|half_open`), `lastError`. `PUT /api/admin/logging/level` `{ "level": "debug", "ttlSeconds": 900 }` for "debug for 15 min"; show the countdown from `levels.revertAt`. Admin calls need the bearer token (or a loopback client); handle `403 ADMIN_FORBIDDEN`.
- Send `X-Request-Id` (8–64 chars `A-Za-z0-9._-`) from the UI if you want to correlate a user action with logs; read it back from every response.
- Records with `traceId` can show an "Open trace in Phoenix" link (operator-only; Phoenix is shared and has no per-project authorization). Phoenix stores **traces, not logs**; never offer "view logs in Phoenix". OTLP log export, if enabled server-side, targets a collector and is invisible to this UI.
- `GET /api/admin/logging` also reports per-sink `spool` counts and `spooled`/`replayed`; show a warning when `state` is `open` and records are spooling, and a note that database/OTLP logs will catch up after recovery.

## 3.1 Usage and duration statistics

- `GET /api/projects/:id/stats?days=30&stage=&role=&from=&to=` — durable metrics from the harness event log, **not** Phoenix. Works when Phoenix is down.
- Show cards: total tokens (`tokens.total`), input/output, cache read/write; runs (`runs.total`) and status split; p95 task duration.
- Distinguish clearly:
  - **Wall-clock run time** = `runDurationMs`; may include hours waiting at the human gate.
  - **Agent task time** = `activeDurationMs`; sum of analyzer/author/reviewer execution. Use `activeDurationMs.avgMs`/`p95Ms` for “how long the agents took”.
- Tables/charts: `byRole` (tokens and duration per role), `byStage`, `daily` (UTC dates), and `recentRuns` (last 20; link to the run).
- `role` filter narrows tokens/durations and the role table; the run count still reflects runs containing that role. `stage` filters everything to one stage.
- Empty state: “No harness usage recorded in this window.” Do not show a fake zero chart; older runs may predate usage capture.
- `503 DATABASE_NOT_CONFIGURED` → hide the stats view (it needs PostgreSQL), like the project routes.

## 4. Observability card (optional)

- `GET /api/projects/:id/observability?hours=24` → traces, spans, errors, tokens, p95 latency, per-role breakdown.
- `available:false` → show "Observability unavailable" and keep the page usable; `503 OBSERVABILITY_DISABLED` → hide the card. Summary only — no prompts or tool content.
- `stale:true` → show a subtle "cached Ns ago" hint from `cachedAt`; the data is the last successful read.
- Operators: `GET /api/admin/observability` returns provider state (`healthy|degraded|open|disabled`), dropped spans, last error and cache stats; show it in the admin area, not on the project page.

## 5. Document search (optional)

- `POST /api/projects/:id/index` (all docs or `{"documentId"}`), `GET /api/projects/:id/search?q=...&limit=8` → ranked chunks with `sourcePath` and `score`. `503 SEMANTIC_INDEX_DISABLED` → hide the search box.

## Rules

- One typed API client (base URL, token, error envelope `{error:{message,code,status}}`, `AbortSignal`).
- Sanitize all Markdown/model text; no raw HTML; redact obvious secrets in logs client-side.
- Stage chat does not exist yet — reserve the tab, do not fake it or reuse `/api/chat`.
- Stop all polling/streams on route change; announce only status/error changes via `aria-live`.
- Done when: a new project can run Planning end to end, with live activity, logs and the decision gate, and survives refresh, reconnect and failure states.
