# AI Factory

Detailed requirements for an autonomous, human-governed software delivery platform.

**Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the implemented system, with diagrams for the runtime, stage lifecycle, gates, model layer, agents, prerequisites, data model and trust boundaries.

**Known defects and remediation plan:** [docs/design/ARCHITECTURE-REMEDIATION.md](docs/design/ARCHITECTURE-REMEDIATION.md) — 17 findings from the code review of 2026-11-17, each with evidence, remedy and acceptance checks, and a five-phase execution plan.

**Primary document:** [docs/AI-Factory-Requirements.md](docs/AI-Factory-Requirements.md) — version 1.0 (draft for review), 2026-11-09.

## Implementation

The platform is being built incrementally against the specification.

- [apps/chat-cli](apps/chat-cli/README.md) — a minimal interactive chat client that runs DeepSeek Harness headless, carries a Session across turns and streams the harness event model. It also exposes the same transport as a JSON + SSE [HTTP API](apps/chat-cli/API.md) for a separate UI, with a PostgreSQL-backed project registry. See [infra/README.md](infra/README.md) for the local database.
- [docs/design/STAGE-RUNTIME.md](docs/design/STAGE-RUNTIME.md) — stage-scoped runtime, coordinator/role orchestration, review loops, per-project harness configuration, and project security/isolation design with diagrams.
- [docs/design/LOGGING-ARCHITECTURE.md](docs/design/LOGGING-ARCHITECTURE.md) — plan for a Serilog-style structured, async, multi-sink logging system with failure isolation, backed by pino spike results.
- [docs/design/MODEL-PROVIDERS.md](docs/design/MODEL-PROVIDERS.md) — plan for Claude, OpenAI, llama.cpp and other model providers behind one interface, with per-role routing.
- [docs/design/OBSERVABILITY-ADAPTERS.md](docs/design/OBSERVABILITY-ADAPTERS.md) — how to add a monitor as an observability adapter without touching the core.
- [docs/design/OBSERVABILITY-PORTS.md](docs/design/OBSERVABILITY-PORTS.md) — review of the current Phoenix coupling and the plan to put tracing/read APIs behind replaceable observability ports.
- [docs/design/PHOENIX-OBSERVABILITY.md](docs/design/PHOENIX-OBSERVABILITY.md) — Phoenix tracing integration plan with project isolation, trace schema, redaction and deployment hardening.
- [docs/ui/STAGE-UI-PROMPT.md](docs/ui/STAGE-UI-PROMPT.md) — implementation prompt for the stage-centric UI, including the Planning & Feasibility workspace, polling, review findings, TELOS preview and human gate.
- [docs/ui/UI-QUICKSTART-PROMPT.md](docs/ui/UI-QUICKSTART-PROMPT.md) — one-page prompt for the UI coder covering the stage workspace, live activity, project logs, observability and search.
- [docs/ui/EVENT-ACTIVITY-INTEGRATION-PROMPT.md](docs/ui/EVENT-ACTIVITY-INTEGRATION-PROMPT.md) — focused UI prompt for the live Activity drawer, SSE client, event rendering, filters, reconnects and accessibility.

## What the document covers

- **26 SDLC stages**, from intake and requirements through design, estimation, proof of concept, implementation, review, testing, release, deployment, operations, documentation and change management.
- **19 human review checkpoints** with authority, quorum, SLAs, escalation and structured decision semantics.
- **A rating and rejection loop** with a weighted rubric, multi-judge panels, bounded revision cycles and non-convergence detection.
- **DeepSeek Harness as the orchestration kernel**, with replaceable coder adapters (Claude Code, opencode, Pi, Codex CLI, Gemini CLI, Aider) and a model gateway for cloud, enterprise-subscription and local providers.
- **Token and cost economy** requirements targeting a 40%+ reduction against a naive full-context baseline.
- **PostgreSQL, Redis, RabbitMQ, Qdrant and object storage** with explicit responsibilities, retention, recovery and isolation requirements.
- **Integrations** with Git hosts, Jira, Azure DevOps, CI/CD, Gmail and Google Chat, including cross-system interrogation and alerting.
- **Security, privacy, compliance, non-functional requirements, configuration, APIs, events, QA gates, roadmap, acceptance scenarios and risks.**

## Document map

| Need | Read |
|---|---|
| Why and what | Executive summary, §2 |
| Lifecycle and stages | §3, §4 |
| Human oversight and approvals | §5 |
| Architecture and agents | §6, §7 |
| Models and token control | §8, §9 |
| Data and integrations | §10, §11 |
| Security and NFRs | §12, §13 |
| Configuration and contracts | §14, §15 |
| Quality and delivery plan | §16, §17 |
| Acceptance and risks | §18, §19 |
| Source coverage of the original brief | Appendix A |

## Status

Draft for stakeholder review. Open questions that block parts of design and procurement are listed in §19.2. The document becomes the baseline after the approvals in the final section are recorded.
