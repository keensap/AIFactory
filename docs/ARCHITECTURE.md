# AI Factory — Architecture

**Status:** current state, 2026-11-18; corrected after the code review; Phases 1–3 applied (hotfixes, foundations, run integrity)  
**Scope:** the backend as implemented (`apps/chat-cli`). The UI is a separate workstream; its contracts are described in [`docs/ui/`](ui/).  
**Related:** [`AI-Factory-Requirements.md`](AI-Factory-Requirements.md) (what to build), [`design/`](design/) (per-area decisions), [`design/ARCHITECTURE-REMEDIATION.md`](design/ARCHITECTURE-REMEDIATION.md) (known defects and the plan to fix them).

This document describes what exists **today**, not the target. Where something is designed but not implemented, it says so. Where the code does not yet do what a diagram implies, a **Known defect** note follows the diagram and links to the remediation register.

---

## 1. Diagram index

| # | Diagram | Answers |
|---|---|---|
| 2 | System context | Who talks to what |
| 3 | Runtime topology | Which processes and ports exist |
| 4 | API layering | Where HTTP stops and services begin |
| 5 | Stage run lifecycle | Every run status and its transitions |
| 6 | Planning run sequence | One run end to end |
| 7 | Acceptance decision | When the loop stops revising |
| 8 | Human gates | Which question is asked, and where |
| 9 | Model layer | How a target becomes a harness patch |
| 10 | Per-role composition | How an agent changes one role's process |
| 11 | Settings resolution | Which value wins |
| 12 | Prerequisites | When a stage may start |
| 13 | Agents | Which agent runs a process |
| 14 | Documents and PDF | How the artifact is produced |
| 15 | Observability | Where events, traces and logs go |
| 16 | Data model | Tables and relationships |
| 16a | Schema and pools | Migrations, and how many connections this process holds |
| 17 | Trust boundaries | What is trusted, sandboxed or secret |

---

## 2. System context

```mermaid
flowchart LR
  operator["Operator<br/>(browser)"] -->|"REST + SSE"| api["AI Factory API<br/>apps/chat-cli"]
  cli["CLI / scripts"] -->|"REST"| api
  api -->|"SQL"| pg[("PostgreSQL<br/>+ pgvector")]
  api -->|"spawn, JSON events"| harness["dsh harness<br/>one process per role"]
  harness -->|"HTTPS"| providers["Model providers<br/>(OpenAI-compatible, Anthropic)"]
  api -->|"OTLP"| phoenix["Phoenix<br/>traces + logs"]
  api -->|"embeddings"| llama["llama.cpp<br/>embeddings"]
  api -->|"read/write"| tree[["Project tree<br/>documents/, .aifactory/"]]
  harness -->|"read/write"| tree
  pg -->|"same database"| api
```

The API owns orchestration and state. The harness owns the model loop and tools. The project directory is the unit of isolation: each project has a root path, and its generated PDFs live under `documents/` inside it.

---

## 3. Runtime topology

```mermaid
flowchart TB
  subgraph host["Host"]
    api["api process<br/>node src/api.ts --port 8787"]
    pg[("postgres-vector<br/>5432")]
    phoenix["Phoenix<br/>6006 UI, 4317 OTLP"]
    embed["llama.cpp server<br/>8081"]
    subgraph roles["Harness children (per role, per step)"]
      a1["dsh (analyzer)"]
      a2["dsh (author)"]
      a3["dsh (reviewer)"]
    end
    tree[["project root"]]
  end
  api --> pg
  api --> phoenix
  api --> embed
  api --> roles
  roles --> tree
  api --> tree
```

Each role is a **separate harness process** launched with `--profile headless --json --patch <model patch> [--patch <agent patch>]`. That is what makes per-role models, personas and tools possible; it is also why nothing may assume in-process agent state.

---

## 4. API layering

```mermaid
flowchart TB
  http["http.ts<br/>responses, bodies, CORS, tokens, errors"]
  table["routes/index.ts<br/>ordered route table"]
  matcher["routes/router.ts<br/>match + assertAuthorised"]
  subgraph routes["routes/* — one module per resource"]
    sys["system"]
    agents["agents"]
    settings["settings"]
    models["models"]
    logging["logging"]
    runs["stage-runs"]
    projects["projects"]
    sessions["sessions"]
  end
  subgraph services["Services"]
    projectsvc["ProjectsService"]
    stages["StageRuntime (planning)"]
    settingssvc["StageSettingsService"]
    prereq["StagePrerequisiteService"]
    agentsvc["AgentService"]
    modelssvc["ModelService + ModelRuntime"]
    logman["LoggingManager"]
  end
  subgraph stores["Stores"]
    ws["ProjectWorkspace (PostgreSQL)"]
    files["Project filesystem"]
  end
  request(("request")) --> table --> matcher --> routes
  routes --> services
  stages --> ws
  stages --> files
  settingssvc --> ws
  prereq --> ws
  agentsvc --> ws
  modelssvc --> db[("PostgreSQL")]
  http --> routes
```

`server.ts` holds only the server lifecycle, request logging and the router wiring: registering a route is the same act as declaring who may call it.

| Concern | Where |
|---|---|
| routes, and their `public` / `operator` / `admin` policy | `src/routes/*.ts`, aggregated in `src/routes/index.ts` |
| matching and authorisation | `src/routes/router.ts` |
| responses, JSON bodies, CORS, token checks, error mapping | `src/http.ts` |
| the option type every module needs | `src/api-options.ts` |

Two guards keep the table honest: an **auth inventory** asserts every route declares a role and that a named set of write operations is `admin`; **OpenAPI parity** asserts the served routes and `openapi.yaml` are the same set.

Errors are typed at the boundary (`HttpError` with `status` + `code`) and rendered as `{ error: { message, code, status } }`. Domain errors (`StageRuntimeError`, `StageSettingsError`, `PrerequisiteError`, `AgentError`, `ModelSettingsError`) map to those codes in `toHttpError` rather than leaking messages.

---

## 5. Stage run lifecycle

```mermaid
stateDiagram-v2
  [*] --> pending
  pending --> analyzing: execute claims the run
  analyzing --> drafting: analysis stored
  drafting --> reviewing: draft stored
  reviewing --> revising: not accepted, budget left
  revising --> reviewing: revised draft
  reviewing --> reviewGate: gating on, not accepted
  reviewing --> finalGate: accepted or budget spent
  state "awaiting_human: review_changes" as reviewGate
  state "awaiting_human: final" as finalGate
  reviewGate --> reviewing: apply
  reviewGate --> finalGate: accept as-is
  finalGate --> reviewing: refine
  finalGate --> completed: go / conditional_go / no_go
  reviewing --> failed: role error, invalid review
  drafting --> failed: role error
  analyzing --> failed: role error
  pending --> cancelled: POST /cancel
  reviewing --> cancelled: POST /cancel (aborted at the heartbeat)
  completed --> [*]
  failed --> [*]
  cancelled --> [*]
```

A paused run **releases its lease** and persists `pending_gate` + `review_cycles`, so it can wait for days and be resumed by any API instance. `claimStageRun` admits `awaiting_human` for that reason.

The status column also carries `execution_attempts` and `locked_by`/`lease_expires_at`: a 120 s lease with a 30 s heartbeat prevents two executors racing the same run.

> **Status** ([remediation register](design/ARCHITECTURE-REMEDIATION.md)):
> - A failed resume **restores the gate** instead of failing the run, and a failed run can be retried explicitly ([AR-04](design/ARCHITECTURE-REMEDIATION.md#ar-04), fixed).
> - A run is **cancelled** by `POST /stage-runs/:id/cancel`: at once if unleased, otherwise at its owner's next heartbeat, which aborts the running harness ([AR-11](design/ARCHITECTURE-REMEDIATION.md#ar-11), fixed).
> - Each run **freezes** its model target and agents at start (`bindings`), so a resume uses what it started with; `POST /stage-runs/:id/rebind` adopts the current ones explicitly ([AR-06](design/ARCHITECTURE-REMEDIATION.md#ar-06), fixed).

---

## 6. Planning run sequence

```mermaid
sequenceDiagram
  autonumber
  participant O as Operator
  participant API as API
  participant R as PlanningStageRuntime
  participant DB as PostgreSQL
  participant H as dsh (role)
  participant P as Model provider

  O->>API: POST /projects
  API->>DB: insert project
  O->>API: POST /projects/:id/stages/planning/runs
  API->>R: start(brief, attachments)
  R->>DB: readiness + start run (status pending)
  O->>API: POST /stage-runs/:id/execute
  R->>DB: claim lease, pin model target
  R->>H: analyzer prompt
  H->>P: chat completion
  P-->>H: analysis
  H-->>R: analysis text
  R->>DB: analysis_markdown, drafting
  R->>H: author prompt
  H->>P: chat completion
  P-->>H: draft
  H-->>R: draft markdown
  R->>H: reviewer prompt (acceptance criteria)
  H->>P: chat completion
  P-->>H: decision, rating, findings
  H-->>R: review JSON
  R->>DB: review, review_cycles, pending_gate
  R-->>O: awaiting_human
  O->>API: POST /stage-runs/:id/decision {go}
  API->>R: decide
  R->>DB: document, checklist, export record
  R->>R: render PDF into documents/planning/
  R-->>O: completed
```

---

## 7. Acceptance decision

The reviewer returns `decision`, `rating` (0–100) and findings. The runtime decides whether the document is good enough to stop revising:

```mermaid
flowchart TD
  review["Review result"] --> counts["count findings by severity<br/>blocker/critical, major, minor"]
  counts --> limits{"blockers <= maxBlockers<br/>AND major <= maxMajor"}
  limits -- "no" --> revise["revise and review again<br/>(or pause at review gate)"]
  limits -- "yes" --> rated{"reviewer supplied<br/>a rating?"}
  rated -- "no" --> decision{"decision == approved?"}
  decision -- "no" --> revise
  decision -- "yes" --> accepted["accepted"]
  rated -- "yes" --> threshold{"rating >= minRating?"}
  threshold -- "no" --> revise
  threshold -- "yes" --> accepted
  revise --> budget{"review_cycles < maxReviewCycles?"}
  budget -- "yes" --> review
  budget -- "no" --> finalGate["pause at final gate<br/>ask the human anyway"]
  accepted --> finalGate
  finalGate --> human["human approves, refines or rejects"]
```

Defaults (`minRating 0`, `maxBlockers 0`, `maxMajor 0`) reproduce the behaviour before this feature: the reviewer's own `approved` decides, and any blocker or major keeps revising.

---

## 8. Human gates

```mermaid
flowchart LR
  review["review finished"] --> accepted{"accepted?"}
  accepted -- "yes" --> final["final gate<br/>kind = final"]
  accepted -- "no" --> gating{"gateAfterEachReview?"}
  gating -- "yes" --> rg["review gate<br/>kind = review_changes"]
  gating -- "no" --> more{"cycles left?"}
  more -- "yes" --> revise["revise, review again"]
  more -- "no" --> final
  rg -->|"POST /gate {apply}"| revise
  rg -->|"POST /gate {accept}"| final
  final -->|"POST /decision {refine:true}"| review
  final -->|"POST /decision {go|conditional_go|no_go}"| done["completed<br/>document + PDF"]
```

An artifact is produced **only** on approval. While paused, `run.documents` is empty and no PDF exists; the draft is in `draftMarkdown`.

---

## 9. Model layer

```mermaid
flowchart LR
  target["settings.model_target<br/>provider + model + fallback"] --> resolve["ModelService.resolveForRun"]
  providers[("model_providers")] --> resolve
  catalog[("model_catalog")] --> resolve
  resolve --> patch["buildModelPatch"]
  patch --> routes["llm-pi-ai<br/>routes per provider"]
  patch --> dm["agent-default-model<br/>provider + model"]
  routes --> file[["model-target-*.json"]]
  dm --> file
  file --> dsh["dsh --patch"]
  resolve --> fallback["fallback chain<br/>on retryable failure"]
  resolve --> breaker["circuit breaker<br/>per provider/model"]
  dsh --> attrib["attribution: model, cost, window<br/>stamped per role"]
```

Credentials never enter the database or the patch file: a route references `apiKeyEnv`, and the child process receives only the variables it needs. A failed refresh keeps the last good patch, so a bad model setting cannot stop runs.

> **Failover on runs** ([AR-03](design/ARCHITECTURE-REMEDIATION.md#ar-03), fixed): a role that fails retryably moves to the next candidate in the run's fallback chain, one attempt each, using the **same** circuit breaker as direct calls. `aborted` and `content_filter` never fall back, because another model would make the same decision. Every attempt is attributed to the model that actually ran, and `role_fallback` / `role_fallback_skipped` record what happened.

---

## 10. Per-role composition

An agent does not use a harness preset. The model patch and the agent patch are both applied to the role's process, in that order:

```mermaid
flowchart LR
  model["model patch<br/>routes + factory model"] --> proc["dsh process<br/>(one role)"]
  agent["agent patch"] --> proc
  agent --> persona["system-prompt.personaPrefix"]
  agent --> skills["skill-filesystem<br/>customSkillDirs"]
  agent --> tools["disabled: tool-* rows<br/>outside the allowlist"]
  agent --> amodel["agent-default-model<br/>model on the factory route"]
  persona --> proc
  skills --> proc
  tools --> proc
  amodel --> proc
  proc --> reply["role output"]
```

The agent's model is declared **on the factory route**, so an agent can change model but never provider. Applying the agent patch last means its `agent-default-model` wins.

> **Status** ([remediation register](design/ARCHITECTURE-REMEDIATION.md)):
> - Each role's usage is priced and measured as the model it ran, from the pin-time catalogue snapshot; an unknown model is reported as unpriced rather than billed at another's price ([AR-02](design/ARCHITECTURE-REMEDIATION.md#ar-02), fixed).
> - The allowlist **fails closed**: every `tool-*` row is classified, an unclassified row refuses a restricted agent, and `scripts/check-tool-rows.mjs` fails on drift ([AR-05](design/ARCHITECTURE-REMEDIATION.md#ar-05), fixed).

---

## 11. Settings resolution

```mermaid
flowchart LR
  defs["definition defaults<br/>(code, per stage)"] --> merge["merge"]
  factory[("settings.stage_defaults<br/>JSONB keyed by stage")] --> merge
  project[("project_stage_settings<br/>project_id, stage, settings JSONB")] --> merge
  merge --> effective["effective settings<br/>source: project / factory / defaults"]
  effective --> snapshot["snapshot into run context<br/>context.constraints"]
  snapshot --> run["run uses its snapshot"]
```

Settings are snapshotted at start, so changing them mid-run affects later runs only. Stages without a runtime have no definition: their settings are `{}` and writes return `501`.

---

## 12. Prerequisites

```mermaid
flowchart TD
  cat[("stage_prerequisites<br/>catalogue per stage")] --> check["readiness(stage)"]
  brief["incoming brief"] --> check
  att[("project_attachments")] --> check
  docs[("project_documents<br/>by kind")] --> check
  waiver[("project_stage_evidence<br/>waiver + reason")] --> check
  check --> ready{"all required met?"}
  ready -- "yes" --> start["create run"]
  ready -- "no" --> refuse["409 STAGE_PREREQUISITES_MISSING<br/>list what is missing"]
  refuse --> waive["admin waives with a reason"]
  waive --> check
```

Readiness is **evidence**, not sequencing: a project can start at any stage when the artifacts exist. Only planning enforces it today; the catalogue covers all eight stages.

---

## 13. Agents

```mermaid
flowchart LR
  defs[("agent_definitions<br/>persona, model, tools, skills")] --> compose
  assign[("agent_assignments<br/>scope_key = factory or project")] --> pick{"project override<br/>else factory<br/>else none"}
  pick --> compose["composition"]
  compose --> materialise["materialise<br/>SKILL.md bundles + patch"]
  materialise --> proc["role process"]
  compose --> events["role_start records<br/>agent, agentId, model"]
```

Deleting an agent cascades its assignments. A disabled agent is skipped rather than failing a run.

---

## 14. Documents and PDF

```mermaid
flowchart LR
  draft["draftMarkdown"] --> doc["document record<br/>kind = telos_report"]
  doc --> md["markdown parser<br/>(subset)"]
  md --> pdf["pdf-lib renderer<br/>A4, header, page x of y"]
  pdf --> file[["documents/<stage>/<Title> — <Project>.pdf"]]
  pdf --> exp[("stage_document_exports<br/>path, bytes, generated_at")]
  exp --> dl["GET /projects/:id/documents/:docId/export"]
  pdf -.->|"failure is logged, never fatal"| run["run continues"]
```

Rendering runs after approval, in the completion path. A render or write failure leaves the run completed with a logged `document_export_failed`, because a broken PDF must not lose the approval.

---

## 15. Observability

```mermaid
flowchart LR
  harness["dsh events<br/>session, status, text, tool_call, ..."] --> sink["StageEventSink"]
  sink --> events[("stage_run_events<br/>role, type, phase, payload")]
  sink --> traces["TraceRecorder"]
  traces --> phoenix["Phoenix<br/>OTLP 4317"]
  api["API logs"] --> logs[("app_logs")]
  logs --> file["JSONL sink"]
  logs --> otlp["OTLP logs sink"]
  events --> status["status bar / SSE"]
```

Usage follows the convention `inputTokens` excludes cached tokens, and `totalTokens = input + output + cacheRead + cacheWrite`. Content capture is off by default (`AIFACTORY_PHOENIX_CAPTURE_CONTENT=0`).

---

## 16. Data model

```mermaid
erDiagram
  projects ||--o{ project_stages : has
  projects ||--o{ project_stage_runs : runs
  projects ||--o{ project_documents : owns
  projects ||--o{ project_attachments : uploads
  projects ||--o{ project_stage_settings : overrides
  projects ||--o{ project_stage_evidence : waives
  project_stage_runs ||--o{ stage_run_events : emits
  project_stage_runs ||--o{ stage_reviews : reviews
  project_stage_runs ||--o{ stage_run_attachments : consumes
  project_documents ||--o{ stage_document_exports : exports
  project_documents ||--o{ project_checklist_items : evidences
  project_documents ||--o{ project_chunks : indexed_as
  model_providers ||--o{ model_catalog : offers
  agent_definitions ||--o{ agent_assignments : assigned

  projects {
    uuid id PK
    text name
    text root_path
    text status
  }
  project_stage_runs {
    uuid id PK
    uuid project_id FK
    text stage
    text status
    jsonb pending_gate
    int review_cycles
    text draft_markdown
  }
  project_documents {
    uuid id PK
    uuid project_id FK
    text stage
    text kind
    text status
    int version
  }
  agent_definitions {
    uuid id PK
    text name
    text persona
    text model
    jsonb tools
    jsonb skills
  }
  agent_assignments {
    text scope_key PK
    text stage PK
    text process PK
    uuid agent_id FK
  }
  stage_prerequisites {
    text stage PK
    text key PK
    jsonb accepts
    bool required
  }
  model_providers {
    text id PK
    text kind
    text base_url
    text api_key_env
  }
  model_catalog {
    text provider PK
    text model PK
    int context_window
  }
```

Reserved but unused today: `stage_role_configs`, `project_role_overrides`. They predate the agent tables; new work should use `agent_definitions`/`agent_assignments`.

---

## 16a. Schema and connection pools

```mermaid
flowchart LR
  files[["migrations/NNNN_name.sql"]] --> runner["runMigrations"]
  runner --> lock["pg_advisory_lock"]
  lock --> check{"recorded in<br/>schema_migrations?"}
  check -- "yes, same checksum" --> skip["skip"]
  check -- "yes, different checksum" --> fail["fail boot:<br/>applied migration was edited"]
  check -- "no" --> apply["BEGIN, apply, record, COMMIT"]
  apply --> schema[("database schema")]
  schema --> stores["every store"]
  stores --> pool["one shared pool<br/>AIFACTORY_DB_POOL_MAX (10)"]
  pool --> pg[("PostgreSQL")]
  sink["log sink"] --> logpool["separate pool (2)"]
  logpool --> pg
```

Two rules hold this together:

- **A migration that has shipped is never edited.** The checksum recorded in `schema_migrations` fails boot if it changes; a correction is a new migration. A destructive change is two releases (add and backfill, then drop) so the previous release still runs against the new schema.
- **A store never opens or closes a pool.** One application pool is shared by every store, and the PostgreSQL log sink has its own small one so a blocked log write cannot take a connection from a request. `GET /api/health` reports `pools` and `schema`, which is how the AR-12 fix is verified in production.

---

## 17. Trust boundaries

```mermaid
flowchart TB
  subgraph untrusted["Untrusted"]
    browser["Browser / CLI caller"]
    repo["Project files<br/>(user-editable)"]
    provider["Model provider responses"]
  end
  subgraph trusted["Trusted: API process"]
    router["HTTP + auth"]
    svc["Services"]
  end
  subgraph sandboxed["Sandboxed: harness child"]
    dsh["dsh, workspace-write"]
  end
  subgraph secret["Secrets"]
    env["Environment variables<br/>(API keys)"]
  end
  browser -->|"REST"| router
  router --> svc
  svc -->|"spawn with scrubbed env"| dsh
  dsh -->|"reads"| repo
  svc -->|"validated paths"| repo
  env -->|"apiKeyEnv names only"| dsh
  provider -->|"text, treated as data"| dsh
```

Rules enforced in code today:

- **Admin-only:** agent writes, assignment writes, agent probes, waivers and model settings call `requireAdmin`.
- **Credentials** live only in the environment; the database stores variable *names*.
- **Paths:** attachment and export paths are resolved and confined to the project.
- **Harness environment** is scrubbed of unrelated secrets.
- **Model output** is treated as data, never as instructions.

Also enforced since Phase 1:

- **Authorisation is data**: every route declares `public`/`operator`/`admin` and the router enforces it, so a route cannot be added without deciding who may call it. With `AIFACTORY_ADMIN_TOKEN` set the operator token cannot reconfigure the factory (tests: `test/auth.test.ts`, [AR-01](design/ARCHITECTURE-REMEDIATION.md#ar-01)).
- **Bearer tokens are compared in constant time** over SHA-256 digests.
- **Agent tool allowlists fail closed**, and an unclassified harness tool row refuses a restricted agent (tests: `test/agents.test.ts`, `scripts/check-tool-rows.mjs`, [AR-05](design/ARCHITECTURE-REMEDIATION.md#ar-05)).
- **Prerequisites accept only acceptable evidence**: `uploaded`/`in_review`/`approved` documents (newest version), and briefs from runs that did not fail ([AR-07](design/ARCHITECTURE-REMEDIATION.md#ar-07)).

Each rule here cites the test that proves it ([AR-17](design/ARCHITECTURE-REMEDIATION.md#ar-17)).

---

## 18. Known gaps and defects

The architecture review of 2026-11-17 found 17 shortcomings. They are tracked, with remedies and a phased plan, in [ARCHITECTURE-REMEDIATION.md](design/ARCHITECTURE-REMEDIATION.md). The defects are flagged inline above where they affect a diagram.

These gaps are deliberate scope limits rather than defects:

- **Only the planning stage executes.** Other stages have a prerequisite catalogue and empty settings, but no runtime ([AR-15](design/ARCHITECTURE-REMEDIATION.md#ar-15)).
- **Models and agents are configured globally.** Agent assignments can be project-scoped; model targets cannot yet.
- **The agent probe is offline by default**: a stand-in endpoint with no credentials, asserting the request the harness actually made. `?mode=online` uses the real model ([AR-08](design/ARCHITECTURE-REMEDIATION.md#ar-08), fixed).
- **A gate never expires by itself.** It is reported stale after `gateReminderHours` and listed by `GET /api/stage-runs?awaiting=1&staleOnly=1`; approval stays a human decision ([AR-16](design/ARCHITECTURE-REMEDIATION.md#ar-16), fixed).
- **Paused runs never expire.** A gate can wait indefinitely; auto-approval is rejected by design, so the only response is a stale flag ([AR-16](design/ARCHITECTURE-REMEDIATION.md#ar-16), fixed).
- **Reverse engineering an existing codebase** is designed but not built; the waiver and document-kind mechanisms are the hooks it will use.
- **Harness presets are unused.** The headless runner does not bind them; the composition patch is the supported path.

---

## 19. Where to read more

| Area | Document |
|---|---|
| Known defects, remedies, phased plan | [`design/ARCHITECTURE-REMEDIATION.md`](design/ARCHITECTURE-REMEDIATION.md) |
| Stage runtime internals | [`design/STAGE-RUNTIME.md`](design/STAGE-RUNTIME.md) |
| Gates, cycles, acceptance | [`design/STAGE-GATES.md`](design/STAGE-GATES.md) |
| Prerequisites and readiness | [`design/STAGE-PREREQUISITES.md`](design/STAGE-PREREQUISITES.md) |
| Agents and composition | [`design/AGENTS.md`](design/AGENTS.md) |
| Model providers and routing | [`design/MODEL-PROVIDERS.md`](design/MODEL-PROVIDERS.md) |
| PDF input/output | [`design/DOCUMENTS-AND-PDF.md`](design/DOCUMENTS-AND-PDF.md) |
| Logging and telemetry | [`design/LOGGING-ARCHITECTURE.md`](design/LOGGING-ARCHITECTURE.md), [`design/PHOENIX-OBSERVABILITY.md`](design/PHOENIX-OBSERVABILITY.md) |
| HTTP API | [`../apps/chat-cli/API.md`](../apps/chat-cli/API.md) |
