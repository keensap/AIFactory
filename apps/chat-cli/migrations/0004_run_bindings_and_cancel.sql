-- Phase 3: per-run bindings and cancellation.
--
-- `bindings` freezes what a run uses at start - the model target and the agent
-- composition of each process - so a paused run resumed a day later is reviewed
-- by the same model it was drafted with, and an explicit rebind is the only way
-- that changes (AR-06).
--
-- `cancel_requested_at` is a request rather than a status: a leased run cannot be
-- switched off from outside, so the owner aborts at its next heartbeat and ends
-- the run as `cancelled` (AR-11).

ALTER TABLE project_stage_runs ADD COLUMN IF NOT EXISTS bindings JSONB;

ALTER TABLE project_stage_runs ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;

-- Why a stop was requested, for the audit trail.
ALTER TABLE project_stage_runs ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- Listing runs that are waiting for a human, or that have asked to stop.
CREATE INDEX IF NOT EXISTS project_stage_runs_status_idx ON project_stage_runs (status);
