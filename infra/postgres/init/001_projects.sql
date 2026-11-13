-- AI Factory project registry and chat settings.
-- Applied automatically only when the container initializes a fresh volume.
-- The API also runs the same idempotent migration on startup.

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  organization TEXT,
  owner_email TEXT,
  status TEXT NOT NULL DEFAULT 'inactive'
    CHECK (status IN ('active', 'inactive', 'archived', 'completed', 'on_hold')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_status_idx ON projects (status);
CREATE INDEX IF NOT EXISTS projects_organization_idx ON projects (organization);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value)
VALUES ('max_active_projects', '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS current_stage TEXT NOT NULL DEFAULT 'planning';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS stage_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS project_stages (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed', 'blocked', 'skipped')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  PRIMARY KEY (project_id, stage)
);

CREATE TABLE IF NOT EXISTS project_stage_runs (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'analyzing', 'drafting', 'reviewing', 'revising',
      'awaiting_human', 'completed', 'failed', 'cancelled'
    )),
  context_hash TEXT,
  context_json JSONB,
  input_text TEXT,
  analysis_markdown TEXT,
  draft_markdown TEXT,
  summary_markdown TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  locked_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  execution_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE project_stage_runs
  ADD COLUMN IF NOT EXISTS context_json JSONB;
ALTER TABLE project_stage_runs
  ADD COLUMN IF NOT EXISTS input_text TEXT;
ALTER TABLE project_stage_runs
  ADD COLUMN IF NOT EXISTS analysis_markdown TEXT;
ALTER TABLE project_stage_runs
  ADD COLUMN IF NOT EXISTS draft_markdown TEXT;
ALTER TABLE project_stage_runs
  ADD COLUMN IF NOT EXISTS locked_by TEXT;
ALTER TABLE project_stage_runs
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE project_stage_runs
  ADD COLUMN IF NOT EXISTS execution_attempts INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS project_documents (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'in_review', 'approved', 'rejected', 'superseded')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE project_documents
  ADD COLUMN IF NOT EXISTS stage_run_id UUID REFERENCES project_stage_runs(id) ON DELETE SET NULL;
ALTER TABLE project_documents
  ADD COLUMN IF NOT EXISTS parent_document_id UUID REFERENCES project_documents(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS project_checklist_items (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'done', 'waived')),
  evidence_document_id UUID REFERENCES project_documents(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (project_id, stage, key)
);

ALTER TABLE project_checklist_items
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS project_briefings (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  markdown TEXT NOT NULL,
  risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model TEXT
);

CREATE TABLE IF NOT EXISTS stage_reviews (
  id UUID PRIMARY KEY,
  stage_run_id UUID NOT NULL REFERENCES project_stage_runs(id) ON DELETE CASCADE,
  reviewer_role TEXT NOT NULL,
  decision TEXT NOT NULL
    CHECK (decision IN ('approved', 'needs_revision', 'rejected')),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stage_run_events (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage_run_id UUID NOT NULL REFERENCES project_stage_runs(id) ON DELETE CASCADE,
  role TEXT,
  agent_id TEXT,
  type TEXT NOT NULL,
  phase TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stage_document_requirements (
  stage TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cardinality TEXT NOT NULL DEFAULT 'one'
    CHECK (cardinality IN ('one', 'many')),
  required BOOLEAN NOT NULL DEFAULT true,
  template_markdown TEXT,
  PRIMARY KEY (stage, kind)
);

CREATE TABLE IF NOT EXISTS stage_role_configs (
  role TEXT PRIMARY KEY,
  agent_preset TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  reasoning_effort TEXT,
  max_tokens INTEGER,
  temperature NUMERIC,
  skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  system_prompt TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_role_overrides (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  config JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, role)
);

CREATE INDEX IF NOT EXISTS project_documents_project_idx ON project_documents (project_id, stage);
CREATE INDEX IF NOT EXISTS project_checklist_project_idx ON project_checklist_items (project_id, stage);
CREATE INDEX IF NOT EXISTS project_stage_runs_project_stage_idx ON project_stage_runs (project_id, stage, created_at DESC);
CREATE INDEX IF NOT EXISTS project_stage_runs_lease_idx ON project_stage_runs (lease_expires_at)
  WHERE status IN ('analyzing', 'drafting', 'reviewing', 'revising');
CREATE INDEX IF NOT EXISTS stage_reviews_run_idx ON stage_reviews (stage_run_id, created_at);
CREATE INDEX IF NOT EXISTS stage_run_events_run_idx ON stage_run_events (stage_run_id, id);

CREATE TABLE IF NOT EXISTS sdlc_stages (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO sdlc_stages (key, name, position) VALUES
  ('planning', 'Planning & Feasibility', 0),
  ('requirements', 'Requirements', 1),
  ('design', 'Design', 2),
  ('architecture', 'Architecture', 3),
  ('development', 'Development', 4),
  ('testing', 'Testing', 5),
  ('deployment', 'Deployment', 6),
  ('maintenance', 'Maintenance', 7)
ON CONFLICT (key) DO NOTHING;

UPDATE sdlc_stages
SET name = 'Planning & Feasibility', updated_at = now()
WHERE key = 'planning' AND name = 'Planning';

INSERT INTO stage_document_requirements
  (stage, kind, label, description, cardinality, required, template_markdown)
VALUES (
  'planning',
  'telos_report',
  'TELOS feasibility report',
  'A single feasibility report covering Technical, Economic, Legal, Operational and Schedule feasibility.',
  'one',
  true,
  NULL
)
ON CONFLICT (stage, kind) DO NOTHING;

