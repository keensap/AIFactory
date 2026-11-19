# AI Factory chat CLI

The first runnable slice of the AI Factory: a small interactive chat client that uses **DeepSeek Harness** as its agent runtime.

**Design walkthrough:** [DESIGN.md](DESIGN.md) — context, components, one-turn flow, session continuity, lifecycle and failure precedence.

**HTTP API:** [API.md](API.md) — JSON and SSE endpoints for a separate UI, plus [openapi.yaml](openapi.yaml).

It is intentionally narrow. It proves the most important integration seam — a terminal can start a harness run, stream its events, keep a Session across turns, surface failures and shut down cleanly — without committing yet to a long-lived daemon, a database, or a web UI.

## Quick start

Requirements:

- Node.js **24+** (the source uses native TypeScript execution).
- A DeepSeek Harness installation whose `headless` profile is usable.
- A model credential available to headless mode.

```sh
cd apps/chat-cli
node src/cli.ts
```

If `dsh` is not on `PATH`:

```sh
npm install -g @deepseek-ai/dsh
# or
DSH_BIN=/path/to/dsh node src/cli.ts
```

### Using an existing harness checkout

If the harness lives at `/fs22/deepseek-harness`, point `DSH_BIN` at its **built CLI entrypoint**, not at the repository root:

```sh
export DSH_BIN=/fs22/deepseek-harness/apps/cli/lib/bin.js
"$DSH_BIN" --version          # sanity check
cd /data/AIFactory2/apps/chat-cli
node src/cli.ts
```

`DSH_BIN` must name one executable file; the client passes the harness flags itself. A directory will fail with `EACCES`/`ENOENT`. For a one-off run, use the flag instead of exporting:

```sh
node src/cli.ts --dsh-bin /fs22/deepseek-harness/apps/cli/lib/bin.js
```

**Launch settings and `.env`.** The harness treats every `DSH_*` variable as launch-only and refuses to boot if one appears in `.env`. Use the `.env`-safe CLI names instead:

```dotenv
DEEPSEEK_API_KEY=sk-...
AIFACTORY_DSH_BIN=/fs22/deepseek-harness/apps/cli/lib/bin.js
AIFACTORY_TIMEOUT_MS=120000
```

`AIFACTORY_DSH_BIN` takes precedence over `DSH_BIN`; `--dsh-bin` takes precedence over both. The CLI detects `DSH_*` keys in `.env` and prints an instruction instead of starting the child. Exporting `DSH_BIN` in the shell also works and is the right choice when you do not want it in the workspace file.

The built entrypoint is a generated artefact. After updating harness sources, rebuild it:

```sh
cd /fs22/deepseek-harness
pnpm run build
```

If the file is missing in a fresh checkout, run the build before pointing at it. If `dsh` is installed globally, `DSH_BIN` can be omitted entirely.

Headless mode reads `DEEPSEEK_API_KEY` from the launching environment, `<workspace>/.env`, or `$DSH_HOME/.env`. It does **not** use a sign-in saved by the web GUI. Run the built-in check first:

```sh
node src/cli.ts doctor
```

## HTTP API

The same transport is exposed over HTTP for a separate UI:

```sh
node src/api.ts                 # http://127.0.0.1:8787
# then browse to http://127.0.0.1:8787/docs for the interactive console
curl -s http://127.0.0.1:8787/api/health
```

Endpoints include `POST /api/chat`, `POST /api/chat/stream` (SSE), session listing/history, project CRUD, chat settings, directory browsing, PDF requirement review and health. Projects are stored in PostgreSQL (`DATABASE_URL`); see [infra/README.md](../../infra/README.md) for the local database. The `maxActiveProjects` setting defaults to 3 and is enforced across all activation paths.

PDF requirement review is project- and session-scoped:

```text
POST /api/projects/:projectId/sessions/:sessionId/pdf-review
multipart: file=<pdf>, message=<review instruction>
```

The API extracts PDF text, attaches project context, and asks the model to act as a product manager. It returns either a Markdown review or a list of questions. See [API.md](API.md) for the response shapes.

Project status is deterministic and lives in PostgreSQL: `GET /api/projects/:id` returns the current SDLC stage, completed stages, checklist, next actions and documents alongside the project. Documents are stored under `<project-root>/.aifactory/documents/`. `POST /api/projects/:id/briefing` adds a cached AI narrative on top of those facts.

The default stage names are seeded in `sdlc_stages` and exposed at `GET /api/sdlc/stages` for UI display. That table is reference data only; `project_stages.stage` stores the key without a foreign key, so per-project renaming and skipping can be added later.

The **Planning & Feasibility** stage uses a single `telos_report` document. Its checklist captures the business idea, stakeholder goals, the TELOS report and the go/conditional-go/no-go decision; there is no planning-stage SRS.

The API process must be able to write `<project-root>/.aifactory/documents/`. Running it inside a sandbox that only permits the AI Factory workspace will fail at the final TELOS save with a project-root permission error.

Phoenix observability is optional. Set `AIFACTORY_PHOENIX_ENABLED=1` to export per-project traces to Phoenix and expose `GET /api/projects/:id/observability`. Prompt/output capture is disabled by default (`AIFACTORY_PHOENIX_CAPTURE_CONTENT=0`).

Semantic retrieval uses PostgreSQL + pgvector. Set `AIFACTORY_EMBEDDING_URL` and `AIFACTORY_EMBEDDING_MODEL` to an OpenAI-compatible `/v1/embeddings` endpoint, run `CREATE EXTENSION vector` once as a database superuser, then use `POST /api/projects/:id/index` and `GET /api/projects/:id/search?q=...`.

Structured logging is async and sink-based (console and rolling file by default; PostgreSQL storage is opt-in from `PATCH /api/settings/logging`). Application logs: `GET /api/logs`; pipeline health and temporary level changes: `/api/admin/logging`. Project logs are available at `GET /api/projects/:id/logs` with level, type, role, run and search filters plus cursor pagination for the AI Factory log viewer.

Stage runs also persist an ordered event log (`role_start`, `thinking`, `tool_call`, `tool_result`, `review_decision`, `document_created`, …) and expose it at `GET /api/stage-runs/:runId/events` plus an SSE stream.

Stage execution uses a PostgreSQL run lease (`locked_by`, `lease_expires_at`) with a heartbeat. A second worker is rejected; runs stranded by a crashed worker are marked `failed` at startup or by the 60-second recovery sweep so the user can start a new attempt.

Planning has a working stage controller: `POST /api/projects/:id/stages/planning/runs` creates a run, `POST /api/stage-runs/:runId/execute` runs analyzer → TELOS author → reviewer in the background, and `POST /api/stage-runs/:runId/decision` records the human gate. Execution is asynchronous by default; poll `GET /api/stage-runs/:runId`.

## What it looks like

```text
AI Factory chat · dsh --profile headless
Type /help for commands, /exit to leave.

you> explain what the harness does in one paragraph
ai> The harness runs an agent loop around a model, tools and a persisted
    session, and exposes the run as a stream of events...

you> /session
session-35afa698-c93d-4d2e-9965-12a16496d265

you> /new
new session will start on the next message.
```

Commands:

| Command | Effect |
|---|---|
| `/help` | Show the command list |
| `/new` | Drop the current session id; the next turn starts a fresh session |
| `/session` | Print the current session id |
| `/exit`, `/quit` | Leave the chat |

Useful flags:

| Flag | Effect |
|---|---|
| `--dsh-bin <path>` | Harness executable (default `$AIFACTORY_DSH_BIN`, `$DSH_BIN`, or `dsh`) |
| `--profile <name>` | Harness profile (default `$AIFACTORY_PROFILE` or `headless`) |
| `--permission-mode <p>` | Pass a permission preset through to headless |
| `--resume <session-id>` | Continue an existing harness Session |
| `--timeout <ms>` | Per-turn wall-clock limit (default 120000) |
| `--show-thinking` | Print `thinking` events to stderr |
| `--debug` | Print tool calls and harness stderr on failure |

## How it works

```text
┌──────────────┐   prompt on stdin    ┌────────────────────────────┐
│  cli.ts      │ ───────────────────▶ │ dsh --profile headless     │
│  REPL        │                      │ --json [--session-id ...]  │
│              │ ◀─────────────────── │ NDJSON events on stdout    │
└──────┬───────┘                      └────────────┬───────────────┘
       │                                           │
       │ uses                                      │ persists
       ▼                                           ▼
┌──────────────┐                            ┌──────────────┐
│ harness.ts   │  one process per turn      │ DSH Session  │
│ transport    │  session id carried over   │ storage      │
└──────────────┘                            └──────────────┘
```

### One process per turn

Each user message spawns a fresh headless process. That is deliberately simple:

- No long-lived child to babysit, reconnect or version-negotiate in this first slice.
- A crashed or hung turn cannot poison later turns.
- Session continuity is still preserved because the harness persists the Session and accepts `--session-id` on the next run.

The cost is process startup latency. The next transport can use the long-lived SDK JSON-RPC surface once the chat loop needs lower latency or live tool approval.

### Prompt goes through stdin

The prompt is written to the child's stdin, not passed as `argv`. That avoids option parsing for prompts beginning with `-`, and avoids operating-system argument limits for long prompts. The harness reads the piped task verbatim.

### One Session per conversation

The opening `session` event carries the Session id. The client stores it and passes it back with `--session-id` on the next turn. `/new` clears it. `--resume` seeds it from the command line.

### The event stream

The harness emits newline-delimited JSON. The client understands the public projection:

| Event | Meaning | Client behaviour |
|---|---|---|
| `session` | Opening event with `sessionId` and `cwd` | Store the session id |
| `status` | Turn and step boundaries | Ignore for display |
| `text` | A committed assistant text block | Print it; prefix the first block with `ai>` |
| `thinking` | Committed reasoning text | Print only with `--show-thinking` |
| `tool_call` | A tool invocation | Print only with `--debug` |
| `tool_result` | Tool outcome | Print failures only with `--debug` |
| `final` | Terminal event with `text` and `reason` | Fallback answer and error mapping |
| `error` | Runner-level failure outside a turn | Raise a `HarnessError` |

`text` and `thinking` are commit points, not token deltas. A retried attempt never appears in the stream. That is why the UI may pause and then print a whole block rather than stream token by token; true token streaming needs a different transport.

### Failure mapping

The client treats a turn as successful only when:

1. the process exits `0`,
2. the stream contains a Session id, and
3. `final.reason.kind`, when present, is `completed`.

A structured `final.reason.error` is surfaced as the user-facing message. For example, a missing key produces:

```text
error: llm-deepseek: no API key for provider route "deepseek-official"; ...
code: MISSING_CREDENTIAL
```

instead of a generic "exit code 1". Timeouts, cancellation, spawn failures and malformed event lines each have distinct handling. Malformed lines are counted and ignored so one bad line does not discard a valid answer.

## Files

| File | Responsibility |
|---|---|
| `src/protocol.ts` | Event types, tolerant NDJSON parsing, reason helpers |
| `src/harness.ts` | Process lifecycle, stdin prompt, event collection, timeout, abort, error mapping |
| `src/cli.ts` | Argument parsing, REPL, rendering, `/commands`, `doctor` |
| `scripts/fake-dsh.mjs` | Deterministic harness stand-in for tests |
| `test/harness.test.ts` | Session continuity, parser tolerance, errors, timeout |

The dependency graph is deliberately acyclic: `cli.ts → harness.ts → protocol.ts`. There are no runtime dependencies.

## Testing

```sh
node --test test/*.test.ts
```

The tests use a fake harness process, so they need no model, API key or network. They cover:

- one turn and session extraction,
- resuming with `--session-id`,
- ignoring non-JSON stdout lines,
- structured error events,
- timeout and child cleanup,
- empty-prompt rejection.

Stage-run and repository tests also use PostgreSQL. Point `AIFACTORY_TEST_DATABASE_URL` at a disposable database (for example the `aifactory_test` database next to `DATABASE_URL`); tests that need it are skipped without it.

The requirements stage regressions (`test/stage-requirements*.test.ts`, `test/requirements-*.test.ts`) use a realistic contract-complete fixture and one fixture per failure mode in `test/support/requirements-fixture.ts`. With a reviewer that approves everything, every failure fixture must still stop at the final gate unaccepted, refuse ordinary approval and publish nothing.

### Live requirements smoke test (opt-in)

`npm test` never calls a model. To check the real Planning → Requirements lifecycle end to end, start the API with a working generation model (a configured model target or the harness profile default) and PostgreSQL, then run:

```sh
npm run smoke:requirements            # against http://127.0.0.1:8787
AIFACTORY_SMOKE_KEEP=1 npm run smoke:requirements   # keep the project for inspection
```

The script creates a scratch project in a temp directory, runs Planning to its gate and approves it (`go`), advances to Requirements, runs it, refines once if deterministic coverage blockers remain, and approves. It checks that the planning baseline is frozen into the run, that the gate carries a coverage report, that ordinary approval is refused while blockers remain, that a `requirements_spec` document and its PDF are produced, and that the summary and PDF are named for requirements. Drafts per pass, the final summary and `smoke-report.json` are written to `<project root>/smoke-report/`.

Only deterministic coverage blockers can fail it; when the model reviewer still has findings at the gate (the budget ran out), the smoke approves and records a warning in the report, as an operator would decide. Remaining coverage blockers fail the smoke (exit 1) and leave the run at its gate. Set `AIFACTORY_SMOKE_WAIVER="reason"` to approve them with an audited waiver instead. Other settings: `AIFACTORY_SMOKE_API`, `AIFACTORY_API_TOKEN`, `AIFACTORY_SMOKE_ROOT` (must exist for, and be writable by, the API process — set it when the API runs with a different `/tmp`, e.g. `.data/smoke/<name>`), `AIFACTORY_SMOKE_BRIEF`, `AIFACTORY_SMOKE_REFINES` (default 1), `AIFACTORY_SMOKE_TIMEOUT_MS` (per run, default 45 min). Exit code 2 means the environment is not ready (API down, no database, stage not executable). CI should run it only in a job that has model credentials.

To exercise the CLI against the fake harness manually:

```sh
printf 'hello\n/session\n/exit\n' \
  | node src/cli.ts --dsh-bin ./scripts/fake-dsh --profile headless --no-color
```

## Design notes and limits

- **Subprocess, not library.** Importing harness internals would couple the CLI to a developer-preview package layout. The headless JSON contract is the stable seam and keeps the CLI language-agnostic.
- **No token-level streaming yet.** Headless `--json` emits committed blocks. Live deltas are a deliberate later change, likely through the SDK transport.
- **No tool approval UI yet.** The CLI passes `--permission-mode` through, but headless has no live approval channel. A chat that can safely run tools needs an approval loop and a permission preset designed for it.
- **No cost display yet.** Token usage is available in events/ledger work later; this slice only proves conversation and session continuity.
- **One conversation at a time.** The REPL is sequential by design; concurrent turns would need a different scheduler and output model.
- **Credentials are inherited, never printed.** `doctor` reports presence, not values. The child sees the parent environment.

## Next slices

1. **SDK transport**: keep one JSON-RPC process alive, stream deltas, expose cancellation and reconnect.
2. **Session picker**: list, resume and name sessions instead of copying ids.
3. **Tool approvals**: a terminal prompt with allow/deny/always, backed by a permission preset.
4. **Usage and cost**: read token usage from events, show per-turn and per-session totals.
5. **Workspace context**: `--add-dir`, repository selection and a visible working-directory banner.
6. **Chat history**: persist a local transcript index for search and replay, without duplicating the harness Session log.
