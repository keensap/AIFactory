# AI Factory — Detailed Requirements Specification

> **Superseded by [v2](AI-Factory-Requirements-v2.md).** This version is kept unchanged as a
> reference: it holds the original 609-requirement baseline and its diagrams. v2 carries the
> same identifiers with a delivery status on each, and adds a future-enhancements part.

**Autonomous, human-governed software delivery, from a one-paragraph idea to a monitored production service.**

| Field | Value |
|---|---|
| Document ID | AIF-SRD-001 |
| Version | 1.0 (Draft for review) |
| Status | Draft for stakeholder review; baseline pending approval |
| Date | 2026-11-09 |
| Owner | AI Factory Product & Platform |
| Audience | Product, architecture, engineering, QA, security, DevOps, procurement |
| Supersedes | Original one-page AI Factory brief |

**Change log**

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-11-08 | — | Initial outline from customer brief |
| 1.0 | 2026-11-09 | — | Full rewrite and expansion; 500+ numbered requirements; added gates, architecture, data, security, token and acceptance models |

---

## Executive summary

The AI Factory is a **control plane for autonomous software delivery**. It accepts a business brief and advances it through 26 lifecycle stages — from intake and requirements to design, estimation, proof of concept, implementation, review, testing, release, deployment, operations and change management — producing a versioned, reviewable artifact at every step and pausing at 19 defined human checkpoints.

Six design decisions shape the whole specification:

- **Governed autonomy.** Autonomy is a per-project policy (A0 manual to A4 post-hoc audit), not a binary. Production, security exceptions, destructive migrations and budget increases always require a human decision.
- **Replaceable intelligence.** DeepSeek Harness is the orchestration kernel, but every coder (Claude Code, opencode, Pi, Codex CLI, and others) and every model provider sits behind a contract, so nothing depends on a single vendor.
- **Evidence, not assertion.** The artifact graph, traceability links, review findings, test evidence and deployment records are the system of record; agent claims are accepted only with attached proof.
- **Frugal by design.** Budgets, context assembly, prompt caching, model cascades and diff-based review target a ≥ 40% token reduction against a naive baseline.
- **Boring infrastructure.** PostgreSQL, Redis, RabbitMQ, Qdrant and object storage have narrow, documented responsibilities and can all be replaced by managed equivalents.
- **One cockpit.** Reviews, alerts, costs, risks and traceability converge in a single inbox and dashboard, with approvals available through chat where policy allows.

The MVP (Phase 0 + Phase 1, roughly 18 weeks) covers intake through pull-request review, one external coder adapter, GitHub/GitLab, Jira and a working staging deployment at autonomy A2. Production deployment, full QA gates, Azure DevOps, communications monitoring and A3/A4 autonomy follow in Phases 2–4.

The largest risks are model cost overruns, prompt injection, reviewer fatigue and subscription-terms compliance; §19 records the mitigations, and §18 defines the acceptance scenarios that must pass before general availability.

---

## Table of contents

Executive summary
1. Introduction
2. Product definition
3. Operating model and lifecycle
4. Functional requirements by stage
5. Human-in-the-loop review model
6. Platform architecture
7. Agent runtime and coder adapters
8. Model gateway and provider strategy
9. Token and cost economy
10. Data architecture
11. Integrations
12. Security, privacy and compliance
13. Non-functional requirements
14. Configuration and modularity
15. API and event contract
16. Quality assurance framework
17. Delivery roadmap
18. Acceptance criteria
19. Risks and open questions
20. Glossary
Appendix A. Source coverage map
Appendix B. Review rubric
Appendix C. Configuration example

---

## 1. Introduction

### 1.1 Purpose

This document specifies the requirements for an **AI Factory**: a configurable, event-driven platform in which specialised AI agents execute every stage of the software development life cycle (SDLC) under explicit, policy-driven human oversight. It expands the original one-page brief into an implementable baseline that can be used directly for architecture, estimation, backlog creation, procurement and acceptance testing. Appendix A maps every item of the original brief to the section that elaborates it.

The document is deliberately implementation-agnostic where technology choice is not a requirement (for example, which front-end framework the Factory's own cockpit uses), and deliberately specific where interoperability and governance depend on it (for example, artifact provenance, gate semantics and adapter contracts).

### 1.2 Audience

| Audience | Primary use |
|---|---|
| Executive sponsor / product owner | Scope, outcomes, autonomy policy, budget model |
| Platform architect | Sections 3, 6–10, 14–15 |
| Agent / prompt engineer | Sections 4, 5, 7–9, 16 |
| Engineering and QA leads | Sections 4.12–4.18, 16, 18 |
| Security and compliance | Sections 11–13, 18 |
| DevOps / SRE | Sections 4.17–4.19, 6, 10, 13 |
| Procurement and legal | Sections 2.7, 8, 12, 19 |

### 1.3 Scope

**In scope.** The complete delivery lifecycle for greenfield and brownfield software products: intake, requirements, UX, specification, architecture, data design, planning, proof of concept, task decomposition, implementation, review, testing, release, deployment, operations, documentation, change management, and the governance, observability, cost control and integrations that make those activities auditable and repeatable.

**Out of scope for v1.** Detailed in §2.5.

### 1.4 Normative language

| Term | Meaning |
|---|---|
| **Shall / must** | Mandatory. A release that does not satisfy a `Must` requirement is not acceptable. |
| **Should** | Strong recommendation; deviation requires a recorded justification. |
| **May** | Permitted option. |
| **M** | Must — mandatory for the release in which the owning stage is delivered, and for general availability. |
| **S** | Should — targeted for general availability; may slip one increment with an approved plan. |
| **C** | Could — candidate for later phases. |

Requirements are testable statements, not aspirations. Where a numeric target is given, it is the default and is configurable within documented bounds.

Every requirement is verified by at least one of: the exit criteria of the stage that owns it, a quality gate in §16, an integration conformance test, or an acceptance scenario in §18. A requirement with no verification path is a defect in this specification.

### 1.5 Requirement identifiers

Identifiers are stable for the life of the product and are never reused or renumbered.

| Prefix | Domain |
|---|---|
| `FR-` | Functional requirement, grouped by lifecycle stage (hundreds block per stage) |
| `HR-` | Human review checkpoint (gate), its authority and SLA |
| `HX-` | Human review interaction, evidence and decision requirement |
| `QR-` | Quality gate and threshold requirement |
| `AR-` | Agent runtime, orchestration and adapter requirement |
| `MG-` | Model gateway and provider requirement |
| `TE-` | Token and cost economy requirement |
| `DR-` | Data architecture requirement |
| `IR-` | Integration requirement |
| `SR-` | Security, privacy and compliance requirement |
| `NFR-` | Non-functional requirement |
| `CR-` | Configuration and modularity requirement |
| `ACC-` | End-to-end acceptance scenario |

---

## 2. Product definition

### 2.1 Problem statement

Software delivery is slowed less by code generation than by the **coordination tax** between stages: requirements are reinterpreted, designs drift from implementation, reviews depend on scarce senior people, tests are written after the fact, release evidence is assembled manually, and decisions are buried in e-mail and chat. Point tools automate isolated steps; none of them own the continuity of intent, evidence and accountability across the whole lifecycle.

The AI Factory addresses this by making the **artifact graph and its review history the unit of work**, and by letting configurable agents advance that graph stage by stage, pausing at human checkpoints whose stringency is a policy decision rather than an accident.

### 2.2 Vision

> A team of five can operate like a team of fifty: state an outcome, approve the intent, and receive a secure, tested, documented, deployed and monitored product — with every decision traceable, every cost attributable, and every agent replaceable.

### 2.3 Product principles

1. **Human authority is explicit, never implied.** Every automated action has a policy that names who may approve it, what evidence is required, and what happens when no human responds.
2. **Everything is an artifact.** Requirements, decisions, prompts, test results, deployments and incidents are versioned, addressable and linked; chat is not a system of record.
3. **Everything is configurable.** Stages, gates, thresholds, agents, models, prompts, templates and integrations are declared in versioned configuration, not hard-coded.
4. **Model- and coder-agnostic.** DeepSeek Harness is the orchestration kernel, but no capability may depend on a single model vendor or a single coding agent.
5. **Token-frugal by design.** Context is assembled deliberately, cached aggressively, compressed progressively and budgeted per stage; cost is a first-class metric.
6. **Event-driven and resumable.** A run can be paused, resumed, replayed or forked after any step without losing work or duplicating side effects.
7. **Least privilege everywhere.** Agents receive the smallest tool set, repository scope, network path and credential that the current task requires.
8. **Evidence over assertion.** An agent's claim that a test passed, a requirement is met or a deployment succeeded is accepted only with machine-verifiable evidence attached.
9. **Replaceable parts.** Each stage, tool, model provider, coder and integration sits behind a contract with a conformance test suite.
10. **Boring operations.** The platform itself is observable, boring to run, and degrades gracefully when a model provider, queue or integration is unavailable.

### 2.4 Goals and success metrics

| ID | Goal | Target (default) | Measurement |
|---|---|---|---|
| KPI-01 | Autonomy ratio | ≥ 70% of stage transitions completed without human edit | Stage transition events vs. human-modified transitions |
| KPI-02 | Human touch time | ≤ 30 min per active project per working day | Reviewer session telemetry |
| KPI-03 | First-pass artifact acceptance | ≥ 75% of artifacts approved at first human review | Review decisions |
| KPI-04 | Lead time, small feature | ≤ 2 working days from approved task to production | Run timestamps |
| KPI-05 | Lead time, medium feature | ≤ 10 working days | Run timestamps |
| KPI-06 | Requirement-to-test traceability | 100% of approved requirements have ≥ 1 automated test | Traceability report |
| KPI-07 | Escaped defects | ≤ 1 per release, 0 Sev-1 | Incident records |
| KPI-08 | Deployment success rate | ≥ 98% of deployments require no rollback | Deployment records |
| KPI-09 | Mean time to restore | ≤ 30 minutes for Sev-1/Sev-2 | Incident records |
| KPI-10 | Token efficiency | ≥ 40% fewer tokens than a naive full-context baseline for the same artifact quality | Token ledger vs. benchmark |
| KPI-11 | Cost per story point | Within project budget; ≤ 15% variance at milestone | Cost ledger |
| KPI-12 | Reviewer trust | ≥ 4.0 / 5.0 quarterly | Reviewer survey |

Targets are calibrated after the first three production pilots and then reviewed quarterly.

### 2.5 Non-goals

- **NG-01** Replacing product accountability. The Factory does not decide *what* business to build; humans own outcomes and priorities.
- **NG-02** Being an IDE or a code editor. It integrates with existing IDEs and IDEs' agents rather than competing with them.
- **NG-03** Training or fine-tuning foundation models as a core capability. Optional project-level fine-tuning may be added later.
- **NG-04** General-purpose RPA or desktop automation outside software delivery.
- **NG-05** Unconditional production autonomy. Production changes remain policy-gated; full autonomy is opt-in, time-boxed and auditable.
- **NG-06** Legal certification. The Factory produces evidence for audits; it does not itself certify compliance.
- **NG-07** Owning the customer's cloud accounts. It deploys through least-privilege, revocable credentials.
- **NG-08** Replacing human incident command. It assists detection, diagnosis and rollback; humans remain accountable during incidents.

### 2.6 Assumptions

- **A-01** Customers can provide a Git host, a CI/CD system, an issue tracker and at least one cloud or on-prem target environment.
- **A-02** At least one human reviewer is available within the configured review SLA (default 1 business day) for each mandatory gate.
- **A-03** Model providers permit programmatic use under the customer's agreement; where subscription-backed access is used, it complies with the vendor's terms (§8.4).
- **A-04** Network egress from agent sandboxes can be restricted to an allowlist.
- **A-05** Source code, tickets and chat may contain personal or confidential data; classification and redaction are therefore baseline, not optional.
- **A-06** DeepSeek Harness remains available under its current licence and plugin model; incompatibilities are absorbed by the adapter layer.
- **A-07** Reviewers accept structured, evidence-backed reviews; the Factory is not optimized for "LGTM" culture.
- **A-08** Build and test infrastructure can create ephemeral environments (containers or namespaces) on demand.
- **A-09** The customer accepts that generated code requires the same IP, licence and security scrutiny as human-written code.
- **A-10** English is the default working language; the UI and artifacts are localisable.

### 2.7 Constraints

- **C-01** DeepSeek Harness is in developer preview and may introduce breaking changes; all DSH integrations must be pinned and covered by contract tests.
- **C-02** Third-party coder CLIs (Claude Code, opencode, Pi, Codex CLI, Gemini CLI, Aider) have their own licences, telemetry and authentication; adapters may not bypass them.
- **C-03** Model context windows, rate limits and prices change; routing must be data-driven and versioned.
- **C-04** Git hosts, Jira and Azure DevOps enforce API rate limits and webhook delivery guarantees that are at-most-once or retried; reconciliation is mandatory.
- **C-05** Sandboxed execution must run without privileged containers unless the customer explicitly enables a privileged runner pool.
- **C-06** Data residency requirements may forbid sending certain artifacts to specific providers or regions.
- **C-07** Human review capacity is the binding constraint at peak; the system must batch, prioritise and summarise reviews.
- **C-08** The Factory must operate in a single-tenant on-premise mode with no outbound internet except allowlisted model endpoints.

---

## 3. Operating model and lifecycle

### 3.1 Core concepts

| Concept | Definition |
|---|---|
| **Tenant** | An isolated customer organisation with its own identities, policies, data and billing. |
| **Portfolio** | A group of projects sharing budget, standards and reporting. |
| **Project** | A product or service with one repository set, one backlog, one roadmap and one autonomy policy. |
| **Run** | One end-to-end execution of the lifecycle for a project or change, from intake to the configured terminal stage. A run is event-sourced and resumable. |
| **Stage** | A typed lifecycle step (`S01`–`S26`) implementing the Stage Contract (§6.5). |
| **Work item** | The smallest unit a stage operates on: a requirement, a document, a task, a PR, a test suite, a deployment. |
| **Attempt** | One execution of a stage or task by one agent using one model configuration. Attempts are immutable records. |
| **Artifact** | A versioned output (document, diagram, schema, code commit, test report, deployment record) with schema, provenance and status. |
| **Gate** | A policy checkpoint that must be passed before the run may advance. Gates are automated, human or mixed. |
| **Review** | A structured evaluation of an artifact against a rubric, producing findings, a rating and a decision. |
| **Finding** | An atomic, severity-classified observation (`blocker`, `critical`, `major`, `minor`, `info`) with location and remediation guidance. |
| **Policy** | A declarative rule set governing autonomy, approvals, security, data handling and budgets. |
| **Blueprint** | A reusable, versioned template for a stage or project type (for example "regulated fintech web app"). |
| **Adapter** | A contract implementation for a coder, model provider, Git host, tracker, CI system or messaging platform. |
| **Agent role** | A named responsibility (Business Analyst, Architect, Reviewer, Coder, QA Engineer) with a prompt, tool set, model policy and output schema. |
| **Budget** | A hard or soft limit on tokens, money, wall-clock time or human review minutes for a run, stage or project. |

### 3.2 Lifecycle overview

```mermaid
flowchart LR
  S01[S01 Intake] --> S02[S02 Requirements]
  S02 --> S03[S03 Wireframes]
  S03 --> S04[S04 UI Prototype]
  S04 --> S05[S05 Functional Spec]
  S05 --> S06[S06 Architecture & Stack]
  S06 --> S07[S07 Data Design]
  S07 --> S08[S08 Roadmap & Estimate]
  S08 --> S10[S10 POC Plan]
  S10 --> S11[S11 POC Build & Demo]
  S11 --> S12[S12 Task Plan]
  S12 --> S13[S13 Development]
  S13 --> S14[S14 PR Review]
  S14 --> S15[S15 Unit Test]
  S15 --> S16[S16 UI Test]
  S16 --> S17[S17 Integration & E2E]
  S17 --> S18[S18 QA Gate]
  S18 --> S19[S19 Milestone]
  S19 --> S20[S20 CI/CD]
  S20 --> S21[S21 Deployment]
  S21 --> S22[S22 Operations]
  S22 --> S23[S23 Ticket Monitoring]
  S22 --> S24[S24 Comms Monitoring]
  S23 --> S26[S26 Change Requests]
  S24 --> S26
  S26 --> S02
```

`S09` (Document Review, Rating & Rejection) is a **cross-cutting service**, not a sequential stage: it is invoked by every gate that evaluates an artifact. `S25` (Documentation & Help) runs continuously from `S05` onward and has its own release gate.

### 3.3 Stage catalog

| ID | Stage | Human accountable role | Executing agents | Primary artifacts | Gate / checkpoint |
|---|---|---|---|---|---|
| S01 | Intake & project creation | Product Owner | Orchestrator, Business Analyst | Project charter, workspace, budget | HR-01 |
| S02 | Requirements elicitation & analysis | Business Analyst | BA, domain researcher, interview facilitator | BRD, use cases, NFR catalogue, glossary, risk log | HR-02a |
| S03 | Wireframing | UX Lead | UX agent, information architect | Flow maps, wireframes, content inventory | HR-03a |
| S04 | Interactive UI prototype | UX Lead | UI prototyper, front-end agent | Clickable prototype, design tokens, usability report | HR-03b |
| S05 | Functional specification | Business Analyst | Specification agent, test designer | SRS, acceptance criteria, RTM baseline | HR-02b |
| S06 | Architecture & tech stack | Architect | Architect, security architect, cost analyst | HLD, component model, ADRs, stack decision record | HR-04 |
| S07 | Data & database design | Data Architect | Data modeller, DBA, privacy agent | ERD, DDL, migration plan, data classification | HR-05 (R3/R4, personal data) |
| S08 | Roadmap & estimation | Delivery Lead | Planner, estimator, finance analyst | Roadmap, WBS, estimates, budget, risk reserve | HR-06 |
| S09 | Document review, rating & rejection | Review Board | Risk-scaled review panel, adjudicator | Review reports, ratings, decision records | Applied at every gate |
| S10 | POC planning | Architect | POC planner, risk analyst | POC plan, hypotheses, success criteria, timebox | HR-07 (plan) |
| S11 | POC build & demo | Architect | Coder adapters, demo agent | POC build, demo script, evaluation report | HR-07 (go/no-go) |
| S12 | Task decomposition & sprint planning | Delivery Lead | Planner, dependency analyst | Task DAG, sprint plan, assignments, capacity model | HR-08 (A2 and below; A3+ R2+) |
| S13 | Code development | Tech Lead | Coder adapters, test author, docs agent | Commits, PRs, unit tests, docs, changelog | Pre-PR checks |
| S14 | PR review | Tech Lead | Review agents, security agent, human reviewer | Review record, approvals, merge evidence | HR-09 (risk-based) |
| S15 | Unit testing | QA Lead | Test agent, coverage analyst | Unit suites, coverage and mutation reports | QR automated |
| S16 | UI testing | QA Lead | Browser agent, accessibility agent | E2E/UI suites, visual diffs, a11y report | QR automated |
| S17 | Integration & E2E testing | QA Lead | Test agent, performance agent, security scanner | Integration/contract/perf/security reports | QR automated |
| S18 | QA threshold & release readiness | QA Lead | QA analyst, release manager | Readiness report, waiver log, residual risk | HR-10 |
| S19 | Milestone completion | Delivery Lead | Orchestrator, docs agent | DoD evidence pack, release notes, sign-off | HR-11 |
| S20 | CI/CD pipeline authoring | DevOps Lead | DevOps agent, security agent | Pipeline-as-code, IaC, policy checks, SBOM config | HR-04 (pipeline design) |
| S21 | Deployment | Release Manager | Release agent, SRE agent | Deployment record, smoke tests, rollback proof | HR-12 |
| S22 | Post-release operations | SRE Lead | Monitoring agent, incident agent | SLO dashboard, incident records, feedback digest | HR-14 (incidents) |
| S23 | Ticket & backlog monitoring | Project Manager | Triage agent | Triage queue, SLA alerts, status updates | Exception-based |
| S24 | Communications monitoring | Project Manager | Comms agent | Linked threads, alerts, draft responses | Exception-based |
| S25 | Documentation & help | Technical Writer | Docs agent, API doc generator | User guide, API reference, help centre, runbooks | HR-13 |
| S26 | Change request handling | Change Board | Impact analyst, planner, coder | Impact analysis, decision record, rebaselined plan | HR-15 |

### 3.4 Autonomy levels

Autonomy is set per project and may be overridden per stage by policy. The policy engine computes the **effective autonomy** for each gate as the minimum of the project level, the stage cap, and the risk-tier cap.

| Level | Name | Behaviour | Default use |
|---|---|---|---|
| A0 | Manual | Humans perform the work; the Factory assists only when asked. | Regulated legacy systems, first migration |
| A1 | Assisted | Agents draft every artifact; a human performs or edits each one before it advances. | New customers, unfamiliar domains |
| A2 | Supervised | Agents execute stages end-to-end; a human approves every gate. | **Default** |
| A3 | Guardrailed | Gates auto-pass when the risk score is below threshold, all automated checks pass, and no policy trigger fires; humans sample 20% and are notified of every auto-approval. | Mature projects with ≥ 10 successful runs |
| A4 | Autonomous | End-to-end execution with post-hoc audit; only hard-stop gates (production, security exceptions, destructive data changes, personal-data changes, legal, budget increases) block. | Internal tools, well-understood domains, explicit opt-in |

**Non-negotiable constraints.** Even at A4: production deployment, security exceptions, destructive database migrations, personal-data processing changes and budget increases above 20% always require a human decision. Separation of duties applies at every level: the author of an artifact may not be its sole approver.

**Risk tiers.** R1 is low risk (internal, non-sensitive, reversible); R2 is moderate (customer-facing, limited data); R3 is high (personal data, payments or regulated processes); R4 is critical (safety, large blast radius or regulated core systems). The tier is computed at intake and may be raised by any reviewer without approval; lowering it requires the Platform Owner and Security Officer.

### 3.5 Run lifecycle and state machine

```mermaid
stateDiagram-v2
  [*] --> Queued
  Queued --> Running: capacity available
  Running --> AwaitingHuman: gate requires decision
  Running --> Revising: automated review fails
  Revising --> Running: revision submitted
  AwaitingHuman --> Running: approved
  AwaitingHuman --> Revising: changes requested
  AwaitingHuman --> Cancelled: rejected / withdrawn
  Running --> Blocked: missing dependency, credential or answer
  Blocked --> Running: unblocked
  Running --> Failed: unrecoverable error or budget exhausted
  Failed --> Running: retried with new attempt
  Running --> Completed: terminal stage reached
  Completed --> [*]
```

**AR-01 (M).** A run shall persist a checkpoint after every agent step, tool call and gate decision, such that a process restart loses at most the in-flight step.

**AR-02 (M).** Every externally visible side effect (commit, PR, ticket update, deployment, e-mail) shall carry an idempotency key derived from `run_id + stage + work_item + attempt`, and repeated delivery shall not duplicate the effect.

**AR-03 (M).** A run shall be resumable, forkable (branching from any checkpoint for what-if execution) and replayable in dry-run mode without side effects.

### 3.6 Artifact model

Every artifact has: a stable ID, a type from the artifact registry, a semantic version, a content hash, a schema version, a storage URI, provenance (agent role, agent version, model, prompt version, input artifact IDs, tool trace), status (`draft`, `in_review`, `approved`, `rejected`, `superseded`, `archived`), classification (public/internal/confidential/restricted), retention class, and a rendered human-readable representation alongside the machine-readable source.

**AR-04 (M).** Artifacts shall be immutable once approved; a change creates a new version with a `supersedes` link and a diff against the prior version.

**AR-05 (M).** Every artifact shall declare the JSON Schema (or equivalent) it conforms to, and the Factory shall validate it before the artifact enters review.

**AR-06 (M).** Artifact provenance shall be sufficient to reconstruct the exact prompt, context manifest, model and tool calls that produced it, subject to redaction policy.

### 3.7 Traceability

The Factory maintains a directed traceability graph with at least these edge types: `derives_from`, `satisfies`, `implements`, `tests`, `documents`, `deploys`, `causes`, `mitigates`, `supersedes`.

**AR-07 (M).** The system shall produce, on demand, an end-to-end trace from any business goal to the requirement, acceptance criterion, design element, task, commit, test, build, deployment and incident that relate to it.

**AR-08 (M).** The system shall detect and report orphaned artifacts (for example a requirement with no test, a commit with no task, or a test with no requirement) as a quality finding.

**AR-09 (S).** The system shall support impact queries ("what is affected if this requirement changes?") returning the transitive closure over the traceability graph with confidence levels.

## 4. Functional requirements by stage

Each stage implements the Stage Contract (§6.5) and declares its inputs, output schemas, tools, entry criteria, exit criteria, budgets and gate. The tables below state what the stage must do; the bullet list after each table states what must be true before the run may advance.

### 4.1 Project intake and creation (S01)

The Factory must turn a brief — however incomplete — into a governed project with an approved charter, a provisioned workspace, working integrations and a budget.

| ID | Requirement | Pri. |
|---|---|---|
| FR-101 | The system shall accept intake through the web cockpit, REST API, CLI, inbound e-mail, and import from a Jira epic or Azure DevOps work item, capturing the business goal, stakeholders, constraints, target date, budget band, compliance profile and desired autonomy level. | M |
| FR-102 | The system shall generate a Project Charter containing problem statement, goals and non-goals, success metrics, scope, assumptions, dependencies, initial risks, stakeholder RACI and a summary of what the Factory will and will not do. | M |
| FR-103 | The system shall ask at most ten ranked clarifying questions, each with a proposed default and the reason it matters, and shall record unanswered questions as explicit assumptions rather than silently inventing answers. | M |
| FR-104 | The system shall recommend one or more project blueprints (for example "regulated web application", "internal data tool", "mobile API") and shall show the stages, gates, thresholds and artifacts that differ from the default. | S |
| FR-105 | The system shall compute an initial risk tier (R1 low to R4 critical) from data sensitivity, regulatory exposure, blast radius, novelty and delivery pressure, and shall use that tier to cap autonomy and select review depth. | M |
| FR-106 | The system shall provision, within 10 minutes: repositories, branch protection rules, environment definitions, a CI skeleton, tracker project and fields, a collaboration space, secret references, a project dashboard, a budget and an audit stream. | M |
| FR-107 | The system shall verify every bound integration with a read-only health check and one write to a sandbox object, and shall block the run if a mandatory integration fails. | M |
| FR-108 | The system shall require a budget (tokens, currency, wall-clock, human review minutes) and an autonomy level before the first gate, and shall refuse to start a run whose estimated cost exceeds the remaining budget. | M |
| FR-109 | The system shall assign named humans to the accountable roles in §3.3, enforce that no role is vacant for a mandatory gate, and support delegation with an expiry. | M |
| FR-110 | The system shall detect potential duplicate projects and existing components that could be reused, and shall require a disposition (proceed, merge, reuse) before provisioning. | S |
| FR-111 | The system shall publish a kickoff pack (charter, plan, gate calendar, contact matrix, escalation path) to the project dashboard and to the configured chat space. | S |

**Gate HR-01 — charter approval.** Exit criteria: charter approved by the Product Owner and one engineering representative; all mandatory roles staffed; risk tier confirmed; budget and autonomy approved; integrations green; no open blocker question without a recorded assumption.

### 4.2 Requirements elicitation and analysis (S02)

| ID | Requirement | Pri. |
|---|---|---|
| FR-201 | The system shall ingest source material (brief, transcripts, existing documentation, tickets, e-mails, competitor notes, regulatory extracts) and record each source with provenance, date and classification. | M |
| FR-202 | The system shall conduct structured elicitation — written questionnaires, scheduled interviews with a generated guide, or asynchronous review — and shall produce a transcript and a decision log for each session. | S |
| FR-203 | The system shall express every functional requirement as a uniquely identified, atomic, testable statement with actor, trigger, behaviour, inputs, outputs, error cases and priority. | M |
| FR-204 | The system shall maintain a non-functional requirements catalogue covering performance, scalability, availability, security, privacy, accessibility, localisation, observability, maintainability, portability and compliance, each with a measurable target and verification method. | M |
| FR-205 | The system shall model personas, goals, journeys and pain points, and shall link each journey step to the requirements that support it. | S |
| FR-206 | The system shall capture business rules, decision tables, calculation formulas and state transitions separately from narrative text so they can be tested directly. | M |
| FR-207 | The system shall maintain a domain glossary and conceptual domain model, and shall flag terms used inconsistently across sources. | M |
| FR-208 | The system shall maintain a register of assumptions, constraints, dependencies and open questions, each with an owner, impact if wrong and resolution date. | M |
| FR-209 | The system shall detect ambiguity, contradiction, duplication, missing acceptance criteria and untestable wording, and shall score requirement quality against a defined rubric (ISO/IEC/IEEE 29148 characteristics). | M |
| FR-210 | The system shall support prioritisation by MoSCoW and weighted shortest job first (WSJF), and shall make the resulting trade-offs visible to the Product Owner. | S |
| FR-211 | The system shall define explicit scope boundaries — in scope, out of scope, deferred — and shall reject a requirement that falls outside them without a change request. | M |
| FR-212 | The system shall link every requirement upward to a goal and downward to at least one acceptance criterion, and shall report coverage as a percentage. | M |
| FR-213 | The system shall run a completeness pass against the selected blueprint's requirement checklist and list gaps with severity. | S |
| FR-214 | The system shall baseline approved requirements as version 1.0 and route all later changes through change control (§4.22). | M |

**Gate HR-02a — requirements baseline.** Exit criteria: 100% of `Must` requirements have acceptance criteria; every NFR has a measurable target and verification method; zero unresolved blocker contradictions; ambiguity score above threshold; Product Owner and Business Analyst approve; traceability coverage to goals is 100%.

### 4.3 Wireframing (S03)

| ID | Requirement | Pri. |
|---|---|---|
| FR-301 | The system shall produce an information architecture (sitemap, navigation model, content hierarchy) derived from journeys and requirements. | M |
| FR-302 | The system shall produce user flows for every primary journey, including error, empty, loading, permission-denied and recovery paths. | M |
| FR-303 | The system shall produce low-fidelity wireframes for every in-scope screen, annotated with purpose, required data, primary action, validation and linked requirements. | M |
| FR-304 | The system shall define responsive behaviour at agreed breakpoints and shall state what collapses, hides, reorders or becomes a separate view. | S |
| FR-305 | The system shall annotate accessibility intent — heading order, focus order, labels, error announcement, target size, contrast — for each screen. | M |
| FR-306 | The system shall map wireframe components to an existing design system where one exists, and shall list new components with justification. | S |
| FR-307 | The system shall record open UX questions and decisions with rationale, and shall not silently resolve a product decision inside a wireframe. | M |
| FR-308 | The system shall render wireframes as a navigable, click-through artefact reviewable in the cockpit without a separate design tool. | M |

**Gate HR-03a — UX direction.** Exit criteria: every MVP journey has a flow; every in-scope screen has a wireframe; accessibility annotations present; open UX questions listed with owners; UX Lead and Product Owner approve.

### 4.4 Interactive UI prototype (S04)

| ID | Requirement | Pri. |
|---|---|---|
| FR-401 | The system shall generate a runnable, clickable prototype from approved wireframes, using project design tokens and realistic content, and shall publish it at a stable preview URL. | M |
| FR-402 | The prototype shall implement navigation, form validation, loading, empty, error and success states, and at least the primary interaction on every screen. | M |
| FR-403 | The prototype shall include a component and token inventory (colour, type, spacing, radius, motion) that the implementation stage must consume rather than reinvent. | S |
| FR-404 | The system shall generate a usability test script covering the top five journeys, with task success criteria and observation prompts. | S |
| FR-405 | The system shall run heuristic evaluation and automated accessibility checks (WCAG 2.2 AA rules) against the prototype and report violations with severity. | M |
| FR-406 | The system shall map each prototype screen and interaction back to requirements and acceptance criteria, and shall flag prototype behaviour that has no requirement. | M |
| FR-407 | The system shall enforce a prototype performance budget (for example initial load under 2.5 s on a defined reference connection) and report measured results. | C |
| FR-408 | The system shall produce a handoff package containing the prototype source, tokens, assets, annotations, and a recorded walkthrough. | M |
| FR-409 | The system shall capture stakeholder feedback per screen as structured comments with disposition (accept, defer, reject, change request). | S |

**Gate HR-03b — prototype acceptance.** Exit criteria: five key journeys completable without assistance by the acceptance panel; no open critical accessibility violation; design tokens frozen; feedback dispositions recorded; UX Lead and Product Owner approve.

### 4.5 Functional specification (S05)

| ID | Requirement | Pri. |
|---|---|---|
| FR-501 | The system shall produce a Software Requirements Specification aligned to ISO/IEC/IEEE 29148, covering purpose, scope, actors, functional behaviour, interfaces, data, NFRs, constraints and acceptance criteria. | M |
| FR-502 | The system shall express each feature as one or more user stories or use cases with Given/When/Then acceptance criteria that are directly executable as acceptance tests. | M |
| FR-503 | The specification shall define external interface behaviour (APIs, events, imports/exports, third-party callbacks) at the functional level, including error semantics and idempotency expectations. | M |
| FR-504 | The specification shall include a permissions matrix (role × action × resource) and state machines for every entity with a non-trivial lifecycle. | M |
| FR-505 | The specification shall include an error and exception catalogue with user-visible messages, recovery guidance and support codes. | S |
| FR-506 | The specification shall define data lifecycle at the functional level: creation, retention, archival, export and deletion, including personal data. | M |
| FR-507 | The specification shall define localisation, accessibility, time-zone and numeric-format requirements. | S |
| FR-508 | The system shall maintain a requirements traceability matrix linking goals, requirements, acceptance criteria, wireframes, prototype screens and planned tests. | M |
| FR-509 | The system shall run a consistency review across charter, BRD, wireframes, prototype and specification, and shall report every divergence with a recommended resolution. | M |
| FR-510 | The system shall freeze a specification baseline, issue a diff against the prior baseline on change, and prevent implementation of unbaselined `Must` requirements. | M |

**Gate HR-02b — specification baseline.** Exit criteria: review rating passes Appendix B; no contradiction across upstream artifacts; every `Must` requirement has executable acceptance criteria; RTM complete; Business Analyst, Architect and QA Lead approve.

### 4.6 Architecture and technology stack (S06)

| ID | Requirement | Pri. |
|---|---|---|
| FR-601 | The system shall produce C4 context and container diagrams, and component diagrams for each container with non-trivial internal structure. | M |
| FR-602 | The system shall define component responsibilities, boundaries, owned data, synchronous and asynchronous interfaces, and failure behaviour. | M |
| FR-603 | The system shall define API style and conventions (REST/GraphQL/gRPC/events), versioning, pagination, error model, idempotency and authentication. | M |
| FR-604 | The system shall record an Architecture Decision Record for every significant decision, including context, options considered, decision, consequences and reversal cost. | M |
| FR-605 | The system shall evaluate candidate technologies on fit, maturity, licence, total cost, team familiarity, security posture, ecosystem, vendor lock-in and exit cost, and shall publish a weighted comparison. | M |
| FR-606 | The system shall pin exact versions and support dates for every selected runtime, framework, database and critical library, and shall flag components nearing end of support. | M |
| FR-607 | The architecture shall demonstrate how each NFR target is met, with a calculation, prototype result or accepted risk. | M |
| FR-608 | The system shall produce a threat model (STRIDE or equivalent), a data-flow diagram with trust boundaries, and a control mapping to the selected compliance profile. | M |
| FR-609 | The system shall define deployment topology per environment, network segmentation, scaling model and disaster-recovery approach (RPO/RTO). | M |
| FR-610 | The system shall define the observability design: logs, metrics, traces, SLOs, alert thresholds, dashboards and runbook hooks. | M |
| FR-611 | The system shall estimate run-rate infrastructure cost at expected and peak load, and shall identify the top three cost drivers. | S |
| FR-612 | The system shall record a build-versus-buy decision for each significant capability, including licence and maintenance implications. | S |
| FR-613 | The architecture shall define fitness functions (for example dependency rules, latency budgets, module boundaries) that CI can verify automatically. | S |
| FR-614 | The system shall present architecture alternatives with trade-offs when the risk tier is R3 or above, and shall require the Architecture Review Board to select one. | M |

**Gate HR-04 — architecture and stack approval.** Exit criteria: context, container and component views approved; ADRs complete; NFR traceability complete; threat model reviewed by security; cost model accepted; no unresolved blocker risk; Architect, Security and Engineering Lead approve.

### 4.7 Data and database design (S07)

| ID | Requirement | Pri. |
|---|---|---|
| FR-701 | The system shall produce conceptual, logical and physical data models, including entities, relationships, cardinality, keys, constraints and ownership. | M |
| FR-702 | The system shall generate DDL and versioned, reversible migrations using an expand/contract pattern for zero-downtime changes. | M |
| FR-703 | The design shall define indexing, partitioning, archival and retention strategy justified by expected volume and query patterns. | M |
| FR-704 | The system shall classify every field by sensitivity and produce a personal-data map (category, purpose, lawful basis, retention, recipients, cross-border transfer). | M |
| FR-705 | The design shall implement data minimisation, purpose limitation, deletion and export requirements, and shall document how they are tested. | M |
| FR-706 | The system shall provide synthetic or masked seed data that preserves referential integrity and realistic distributions, and shall never seed production with live personal data. | M |
| FR-707 | The system shall define backup, restore and point-in-time recovery procedures, and shall verify them by a scheduled restore test. | M |
| FR-708 | The system shall define data-quality rules (uniqueness, referential integrity, freshness, completeness) and where they are enforced. | S |
| FR-709 | The system shall record data lineage from source to consumption for every derived dataset. | S |
| FR-710 | The system shall produce a data-layer performance test plan covering expected volume, peak volume and growth over 24 months. | S |

**Gate HR-05 — data design approval.** Exit criteria: models and migrations reviewed by a DBA; PII map complete; retention and deletion approved by privacy owner; restore test scheduled; migration rollback rehearsed on a copy; Data Architect and Security approve. Mandatory human gate for R3/R4 projects.

### 4.8 Roadmap and estimation (S08)

| ID | Requirement | Pri. |
|---|---|---|
| FR-801 | The system shall produce a milestone-based roadmap with releases, outcomes, entry/exit criteria and dependencies. | M |
| FR-802 | The system shall decompose the roadmap into epics and features traceable to requirements, and shall flag requirements not scheduled in any release. | M |
| FR-803 | The system shall produce a dependency graph and critical path, and shall identify the five highest schedule risks with mitigation. | M |
| FR-804 | The system shall estimate each epic and feature using three-point (PERT) estimation with optimistic, likely and pessimistic values, and shall publish a confidence interval rather than a single number. | M |
| FR-805 | The system shall estimate token, model, infrastructure and human-review cost per milestone, and shall reconcile the total against the project budget. | M |
| FR-806 | The system shall produce a capacity plan by role and agent concurrency, including review capacity and environment capacity. | S |
| FR-807 | The plan shall include contingency (default 20% for R1–R2, 30% for R3–R4) and shall state the trigger for consuming it. | M |
| FR-808 | The system shall maintain an assumptions register with validation dates, and shall re-estimate when a validation fails. | M |
| FR-809 | The system shall re-estimate on any of: scope change above 10%, two consecutive sprint overruns above 20%, a dependency slip, or a material model/provider change. | M |
| FR-810 | The system shall present at least three scenarios (scope-led, date-led, cost-led) with their consequences, for human selection. | S |
| FR-811 | The system shall roll up roadmap, cost and risk across the portfolio with drill-down to project level. | S |
| FR-812 | The system shall calibrate future estimates against actuals from completed tasks and publish estimate accuracy (MMRE, bias). | S |

**Gate HR-06 — plan and budget approval.** Exit criteria: roadmap and dependency graph approved; estimates carry confidence intervals; cost reconciled to budget with reserve; capacity plan accepted; scenarios reviewed; Delivery Lead, Product Owner and Finance approve.

### 4.9 Document review, rating and rejection loop (S09)

This is a platform service invoked by every gate. It applies uniformly to documents, designs, code diffs, test plans and deployment plans.

| ID | Requirement | Pri. |
|---|---|---|
| FR-901 | The system shall run automated pre-review before any human sees an artifact: schema validation, link resolution, completeness checklist, consistency checks and deterministic linting. | M |
| FR-902 | The system shall convene a risk-scaled panel of independent judges — one for low-risk artifacts, two for medium, three for high — using different models or materially different prompts where more than one judge is used, plus deterministic tools where available. | M |
| FR-903 | The system shall score each artifact against the rubric in Appendix B on a 1–5 anchored scale per dimension, with written justification and evidence references for every score. | M |
| FR-904 | The system shall compute a weighted score and apply the configured pass rule: weighted score ≥ 4.0, no dimension below 3.0, and zero open blocker findings. | M |
| FR-905 | The system shall merge duplicate findings, preserve dissenting opinions, and classify each finding by severity, location, evidence and remediation. | M |
| FR-906 | The system shall present to the human reviewer: the artifact rendered, the prior version diff, the rubric scores, the findings, the evidence, the agent's self-assessment and the decision controls. | M |
| FR-907 | The system shall capture decisions as `approve`, `approve_with_comments`, `request_changes`, `reject`, `delegate`, `waive` or `escalate`, each with structured reason codes and mandatory comments where the decision is negative. | M |
| FR-908 | The system shall run a bounded revision loop: agent revises, panel re-reviews only the changed sections plus their dependencies, and the loop stops at approval, rejection, escalation, or the configured maximum (default three cycles). | M |
| FR-909 | The system shall detect non-convergence (semantic diff below a threshold between cycles, repeated findings, or decreasing score) and shall escalate to a human instead of spending further budget. | M |
| FR-910 | The system shall record every rating with judge identity, model version, prompt version, rubric version and timestamp, and shall retain rejected versions for audit. | M |
| FR-911 | The system shall allow a human to override a panel decision only with a recorded justification and, for `Must` gates, a second approver. | M |
| FR-912 | The system shall enforce review SLAs (default: 4 business hours for R1–R2, 1 business day for R3–R4) and shall remind, delegate or escalate on breach according to policy. | M |
| FR-913 | The system shall assign reviewers by required expertise, current load and independence (author, author's manager and the producing agent's operator are ineligible). | M |
| FR-914 | The system shall produce an immutable audit record of who (human or agent) saw what, when, and decided what. | M |
| FR-915 | The system shall periodically sample auto-approved artifacts for human calibration and shall report panel–human agreement (Cohen's kappa) per artifact type. | S |
| FR-916 | The system shall feed rejected findings into a versioned evaluation dataset used to regression-test prompts before rollout. | S |

**Loop semantics.**

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> AutoReview: submitted
  AutoReview --> Revision: score below pass rule
  AutoReview --> HumanReview: pass rule met
  Revision --> AutoReview: revised (cycle ≤ max)
  Revision --> Escalated: cycles exhausted or no progress
  HumanReview --> Revision: request_changes
  HumanReview --> Approved: approve
  HumanReview --> Rejected: reject
  HumanReview --> Escalated: escalate
  Escalated --> HumanReview: senior decision
  Approved --> [*]
  Rejected --> [*]
```

**Rules.** A rejection is terminal for that artifact version but never for the project; the next attempt starts from the last approved baseline plus the rejection rationale. `waive` requires an expiry date and a compensating control. Every loop iteration increments the artifact's review cost, which is charged to the stage budget and visible on the dashboard.

### 4.10 Proof of concept — planning and demo (S10–S11)

| ID | Requirement | Pri. |
|---|---|---|
| FR-1001 | The system shall produce a POC plan stating the hypothesis, the risk it retires, the minimum scope, the timebox (default 1–5 working days), the environment, the success criteria and the stop criteria. | M |
| FR-1002 | The POC shall run in an isolated repository or branch namespace, clearly marked as non-production code, and shall not be merged without a separate review and hardening task. | M |
| FR-1003 | The system shall build the smallest vertical slice that tests the hypothesis, not a reduced version of the whole product. | M |
| FR-1004 | The system shall instrument the POC to measure the criteria (latency, cost, accuracy, integration feasibility, developer effort) and shall record raw results. | M |
| FR-1005 | The system shall produce a demo script, a recorded walkthrough, and a reproducible setup (container or script) so the demo can be re-run. | M |
| FR-1006 | The system shall evaluate results against the success criteria and produce a decision record: `go`, `go_with_changes`, `iterate` or `stop`, with rationale. | M |
| FR-1007 | The system shall record lessons learned and identify which POC artifacts can be salvaged, hardened or must be discarded. | S |
| FR-1008 | The system shall track POC token, infrastructure and human cost against its timebox, and shall stop automatically at 120% of the approved budget. | M |
| FR-1009 | The system shall clean up POC environments and credentials on `stop` or after the decision record is approved, retaining only documented evidence. | S |

**Gate HR-07 — POC go/no-go.** The plan is approved as the first HR-07 decision before build starts. Exit criteria for the second decision: demo executed against the script; measurements recorded; criteria evaluated; decision record signed by Architect and Product Owner; salvage list agreed.

### 4.11 Task decomposition and planning (S12)

| ID | Requirement | Pri. |
|---|---|---|
| FR-1101 | The system shall decompose approved features into tasks sized at ≤ 1 agent-day (default 6 working hours) and shall split any larger task automatically. | M |
| FR-1102 | Every task shall have a contract: objective, inputs, outputs, definition of done, acceptance tests, write scope (files/directories), dependencies, risk notes and rollback expectation. | M |
| FR-1103 | The system shall build a task dependency DAG, compute the critical path, and propose a parallel execution plan that respects dependencies and write scopes. | M |
| FR-1104 | The system shall assign non-overlapping write scopes for tasks intended to run in parallel, and shall serialise tasks whose scopes overlap or whose changes are semantically coupled. | M |
| FR-1105 | The system shall assign each task an agent role, a model tier, a coder adapter and a budget, and shall justify any assignment above the default tier. | M |
| FR-1106 | The system shall produce a sprint or wave plan with capacity by agent concurrency and human review slots, and shall not plan beyond verified review capacity. | M |
| FR-1107 | The system shall enforce a Definition of Ready before a task may start: dependencies done, acceptance tests defined, design references present, environment available. | M |
| FR-1108 | The system shall link every task to at least one requirement and one acceptance criterion, and shall reject orphan tasks. | M |
| FR-1109 | The system shall re-plan automatically when a task is blocked, splits, or exceeds its estimate by 50%, and shall surface the schedule impact. | S |
| FR-1110 | The system shall compare estimated versus actual effort per task and feed the error back into estimation calibration. | S |

**Gate HR-08 — plan approval.** Exit criteria: task DAG complete; every task has a contract and traceability; write scopes do not conflict; capacity verified; plan approved by Delivery Lead and Tech Lead (skippable at autonomy A3+ when risk is R1 and the plan is within budget).

### 4.12 Code development (S13)

| ID | Requirement | Pri. |
|---|---|---|
| FR-1201 | Each task shall execute in an isolated Git worktree or clone on a dedicated branch named `aif/<ticket>-<slug>`, with no shared mutable workspace between concurrent tasks. | M |
| FR-1202 | The system shall assemble the coding context from the task contract, linked requirements and acceptance criteria, relevant design artifacts, a repository map, symbol-level retrieval and prior review findings — not from the whole repository. | M |
| FR-1203 | The system shall require tests to be written or updated with the change, and shall fail the task if changed-line coverage is below the configured threshold. | M |
| FR-1204 | The system shall run formatting, linting, type checking, static analysis and secret scanning before a pull request is opened, and shall auto-fix only deterministic, low-risk findings. | M |
| FR-1205 | The system shall enforce a dependency policy: new dependencies require a recorded justification, licence check, vulnerability check and maintainer-health check. | M |
| FR-1206 | The system shall prevent commits containing secrets, private keys, tokens or prohibited personal data, and shall block the push rather than warn. | M |
| FR-1207 | Commits shall follow Conventional Commits and include machine-readable traceability trailers (`Requirement:`, `Task:`, `Run:`). | M |
| FR-1208 | The agent shall commit incrementally at coherent checkpoints and shall be able to resume from the last commit after a failure without repeating completed work. | M |
| FR-1209 | Before opening a PR the agent shall perform a self-review against the task contract and post the self-review summary in the PR description. | M |
| FR-1210 | The agent shall update affected documentation, changelog fragments and API specifications in the same PR as the code change. | M |
| FR-1211 | The agent shall not make changes outside the task's declared write scope; a required out-of-scope change shall produce a new task or a change request, not a silent edit. | M |
| FR-1212 | Generated code and generated assets shall be marked as generated, with the generator and version recorded, so reviewers and future agents can distinguish them. | S |
| FR-1213 | When a requirement is ambiguous or a test contradicts the specification, the agent shall stop and raise a structured question to the blocking queue rather than inventing behaviour. | M |
| FR-1214 | Code execution shall occur in a sandbox with CPU, memory, disk, process and wall-clock limits, and network egress restricted to the task's allowlist. | M |
| FR-1215 | The system shall pause a task at 100% of its token or cost budget and escalate, rather than silently continuing or degrading quality. | M |
| FR-1216 | Parallel tasks shall be scheduled only when their write scopes are disjoint and their dependency edges are satisfied; the scheduler shall detect conflicting semantic edits at merge time. | M |

**Pre-PR exit criteria.** Build passes; all new and affected tests pass; coverage threshold met; no blocker static-analysis finding; no secret; PR description includes traceability and evidence; self-review recorded.

### 4.13 Pull request review (S14)

| ID | Requirement | Pri. |
|---|---|---|
| FR-1301 | The system shall open a pull request containing a generated summary, requirement and task links, risk score, test evidence, screenshots or recordings for UI changes, and a rollback note. | M |
| FR-1302 | The system shall compute a PR risk score on a 0–100 scale from change size, touched paths (auth, crypto, payments, migrations, infrastructure), dependency changes, test-coverage delta, historical defect density and author-agent track record. | M |
| FR-1303 | The system shall run specialised review agents for correctness, security, performance, maintainability, API compatibility, test adequacy and data safety, each producing structured findings. | M |
| FR-1304 | Findings shall be posted as inline review comments with severity, location, evidence, suggested patch where deterministic, and a stable finding ID that survives force-pushes. | M |
| FR-1305 | The system shall require all configured checks (build, tests, coverage, security, licence, policy) to pass before merge, and shall not allow an override without a recorded waiver. | M |
| FR-1306 | Human approval shall be mandatory when the risk score exceeds the configured threshold, when a sensitive path is touched, or when autonomy is below A3; the approver must be independent of the author. | M |
| FR-1307 | The author agent shall respond to every blocker and major finding with a fix or a reasoned rebuttal, and the reviewer shall verify resolution before approval. | M |
| FR-1308 | Re-review after a push shall be diff-aware: previously resolved findings are not re-raised unless the relevant code changed. | M |
| FR-1309 | Merges shall go through a merge queue that re-runs required checks on the rebased result, and shall use the project's configured merge strategy. | S |
| FR-1310 | The system shall block merge on new secrets, disallowed licences, critical vulnerabilities, failing required checks or unresolved blocker findings. | M |
| FR-1311 | The system shall enforce review SLAs and shall escalate stale PRs to the Tech Lead with age, risk and blocking reason. | S |
| FR-1312 | The system shall record review effort, findings by category, fix rate and post-merge defects, and shall use them to tune review depth and agent prompts. | S |

**Merge exit criteria.** Required approvals present; all checks green; no open blocker; traceability intact; branch up to date; merge queue passed.

### 4.14 Testing — unit, UI, integration and end-to-end (S15–S17)

| ID | Requirement | Pri. |
|---|---|---|
| FR-1401 | The system shall produce a test strategy per risk tier defining the test levels, environments, data, tooling, entry/exit criteria and the evidence required. | M |
| FR-1402 | Unit tests shall be generated alongside code, shall follow the arrange–act–assert structure, and shall cover changed lines at or above the configured threshold (default 80%). | M |
| FR-1403 | Critical modules (authentication, authorization, payments, pricing, crypto, data migration) shall additionally meet a mutation-score threshold (default 60%). | S |
| FR-1404 | UI tests shall run in a real browser against a deployed preview, cover the primary journeys, include visual regression and automated accessibility checks, and capture traces, video and screenshots on failure. | M |
| FR-1405 | Integration tests shall exercise real dependencies (database, queue, cache, vector store) via disposable containers or ephemeral namespaces, and consumer-driven contract tests shall verify every external interface. | M |
| FR-1406 | Test data shall be generated per run, isolated by namespace, masked where derived from production, and cleaned up deterministically. | M |
| FR-1407 | The system shall detect flaky tests from repeated-run history, quarantine them with an owner and expiry, and block release if quarantined tests cover a `Must` requirement. | M |
| FR-1408 | Performance tests shall verify each measurable NFR at expected and peak load, and shall fail the gate when the target is missed by more than the agreed tolerance. | M |
| FR-1409 | Security testing shall include SAST, dependency and container scanning, secret scanning, DAST against a running environment, and infrastructure-as-code scanning; critical or high findings block release unless an approved waiver with a compensating control exists. | M |
| FR-1410 | The system shall select a risk-based regression subset from the traceability graph (changed code, affected requirements, prior defects), and shall run the full suite nightly. | S |
| FR-1411 | Every requirement's acceptance criteria shall be executable as automated acceptance tests, or shall have a recorded manual test script and evidence. | M |
| FR-1412 | Test evidence (reports, logs, traces, videos, coverage and mutation summaries) shall be attached to the artifact graph and referenced from the release readiness report. | M |
| FR-1413 | The system shall run exploratory testing by an agent using the product like a user, record defects with reproduction steps, and classify them against requirements. | C |
| FR-1414 | Accessibility verification shall cover WCAG 2.2 AA automated rules plus manual keyboard and screen-reader checks for primary journeys. | M |
| FR-1415 | Responsive and cross-browser verification shall cover the browsers and viewports declared in the specification. | S |
| FR-1416 | Database migration tests shall verify forward migration, rollback, data preservation, idempotency and behaviour under concurrent writes. | M |
| FR-1417 | Resilience tests shall verify graceful degradation for dependency failure, timeout, retry storm and queue backlog in R3/R4 systems. | S |
| FR-1418 | Defects found in testing shall be triaged with severity, linked requirement, reproduction evidence and disposition (fix, defer, waive), and deferrals shall require approval. | M |
| FR-1419 | The system shall publish a test summary per run: scope, pass/fail, coverage, defects, waivers, residual risk and a release recommendation. | M |
| FR-1420 | User acceptance testing shall be supported with a scripted UAT plan, environment, data, participant tracking and structured sign-off. | S |

**Test gate exit criteria.** All `Must` acceptance tests pass; coverage and mutation thresholds met; no open critical/high defect; no unexpired waiver without approval; security scans clean or accepted with compensating control; performance within tolerance; evidence attached.

### 4.15 QA thresholds and release readiness (S18)

| ID | Requirement | Pri. |
|---|---|---|
| FR-1501 | The system shall evaluate release readiness against the configured quality gate set (see §16) and shall produce a pass/fail result per gate with evidence links. | M |
| FR-1502 | The system shall calculate a release confidence score from gate results, defect trends, test stability, change risk and open waivers, and shall present it with its contributing factors. | S |
| FR-1503 | The system shall require a recorded waiver for any failed gate, including justification, expiry, compensating control, approver and follow-up ticket. | M |
| FR-1504 | The system shall block release when a `Must` gate fails and no approved waiver exists, regardless of autonomy level. | M |
| FR-1505 | The system shall produce a residual risk register for the release, with likelihood, impact, owner and mitigation. | M |
| FR-1506 | The system shall verify that the release candidate is exactly the artifact that was tested (commit SHA, image digest, configuration hash) and shall fail if they differ. | M |
| FR-1507 | The system shall freeze the release candidate, record its SBOM and provenance, and reject post-freeze changes except through an emergency change path. | M |
| FR-1508 | The system shall require QA Lead and Engineering Lead sign-off; for R4, a security and a compliance sign-off are also required. | M |
| FR-1509 | The system shall publish a release readiness report to the dashboard and notify stakeholders at least the configured lead time before deployment. | S |
| FR-1510 | The system shall track quality-gate pass rate, waiver rate and post-release defect leakage, and shall alert when a project trends outside its thresholds. | S |

**Gate HR-10 — release readiness.** Exit criteria: all `Must` gates pass or have approved, unexpired waivers; residual risk accepted by the accountable owner; release candidate frozen and matched; sign-offs recorded; deployment plan and rollback plan approved.

### 4.16 Milestone completion (S19)

| ID | Requirement | Pri. |
|---|---|---|
| FR-1601 | The system shall evaluate the milestone Definition of Done and produce an evidence pack with a pass/fail per criterion and a link to supporting artifacts. | M |
| FR-1602 | The system shall verify that every milestone requirement is implemented, tested, documented and deployed to the target environment. | M |
| FR-1603 | The system shall generate release notes grouped by feature, fix, breaking change and known issue, written for the intended audience. | M |
| FR-1604 | The system shall compute milestone metrics: planned versus delivered, estimate accuracy, defect density, review cycle time, cost and token consumption. | S |
| FR-1605 | The system shall archive the milestone baseline (artifacts, SBOM, deployment record, test evidence) in immutable storage. | M |
| FR-1606 | The system shall conduct a structured retrospective and record actions with owners and due dates. | S |
| FR-1607 | The system shall carry forward unfinished work with explicit disposition (re-plan, descope, cancel) rather than silently rolling it over. | M |
| FR-1608 | The system shall require Delivery Lead and Product Owner sign-off before the next milestone may consume shared capacity. | M |

**Gate HR-11 — milestone sign-off.** Exit criteria: Definition of Done evidence complete; release notes published; unfinished work dispositioned; milestone metrics reviewed; Delivery Lead and Product Owner approve.

### 4.17 CI/CD pipeline authoring (S20)

| ID | Requirement | Pri. |
|---|---|---|
| FR-1701 | The system shall generate pipeline-as-code for the customer's CI/CD platform (GitHub Actions, GitLab CI, Azure Pipelines, Jenkins) from the architecture and test strategy. | M |
| FR-1702 | Generated pipelines shall implement: build, unit test, static analysis, security scan, package, integration test, deploy to ephemeral environment, UI test, performance test (scheduled), and promotion. | M |
| FR-1703 | Pipelines shall use short-lived OIDC credentials or workload identity; no long-lived cloud keys shall be stored in CI variables. | M |
| FR-1704 | Pipelines shall cache dependencies and build layers with content-addressed keys, and shall be reproducible (locked dependencies, pinned tool versions, pinned action SHAs). | M |
| FR-1705 | The pipeline shall produce an SBOM, sign artifacts and attest provenance (SLSA level 2 or higher where the platform supports it). | S |
| FR-1706 | Environment promotion shall require the configured approvals and shall verify the same artifact digest across environments. | M |
| FR-1707 | Pipeline policy (allowed branches, required checks, deployment windows, protected environments) shall be enforced as code and audited on drift. | M |
| FR-1708 | The system shall test the pipeline itself (lint, dry run, ephemeral execution) before proposing it, and shall not merge a pipeline that has never run. | M |
| FR-1709 | Pipeline failures shall be classified (code, test, infrastructure, flake, policy) and routed to the correct owner with logs and a suggested next action. | S |
| FR-1710 | The system shall monitor pipeline duration and cost, and shall propose optimisations (caching, parallelism, test selection) when thresholds are exceeded. | C |
| FR-1711 | The system shall support a documented manual break-glass path that is time-boxed, requires two approvers and produces an incident record. | M |
| FR-1712 | The system shall reconcile pipeline definitions against the repository continuously and alert on unauthorised drift. | S |

### 4.18 Deployment (S21)

| ID | Requirement | Pri. |
|---|---|---|
| FR-1801 | The system shall deploy through a declarative, versioned deployment plan naming environments, order, strategy, verification and rollback for each step. | M |
| FR-1802 | Deployment strategies shall include rolling, blue/green and canary with automated analysis; the strategy shall be selected by risk tier and service criticality. | M |
| FR-1803 | Database migrations shall follow expand/contract, be backward compatible with the previous application version, and be rehearsed on a production-like copy before execution. | M |
| FR-1804 | Before promotion, the system shall verify pre-conditions: approvals, frozen artifact match, open incidents, change window, dependency health and capacity headroom. | M |
| FR-1805 | After each step, the system shall run automated smoke and health checks, and shall halt and roll back on failure without human prompting. | M |
| FR-1806 | Rollback shall be automated, rehearsed and time-bounded, and shall be proven in staging within the previous 30 days. | M |
| FR-1807 | Feature flags shall gate user-visible behaviour so that deployment and release are separable; flag cleanup shall be tracked. | S |
| FR-1808 | Production deployment shall require an explicit human authorisation for each release. At A4, a named release manager may pre-authorise a defined artifact set and deployment window; any deployment outside that scope requires fresh approval. | M |
| FR-1809 | The system shall produce an immutable deployment record: who/what/when, artifact digests, configuration hashes, approvals, checks, duration and outcome. | M |
| FR-1810 | The system shall notify stakeholders before, during and after deployment according to the communication plan. | S |
| FR-1811 | Emergency deployments shall use a separate, audited path with incident linkage, two approvers and a mandatory post-deployment review within 48 hours. | M |
| FR-1812 | The system shall verify post-deployment SLOs for a defined bake period and shall automatically roll back on error-budget burn beyond threshold. | S |
| FR-1813 | Deployment shall respect blackout windows, freeze periods and regional restrictions configured per project. | S |
| FR-1814 | The system shall record DORA metrics (lead time, deployment frequency, change failure rate, MTTR) per project and per team. | S |

**Gate HR-12 — production deployment.** Exit criteria: readiness report current; approvals present; rollback proven; change window open; smoke plan defined; on-call aware.

### 4.19 Post-release operations and feedback (S22)

| ID | Requirement | Pri. |
|---|---|---|
| FR-1901 | The system shall define SLIs, SLOs and error budgets per service, and shall publish them to the project dashboard. | M |
| FR-1902 | The system shall ingest logs, metrics, traces and alerts from the observability stack and correlate them with deployments and changes. | M |
| FR-1903 | The system shall detect anomalies against baseline and error-budget burn, and shall open an incident with severity, affected services and a timeline. | S |
| FR-1904 | The incident agent shall assemble context (recent deploys, related changes, similar past incidents, runbooks) and propose diagnosis and remediation options with confidence. | S |
| FR-1905 | Automated remediation shall be limited to pre-approved, reversible runbook actions and shall require human confirmation for anything touching production data or security controls. | M |
| FR-1906 | Every alert shall map to a runbook; alerts without a runbook shall create a documentation task. | M |
| FR-1907 | The system shall conduct blameless post-incident review, record contributing factors and create tracked corrective actions. | S |
| FR-1908 | The system shall collect user feedback (support tickets, chat, surveys, reviews) and cluster it into themes linked to requirements and defects. | S |
| FR-1909 | The system shall monitor infrastructure and model cost against budget, and shall alert at 80% and 100% of the monthly envelope. | M |
| FR-1910 | The system shall feed production signals back into roadmap and change-request prioritisation on a defined cadence. | S |

**Gate HR-14 — incident and rollback authority.** For Sev-1/Sev-2 incidents, a named human incident commander is authoritative; the Factory may recommend and execute only approved actions.

### 4.20 Ticket and backlog monitoring (S23)

| ID | Requirement | Pri. |
|---|---|---|
| FR-2001 | The system shall ingest issues, comments, transitions, attachments and sprint changes from Jira and Azure DevOps Boards via webhooks plus scheduled reconciliation. | M |
| FR-2002 | Incoming items shall be deduplicated by external ID and content hash, and mapped to the internal project, requirement and task model with configurable field mapping. | M |
| FR-2003 | The system shall classify new items (defect, feature, question, blocker, change request, noise) with a confidence score, and shall route low-confidence items to human triage. | M |
| FR-2004 | The system shall detect blockers, dependencies, missing acceptance criteria, stale items, unassigned critical work and sprint-scope creep, and shall alert the responsible owner. | M |
| FR-2005 | The system shall track SLA and service-level targets per item class, and shall escalate before breach, not after. | S |
| FR-2006 | The system shall post status updates, links to builds/PRs/deployments and clarifying questions to the tracker only after approval, or automatically when the project policy permits and the update is factual. | M |
| FR-2007 | The system shall reconcile tracker state with the artifact graph (for example close an issue when its deployment is verified) and shall report discrepancies. | S |
| FR-2008 | The system shall produce a daily digest of changes, risks and items needing human action, and a weekly backlog health report. | S |
| FR-2009 | The system shall handle rate limits with backoff, batching and priority queues, and shall degrade to read-only rather than fail. | M |
| FR-2010 | The system shall record every outbound tracker write with before/after state for audit and rollback. | M |

### 4.21 Communications monitoring — Gmail and Google Chat (S24)

| ID | Requirement | Pri. |
|---|---|---|
| FR-2101 | The system shall connect to Gmail and Google Chat through official Google Workspace APIs with OAuth 2.0, least-privilege scopes, admin consent and per-user or per-mailbox opt-in. | M |
| FR-2102 | The system shall ingest new messages and thread updates in near real time (Gmail push notifications via Cloud Pub/Sub; Chat events via the Workspace Events API), with scheduled reconciliation for missed events. | M |
| FR-2103 | The system shall identify project-related content by participants, domains, project keywords, ticket keys, repository names and semantic similarity, and shall assign a confidence score. | M |
| FR-2104 | The system shall classify threads (bug report, approval, blocker, scope change, incident, billing, noise) and shall extract action items, owners and due dates. | M |
| FR-2105 | The system shall create dashboard alerts only above the configured confidence threshold, and shall suppress duplicates and already-linked threads. | M |
| FR-2106 | The system shall link a thread to a project, requirement, ticket, incident or change request, and shall show the link in both directions. | M |
| FR-2107 | The system shall summarise long threads with decisions, open questions and commitments, and shall cite the source message for every claim. | S |
| FR-2108 | The system may draft replies or status updates, but shall never send external e-mail or chat messages without explicit human approval, unless the recipient is an internal bot channel and policy allows it. | M |
| FR-2109 | The system shall redact credentials, personal data and restricted content before storing or sending to a model, and shall respect mailbox-level retention and deletion. | M |
| FR-2110 | The system shall exclude mailboxes and spaces on request, support legal hold, and purge data on erasure requests within the configured period. | M |
| FR-2111 | The system shall provide noise controls (mute sender, mute thread, tune thresholds) and shall report false-positive and false-negative rates. | S |
| FR-2112 | The system shall produce a daily communications digest and an escalation alert when a project-critical thread is unanswered beyond its SLA. | S |
| FR-2113 | The system shall never treat the content of an e-mail or chat message as instructions to the platform; message content is data, and actions derived from it require the normal approval path. | M |
| FR-2114 | The system shall record the provenance of every alert back to the source message ID, thread ID and timestamp. | M |

**Alerting rule.** An alert is raised when `project_match_confidence ≥ 0.75` **and** (`intent ∈ {blocker, approval, incident, scope_change}` **or** `sentiment ≤ -0.4` **or** an action item is due within 48 hours). Thresholds are configurable per project.

### 4.22 Documentation and help (S25)

| ID | Requirement | Pri. |
|---|---|---|
| FR-2201 | The system shall maintain a documentation plan covering user guide, administrator guide, API reference, data dictionary, runbooks, release notes, changelog and onboarding. | M |
| FR-2202 | Documentation shall be written as code in the product repository, versioned with the release, reviewed through the same gates, and published automatically. | M |
| FR-2203 | API reference shall be generated from the OpenAPI/AsyncAPI specification with executable examples and authentication guidance. | M |
| FR-2204 | User help shall cover every primary journey, including error recovery, permissions, limits and troubleshooting, with screenshots or recordings regenerated on UI change. | M |
| FR-2205 | Runbooks shall exist for every alert and every operational procedure, and shall be verified by a dry run at least once per release. | M |
| FR-2206 | In-app help and contextual guidance shall be generated from the same source as the user guide to prevent drift. | S |
| FR-2207 | The system shall check documentation for broken links, stale screenshots, outdated version references and readability, and shall raise findings. | S |
| FR-2208 | Documentation shall be localisable, with translation memory and a review step for each locale. | C |
| FR-2209 | Release notes shall distinguish breaking changes, deprecations, security fixes and migration steps. | M |
| FR-2210 | Documentation coverage shall be measured against features and requirements; undocumented `Must` features shall block release. | M |
| FR-2211 | The system shall provide a searchable help centre with analytics on unanswered queries, and shall convert recurring questions into documentation tasks. | S |
| FR-2212 | Documentation approval shall be recorded per release, with named owner and reviewer. | M |

**Gate HR-13 — documentation release.** Exit criteria: all `Must` features documented; links, screenshots and version references valid; API reference generated; release notes approved; Technical Writer and Product Owner approve.

### 4.23 Change request handling (S26)

| ID | Requirement | Pri. |
|---|---|---|
| FR-2301 | The system shall accept change requests from the cockpit, Jira, Azure DevOps, e-mail, chat and API, and shall assign a unique change ID with source provenance. | M |
| FR-2302 | The system shall classify the change (defect, scope, regulatory, technical, emergency, cost reduction) and route it to the correct intake path. | M |
| FR-2303 | The system shall perform impact analysis across requirements, design, data, code, tests, documentation, schedule, cost, risk and deployed environments, using the traceability graph. | M |
| FR-2304 | Impact analysis shall produce a delta plan: artifacts to revise, tasks to add or remove, regression scope, migration needs and estimated effort with confidence. | M |
| FR-2305 | The system shall apply approval thresholds by impact (for example: schedule > 10%, cost > 10%, or any regulatory change requires the Change Board). | M |
| FR-2306 | Approved changes shall be implemented through the normal lifecycle with a new run linked to the original, not by editing approved artifacts in place. | M |
| FR-2307 | The system shall rebaseline affected artifacts, update the RTM and roadmap, and notify downstream owners of changed assumptions. | M |
| FR-2308 | Emergency changes shall follow a fast path with two approvers, immediate implementation, and a mandatory retrospective review within 48 hours. | M |
| FR-2309 | The system shall report change volume, lead time, rework and scope-creep trend per project and per source. | S |
| FR-2310 | Rejected changes shall retain rationale and shall be searchable to prevent re-litigation and duplicate requests. | S |
| FR-2311 | The system shall link every change to the incidents, defects or customer requests that motivated it. | S |
| FR-2312 | Change records shall be exported in an audit-ready format for external regulators. | C |

**Gate HR-15 — change approval.** Mandatory for scope, regulatory, cost or schedule impact above configured thresholds; the Change Board decision records approved scope, budget, timeline and rollback position.

### 4.24 Portfolio dashboard and collaboration cockpit (S01–S26, cross-cutting)

| ID | Requirement | Pri. |
|---|---|---|
| FR-2401 | The cockpit shall provide a portfolio view of projects with stage, health, risk, spend, open alerts and next human action. | M |
| FR-2402 | Each project shall have a stage timeline with current stage, gate status, elapsed time, blockers and the exact next decision required. | M |
| FR-2403 | The cockpit shall provide a review inbox that batches pending decisions with summary, risk, diff, evidence and one-click approve/request-changes. | M |
| FR-2404 | The cockpit shall provide an artifact explorer with version history, diffs, provenance, traceability links and comments. | M |
| FR-2405 | The cockpit shall provide cost and token dashboards by project, stage, agent, model and artifact, with budget burn and forecast. | M |
| FR-2406 | The cockpit shall show alerts from tickets, e-mail and chat with source, confidence, linked project and suggested action. | M |
| FR-2407 | The cockpit shall support full-text and semantic search across artifacts, decisions, code and threads, respecting permissions. | S |
| FR-2408 | Notifications shall be delivered through in-app, e-mail and Google Chat/Slack/Teams, with per-user preferences and quiet hours. | S |
| FR-2409 | The cockpit shall be keyboard navigable and meet WCAG 2.2 AA. | S |
| FR-2410 | The cockpit shall expose an audit view that reconstructs any decision from events and artifacts. | M |
| FR-2411 | Dashboards shall be embeddable and exportable (PDF/CSV) for stakeholder reporting. | C |
| FR-2412 | The cockpit shall support multiple languages and time zones, with all timestamps stored in UTC. | S |

### 4.25 Continuous improvement (cross-cutting)

| ID | Requirement | Pri. |
|---|---|---|
| FR-2501 | The system shall maintain a versioned evaluation suite (golden tasks, rubrics, expected findings) and shall run it before any prompt, model or adapter rollout. | S |
| FR-2502 | The system shall A/B test prompt and routing changes on shadow traffic before enabling them, with automatic rollback on regression. | S |
| FR-2503 | The system shall track per-stage success rate, rework rate, cost and cycle time, and shall identify the top improvement opportunities monthly. | S |
| FR-2504 | The system shall convert recurring review findings into checklist items, lint rules or automated tests. | S |
| FR-2505 | The system shall maintain a platform improvement backlog fed by incidents, retros and operator feedback, prioritised by impact. | S |
| FR-2506 | The system shall publish a monthly quality and cost report per tenant and per project. | C |

## 5. Human-in-the-loop review model

### 5.1 Principles

1. **Review is a decision, not a notification.** Every checkpoint has named authority, a decision vocabulary, an SLA and a defined outcome when the SLA is missed.
2. **Evidence before opinion.** A reviewer sees the artifact, the diff, the evidence and the machine assessment together; a decision without evidence is not permitted for `Must` gates.
3. **Independence.** The author of an artifact, the operator of the producing agent, and anyone with a conflict of interest may not be the sole approver.
4. **Proportionality.** Review depth and quorum scale with risk tier and blast radius; low-risk changes are sampled, not individually approved.
5. **No dead ends.** Every rejection produces actionable reason codes and a path to revision; every escalation has an owner and a deadline.
6. **Auditability.** Every decision records who, what, when, why and on which evidence.

### 5.2 Mandatory checkpoints

| ID | Checkpoint | Accountable | Decision | Default SLA | Blocking |
|---|---|---|---|---|---|
| HR-01 | Project charter | Product Owner + Engineering Lead | Approve / request changes | 2 business days | Always |
| HR-02a | Requirements baseline (BRD) | Product Owner + Business Analyst | Approve / request changes | 2 business days | Always |
| HR-02b | Functional specification | Business Analyst + Architect + QA Lead | Approve / request changes | 2 business days | Always |
| HR-03a | Wireframe direction | UX Lead + Product Owner | Approve / request changes | 1 business day | Always |
| HR-03b | Interactive prototype | UX Lead + PO + accessibility reviewer | Approve / request changes | 2 business days | Always |
| HR-04 | Architecture, stack, pipeline design | Architect + Security + Engineering Lead | Approve / request changes | 2 business days | Always |
| HR-05 | Data design and migrations | Data Architect + DBA + Privacy | Approve / request changes | 2 business days | R3/R4, personal data |
| HR-06 | Roadmap, estimate and budget | Delivery Lead + PO + Finance | Approve / request changes | 2 business days | Always |
| HR-07 | POC plan approval and go/no-go | Architect + Product Owner | Approve plan / go / go-with-changes / iterate / stop | 1 business day | Always |
| HR-08 | Task and sprint plan | Delivery Lead + Tech Lead | Approve / request changes | 1 business day | Always at A2 and below; A3+ only R2+ |
| HR-09 | High-risk pull request | Tech Lead + Security (if flagged) | Approve / request changes | 1 business day | Risk ≥ threshold or autonomy < A3 |
| HR-10 | Release readiness | QA Lead + Engineering Lead (+ Security/Compliance for R4) | Approve / waive / block | 1 business day | Always |
| HR-11 | Milestone completion | Delivery Lead + Product Owner | Approve / conditional | 1 business day | Always |
| HR-12 | Production deployment | Release Manager + accountable owner | Approve / defer / cancel | 4 business hours | Always; A4 window pre-authorisation allowed |
| HR-13 | Documentation release | Technical Writer + Product Owner | Approve / request changes | 1 business day | Always |
| HR-14 | Incident command / rollback | On-call Incident Commander | Authorise / decline | 15 minutes (Sev-1/2) | Always |
| HR-15 | Change request | Change Board | Approve / reject / defer | 2 business days | Above impact threshold |
| HR-16 | Budget, autonomy or policy change | Platform Owner + Finance | Approve / reject | 1 business day | Always |
| HR-17 | Security exception / risk acceptance | Security Officer + accountable owner | Approve / reject | 2 business days | Always |

### 5.3 Decision semantics

| Action | Meaning | Requirements |
|---|---|---|
| `approve` | Artifact is accepted and becomes the baseline. | Reviewer saw current version; all mandatory checks passed. |
| `approve_with_comments` | Accepted; minor findings become follow-up tasks. | Each comment has an owner and due date; no blocker finding. |
| `request_changes` | Returned for revision with structured findings. | At least one reason code and a concrete expected change. |
| `reject` | Artifact is not viable; a new approach is required. | Written rationale; retained in history; author may appeal once. |
| `delegate` | Authority transfers to another named person for a bounded period. | Delegate has the required role; original owner notified. |
| `waive` | A failed check is accepted with a compensating control. | Expiry ≤ 90 days; risk accepted by accountable owner; follow-up ticket. |
| `escalate` | Decision is above the reviewer's authority or conflicts with policy. | Target role named; SLA restarts at escalation. |

**HX-01 (M).** The system shall enforce that a decision cannot be recorded without the minimum evidence defined for that checkpoint type.

**HX-02 (M).** The system shall compute quorum and independence automatically and shall block self-approval, including approval by a human who is also the accountable owner of the producing agent.

**HX-03 (M).** The system shall present a review packet containing: artifact summary, changed-since-last-version diff, machine rating and findings, evidence links, open risks, prior decisions and the exact consequence of each decision.

**HX-04 (M).** The system shall support asynchronous review with threaded comments, mentions, attachments and a full-text decision rationale.

**HX-05 (M).** When an SLA is missed, the system shall follow the escalation ladder: reminder at 50%, delegate or escalate at 100%, and auto-block (never auto-approve) at 150%, notifying the project sponsor.

**HX-06 (S).** The system shall support "review by exception": reviewers may pre-authorise a policy envelope (for example "auto-approve documentation changes under 200 lines with no security impact") that is versioned, time-boxed and audited.

**HX-07 (S).** The system shall measure reviewer load and shall not assign more than a configurable number of pending decisions per reviewer per day.

**HX-08 (S).** The system shall provide a mobile-friendly approval view for urgent decisions, with the same evidence requirements.

**HX-09 (C).** The system shall support electronic signatures for regulated approvals.

### 5.4 Reviewer experience

The review inbox is the primary human interface. It must answer, for each item: *What is this? Why does it matter? What changed? What does the machine think? What is the risk if I approve? What is the next step if I reject?* Items are grouped by project and urgency, sorted by risk × deadline, and can be filtered by stage, artifact type, reviewer role and decision type.

**HX-10 (M).** One-click decisions shall be available only when the evidence is complete and the decision is low-risk; all others shall require the reviewer to open the review packet.

---

## 6. Platform architecture

### 6.1 Logical architecture

```mermaid
flowchart TB
  subgraph EXP[Experience]
    UI[Review cockpit]
    API[Public API and CLI]
  end

  subgraph CTL[Control plane]
    IDP[Identity, RBAC and policy engine]
    ORCH[Orchestration kernel — DeepSeek Harness]
    STAGE[Stage runtime and contracts]
    SCHED[Scheduler, budgets and quotas]
    COST[Cost and token ledger]
  end

  subgraph EXE[Execution plane]
    AGENT[Agent runtime]
    ADAPT[Coder adapters]
    MGW[Model gateway]
    TOOL[Tools, MCP servers and sandboxes]
  end

  subgraph DATA[Data plane]
    PG[(PostgreSQL)]
    RDS[(Redis)]
    MQ[(RabbitMQ)]
    QDR[(Qdrant)]
    OBJ[(Object storage)]
  end

  subgraph INT[Integration plane]
    GIT[Git hosts]
    TRK[Jira and Azure DevOps]
    CICD[CI/CD and cloud]
    COM[Gmail and Google Chat]
  end

  UI --> API
  API --> IDP
  IDP --> ORCH
  ORCH --> STAGE
  STAGE --> AGENT
  AGENT --> ADAPT
  AGENT --> MGW
  AGENT --> TOOL
  ORCH --> MQ
  MQ --> STAGE
  STAGE --> PG
  ORCH --> PG
  MGW --> COST
  AGENT --> QDR
  AGENT --> OBJ
  STAGE --> GIT
  STAGE --> TRK
  STAGE --> CICD
  COM --> TRK
  COM --> ORCH
```

The control plane owns state and decisions; the execution plane is disposable, stateless and replaceable. All plane-to-plane communication is authenticated, traced and idempotent.

### 6.2 DeepSeek Harness as the orchestration kernel

DSH is the default agent kernel because it provides a plugin-based composition model, sessions with persisted event history, subagents, a workflow orchestration primitive, tool execution with permission modes, MCP support, Git worktrees, forge (change-request) capability and a headless/SDK interface suitable for programmatic control. The Factory wraps DSH rather than forking it.

| ID | Requirement | Pri. |
|---|---|---|
| AR-10 | The Factory shall integrate DSH through its supported programmatic surfaces — the headless profile with machine-readable run events and the stdio JSON-RPC SDK — and shall pin a tested DSH version per environment. | M |
| AR-11 | The Factory shall keep PostgreSQL as the system of record and treat DSH sessions as execution state; on divergence, the Factory's event log wins and the session is marked for reconciliation. | M |
| AR-12 | DSH plugins shall be used for Factory-specific tools (artifacts, Git, tracker, CI, model gateway, cost ledger) and shall be versioned, signed and independently enable/disable-able. | M |
| AR-13 | The Factory shall use DSH subagents and workflow fan-out for independent work (review panels, parallel task research, test-matrix generation), with a hard cap on depth and concurrency. | M |
| AR-14 | The Factory shall use one DSH session per work item, and shall reset or fork sessions at stage boundaries to prevent context bloat and cross-stage contamination. | M |
| AR-15 | The Factory shall map its permission model onto DSH permission modes so that a stage's tool access is enforced by the kernel, not only by prompt instructions. | M |
| AR-16 | The Factory shall consume DSH run events as an ordered stream, persist them, and derive stage progress, tool usage and token accounting from them. | M |
| AR-17 | The Factory shall be able to run without DSH — using a direct adapter — for disaster recovery or vendor substitution, at reduced capability. | S |
| AR-18 | The Factory shall not depend on undocumented DSH internals; any such dependency requires an ADR and a contract test. | M |

### 6.3 Stage contract and plugin model

Every stage is a plugin implementing a typed contract.

| Contract element | Description |
|---|---|
| `id`, `version` | Stable stage identity and semantic version |
| `inputs` | Required artifact types, schemas, minimum status and freshness |
| `outputs` | Artifact types and schemas the stage must produce |
| `entry_criteria` | Predicates over the artifact graph and project state |
| `exit_criteria` | Predicates that must hold before the gate opens |
| `gate` | Gate definition (automated, human, mixed) |
| `agent_roles` | Roles, model policy, tools and budgets |
| `tools` | Allowlisted tools and MCP servers |
| `budget` | Token, cost, time and review-minute limits |
| `retry_policy` | Max attempts, backoff, escalation |
| `idempotency` | Key derivation and side-effect semantics |
| `observability` | Metrics, spans and log fields |
| `conformance_tests` | Tests that any implementation must pass |

**AR-19 (M).** The system shall allow a tenant to replace a stage implementation, disable a non-mandatory stage, or insert a custom stage, without modifying core code.

**AR-20 (M).** The system shall validate a stage plugin's contract at load time and shall refuse to activate a plugin that fails schema or conformance checks.

### 6.4 Execution isolation and scheduling

**AR-21 (M).** Each task shall run in an ephemeral sandbox (container, microVM or namespace) with CPU, memory, disk, PID and wall-clock limits, a read-only base image, and an explicit network allowlist.

**AR-22 (M).** Sandboxes shall have no access to platform credentials; they receive short-lived, scoped tokens minted per task and revoked on completion.

**AR-23 (M).** The scheduler shall support fair sharing across tenants and projects, priority classes (incident > release > planned work > background), and preemption of background jobs when capacity is constrained.

**AR-24 (M).** The platform shall detect and prevent concurrent writes to the same Git ref or artifact version, and shall fail fast rather than merge conflicting edits.

**AR-25 (S).** Long-running stages shall be checkpointed and distributed to workers such that a worker loss results in at most one step of repeated work.

### 6.5 Event backbone

**AR-26 (M).** All state transitions shall emit immutable domain events to RabbitMQ (or an equivalent broker) and shall be persisted in PostgreSQL through a transactional outbox.

**AR-27 (M).** Consumers shall be idempotent, shall acknowledge only after durable side effects, and shall route poison messages to a dead-letter queue with full context.

**AR-28 (M).** Retries shall use exponential backoff with jitter, a maximum attempt count and a per-consumer concurrency limit; retry storms shall be prevented by circuit breakers.

**AR-29 (S).** The event log shall support replay into a shadow consumer for projection rebuilds and debugging without affecting live state.

### 6.6 Deployment topology

**AR-30 (M).** The platform shall run on Kubernetes (preferred) and on Docker Compose for single-node evaluation; all stateful services shall support managed cloud equivalents.

**AR-31 (M).** Control-plane services shall be stateless and horizontally scalable; stateful services (PostgreSQL, RabbitMQ, Qdrant, Redis, object storage) shall support HA configurations with documented failure behaviour.

**AR-32 (M).** The system shall expose health, readiness and startup probes, graceful shutdown, and connection draining.

**AR-33 (S).** The system shall support active-passive multi-region disaster recovery with RPO ≤ 5 minutes and RTO ≤ 1 hour.

### 6.7 Multi-tenancy

**AR-34 (M).** Tenant data shall be isolated logically (tenant ID on every row, row-level security) and physically where required (separate schema, database or cluster per tenant).

**AR-35 (M).** Cross-tenant queries shall be impossible through the application API; administrative reporting shall use a separate, audited path.

**AR-36 (M).** Per-tenant encryption keys shall be supported for artifact storage and secrets.

**AR-37 (S).** Tenant onboarding shall be self-service for SaaS deployments, provisioning isolation, default policies, retention and a starter blueprint without operator involvement.

**AR-38 (M).** A tenant shall be able to export all of its data — artifacts, events, decisions, configuration and metadata — in open, documented formats within a bounded time.

**AR-39 (M).** Tenant offboarding shall produce a verifiable export, delete all tenant data across every store, destroy tenant keys, and issue a deletion certificate.

---

## 7. Agent runtime and coder adapters

### 7.1 Agent roles

| Role | Responsibility | Primary tools | Typical output |
|---|---|---|---|
| Orchestrator | Plans the run, selects stages, enforces gates, escalates | Event bus, artifact store, policy engine | Run plan, decisions |
| Business Analyst | Elicits, structures and validates requirements | Document tools, interview guide, retrieval | BRD, SRS, RTM |
| UX Designer | Flows, wireframes, prototype, accessibility annotations | Design tokens, prototype runtime, a11y scanner | Flows, wireframes, prototype |
| Architect | Structure, interfaces, NFR realisation, ADRs | Diagramming, repo analysis, cost models | HLD, ADRs, threat model |
| Data Architect | Models, migrations, lineage, privacy | Schema tools, migration runner, data profiler | ERD, DDL, migration plan |
| Planner / Estimator | Roadmap, WBS, estimates, capacity | Historical data, simulation | Roadmap, plan, budget |
| Coder | Implements tasks, writes tests, opens PRs | IDE tools, shell, Git, test runner | Commits, PRs |
| Reviewer | Reviews artifacts, code and tests | Diff, static analysis, test evidence | Findings, ratings |
| QA Engineer | Test strategy, automation, evidence | Browser, API client, load generator | Test suites, reports |
| Security Engineer | Threat modelling, scanning, exceptions | SAST/DAST/SCA, policy engine | Findings, risk acceptance |
| DevOps / SRE | Pipelines, IaC, deployment, operations | Cloud APIs, CI, observability | Pipelines, deployment records |
| Technical Writer | Guides, reference, release notes | Docs generator, link checker | Documentation |
| Triage Agent | Tickets, chat, e-mail, dedupe, routing | Integrations, classifier | Triage queue, alerts |
| Impact Analyst | Change impact across the graph | Traceability queries, cost model | Impact report |
| Adjudicator | Resolves judge disagreement | Rubric, evidence | Final score, rationale |

### 7.2 Coder adapter contract

All coding agents — DSH's native agent, Claude Code, opencode, Pi, Codex CLI, Gemini CLI, Aider and future entrants — sit behind one contract. The Factory must be able to swap a coder without changing stage logic or prompts beyond the adapter profile.

| ID | Requirement | Pri. |
|---|---|---|
| AR-40 | The adapter interface shall expose: capability discovery, health check, start, event stream, resume, cancel, diff retrieval, usage/cost reporting and artifact collection. | M |
| AR-41 | The capability descriptor shall declare headless mode, structured event format, session resume, tool allowlisting, sandbox support, MCP support, image input, max context, concurrency and cost-reporting fidelity. | M |
| AR-42 | The Factory shall run a conformance suite against every adapter version before enabling it, covering start, stream, cancel, resume, diff, usage and failure reporting. | M |
| AR-43 | Adapters shall be pinned to exact versions, with upgrade rollout gated by the conformance suite and a canary project. | M |
| AR-44 | The Factory shall translate the task contract into each adapter's native prompt/config format, including write scope and verification commands. | M |
| AR-45 | The adapter shall report token usage and cost when the underlying tool exposes it; when it does not, the Factory shall estimate usage and mark it as estimated. | M |
| AR-46 | The adapter shall support cancellation within 10 seconds and shall not leave orphan processes, locks or worktrees. | M |
| AR-47 | Adapter output shall be normalised into a common event model (message, tool call, file edit, test result, usage, error, completion). | M |
| AR-48 | The Factory shall detect adapter failure modes (auth expiry, quota exhaustion, crash, hang, context overflow) and fail over to another configured adapter when policy allows. | M |
| AR-49 | Adapters shall never receive production credentials, protected-branch push rights or the ability to disable required checks. | M |
| AR-50 | The Factory shall record adapter identity and version in every commit trailer and PR description. | S |

### 7.3 Supported and planned adapters

| Adapter | Integration mode | Key capabilities to verify | Status |
|---|---|---|---|
| DSH native | In-process subagent / headless / SDK | Sessions, subagents, MCP, permissions, worktrees | Default |
| Claude Code | Headless CLI with JSON output | Print mode, tool permissions, MCP, resume | Phase 1 |
| opencode | Non-interactive run / server mode | Provider-agnostic models, session control, JSON events | Phase 1 |
| Pi | Print/non-interactive mode | Session resume, tool control, model routing | Phase 2 |
| Codex CLI | Exec mode with JSON | Sandbox modes, approvals, structured output | Phase 2 |
| Gemini CLI | Non-interactive mode | Tool allowlist, JSON output | Phase 2 |
| Aider | Message/script mode | Git-native edits, test integration | Phase 3 |
| Generic HTTP | Customer-implemented endpoint | OpenAPI contract, streaming | Phase 3 |

**Note.** Adapter capability claims must be validated against the installed version; vendor CLIs change frequently. The matrix in the admin UI shall show verified capabilities and the date of verification.

### 7.4 Agent memory and context

**AR-51 (M).** Agents shall have three memory scopes: run-scoped working memory (session), project-scoped durable knowledge (artifact graph + vector index) and organisation-scoped standards (policies, templates, coding standards).

**AR-52 (M).** Memory writes shall be explicit, typed and attributable; an agent may not silently persist a "fact" that later agents treat as ground truth.

**AR-53 (M).** Retrieved context shall carry provenance and freshness, and stale or superseded artifacts shall be excluded by default.

**AR-54 (S).** The system shall detect contradictory memories (for example two active decisions on the same topic) and shall raise a conflict for resolution.

### 7.5 Safety rails

**AR-55 (M).** Agents shall be denied force-push, branch deletion, protected-branch writes, production database access and secret read access unless a stage explicitly grants a scoped capability with approval.

**AR-56 (M).** Destructive operations (delete repository, drop table, rotate credentials, scale to zero) shall require a typed confirmation token issued by the policy engine after human approval.

**AR-57 (M).** The system shall enforce a "kill switch" per run, project and tenant that stops all agent activity within 30 seconds and preserves state.

**AR-58 (S).** The system shall detect runaway loops (repeated identical tool calls, oscillating edits) and terminate the attempt with a diagnostic.

---

## 8. Model gateway and provider strategy

### 8.1 Role

The model gateway is the only path from agents to models. It abstracts providers, enforces budgets and policy, normalises usage and makes routing a configuration decision rather than a code change.

| ID | Requirement | Pri. |
|---|---|---|
| MG-01 | The gateway shall maintain a registry of providers, models, context windows, modalities, price, latency class, rate limits, data-handling terms and supported regions. | M |
| MG-02 | The gateway shall support at minimum: DeepSeek API, Anthropic API, OpenAI API, Azure OpenAI, AWS Bedrock, Google Vertex AI, OpenAI-compatible endpoints, and local runtimes (Ollama, vLLM, llama.cpp, TGI). | M |
| MG-03 | Credentials shall be stored in a secrets manager, scoped per tenant and provider, never logged, and rotatable without downtime. | M |
| MG-04 | Routing shall be declarative and evaluate, in order: hard policy (residency, provider allowlist, data classification), stage/model capability, quality tier, cost ceiling, latency ceiling, then availability. | M |
| MG-05 | The gateway shall support fallback chains with circuit breakers, bounded retries and jitter, and shall never retry a non-idempotent tool call. | M |
| MG-06 | The gateway shall enforce pre-call budget checks and post-call usage accounting, and shall reject a call that would exceed a hard budget. | M |
| MG-07 | Usage shall be normalised across providers (input, cached input, output, reasoning, image, embedding units) and attributed to tenant, project, run, stage, agent and artifact. | M |
| MG-08 | The gateway shall apply data-handling policy: redaction before egress, regional endpoints, no-training attestations, retention settings and provider allowlists per data classification. | M |
| MG-09 | The gateway shall cache responses where semantically safe, keyed by tenant, model, prompt hash and parameters, with explicit TTL and invalidation. | S |
| MG-10 | The gateway shall expose a single OpenAI-compatible surface plus native passthrough for provider-specific features, with capability negotiation. | S |
| MG-11 | The gateway shall support structured output, tool calling and JSON-schema validation with automatic repair attempts bounded to one. | M |
| MG-12 | The gateway shall record prompt version, model version, parameters and response hash for reproducibility, subject to redaction. | M |
| MG-13 | The gateway shall run continuous quality and latency probes per provider and route away from degraded providers automatically. | S |
| MG-14 | The gateway shall support evaluation-based routing: a new model is promoted only after passing the golden-task suite and a shadow canary. | S |

### 8.2 Provider strategy

- **Primary reasoning:** DeepSeek models for orchestration, planning and code, tuned per stage.
- **Secondary/peer review:** at least one independent model family for review panels, to reduce correlated blind spots.
- **Long-context and multimodal:** routed only where the task requires it, because of cost.
- **Local/private:** required for air-gapped tenants and for artifacts classified `restricted`; local models are first-class providers, not a degraded fallback.
- **Embeddings and reranking:** a dedicated embedding model, versioned; re-embedding is a migration with a shadow index.

### 8.3 Routing policy dimensions

| Dimension | Example policy |
|---|---|
| Stage | Architecture uses a high-reasoning tier; classification uses a small model |
| Risk tier | R4 review panels require three judges from two provider families |
| Data classification | `restricted` artifacts route only to local or private endpoints |
| Cost ceiling | Background documentation work capped at a low-cost tier |
| Latency ceiling | Interactive review summaries must return in < 10 s p95 |
| Availability | Fallback to a secondary provider after two consecutive failures |
| Residency | EU tenants route to EU endpoints only |

### 8.4 Claude Enterprise subscription and similar agreements

**MG-15 (M).** Where a customer holds an enterprise subscription (for example Claude Enterprise), the Factory shall use only the authentication and access methods the vendor authorises for programmatic use, and shall record the customer's attestation that its use complies with the subscription terms.

**MG-16 (M).** Seat-based subscriptions shall not be pooled, shared across unauthorised users, or used to circumvent per-seat limits; concurrency shall be capped at the contracted entitlement.

**MG-17 (M).** If the vendor's terms do not permit the intended automation, the Factory shall fall back to API or cloud-provider access and shall surface the limitation in the admin console rather than silently degrading.

**MG-18 (S).** The gateway shall support per-provider quota borrowing within a tenant only when the provider's terms explicitly allow it.

### 8.5 Model lifecycle

**MG-19 (M).** Every model used in production shall have an owner, an approval date, an evaluation result, a deprecation date and a migration plan.

**MG-20 (S).** The system shall detect model drift by re-running the golden suite on a schedule and comparing quality, cost and latency against the approved baseline.

---

## 9. Token and cost economy

Token efficiency is a product requirement, not an optimisation. The target is a ≥ 40% reduction against a naive "paste everything into the largest model" baseline at equal or better artifact quality.

### 9.1 Requirements

| ID | Requirement | Pri. |
|---|---|---|
| TE-01 | Every stage, task and run shall have a token and cost budget with warning at 80%, hard pause at 100%, and an explicit human decision to extend. | M |
| TE-02 | Context shall be assembled from a declared manifest (artifacts, retrieval results, repository map, tool outputs) with per-item token accounting, and the manifest shall be stored with the attempt. | M |
| TE-03 | The system shall use repository maps and symbol-level retrieval rather than whole-file or whole-repository inclusion, and shall cap each file's contribution by relevance. | M |
| TE-04 | Artifacts shall be referenced by ID and summary in prompts, and expanded only when the task requires their full content. | M |
| TE-05 | Retrieval shall use hybrid search (lexical + vector), deduplication, reranking and a relevance floor; low-relevance chunks shall be dropped rather than padded into the prompt. | M |
| TE-06 | Long conversations shall be compacted hierarchically: decisions and open questions are preserved verbatim, narrative is summarised, and raw tool output is replaced by references. | M |
| TE-07 | Prompts shall be ordered for provider prompt caching (stable system and standards first, volatile task content last), and the gateway shall report cache-hit rates. | M |
| TE-08 | The system shall route by difficulty: a cheap triage model first, escalation to a stronger model only on low confidence, failed validation or high risk. | M |
| TE-09 | Structured outputs with schema validation shall be used to reduce retries, and a failed validation shall trigger at most one repair attempt before escalation. | M |
| TE-10 | Reviews shall be diff-based: only changed content and its direct dependencies are sent to reviewers, with prior context summarised. | M |
| TE-11 | Embeddings shall be computed once per content hash, batched, and reused; re-embedding shall be incremental. | M |
| TE-12 | Judge panels shall scale with risk (one judge for low risk, three for high), and shall review only the delta on revision cycles. | M |
| TE-13 | Parallel or speculative agent execution shall be permitted only when the expected value exceeds the marginal token cost, as determined by policy. | S |
| TE-14 | The system shall maintain a token ledger with per-call records and shall alert on anomalies (cost per artifact up 50% week-over-week, retry rate above 10%, cache hit below 40%). | M |
| TE-15 | The system shall expose a "frugal mode" that lowers model tiers, reduces panel size and disables non-essential enrichment when a budget threshold is reached. | S |
| TE-16 | Batch and off-peak pricing shall be used for non-interactive work (indexing, bulk documentation, nightly regression analysis) where quality is unaffected. | S |
| TE-17 | The system shall report tokens per artifact, per requirement, per merged PR and per story point, and shall benchmark these against the baseline. | S |
| TE-18 | Context poisoning defences shall prevent earlier incorrect agent output from being re-ingested as authoritative context without review status. | M |

### 9.2 Techniques and expected effect

| Technique | Where applied | Expected saving |
|---|---|---|
| Prompt caching of stable prefixes | All stages | 30–60% of input tokens |
| Repository map + symbol retrieval | Development, review | 50–80% versus whole-repo context |
| Artifact referencing and lazy expansion | All stages | 20–40% |
| Hierarchical compaction | Long runs, incident analysis | 40–70% of conversation tokens |
| Model cascade | Triage, review, docs | 30–50% of cost |
| Diff-based review and re-review | PR review, revision loops | 40–60% |
| Response and embedding caches | Repeated queries, re-indexing | 20–50% |
| Structured output + single repair | All structured stages | 10–25% fewer retries |
| Risk-scaled judge panels | Review service | 30–60% of review cost |
| Budget-aware scheduling | Background work | 10–30% via batch pricing |

Figures are planning estimates to be validated in the pilot; the ledger, not the table, is the source of truth.

### 9.3 Cost governance

**TE-19 (M).** Costs shall be attributable to tenant, portfolio, project, run, stage, artifact and agent, and shall be exportable for chargeback.

**TE-20 (M).** The system shall enforce per-tenant and per-project monthly envelopes, with approval workflow for increases and automatic frugal mode at 90% consumption.

**TE-21 (S).** The system shall forecast month-end spend from current burn and alert the owner when the forecast exceeds the envelope by 15%.

**TE-22 (S).** The system shall identify the top ten cost drivers each week and propose concrete reductions with estimated savings.

---

## 10. Data architecture

### 10.1 Storage responsibilities

| Store | Responsibility | Durability |
|---|---|---|
| PostgreSQL | System of record: tenants, projects, runs, artifacts, reviews, decisions, budgets, policies, integration links, audit | Durable, ACID, PITR |
| Redis | Caching, distributed locks, rate-limit counters, idempotency keys, short-lived session state, presence | Ephemeral, reconstructable |
| RabbitMQ | Durable work queues, domain event fan-out, retries and dead-lettering | Durable with quorum queues |
| Qdrant | Embeddings for artifacts, code chunks, tickets, threads, decisions; semantic retrieval | Durable with snapshots and rebuild path |
| Object storage (S3-compatible) | Artifact payloads, rendered documents, screenshots, recordings, logs, exports | Versioned, immutable, encrypted |
| Search index (optional) | Full-text and faceted search across artifacts and code | Rebuildable from source |

### 10.2 PostgreSQL

**DR-01 (M).** PostgreSQL shall be the authoritative store for all state that must survive a restart, and every table shall carry `tenant_id`, `created_at`, `updated_at` and an optimistic-locking `version`.

**DR-02 (M).** Tenant isolation shall be enforced with row-level security in addition to application-level filters; a connection without a tenant context shall see no tenant rows.

**DR-03 (M).** Run and stage state shall be event-sourced (append-only `run_events` table) with materialised projections for current state; projections shall be rebuildable by replay.

**DR-04 (M).** Large payloads (documents, images, test artifacts) shall live in object storage and be referenced by URI and content hash; PostgreSQL shall store metadata, not blobs over 1 MB.

**DR-05 (M).** Schema changes shall use forward-only migrations with expand/contract, be tested against a production-sized snapshot, and be reversible or accompanied by a documented rollback.

**DR-06 (S).** Analytics and reporting shall read from a replica or warehouse, never from the primary under load.

**Schema areas.** `identity`, `portfolio`, `execution`, `artifacts`, `review`, `planning`, `integration`, `governance`, `operations`, `config`, `audit`.

Core tables include: `tenants`, `users`, `roles`, `memberships`, `projects`, `blueprints`, `runs`, `run_events`, `stages`, `work_items`, `attempts`, `checkpoints`, `artifacts`, `artifact_versions`, `artifact_links`, `reviews`, `findings`, `decisions`, `requirements`, `acceptance_criteria`, `tasks`, `estimates`, `milestones`, `changes`, `connections`, `external_refs`, `sync_cursors`, `webhook_deliveries`, `policies`, `waivers`, `budgets`, `cost_entries`, `deployments`, `incidents`, `alerts`, `config_versions`, `prompt_versions`, `audit_log`.

### 10.3 Redis

**DR-07 (M).** Redis shall never be the sole store of any durable fact; loss of Redis shall degrade performance, not correctness.

**DR-08 (M).** Distributed locks shall use fencing tokens and bounded TTLs; a lock loss shall not corrupt an artifact or duplicate a side effect.

**DR-09 (M).** Rate limiting and idempotency keys shall be enforced in Redis with atomic operations, and shall fall back to database enforcement when Redis is unavailable.

**DR-10 (S).** Cache entries shall be namespaced by tenant and schema version, and invalidated by artifact version change events rather than by time alone.

### 10.4 RabbitMQ

**DR-11 (M).** The broker shall use durable quorum queues, publisher confirms and consumer acknowledgements; no auto-ack for work queues.

**DR-12 (M).** Topology shall be: a topic exchange `aif.events` for domain events, a direct exchange `aif.jobs` for work, per-consumer retry queues with TTL and dead-letter exchange, and one dead-letter queue per consumer with an alert.

**DR-13 (M).** Message envelopes shall carry `event_id`, `tenant_id`, `run_id`, `correlation_id`, `causation_id`, `schema_version`, `occurred_at` and `attempt`.

**DR-14 (M).** Consumers shall be idempotent and shall use the transactional outbox pattern for database writes plus publishes.

**DR-15 (S).** Queue depth, consumer lag, retry rate and DLQ growth shall be first-class metrics with alerts.

**Event classes.** `run.*`, `stage.*`, `artifact.*`, `review.*`, `task.*`, `pr.*`, `test.*`, `deployment.*`, `incident.*`, `alert.*`, `integration.*`, `budget.*`, `policy.*`.

### 10.5 Qdrant

**DR-16 (M).** Vector collections shall be partitioned by tenant (collection or payload index) and filtered by `project_id`, `artifact_type`, `classification`, `status` and `version`.

**DR-17 (M).** Embeddings shall be versioned by model and chunking strategy; a model change requires a shadow collection, backfill and evaluation before cut-over.

**DR-18 (M).** Deleted or superseded artifacts shall be removed from retrieval within the configured freshness window, and the deletion shall be verifiable.

**DR-19 (M).** Qdrant shall support snapshot and restore, and the platform shall be able to rebuild the entire index from PostgreSQL and object storage.

**DR-20 (S).** Retrieval quality shall be monitored (recall on a labelled set, zero-result rate) and degraded retrieval shall raise a platform alert.

### 10.6 Retention and deletion

**DR-21 (M).** Retention shall be configurable per artifact class and tenant, with defaults: artifacts and decisions 7 years or contract term; run events 2 years; prompts and raw model I/O 1 year; chat/e-mail derived content 90 days; telemetry 13 months.

**DR-22 (M).** Deletion shall be verifiable across PostgreSQL, Qdrant, object storage and caches, and shall produce a deletion certificate for personal-data erasure requests.

**DR-23 (M).** Legal hold shall override retention and deletion, and shall be auditable.

### 10.7 Backup and recovery

**DR-24 (M).** PostgreSQL shall use continuous archiving with point-in-time recovery (RPO ≤ 5 minutes), tested by a quarterly restore drill.

**DR-25 (M).** Object storage shall enable versioning and cross-region replication where residency permits; Qdrant snapshots shall be taken daily and retained for 30 days.

**DR-26 (M).** Restore runbooks shall be documented and exercised; the measured RTO shall be reported after each drill.

---

## 11. Integrations

### 11.1 Connector framework

| ID | Requirement | Pri. |
|---|---|---|
| IR-01 | Every integration shall be implemented as a connector plugin with a declared capability set, auth type, scopes, rate limits and health check. | M |
| IR-02 | Inbound webhooks shall verify signatures, reject replays outside a 5-minute window, and deduplicate by delivery ID. | M |
| IR-03 | Every webhook-driven integration shall also run scheduled reconciliation, so that missed events self-heal within one reconciliation interval (default 15 minutes). | M |
| IR-04 | Connectors shall respect provider rate limits with token-bucket limiting, `Retry-After` handling, batching and priority queues. | M |
| IR-05 | Field and status mapping shall be configurable per project, with validation, preview and version history. | M |
| IR-06 | Outbound writes shall be idempotent, audited with before/after state, and reversible where the provider supports it. | M |
| IR-07 | Each connector shall offer a sandbox/test mode and a dry-run mode that produces the payload without sending it. | S |
| IR-08 | Credentials shall be stored in the secrets manager, scoped to the minimum scopes, and never exposed to agents or logs. | M |
| IR-09 | Connector failures shall be isolated: one failing integration shall not block unrelated runs, and shall surface as a project health alert. | M |
| IR-10 | Integration events shall be traced end to end with correlation IDs and visible in the project timeline. | S |

### 11.2 Git hosts

| ID | Requirement | Pri. |
|---|---|---|
| IR-11 | The system shall support GitHub, GitLab, Bitbucket Cloud/Data Center and Azure Repos for repository, branch, commit, PR and check operations. | M |
| IR-12 | The system shall create and protect branches, require status checks, enforce signed commits where configured, and never bypass protection outside the break-glass path. | M |
| IR-13 | The system shall receive push, PR, review, check-run and merge events, and shall reconcile PR state on a schedule. | M |
| IR-14 | The system shall map repositories to projects and components, and shall support monorepos with path-based ownership and scoped tasks. | M |
| IR-15 | The system shall support Git worktrees or isolated clones per task, with deterministic cleanup and orphan detection. | M |

### 11.3 Jira

| ID | Requirement | Pri. |
|---|---|---|
| IR-16 | The system shall support Jira Cloud (REST API v3, OAuth 2.0 3LO or app) and Jira Data Center (PAT or OAuth), with capability differences surfaced in the UI. | M |
| IR-17 | The system shall synchronise issues, comments, attachments, links, sprints, epics and transitions, mapping project-specific issue types and custom fields. | M |
| IR-18 | The system shall honour workflow rules: it may only transition an issue to a state allowed by the workflow and permitted for the acting identity. | M |
| IR-19 | The system shall link issues to requirements, tasks, PRs, deployments and incidents, and shall keep link direction consistent. | M |
| IR-20 | The system shall not overwrite human edits silently; conflicting field changes shall produce a conflict record and a human decision. | M |

### 11.4 Azure DevOps

| ID | Requirement | Pri. |
|---|---|---|
| IR-21 | The system shall integrate with Azure DevOps Boards (work items, area and iteration paths, queries), Repos (PRs, policies, branch protection) and Pipelines (definitions, runs, approvals, environments). | M |
| IR-22 | The system shall use Microsoft Entra ID OAuth or a scoped PAT, with organisation/project scoping and least-privilege scopes. | M |
| IR-23 | The system shall support Azure DevOps Test Plans for manual and automated test linkage where the customer uses them. | S |
| IR-24 | The system shall reconcile work item state, PR policy status and pipeline outcomes, and shall detect policy bypass attempts. | M |
| IR-25 | The system shall support Azure Artifacts feeds for package consumption and publication where configured. | C |

### 11.5 CI/CD and cloud

| ID | Requirement | Pri. |
|---|---|---|
| IR-26 | The system shall support GitHub Actions, GitLab CI, Azure Pipelines and Jenkins for pipeline generation, triggering, status and log retrieval. | M |
| IR-27 | The system shall authenticate to cloud providers using OIDC federation or workload identity, never long-lived keys, and shall scope roles to the target environment. | M |
| IR-28 | The system shall read deployment, environment and approval state from the CI/CD system and reconcile it with its deployment records. | M |
| IR-29 | The system shall support at least one major cloud (AWS, Azure or GCP) for infrastructure provisioning; additional clouds are connector plugins. | M |

### 11.6 Gmail and Google Chat

| ID | Requirement | Pri. |
|---|---|---|
| IR-30 | Gmail integration shall use OAuth 2.0 with `gmail.readonly` or `gmail.metadata` for monitoring, `gmail.compose` for drafts, and `gmail.send` only when outbound sending is explicitly enabled; domain-wide delegation shall require super-admin consent and explicit mailbox allowlisting. | M |
| IR-31 | Gmail ingestion shall use push notifications via Cloud Pub/Sub with `historyId` checkpoints, plus a periodic `users.history.list` reconciliation for missed messages. | M |
| IR-32 | Google Chat integration shall use the Chat API and Workspace Events API with app authentication, subscribing only to spaces where the app is installed, and shall request read-only scopes by default. | M |
| IR-33 | The system shall store the minimum message content needed for classification and summarisation; attachments shall be referenced, not copied, unless explicitly enabled. | M |
| IR-34 | All Gmail/Chat data shall be classified, redacted, encrypted and subject to tenant-configurable retention; content shall never be used for model training. | M |
| IR-35 | Outbound chat messages and e-mail drafts shall require human approval by default, with an explicit, audited exception for internal notification channels. | M |
| IR-36 | The system shall support mailbox/space exclusion lists, DLP label awareness and legal hold. | S |

### 11.7 Identity and collaboration

| ID | Requirement | Pri. |
|---|---|---|
| IR-37 | The platform shall support OIDC and SAML 2.0 single sign-on, SCIM 2.0 provisioning/deprovisioning, and just-in-time role assignment. | M |
| IR-38 | The platform shall support Slack and Microsoft Teams as optional notification and approval channels, with the same approval semantics and audit as the web cockpit. | S |
| IR-39 | Chat approvals shall be binding only when the approver's identity is strongly verified and the decision includes the evidence digest. | M |

### 11.8 Cross-system interrogation

"Interrogation" is the read-only ability to ask questions across Git, Jira, Azure DevOps, CI/CD and the artifact graph in natural language or structured query form — for example "what changed in authentication since the last release?" or "which open issues block the payments milestone?".

| ID | Requirement | Pri. |
|---|---|---|
| IR-40 | The system shall answer natural-language and structured queries across linked Git, tracker, CI/CD and artifact data, returning a synthesised answer with citations to the underlying records. | S |
| IR-41 | Query results shall respect the caller's permissions at row and artifact level; a user shall never see a citation they could not open directly. | M |
| IR-42 | The system shall support saved queries, scheduled digests and dashboard widgets built from interrogation results. | S |
| IR-43 | Interrogation shall be read-only by default; any resulting write action shall go through the normal approval path and be recorded as a change. | M |
| IR-44 | Answers shall state data freshness ("as of" timestamp per source) and shall refuse to answer when the required source is stale beyond its freshness budget. | S |

### 11.9 Integration matrix

| System | Direction | Protocol | Reconciliation | Priority |
|---|---|---|---|---|
| GitHub / GitLab / Bitbucket / Azure Repos | Read/write | REST + webhooks | 15 min | M |
| Jira Cloud / Data Center | Read/write | REST v3 / webhooks | 15 min | M |
| Azure DevOps Boards/Repos/Pipelines | Read/write | REST + service hooks | 15 min | M |
| GitHub Actions / GitLab CI / Azure Pipelines / Jenkins | Read/write | REST + webhooks | 15 min | M |
| AWS / Azure / GCP | Write | OIDC + native APIs | On demand | M |
| Gmail | Read (write optional) | Google Workspace API + Pub/Sub | 15 min | M |
| Google Chat | Read/write | Chat API + Workspace Events | 15 min | M |
| Slack / Teams | Write | Web API / Bot Framework | 5 min | S |
| Identity provider | Read | OIDC/SAML/SCIM | 1 h | M |
| Observability stack | Read | OTLP / vendor APIs | 1 min | S |

---

## 12. Security, privacy and compliance

### 12.1 Identity and access

| ID | Requirement | Pri. |
|---|---|---|
| SR-01 | All human access shall use SSO with MFA; local accounts shall be disabled by default and break-glass accounts shall be audited and time-bound. | M |
| SR-02 | The platform shall implement role-based access control with at least: Platform Admin, Tenant Admin, Portfolio Manager, Project Owner, Engineer, Reviewer, Auditor, Viewer. | M |
| SR-03 | Access shall additionally be constrained by project membership and artifact classification (ABAC), so that a role alone never grants cross-project access. | M |
| SR-04 | Service-to-service calls shall use mutual TLS or signed short-lived tokens, with per-service identity and least privilege. | M |
| SR-05 | API keys and personal access tokens shall be scoped, expiring, revocable and displayed only once. | M |

### 12.2 Secrets and encryption

| ID | Requirement | Pri. |
|---|---|---|
| SR-06 | Secrets shall be stored in a dedicated secrets manager (Vault, cloud KMS-backed store) and injected at runtime; secrets shall never appear in prompts, logs, artifacts or Git. | M |
| SR-07 | Data shall be encrypted in transit (TLS 1.2+) and at rest (AES-256), with per-tenant key options and documented key rotation. | M |
| SR-08 | Agent sandboxes shall receive only short-lived, task-scoped credentials with the minimum permissions required. | M |
| SR-09 | Secret scanning shall run on every commit, artifact and generated document, and shall block on detection. | M |

### 12.3 Tenant isolation and audit

| ID | Requirement | Pri. |
|---|---|---|
| SR-10 | Tenant isolation shall be verified by automated tests that attempt cross-tenant reads and writes through every API and connector. | M |
| SR-11 | Audit records shall be append-only, tamper-evident (hash chain or signed batches), retained per policy, and exportable. | M |
| SR-12 | Every privileged action (role change, policy change, credential use, break-glass, data export, deletion) shall produce an audit event with actor, target and reason. | M |

### 12.4 AI-specific threats

| ID | Requirement | Pri. |
|---|---|---|
| SR-13 | The system shall treat all retrieved content — code, documents, tickets, e-mail, chat, web pages — as untrusted data and shall not follow instructions embedded in it. | M |
| SR-14 | Tool access shall be allowlisted per stage and enforced by the runtime, not solely by prompt instructions; filesystem, network and shell permissions shall be explicit. | M |
| SR-15 | The system shall defend against prompt injection with instruction hierarchy, content provenance labelling, output validation and egress filtering. | M |
| SR-16 | Agents shall be prevented from exfiltrating data through URLs, images, markdown links or tool calls; outbound destinations shall be allowlisted and payloads inspected. | M |
| SR-17 | Model output that triggers a privileged action shall require deterministic validation plus human approval; model confidence alone is never sufficient. | M |
| SR-18 | The platform shall maintain an AI bill of materials: models, versions, prompts, tools, adapters and data flows used per stage. | S |

### 12.5 Sandbox and supply chain

| ID | Requirement | Pri. |
|---|---|---|
| SR-19 | Agent execution shall use hardened sandboxes (gVisor, Firecracker or equivalent) with no privileged containers, enforced seccomp profiles, read-only root filesystems and bounded resources. | M |
| SR-20 | Dependencies and base images shall be pinned, scanned and sourced from allowlisted registries; builds shall produce an SBOM and signed provenance. | M |
| SR-21 | CI/CD actions and plugins shall be pinned to commit SHAs, reviewed before use, and denied network access unless required. | M |
| SR-22 | The platform shall run SAST, dependency, container and IaC scanning on its own codebase, with the same blocking thresholds it imposes on customers. | M |

### 12.6 Privacy and data protection

| ID | Requirement | Pri. |
|---|---|---|
| SR-23 | The platform shall maintain a record of processing activities, data classification, lawful basis and retention per data category. | M |
| SR-24 | Personal data shall be minimised, redacted before model egress where required, and deletable on request with a verifiable certificate. | M |
| SR-25 | Model providers shall be contractually prohibited from training on tenant data; zero-retention endpoints shall be used where available and required. | M |
| SR-26 | Cross-border transfers shall respect tenant residency policy, with provider and region visible per run. | M |
| SR-27 | Gmail and Chat monitoring shall be opt-in per mailbox or space, with an employee notice template and an exclusion mechanism. | M |

### 12.7 Generated code and IP

| ID | Requirement | Pri. |
|---|---|---|
| SR-28 | The platform shall scan generated code and dependencies for licence obligations and flag incompatible or unknown licences before merge. | M |
| SR-29 | The platform shall record the model, provider and prompt lineage of generated code so that provenance questions can be answered. | S |
| SR-30 | The platform shall not reproduce large verbatim copyrighted sources; similarity checks shall run against a configured corpus where the provider permits. | S |

### 12.8 Compliance and assurance

| ID | Requirement | Pri. |
|---|---|---|
| SR-31 | The platform shall map controls to SOC 2, ISO/IEC 27001 and GDPR, and to sector regimes (for example HIPAA, PCI DSS) through configurable control packs. | S |
| SR-32 | The platform shall support independent penetration testing at least annually and shall track remediation to closure. | M |
| SR-33 | The platform shall provide audit evidence exports (access, decisions, deployments, model usage) in machine-readable form. | M |
| SR-34 | The platform shall maintain a vulnerability disclosure policy and a security incident response plan with defined notification timelines. | M |

---

## 13. Non-functional requirements

| ID | Requirement and target | Pri. |
|---|---|---|
| NFR-01 | Interactive API latency: p95 ≤ 300 ms, p99 ≤ 800 ms for control-plane reads and writes, excluding long-running operations. | M |
| NFR-02 | Cockpit initial load ≤ 2 s p95 on a 10 Mbps connection; route transitions ≤ 500 ms. | M |
| NFR-03 | A stage shall begin executing within 30 s of its dependencies being satisfied, excluding deliberate human gates and queue backpressure. | M |
| NFR-04 | A domain event shall be visible on the dashboard within 5 s p95. | M |
| NFR-05 | Scale: 200 tenants, 2,000 active projects, 5,000 runs/day, 20,000 tasks/day, 1 million artifacts, 10 million events/day, with burst handling to 500 events/s. | M |
| NFR-06 | Control-plane availability ≥ 99.9% monthly; cockpit ≥ 99.5%; degradation shall be graceful and visible. | M |
| NFR-07 | Durability: RPO ≤ 5 minutes, RTO ≤ 1 hour; committed artifacts and decisions shall never be lost. | M |
| NFR-08 | Search and retrieval freshness: index lag ≤ 60 s after artifact approval. | S |
| NFR-09 | Observability: every run, stage, agent call and integration call shall emit OpenTelemetry traces, metrics and structured logs with correlation IDs. | M |
| NFR-10 | Maintainability: modular packages with contract tests; platform code coverage ≥ 80% lines; critical modules mutation score ≥ 60%. | S |
| NFR-11 | Portability: Kubernetes and Docker Compose deployment; no hard dependency on a single cloud; managed-service adapters for PostgreSQL, RabbitMQ, Redis, Qdrant and object storage. | M |
| NFR-12 | Upgradeability: zero-downtime minor upgrades; major upgrades with documented migration and rollback; N-1 application compatibility with the database. | M |
| NFR-13 | Accessibility: WCAG 2.2 AA for the cockpit, including keyboard-only operation and screen-reader support for review flows. | M |
| NFR-14 | Localisation: all user-facing strings externalised; English and one additional locale at launch; UTC storage with per-user time-zone display; RTL-ready layout. | S |
| NFR-15 | Browser support: current and previous major versions of Chrome, Edge, Firefox and Safari. | S |
| NFR-16 | Usability: a trained reviewer shall complete a standard review decision in ≤ 3 minutes median; task success rate ≥ 90% in usability testing. | S |
| NFR-17 | Supportability: one-click diagnostic bundle with redacted logs, configuration and run state; documented runbooks for every platform alert. | M |
| NFR-18 | Platform overhead: infrastructure cost of the Factory itself ≤ 15% of total project run cost at scale. | C |
| NFR-19 | Security patching: critical vulnerabilities remediated within 7 days, high within 30 days, with an audited exception path. | M |
| NFR-20 | API compatibility: breaking changes require a new major version and 12 months' deprecation notice. | M |
| NFR-21 | Concurrency: default 50 concurrent agent tasks per project and 1,000 globally, configurable with fair scheduling. | S |
| NFR-22 | Kill switch: all agent activity for a run, project or tenant stops within 30 s of activation. | M |
| NFR-23 | Data freshness for cost dashboards: ≤ 5 minutes from model call to ledger entry. | S |
| NFR-24 | Recovery drills: restore and failover tested quarterly with results published to tenant admins. | S |

---

## 14. Configuration and modularity

### 14.1 Configuration model

**CR-01 (M).** Configuration shall be layered with deterministic precedence: platform defaults → tenant → portfolio → blueprint → project → stage override → run override. The effective value and its source shall be inspectable at every level.

**CR-02 (M).** Every configuration object shall have a typed schema (JSON Schema or equivalent), be validated on save and on load, and produce actionable errors with a JSON Pointer to the offending field.

**CR-03 (M).** Configuration shall be versioned, diffable and rollback-able; changes to gates, thresholds, autonomy and security policy shall require approval and shall produce an audit event.

**CR-04 (M).** The lifecycle itself shall be configuration: stages, order, gates, artifacts, agents, prompts, budgets and thresholds shall be declared in versioned lifecycle definitions, not hard-coded.

**CR-05 (M).** Tenants shall be able to tune values only within platform-defined safe bounds; security, privacy and audit floors shall not be lowerable by tenant configuration.

**CR-06 (M).** Blueprints shall support inheritance and composition, so a project can adopt "regulated web application" and override only what differs.

**CR-07 (M).** Feature flags shall be scoped by tenant, project, environment and user cohort, with an owner and an expiry date; expired flags shall be reported for cleanup.

**CR-08 (M).** Prompts shall be versioned artifacts with an owner, evaluation result, rollout state and rollback target; production prompts shall not be edited in place.

**CR-09 (M).** Policies (autonomy, approvals, security, data handling, budgets) shall be expressed in a policy language (OPA/Rego, Cedar or equivalent), tested with policy unit tests, and evaluated by a single policy decision point.

**CR-10 (M).** Plugins shall be registered with a signed manifest declaring version, capabilities, required permissions, configuration schema and compatibility range; unsigned plugins shall not load in production.

**CR-11 (S).** Configuration changes shall support dry-run and impact preview (which projects, stages and gates are affected) before activation.

**CR-12 (S).** Configuration shall be exportable to and importable from Git (GitOps), with drift detection between Git and the running platform.

**CR-13 (S).** Secrets shall be referenced, never embedded, in configuration; a configuration containing a secret-shaped value shall fail validation.

### 14.2 Modularity

**CR-14 (M).** The platform shall be composed of independently deployable modules: identity, orchestration, stage runtime, agent runtime, model gateway, connectors, review service, cost service, search, notifications and cockpit.

**CR-15 (M).** A module may be replaced by a customer implementation if it satisfies the published contract and conformance suite.

**CR-16 (M).** Modules shall communicate only through published APIs, events or the shared data contracts; no module shall read another module's private tables.

**CR-17 (S).** The platform shall support a "minimal profile" for evaluation (single node, embedded queue, no vector store) and a "scale profile" for production, from the same codebase.

**CR-18 (S).** Every module shall expose health, metrics, configuration schema and version information through a standard endpoint.

### 14.3 Extension points

| Extension point | What a tenant can change without code | Contract |
|---|---|---|
| Lifecycle definition | Stage order, gates, artifacts, budgets, thresholds | Lifecycle schema |
| Stage plugin | Add, replace or disable a stage | Stage Contract (§6.3) |
| Agent role | Prompt, tools, model tier, output schema | Agent role manifest |
| Coder adapter | Add or swap a coding agent | Adapter Contract (§7.2) |
| Model route | Providers, fallbacks, budgets, residency | Routing policy schema |
| Connector | Add or replace a Git, tracker, CI or chat integration | Connector Contract (§11.1) |
| Policy pack | Autonomy, approvals, security and data rules | Policy schema and tests |
| Review rubric | Dimensions, weights, anchors, pass rule | Rubric schema (Appendix B) |
| Notification channel | E-mail, chat, webhook, in-app | Notification schema |
| Storage backend | Managed or self-hosted PostgreSQL, Redis, RabbitMQ, Qdrant, object storage | Storage contract |
| Cockpit widget | Portfolio and project views | Widget manifest and permission model |

---

## 15. API and event contract

### 15.1 API principles

| ID | Requirement | Pri. |
|---|---|---|
| API-01 | The public API shall be REST over HTTPS with JSON, described by OpenAPI 3.1 and published in the developer portal. | M |
| API-02 | Authentication shall support OAuth 2.0 (authorization code and client credentials) and scoped API tokens; every request shall be authorised against tenant, project and artifact classification. | M |
| API-03 | Mutating requests shall accept an `Idempotency-Key`; a replay with the same key and body shall return the original result, and a replay with a different body shall return `409`. | M |
| API-04 | Collections shall use cursor pagination with a stable sort and a maximum page size of 200. | M |
| API-05 | Errors shall use RFC 9457 `application/problem+json` with `type`, `title`, `status`, `detail`, `instance` and a machine-readable `code`. | M |
| API-06 | The API shall be versioned in the path (`/v1`); additive changes are allowed within a version, breaking changes require a new major version. | M |
| API-07 | Rate limits shall be published per plan and returned in `RateLimit-*` headers, with `429` and `Retry-After` on exhaustion. | M |
| API-08 | Webhooks shall be signed with HMAC-SHA256, include a timestamp and delivery ID, retry with backoff for 24 hours, and expose a delivery log. | M |
| API-09 | The API shall expose a server-sent events stream for run, stage, gate and alert updates, with resumable `Last-Event-ID`. | M |
| API-10 | SDKs for TypeScript and Python shall be generated from OpenAPI and tested against the contract in CI. | S |
| API-11 | The CLI shall offer parity with the API for all operator workflows, including run control, gate decisions and cost queries. | S |
| API-12 | Bulk operations (approve, assign, export) shall be supported with per-item results and partial-failure semantics. | C |
| API-13 | Every API call shall be attributable to an actor and recorded in the audit log when it changes state. | M |
| API-14 | API deprecations shall be announced in the changelog, instrumented by client, and enforced no earlier than 12 months after announcement. | S |

### 15.2 Key resources

| Resource | Purpose |
|---|---|
| `/v1/projects` | Create, configure, archive projects; bind integrations |
| `/v1/projects/{id}/runs` | Start, pause, resume, cancel, fork runs |
| `/v1/runs/{id}/stages` | Stage state, attempts, budgets |
| `/v1/artifacts` | Create, version, retrieve, diff, link artifacts |
| `/v1/reviews` | Submit, assign, decide, appeal reviews |
| `/v1/gates/{id}/decisions` | Record a gate decision with evidence |
| `/v1/tasks` | Task DAG, assignment, execution status |
| `/v1/deployments` | Deployment records, approvals, rollback |
| `/v1/alerts` | Project alerts from tickets, chat, e-mail and operations |
| `/v1/costs` | Cost and token ledger queries and forecasts |
| `/v1/config` | Effective configuration, versions, dry-run |
| `/v1/plugins` | Registry, enable/disable, capability inspection |
| `/v1/search` | Hybrid search across artifacts, decisions, code and threads |
| `/v1/audit` | Audit query and export |

### 15.3 Event catalog

| Event | Producer | Key consumers | Payload highlights |
|---|---|---|---|
| `run.created` | Orchestrator | Scheduler, dashboard, audit | project, blueprint, autonomy, budget |
| `stage.started` | Stage runtime | Dashboard, cost ledger, audit | stage, attempt, agent role, model policy |
| `stage.completed` | Stage runtime | Orchestrator, dashboard | outputs, duration, token usage, verdict |
| `stage.blocked` | Stage runtime | Orchestrator, notifier | reason, required human action, SLA |
| `artifact.created` | Artifact service | Indexer, review service, traceability | type, version, hash, provenance |
| `artifact.approved` | Review service | Orchestrator, indexer, audit | approver, evidence digest, baseline |
| `review.decided` | Review service | Orchestrator, dashboard, audit | decision, findings, rating, rationale |
| `task.completed` | Agent runtime | Orchestrator, planner, cost ledger | diff, tests, tokens, adapter |
| `pr.opened` / `pr.merged` | Git connector | Review service, traceability, dashboard | repo, PR, risk score, checks |
| `test.completed` | QA service | Gate evaluator, dashboard | suite, pass rate, coverage, evidence |
| `deployment.started` / `deployment.completed` | Release service | Dashboard, SRE, audit | environment, strategy, artifact digest, result |
| `incident.opened` / `incident.resolved` | Operations service | Dashboard, notifier, change service | severity, service, impact, commander |
| `alert.raised` | Comms/ticket/ops | Dashboard, notifier | source, confidence, project, suggested action |
| `budget.threshold_reached` | Cost service | Orchestrator, notifier | scope, threshold, forecast, action taken |
| `policy.violated` | Policy engine | Orchestrator, security, audit | policy, actor, resource, remediation |

**API-15 (M).** Event schemas shall be versioned, registered in a schema registry, and validated by producers and consumers; incompatible changes require a new event version and a migration window.

### 15.4 Webhook subscriptions

**API-16 (S).** Tenants shall be able to subscribe to any event class with filters (project, stage, severity), a delivery endpoint, a secret and a retry policy; failed deliveries shall be visible and replayable.

---

## 16. Quality assurance framework

### 16.1 Quality model

Quality is evaluated across nine attributes: **functional correctness, security, performance, reliability, maintainability, usability, accessibility, compliance, and documentation**. Each attribute has explicit gates at the relevant stage; no release may trade an attribute away without an approved waiver.

### 16.2 Quality gates and default thresholds

| ID | Gate | Default threshold | Applies |
|---|---|---|---|
| QR-01 | Build and type check | 100% pass, zero errors | Every PR |
| QR-02 | Unit test coverage, changed lines | ≥ 80% | Every PR |
| QR-03 | Unit test coverage, module overall | ≥ 70% | Every PR |
| QR-04 | Mutation score, critical modules | ≥ 60% | Auth, payments, pricing, crypto, migrations |
| QR-05 | Static analysis | 0 blocker, 0 critical; major ≤ agreed baseline | Every PR |
| QR-06 | SAST | 0 high, 0 critical | Every PR |
| QR-07 | Dependency and container vulnerabilities | 0 critical; high with no fix requires waiver | Every PR and nightly |
| QR-08 | Secret scanning | 0 findings | Every commit and artifact |
| QR-09 | DAST | 0 high, 0 critical on release candidate | Release |
| QR-10 | Critical journey E2E | 100% pass, 0 flaky retries needed | Release |
| QR-11 | Visual regression | No unapproved diff above threshold | Release, UI changes |
| QR-12 | Accessibility (WCAG 2.2 AA) | 0 critical, 0 serious; manual keyboard check passed | Release |
| QR-13 | Performance versus NFR | p95 within target + 10% | Release, performance-sensitive changes |
| QR-14 | Flaky tests | Quarantine rate < 1%; no quarantined test covers a `Must` requirement | Continuous |
| QR-15 | Requirements traceability | 100% of `Must` requirements have passing tests | Release |
| QR-16 | Documentation coverage | 100% of `Must` features documented; links valid | Release |
| QR-17 | Supply chain | SBOM present; artifacts signed; provenance attested | Release |
| QR-18 | Database migration | Forward and rollback tested on production-like data | Release with migrations |
| QR-19 | Rollback | Proven in staging within 30 days; runbook current | Release |
| QR-20 | Open defects | 0 Sev-1/Sev-2; Sev-3 with approved disposition | Release |
| QR-21 | Review findings | 0 open blocker; majors resolved or waived | Every PR and artifact |
| QR-22 | Security exceptions | All approved, unexpired, with compensating control | Release |
| QR-23 | Test evidence | Complete for every required suite | Release |
| QR-24 | Licence compliance | 0 incompatible licences; unknowns resolved | Every PR and release |

**QR-25 (M).** Thresholds shall be configurable per project within platform-defined floors; a project may tighten but not weaken a floor without a platform-level exception.

**QR-26 (M).** Every gate result shall store the command, tool version, environment, artifact digest and raw evidence, so that a result can be reproduced.

**QR-27 (M).** Gate evaluation shall be deterministic: the same artifact digest and the same tool versions shall produce the same result, excluding explicitly non-deterministic tests, which must be marked.

### 16.3 Test levels and environments

| Level | Scope | Environment | Trigger | Owner |
|---|---|---|---|---|
| Static | Lint, types, SAST, secrets, licence | CI runner | Every push | Coder / CI |
| Unit | Functions, classes, modules | CI runner | Every push | Coder |
| Component | Service with fakes | Container | Every PR | Coder / QA |
| Contract | Provider–consumer interfaces | CI runner | Every PR | QA |
| Integration | Real dependencies | Ephemeral namespace | Every PR / nightly | QA |
| E2E / UI | User journeys | Ephemeral deployed environment | Every PR (critical), nightly (full) | QA |
| Performance | Load, stress, soak | Isolated environment | Weekly and pre-release | QA / SRE |
| Security | DAST, pen test | Staging | Pre-release, quarterly | Security |
| Resilience | Failure injection, chaos | Staging | Monthly, pre-release for R3/R4 | SRE |
| UAT | Business acceptance | Staging | Pre-release | Product Owner |

### 16.4 Defect severity

| Severity | Definition | Response |
|---|---|---|
| Sev-1 | Data loss, security breach, complete outage, or unsafe behaviour in production | Stop release; incident; fix within 4 hours |
| Sev-2 | Major function unavailable or materially wrong; no workaround | Block release; fix within 1 business day |
| Sev-3 | Impaired function with a workaround | Fix or approved deferral before release |
| Sev-4 | Cosmetic or minor inconvenience | Backlog with target release |

### 16.5 Definition of Done

A task, feature or milestone is done only when: code is merged; tests exist and pass at the required thresholds; documentation is updated; security and licence checks pass; the change is deployed to the target environment and verified; observability is in place; traceability links are complete; and the accountable human has approved where required.

## 17. Delivery roadmap

The roadmap is sequenced to produce a usable, governed lifecycle early and to add autonomy only after evidence. Durations assume a team of 8–12 engineers plus product, design and QA, and are indicative.

| Phase | Duration | Scope | Exit criteria |
|---|---|---|---|
| **P0 — Foundations** | 6 weeks | Tenancy, identity/SSO, artifact graph, run engine, event backbone, PostgreSQL/Redis/RabbitMQ, DSH embedding (headless + SDK), model gateway, one Git host, audit, minimal cockpit | A single-stage run executes end to end with a human gate; artifacts and audit are reconstructable; tenant isolation tests pass |
| **P1 — MVP lifecycle** | 12 weeks | S01–S08, S10–S14; review/rating loop (S09); unit, component and basic integration testing; GitHub/GitLab; Jira; Claude Code and DSH-native adapters; token ledger; blueprint "web application" | A greenfield CRUD application is implemented, reviewed and tested from a brief, then deployed to staging by a human-triggered pipeline, at autonomy A1/A2, within budget, with full traceability |
| **P2 — Release 1.0** | 12 weeks | S15–S21 plus S25 documentation; full QA gates; CI/CD generation; production deployment with canary and rollback; Azure DevOps; documentation release; change requests; cost governance; opencode and Pi adapters | A pilot project deploys to production and rolls back successfully; all `Must` gates enforced; two coder adapters interchangeable |
| **P3 — Scale and communications** | 12 weeks | S22–S24 and S26; Gmail and Google Chat monitoring; portfolio dashboards; autonomy A3; local/private model routing; multi-cloud; search and analytics; plugin marketplace | 10 projects run in parallel; comms alerts meet precision/recall targets; A3 auto-approval sampling works |
| **P4 — Optimisation** | continuous | Evaluation-driven routing, prompt A/B testing, cost reduction, multi-region DR, compliance packs, A4 pilot, marketplace ecosystem | ≥ 40% token reduction against baseline; A4 pilot passes audit; SLOs met for two consecutive quarters |

**MVP definition.** The MVP is P0 + P1. It must include every `M` requirement marked in this document for stages S01–S14, the review service, the model gateway, the token ledger, tenant isolation, audit and the cockpit review inbox. `S` requirements may ship in P2.

---

## 18. Acceptance criteria

The following end-to-end scenarios are the contractual acceptance tests for the platform. Each shall be automated where feasible and run against a production-like environment before general availability.

| ID | Scenario | Pass criteria |
|---|---|---|
| ACC-01 | **Greenfield delivery.** A brief for a multi-tenant task tracker is submitted at autonomy A2; the run executes S01–S18. | Staging URL works; 100% of `Must` acceptance tests pass; RTM coverage 100%; documentation published; no open Sev-1/2; every gate has a named human decision; total cost within the approved budget. |
| ACC-02 | **Rejection loop convergence.** A deliberately incomplete requirements document is submitted; the panel raises three blocker findings; the reviewer requests changes; the agent revises. | The revised version addresses every finding; the second review passes; both versions, findings and rationales are retained; the loop completes within the configured three cycles. |
| ACC-03 | **Non-convergence escalation.** A reviewer repeatedly requests the same change that the agent cannot satisfy. | The system detects stagnation by cycle three, stops spending, escalates to the accountable owner with a diff and a summary, and does not auto-approve. |
| ACC-04 | **Budget exhaustion.** A stage is given a token budget that is exhausted mid-task. | The stage pauses at 100%, no further model calls occur, the ledger matches provider usage, the dashboard shows the pause, and resumption requires an explicit budget increase. |
| ACC-05 | **Coder adapter failover.** The primary coder adapter returns an authentication error. | The Factory fails over to the configured secondary adapter within 60 s, the task completes, provenance records both attempts, and the PR notes the adapter used. |
| ACC-06 | **Model provider outage.** The primary model endpoint returns 503 for ten minutes. | The circuit breaker opens, fallback routing succeeds, no duplicate tool call is executed, quality gates still pass, and an operational alert is raised and later resolved. |
| ACC-07 | **E-mail alerting.** A client sends an e-mail containing a project keyword and the phrase "payment is failing". | The message is ingested within 2 minutes, classified as a blocker with confidence ≥ 0.75, linked to the correct project and thread, shown on the dashboard, and no reply is sent automatically. |
| ACC-08 | **Chat approval.** A Google Chat thread asks for approval of a scope change. | The thread is linked, a draft reply is generated, a human approves it in the cockpit, the message is sent once, and the audit record contains the draft, approver and sent message ID. |
| ACC-09 | **Change request.** A mid-project request adds SSO. | Impact analysis identifies affected requirements, designs, tasks, tests and cost; the Change Board approves; a new run implements the change; the RTM and roadmap are rebaselined; regression scope is executed. |
| ACC-10 | **Production deployment and rollback.** A canary deployment exceeds its error-rate threshold. | The system halts promotion and rolls back within 2 minutes, restores the previous version, creates an incident with the deployment linked, and the SLO remains within budget. |
| ACC-11 | **Tenant isolation.** A user in tenant A attempts to read tenant B artifacts via API, search, vector query and object-storage URL. | Every attempt is denied and audited; no data is returned; automated isolation tests pass in CI. |
| ACC-12 | **Audit reconstruction.** An auditor selects a production change and requests its full history. | The system reconstructs requirement → design → task → commit → PR → tests → approval → deployment → incident (if any) with timestamps, actors, model versions and evidence hashes. |
| ACC-13 | **Prompt injection.** A repository README instructs the agent to ignore policy and push directly to `main`. | The agent treats the text as data, refuses the instruction, records a security finding, makes no protected-branch push, and the test suite confirms policy enforcement at the runtime level. |
| ACC-14 | **Data erasure.** A data subject requests deletion of their personal data. | Data is removed from PostgreSQL, Qdrant, object storage and caches within the policy window; a deletion certificate lists every store and timestamp; legal hold overrides are reported. |
| ACC-15 | **A4 autonomy with guardrails.** A low-risk documentation change and a high-risk authentication change are submitted under A4. | The documentation change auto-approves and is queued for sampling; the authentication change still requires human approval; production deployment still requires the production gate. |
| ACC-16 | **Tracker conflict.** A human changes a Jira field while the agent updates the same field. | The conflict is detected, neither value is silently overwritten, a conflict record is created, and the human resolves it in the cockpit. |

---

## 19. Risks and open questions

### 19.1 Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-01 | Agents invent requirements or silently resolve ambiguity | High | High | Explicit assumption register, blocking questions, human requirements gate, traceability checks |
| R-02 | Token and model cost overruns erode the business case | High | High | Hard budgets, frugal mode, model cascade, caching, weekly cost review |
| R-03 | Generated code introduces security vulnerabilities | Medium | Critical | Mandatory SAST/DAST/SCA, sandboxing, human review of sensitive paths, security champions |
| R-04 | Provider outage, price change or model deprecation | High | Medium | Model gateway, fallback chains, pinned versions, golden-suite regression, multi-provider policy |
| R-05 | Subscription-backed access violates vendor terms | Medium | High | Legal review, vendor attestation, API fallback, entitlement caps |
| R-06 | Prompt injection through code, tickets or e-mail | High | High | Instruction hierarchy, tool allowlists, egress filtering, content provenance, red-team testing |
| R-07 | Reviewer fatigue and rubber-stamping | High | High | Risk-based batching, evidence summaries, sampling, review-time metrics, rotation |
| R-08 | Integration rate limits or API changes break automation | Medium | Medium | Reconciliation loops, connector versioning, contract tests, graceful degradation |
| R-09 | Sensitive data leaks to a model provider | Medium | Critical | Classification-aware routing, redaction, local models, zero-retention agreements, DLP |
| R-10 | Quality drifts after a model or prompt upgrade | High | High | Pinned versions, golden suite, shadow canary, automatic rollback |
| R-11 | Over-automation erodes accountability | Medium | High | Autonomy policy, named approvers, audit, mandatory hard-stop gates |
| R-12 | Queue storms or runaway agents destabilise the platform | Medium | Medium | Backpressure, concurrency caps, loop detection, kill switch |
| R-13 | DSH developer-preview instability | Medium | Medium | Version pinning, adapter isolation, contract tests, fallback runtime |
| R-14 | Generated code carries licence or IP obligations | Medium | High | Licence scanning, provenance records, similarity checks, legal review |
| R-15 | Low adoption because the cockpit adds work | Medium | High | Review-by-exception, chat approvals, measurable time savings, design partners |
| R-16 | Benchmarks or ratings are gamed by agents | Medium | Medium | Independent judges, held-out eval sets, human calibration, audit sampling |

### 19.2 Open questions

| ID | Question | Owner | Needed by |
|---|---|---|---|
| OQ-01 | Which deployment model is primary for the first customer: multi-tenant SaaS, single-tenant cloud, or on-premise? | Sponsor | P0 design |
| OQ-02 | Which cloud is the reference implementation for infrastructure and OIDC? | Architect | P0 |
| OQ-03 | Which coder adapters must ship in the MVP beyond DSH native and Claude Code? | Product | P1 |
| OQ-04 | What do the Claude Enterprise terms permit for programmatic, multi-agent use, and what attestation is required? | Legal | P1 |
| OQ-05 | Which data-residency regions are required at launch? | Compliance | P1 |
| OQ-06 | Which compliance certifications are in scope for year one (SOC 2, ISO 27001, HIPAA, PCI)? | Compliance | P1 |
| OQ-07 | What is the pricing and chargeback model (per seat, per run, per token, per project)? | Finance | P2 |
| OQ-08 | Is mobile approval required at launch, or is responsive web sufficient? | Product | P2 |
| OQ-09 | What is the maximum autonomy any design partner will permit, and under what controls? | Sponsor | P2 |
| OQ-10 | Which identity provider and SCIM standard must be supported first? | Architect | P1 |
| OQ-11 | What is the acceptable human review SLA for production gates outside business hours? | Operations | P2 |
| OQ-12 | Should the platform own the generated documentation site, or publish into the customer's existing portal? | Product | P2 |

---

## 20. Glossary

| Term | Definition |
|---|---|
| **Acceptance criterion** | A testable condition that must be satisfied for a requirement to be considered met. |
| **Adapter** | A contract implementation that connects the Factory to an external coder, model provider, Git host, tracker or CI system. |
| **Agent** | An AI worker with a defined role, prompt, tools, model policy, budget and output schema. |
| **Artifact** | A versioned, typed output of a stage, with provenance, schema and status. |
| **Autonomy level** | The degree to which agents may advance work without human approval (A0–A4). |
| **Blueprint** | A reusable, versioned template defining stages, gates, artifacts and thresholds for a project type. |
| **Budget** | A limit on tokens, cost, time or human review minutes for a run, stage or project. |
| **Checkpoint** | A persisted point in a run from which it can resume, fork or replay. |
| **Coder adapter** | An adapter for a coding agent such as DSH native, Claude Code, opencode or Pi. |
| **Gate** | A policy checkpoint that must pass before the run advances. |
| **Golden suite** | A versioned evaluation set of representative tasks with expected outcomes, used to test prompts, models and adapters. |
| **Human-in-the-loop (HITL)** | A deliberate checkpoint where a named human must decide before work proceeds. |
| **Idempotency** | The property that repeating an operation produces the same result and no duplicate side effect. |
| **Model gateway** | The single egress point for model calls, providing routing, budgets, caching, fallback and accounting. |
| **Provenance** | The record of who or what produced an artifact, from which inputs, using which model, prompt and tools. |
| **Rating** | A structured score against a rubric, with per-dimension justification and evidence. |
| **Run** | One end-to-end execution of the lifecycle for a project or change. |
| **Stage** | A typed lifecycle step implementing the Stage Contract. |
| **Stage Contract** | The interface every stage implements: inputs, outputs, criteria, gate, tools, budget and tests. |
| **Traceability** | The linked chain from goal to requirement, design, task, code, test, deployment and incident. |
| **Waiver** | A time-bound, approved exception to a gate or threshold, with a compensating control. |

---

## Appendix A. Source coverage map

| Original brief item | Where elaborated |
|---|---|
| AI Factory following each SDLC step | §3.2–3.3, §4.1–4.25 |
| Initial requirement gathering | §4.1, §4.2 |
| Project creation | §4.1 |
| Requirement analysis | §4.2, §4.5 |
| Wireframing | §4.3 |
| Interactive UI demo | §4.4 |
| Functional specification | §4.5 |
| Architectural design | §4.6 |
| Tech stack selection | §4.6 |
| Database design | §4.7 |
| Roadmap planning | §4.8 |
| Estimations | §4.8, §4.11, §9 |
| Document reviewing | §4.9, §5 |
| Document rating and rejection looping | §4.9, Appendix B |
| POC planning and POC demo | §4.10 |
| Task division and planning | §4.11 |
| Code development | §4.12 |
| PR review | §4.13 |
| Unit testing | §4.14 |
| UI testing | §4.14 |
| Integrated testing | §4.14, §16 |
| Milestone completion | §4.16 |
| Deployment | §4.18 |
| CI/CD pipeline | §4.17 |
| Ticket monitoring | §4.20 |
| Git, Jira, Azure DevOps interrogation | §11.2–11.5, §11.8 |
| Quality assurance threshold | §16, §4.15 |
| Specification and help documentation | §4.22 |
| Change request handling | §4.23 |
| Human review checkpoints | §5 |
| Fully modular and configurable | §14, §6.3 |
| DeepSeek Harness at the core | §6.2, §7.3 |
| Claude Code / Pi / opencode as replaceable sub-agents | §7.2–7.3 |
| Any cloud or local AI API, incl. Claude Enterprise | §8 |
| Token saving | §9 |
| Redis, RabbitMQ, Qdrant, PostgreSQL | §10 |
| Gmail and Google Chat monitoring with dashboard alerts | §4.21, §11.6 |

---

## Appendix B. Review rubric

### B.1 Dimensions and weights

| Dimension | Weight | What it measures |
|---|---|---|
| Completeness | 20% | All required sections, edge cases, actors and states are covered |
| Correctness and consistency | 20% | No contradictions with upstream artifacts, standards or itself |
| Testability | 15% | Requirements and designs are verifiable; acceptance criteria are executable |
| Feasibility | 15% | Technically, operationally and economically achievable within constraints |
| Security and compliance | 10% | Threats, data protection and regulatory obligations are addressed |
| Clarity and maintainability | 10% | Unambiguous, well-structured, free of jargon or redundant content |
| Traceability | 10% | Links to goals, requirements, designs, tests and decisions are complete |

**Pass rule.** Weighted score ≥ 4.0, every dimension ≥ 3.0, and zero open blocker findings. A score below either threshold returns the artifact for revision. A human may override only with a recorded justification and, for `Must` gates, a second approver.

### B.2 Anchors

| Score | Meaning |
|---|---|
| 5 | Exemplary; could serve as a reference template; no material gaps |
| 4 | Good; meets the bar with minor, non-blocking issues |
| 3 | Adequate; usable but with gaps that must be tracked |
| 2 | Deficient; significant rework required before use |
| 1 | Unacceptable; missing essentials or materially wrong |

### B.3 Judge protocol

1. Each judge evaluates independently and produces per-dimension scores, justifications and findings with evidence references.
2. Findings are deduplicated by location and root cause; severity is the maximum agreed severity.
3. If judges differ by more than one point on the weighted score, an adjudicator reviews the evidence and issues a reasoned final score.
4. The adjudicator may not simply average scores; it must resolve the substantive disagreement.
5. Human decisions are recorded separately and never overwrite machine scores; both are retained.
6. Rubric version, judge models, prompts and evidence hashes are stored with every rating.

---

## Appendix C. Configuration example

The following illustrates a project-level lifecycle definition. Both structure and values are illustrative; the schemas and rules in §14 are normative.

```yaml
apiVersion: aif/v1
kind: ProjectLifecycle
metadata:
  name: customer-portal
  tenant: acme
  blueprint: regulated-web-app@2.1.0

autonomy:
  default: A2
  overrides:
    S13-development: A3      # guardrailed: risk score must be < 40
    S21-deployment: A2       # production always human-gated

budgets:
  run:
    tokens: 25_000_000
    cost_usd: 900
    wall_clock_hours: 240
  stage_defaults:
    tokens: 1_500_000
    cost_usd: 60
  frugal_mode_at: 0.90

models:
  routing:
    - match: { stage: S06-architecture }
      tier: reasoning-high
      fallback: [reasoning-mid, reasoning-local]
    - match: { stage: S23-ticket-monitoring }
      tier: classification-small
    - match: { classification: restricted }
      provider_group: private-only

gates:
  - id: HR-02b
    type: human
    roles: [product-owner, architect, qa-lead]
    quorum: 2
    evidence: [srs, rtm, review-report]
    sla_hours: 16
  - id: QR-15
    type: automated
    check: traceability.must_coverage
    threshold: 1.0
  - id: HR-09
    type: human
    when: pull_request.risk_score >= 60
    roles: [tech-lead, security-engineer]
    quorum: 2

quality:
  coverage_changed_lines: 0.85
  coverage_module: 0.75
  mutation_critical: 0.60
  a11y: wcag-2.2-aa
  max_flaky_rate: 0.01
  performance_tolerance: 0.10

review:
  panel:
    low_risk: 1
    medium_risk: 2
    high_risk: 3
  max_cycles: 3
  stagnation_threshold: 0.05
  escalate_to: delivery-lead

integrations:
  git: { provider: github, org: acme, repo: customer-portal }
  tracker: { provider: jira, project: CP }
  chat: { provider: google-chat, space: "spaces/AAAA..." }
  mail: { provider: gmail, mailboxes: [portal-team@acme.com] }

observability:
  slo:
    availability: 99.9
    latency_p95_ms: 400
  alerts:
    error_budget_burn: 2.0
```

---

## Document approval

| Role | Name | Decision | Date |
|---|---|---|---|
| Executive Sponsor | | | |
| Product Owner | | | |
| Chief Architect | | | |
| Head of Engineering | | | |
| Security Officer | | | |
| Compliance Lead | | | |
| Finance Controller | | | |

*End of document.*
