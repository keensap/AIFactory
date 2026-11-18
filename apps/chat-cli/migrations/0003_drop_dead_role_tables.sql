-- AR-16: drop the tables reserved for the superseded role-config design.
--
-- `stage_role_configs` and `project_role_overrides` were reserved before agents
-- were built; `agent_definitions` and `agent_assignments` replaced them and
-- nothing reads these. They are dropped only when empty: a non-empty table means
-- something unexpected wrote to it, and losing that data silently would be worse
-- than failing the migration.

DO $$
BEGIN
  IF to_regclass('public.stage_role_configs') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM stage_role_configs) THEN
      RAISE EXCEPTION 'stage_role_configs is not empty; refusing to drop it. Migrate its rows to agent_definitions first.';
    END IF;
    DROP TABLE stage_role_configs;
  END IF;

  IF to_regclass('public.project_role_overrides') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM project_role_overrides) THEN
      RAISE EXCEPTION 'project_role_overrides is not empty; refusing to drop it. Migrate its rows to agent_assignments first.';
    END IF;
    DROP TABLE project_role_overrides;
  END IF;
END $$;
