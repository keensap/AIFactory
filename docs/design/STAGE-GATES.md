# Stage Review Gates

**Status:** implemented 2026-11-16  
**Scope:** Planning & Feasibility (the only executable stage)  
**Related:** `DOCUMENTS-AND-PDF.md`, `STAGE-RUNTIME.md`

---

## 1. What this changes

A run reviews and revises automatically until the review meets the acceptance criteria or the configured cycle budget is exhausted. It then pauses at the **final human gate**, even when the review did not meet the criteria. A human decision, not automated acceptance, completes the stage; only then are the Markdown document and PDF produced.

---

## 2. Settings

Settings are stored **per project and per stage** as JSONB, because each stage needs different knobs: `project_stage_settings(project_id, stage, settings)`. A stage's schema lives in code (`STAGE_SETTINGS_DEFINITIONS`); a stage without a runtime has no definition, so its settings are `{}` and updates return `501`. Resolution is **definition defaults ← Factory default ← project override**, and the Factory defaults are one JSONB document keyed by stage.

| Field | Default | Meaning |
|---|---|---|
| `maxReviewCycles` | `3` | Automatic revision/review cycles, counted **after** the first review (1–10) |
| `minRating` | `0` | Minimum overall document rating (0–100) for the run to stop revising early |
| `maxBlockers` | `0` | Blockers tolerated |
| `maxMajor` | `0` | Major findings tolerated |

Resolution is **project override → Factory default**. Endpoints:

- `GET /api/settings/stages`, `GET/PATCH /api/settings/stages/:stage` (Factory defaults)
- `GET/PATCH/DELETE /api/projects/:id/stages/:stage/settings` (project override)
- `GET/PATCH /api/settings/stage-defaults` is a deprecated alias for the planning default.

A run **snapshots** the resolved values into its context packet at start, so changing settings mid-run cannot alter an in-flight run. A corrupt stored value falls back to the defaults rather than blocking runs.

**Acceptance criteria.** The reviewer rates the document (0–100) and reports findings by severity. After each review the runtime evaluates:

```
accepted = blockers <= maxBlockers AND major <= maxMajor AND rating >= minRating
```

When accepted, the run **stops revising immediately** and asks for approval at the final gate, even with cycles left in the budget. When not accepted, it revises automatically until `maxReviewCycles` is spent, then asks for approval anyway. A review without a rating falls back to the reviewer's `decision`, keeping older reviewers working.

Defaults (`0`/`0`/`0`) mean: any blocker or major finding keeps the run revising, and the reviewer's `approved` decision governs — the behaviour before this feature.

---

## 3. State machine

```
execute → analyze → draft → review ── accepted or budget exhausted ──→ final gate
                              │                                             │
                              └── revise → review (while budget remains)    │
                                     complete + document + PDF ← decision ──┘
```

A review that meets the acceptance criteria leaves the loop early. When the budget is spent the run stops at the **final gate** instead of failing with `REVIEW_CYCLE_LIMIT`.

**Pausing.** A paused run has status `awaiting_human` and a persisted `pendingGate` of kind `final`, with the cycle count, review decision and findings. It releases its worker lease, so it can wait hours or days and resume on any API instance.

**Resuming.** `POST /api/stage-runs/:id/decision` answers the final gate (`decision`, or `refine: true`).

**Refining.** `refine: true` runs one more review and, if it requests changes, one revision; then the final gate returns. Refining does not complete anything.

---

## 4. Completion

`decide` without `refine` is the only path to `completed`:

1. store the Markdown document (`.aifactory/documents/planning/…`);
2. mark the TELOS checklist items done;
3. render and write the PDF into `<root>/documents/planning/`, failure-isolated;
4. mark `feasibility_decision` done, record the decision and summary, set `completed`.

Before this point `run.documents` is empty and `documents/` does not exist; the draft is available as `run.draftMarkdown`.

---

## 5. Failure handling

| Failure | Behaviour |
|---|---|
| Reviewer repeatedly requests changes | Stops at the final gate; no error, no unbounded loop (hard stop at the budget) |
| PDF render/write fails | Stage still completes; `document_export_failed` event and warning log; `POST …/export` retries |
| Settings unavailable or corrupt | Falls back to defaults; the run proceeds |
| Wrong endpoint for the gate | `409` with a specific code; the run is untouched |
| Lease lost while paused | Not possible: the lease is released at the pause and re-claimed on answer |

---

## 6. Tests

`test/stage-gates.test.ts` covers: automatic cycles then final gate, budget exhausted without failure, accepted reviews stopping early, refine behaviour, completion producing the document and PDF, settings validation and snapshot semantics, and the HTTP gate/decision lifecycle. `test/stage-settings.test.ts` covers persistence, precedence, clearing, validation, corrupt values and the settings endpoints.

---

## 7. Not done

- Gates for stages beyond planning and requirements (no other stage is executable yet). Requirements adds deterministic coverage blockers and an audited waiver to the same final gate ([REQUIREMENTS-CONTRACT.md](REQUIREMENTS-CONTRACT.md)).
- A timeout or auto-accept policy for runs left paused indefinitely.
- Per-run overrides of the settings (only per project and per Factory).
- Notification when a run reaches a gate.
