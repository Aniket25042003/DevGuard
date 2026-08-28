-- CP012 (C012): artifact metadata ledger (object bytes live in the ObjectStore).
CREATE TABLE IF NOT EXISTS artifacts (
  id           uuid PRIMARY KEY,
  run_id       uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  filename     text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes   bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sha256       char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key   uuid NOT NULL,
  scan_state   text NOT NULL DEFAULT 'SAFE' CHECK (scan_state IN ('SAFE','QUARANTINED','REJECTED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);