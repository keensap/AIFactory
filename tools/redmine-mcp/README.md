# Redmine MCP tooling

AI Factory work is tracked in a local Redmine instance. Agents reach it through the
[`mcp-server-redmine`](https://github.com/jesusr00/mcp-server-redmine) MCP server,
launched by the shim in [`redmine-mcp.mjs`](redmine-mcp.mjs) so its tool schemas pass
DeepSeek Harness (DSH) validation.

| Item | Value |
|---|---|
| Redmine URL | `http://localhost:8282` (local; plain HTTP) |
| Project | `AIFactory`, numeric id `1` (identifier expected to be `aifactory`; prefer the numeric id in tool calls) |
| Tracking issues | parent `#1`; children `#2`–`#10` = R1–R9 |
| DSH server name | `redmine` → tools appear as `mcp__redmine__redmine_*` |

## What the shim does and why

`mcp-server-redmine@0.8.1` validates upload `filename`/`file_path` arguments with the
zod regex `/^[^\0]+$/` (3 occurrences in `dist/index.mjs`). Its generated tool JSON
Schema carries that source verbatim:

| | JSON Schema `pattern` (as serialized JSON) |
|---|---|
| Before | `"^[^\\0]+$"` |
| After  | `"^[^\\u0000]+$"` |

The DSH provider rejected `"^[^\\0]+$"` as not a valid `"regex"` format. One bad schema
fails the whole model request, so tool discovery broke for every Redmine tool.

At startup the shim:

1. reads the package entry file (`REDMINE_MCP_ENTRY`, else the hard-coded `DEFAULT_ENTRY`);
2. replaces every literal `[^\0]` with `[^\u0000]` **in memory**. Both forms match "any
   character except NUL", so validation behaviour is unchanged. Only that one substring
   changes; the installed package on disk is never modified;
3. imports the patched source as a `data:` module in the same Node process. stdin/stdout
   (the MCP stdio channel), environment variables and all other code run exactly as
   upstream. This works because the bundle imports only `node:` built-ins.

If the substring is missing, the shim logs
`redmine-mcp shim: no [^\0] in <entry> — running unpatched (upstream may have fixed it)`
to stderr and runs the package unchanged.

**Removing the shim once upstream is fixed:** upgrade the package. Confirm the shim prints
the "running unpatched" warning, or that `grep -c '\[^\\0\]' "$(npm root -g)/mcp-server-redmine/dist/index.mjs"` returns `0`.
Then point the DSH entry's `command` at the package's `mcp-server-redmine` bin (or
`node <entry>`) and delete this directory.

## Prerequisites

- **Node.js**: tested with v24.21.0 (installed via fnm). The package declares no `engines`
  field. The shim needs ESM with top-level await and `data:` imports.
- **Package**: pinned global install, so nothing is fetched at launch (no `npx`):

  ```sh
  npm install --global mcp-server-redmine@0.8.1
  ls "$(npm root -g)/mcp-server-redmine/dist/index.mjs"
  ```

  The shim resolves the entry from the global npm root (`npm root -g`) plus
  `mcp-server-redmine/dist/index.mjs`, so no machine-specific path is baked in. If npm is not
  on `PATH` for the DSH host process, or the package lives elsewhere, set `REDMINE_MCP_ENTRY`
  to the path printed above.
- A Redmine user with an API key, with REST API enabled (*Administration → Settings → API*).

## Configuration (environment variable names only)

| Variable | Read by | Required | Meaning |
|---|---|---|---|
| `REDMINE_URL` | package | yes | Base URL, e.g. `http://localhost:8282`. HTTP triggers a cleartext warning on stderr |
| `REDMINE_API_KEY` | package | yes | Redmine API access key (*My account → API access key*) |
| `REDMINE_UPLOAD_DIR` | package | no | Absolute directory; restricts `redmine_upload_attachment` to files inside it (recommended) |
| `REDMINE_MCP_ENTRY` | shim | no | Override path to `mcp-server-redmine/dist/index.mjs` (default: resolved from `npm root -g`) |

If either required variable is missing, the server prints `Missing required environment variables` and exits.

**Never inline the key in DSH config.** The DSH stdio bridge scrubs credential-shaped
ambient variables before spawning the child, so pass the key explicitly in the entry's
`env` as a **named credential reference** `${credential:REDMINE_API_KEY}`. Save the value
through DSH Settings or the local credentials store (`dsh-credentials-local`). DSH resolves
the reference at spawn time and redacts it from diagnostics.

## Register with DSH (stdio)

Use **one** of the two options below. Placeholders are shown in `<angle brackets>`.

**Option A: MCP manager (Web/Desktop profiles; also editable in Settings → MCP).** Note
that a profile `cordis.patch.yml` replaces the manager's whole `servers` map. For partial
edits, use Settings.

```yaml
- id: mcp
  config:
    servers:
      redmine:
        transport: stdio
        command: </absolute/path/to/node>
        args: ['</absolute/path/to>/tools/redmine-mcp/redmine-mcp.mjs']
        env:
          REDMINE_URL: 'http://localhost:8282'
          REDMINE_API_KEY: '${credential:REDMINE_API_KEY}'
          REDMINE_UPLOAD_DIR: '</absolute/upload/dir>'        # optional
          # REDMINE_MCP_ENTRY: '</npm-root-g>/mcp-server-redmine/dist/index.mjs'
        enabled: true
```

**Option B: a plain `dsh-mcp-client` row** (pinned in a composition or patch layer):

```yaml
- insert:
    - id: mcp-redmine
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: redmine
        transport: stdio
        command: </absolute/path/to/node>
        args: ['</absolute/path/to>/tools/redmine-mcp/redmine-mcp.mjs']
        expandTemplates: true          # required for ${credential:...}
        env:
          REDMINE_URL: 'http://localhost:8282'
          REDMINE_API_KEY: '${credential:REDMINE_API_KEY}'
```

Use an absolute `node` path. fnm's per-shell `PATH` is not guaranteed in the DSH host
process.

## Quick verification

1. **Schema check without Redmine or a real key.** `tools/list` does not call Redmine, so
   a placeholder key is enough:

   ```sh
   (printf '%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
     '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 2) |
   REDMINE_URL=http://localhost:8282 REDMINE_API_KEY=placeholder-not-a-key \
     node tools/redmine-mcp/redmine-mcp.mjs | grep -o '\^\[\^\\\\[u0-9]*\]+\$' | sort | uniq -c
   ```

   Expect only `^[^\\u0000]+$`, and no `^[^\\0]+$`. 0.8.1 exposes 34 tools.
2. **In DSH:** after (re)loading, confirm the `mcp__redmine__*` tools are listed, or use the
   manager's *probe* in Settings. Then ask the agent to call:
   - `mcp__redmine__redmine_get_current_user`, which confirms auth;
   - `mcp__redmine__redmine_get_issue` with `id: 1`, which should return the parent tracking
     issue in project AIFactory;
   - optionally `mcp__redmine__redmine_list_issues` with `project_id: "1"`, which should show `#2`–`#10`.

## First-time Redmine setup gotchas

- **`redmine_create_issue` returned HTTP 422 on a fresh instance.** The cause was that
  Redmine's default data was not loaded, so no trackers, issue statuses or priorities
  existed. Load it once (*Administration* prompts on a fresh install, or run
  `bundle exec rake redmine:load_default_data RAILS_ENV=production` in the Redmine
  container/app).
- **Still 422 after that.** The trackers (Bug, Feature, Support) must be associated with
  the project: *Project → Settings → Issue tracking*, tick the trackers, save. Also make
  sure the user's role may add issues in the project.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Provider error: pattern `^[^\0]+$` is not a valid `regex`; Redmine tools missing or every request fails | DSH launches the package directly instead of the shim. Point `args` at `redmine-mcp.mjs`. If the shim logs "running unpatched" but the error persists, the upstream pattern changed: inspect `dist/index.mjs` and update `FROM`/`TO` |
| `package entry not found at ...` at start | The package is not in the global npm root this process sees, or `npm` is not on `PATH`. Install it globally or set `REDMINE_MCP_ENTRY` |
| `Missing required environment variables` | `REDMINE_URL`/`REDMINE_API_KEY` not passed in the entry `env`. The credential reference is unresolved (the instance shows `waiting-credentials`), or `expandTemplates` is off on a plain client row |
| HTTP 422 on create/update | Missing default data or trackers not enabled for the project (see above). Also check required fields such as tracker, status and subject |
| HTTP 401 | Key wrong, revoked or rotated, or REST API disabled. Update the stored credential; do not paste it into config |
| HTTP 403 | Authenticated but the role lacks permission in project AIFactory, or the call is admin-only (e.g. `redmine_list_users`) |
| Connection refused / 404 on every call | Wrong `REDMINE_URL`. Use the base URL `http://localhost:8282` with no `/projects/...` path or trailing API suffix. Confirm Redmine is running on that port |

## Security notes

- **Never** commit or write API keys, passwords, or Redmine's Rails `secret_key_base`
  into this repo, docs, issue text, DSH `cordis.patch.yml`/`cordis.yml` files, or logs.
  Use `${credential:REDMINE_API_KEY}` and the DSH credentials store.
- **Rotate immediately** (*My account → API access key → Reset*) any key that appeared in
  a chat transcript, tool output or log. Treat it as compromised, and update the stored
  credential afterwards.
- `redmine_get_my_account` returns the caller's API key in its result, so avoid
  calling it from agents. Treat its output as secret if you do.
- `http://localhost:8282` is cleartext. This is acceptable only for a loopback instance.
  Use HTTPS for anything remote.
- Set `REDMINE_UPLOAD_DIR` so the model cannot upload arbitrary local files as attachments.
