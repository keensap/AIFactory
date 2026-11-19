# Requirements specification contract

**Status:** implemented 2026-11-19
**Source of truth:** [`requirements-contract.ts`](../../apps/chat-cli/src/stages/requirements-contract.ts)

---

## 1. Why a contract

The requirements stage used to ask for "numbered functional requirements, measurable
NFRs and acceptance criteria" in prose. The reviewer judged whatever arrived, so a
document could pass review while missing fields the specification requires
(`FR-203`, `FR-204`, `FR-208`, `FR-211`, `FR-212`).

The contract is now one module used by three callers — the author prompt, the
reviewer rubric and the revision prompt — plus one deterministic check,
[`inspectRequirementsDocument`](../../apps/chat-cli/src/stages/requirements-checks.ts),
which the runtime gates on. A prompt
change and its review criteria cannot drift apart, and a test asserts that every
element appears in each prompt.

## 2. What the document must contain

| Section | Required content |
|---|---|
| 1. Purpose and scope | The problem and outcome, plus **In scope / Out of scope / Deferred** as separate statements. Optional `### Glossary`: term, definition, source |
| 2. Actors and permissions | Actor, goal, permissions |
| 3. Functional requirements | One row per requirement with **id, actor, trigger, behaviour, inputs, outputs, error cases, priority, acceptance criteria**; priority is MoSCoW (**must / should / could / won't**). Optional `### Business rules`: `BR-###`, type (decision table, formula, state transition, validation, policy), rule, the FRs it applies to, its acceptance criteria |
| 4. Non-functional requirements | Every domain in the catalogue, each with a measurable target and a verification method |
| 5. Acceptance criteria | `AC-###` rows in Given/When/Then form, each naming the FR, NFR or business rule it proves |
| 6. Assumptions, constraints and open questions | Each with a **type** (assumption, constraint, dependency, question), **owner**, **impact if wrong**, **status** (open, confirmed, closed) and a **resolve-by** date (YYYY-MM-DD; required while open) |
| 7. Traceability | For each FR and NFR: the source — its `SRC-###` id from the run's source register, else the planning baseline (document id and version), an input document or the brief — and the stakeholder or project goal |

**Source register (FR-201).** At run start every input — the brief, the planning
baseline, each uploaded document — is recorded with an `SRC-###` id, origin,
received date and SHA-256 in `run.context.sources`, and shown to every role.
Sources are not classified yet (`unclassified`).

**NFR catalogue:** performance, scalability, availability, security, privacy,
accessibility, localisation, observability, maintainability, portability,
compliance. A domain that genuinely does not apply is written as
`not applicable — <reason>`; it cannot be silently deleted.

## 3. Machine check versus review

`inspectRequirementsDocument` is the only deterministic check. It combines two
modules and is what the gate, the tests and the live smoke test use:

| Module | Checks | Finding codes |
|---|---|---|
| [`requirements-validation.ts`](../../apps/chat-cli/src/stages/requirements-validation.ts) (shape) | the seven section headings, present and in order; the required table and columns in each; non-placeholder values in every required FR, NFR target, acceptance criterion (Given/When/Then), actor and register cell; MoSCoW priority; register type, status and resolve-by date; business-rule type; glossary terms defined once and consistently; every NFR domain present, or `not applicable — <reason>`; the three scope boundaries | `CONTRACT_*`, always blocking |
| [`requirements-coverage.ts`](../../apps/chat-cli/src/stages/requirements-coverage.ts) (links) | declared FR/NFR/BR/AC ids, duplicates, dangling and mismatched references, an acceptance criterion naming every FR, NFR and business rule, business rules applying to declared FRs, NFR verification, traceability source and goal; counts including the MoSCoW tally and business rules | blocking, except `MISSING_SOURCE` / `MISSING_GOAL` (advisory) |
| [`requirements-checks.ts`](../../apps/chat-cli/src/stages/requirements-checks.ts) (sources) | with the run's source register: cited `SRC-###` ids exist; every source is cited | `UNKNOWN_SOURCE`, `UNCITED_SOURCE` (advisory) |

Judgement stays with the reviewer: whether a behaviour is atomic, a target is
measurable, a verification method is adequate, or a claim is unsupported. The
checks look at table cells, not prose, so they cannot reject a good document on
style; a placeholder such as `<actor>` or `TBD` is not a value, so an echoed
skeleton never passes.

> **History.** R3 shipped a separate `inspectRequirementsSpec` that matched ids
> and headings anywhere in the text. The runtime never used it, and it disagreed
> with the table-based checks (for example on ids written without backticks).
> R8 removed it so there is one definition of "complete".

The runtime coverage report (`inspectRequirementsCoverage`) reads rows in the functional requirements, non-functional requirements, acceptance criteria, and traceability tables. It counts unique declared requirements and how many have acceptance criteria, sources, and goals. Prose mentions, comments, and fenced examples do not count as declarations. Every declared FR and NFR needs an acceptance criterion that names it.

- **Blocking:** missing requirement or criterion declarations, invalid, duplicate or dangling IDs, mismatched links, requirements lacking acceptance criteria, and NFRs missing verification. A blocking finding keeps automated revision running while budget remains and prevents ordinary approval at the final gate, even if the model approved.
- **Advisory:** missing source or goal. These gaps are shown but do not independently prevent acceptance or approval. The parser checks that links are stated; it does not verify their meaning or provenance.
- **Waiver:** an operator can explicitly approve with `{"decision":"approved","coverageWaiverReason":"…"}` using a nonblank reason of up to 2,000 characters. This waives the current draft's blocking findings for that decision only. The final summary and `human_decision` event retain the reason; the event also records the waived findings. An ordinary note, compatibility alias, rejection, or refine request cannot waive blockers.

The report appears on `pendingGate.coverage`, in the run summary and in the `review_decision` and `final_gate` events. Review events report the draft actually reviewed; the final gate rechecks the actual candidate after refinement. The report also includes `CONTRACT_` blockers for deterministic checks of the required sections and table fields. These use the same revision budget, final gate, and explicit waiver policy as traceability blockers.

## 4. Where it is enforced

| Caller | Use |
|---|---|
| `authorPrompt` (analyzer too) | Renders the skeleton and the rules; the author fills the tables in |
| `reviewerPrompt` | Receives the saved analysis, frozen planning evidence, brief, and attachments; checks ambiguity, contradictions, duplicates, testability, completeness, and unsupported claims using blocker/major/minor severity guidance |
| `revisionPrompt` | Renders the rules so a revision cannot drop a section while fixing a finding |

## 5. Tests

- `test/requirements-contract.test.ts` — a complete document passes; each missing section, a removed acceptance criterion, a deleted NFR domain and a missing scope boundary block; the unfilled skeleton is never approvable; every prompt carries every section, field and domain.
- `test/requirements-validation.test.ts`, `test/requirements-coverage.test.ts` — each module's rules in detail.
- `test/stage-evidence.test.ts` — the source register: numbering, provenance, frozen at run start, shown to every role, citation advice.
- `test/stage-requirements-paths.test.ts` — a realistic fixture and seventeen failure modes (`test/support/requirements-fixture.ts`) through a real engine: with a reviewer that approves everything, no failure mode is ever published.

## 6. Known limitations

- **Model findings do not block approval.** Only deterministic findings do. A reviewer blocker leaves the gate `accepted: false` and drives revision, but a human can still approve. In the first live run the reviewer did not converge (ratings 68 → 82 → 74 → 68 over three revisions) while the deterministic checks passed.
- **Links are checked, not meanings.** A traceability source or goal must be stated; whether it is true is the reviewer's and the operator's call.
- **Optional subsections are optional.** A document with no business rules or glossary passes; whether the evidence contained rules or terms that should have been captured is the reviewer's call.
- **No WSJF, no source classification, no journeys.** Deferred with reasons in the S02 table ([§5.2](../AI-Factory-Requirements-v2.md#52-s02--requirements-elicitation-and-analysis), [R9](http://localhost:8282/issues/10)).
- **Contract changes apply to existing gates.** The gate rechecks the draft at approval, so a run paused before R9 (old register shape, non-MoSCoW priority) is blocked until refined or approved with a waiver.

Operating the stage — configuration, inspection and recovery — is in [REQUIREMENTS-STAGE-OPERATIONS.md](../operations/REQUIREMENTS-STAGE-OPERATIONS.md).
