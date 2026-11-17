# Named Agents

**Status:** implemented 2026-11-17  
**Scope:** definitions, assignments and composition for the planning stage's three processes

---

## 1. What an agent is

A named agent is a **composition**: a persona, a tool allowlist, skills and a model. It is assigned to a **stage process** — `planning` runs `analyzer`, `author` and `reviewer`.

An agent may choose a **model**, never a **provider**:

```
global target: provider + model    ← the only place a provider is chosen
  └─ stage: none
       └─ agent: model only        ← must live on the Factory provider
```

One provider means one credential, one breaker and one fallback path stay in force. The harness patch declares the agent's model on the Factory's own route, so no second provider can be reached.

## 2. Why not harness presets

The harness has `dsh-agent-preset`, and it looks like the natural fit. A prototype proved it is not usable on our path:

- a patch declaring `agent-preset-registry` and a preset is accepted by `--dump-config`;
- a real turn against a fake OpenAI server ran with `agentPreset: null` in the session log, the deployment persona instead of the preset's, and a preset containing a **nonexistent child plugin** booted fine — the preset was never bound.

Presets bind from the session **header**, which `dsh --profile headless` never sets; only hosts like the web app and the webhook session do. What *does* work, verified the same way, is the profile patch, because we already launch **one harness process per role**:

| Agent property | Patch row | Verified |
|---|---|---|
| Persona / rules | `system-prompt.personaPrefix` | marker appeared in the captured system prompt |
| Model | `agent-default-model` + the model on the Factory route | request used `author-model` vs `reviewer-model` on one provider |
| Tools | `{ id: tool-…, disabled: true }` for every tool not allowed | `bash` and `web` disappeared from the tool list |
| Skills | `skill-filesystem.customSkillDirs` with `includeDefaultRoots: false` | a `SKILL.md` bundle was discovered |

So the patch **is** the per-agent composition, and no preset is involved.

## 3. Data

```sql
agent_definitions (
  id UUID, name TEXT UNIQUE,            -- kebab-case
  description TEXT, enabled BOOLEAN,
  persona TEXT,                          -- replaces the deployment persona for that process
  model TEXT NULL,                       -- inside the Factory provider only
  reasoning_effort TEXT NULL,
  tools JSONB,                           -- allowlist of harness tool rows; [] = no restriction
  skills JSONB,                          -- [{ name, description, instructions }]
  created_at, updated_at
)

agent_assignments (
  scope_key TEXT,                        -- 'factory' or a project id (no NULL key semantics)
  stage TEXT, process TEXT,
  agent_id UUID REFERENCES agent_definitions ON DELETE CASCADE,
  PRIMARY KEY (scope_key, stage, process)
)
```

`scope_key` avoids `NULL`-in-primary-key problems and keeps the factory default and project overrides in one table. Deleting an agent removes its assignments.

## 4. Resolution

For a stage process, the **project override** wins over the **Factory default**; with neither, the process runs with no agent (today's behaviour). A disabled agent is skipped rather than failing the run.

A run snapshots nothing about agents: each role resolves its agent when it starts, and `role_start` records `agent`, `agentId` and the effective `model`, so the event log explains what ran.

## 5. Composition at run time

For each role the runtime:

1. resolves the agent (if any) for `planning/<role>`;
2. materialises skills as `<project>/.aifactory/agents/<agentId>/skills/<skill>/SKILL.md`;
3. writes a patch with persona, `skill-filesystem` roots, disabled tools and the agent's model;
4. launches the role with `pin.harness(cwd, timeout, agentPatch)` — the agent patch is applied **after** the model patch, so its model wins;
5. deletes the patch file in a `finally`; skill files stay for inspection.

An agent with no persona, no model and no tool restrictions produces an empty patch: the role runs exactly as before.

## 6. API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/agents` | List definitions |
| `POST` | `/api/agents` | Create (admin) |
| `GET` | `/api/agents/:id` | One definition (id or name) |
| `PATCH` | `/api/agents/:id` | Update (admin) |
| `DELETE` | `/api/agents/:id` | Delete (admin) |
| `GET` | `/api/stages/:stage/assignments?projectId=` | Resolved assignments |
| `PUT` | `/api/stages/:stage/assignments/:process` | Assign `{ agentId, projectId? }` (admin) |
| `DELETE` | `/api/stages/:stage/assignments/:process` | Clear (admin) |
| `POST` | `/api/agents/:id/test` | Boot the composition and report (admin) |

Assignments carry `source`: `project`, `factory` or `none`.

## 7. Testing a composition

`POST /api/agents/:id/test` runs the real materialiser and starts a harness with the agent patch and a one-word prompt. It separates two questions that are easy to conflate:

- **Was the composition accepted?** (`configAccepted`) — deterministic, and the only thing a config dump can honestly claim. A bad plugin row or patch shape fails here.
- **Did the model answer?** (`model`) — needs credentials, so a `MODEL_CALL_FAILED` or `MODEL_NOT_CONFIGURED` is reported without failing the first answer.

A config-file validation is not enough: `dsh --dump-config` does not activate plugins, and the prototype showed a preset with a nonexistent child passing it. Only a boot proves the composition loads.

## 8. Limits worth knowing

- Only `planning` declares processes; other stages return `400 NO_PROCESSES`.
- Editing an agent affects **new** role runs, not one in flight.
- Skills are files on disk by design (the harness discovers them); the database holds the definition and the run materialises it.
- The persona is process-wide inside the harness, which is correct for one-role-per-process. Running several roles in one process would break that assumption — do not "optimise" the runner without revisiting it.

## 9. Tests

`test/agents.test.ts`: name/tool/skill validation, the patch contents (persona, model declared on the same route, disabled tools, skills dir), assignment precedence and clearing, disabled agents, a stage run where only the assigned author gets a patch while the other roles run unchanged, the shared materialiser, and the probe endpoint (payload and the 503 when unavailable).
