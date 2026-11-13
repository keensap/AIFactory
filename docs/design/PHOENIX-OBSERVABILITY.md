# Phoenix Observability and Project Isolation — Plan

**Status:** implemented for metadata-only traces; deployment hardening remains  
**Date:** 2026-11-11  
**Scope:** integrate Arize Phoenix as an optional observability layer for stage runs, without weakening project isolation or exposing project data

---

## 1. Current environment

```text
container:   phoenix
image:       arizephoenix/phoenix:12.14.2
UI:          http://127.0.0.1:6006
OTLP gRPC:   127.0.0.1:4317
```

Observed facts:

- both ports are published on `0.0.0.0`, not loopback-only;
- the container has no `PHOENIX_ENABLE_AUTH` or `PHOENIX_SECRET` configured;
- the container has no mounted volume, so its default SQLite data is ephemeral;
- `GET /v1/projects` returned a `default` project without credentials from localhost.

Treat the current instance as **development-only and untrusted for project data** until the deployment is hardened.

Phoenix facts used in this plan:

- Phoenix routes spans to projects using the `openinference.project.name` resource attribute, or the `x-project-name` HTTP header.
- Phoenix defaults to SQLite; PostgreSQL is configured with `PHOENIX_SQL_DATABASE_URL`.
- Authentication is configured with `PHOENIX_ENABLE_AUTH` and `PHOENIX_SECRET`.
- Bind address defaults and auth defaults matter: a network-exposed instance must not rely on localhost convenience.

## 1.1 Decisions adopted

- AI Factory exposes a project-scoped Phoenix summary API; the project page will consume it.
- One shared Phoenix instance with one tracer provider per AI Factory project.
- 24-hour summary window for now; Phoenix retention policy can be configured later.
- Prompt/output/thinking/tool-content capture is configurable through
  `AIFACTORY_PHOENIX_CAPTURE_CONTENT` and is **disabled by default**.

---

## 2. Goals

1. Make stage runs observable in Phoenix without making Phoenix authoritative.
2. Never expose one project’s traces to another project’s users.
3. Keep prompts, documents, thinking and tool output out of traces by default.
4. Make Phoenix optional: the API and stage runs must work when Phoenix is down.
5. Provide useful latency, token, error and tool traces for operators.
6. Define retention and deletion before production use.

## 3. Non-goals

- Replacing `stage_run_events` or the audit log.
- Using Phoenix for authorization.
- Exposing Phoenix directly to project end users.
- Capturing raw prompts by default.
- Deep Claude Code/Codex child events that the DSH provider does not expose.
- Using Phoenix as the event bus or job queue.

---

## 4. Security principles

### 4.1 Phoenix is not the source of truth

`stage_run_events` remains the durable audit/replay record. Phoenix receives a sampled, redacted observability projection. A missing trace must never change run state.

### 4.2 Metadata-only by default

Default trace attributes:

- project ID and name;
- stage;
- run ID and attempt;
- role and agent ID;
- model/provider when known;
- duration;
- token counts when available;
- status and error code;
- tool name and status;
- document kind;
- context hash.

Not captured by default:

- prompts;
- model output;
- thinking/reasoning text;
- tool arguments or commands;
- tool output;
- document contents;
- filesystem paths beyond project root;
- API keys, auth headers, environment values.

### 4.3 Content capture is opt-in and scoped

If content capture is enabled, it must be:

- per environment;
- per project or tenant where possible;
- explicitly approved;
- truncated;
- redacted;
- excluded from normal operator views.

### 4.4 No cross-project trace visibility

A user with access to project A must not be able to query project B’s traces through Phoenix.

The safe options are:

| Option | Isolation | Recommendation |
|---|---|---|
| Shared Phoenix, one project per AI Factory project | Logical only; Phoenix UI may expose all projects | Development only |
| Shared Phoenix + authenticated gateway + verified per-project authorization | Conditional | Only if Phoenix supports project-level RBAC in this deployment |
| Phoenix instance per tenant/environment | Strong | Recommended for untrusted tenants |
| Phoenix instance per project | Strongest, expensive | Enterprise/highly sensitive projects |

Do not assume Phoenix “projects” are an authorization boundary. They are a grouping feature unless access control is proven.

---

## 5. Threat model

| Threat | Impact | Control |
|---|---|---|
| Project A user opens Phoenix and sees project B traces | Cross-project data leak | Separate Phoenix instance per tenant; authenticated gateway; no user access to shared instance |
| Prompt/document text captured in span attributes | Confidentiality loss | Metadata-only default; opt-in content; redaction |
| Tool command contains a token/password | Secret leak | Never capture command by default; redact secret-like values |
| Project sandbox can reach OTLP endpoint | Forged spans, data injection, DoS | Egress deny from project sandboxes; only API/worker network can reach 4317 |
| Unauthenticated Phoenix UI/API on 0.0.0.0 | Anyone on host/network reads traces | Bind loopback; enable auth; reverse proxy TLS |
| Ephemeral SQLite container loses traces | Audit confusion; no history | PostgreSQL backend or mounted persistent volume |
| Trace attributes carry unbounded/high-cardinality text | Cost and accidental content leakage | Attribute allowlist; truncation; no raw text |
| Phoenix down blocks stage execution | Availability | Optional async exporter; never await Phoenix |
| Trace deletion not aligned with project deletion | Data retention violation | Project deletion removes traces via Phoenix API or per-project instance destruction |
| Operator copies traces elsewhere | Policy breach | Access logging, retention policy, classification |

---

## 6. Target deployment

### 6.1 Network

```text
Project runtime ──X──> Phoenix
Project runtime ──X──> OTLP :4317

API / worker ───────> OTLP :4317
Operator ──> reverse proxy / TLS / auth ──> Phoenix UI :6006
```

- Publish only to loopback or a private network:

```yaml
ports:
  - "127.0.0.1:6006:6006"
  - "127.0.0.1:4317:4317"
```

- Do not expose `4317` to project containers.
- If remote access is needed, use an authenticated TLS reverse proxy.
- Separate dev, staging and production Phoenix deployments.

### 6.2 Authentication

```text
PHOENIX_ENABLE_AUTH=true
PHOENIX_SECRET=<random 32+ character secret>
```

- Store the secret outside the compose file.
- Use TLS at the proxy.
- Verify that `/v1/projects` and the UI are actually protected after configuration; do not assume defaults.
- If Phoenix OSS cannot enforce per-project access, do not give project users direct UI access.

### 6.3 Persistence

Current container has no volume. Before production:

- use a dedicated PostgreSQL database with `PHOENIX_SQL_DATABASE_URL`; or
- mount `PHOENIX_WORKING_DIR` to a persistent volume.

Do not use the AI Factory project database for Phoenix. Use a separate DB/user/schema and backup policy.

### 6.4 Retention and deletion

Define:

- trace retention, e.g. 7 days for metadata, 24 hours for opt-in content;
- deletion on project removal;
- deletion on tenant offboarding;
- backup retention.

Phoenix stores prompt-like data; project deletion must not leave traces behind.

---

## 7. Trace architecture

```text
PlanningStageRuntime
  ├── stage.run                    root span
  │     ├── stage.role.analyzer    child span
  │     ├── stage.role.author      child span
  │     ├── stage.role.reviewer    child span
  │     │     └── tool.call        child spans
  │     └── events                 review/document/human decision
  └── OTLP gRPC exporter ─────────> Phoenix :4317
```

### 7.1 Resource attributes

```text
service.name = aifactory
deployment.environment = dev | staging | prod
openinference.project.name = aifactory-<projectId>   # when per-project routing is enabled
```

### 7.2 Span attributes

`stage.run`:

```text
project.id
project.name
stage
run.id
run.attempt
context.hash
worker.id
status
document.kind
```

`stage.role`:

```text
project.id
run.id
role
attempt
timeout.ms
duration.ms
status
model/provider (when available)
llm.token_count.prompt
llm.token_count.completion
llm.token_count.total
```

`tool.call`:

```text
project.id
run.id
role
tool.name
tool.call_id
tool.status
tool.output.size
```

Opt-in only:

```text
llm.input_messages
llm.output_messages
tool.input
tool.output
```

### 7.3 Events

- `review.decision` — decision and finding count
- `document.created` — kind and redacted path
- `human.decision` — decision
- `role.error` — safe error code/message
- `run.recovered` — previous status

---

## 8. Project routing: critical design choice

Phoenix routes by a **resource** attribute, not a per-span attribute. A single process exporting all projects needs one of:

### Option A — one Phoenix project, shared

- Set `openinference.project.name = aifactory`.
- Add `project.id` as a span attribute.
- Simplest.
- Not an authorization boundary.
- Suitable only for a trusted operator view.

### Option B — one exporter/provider per project

- Create a `TracerProvider` and OTLP exporter per active project.
- Resource includes `openinference.project.name = aifactory-<projectId>`.
- Gives Phoenix project separation.
- Requires lifecycle management and resource limits.
- Recommended if staying with one Phoenix instance and project users must be isolated.

### Option C — one Phoenix instance per tenant/project

- Strongest isolation.
- Expensive and operationally heavier.
- Recommended for untrusted tenants or regulated data.

### Option D — OTLP collector routing

- A collector receives all spans and routes by `project.id`/resource.
- Requires a collector and custom routing.
- Useful at scale, but more moving parts than we need now.

**Decision:** Option B — one shared Phoenix instance, one tracer provider/exporter per AI Factory project, with `openinference.project.name = aifactory-<projectId>`.

This was implemented and verified: Phoenix created a separate project for the test project and the AI Factory summary API read only that project's spans.

---

## 9. Application integration

Add an optional `telemetry.ts`:

```text
initTelemetry()
  ├── no-op when disabled
  ├── NodeTracerProvider
  ├── BatchSpanProcessor
  └── OTLP gRPC exporter -> 127.0.0.1:4317
```

Integration points:

- `PlanningStageRuntime.execute` — `stage.run`
- `runRole` — `stage.role`
- DSH `tool_call`/`tool_result` — `tool.call`
- review/document/human events — span events
- errors — span status and safe error attributes

Configuration:

```sh
AIFACTORY_PHOENIX_ENABLED=1
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317
OTEL_SERVICE_NAME=aifactory
AIFACTORY_PHOENIX_ENVIRONMENT=dev
AIFACTORY_PHOENIX_CAPTURE_CONTENT=0
AIFACTORY_PHOENIX_CAPTURE_MAX_CHARS=2000
AIFACTORY_PHOENIX_RETENTION_HOURS=24
AIFACTORY_PHOENIX_REQUEST_TIMEOUT_MS=5000
AIFACTORY_PHOENIX_OTLP_TIMEOUT_MS=5000
AIFACTORY_PHOENIX_BREAKER_THRESHOLD=3
AIFACTORY_PHOENIX_BREAKER_COOLDOWN_MS=30000
AIFACTORY_PHOENIX_SHUTDOWN_TIMEOUT_MS=3000
```

Rules (implemented):

- never block a stage turn on Phoenix export;
- every export has a hard timeout (default 5 s) and a per-project circuit breaker (3 consecutive failures, 30 s cool-down); while open, spans are dropped and counted instead of retrying;
- every telemetry method is wrapped and cannot throw into a stage run;
- shutdown flushes providers with a 3 s deadline, and never waits on an unreachable OTLP endpoint;
- REST summary has a 5 s timeout and a client-side breaker; a dead Phoenix returns `available:false` quickly;
- project deletion performs Phoenix cleanup in the background, never blocking the API response;
- no-op tracer in tests;
- do not attach the event-log payload wholesale.

**Phoenix does not ingest OTLP logs.** `POST /v1/logs` returns 405, and its OpenAPI only exposes span ingestion. Application-log export is therefore a separate OTLP/HTTP logs sink targeting an OTel Collector or another OTLP logs backend. Log records carry `traceId`/`spanId`, so they can be correlated with Phoenix traces, but they are not stored in Phoenix.

---

## 10. Implementation phases

### Phase 0 — Harden Phoenix (must happen first)

- bind 6006/4317 to loopback or private network;
- enable auth and set a strong secret;
- add persistent PostgreSQL or a volume;
- confirm no unauthenticated `/v1/projects`;
- define retention.

### Phase 1 — Metadata traces

- add optional telemetry module;
- instrument `stage.run` and `stage.role`;
- add token/duration/status attributes;
- no prompts, output, thinking or tool arguments;
- verify a trace in Phoenix for a planning run.

### Phase 2 — Project routing

- choose Option A/B/C;
- if B, implement per-project tracer providers/exporters;
- add `openinference.project.name`;
- verify project A cannot see B in the intended access model.

### Phase 3 — Opt-in content

- add redaction/truncation;
- add per-project content-capture policy;
- test with synthetic secrets;
- document retention.

### Implemented in this iteration

- optional `phoenix.ts` client and telemetry;
- per-project OTel tracer providers with `openinference.project.name`;
- `stage.run` and `stage.role.*` spans;
- token usage, review and document events;
- metadata-only default, content capture env switch;
- `GET /api/projects/:id/observability?hours=24`;
- verified separate Phoenix project and summary for a test project.

### Remaining before production

- loopback/private port binding and authentication;
- persistent Phoenix database;
- actual 24-hour trace deletion (the current 24h value is the summary window);
- project-user access model;
- tool-level spans and alerts.

### Phase 4 — Operations

- dashboards for stage latency/tokens/errors;
- alerts for role timeouts and lease recovery;
- trace deletion on project deletion;
- backup/retention review.

---

## 11. Acceptance checklist

- [ ] Phoenix is not exposed on `0.0.0.0` without auth.
- [ ] `/v1/projects` is not anonymously accessible from a non-loopback client.
- [ ] Phoenix data survives a container restart.
- [ ] Trace export is optional; API works with Phoenix stopped.
- [ ] Metadata-only traces contain no prompts, documents, thinking or commands.
- [ ] Project ID/run ID/stage/role are present.
- [ ] Token and duration attributes appear when available.
- [ ] A project user cannot access another project’s traces.
- [ ] Project deletion removes/deprecates its traces per policy.
- [ ] Retention and access policy are documented.

---

## 12. Open decisions

1. Is Phoenix only for operators, or should project users see their own traces?
2. If project users see traces, does this Phoenix version support per-project access control, or do we need one instance per tenant?
3. Which backend: Phoenix PostgreSQL or persistent volume?
4. Retention: 24h, 7d or 30d?
5. Is prompt/response capture ever allowed, and under which project classification?
6. Per-project exporter (Option B) or per-tenant Phoenix (Option C)?

---

## 13. References

- Phoenix project routing: <https://www.arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/setup-projects#log-to-a-specific-project>
- Phoenix resource attributes: <https://arize.com/docs/phoenix/tracing/concepts-tracing/otel-openinference/resource>
- Phoenix authentication defaults: <https://github.com/arize-ai/phoenix/blob/642585376568cee44c982da90eb67180bfaa7861/internal_docs/specs/authentication-defaults.md>
- Phoenix persistence: <https://raw.githubusercontent.com/Arize-ai/phoenix/1da324d749760d7cbe64efe8553ee965f7e8c8ae/docs/deployment/persistence.md>

> **Modularity review (2026-11-13):** current Phoenix runtime isolation is strong, but the integration is not yet behind interfaces. See [OBSERVABILITY-PORTS.md](OBSERVABILITY-PORTS.md) for findings and the refactor plan.
