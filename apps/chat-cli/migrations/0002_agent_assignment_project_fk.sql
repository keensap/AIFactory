-- AR-09: agent assignments must belong to a project that exists.
--
-- `scope_key` was free text holding either 'factory' or a project id, with no
-- foreign key, so deleting a project left its overrides behind and a mistyped
-- project id was accepted. Replace it with a nullable `project_id`:
--
--   project_id IS NULL       -> the Factory default for that stage/process
--   project_id IS NOT NULL   -> that project's override, cascading on delete
--
-- Two partial unique indexes keep one row per scope without NULL semantics.
-- Idempotent: it also runs against a database that has only the baseline shape.

ALTER TABLE agent_assignments ADD COLUMN IF NOT EXISTS project_id UUID;

-- Rows whose scope is not a live project are unreachable today; drop them rather
-- than fail the foreign key. Anything that does not look like a UUID is not a
-- project id and is dropped too.
DELETE FROM agent_assignments
WHERE project_id IS NULL
  AND scope_key <> 'factory'
  AND (
    scope_key !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = scope_key::uuid)
  );

-- Move the surviving project-scoped rows onto the new column.
UPDATE agent_assignments
SET project_id = scope_key::uuid
WHERE scope_key <> 'factory' AND project_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'agent_assignments_project_fk' AND t.relname = 'agent_assignments' AND n.nspname = 'public'
  ) THEN
    ALTER TABLE agent_assignments
      ADD CONSTRAINT agent_assignments_project_fk
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Drop the (scope_key, stage, process) primary key: the two partial unique
-- indexes below replace it, and scope_key must allow null now that the project
-- id is the scope for project rows.
ALTER TABLE agent_assignments DROP CONSTRAINT IF EXISTS agent_assignments_pkey;
ALTER TABLE agent_assignments ALTER COLUMN scope_key DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agent_assignments_factory_idx
  ON agent_assignments (stage, process) WHERE project_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_assignments_project_idx
  ON agent_assignments (project_id, stage, process) WHERE project_id IS NOT NULL;
