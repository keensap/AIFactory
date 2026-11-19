# AI Factory

An autonomous, human-governed software delivery platform. Agents analyse, draft and review
delivery artifacts stage by stage; a person makes every consequential decision.

**Status: early.** Two of the eight SDLC stages execute end to end — **Planning & Feasibility**
(a TELOS feasibility report) and **Requirements** (a requirements specification). Both run on
one shared stage engine, and both stop at a human gate where the operator approves, rejects or
asks for one more pass. The other stages appear in the UI as read-only and are not implemented.
Everything here is under active development and the API may change.

## How a stage runs

```
brief / attachments / approved upstream artifact
        │
        ▼
   analyzer ──▶ author ──▶ reviewer ──▶ meets criteria? ──yes──▶ human gate ──▶ artifact + PDF
        ▲                      │                                   │
        └──── revise (≤ maxReviewCycles, deterministic checks included) ◄─ reject: gate stays open
```

- **One engine, many stages.** A stage is a definition (prompts, artifact, checklist keys,
  review settings); the engine owns the lease, the loop, the gate, completion and export.
- **Deterministic checks gate approval.** For requirements, a contract checker plus a coverage
  report (ids, acceptance-criteria links, NFR verification, priorities, register dates, source
  citations) block ordinary approval. Model review findings drive revision but do not block.
  A blocked draft can still be approved with an audited waiver reason.
- **Rejection publishes nothing.** The draft and queue are kept so the run can be refined later.
- **Models are pluggable.** Claude, OpenAI, OpenRouter, llama.cpp and Ollama behind one target,
  with per-role routing, retries, a circuit breaker and token/cost accounting.

## Layout

| Path | What it is |
|---|---|
| [`apps/chat-cli`](apps/chat-cli) | The runnable slice: CLI, HTTP API (JSON + SSE), PostgreSQL-backed project registry, stage engine, agents, model providers, logging, observability. |
| [`apps/chat-web`](apps/chat-web) | React + TypeScript web client: projects, stage workspace, live activity, review gates, artifacts, log viewer. |
| [`docs`](docs) | Requirements specification, architecture, design notes, UI prompts, diagrams. |
| [`infra`](infra) | Local PostgreSQL setup and schema bootstrap. |
| [`tools`](tools) | Developer tooling (e.g. the Redmine MCP launcher used to track work). |

Start with the design notes:

- [Architecture](docs/ARCHITECTURE.md) — the implemented system, with diagrams.
- [Requirements specification](docs/AI-Factory-Requirements-v2.md) — the full platform brief.
- [Requirements contract](docs/design/REQUIREMENTS-CONTRACT.md) and [operations](docs/operations/REQUIREMENTS-STAGE-OPERATIONS.md) — what a specification must contain, and how to run, inspect and recover a requirements run.
- [Known defects and remediation plan](docs/design/ARCHITECTURE-REMEDIATION.md).
- API reference: [API.md](apps/chat-cli/API.md) and [openapi.yaml](apps/chat-cli/openapi.yaml).

## Quick start

Requirements: Node.js 24+, PostgreSQL 14+ (pgvector optional, for semantic retrieval), and a
DeepSeek Harness installation whose `headless` profile can reach a model.

```sh
# 1. Database (local container example; see infra/README.md)
docker exec postgres-vector psql -U postgres -c "CREATE ROLE aifactory LOGIN PASSWORD '<password>';"
docker exec postgres-vector createdb -U postgres -O aifactory aifactory

# 2. API
cd apps/chat-cli
cp .env.example .env          # then fill in DATABASE_URL and a model credential
npm ci
node src/api.ts               # http://127.0.0.1:8787/docs
```

```sh
# 3. Web client
cd apps/chat-web
npm ci
npm run dev                   # http://127.0.0.1:5173
```

See [apps/chat-cli/README.md](apps/chat-cli/README.md) and
[apps/chat-web/README.md](apps/chat-web/README.md) for every setting, and run `npm run mock`
in `apps/chat-web` to try the UI without a database or model.

## Tests

```sh
cd apps/chat-cli && npm test          # node:test; needs AIFACTORY_TEST_DATABASE_URL for DB tests
cd apps/chat-web  && npm test         # vitest, no network
```

Both packages also expose `npm run typecheck`; `apps/chat-cli` has `check:models` and
`check:observability` guards. A live end-to-end requirements run is opt-in and costs model
tokens: `npm run smoke:requirements` (documented in the [CLI README](apps/chat-cli/README.md#live-requirements-smoke-test-opt-in)).

## Security

- Credentials are read from the environment or a gitignored `.env`; nothing secret belongs in
  this repository. `.env.example` documents the contract, with empty values.
- Generated artifacts, logs and local state live under `.data/` (gitignored), never in git.
- The API supports a bearer token (`AIFACTORY_API_TOKEN`) and an admin token; bind it to
  loopback unless you have put authentication in front of it.

## License

Copyright (C) 2026 the AI Factory contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the
**GNU General Public License as published by the Free Software Foundation, either version 3 of
the License, or (at your option) any later version** (GPL-3.0-or-later). See [LICENSE](LICENSE).

This program is distributed in the hope that it will be useful, but **without any warranty**;
without even the implied warranty of merchantability or fitness for a particular purpose.
