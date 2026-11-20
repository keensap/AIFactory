# Operating the requirements stage

**Status:** R1–R9 and versioned role prompts
**Audience:** operators running the AI Factory API and the web workspace
**Related:** [contract](../design/REQUIREMENTS-CONTRACT.md) · [stage runtime](../design/STAGE-RUNTIME.md) · [stage gates](../design/STAGE-GATES.md) · [API reference](../../apps/chat-cli/API.md)

The requirements stage turns a planning baseline, a brief or uploaded documents into a requirements specification. It runs on the same engine as planning: analyzer → author → reviewer, automatic revision, then **one** human decision at the final gate. Nothing is published before a human approves.

---

## 1. Configuration

### 1.1 Server

| Setting | Where | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | `.env` | — | Required. Stage runs, documents and events live in PostgreSQL. |
| Generation model | `PATCH /api/settings/models`, or the harness profile default | profile default | `GET /api/settings/models` shows `source: unconfigured` when the profile default is used. Embeddings are **not** needed for this stage. |
| `AIFACTORY_STAGE_ROLE_TIMEOUT_MS` | environment | `900000` (15 min) | One role turn. A live run needed up to ~5 min for one reviewer pass over a 70,000-character specification; the former 5-minute default failed realistic runs. Raise it for large specifications or slow models; lowering it below ~10 min is not recommended. |
| `AIFACTORY_DSH_BIN`, `AIFACTORY_TIMEOUT_MS` | `.env` | — | The harness binary and the chat (not stage) timeout. |
| Harness profile | `~/.dsh/profiles/headless` | — | The API process must be able to **write** it; a read-only home fails every role with `harness exited with code 1` (`EROFS … cordis.yml`). |

`GET /api/sdlc/stages` reports `executable: true` for `requirements` when this API instance has its engine; the web UI uses that flag.

### 1.2 Review loop and gate (per stage, Factory default or project override)

| Field | Default | Meaning |
|---|---|---|
| `maxReviewCycles` | 3 | Automatic revisions after the first review (cycle 0). |
| `minRating` | 0 | Reviewer rating (0–100) needed to stop early. |
| `maxBlockers` / `maxMajor` | 0 / 0 | Reviewer findings tolerated to stop early. |
| `gateReminderHours` | 72 | When an unanswered gate is reported stale. |

```bash
GET   /api/settings/stages/requirements                 # Factory default
PATCH /api/settings/stages/requirements                 # admin
GET   /api/projects/<id>/stages/requirements/settings   # effective value and its source
PATCH /api/projects/<id>/stages/requirements/settings   # project override
DELETE /api/projects/<id>/stages/requirements/settings  # back to the Factory default
```

Settings are snapshotted when a run is created. `processParams` can also be overridden when creating a run. For example, set `review.maxFindings` to cap the reviewer response (default 12; excess findings fail rather than being discarded), or `revision.maxGrowthRatio` to change the size advisory (default 1.25). Neither is a human approval criterion. See the [stage settings API](../../apps/chat-cli/API.md#stage-settings) for bounds and precedence.

### 1.3 Prerequisite

A run needs one of: an approved (or imported) `telos_report`, an uploaded document, or a brief on the run. Otherwise creation fails with `409 STAGE_PREREQUISITES_MISSING`. Check with `GET /api/projects/<id>/stages/requirements/readiness`; an admin can waive `planning-baseline` with a reason (`POST …/waivers`).

---

## 2. Running a run

### 2.1 From the web workspace

Open the project → **Requirements** in the stage bar (it must be the project's current stage) → enter a brief and/or attach PDFs → **Start requirements run**. Progress, the activity drawer and reviewer findings update live. At the final gate the panel shows the review outcome, the deterministic coverage report and the draft preview, with **Approve**, **Reject** and **Refine further**.

### 2.2 From the API

```bash
# after planning is approved and the project advanced (PATCH /api/projects/<id>/stage {"stage":"requirements"})
POST /api/projects/<id>/stages/requirements/runs   {"brief":"…","attachmentIds":["…"]}   # 201
POST /api/stage-runs/<runId>/execute                                                   # 202, runs in the background
GET  /api/stage-runs/<runId>                                                           # poll until awaiting_human | failed
POST /api/stage-runs/<runId>/decision {"decision":"approved","note":"…"}               # or rejected / refine
```

Creating the run freezes the planning baseline into `run.context.baselineEvidence` (document id, version, hash, up to 20,000 characters) and records every input in `run.context.sources` — the source register, with `SRC-###` ids the specification cites in its traceability. Later changes to the planning document do not affect the run.

### 2.3 Decisions at the final gate

| Request | Effect |
|---|---|
| `{"decision":"approved"}` | Publishes the `requirements_spec` Markdown and its PDF, marks `requirement_document`, `acceptance_criteria` and `requirements_review` done. **Refused with `409 REQUIREMENTS_COVERAGE_BLOCKED`** while deterministic blockers remain. |
| `{"decision":"approved","coverageWaiverReason":"…"}` | Approves despite blockers. Reason 1–2,000 characters; recorded with the waived findings in the `human_decision` event and the summary. |
| `{"decision":"rejected","note":"…"}` | Records the rejection; the run **stays at the same gate** and nothing is published. It can be refined or approved later. |
| `{"refine":true}` | One more review (and a revision if needed), then back to the gate. May take `reviewCycles` past `maxReviewCycles`. |
| `go` / `conditional_go` / `no_go` | Compatibility aliases: the first two approve, `no_go` rejects. |

Model-reported findings do **not** block approval; only deterministic findings do (see [§5](#5-known-limitations)).

### 2.4 Live smoke test

`npm run smoke:requirements` (in `apps/chat-cli`) runs Planning → Requirements against a running API with a real model and checks the whole lifecycle. See the [README](../../apps/chat-cli/README.md#live-requirements-smoke-test-opt-in). It spends model tokens and takes about 30 minutes.

---

## 3. Inspecting a run

| Question | Where |
|---|---|
| Where is it? | `GET /api/stage-runs/<runId>` → `status` (`pending`, `analyzing`, `drafting`, `reviewing`, `revising`, `awaiting_human`, `completed`, `failed`, `cancelled`), `reviewCycles` |
| Why is the gate unaccepted? | `pendingGate.rating`, `.counts` (reviewer findings), `.criteria`, `.accepted`, and `pendingGate.coverage` — `counts` (requirements with AC / source / goal, MoSCoW `priorities`, `businessRules`) and `findings` (`severity: blocking | advisory`; `CONTRACT_*` = shape; `UNKNOWN_SOURCE` / `UNCITED_SOURCE` = citation advice) |
| Which inputs did it use? | `run.context.sources` (id, kind, origin, received date, SHA-256) and `run.context.baselineEvidence` |
| What did each role do? | `GET /api/stage-runs/<runId>/events` — `role_start`/`role_end`/`role_error`, `tool_call`, `review_decision` (rating, counts, coverage), `final_gate`, `gate_decision`, `human_decision`, `document_created`, `document_exported` / `document_export_failed`, `run_retried`, `gate_stale`. Live: `…/events/stream` (SSE). |
| The draft and analysis | `run.draftMarkdown`, `run.analysisMarkdown` (kept on failure) |
| Reviewer findings per pass | `GET /api/stage-runs/<runId>/reviews` (`reviewerRole: requirements_reviewer`) |
| Tokens, rate, context | `GET /api/stage-runs/<runId>/telemetry` |
| Logs | Web: project **Logs** (filter by run); API: `GET /api/projects/<id>/logs?runId=<runId>&level=error` |
| Published files | `run.documents` (Markdown under `<project root>/.aifactory/documents/requirements/`); the PDF at `<project root>/documents/requirements/Requirements specification — <project>.pdf` |
| Gates waiting on a human | `GET /api/stage-runs?awaiting=1[&staleOnly=1]` |

### 3.1 Diagnose a revision or reproduce it offline

1. Read `run.context.promptBundleVersion` and `run.context.processParams`. From `role_start`, compare `spec`, `specVersion`, `promptSha256`, and `truncated` section IDs to distinguish a prompt change from changed evidence or budgets. `revision_report` links input and revised drafts via their fingerprints and shows plan validity, missing IDs, author-reported dispositions and size growth. Compare the revised fingerprint to the reviewed draft; dispositions are claims, not proof of fixes. An invalid plan gets one plan-only repair attempt when a revised document is present. Its result cannot replace the revised Markdown, and the revised draft still goes to review.
2. For a controlled reproduction, start the API with `AIFACTORY_RECORD_PROMPTS=1` and `AIFACTORY_REPLAY_DIR` pointing to a dedicated private directory under a trusted location outside the project and repository. Capture is off by default. Successful role turns write full prompt/reply pairs, in sequence, under a hashed run directory. The replay writer requires private, non-symlink directories and writes private files. Captures can contain briefs, attachments, drafts and other confidential data: use synthetic inputs where possible; never commit or attach raw captures; delete them when finished. Disable capture before replay. If a capture could not be written (including size or entry limits), look for `stage.role.capture_failed` in the API logs.
3. In a local test, recreate the inputs and inject `new ReplayRunner(captureRoot, capturedRunId).runPrompt` into the stage runtime's `runPrompt` dependency. This is a test hook, not an HTTP endpoint or a production run switch. See [replay tests](../../apps/chat-cli/test/process-replay.test.ts) for runner usage. It requires the same role and exact prompt at each slot, preserving repeated prompts in order. A mismatch or exhausted capture fails rather than calling a live model. Compare the review/gate results to isolate deterministic processing; replay does not demonstrate live convergence.

---

## 4. Recovery

| Symptom | Cause | Recovery |
|---|---|---|
| `status: failed`, summary `# Requirements run failed` / `<role> failed: harness turn timed out after N ms` | Role exceeded `AIFACTORY_STAGE_ROLE_TIMEOUT_MS` | Raise the timeout and restart the API, then `POST /api/stage-runs/<id>/retry` (admin) and `POST …/execute`. Retry keeps the stored analysis and draft and resumes from the failed phase; it never runs automatically. |
| Failed with `harness exited with code 1` immediately | Harness cannot start (profile not writable, binary missing, no credentials) | Fix the environment (`npm run doctor`, `node <dsh> --profile headless --dump-config`), then retry. |
| Failed for a model error (rate limit, auth) | Provider | Fix the target or credentials; `POST …/rebind` (admin) makes a paused run adopt the current model and agents; retry a failed one. |
| A decision or refine fails mid-way (`502 STAGE_RESUME_FAILED`) | Role failure while resuming at the gate | Nothing to do: the run is put back at the **same gate with the same draft**. Retry the decision. |
| `409 REQUIREMENTS_COVERAGE_BLOCKED` on approve | Deterministic blockers in the current draft | Read `pendingGate.coverage.findings`; **Refine further**, or approve with `coverageWaiverReason` if the gap is accepted. A run paused before the R9 contract (register without type/status/resolve-by, non-MoSCoW priorities) needs one refine pass. |
| Approved but no PDF (`document_export_failed`) | PDF rendering failed; the Markdown is stored | `POST /api/stage-runs/<id>/export` re-renders and overwrites the file. |
| Gate unanswered for days | — | Listed by `?awaiting=1&staleOnly=1`, one `gate_stale` event. Nothing is auto-approved or cancelled. |
| Run stuck or no longer wanted | — | `POST /api/stage-runs/<id>/cancel {"reason":"…"}`; a running role stops at its next heartbeat. Start a new attempt. |
| `409 STAGE_RUN_NOT_FAILED` on retry | Only failed runs can be retried | A cancelled or completed run cannot be resumed; start a new run. |
| `409 STAGE_RUN_NOT_AWAITING_DECISION` | The gate already moved (another tab, a completed decision) | Reload the run. |

---

## 5. Known limitations

- **Model review does not block approval.** Deterministic checks block; reviewer blockers drive revision and are shown at the gate, but a human can approve. In the first live run the reviewer did not converge (68 → 82 → 74 → 68 over three revisions, ending with one blocker) while every deterministic check passed. Treat an unaccepted gate as a request for human judgement, not as a pass.
- **Specifications get long.** Live drafts reached 57,000–74,000 characters (35–41 requirements). Every revision rewrites the whole document, which is what drives the role timeout.
- **One document per stage run.** No partial approval, no diff between revisions in the UI; compare `requirements-draft-*` files from the smoke test or the events.
- **Checks verify structure and links, not truth.** A stated source or goal is not checked against the evidence.
- **Deferred with reasons** ([R9 #10](http://localhost:8282/issues/10)): source classification, structured elicitation, journeys, WSJF, cross-source term-usage checks, out-of-scope rejection, a blueprint checklist, baseline versioning and change control. Business rules, a glossary, MoSCoW priorities, a typed register with resolve-by dates and the source register are built. See the S02 table in [AI-Factory-Requirements-v2.md](../AI-Factory-Requirements-v2.md#52-s02--requirements-elicitation-and-analysis).

---

## 6. Work tracking

The requirements-stage work (R1–R9) is tracked in the local Redmine at `http://localhost:8282` (project AIFactory, parent [#1](http://localhost:8282/issues/1)). Agents reach it through an MCP server; setup, the schema shim and security notes are in [tools/redmine-mcp/README.md](../../tools/redmine-mcp/README.md).
