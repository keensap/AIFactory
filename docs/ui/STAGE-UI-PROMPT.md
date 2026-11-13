# UI Implementation Prompt — Stage Workspace

**For:** the UI implementation agent  
**Scope:** project stage workspace, starting with Planning & Feasibility  
**Backend:** AI Factory HTTP API at `http://127.0.0.1:8787`  
**API contract:** `/openapi.yaml`, live console at `/docs`

---

## Your task

Build a **stage-centric project workspace** for the AI Factory UI.

Do not build another generic chat page. The primary object is a **stage run**: its context, progress, review findings, TELOS document and human decision.

The first complete flow must be **Planning & Feasibility**. The other seven stages must appear in the navigation and read-only status views, but only Planning is executable today.

By the end, a user must be able to:

1. open a project and see all SDLC stages;
2. open Planning & Feasibility;
3. enter a high-level business brief;
4. start a planning stage run;
5. watch it move through analysis, drafting and review;
6. inspect reviewer findings and revisions;
7. read and download the generated TELOS feasibility report;
8. record a go / conditional-go / no-go decision;
9. advance the project to Requirements when the gate is satisfied.

---

## Product model

```text
Project
  └── Stage (planning, requirements, design, …)
        └── Stage run (attempt 1, 2, …)
              ├── context packet (hash)
              ├── analyzer
              ├── TELOS author
              ├── reviewer
              ├── reviews / findings
              ├── TELOS document
              └── human decision
```

A stage can have multiple runs. A completed or failed run is terminal; a retry creates a **new run**, not a new execution of the old one.

The stage UI must always make the current project, current stage and current run obvious.

---

## Navigation and routes

Recommended routes:

```text
/projects/:projectId
/projects/:projectId/stages/:stage
/projects/:projectId/stages/:stage/runs/:runId
```

Stage key must use the API key, even when the display name differs:

```text
planning      → Planning & Feasibility
requirements  → Requirements
design        → Design
architecture  → Architecture
development   → Development
testing       → Testing
deployment    → Deployment
maintenance   → Maintenance
```

Load display names from `GET /api/sdlc/stages`. Fall back to a local map only if the request fails.

---

## Page layout

Use a three-region workspace on desktop:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Project header: name · root path · status · active-stage badge              │
├──────────────────┬───────────────────────────────────────┬───────────────────┤
│ Stage rail       │ Stage workspace                       │ Context panel     │
│                  │                                       │                   │
│ 01 Planning  ●   │ Stage header + progress               │ Checklist         │
│ 02 Requirements  │ Brief form / current run              │ Documents         │
│ 03 Design        │ Agent pipeline                        │ Project context   │
│ 04 Architecture  │ Review findings                       │ Latest run        │
│ 05 Development   │ TELOS preview                         │                   │
│ 06 Testing       │ Decision panel                        │                   │
│ 07 Deployment    │                                       │                   │
│ 08 Maintenance   │                                       │                   │
└──────────────────┴───────────────────────────────────────┴───────────────────┘
```

On mobile, collapse the rail into a horizontal stage stepper and the context panel into disclosures below the main content.

### Stage rail

Each stage row must show:

- position number;
- display name;
- status chip: `not_started`, `in_progress`, `completed`, `blocked`, `skipped`;
- a small progress indicator when the stage has checklist items;
- the current stage highlighted.

Clicking a stage:

- opens that stage workspace;
- for non-planning stages, show a clear read-only “Runtime not implemented yet” state;
- do not pretend non-planning stages can execute.

### Project header

Show:

- project name;
- root path in a monospace, copyable field;
- project status;
- current stage badge;
- overall progress: completed stages / 8, completed required items / total.

Use `GET /api/projects/:id` for this data.

---

## Planning & Feasibility workspace

Planning has **one** output document: a TELOS feasibility report. Do not label it SRS, functional specification or requirements document.

### 1. Stage header

Show:

- “Planning & Feasibility”;
- stage status;
- short explanation: “Validate the business idea and assess Technical, Economic, Legal, Operational and Schedule feasibility.”
- progress: required checklist items completed;
- current run status, if any.

### 2. Business brief

A textarea labelled **“Business idea and stakeholder goals”** with helper text:

> Describe the problem, target users, business idea, stakeholder goals, success measures and known constraints. The analyzer will turn this into a TELOS feasibility report.

Requirements:

- multiline, autosizing, max ~20,000 characters;
- preserve text on navigation;
- disable while a run is executing;
- empty brief is allowed by the API, but show a warning that the report will be based only on project metadata;
- do not create a separate “SRS” field.

Primary button: **Start planning run**.

On click:

```http
POST /api/projects/:projectId/stages/planning/runs
Content-Type: application/json
Authorization: Bearer <token>

{"brief":"..."}
```

Response `201`:

```json
{
  "run": {
    "id": "...",
    "projectId": "...",
    "stage": "planning",
    "attempt": 1,
    "sessionId": null,
    "status": "pending",
    "contextHash": "64-char-sha256",
    "context": {},
    "inputText": "...",
    "summaryMarkdown": null,
    "startedAt": null,
    "completedAt": null,
    "createdAt": "...",
    "updatedAt": "...",
    "reviews": [],
    "documents": []
  }
}
```

Navigate to the run route and immediately start execution.

### 3. Execute and poll

```http
POST /api/stage-runs/:runId/execute
```

The API returns `202 Accepted` with the current run. Execution continues in the background.

Poll:

```http
GET /api/stage-runs/:runId
```

Recommended polling:

- every 1.5 seconds while status is `pending`, `analyzing`, `drafting`, `reviewing` or `revising`;
- back off to 3 seconds after 30 seconds;
- stop on `awaiting_human`, `completed`, `failed` or `cancelled`;
- do not overlap requests;
- pause while the document is hidden, resume on visibility;
- stop after 30 minutes and show a “taking longer than expected” state.

Do **not** use `?wait=1` from the browser; the request can take minutes.

### 4. Agent pipeline

Show a simple three-step pipeline derived only from the run status:

```text
Analyzer  →  TELOS author  →  Reviewer
```

Highlight the active step:

| Run status | Active step |
|---|---|
| `pending` | none |
| `analyzing` | Analyzer |
| `drafting` | Author |
| `reviewing` | Reviewer |
| `revising` | Author |
| `awaiting_human` | Reviewer complete |
| `completed` | all complete |
| `failed` | last known step, with error |

Do not invent per-role token counts, model names or live tool activity. The API does not expose them yet. Show a compact “Pipeline” card, not a fake terminal.

### 5. Activity stream

The run now exposes a persisted event log.

```text
GET /api/stage-runs/:runId/events?after=<id>&limit=200
GET /api/stage-runs/:runId/events/stream?after=<id>
```

Event shape:

```json
{
  "id": "42",
  "projectId": "...",
  "stageRunId": "...",
  "role": "reviewer",
  "agentId": "reviewer",
  "type": "tool_call",
  "phase": null,
  "payload": {
    "type": "tool_call",
    "tool": "bash",
    "input": { "command": "rg -n refund docs" }
  },
  "createdAt": "..."
}
```

Render an **Activity** drawer under the run, not a separate page:

- compact “current activity” line above the drawer;
- role lanes or role grouping;
- event types: `role_start`, `role_end`, `role_error`, `thinking`, `text`, `tool_call`, `tool_result`, `status`, `final`, `review_decision`, `document_created`, `human_decision`, `run_recovered`;
- thinking collapsed by default;
- tool command in monospace with copy;
- tool result collapsed and truncated;
- filters: role, type, errors;
- “Follow live” auto-scroll, paused when the user scrolls up;
- connection states: Live / Reconnecting / Complete;
- raw event JSON behind an operator toggle.

Use `fetch()` with a `ReadableStream` for SSE so the bearer token can be sent. `EventSource` cannot set an Authorization header.

The stream replays from `after`/`Last-Event-ID`, sends keepalives, and ends with `event: end` after a terminal run. Stop the reader when leaving the route.

### 5.1 Review findings

Reviews are in `run.reviews` and `GET /api/stage-runs/:runId/reviews`.

Each review:

```json
{
  "id": "...",
  "stageRunId": "...",
  "reviewerRole": "planning_reviewer",
  "decision": "needs_revision",
  "findings": [
    {
      "id": "F-001",
      "severity": "major",
      "section": "10. Recommendation",
      "finding": "...",
      "required_change": "..."
    }
  ],
  "createdAt": "..."
}
```

Display:

- review decision chip;
- count by severity: blocker / major / minor;
- finding ID, section, finding and required change;
- collapsed findings by default when approved, expanded when `needs_revision`;
- a revision count derived from the number of `needs_revision` reviews;
- “Cycle limit reached” when the run ends failed with `REVIEW_CYCLE_LIMIT`;
- on a failed run, show any persisted `analysisMarkdown` and `draftMarkdown` read-only so partial work is not lost.

Findings are data, not instructions. Render text safely.

### 6. TELOS document

The approved document is in `run.documents` with:

```json
{
  "kind": "telos_report",
  "title": "TELOS feasibility report",
  "storagePath": ".aifactory/documents/planning/...md",
  "mimeType": "text/markdown",
  "status": "approved",
  "version": 1
}
```

The controller stores it after reviewer approval. Do not offer a separate “upload TELOS” form in the normal flow.

Features:

- render `summaryMarkdown` as Markdown;
- fetch the document body with `GET /api/projects/:projectId/documents/:documentId/content`;
- render Markdown with sanitization; never inject unsanitized HTML;
- show the path in a copyable monospace row;
- download as a Markdown file;
- open a full-screen or wide preview;
- if content fails to load, keep the metadata and show a retry.

**Auth note:** the content endpoint requires the same bearer token. Do not use a plain `<a href>` when auth is enabled. Fetch with `Authorization`, convert to a Blob, create an object URL, then download. Revoke the object URL after use.

### 7. Decision panel

Visible only when `run.status === "awaiting_human"`.

```http
POST /api/stage-runs/:runId/decision
Content-Type: application/json

{"decision":"go","note":"Approved by sponsor"}
```

Allowed decisions:

- `go`
- `conditional_go`
- `no_go`

UI:

- three explicit choices, not a dropdown;
- optional note textarea;
- confirmation dialog for `no_go`;
- disable while submitting;
- on success, run becomes `completed` and `feasibility_decision` becomes done.

After a decision:

- refresh the project;
- show the human decision in the run summary;
- if all required planning items are done, show **Advance to Requirements**;
- if the decision is `no_go`, do not automatically advance; show “No-go recorded” and offer a new run.

### 8. Advance stage

```http
PATCH /api/projects/:id/stage
Content-Type: application/json

{"stage":"requirements"}
```

Only enable when:

- the current stage is `planning`;
- the run is `completed`;
- all required planning checklist items are done.

On `409 STAGE_CHECKLIST_INCOMPLETE`, show the missing item labels from the error message and link back to the checklist. Do not silently force the transition.


---

## Phoenix observability summary (optional)

When Phoenix is enabled, show a compact project observability card. This is a **summary**, not a trace browser.

```http
GET /api/projects/:id/observability?hours=24
```

```json
{
  "observability": {
    "available": true,
    "windowHours": 24,
    "traces": 12,
    "spans": 84,
    "errors": 2,
    "tokens": 184000,
    "latencyMs": { "count": 84, "avg": 1200, "p50": 900, "p95": 4200, "max": 7100 },
    "roles": [
      { "role": "reviewer", "spans": 12, "errors": 1, "durationMs": 24000, "tokens": 52000 }
    ],
    "lastSpanAt": "..."
  }
}
```

Card contents:

- traces and spans;
- error count;
- p95 latency;
- total tokens;
- reviewer/author/analyzer role breakdown;
- “Open Phoenix” link for operators.

States:

- `available: false` → “Phoenix unavailable” with the reason; keep the page usable;
- `503 PHOENIX_DISABLED` → hide the card or show “Observability disabled”;
- no traces → “No traces in the last 24 hours”.

Do not render prompts, outputs, thinking or tool arguments. The summary endpoint is metadata-only. Do not expose the Phoenix UI to project users unless per-project authorization is implemented.

## Context panel

Right-hand panel, collapsible on smaller screens.

### Checklist

Render the active planning checklist:

| Key | Label |
|---|---|
| `business_idea` | High-level business idea and problem statement are captured |
| `stakeholder_goals` | Stakeholder goals, success measures and constraints are captured |
| `telos_report` | Single TELOS feasibility report is provided |
| `feasibility_decision` | Go, conditional-go or no-go decision and conditions are recorded |

Show `required`, `status`, and evidence document link.

Status colors:

- `done` — green;
- `open` — neutral/amber;
- `waived` — muted with a “waived” label.

Do not show inactive checklist items; the API already filters them.

### Documents

List `project.documents` for the stage or `run.documents` for the run.

Show:

- kind;
- title;
- status;
- version;
- storage path;
- created date;
- open/download action.

The TELOS document should be visually primary. Other uploads are secondary.

### Project context

Show:

- organization;
- owner email;
- project status;
- context hash (short form, copy full);
- input brief;
- prior stage summaries when available.

Do not dump the full context JSON by default. Put it behind a “View context” disclosure for operators.

---

## Empty, loading and error states

Implement all of these explicitly.

| State | UI |
|---|---|
| No project | Full-page “Project not found” with back link |
| Project has no planning run | Brief form + “No planning runs yet” |
| Loading project | Skeleton header, rail and panels |
| Loading run | Skeleton progress and checklist |
| API offline | Banner “API unavailable”; preserve form text; retry |
| `401` | “Session expired or token missing”; do not loop |
| `403`/`404` | “Project or run not found” |
| `409 STAGE_RUN_RUNNING` | “This run is already executing”; keep polling |
| `409 STAGE_RUN_LEASED` | “Run is owned by another worker”; keep polling |
| `409 STAGE_RUN_LEASE_LOST` | “Worker lease was lost”; show interrupted state and offer a new attempt |
| `409 STAGE_RUN_TERMINAL` | Offer “Start a new attempt” |
| `409 REVIEW_CYCLE_LIMIT` | Show failed summary, findings and retry action |
| `409 PROJECT_ROOT_UNAVAILABLE` | “Project directory is unavailable”; do not retry automatically |
| `409 PROJECT_ROOT_NOT_WRITABLE` | “Project directory is read-only”; ask an operator to fix permissions |
| `409 DOCUMENT_WRITE_FAILED` | “The TELOS document could not be saved”; show the path and retry after fixing storage |
| `501 STAGE_RUNTIME_NOT_IMPLEMENTED` | Read-only stage notice |
| `502` harness error | “The model run failed”; show safe error, retry as new run |
| `502 STAGE_ROLE_FAILED` | Show the failed role and safe message; keep partial analysis/draft visible |
| `503` disabled | “Stage runtime is disabled on this server” |

Error envelope:

```json
{
  "error": {
    "message": "...",
    "code": "STAGE_CHECKLIST_INCOMPLETE",
    "status": 409
  }
}
```

Never display raw stack traces, prompts or API tokens.

---

## Async and state rules

- One active execution per run. The API rejects concurrent execution with `409 STAGE_RUN_RUNNING`.
- Do not optimistically set `awaiting_human`; only render what the API returns.
- Do not mark checklist items done locally; refresh project/run after mutations.
- Do not auto-advance the stage after approval. The user must confirm.
- A failed run cannot be re-executed. “Retry” means `POST /runs` with a new attempt.
- Preserve the brief when creating a retry, but let the user edit it.
- Refresh `GET /api/projects/:id` after decision, checklist changes or stage advance.
- Polling must be cancelled when leaving the route or unmounting.

---

## Stage chat (not available yet)

The backend does **not** yet expose stage-scoped chat. Do not wire the existing project chat into the stage workspace: it lacks the stage context packet and can produce misleading answers.

Reserve a **Chat** tab or panel with:

> Stage chat is coming next. For now, use the brief and the run review to discuss this stage.

Do not build a fake chat interaction or send messages to `/api/chat` from the stage UI.

---

## API client requirements

Create a small typed client with one place for:

- base URL;
- bearer token;
- JSON parsing;
- error envelope parsing;
- request cancellation via `AbortSignal`;
- content/blob download.

Do not scatter `fetch` calls across components.

Suggested types:

```ts
type StageStatus = 'not_started' | 'in_progress' | 'completed' | 'blocked' | 'skipped'
type RunStatus = 'pending' | 'analyzing' | 'drafting' | 'reviewing' | 'revising'
  | 'awaiting_human' | 'completed' | 'failed' | 'cancelled'

interface StageRun {
  id: string
  projectId: string
  stage: string
  attempt: number
  sessionId: string | null
  status: RunStatus
  contextHash: string | null
  context: unknown
  inputText: string | null
  analysisMarkdown: string | null
  draftMarkdown: string | null
  summaryMarkdown: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

interface StageRunDetail extends StageRun {
  reviews: StageReview[]
  documents: ProjectDocument[]
}

interface Finding {
  id: string
  severity: 'blocker' | 'major' | 'minor'
  section: string
  finding: string
  required_change: string
}

interface StageReview {
  id: string
  stageRunId: string
  reviewerRole: string
  decision: 'approved' | 'needs_revision' | 'rejected'
  findings: Finding[]
  createdAt: string
}
```

Use the OpenAPI file as the source of truth for the rest.

---

## Visual and interaction guidance

- This is an operational workspace, not a landing page.
- Prefer a calm neutral surface, one accent color, clear status chips and strong typography.
- Use monospace for paths, IDs and context hashes.
- Use relative timestamps with full timestamps on hover.
- Use a sticky stage header on long TELOS pages.
- Use an accessible focus ring and keyboard navigation on the stage rail.
- Use `aria-live="polite"` for run-status changes.
- Do not use color alone to communicate status.
- Respect `prefers-reduced-motion` for progress animations.
- Support narrow screens without horizontal scrolling of the main content.
- Render Markdown with a sanitizer; links open safely.
- Long reviewer findings must collapse/expand, not overflow.

### Suggested status chips

| Status | Label |
|---|---|
| `pending` | Queued |
| `analyzing` | Analyzing |
| `drafting` | Drafting TELOS |
| `reviewing` | Under review |
| `revising` | Revising |
| `awaiting_human` | Awaiting your decision |
| `completed` | Complete |
| `failed` | Failed |
| `cancelled` | Cancelled |

---

## Acceptance criteria

### Core flow

- [ ] Project page loads project, stage rail and current stage.
- [ ] Stage names come from `GET /api/sdlc/stages`; planning displays “Planning & Feasibility”.
- [ ] Planning workspace shows brief, checklist, run history and TELOS area.
- [ ] Starting a run posts the brief and creates `attempt` 1.
- [ ] Execute returns `202`; UI polls and shows analyzer → author → reviewer progress.
- [ ] `needs_revision` reviews show findings and revision count.
- [ ] Approved run reaches `awaiting_human` and shows the decision panel.
- [ ] TELOS document renders and downloads with authentication.
- [ ] Decision records `go`, `conditional_go` or `no_go` and updates the checklist.
- [ ] After a completed run, “Advance to Requirements” works and handles missing checklist items.

### Resilience

- [ ] Refreshing the run route restores state from the API.
- [ ] A failed run shows the safe error and offers a new attempt.
- [ ] `409 STAGE_RUN_RUNNING` does not start a second poller.
- [ ] `409 STAGE_CHECKLIST_INCOMPLETE` shows missing labels.
- [ ] Leaving the page stops polling.
- [ ] Missing TELOS content does not break the metadata view.
- [ ] Unauthorized and offline states are explicit and recoverable.

### Quality

- [ ] Keyboard-only user can reach the stage rail, brief, start, decision and advance actions.
- [ ] Status changes are announced.
- [ ] Markdown is sanitized.
- [ ] No token appears in URLs, logs or rendered UI.
- [ ] Non-planning stages show a clear read-only “runtime not implemented” state.
- [ ] No fake stage chat, no fake model metrics, no invented checklist data.

---

## Non-goals for this iteration

Do not build:

- role/model configuration UI;
- subagent console;
- stage chat;
- live model token streaming;
- project isolation or security controls;
- multi-run comparison beyond attempt history;
- editing the TELOS document in the browser.

These are separate follow-up work items.

---

## Handoff notes

- API base: `http://127.0.0.1:8787`
- Live docs: `http://127.0.0.1:8787/docs`
- OpenAPI: `http://127.0.0.1:8787/openapi.yaml`
- Use the bearer token configured for the API; do not hardcode it.
- Current executable stage: `planning`.
- Current document kind: `telos_report`.
- Current human decisions: `go`, `conditional_go`, `no_go`.
- Current run execution is asynchronous; poll `GET /api/stage-runs/:runId`.

Build the Planning & Feasibility workspace first, completely, then reuse the stage shell for the remaining stages.
