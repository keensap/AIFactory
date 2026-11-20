# Named Agents

**Status:** implemented, including the [architecture remediation](ARCHITECTURE-REMEDIATION.md)

**Scope:** definitions, assignments and composition for the Planning and Requirements processes

---

## 1. What an agent is

A named agent is a **composition**: a persona, a tool allowlist, skills and a model. It is assigned to a **stage process** — Planning and Requirements both run `analyzer`, `author` and `reviewer`. Revision uses the author.

An agent may choose a **model**, never a **provider**:

```
global target: provider + model    ← the only place a provider is chosen
  └─ stage: none
       └─ agent: model only        ← must live on the Factory provider
```

The primary attempt declares the agent's model on the Factory provider's route, using that provider's credential. A configured Factory fallback can still use its own provider and model.

The agent cannot choose a separate provider or fallback chain. The run's bound model route supplies both the primary and fallback candidates, and each attempt uses the provider breaker. See [AR-03](ARCHITECTURE-REMEDIATION.md#ar-03).

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

Restricted agents fail closed if the harness profile contains an unclassified tool row (`AGENT_TOOLSET_UNVERIFIED`). An agent with skills and a nonempty allowlist must include `tool-skill` (`AGENT_SKILLS_NEED_SKILL_TOOL`).

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
  project_id UUID REFERENCES projects ON DELETE CASCADE, -- NULL for Factory default
  stage TEXT, process TEXT,
  agent_id UUID REFERENCES agent_definitions ON DELETE CASCADE
)
```

Partial unique indexes enforce one Factory assignment per stage/process and one per project/stage/process. Deleting an agent or project removes its assignments.

## 4. Resolution

For a stage process, the **project override** wins over the **Factory default**; with neither, the process runs with no agent (today's behaviour). A disabled agent is skipped rather than failing the run.

New runs snapshot the model target and selected agents at creation, including unassigned roles. Editing assignments or agent definitions does not change a bound run. An administrator can explicitly adopt current model and agent settings with `POST /api/stage-runs/:runId/rebind`. Legacy runs without bindings may resolve agents at role start.

`role_start` records the effective primary model and, when assigned, `agent` and `agentId`. Usage is attributed to the model that actually ran, including fallback attempts. Prompt bundles and process parameters are independent of named agents: agent patches provide persona, model, tools and skills; stage role specs provide the task and contract. `role_start` may also carry prompt/spec audit metadata; see [Stage Runtime](STAGE-RUNTIME.md).

## 5. Composition at run time

For each role the runtime:

1. uses the bound agent (if any) for the stage and role;
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

`POST /api/agents/:id/test` defaults to an offline structural probe. It boots the harness with a local stand-in endpoint, checks that a request reached it, and verifies the configured persona, model, tools and skills where applicable. `?mode=online` uses the real target and reports boot/config acceptance separately from model success. A config dump alone does not verify plugin activation.

## 8. Limits worth knowing

- Planning and Requirements declare role processes; stages without processes return `400 NO_PROCESSES`.
- Skills are stored in the definition and materialised as files for harness discovery.
- Persona is process-wide inside the harness. Running several roles in one process would break that assumption.

## 9. Tests

`test/agents.test.ts`: name/tool/skill validation, the patch contents (persona, model declared on the same route, disabled tools, skills dir), assignment precedence and clearing, disabled agents, a stage run where only the assigned author gets a patch while the other roles run unchanged, the shared materialiser, and the probe endpoint (payload and the 503 when unavailable).
