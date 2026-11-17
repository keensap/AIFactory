# UI Implementation Prompt — Review Gates and Stage Settings

**For:** the UI implementation agent  
**Scope:** the planning-stage gate panels, the final decision panel, and the review-settings UI  
**Backend:** AI Factory HTTP API at `http://127.0.0.1:8787`  
**Contract:** `/openapi.yaml` · design: `docs/design/STAGE-GATES.md`

---

## Your task

A planning run no longer finishes on its own. It **pauses** at a gate and waits for a person. Build:

1. the **review gate** panel (apply the reviewer's changes, or accept the draft as it is);
2. the **final gate** panel (complete the stage with a decision, or refine further);
3. the **settings** UI for gating and iteration count (project and Factory default).

Three rules drive everything:

> **A paused run is a normal state, not an error.** Status is `awaiting_human` and `pendingGate` says what is being asked.
>
> **Nothing is produced before approval.** While paused, `run.documents` is empty and there is no PDF. Show `run.draftMarkdown` as the document.
>
> **The gate kind decides the panel.** `review_changes` → apply/accept. `final` → decision + refine. Never show the wrong panel.

---

## 1. Detecting a pause

```json
{ "run": { "status": "awaiting_human",
  "pendingGate": { "kind": "review_changes", "cycle": 0, "maxReviewCycles": 3,
    "gateAfterEachReview": true, "reviewDecision": "needs_revision",
    "findings": [ { "id": "F-001", "severity": "major", "section": "Economic",
                    "finding": "Budget not evidenced", "required_change": "Add the budget" } ],
    "question": "Apply the reviewer findings, or accept the draft as it is?",
    "waitingSince": "2026-11-16T17:00:00.000Z" } } }
```

- `pendingGate: null` → not paused.
- `pendingGate.kind` selects the panel; render from it, not from the status alone.
- `cycle` / `maxReviewCycles` → show progress, e.g. "Review cycle 1 of 3".
- `rating` / `counts` / `criteria` → show the score against the bar: "Rating 90/100 (needs ≥95) · 0 blockers (max 0) · 1 major (max 1)". `rating` may be `null` — show "not rated".
- `accepted: true` means the review met the bar, which is why the final gate was reached without using the full budget. Say so: "Meets the acceptance criteria."
- Note: a run can reach the **final** gate with `accepted: false` when the budget ran out — that is expected, not an error.

---

## 2. Review gate (`kind: "review_changes"`)

```
┌──────────────────────────────────────────────────────────────┐
│ Reviewer requested changes            cycle 1 of 3           │
│ Rating 90/100 · 0 blockers · 1 major   (needs ≥95, ≤0, ≤1)   │
│                                                              │
│ ● major · Economic — Budget not evidenced                    │
│   Required: Add the budget                                   │
│ ● minor · Schedule — Timeline is optimistic                  │
│                                                              │
│ [Apply these changes]        [Accept the draft as it is]     │
└──────────────────────────────────────────────────────────────┘
```

- List `findings` with severity, section, finding and `required_change`. Order blockers first.
- **Apply these changes** → `POST /api/stage-runs/:id/gate {"action":"apply"}`. Explain in a hint: "The author will revise, then the reviewer checks it again."
- **Accept the draft as it is** → `{"action":"accept"}`. This overrides the reviewer. Confirm once: "The reviewer's findings will not be applied. The draft is kept as it is." Show it as the secondary action, not the default.
- After either call the run may pause again (another review gate, or the final gate). Replace the panel with whatever `pendingGate` now says; do not assume the run finished.

**When the reviewer approved,** the run goes straight to the final gate — there is no review gate, so never show this panel.

---

## 3. Final gate (`kind: "final"`)

```
┌──────────────────────────────────────────────────────────────┐
│ Draft ready — review: approved                               │
│                                                              │
│ [Preview draft]            cycle 3 of 3                      │
│                                                              │
│ Decision   ( ) Go   ( ) Conditional go   ( ) No-go           │
│ Note       [___________________________________]             │
│                                                              │
│ [Complete stage and produce PDF]   [Refine further]          │
└──────────────────────────────────────────────────────────────┘
```

- Show the draft via `run.draftMarkdown` (the document card is empty until completion). A "Preview draft" expander is enough; rendering Markdown is already in the app.
- **Decision** is required to complete: `go` / `conditional_go` / `no_go`. `note` is optional.
- **Complete stage and produce PDF** →
  ```json
  POST /api/stage-runs/:id/decision {"decision":"go","note":"Approved by sponsor"}
  ```
  On success the run is `completed`, `documents[0].exportPath` exists, and the PDF is in the project.
- **Refine further** →
  ```json
  POST /api/stage-runs/:id/decision {"refine":true}
  ```
  The run stays `awaiting_human`; it runs another review (and revision if needed) and returns to this panel. Say so: "One more review and revision, then you will be asked again."
- Disable both buttons while a request is in flight; these calls take as long as a role run.

**Also show:** `pendingGate.reviewDecision` and the count of findings, so the operator knows why they are here.

---

## 4. Settings

### Where

A **Stage settings** section: project-level under the planning stage (or project settings), plus a Factory default in the global settings page.

```
Planning & Feasibility — review settings
  ( ) Ask me after every review whether to apply the changes
  (•) Apply changes automatically for  [3]  review cycles
  Stop revising early when: rating ≥ [95] · blockers ≤ [0] · major ≤ [1]

  Effective: Factory default           [Reset to Factory default]
```

### Endpoints

| Purpose | Call |
|---|---|
| Factory defaults | `GET` / `PATCH /api/settings/stage-defaults` |
| Project override | `GET` / `PATCH` / `DELETE /api/projects/:id/stages/planning/settings` |

```json
{ "stageDefaults": { "gateAfterEachReview": false, "maxReviewCycles": 3 } }
{ "settings": { "gateAfterEachReview": true, "maxReviewCycles": 3, "source": "project" } }
```

- Show `source` (`project` or `factory`) next to the controls so the user knows what they are overriding.
- The number is only meaningful when gating is **off**; disable the input (with a hint) when gating is on, but still send it.
- Ranges: cycles 1–10, rating 0–100, blockers 0–20, major 0–50. Surface `INVALID_REVIEW_CYCLES`, `INVALID_MIN_RATING`, `INVALID_MAX_BLOCKERS`, `INVALID_MAX_MAJOR` on the fields.
- Explain the early stop in one line: "The run stops revising as soon as all three hold, and asks you to approve." Setting `minRating: 0` with `0`/`0` means only the reviewer's own approval ends the loop.
- `Reset to Factory default` → `DELETE`; then refresh and show `source: "factory"`.
- Say clearly: **"Applies to new runs. A run that has already started keeps the settings it began with."**

---

## 5. States and errors

| Situation | UI |
|---|---|
| `pendingGate: null`, status not `completed` | the run is executing; show progress, not a gate |
| `409 STAGE_RUN_NOT_AT_REVIEW_GATE` | panel is stale — refresh the run |
| `409 STAGE_RUN_NOT_AWAITING_DECISION` | same: the gate changed |
| `400 INVALID_HUMAN_DECISION` | decision required for completion |
| `400 INVALID_GATE_ACTION` | programming error; do not surface raw |
| `400 INVALID_REVIEW_CYCLES` / `INVALID_GATE_SETTING` | on the settings field |
| `501 STAGE_SETTINGS_NOT_IMPLEMENTED` | other stages have no settings yet; hide the section |
| `503 STAGE_SETTINGS_NOT_CONFIGURED` | no database; disable the section |
| Run `completed` | show the document card with **Open PDF** (`GET /api/projects/:id/documents/:documentId/export`) and **Re-export** (`POST /api/stage-runs/:runId/export`); on `410 EXPORT_FILE_MISSING`, offer Re-export and retry |
| Run `failed` | show the failure summary; gates are not available |

**Polling:** while paused, the run does not change on its own. Poll slowly (or not at all) — refresh after an action instead. While executing, poll as today.

---

## 6. Acceptance criteria

- [ ] A paused run shows the correct panel for `pendingGate.kind`; the wrong panel is never shown.
- [ ] The review gate lists findings with severity and required change, and both actions work.
- [ ] "Accept the draft as it is" is secondary and confirmed, and its consequence is stated.
- [ ] The final gate requires a decision to complete, and "Refine further" returns to the same panel.
- [ ] Completing the run reveals the document and the PDF path; before that the panel says no PDF exists yet.
- [ ] Cycle progress ("cycle 2 of 3") is shown from `pendingGate.cycle` / `maxReviewCycles`.
- [ ] Settings show their source, can be overridden and reset, and state that they apply to new runs only.
- [ ] `409` from a stale gate refreshes the run instead of showing an error toast.
- [ ] After every action the UI re-reads `pendingGate` rather than assuming the next state.
