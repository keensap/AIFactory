# API needed to complete the project workspace UI

Audience: the `apps/chat-cli` (back-end) owner.
Written: 2026-11-13, against `apps/chat-cli/openapi.yaml` as it stands today.
Scope: what `apps/chat-web` still needs. Nothing here is built on the UI side yet unless marked **UI ready**.

Legend: ✅ exists and the UI uses it · 🟡 exists, UI not wired yet · ❌ missing (request).

## 1. Left panel links

| Link | Status | What the UI needs |
|---|---|---|
| Logs | ✅ | `GET /api/projects/:id/logs` (in use). |
| Chat | ✅ | `/api/chat/stream`, `/api/sessions` (in use). Chat is per stage now; see the stage-scoped chat row below. |
| Documents | 🟡 | `GET /api/projects/:id/documents`, `…/:documentId`, `…/:documentId/content` exist. A cross-stage Documents page can be built **now**; the link stays "soon" until you want it. Missing: filtering/pagination (see 1.1). |
| Images | ❌ | See 1.2. |
| Directories | ❌ | See 1.3. (`GET /api/fs/directories` lists *host* folders for the picker, not a project tree.) |
| Repository | ❌ | See 1.4. |

### 1.1 Documents (nice to have)
- `GET /api/projects/:id/documents?stage=&kind=&status=&q=&limit=&before=` with paging (`nextBefore`, like `/logs`).
- Document `size` (bytes) and `mimeType` in `ProjectDocument`, so the page can show size and choose a viewer.
- `DELETE /api/projects/:id/documents/:documentId` (soft delete) — only when editing is enabled later.

### 1.2 Images
Needs a notion of image artifacts (screenshots, mock-ups, diagrams).
- Either a `kind: image` convention on documents, or `GET /api/projects/:id/images?stage=&limit=&before=`.
- Fields: `id`, `title`, `stage`, `mimeType`, `width`, `height`, `size`, `createdAt`.
- `GET …/images/:id/content` with bearer auth and correct `Content-Type` (`image/png|jpeg|webp|svg+xml`), plus `…/thumbnail?w=240`.
- Security: serve SVG with `Content-Security-Policy: sandbox` / `Content-Disposition`; the UI will never inline it as HTML.

### 1.3 Directories (project file browser, read-only)
- `GET /api/projects/:id/files?path=<relative>&hidden=0` → `{ path, entries: [{ name, type: file|dir, size, modifiedAt }] }`.
  - Path is **relative to the project root**; reject `..`, absolute paths and symlinks that leave the root (same rules as `fs/directories`).
  - Cap entries (e.g. 1000) and report `truncated`.
- `GET /api/projects/:id/files/content?path=` for text preview (size limit, `415` for binary), UTF-8 only.
- Open question: respect `.gitignore`? (UI default: hide dot-folders and `node_modules`.)

### 1.4 Repository
The project has no repo data today (`rootPath` only).
- Add to `Project` (and `PATCH /api/projects/:id`): `repoUrl` (nullable), `defaultBranch` (nullable).
- Read-only git info for the root: `GET /api/projects/:id/repository` → `{ isRepo, branch, head: { sha, message, author, date }, dirty, ahead, behind, remotes: [{ name, url }] }`.
  - Strip credentials from remote URLs before returning them.
- Optional later: `GET …/repository/commits?limit=` and `…/branches`.

## 2. Project settings page

Today "Project settings" opens the existing edit dialog (`PATCH /api/projects/:id`, `PATCH …/status`). A full page needs:

| Setting | Status | Request |
|---|---|---|
| Name, root path, organization, owner, status | ✅ | none |
| Description | ❌ | `description` (string, ≤ 2000) on `Project` create/patch. |
| Model override per project | ❌ | `GET/PATCH /api/projects/:id/settings/models` (provider, model, temperature, maxTokens, reasoningEffort); falls back to the global `/api/settings/models`. |
| Per-project log level / retention | ❌ | Optional, only if per-project logging is wanted (global one exists: `/api/settings/logging`). |
| Members / access | ❌ | Out of scope until auth exists. |
| Danger zone (archive, delete) | ✅ | status + `DELETE /api/projects/:id`. |
| Max active projects | 🟡 | `GET/PATCH /api/settings` exists; UI could expose it on a global settings page. |

## 3. Status bar

| Item | Status | Source today | Request |
|---|---|---|---|
| Model | ✅ | `GET /api/settings/models` | A project override (see 2) would change this to the **effective** model for the project. Better: return `effectiveModel` in `GET /api/projects/:id`. |
| Context window | ✅ | `GET /api/models` (`contextWindow`) | none |
| Tokens consumed, cost | ✅ | `GET /api/projects/:id/stats` | Add a `?stageRunId=` (or `runId`) filter, so the bar can show **this run** as well as the 30-day total. |
| **Context % used** | ❌ (UI estimates) | Derived from the latest `status` event's usage ÷ window. | Expose it exactly: on the stage run (`GET /api/stage-runs/:id`) add `usage: { contextTokens, contextWindow, inputTokens, outputTokens, cacheRead, cacheWrite }` for the latest step, and include `contextTokens` in each `status` event payload. |
| **Tokens/sec** | ❌ (UI estimates) | Derived from `step_start`→`step_end` times. | Include `durationMs` and `outputTokens` in `status` `step_end` events, or return `tokensPerSecond` in the run `usage` object. Provider-reported timing is better than wall-clock. |
| Run state | ✅ | run polling | none |

Why these matter: the two derived values are labelled "≈" in the UI and are wrong whenever steps include tool time or queueing.

## 4. Stage bar and read-only history

| Need | Status | Request |
|---|---|---|
| Completed / current stage state | ✅ | `GET /api/projects/:id` (`sdlc.stages`, `currentStage`). |
| Editing a past stage (future) | ❌ | `POST /api/projects/:id/stage/rewind` `{ stage, reason }` → marks that stage `in_progress` and **invalidates later stages** (their runs/documents flagged `superseded`, checklist reset). Must be explicit, idempotent, and return what was invalidated so the UI can show it in the confirmation dialog. |
| Preview of what a rewind would invalidate | ❌ | `GET /api/projects/:id/stage/rewind-preview?stage=` (dry run of the above). |
| Runtime for stages after Planning | ❌ | `POST /api/projects/:id/stages/:stage/runs` + `execute` currently return `501 STAGE_RUNTIME_NOT_IMPLEMENTED` for everything except `planning`. |
| Stage-scoped chat | ❌ | Chat is docked per stage and works today without API support: the UI keeps the stage → sessions map in the browser and puts a `<stage-context>` block (stage, run, checklist, document links, one-line history) in the first message. Please add `stage` (+ optional `runId`) to `/api/chat/stream` and a `stage` field on sessions/`GET /api/sessions?projectId=&stage=`, and build that compact context server-side (documents are known there, and so is the token budget). Then the UI drops the hidden block and the localStorage map. |

## 5. Smaller gaps found while building

1. **Server-side document filter** `GET /api/projects/:id/documents?stage=` — the UI currently filters client-side.
2. **Run listing for every stage**: `GET /api/projects/:id/stages/:stage/runs` works per stage; a project-wide `GET /api/projects/:id/runs?limit=&before=` would let the Logs run filter list all stages at once (today it lists the selected stage, default Planning).
3. **Multi-level log filter**: `GET /api/projects/:id/logs?level=` takes one level; accepting a list (`level=warn,error`) or a minimum level (`minLevel=warn`) would allow multi-select in the viewer.
4. **Log live tail**: the viewer polls every 3 s. `GET /api/projects/:id/logs/stream?after=` (SSE, like `/events/stream`) would remove polling.
5. **Error counts for the Logs link**: `GET /api/projects/:id/logs/summary?hours=24` → `{ error, warn }` for the badge next to the link.
6. **Phoenix**: `/observability` is used as documented. `503 PHOENIX_DISABLED` vs `200 available:false` is handled; please keep both stable.

## 6. Suggested order

1. Status bar exactness (context %, tokens/sec, per-run usage) — small, removes two estimates.
2. Documents filters/paging — unlocks the Documents link with no new concepts.
3. Repository (project fields + read-only git info).
4. Directories (read-only file tree).
5. Project settings (description, per-project model).
6. Images.
7. Rewind with invalidation + runtimes for the remaining stages.
