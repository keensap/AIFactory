# Stage Review Gates

**Status:** implemented 2026-11-16  
**Scope:** Planning & Feasibility (the only executable stage)  
**Related:** `DOCUMENTS-AND-PDF.md`, `STAGE-RUNTIME.md`

---

## 1. What this changes

Before, a planning run executed analyzer → author → reviewer in one pass, revised automatically at most three times, and then waited for a go / conditional-go / no-go decision. The document and its PDF were produced *before* that decision.

Now a run **pauses at gates** and resumes when a human answers:

- **Gating on** — after **every** review that is not approved, the operator is asked whether to apply its changes.
- **Gating off** — review changes are applied automatically for a configured number of cycles.
- In both modes the run ends at a **final gate** asking whether to refine further.
- Only an approval at that gate completes the stage; **only then** are the Markdown document and the PDF produced.

---

## 2. Settings

| Field | Default | Meaning |
|---|---|---|
| `gateAfterEachReview` | `false` | Pause after every non-approved review and ask before applying changes |
| `maxReviewCycles` | `3` | Revision cycles applied automatically when gating is off, counted **after** the first review (1–10) |

Resolution is **project override → Factory default**. Endpoints:

- `GET/PATCH /api/settings/stage-defaults`
- `GET/PATCH/DELETE /api/projects/:id/stages/planning/settings`

A run **snapshots** the resolved values into its context packet at start, so changing settings mid-run cannot alter an in-flight run. A corrupt stored value falls back to the defaults rather than blocking runs.

---

## 3. State machine

```
                 ┌──────────────── gating on ───────────────┐
                 │                                           ▼
execute ─► analyze ─► draft ─► review ─► [needs changes?] ─► review gate (apply / accept)
                 ▲                        │ no (approved)          │ apply
                 │                        ▼                       ▼
                 │                    final gate ◄────────── revise ─► review
                 │                        │
                 │          refine ───────┤
                 └────────────────────────┤
                                          │ approve (decision)
                                          ▼
                                   complete + document + PDF
```

Gating off replaces the review gate with an automatic revision while `cycle < maxReviewCycles`; when the budget is spent the run stops at the **final gate** instead of failing with `REVIEW_CYCLE_LIMIT`.

**Pausing.** A paused run has status `awaiting_human` and a persisted `pendingGate` (`review_changes` or `final`) with the cycle count, review decision and findings. It releases its worker lease, so it can wait hours or days and resume on any API instance.

**Resuming.** `POST /api/stage-runs/:id/gate` answers a review gate (`apply` or `accept`); `POST /api/stage-runs/:id/decision` answers the final gate (`decision`, or `refine: true`).

`accept` overrides the reviewer: the draft is kept, the override is recorded in the run event and the gate payload, and the run moves to the final gate.

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
| Reviewer repeatedly requests changes | Stops at the final gate; no error, no unbounded loop (hard stop at the budget, or the operator's answer when gating) |
| PDF render/write fails | Stage still completes; `document_export_failed` event and warning log; `POST …/export` retries |
| Settings unavailable or corrupt | Falls back to defaults; the run proceeds |
| Wrong endpoint for the gate | `409` with a specific code; the run is untouched |
| Lease lost while paused | Not possible: the lease is released at the pause and re-claimed on answer |

---

## 6. Tests

`test/stage-gates.test.ts` covers: automatic cycles then final gate, budget exhausted without failure, gating on pausing after each review, `apply` and `accept`, approved reviews skipping the review gate, refine behaviour, completion producing the document and PDF, settings validation and snapshot semantics, and the HTTP gate/decision lifecycle. `test/stage-settings.test.ts` covers persistence, precedence, clearing, validation, corrupt values and the settings endpoints.

---

## 7. Not done

- Gates for other stages (only planning is executable).
- A timeout or auto-accept policy for runs left paused indefinitely.
- Per-run overrides of the settings (only per project and per Factory).
- Notification when a run reaches a gate.
