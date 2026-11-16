# UI Implementation Prompt — Run Telemetry Status Bar

**For:** the UI implementation agent  
**Scope:** a bottom status bar showing live run telemetry, like the one in the DeepSeek Harness UI  
**Backend:** AI Factory HTTP API at `http://127.0.0.1:8787`  
**API contract:** `/openapi.yaml`, live console at `/docs`

---

## Your task

Add a **status bar** that shows, for the run the user is looking at:

```
◐ turns 1 · steps 2 · 250 tok/s · 5.5k tokens · cache 66.7% · context 5% ▓░░░░░░░░░ · claude-sonnet-4-5
```

It appears in **two places**:

1. the **chat** view (one turn per message);
2. the **stage run** view (a whole analyzer/author/reviewer run, which spans many turns).

Both read the same object, so the bar behaves identically in both.

**The data already exists.** The backend folds the harness event stream into one telemetry snapshot. Do not compute these numbers yourself from raw events, and do not estimate anything: every figure shown must come from the API.

---

## Where the data comes from

### Live (while a run is happening)

Both streams emit a dedicated `telemetry` event. The payload **is** the snapshot:

```
event: telemetry
data: {"turns":1,"steps":2,"phase":"step_end","usage":{...},"lastStep":{...},...}
```

- **Chat:** `POST /api/chat/stream` → `event: telemetry`, plus `status` events now carry `usage`.
- **Stage run:** `GET /api/stage-runs/:runId/events/stream` → `event: telemetry` immediately on connect (so a late joiner sees the current state at once) and again after each change.

Replace the bar's state with each snapshot. Do **not** accumulate or add them up — each snapshot is already the whole truth for the run.

### Historical (a finished run)

```
GET /api/stage-runs/:runId/telemetry
```

```json
{ "telemetry": { "turns": 1, "steps": 3, "tokensPerSecond": 250, ... } }
```

Use this when opening a run that is already finished, so the bar is populated before any stream connects.

---

## The fields

| Field | Bar label | Notes |
|---|---|---|
| `turns` | `turns` | Highest turn seen |
| `steps` | `steps` | Completed steps |
| `tokensPerSecond` | `tok/s` | Throughput of the **last step**; the live figure |
| `usage.total` | `tokens` | Cumulative for the run |
| `cacheHitPercent` | `cache` | 0–100, append `%` |
| `contextUsedTokens` / `contextWindow` | `context` | Show a percentage **and** a small bar |
| `contextUsedPercent` | `context` | 0–100, append `%` |
| `model` | model name | `"provider/model"`, or the model name alone if space is tight |
| `phase` | (optional) | e.g. a dot colour or a subtle "thinking/drafting" hint |

Also available if you want a tooltip: `averageTokensPerSecond`, `lastStep.durationMs`, `usage.input`/`output`/`cacheRead`/`cacheWrite`, `startedAt`, `updatedAt`.

---

## Hard rules

1. **`null` means "no number yet" — render `—`, never `0`.**
   - `tokensPerSecond` is null until a step has both a start and an end.
   - `cacheHitPercent` is null when there were no prompt tokens.
   - `contextUsedPercent` is null when the model's context window is unknown.
   - `0` is a real value (for example a free local model's cost); do not treat it as missing.
2. **Never derive or interpolate.** If a field is null, show "—". Do not compute t/s from a timer you control, and do not estimate tokens.
3. **Format compactly.** The bar must fit on one line at 1280 px wide.
   - tokens: `950` · `5.5k` · `1.2M` (one decimal below 10k)
   - t/s: integer (`250`) or one decimal below 10 (`2.5`)
   - percentages: one decimal below 10, otherwise integer (`5%`, `66.7%`)
4. **Context percent needs a colour cue.** Use a subtle bar: green under 60%, amber 60–85%, red above 85%. Tooltip: "10,000 of 200,000 context tokens (5%)". The bar is a *rendering* of `contextUsedPercent`, not a second calculation.
5. **Update smoothly.** The bar re-renders on each `telemetry` event; do not animate numbers, and do not reflow the layout when a digit count changes (use tabular figures / fixed-width number spans).
6. **One bar per view.** In the stage run view it reflects the whole run (all roles); in chat it reflects the current conversation turn. Do not show per-role bars in the status bar — the activity stream already shows roles.

---

## States

| Situation | Bar shows |
|---|---|
| No run selected / no usage yet | `—` for every metric, or hide the bar until the first snapshot |
| Stream connected, no usage yet | `turns 0 · steps 0 · — tok/s · — tokens · …` |
| Run finished | keep the last snapshot; optionally add a "finished" dot |
| Stream error | keep the last values and mark them stale (dim the bar); do not blank it |
| `runPrompt`/test runs with no model | `model` is null → hide the model label only |

`phase` values seen: `turn_start`, `step_start`, `step_end`, `turn_end`. A useful mapping for a status dot: a step in progress (`step_start` without a following `step_end`) = "working"; `turn_end`/`step_end` = "idle".

---

## Layout guidance

One line, bottom of the view, above the composer:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ◐ turns 1 · steps 2 · 250 tok/s · 5.5k tokens · cache 66.7%                 │
│  context 5% ▓░░░░░░░░░ · anthropic/claude-sonnet-4-5                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Left group: turns, steps, throughput, tokens.
- Right group: cache, context (with bar), model.
- On narrow screens, drop `turns`/`steps` into the tooltip first, then `cache`; **never** drop the context bar or the model.
- Tabular numbers, 11–12 px, muted colour; it is ambient information, not primary content.
- Make the whole bar a tooltip target with the full detail (input/output/cache split, average t/s, window).

---

## Acceptance criteria

- [ ] The bar appears in both chat and the stage run view and looks identical.
- [ ] While a run streams, turns, steps, t/s, tokens, cache % and context % update from `telemetry` events.
- [ ] Opening a **finished** run populates the bar from `GET /api/stage-runs/:runId/telemetry` before any stream connects.
- [ ] A null field renders as `—`; `0` renders as `0`; the two are never confused.
- [ ] No number on the bar is computed client-side from anything other than the snapshot fields.
- [ ] The context bar turns amber above 60% and red above 85%, and its tooltip shows tokens and window.
- [ ] The bar fits on one line at 1280 px and degrades by moving fields into the tooltip.
- [ ] A stream failure dims the bar but keeps the last values.
- [ ] Numbers use tabular figures and do not cause layout shift as they grow.
