# Process architecture: isolated, testable, overridable roles

**Status:** proposed 2026-11-19 — no code written yet
**Owners:** platform
**Tracking:** Redmine [#11](http://localhost:8282/issues/11) — phases [#12](http://localhost:8282/issues/12) to [#17](http://localhost:8282/issues/17)
**Related:** [STAGE-RUNTIME.md](STAGE-RUNTIME.md) · [STAGE-GATES.md](STAGE-GATES.md) · [REQUIREMENTS-CONTRACT.md](REQUIREMENTS-CONTRACT.md) · [AGENTS.md](AGENTS.md)

---

## 1. Decision

The analyzer, author, reviewer and revision roles become **first-class units**: a spec
(input type, ordered prompt sections, parameters, output contract, parser, post-conditions)
executed by a **runner port**. The shared engine keeps the lease, the loop, the gate and
completion; it stops owning prompt text.

Two consequences are intended, not accidental:

1. **Planning changes too.** Its prompts are currently inside `stage-runtime.ts`; they move
   into a spec. Both stages then use one contract.
2. **Stage-specific invariants stay stage-specific.** The deterministic checks that gate
   approval (TELOS completeness for planning, the specification contract for requirements)
   are not abstracted into a common shape.

## 2. Why now — evidence from a live run

The ABCClothing requirements run (2026-11-19, `bc4cf315…`) exposed four failures that all
trace back to the role boundary being a string builder.

| Observation | Cause | Where it lives today |
|---|---|---|
| Findings grew 14 → 18 on an **unchanged** 98k-character draft between two reviews | Reviewer prompt asks for "gaps", no cap, no stability rule; default model temperature | `stages/requirements.ts` reviewer text |
| The author answered "missing requirement" findings by inventing ~37 requirements (30 → 67) and 63k characters | Revision prompt said "apply each finding" and "renumber new requirements"; no minimal-edit or no-scope-growth rule | `stages/requirements.ts` revision text |
| Findings sat at 94% of a 185k-character revision prompt, after the document | Prompt layout is invisible; ordering is incidental to template order | `stages/requirements.ts` |
| A refine pass handed the gate a draft **no reviewer had read** | Refine reviewed, revised, then paused with the pre-revision review | `stage-runtime.ts` `refineOnce` (fixed 2026-11-19) |
| Planning's prompts live in the engine file | `StagePrompts` was added for the second stage; the first stage kept its builders in `stage-runtime.ts` | `stage-runtime.ts` lines 1642–1800 |

The pattern: **behaviour that is not a declared, inspectable unit drifts silently, and cannot
be tested except through a model or a 40-minute live run.**

## 3. Current state

Already in place, and worth keeping:

| Piece | Evidence |
|---|---|
| Engine orchestration | `StageEngine` owns lease, loop, gates, completion; `StageDefinition` declares stage identity |
| Dependency injection | `StageEngine` takes `harnessFactory`, `runPrompt`, `agents`, `traces`, `stageSettings`, `prerequisites` |
| Ports + adapters + guard | `src/models/` with `check:models`; `src/observability/` with `check:observability` |
| Agent composition | persona, model, tool allowlist, skills per stage process |
| Deterministic gates | requirements contract/coverage; TELOS template |
| Review settings | `maxReviewCycles`, `minRating`, `maxBlockers`, `maxMajor`, snapshot into the run |

The seam that is not a unit:

```ts
// stage-definition.ts
interface StagePrompts {
  analyzer(project, context): string
  author(project, context, analysis): string
  reviewer(project, context, draft, settings, analysis?): string
  revision(project, context, analysis, draft, findings: unknown[]): string
}
```

`findings: unknown[]` is the whole problem in one type: no input contract, no output
contract, no parameters, no version, no provenance, no way to override a section.

## 4. Principles

1. **Ports and adapters, as with models and observability.** A role depends on ports
   (`RunnerPort`, `ContextPort`); concrete runners are adapters. A guard script keeps the
   kernel from importing an adapter.
2. **The kernel orchestrates, it does not compose prose.** The engine may decide *when* a
   role runs and *what to do* with its output. It must not know what a TELOS report says.
3. **Data over templates.** A prompt is an ordered list of sections with ids, budgets and
   provenance — inspectable, diffable, testable without a model.
4. **Structured at the boundary, Markdown in the artifact.** Reviews, plans and findings are
   schema-checked JSON. The document itself stays Markdown, because humans and PDF rendering
   consume it.
5. **Provenance is cheap and decisive.** Every role run records which spec, which prompt and
   which document digest it saw. Same lesson as `reviewedDraft`.
6. **Invariants are stage-specific.** Deterministic checks are per stage and may not be
   normalised into a "generic validator".
7. **Compat first.** The old `StagePrompts` interface survives as an adapter until every
   stage has moved, so the engine and the tests keep working during migration.

## 5. The process abstraction

### 5.1 Role spec

```ts
// src/processes/spec.ts
export interface RoleSpec<I, O> {
  /** Stable identity, e.g. 'requirements/reviewer'. */
  readonly id: string
  /** Semantic version of the spec; a behaviour change must bump it. */
  readonly version: string
  /** Which runner modes are acceptable (markdown author vs JSON reviewer). */
  readonly output: 'markdown' | 'json' | 'markdown+envelope'
  /** Build the ordered, budgeted prompt from a typed request. Pure. */
  sections(input: I, params: RoleParams): PromptSection[]
  /** Parse and validate the raw reply. Throws a typed error with the reason. */
  parse(raw: string, input: I): O
  /** Optional incremental repair instruction after a parse failure (one retry). */
  repair?(raw: string, error: ProcessError): string
  /** Post-conditions that need no model, e.g. "every finding cites an id". */
  check?(output: O, input: I): ProcessFinding[]
}
```

Requests are typed per role, replacing ad-hoc arguments:

```ts
// requirements
type ReviewerInput = { draft: Draft; analysis: string; evidence: Evidence; params: RoleParams }
type RevisionInput = { draft: Draft; findings: ReviewFinding[]; analysis: string; evidence: Evidence }
```

Outputs are typed per role:

```ts
type ReviewOutput = { decision: StageReviewDecision; rating: number | null; findings: ReviewFinding[] }
type RevisionOutput = { plan: RevisionStep[]; document: string }
type AnalysisOutput = { text: string }
```

### 5.2 Prompt sections

```ts
export interface PromptSection {
  id: string                  // 'findings', 'document', 'evidence', 'contract', 'task'
  title?: string
  body: string
  /** Truncate here, never silently: the renderer marks the cut. */
  maxChars?: number
  /** Lower runs first; ties keep declaration order. */
  order: number
  /** Provenance: where the body came from (document id, baseline, brief). */
  source?: { kind: 'draft' | 'baseline' | 'attachment' | 'brief' | 'spec' | 'analysis'; ref?: string }
}
```

The renderer is one function with three rules the tests assert:

1. sections render in `order`, and the **task/findings sections come before long evidence**;
2. a section over its budget is truncated **with an explicit marker** naming the original size;
3. the whole prompt's section sizes are returned, so `role_start` can record them.

This makes yesterday's failures declarative: "findings before document" becomes an
assertion on the section list, not on string positions in a 185k template.

### 5.3 Outputs

| Role | Shape | Parsing | On failure |
|---|---|---|---|
| analyzer | Markdown | trim only | fail the role |
| author (initial) | Markdown | fence-stripping (`cleanMarkdown`) | fail the role |
| reviewer | **JSON** `{decision, rating, findings[]}` | schema validation of every field; unknown severities rejected or mapped explicitly | **one repair retry** with the validation error, then fail |
| revision | **`markdown+envelope`**: a leading `REVISION_PLAN` block (`findingId → section → change`) then the full document | envelope parsed and validated; document via `cleanMarkdown` | one repair retry, then fail |

`markdown+envelope` is the deliberate compromise: it proves the author addressed the
feedback (which the run today cannot show), without putting a 120k-character document inside
JSON.

Post-conditions worth having from day one:

- revision: every finding id appears in the plan, or the plan says `unaddressed: reason`;
- revision: document size change is reported, and a growth beyond a configured ratio is a
  `check` finding (advisory, shown at the gate — not a block);
- review: findings are capped; each has `severity` in the rubric and a non-empty `required_change`.

### 5.4 Context providers

```ts
export interface ContextSection {
  id: 'project' | 'brief' | 'attachments' | 'baseline' | 'sources' | 'prior-stages' | 'analysis'
  body: string
  budget?: number
  truncated?: boolean
  provenance: Array<{ kind: string; ref: string }>
}
export interface ContextProvider { provide(input: RunContext): Promise<ContextSection[]> }
```

Requirements and planning select providers in their spec; the engine stops calling
`evidence()`-style helpers. Budgets move out of magic constants (`MAX_ATTACHMENT_CHARS`,
`BASELINE_TEXT_LIMIT`, `PROMPT_CHARS_PER_ATTACHMENT`) into the spec's parameters, with the
existing values as defaults.

### 5.5 Runner port

```ts
export interface RunnerPort {
  run(request: RunRequest): Promise<RunReply>
}
export interface RunRequest {
  role: string; prompt: string; cwd: string; timeoutMs: number
  sessionId?: string; signal?: AbortSignal; onEvent?: (event: HarnessEvent) => void
}
export interface RunReply { text: string; stderr: string; durationMs: number; exitCode: number }
```

Adapters: `HarnessRunner` (today's `DshHarness`), `ReplayRunner` (recorded prompt → recorded
reply), `DeterministicRunner` (test map), and later `DirectModelRunner` for the model
routing path. The engine resolves one runner per run and records which was used.

### 5.6 Parameters and precedence

```ts
export interface RoleParams {
  model?: { provider?: string; model?: string; temperature?: number }
  review: { maxFindings: number; rubric: 'strict' | 'balanced'; requireEvidenceCitation: boolean }
  revision: { maxGrowthRatio: number; allowNewRequirements: boolean }
  context: { draftChars: number; baselineChars: number; attachmentChars: number; analysisChars: number }
  prompt: { sections: Record<string, { enabled?: boolean; maxChars?: number; extraInstructions?: string }> }
  checks: { deterministic: 'block' | 'advisory' }
}
```

Precedence: **factory default → stage → project → run**, each layer partial, deep-merged per
field (not by replacing the object). The resolved object is snapshotted into the run, exactly
as review settings are today, so a paused run keeps its behaviour.

Only declared keys are overridable. `extraInstructions` appends to a named section; it cannot
replace one, delete one, or reorder the task/contract sections. That is the boundary between
configuration and drift.

### 5.7 Provenance on every role run

`role_start` gains:

```json
{ "role": "reviewer", "spec": "requirements/reviewer", "specVersion": "2",
  "promptSha256": "…", "promptChars": 185598,
  "sections": [{ "id": "findings", "chars": 12000 }, { "id": "document", "chars": 119138 }],
  "truncated": ["baseline"], "draft": { "chars": 98124, "sha256": "…" } }
```

With this, "the reviewer behaved differently" is answerable from the event log: same spec,
same digest, different output. It also makes the replay corpus self-describing.

### 5.8 Prompt capture for replay

Replay needs the exact prompt. Two mechanisms, both cheap:

1. **Always:** `promptSha256` + section sizes (above). Detects drift, costs nothing.
2. **Opt-in:** `AIFACTORY_RECORD_PROMPTS=1` writes the rendered prompt to
   `<project>/.aifactory/runs/<runId>/prompts/<role>-<n>.txt` (gitignored, size-capped,
   redacted by the existing logging sanitiser). This is what `ReplayRunner` consumes.

Because specs are versioned and retained, a test can also **re-render** a prompt from the
stored run context and assert the hash matches — proving that a spec change is intentional.

## 6. What stays stage-specific

| Concern | Planning | Requirements |
|---|---|---|
| Artifact | TELOS report (Markdown) | Requirements specification (Markdown) |
| Deterministic gate | TELOS template completeness | Contract shape + coverage + source citations |
| Decision | go / conditional go / no go | approve / reject / waiver |
| Review rubric | feasibility evidence, five dimensions | contract conformance, atomicity, traceability |
| Prompts | TELOS sections | contract sections |

The shared layer knows about **roles, sections, runners, params and provenance**. It does not
know what a requirement is.

## 7. Compatibility adapter

Phase 1 keeps the existing contract working:

```ts
// adapter: a spec still satisfies StagePrompts
export function promptsOf(specs: StageRoleSpecs): StagePrompts {
  return {
    analyzer: (p, c) => render(specs.analyzer.sections(requestFor(specs.analyzer, p, c)), params),
    author: (p, c, a) => …,
    reviewer: (p, c, d, s, a) => …,
    revision: (p, c, a, d, f) => …,
  }
}
```

No engine change, no test change, until a stage opts in. That is what makes the migration
safe and incremental.

## 8. Execution plan

Each phase is independently shippable and leaves `main` green. Exit criteria are testable,
not aspirational.

| Phase | Redmine | Outcome visible to a user |
|---|---|---|
| 1. Sections and specs behind an adapter | [#12](http://localhost:8282/issues/12) | none (byte-identical prompts); planning's prose leaves the engine |
| 2. Provenance and replay | [#13](http://localhost:8282/issues/13) | `role_start` shows which spec, prompt and draft a role saw; prompt changes are testable without a model |
| 3. Requirements specs | [#14](http://localhost:8282/issues/14) | the gate shows whether the author addressed each finding, and how much the document grew |
| 4. Planning spec and structured review | [#15](http://localhost:8282/issues/15) | a malformed review is repaired or fails with a reason, not a 5-minute loss |
| 5. Parameters and precedence | [#16](http://localhost:8282/issues/16) | review strictness, caps and budgets are configurable per project without a deploy |
| 6. Guard and docs | [#17](http://localhost:8282/issues/17) | a new stage cannot bypass the role contract |

### Phase 1 — Sections and specs behind an adapter (no behaviour change)

- **Build:** `src/processes/{spec,sections,render,params}.ts`; `promptsOf()` adapter;
  section-based renderer with ordinal ordering, budgets, truncation markers and size report.
- **Move:** planning's four prompt builders from `stage-runtime.ts` into
  `src/processes/stages/planning.ts` as sections, rendering byte-identical prompts.
- **Tests:** golden tests compare rendered output with the current prompt text (hash
  equality), so "no behaviour change" is proven, not assumed; section ordering and budget
  truncation unit tests.
- **Exit:** all 703 tests pass unchanged; `stage-runtime.ts` contains no stage prose;
  `grep` shows no prompt literal for planning in the engine.

### Phase 2 — Provenance and replay

- **Build:** `promptSha256`, section sizes, `truncated[]` and `spec`/`specVersion` on
  `role_start`; `AIFACTORY_RECORD_PROMPTS` capture; `ReplayRunner`; a replay test harness.
- **Tests:** record the ABCClothing-shaped fixture once (synthetic, small), replay it, assert
  the same parsed review; assert a spec change moves the hash and the golden test fails loudly.
- **Exit:** a prompt change can be evaluated against a recorded reply in seconds; no model
  call in the replay tests.

### Phase 3 — Requirements spec (the painful stage)

- **Build:** requirements analyzer/author/reviewer/revision specs with typed inputs and
  section order (findings before document), context budgets, and the revision envelope.
- **Behaviour:** keep 2026-11-19 fixes (minimal edit, no scope growth, 12-finding cap,
  re-review after refine) but expressed as spec rules and `check` post-conditions.
- **Tests:** section-order assertions; envelope parse + repair; "plan covers every finding";
  growth ratio reported; the existing regression suite (`stage-requirements-paths`) unchanged.
- **Exit:** deterministic tests prove ordering, budgets and the revision plan; a recorded
  replay shows the reviewer's list capped and stable.

### Phase 4 — Planning spec and structured review

- **Build:** planning specs from the Phase 1 sections; reviewer JSON schema with validation
  and one repair retry; feasibility rubric as parameters; TELOS gate untouched.
- **Tests:** TELOS prompt goldens; malformed reviewer reply → repair → typed error; planning
  gate semantics unchanged (`go`/`conditional_go`/`no_go`, summaries, PDF).
- **Exit:** planning behaviour equal except where a parameter default differs, documented.

### Phase 5 — Parameters and overrides

- **Build:** `RoleParams` with `factory → stage → project → run` precedence, deep merge,
  snapshot into the run; API fields (settings endpoints) and web controls for the review
  knobs only; validation with bounds.
- **Tests:** precedence table; invalid value rejected with a typed error; snapshot survives a
  settings change mid-run; `extraInstructions` cannot remove a task/contract section.
- **Exit:** changing `maxFindings` or `maxMajor` changes a replayed run's outcome without a
  code change.

### Phase 6 — Guard and consolidation

- **Build:** `scripts/check-processes.mjs` (like `check:models`): no stage prompt literals
  outside `src/processes/stages/`; no adapter imports from the engine; no spec without a
  version; no `findings: unknown[]` left in a role signature.
- **Docs:** update STAGE-RUNTIME.md, AGENTS.md, API.md (role_start fields, settings),
  REQUIREMENTS-STAGE-OPERATIONS.md (debugging with replay).
- **Exit:** guard runs in CI; documentation matches the code.

**Effort:** Phase 1–2 ≈ 1 day each; Phase 3 ≈ 2 days; Phase 4 ≈ 1 day; Phase 5 ≈ 1–2 days;
Phase 6 ≈ 0.5 day. Roughly one working week, with Phase 1–2 useful on their own.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Planning regression (it gates advancement) | Phase 1 proves byte-identical prompts; Phase 4 keeps gate semantics and runs the existing planning suites |
| Prompt drift from the deterministic contract | Overrides are typed and additive; the gate still checks the document, so a bad prompt override cannot publish a non-conforming artifact |
| Token/cost growth from repair retries | At most one repair per role; `maxReviewCycles` still bounds the loop; repair is skipped when the reply is empty |
| Spec proliferation | One `RoleSpec` per role per stage; shared section builders; the guard forbids a second prompt path |
| Replay corpus becomes a crutch | Replay tests are regression tests, not acceptance; one live smoke still runs per release |
| Over-abstraction | The engine is not refactored. Lease, loop, gate and completion stay as they are |

## 10. Open decisions

1. **Reviewer repair policy.** One retry (proposed) or fail fast? A retry costs a model call
   but avoids losing a 5-minute pass to a malformed brace.
2. **Author growth guard.** Advisory at the gate (proposed) or a blocking check? Blocking
   would catch ABCClothing-style scope creep but can block a legitimate expansion.
3. **`extraInstructions` scope.** Sections only (proposed), or also rubric weights?
4. **Where `RoleParams` are stored.** Reuse the stage-settings table (proposed, one row per
   stage with a JSONB blob) or a new table per run.
5. **Replay corpus in git.** Small synthetic fixtures only (proposed); real project prompts
   stay in `.data/`.

## 11. Not doing

- Rewriting the engine, the lease model or the gate lifecycle.
- Putting the document itself in JSON.
- A generic "prompt language" with conditionals or loops.
- Making deterministic checks uniform across stages.
- Per-user prompt overrides.
