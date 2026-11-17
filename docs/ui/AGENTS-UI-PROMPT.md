# UI Prompt — Agents

You are building the Agents section of the AI Factory UI. Read `docs/design/AGENTS.md` first; it explains why an agent is a *composition* and not a harness preset.

## Screens

### 1. Agents list (`/settings/agents`)

- Table: name, model (or "Factory default"), tools count, skills count, enabled, updated.
- Rows link to the editor. **Create agent** button.
- Empty state: "No agents yet. Planning runs use the stage defaults until you assign one."
- Disabled agents are dimmed with a "Disabled" chip.

### 2. Agent editor

Fields map 1:1 to `POST/PATCH /api/agents`:

| Field | Control | Notes |
|---|---|---|
| `name` | text | kebab-case; validate client-side with `^[a-z0-9]+(-[a-z0-9]+)*$`; `409 AGENT_NAME_TAKEN` shows on the field |
| `description` | textarea | optional |
| `persona` | textarea (monospace) | max 8000 chars; explain: "replaces the default persona for this process only" |
| `model` | select | **models of the Factory provider only**; include a "Factory default" option (`null`). Never offer another provider — an agent cannot switch provider |
| `reasoningEffort` | select | optional; hide when the model has no reasoning efforts |
| `tools` | multi-select | harness tool ids: `tool-bash`, `tool-fs`, `tool-fs-search`, `tool-web`, `tool-todo`, `tool-skill`, `tool-subagent`, `tool-workflow`, `tool-goal`, `tool-jobs`, `tool-agent-team`, `tool-subagent-control`, `tool-pwsh`, `tool-plugin-manager`, `tool-working-directory`. **Empty = all tools** — say so explicitly ("no restriction") |
| `skills` | repeatable list | name (kebab), description, instructions (markdown). Show a note: "written as `SKILL.md` under the project when a run starts" |
| `enabled` | switch | disabled agents are skipped by runs |

Show the model picker as: `Factory default (deepseek-chat)` / `deepseek-reasoner` / … — the list comes from the current Factory target's provider, so a provider change invalidates it.

### 3. Assignments (per stage)

On the stage view (start with Planning):

```
Planning
  Analyzer   (no agent)        [Choose]
  Author     feasibility-author  [Change] [Clear]
  Reviewer   feasibility-reviewer [Change] [Clear]
```

- `GET /api/stages/planning/assignments` (add `?projectId=` for project view).
- `source` chip: `project` (this project), `factory` (Factory default), `none`.
- **Scope toggle**: "Factory default" vs "This project". Factory edits require admin; project overrides too.
- Clearing a project override should say it "falls back to the Factory default", not "removes the agent".
- `400 NO_PROCESSES` means the stage has no runtime yet: hide the panel rather than showing an error.

### 4. Test an agent

A **Test this agent** button in the editor calls `POST /api/agents/:id/test` and shows two results, not one:

- *Composition accepted* — from `configAccepted`; if false, show `model.message` (a plugin/config problem).
- *Model reply* — from `model`: the `reply` text on success, or `MODEL_CALL_FAILED` / `MODEL_NOT_CONFIGURED` with the provider message.

Never collapse these into one "passed/failed": a missing API key is not a broken agent. Show the `config` summary (persona on/off, model, tool count, skills) beside the result.

## Rules

- Admin-only for every write (`POST/PATCH/DELETE /api/agents`, `PUT/DELETE …/assignments/…`). Non-admins see a read-only view.
- Show the effective model per assignment when it differs from the Factory target.
- Do not let a user type a model that is not on the Factory provider; if the API returns `400 INVALID_AGENT*`, surface the message on the field.
- After saving, a run picks the change up on its **next role start**; an in-flight run keeps its agent. Say so in a hint, not a modal.
