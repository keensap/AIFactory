# AI Factory infrastructure

## PostgreSQL

The local environment already runs PostgreSQL 18 in the Docker container
`postgres-vector`, published on **port 5432**. AI Factory uses a separate
database in that container:

| Setting | Value |
|---|---|
| Host | `127.0.0.1` |
| Port | `5432` |
| Database | `aifactory` |
| Role | `aifactory` |
| Test database | `aifactory_test` |

The role password is local-development only. Set the real connection string in
`apps/chat-cli/.env` (gitignored) and never commit it:

```dotenv
DATABASE_URL=postgres://aifactory:<password>@127.0.0.1:5432/aifactory
```

### First-time setup

If the role or database does not exist:

```sh
docker exec postgres-vector psql -U postgres \
  -c "CREATE ROLE aifactory LOGIN PASSWORD '<password>';"
docker exec postgres-vector createdb -U postgres -O aifactory aifactory
docker exec postgres-vector createdb -U postgres -O aifactory aifactory_test
```

### Schema

The API runs an idempotent migration on startup (`PostgresProjectStore.migrate`).
The same DDL is in [`postgres/init/001_projects.sql`](postgres/init/001_projects.sql)
for fresh containers.

Current tables:

| Table | Purpose |
|---|---|
| `projects` | Project registry: name, root path, optional organization/owner, status, timestamps |
| `settings` | Chat-level settings; `max_active_projects` defaults to 3 |
| `project_stages` | Per-project SDLC stage state |
| `project_stage_runs` | Durable stage executions, sessions, summaries, worker lease and execution attempts |
| `stage_reviews` | Analyzer/author/reviewer decisions and findings |
| `stage_run_events` | Ordered role/status/thinking/tool events with replayable ids |
| `project_chunks` | pgvector chunks for project-scoped document retrieval |
| `stage_document_requirements` | Required documents per stage, cardinality and template |
| `stage_role_configs` | Global role presets/model/skills defaults |
| `project_role_overrides` | Per-project role overrides |
| `project_documents` | Uploaded documents, checksums, status, versions and relative paths |
| `project_checklist_items` | Required/optional stage checklist items; `active` preserves historical definitions |
| `project_briefings` | Cached AI briefings keyed by input hash |
| `sdlc_stages` | Default stage keys, display names and order (reference data; no FK from projects) |

Semantic retrieval requires the `vector` extension. On this PostgreSQL image the extension is available but must be created once by a superuser:

```sh
docker exec postgres-vector psql -U postgres -d aifactory -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

The API creates `project_chunks` and its HNSW index when embeddings are configured; if the extension cannot be created, retrieval stays disabled with a warning.

Planning & Feasibility is seeded with one `telos_report` document slot (`cardinality = one`). Its four checklist items cover the business idea, stakeholder goals, the report and the go/conditional-go/no-go decision.

Constraints worth knowing:

- `root_path` is **unique** — two projects cannot manage the same directory.
- `status` is one of `active`, `inactive`, `archived`, `completed`, `on_hold`.
- At most `settings.max_active_projects` (default 3) projects may be `active` at once. The limit is enforced transactionally with a PostgreSQL advisory lock.
- `remove_project` deletes the row only. It never deletes the user's directory.

### Verify

```sh
docker exec postgres-vector psql -U aifactory -d aifactory -c '\d projects'
docker exec postgres-vector psql -U aifactory -d aifactory -c 'select id, name, status from projects;'
```

### Using a different container

If you replace the container, keep the same database name and port, or update
`DATABASE_URL`. For a fresh container, mount `postgres/init` into
`/docker-entrypoint-initdb.d/` and create the role/database via the container's
`POSTGRES_USER` / `POSTGRES_DB` settings.
