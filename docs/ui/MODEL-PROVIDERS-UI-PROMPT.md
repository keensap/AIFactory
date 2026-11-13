# UI Implementation Prompt — Models, Cost and Usage

**For:** the UI implementation agent  
**Scope:** the Factory-wide *Models* settings page, per-project model/cost views and a Factory usage report  
**Backend:** AI Factory HTTP API at `http://127.0.0.1:8787`  
**API contract:** `/openapi.yaml`, live console at `/docs`  
**Design:** `docs/design/MODEL-PROVIDERS.md`

---

## Your task

Build the screens that let an operator choose which AI model the whole Factory uses, check that it works, and see what it costs.

The product rule that shapes every screen:

> **There is one model target for the entire Factory.** It applies to every project and every stage. There is **no** per-project and **no** per-stage model picker. Do not build one, and do not imply one exists.

By the end, an operator must be able to:

1. see which providers exist and whether each one is usable (credential present, reachable);
2. discover a provider's models and set prices;
3. choose the global model, its tuning and a fallback chain;
4. run a test call and see exactly what happened, including fallbacks;
5. see which model produced the tokens in a project, and what they cost;
6. see Factory-wide spend by model, project and day;
7. recover a provider whose circuit breaker is open.

---

## Hard rules

1. **Never display, request or store an API key.** Providers reference an environment variable name (`apiKeyEnv`, e.g. `OPENAI_API_KEY`). The API returns only `credentialPresent: true|false`. Show the variable *name* and a status; never an input for the key. If a key is missing, tell the operator to set that variable in the Factory's `.env` or deployment environment and restart.
2. **Distinguish `null` from `0` for cost.** `costUsd: null` means **unknown (no price)**. `costUsd: 0` means **priced and free** (a local model). Render them differently ("—" or "no price" vs "$0.00"). Never coerce `null` to zero.
3. **A cost total can be partial.** Wherever a cost is shown with `unpricedTokens > 0`, show that the total excludes that many tokens (see [Cost coverage](#cost-coverage)).
4. **The model change affects future runs only.** A stage run keeps the model it started with. Say so next to the Save button.
5. **Admin actions need the admin token.** Discovery, health, test, pricing, breaker reset and the Factory usage report are admin endpoints. If the Factory is configured with a bearer token, send it; handle `401`/`403` with a clear "admin access required" state instead of a generic error.
6. **Do not poll hard.** Provider health is an explicit button, not a timer. The usage report refreshes on demand and when the date range changes.

---

## Navigation

Add a top-level **Settings → Models** page (`/settings/models`) next to the existing logging settings, with three tabs:

| Tab | Purpose |
|---|---|
| **Target** | Choose the global model and fallback chain, test it |
| **Providers** | Status, discovery, health, prices, circuit breakers |
| **Usage** | Factory-wide tokens and cost |

Add a **Models & cost** section to the existing project stats view (see [Project stats](#project-stats)).

---

## Tab 1 — Target

### Data

```
GET /api/settings/models
```

```json
{
  "target": {
    "provider": "anthropic", "model": "claude-sonnet-4-5",
    "temperature": 0.2, "maxTokens": 8000, "reasoningEffort": "medium",
    "fallback": [{ "provider": "openai", "model": "gpt-5" }]
  },
  "source": "settings",
  "warnings": ["OPENAI_API_KEY is not set; openai cannot be called"],
  "updatedAt": "2026-11-13T12:00:00.000Z",
  "providers": [ { "id": "anthropic", "credentialPresent": true, "modelCount": 12, "local": false, "enabled": true } ]
}
```

`source` is one of `settings` (saved in the UI), `environment` (from `AIFACTORY_MODEL_*` variables) or `unconfigured`.

### Layout

- **Header strip** — current target as `provider / model`, a source chip, and the warnings as a visible list (amber). `unconfigured` is a first-class state, not an error: show "No model configured — the harness default is used" and make the form the focus.
- **Form**
  - *Provider* select (only `enabled` providers; mark those with `credentialPresent:false` with a warning icon but keep them selectable — a key may be set later).
  - *Model* select populated from `GET /api/models?provider=<id>`. If the provider has no models yet, show a free-text input and a hint "Run discovery on the Providers tab to list models".
  - *Temperature* (0–2), *Max tokens* (1–200000), *Reasoning effort* (free text or `minimal|low|medium|high`). All optional.
  - *Fallback chain* — an ordered list, **maximum 4**, each a provider+model pair. Reorder with drag handles **and** up/down buttons (keyboard accessible). Disallow duplicates, including the primary.
- **Actions** — `Save` (`PATCH /api/settings/models`), `Reset to environment` (`DELETE /api/settings/models`), `Test` (below).

### Validation errors from `PATCH`

| `error.code` | Show |
|---|---|
| `PROVIDER_NOT_FOUND`, `PROVIDER_DISABLED` | on the provider field |
| `MODEL_NOT_FOUND` | on the model field: "not in this provider's catalogue — run discovery" |
| `INVALID_TARGET` | on the offending field (message names it) |
| `INVALID_FALLBACK` | on the fallback list |
| `EGRESS_BLOCKED` | banner: the Factory is restricted to local providers (`AIFACTORY_MODEL_EGRESS=local-only`); list which entry is cloud |

Do not pre-empt these with client-side rules beyond the obvious (required fields, numeric ranges, max 4, no duplicates): the server is the authority.

### Test call

```
POST /api/models/test     { "prompt"?: string, "maxTokens"?: 1-256, "timeoutMs"?: 1000-300000 }
```

Show a result card:

- the **serving model** (it may be a fallback — highlight when `attempts[0]` failed);
- `text` (monospace; note if `truncated`), `finishReason`, duration, tokens, cost (`null` → "no price");
- an **attempts timeline**: one row per entry in `attempts`, in order — provider/model, `outcome` (`ok` / `error` / `skipped`), `kind` for failures, `status` if present, `durationMs`.

Attempt `kind` values and a human wording:

| `kind` | Wording |
|---|---|
| `network` | "Could not reach the provider" |
| `timeout` | "Timed out" |
| `overloaded`, `rate_limit` | "Provider busy" |
| `auth` | "Credential rejected or missing" |
| `quota` | "Out of quota or credit" |
| `invalid_request`, `unsupported` | "Request not supported by this model" |
| `context_overflow` | "Input too long for this model" |
| `content_filter` | "Refused by the provider" |
| `unavailable` | "Skipped: provider is quarantined after repeated failures" |
| `unconfigured` | "No model configured" |

A failed test is a normal outcome, not a crash. Render these HTTP errors inline on the card:

| HTTP / `error.code` | Meaning |
|---|---|
| `503 MODEL_UNCONFIGURED` | no target set |
| `502 MODEL_UNAVAILABLE` | every target failed; the message lists each one |
| `504 MODEL_TIMEOUT` | the test did not finish in time |
| `422 MODEL_CONTENT_FILTER` | refused |
| `400 MODEL_*` | the request cannot be served as sent |

Disable the Test button while a call is in flight and show elapsed time. The call may legitimately take a long time on a local CPU model.

---

## Tab 2 — Providers

```
GET /api/models/providers
GET /api/admin/models           (admin)
```

A table, one row per provider:

| Column | Source |
|---|---|
| Name, kind, local/cloud badge | `displayName`, `kind`, `local` |
| Endpoint | `baseUrl` (null → "vendor default") |
| Credential | `apiKeyEnv` as a code chip + status from `credentialPresent`. Local providers with no key: "not required" |
| Models | `modelCount` |
| Circuit breaker | from `GET /api/admin/models` → `models.providers[].breaker` |
| Actions | Health, Discover, Reset breaker |

`GET /api/admin/models` also contains `applied` / `provider` / `model` / `patchPath` / `warnings` / `lastError`: what the agent harness is **actually** using right now. Show it as a small "Applied to agent runs" panel; if `lastError` is set, show it — it means the last settings change could not be applied and the previous model is still in effect.

### Actions

- **Health** — `POST /api/models/providers/:id/health` → `{ state: healthy|degraded|unconfigured, credential, reachable, latencyMs, lastError }`. Cloud providers on vendor defaults return `reachable: null`: say "not probed", not "down".
- **Discover** — `POST /api/models/providers/:id/discover`. Syncs that provider's catalogue: models still offered are updated and **keep their prices**, models that disappeared are removed, new models start with no price. Confirm first ("removes models the provider no longer lists"). Show how many models were found. Errors: `MODEL_NETWORK`, `MODEL_AUTH`, `MODEL_TIMEOUT` (502/504) — inline, with the provider name.
- **Reset breaker** — `POST /api/admin/models/providers/:id/reset`. Only enabled when the breaker is `open` or `half_open`.

### Circuit breaker display

```json
{ "provider": "openai", "breaker": { "state": "open", "consecutiveFailures": 3,
  "retryAt": 1794577000000, "lastError": "network: openai unreachable: ECONNREFUSED",
  "successes": 4, "failures": 3 } }
```

| `state` | Chip | Meaning to show |
|---|---|---|
| `closed` | green "Healthy" | normal |
| `open` | red "Quarantined" | calls skip this provider; show "retrying at {retryAt}" (epoch ms) and `lastError` |
| `half_open` | amber "Probing" | the next call will test the provider |

A provider with no entry in `providers[]` has not been called yet: show "—".

### Models and prices (expandable row, or a drawer)

```
GET /api/models?provider=<id>
PUT /api/models/price     { provider, model, input?, output?, cacheRead?, cacheWrite? }
```

A table of the provider's models: name, context window, capabilities (tools / thinking / JSON / vision as icons), and an editable **price per million tokens** for input, output, cache read and cache write.

- Show `price: {}` as "no price" (cost will be unknown), not as 0.
- Use number inputs, 0–100000, USD per **million** tokens. Label it clearly — per-token values will be wrong by six orders of magnitude.
- A price applies to usage recorded **from the next run on**. Past costs never change. Say so.
- Local models: offer a "Free (0)" shortcut that sets all prices to 0, so their cost reads `$0.00` rather than "unknown".
- Warn that **local models are marked tool-incapable until confirmed** (llama.cpp needs `--jinja` for tools); show the `tools` capability and do not let the UI imply otherwise.

---

## Tab 3 — Usage (Factory-wide)

```
GET /api/models/usage?days=30            (admin)
GET /api/models/usage?from=…&to=…
```

`days` must be an integer 1–365; reject anything else client-side too. Default 30. Provide presets (7 / 30 / 90) and a custom range.

```json
{ "usage": {
  "from": "…", "to": "…",
  "tokens": { "input": 0, "output": 0, "total": 0, "cacheRead": 0, "cacheWrite": 0 },
  "cost": { "usd": 0.0225, "pricedTokens": 4500, "unpricedTokens": 0 },
  "byModel":   [ { "provider": "openai", "model": "gpt-4o", "tokens": {…}, "calls": 3, "runs": 1, "costUsd": 0.0225, "pricedCalls": 3, "unpricedTokens": 0 } ],
  "byProject": [ { "projectId": "…", "name": "Portal", "tokens": {…}, "calls": 3, "runs": 1, "costUsd": 0.0225, "unpricedTokens": 0 } ],
  "daily":     [ { "date": "2026-11-13", "tokens": {…}, "calls": 3, "costUsd": 0.0225, "unpricedTokens": 0 } ] } }
```

### Layout

1. **KPI row** — total cost, total tokens, input vs output split, cache share (`cacheRead / total`). The cost KPI carries the coverage note when `cost.unpricedTokens > 0`.
2. **Cost per day** — bar chart from `daily`. A day with `costUsd: null` is drawn as a hatched/empty bar, **not** a zero bar. Provide a tokens/cost toggle.
3. **By model** — table sorted as returned (largest first): provider/model, tokens, calls, runs, cost, and a coverage badge when `unpricedTokens > 0`. A row with `provider: null, model: null` is **unattributed** usage (see below).
4. **By project** — table with project names (`name` may be `null` if the project was deleted: show the short id). Link to the project's stats.

Both tables must be sortable and handle the empty state ("No model usage recorded in this period").

`byProject` is capped at 200 rows by the server; if you receive 200, show "Showing the top 200 projects by tokens".

### Unattributed usage

Usage recorded before model attribution existed has `provider: null` and `model: null`. Label it **"Unattributed (recorded before model tracking)"**. Never guess a model for it and never hide it: it is part of the totals. Its cost is always `null`, and its tokens always count toward `unpricedTokens`.

---

## Project stats

`GET /api/projects/:id/stats` already powers the project stats view. It now also returns:

```json
{
  "cost":    { "usd": 0.0225, "pricedTokens": 4500, "unpricedTokens": 0 },
  "byModel": [ { "provider": "openai", "model": "gpt-4o", "tokens": {…}, "calls": 3, "runs": 1,
                 "pricedCalls": 3, "costUsd": 0.0225, "unpricedTokens": 0 } ],
  "byRole":  [ { "role": "author", "…": "…", "costUsd": 0.0075 } ],
  "byStage": [ { "stage": "planning", "…": "…", "costUsd": 0.0225 } ],
  "daily":   [ { "date": "…", "…": "…", "costUsd": 0.0225 } ],
  "recentRuns": [ { "id": "…", "costUsd": 0.0225, "models": [ { "provider": "openai", "model": "gpt-4o" } ] } ]
}
```

Add:

- a **cost KPI** beside the existing token KPIs (with the coverage note);
- a **Models** table (`byModel`);
- a **cost** column in the by-role, by-stage and recent-runs tables;
- in recent runs, the model name(s) as chips — a run normally has one model. **If a run shows more than one, that is a real change to investigate**, not a UI quirk; display them all.

`recentRuns[].models` and `byModel` are empty for a project with no usage — render the existing empty state.

### The run detail view

`role_start` events now carry `payload.model` (`{ provider, model, source }`, or `null` when the harness default was used). In the stage activity stream, show the model as a small chip on each role's header ("analyzer · openai/gpt-4o"). Usage `status` events also carry `payload.model` and `payload.costUsd`; if you show per-step usage, show the cost too (same `null` vs `0` rule).

---

## Cost coverage

A cost figure is only as complete as the prices behind it. The API gives you what you need to say so:

```
cost: { usd, pricedTokens, unpricedTokens }
```

- `usd: null` — nothing in scope was priced. Show "No price data".
- `usd: 0.0225, unpricedTokens: 0` — complete. Show the figure plainly.
- `usd: 0.0225, unpricedTokens: 8000` — **partial**. Show the figure with a visible marker ("≥ $0.0225" or an info icon) and a tooltip: "Excludes 8,000 tokens with no price (a model without a price, or usage recorded before cost tracking)."

Format money with enough precision for small amounts: up to 6 decimals below $0.01 (`$0.000096`), 2–4 decimals otherwise. Never round a non-zero cost to `$0.00`.

---

## States

| State | Behaviour |
|---|---|
| Loading | skeletons, not spinners over empty tables |
| `503 MODELS_NOT_CONFIGURED` | "Model management needs the database (`DATABASE_URL`)". Show the Usage tab only if `WORKSPACE_NOT_CONFIGURED` is not returned |
| `503 WORKSPACE_NOT_CONFIGURED` | usage and project stats unavailable: explain, don't retry in a loop |
| `401` / `403 ADMIN_FORBIDDEN` | "Admin access required" with the way to provide a token |
| Empty catalogue | prompt to run discovery |
| `unconfigured` target | neutral state, not an error |
| Network failure | inline retry button; keep the last good data visible and mark it stale |

---

## Security and privacy

- Never log or echo request bodies that could contain credentials (there are none by design — keep it that way).
- Test prompts are sent to the real provider. Add a one-line note under the test field: "This sends the prompt to the selected provider."
- When `AIFACTORY_MODEL_EGRESS=local-only` is active (any `EGRESS_BLOCKED` response), explain that cloud providers are disabled by policy.
- Do not cache admin responses in local storage.

---

## API client requirements

Add typed helpers (names are suggestions):

```ts
getModelTarget(): Promise<TargetView>
saveModelTarget(target: ModelTarget): Promise<TargetView>
resetModelTarget(): Promise<TargetView>
listProviders(): Promise<ProviderView[]>
listModels(provider?: string): Promise<ModelEntry[]>
discoverModels(provider: string): Promise<DiscoveryResult>
checkProvider(provider: string): Promise<ProviderHealth>
getModelRuntime(): Promise<ModelRuntimeStatus>          // GET /api/admin/models
resetBreaker(provider: string): Promise<{ provider: string; reset: boolean }>
setModelPrice(input: PriceInput): Promise<ModelEntry>
testModel(input?: TestInput): Promise<TestResult>
getFactoryUsage(range: { days?: number; from?: string; to?: string }): Promise<FactoryUsage>
```

Map every `error.code` to a typed error so screens can branch on it; never match on message text.

---

## Acceptance criteria

### Target
- [ ] The page shows the current target, its source and every warning.
- [ ] `unconfigured` is a normal state with a clear call to action.
- [ ] The form saves, resets to environment, and surfaces each validation code on the right field.
- [ ] The fallback list is ordered, capped at 4, de-duplicated and keyboard-operable.
- [ ] A test call shows the serving model, every attempt in order, tokens and cost, and handles `502/503/504/422` inline.
- [ ] There is no per-project or per-stage model control anywhere.

### Providers
- [ ] No screen has an input for an API key; only the variable name and a present/missing status.
- [ ] Health, discover and reset breaker work, with a confirmation on discover.
- [ ] Breaker state is shown (`closed`/`open`/`half_open`) with the retry time and last error.
- [ ] "Applied to agent runs" shows what the harness really uses, including `lastError`.
- [ ] Prices are editable per million tokens, "no price" ≠ 0, and local models have a Free shortcut.

### Usage and cost
- [ ] `null` cost renders as "no price"/"—", `0` as `$0.00`; they are never confused.
- [ ] Any cost with `unpricedTokens > 0` is marked partial and explains why.
- [ ] Unattributed usage is shown and labelled, never hidden or guessed.
- [ ] Factory usage has KPIs, a daily chart (null days not drawn as zero), and by-model and by-project tables.
- [ ] Project stats show cost, a models table and model chips on runs and roles.
- [ ] Money keeps enough precision that small non-zero costs are never shown as `$0.00`.
- [ ] Admin endpoints handle `401/403` with an actionable message.
