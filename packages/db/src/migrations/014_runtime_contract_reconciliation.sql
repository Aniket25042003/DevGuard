-- BE-002/003/007/009/015 — forward-only runtime contract reconciliation.
-- Existing migrations remain immutable. This migration makes the persisted
-- schema match the canonical application contracts used by API and worker.

BEGIN;

ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_status_check;
ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_status_check CHECK (status IN (
    'queued','dispatch_pending','provisioning','running','waiting_for_approval',
    'resuming','verifying','completed','failed','cancelled','rejected',
    'timed_out','expired'
  ));

ALTER TABLE workflow_runs
  ALTER COLUMN definition_version TYPE text
  USING CASE
    WHEN definition_version IS NULL THEN '1.0.0'
    WHEN definition_version::text ~ '^[0-9]+$' THEN definition_version::text || '.0.0'
    ELSE definition_version::text
  END;
ALTER TABLE workflow_runs
  ALTER COLUMN definition_version SET DEFAULT '1.0.0';

ALTER TABLE workflow_steps DROP CONSTRAINT IF EXISTS workflow_steps_status_check;
ALTER TABLE workflow_steps
  ADD CONSTRAINT workflow_steps_status_check CHECK (status IN (
    'pending','running','waiting_for_approval','succeeded','failed',
    'skipped','cancelled','timed_out'
  ));

ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_storage_object_fk
  FOREIGN KEY (storage_object_id) REFERENCES storage_objects(id)
  NOT VALID;

-- Durable execution fencing and provider reconciliation metadata.
ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS execution_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancellation_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS projection_version bigint NOT NULL DEFAULT 0;
ALTER TABLE actions
  ADD COLUMN IF NOT EXISTS target_fingerprint text,
  ADD COLUMN IF NOT EXISTS canonical_operation_json jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS provider_request_id text;
ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS action_id uuid REFERENCES actions(id),
  ADD COLUMN IF NOT EXISTS policy_decision_id uuid REFERENCES policy_decisions(id),
  ADD COLUMN IF NOT EXISTS target_fingerprint text;
ALTER TABLE github_webhook_deliveries
  ADD COLUMN IF NOT EXISTS payload_object_key text,
  ADD COLUMN IF NOT EXISTS processing_error_code text;

CREATE TABLE IF NOT EXISTS sandbox_workspaces (
  id uuid PRIMARY KEY,
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'trueforge',
  provider_workspace_id text,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  head_sha text NOT NULL,
  generation bigint NOT NULL DEFAULT 0,
  lease_token text,
  lease_expires_at timestamptz,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','provisioning','ready','running','quarantined','destroying','destroyed','failed')),
  attestation_json jsonb,
  cleanup_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, generation)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_workspaces_recovery
  ON sandbox_workspaces (status, lease_expires_at, updated_at);

CREATE TABLE IF NOT EXISTS sandbox_commands (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES sandbox_workspaces(id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  action_id uuid REFERENCES actions(id),
  generation bigint NOT NULL,
  provider_command_id text,
  command_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'authorized'
    CHECK (status IN ('authorized','running','succeeded','failed','timed_out','cancelled','unknown')),
  started_at timestamptz,
  completed_at timestamptz,
  result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, generation, command_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_commands_recovery
  ON sandbox_commands (status, updated_at);

CREATE TABLE IF NOT EXISTS provider_mutation_receipts (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  operation_key text NOT NULL UNIQUE,
  target_fingerprint text NOT NULL,
  provider_request_id text,
  status text NOT NULL CHECK (status IN ('pending','succeeded','failed','unknown')),
  response_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_active
  ON workflow_runs (repository_id, updated_at)
  WHERE status NOT IN ('completed','failed','cancelled','rejected','timed_out','expired');
CREATE INDEX IF NOT EXISTS idx_approvals_pending_expiry
  ON approvals (status, expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_installation_links_visibility
  ON user_installation_links (user_id, installation_id, expires_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workflow_policy_snapshots_run_fk'
  ) THEN
    ALTER TABLE workflow_policy_snapshots
      ADD CONSTRAINT workflow_policy_snapshots_run_fk
      FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_runs_dispatchable
  ON workflow_runs (status, updated_at, id)
  WHERE status IN ('queued','dispatch_pending','provisioning','resuming','verifying');

COMMIT;
