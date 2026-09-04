-- Durable approval resume coordination.
-- Existing migrations remain immutable; this table records the resume state
-- for every approval resolution so retries and worker restarts converge.

BEGIN;

CREATE TABLE IF NOT EXISTS approval_resume_states (
  approval_id uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  resolution_version bigint NOT NULL CHECK (resolution_version > 0),
  state text NOT NULL CHECK (state IN (
    'QUEUED','CLAIMED','REVALIDATING','SYNCING_CHECKPOINT','EXECUTING',
    'VERIFYING','COMPLETED','RETRY_WAIT','STALE_NOOP','CANCELLED_FENCED',
    'DEAD_LETTERED','EXPIRED'
  )),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (approval_id, resolution_version)
);

CREATE INDEX IF NOT EXISTS idx_approval_resume_pending
  ON approval_resume_states (state, updated_at)
  WHERE state IN ('QUEUED','CLAIMED','RETRY_WAIT');

COMMIT;
