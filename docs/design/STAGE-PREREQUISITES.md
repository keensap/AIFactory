# Stage Prerequisites and Readiness

**Status:** implemented 2026-11-17  
**Scope:** catalogue for all eight stages; enforcement for planning (the only executable stage)  
**Related:** `STAGE-GATES.md`, `DOCUMENTS-AND-PDF.md`

---

## 1. The problem

A project does not always start at Planning. A client may hand over requirements, an existing codebase may enter at Development, and an import may supply design and architecture documents. So "run the previous stage" cannot be the definition of readiness.

A prerequisite is therefore **evidence**, and each one is satisfied by any one of:

- a **brief/input text** on a run of that stage,
- one or more **attachments** (uploaded PDFs),
- a **project document** of a given kind,
- or a **human waiver with a reason**, recorded and attributed.

## 2. The catalogue

Stored in `stage_prerequisites`, seeded once from `STAGE_PREREQUISITE_SEEDS`; editing a row changes behaviour without a deploy.

| Stage | Prerequisite | Satisfied by |
|---|---|---|
| planning | `project-brief` | brief text, an attachment, or a `business_brief` document |
| requirements | `planning-baseline` | `telos_report` document, an attachment, or requirements text |
| design | `requirements-baseline` | `requirements_spec` document |
| architecture | `design-baseline` | `design_spec` document |
| development | `requirements-approved`, `design-approved`, `architecture-approved`, `tech-stack` | those four document kinds |
| testing | `test-plan` | `test_plan` document, or the requirements spec |
| deployment | `testing-baseline` | `test_plan` document |
| maintenance | `deployment-baseline` | `deployment_plan` document |

Document kinds are a convention, not a constraint: uploads may use any kind, and a prerequisite looks only for the kinds it lists.

## 3. Readiness

```
GET /api/projects/:id/stages/:stage/readiness
```

```json
{ "projectId": "…", "stage": "planning", "ready": false,
  "prerequisites": [ { "key": "project-brief", "label": "Project brief", "satisfied": false,
                       "via": null, "accepts": [ { "kind": "brief", "label": "the business brief on a run" } ] } ],
  "missing": [ { "key": "project-brief", "label": "Project brief", "accepts": ["the business brief on a run", "an uploaded document"] } ] }
```

`via` is one of `brief`, `attachment`, `document`, `waiver`. The UI uses `missing` to tell the operator exactly what to supply.

The stage runtime calls the same evaluation before creating a run, passing the **incoming brief** (it is evidence even though no run row exists yet). Missing evidence is refused with `409 STAGE_PREREQUISITES_MISSING` listing what is needed — it is never silently started with an empty context.

## 4. Waivers

```
POST   /api/projects/:id/stages/:stage/waivers     { "key": "project-brief", "reason": "client brief is verbal" }
DELETE /api/projects/:id/stages/:stage/waivers/:key
```

Admin only. A waiver is stored in `project_stage_evidence` with the reason and timestamp, appears in readiness as `via: "waiver"`, and satisfies the requirement until removed. Waiving is deliberately visible: it is how an existing project enters mid-SDLC without pretending the evidence exists.

## 5. Catalogue API

```
GET /api/stages     → every stage, its label and prerequisites
```

Used by the UI to show what each stage expects before it is attempted.

## 6. What this does and does not enable

**Enables now:** entering a stage with imported evidence, refusing to start without it, and an explicit, attributable waiver. This is the schema half of "start from any middle stage".

**Not included:** stage runtimes for anything except planning; automatic **provenance** on documents (`authored` / `imported` / `reverse_engineered`); reverse engineering an existing codebase into documents; prerequisite editing through the API.

## 7. Tests

`test/stage-prerequisites.test.ts`: catalogue coverage and seeding, evaluation from each evidence kind, waiver behaviour, later stages rejecting unrelated documents, readiness from stored runs/documents/attachments, the endpoints (including admin-only waivers), and the runtime refusing to start until readiness or a waiver allows it.
