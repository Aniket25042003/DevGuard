-- CP016 (C011): run provenance — which surface started each run.
ALTER TABLE workflow_runs
  ADD COLUMN origin_surface text NOT NULL DEFAULT 'web'
  CHECK (origin_surface IN ('web','cli','github_comment','github_event','schedule'));

CREATE INDEX IF NOT EXISTS idx_runs_origin
  ON workflow_runs (repository_id, origin_surface, created_at DESC);

-- Widen trigger_type to include schedule (CP016 §8 mapping).
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_trigger_type_check;
ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_trigger_type_check
  CHECK (trigger_type IN ('manual','webhook','api','schedule'));