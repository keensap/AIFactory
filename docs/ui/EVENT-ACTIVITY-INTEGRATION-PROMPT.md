# UI Integration Prompt — Live Stage Activity

**For:** the UI implementation agent  
**Scope:** integrate the persisted stage-run event stream into the existing stage workspace  
**API base:** `http://127.0.0.1:8787`  
**Related UI spec:** [STAGE-UI-PROMPT.md](STAGE-UI-PROMPT.md)  
**Backend design:** [STAGE-RUNTIME.md](../design/STAGE-RUNTIME.md)

---

## Your task

Add a **live Activity view** to each stage run. The current UI only shows coarse run status (`analyzing`, `reviewing`, …). The backend now exposes an ordered event log containing:

- role start/end/error and durations;
- model reasoning blocks;
- assistant text;
- tool names, arguments and commands;
- tool results and errors;
- review decisions;
- document creation;
- human decisions.

Build this as a collapsible **Activity drawer** on the run workspace, not a separate page and not a replacement for the existing status/decision UI.

The primary outcome:

> While a stage is running, the user can open Activity and see what the analyzer, author and reviewer are actually doing, without waiting for the run to finish.

---

## API contract

### Read persisted events

```http
GET /api/stage-runs/:runId/events?after=<id>&limit=200
Authorization: Bearer <token>
```

Response:

```json
{
  "events": [
    {
      "id": "42",
      "projectId": "…",
      "stageRunId": "…",
      "role": "reviewer",
      "agentId": "reviewer",
      "type": "tool_call",
      "phase": null,
      "payload": {
        "type": "tool_call",
        "callId": "call-1",
        "tool": "bash",
        "input": { "command": "rg -n refund docs" }
      },
      "createdAt": "2026-11-11T07:00:00.000Z"
    }
  ],
  "nextAfter": "42"
}
```

- `id` is a string containing a numeric database id.
- Events are ordered by numeric id, not lexicographic string order.
- `role` is `null` for run-level events.
- `agentId` is currently the role name; future child agents will use distinct ids.
- `payload` shape depends on `type`.

### Live stream

```http
GET /api/stage-runs/:runId/events/stream?after=<id>
Authorization: Bearer <token>
Accept: text/event-stream
```

SSE frames:

```text
id: 42
event: stage
data: {"id":"42","type":"text",...}

: keepalive

event: end
data: {}
```

- `event: stage` carries one event.
- `event: end` means the run is terminal and no more events exist.
- `event: error` means the stream failed.
- `: keepalive` comments every 15 seconds.
- `awaiting_human` runs keep the stream open so a later `human_decision` event can arrive.
- Completed/failed/cancelled runs replay remaining events and then send `end`.
- Reconnect with the last received `id` using `?after=<id>`.
- `Last-Event-ID` is supported by the server, but prefer the explicit query parameter when using `fetch`.

### Important browser constraint

`EventSource` cannot send the `Authorization: Bearer …` header. Do **not** use `EventSource` unless the API is behind a same-origin session proxy.

Use `fetch()` and consume `response.body` as a `ReadableStream`.

---

## Project log history

The run Activity view covers one run. Add a project-level **Logs** view for all runs:

```http
GET /api/projects/:id/logs?limit=100&before=<id>&level=error&role=reviewer&runId=<id>&q=timeout
```

Response:

```json
{
  "logs": [
    {
      "id": "128",
      "stageRunId": "...",
      "stage": "planning",
      "attempt": 2,
      "role": "reviewer",
      "level": "error",
      "type": "role_error",
      "message": "reviewer failed: harness turn timed out",
      "preview": null,
      "payload": {},
      "createdAt": "..."
    }
  ],
  "nextBefore": "128"
}
```

Use it for:

- newest-first history across stage runs;
- level filters: debug / info / warn / error;
- role and stage filters;
- free-text search;
- “Load older” with `before=nextBefore`;
- clicking a row jumps to the run or opens the raw payload.

Render `message` as the primary line, `preview` for thinking/text, and keep `payload` behind a detail disclosure. This is the same data as the run event stream, but paginated and filterable.

## Event types

| Type | Role | Payload | UI treatment |
|---|---|---|---|
| `role_start` | role | `{ role, timeoutMs }` | Role group header |
| `session` | role | `{ sessionId, cwd }` | Hide by default |
| `status` | role | `{ phase, turn?, step?, usage? }` | Compact step marker; collapse repeats |
| `thinking` | role | `{ text }` | Collapsed reasoning block |
| `text` | role | `{ text }` | Assistant text block |
| `tool_call` | role | `{ tool, input, callId? }` | Tool row; command in monospace |
| `tool_result` | role | `{ status, result?, error?, callId? }` | Collapsed output |
| `final` | role | `{ reason, text?, sessionId }` | Mark role complete; do not duplicate the full text if already shown |
| `role_end` | role | `{ role, durationMs, textLength, stderr? }` | Duration badge |
| `role_error` | role | `{ role, durationMs, message }` | Error row |
| `review_decision` | run | `{ decision, findings }` | Review card with finding count |
| `document_created` | run | `{ documentId, kind, storagePath }` | Artifact link |
| `human_decision` | run | `{ decision, note }` | Gate result |

The actual `tool_call` projection uses `tool` and `input`, not `name` and `arguments`. Some older events may use the compatibility fields; support both.

`thinking` is model-dependent. If the provider does not emit reasoning, show nothing rather than “thinking…” indefinitely.

---

## Component structure

Add to the run workspace:

```text
StageRunWorkspace
├── RunStatusCard                  existing
├── StageRunActivity               new
│   ├── ActivityHeader             live state, current activity, event count
│   ├── ActivityFilters            role/type/errors
│   ├── ActivityTimeline
│   │   ├── RoleGroup              analyzer / author / reviewer
│   │   │   ├── ActivityRow
│   │   │   └── ...
│   │   └── RunGroup               review / document / human decision
│   └── ActivityDrawer             desktop side panel / mobile sheet
└── DecisionPanel                  existing
```

### Placement

Desktop:

- right-side drawer, resizable, default width ~420px;
- a compact “Activity” button in the run header with a live dot;
- a one-line **current activity** under the status card;
- the drawer overlays the context panel, not the entire page.

Mobile:

- full-screen sheet;
- sticky filter row;
- close returns to the run workspace.

Do not replace the run status card. Activity is an optional detail layer.

---

## Current activity line

Derive one short line from the latest meaningful event:

| Event | Text |
|---|---|
| `role_start` | `Analyzer started` |
| `tool_call` | `Reviewer is running bash` |
| `thinking` | `Reviewer is reasoning` |
| `text` | `Author is writing the TELOS` |
| `role_end` | `Analyzer completed in 16s` |
| `review_decision` | `Reviewer requested changes` / `Reviewer approved` |
| `document_created` | `TELOS report saved` |
| `role_error` | `Reviewer failed` |
| `human_decision` | `Decision recorded` |
| no events | `Waiting for events…` |

Clicking the line opens the Activity drawer.

---

## Streaming client

Implement one reusable client, not per-component `fetch` calls.

### API

```ts
type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'error'

interface StreamOptions {
  after?: string
  signal: AbortSignal
  onEvent: (event: StageRunEvent) => void
  onEnd: () => void
  onError: (error: Error) => void
  onState: (state: ConnectionState) => void
}

function streamStageEvents(runId: string, options: StreamOptions): Promise<void>
```

### Required behavior

1. Fetch with `Authorization` and `Accept: text/event-stream`.
2. If response is `404`, stop and show “Run not found.”
3. If response is `401/403`, stop and show an auth error.
4. Parse SSE incrementally; do not wait for the whole response.
5. Handle frames split across chunks and CRLF.
6. Ignore comments (`:` lines).
7. Support multi-line `data:` fields.
8. On `event: stage`, parse JSON and call `onEvent`.
9. On `event: end`, call `onEnd` and stop.
10. On `event: error`, call `onError`; allow one reconnect.
11. On network close before `end`, reconnect with backoff:
    - 1s, 2s, 5s, 10s;
    - maximum 5 attempts;
    - always use the latest received id as `after`.
12. Abort on unmount or run change.
13. Never create two concurrent readers for the same run.

### SSE parser sketch

```ts
async function* readSse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      yield frame
      boundary = buffer.indexOf('\n\n')
    }
  }
}
```

Parse `id:`, `event:` and `data:` from each frame. Do not assume one event per network chunk.

---

## State and ordering

Maintain:

```ts
const [events, setEvents] = useState<StageRunEvent[]>([])
const [lastId, setLastId] = useState<string>('0')
const [connection, setConnection] = useState<ConnectionState>('connecting')
const [isFollowing, setIsFollowing] = useState(true)
const [filters, setFilters] = useState({ role: 'all', type: 'all', errorsOnly: false })
```

Rules:

- Merge events by `id`; never duplicate on reconnect/replay.
- Keep numeric ordering: compare `BigInt(a.id)` or parse as safe integers; do not sort strings.
- Batch UI updates:
  - buffer incoming events for ~100ms or one animation frame;
  - append once per batch;
  - avoid a render per token.
- Cap the in-memory list, for example 2,000 events.
- When the cap is reached, offer “Load older” using the JSON endpoint with `after` before the oldest retained id. If not implemented, show a “trimmed” notice.
- On `end`, refresh the stage run with `GET /api/stage-runs/:runId`; do not assume the status from the last event.
- If the user opens Activity after the run completed, first call the JSON endpoint, then optionally connect to SSE from the last id; the stream will end immediately.
- Preserve events when the user switches between filters.

---

## Timeline rendering

Group by role in this order:

```text
Analyzer → Author → Reviewer → Run
```

Each role group:

- role name and status dot;
- start time;
- duration from `role_end`;
- event count;
- error count;
- collapse/expand.

Each row:

```text
17:31:28  thinking   Assessing TELOS evidence…        ▸
17:31:32  status     step 1 · 2.4k tokens
17:31:40  tool       bash
          $ rg -n refund docs                [copy]
          output ▸
17:31:52  text       The portal is feasible…  [expand]
17:32:05  review     needs_revision · 3 findings
```

Rules:

- Hide `session` by default; show under “Raw event.”
- Collapse consecutive `status` events into a single step marker.
- Collapse `thinking` by default; label it **Reasoning (may be summarized)**.
- Collapse `tool_result` output by default; cap height and truncate.
- Render `tool_call.input.command` in a code block with copy.
- For other tools, show the tool name and a compact JSON disclosure.
- `review_decision` opens the existing findings view or expands findings inline.
- `document_created` links to the document preview/download.
- `human_decision` shows decision and note.
- Do not render `thinking` as user-facing assistant prose; style it as secondary metadata.
- Do not render raw HTML from `text`, `thinking`, `result` or Markdown without sanitization.

---

## Filters and controls

Header:

- connection badge: Connecting / Live / Reconnecting / Ended / Error;
- event count;
- “Follow live” toggle;
- “Clear” is not allowed; this is an audit log;
- close button.

Filters:

- role: All / Analyzer / Author / Reviewer / Run;
- type: All / Model / Tools / Thinking / Reviews / Errors;
- errors only toggle;
- search across text/tool/command (client-side, capped).

Behavior:

- When “Follow live” is on, auto-scroll to bottom on new events.
- If the user scrolls up, pause auto-scroll and show “Jump to latest”.
- Clicking “Jump to latest” re-enables follow.
- Empty state: “No events yet. The run will write its first event when execution starts.”
- When disconnected: keep the last events visible and show Reconnecting.

---

## Security and privacy

- Send the bearer token only in the `Authorization` header.
- Do not put the token in the SSE URL.
- Do not log event payloads or tokens to the browser console in production.
- Treat thinking, tool input and tool output as sensitive project data.
- Add a client-side redaction pass for obvious secrets:
  - `api_key=…`, `token=…`, `password=…`, long bearer-like strings;
  - show `[redacted]` instead.
  - This is defense in depth, not a guarantee.
- “Raw event JSON” is an operator/debug affordance; put it behind a disclosure.
- Do not send event contents to analytics.
- Escape all text; never use unsanitized `dangerouslySetInnerHTML`.

---

## Accessibility

- Activity drawer has a labelled dialog/panel role.
- Keyboard: open, close, filter, expand/collapse, copy command.
- Do not use `aria-live` on every event. Announce only:
  - connection state changes;
  - role completion;
  - errors;
  - review decision.
- Preserve focus when opening/closing the drawer.
- Respect `prefers-reduced-motion` for live indicators.
- Ensure color is not the only status signal.

---

## Error states

| Condition | UI |
|---|---|
| `404` | “Stage run not found”; stop |
| `401/403` | “Session expired or token missing”; stop, no retry loop |
| `503` | “Event streaming is disabled” |
| `event: error` | “Live detail stream failed”; show last events; offer reconnect |
| Repeated network failure | Stop after 5 attempts; show reconnect button |
| Malformed event JSON | Skip that event, show a small “malformed event” warning |
| Run reaches `failed` | Stream ends; show error event and partial analysis/draft |
| Run reaches `awaiting_human` | Stream stays open; decision panel remains active |
| Run reaches `completed` | End stream; refresh run |

Do not show raw stack traces, prompts, tokens or environment values.

---

## Acceptance criteria

- [ ] Run workspace has an Activity button with live/ended/error state.
- [ ] Opening Activity loads persisted events and then tails live events.
- [ ] A running run shows analyzer/author/reviewer events without waiting for completion.
- [ ] Events appear in numeric order and are not duplicated after reconnect.
- [ ] Thinking is collapsed by default and expandable.
- [ ] Tool calls show name and command; output is collapsed.
- [ ] Review decision and document creation appear as distinct cards.
- [ ] `event: end` closes the stream and refreshes run status.
- [ ] `awaiting_human` leaves the stream open for a later decision event.
- [ ] Leaving the route aborts the stream; no duplicate readers.
- [ ] Reconnect uses the last id and backs off.
- [ ] 401/404 do not loop.
- [ ] Activity is usable on desktop and mobile.
- [ ] Keyboard and screen-reader behavior meet the accessibility section.
- [ ] No unsanitized HTML and no token in URLs.

---

## Out of scope

- Backend event changes.
- Claude Code/Codex internal child activity. The DSH provider still exposes only the parent subagent call and final result for those.
- Token-level streaming; events are committed blocks.
- A general log search service.
- Event deletion or editing.
- Sending events to external observability services.

---

## Handoff

Build against:

```text
GET /api/stage-runs/:runId/events?after=0
GET /api/stage-runs/:runId/events/stream?after=0
```

Existing runs created before the event table have no events. Verify against a new planning run after the backend is running with the event implementation.

Use the backend design for context: [STAGE-RUNTIME.md](../design/STAGE-RUNTIME.md).
