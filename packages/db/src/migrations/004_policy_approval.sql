-- 004_policy_approval.sql
-- C010: immutable policy versions, head pointer, workflow snapshots,
-- approval aggregate, transition evidence.

CREATE TABLE repository_policy_versions (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  version int NOT NULL CHECK (version >= 1),
  schema_version int NOT NULL DEFAULT 1,
  policy_json jsonb NOT NULL,
  canonical_hash text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, version)
);
CREATE INDEX idx_policy_version_repo ON repository_policy_versions (repository_id);

CREATE TABLE repository_policy_heads (
  repository_id uuid PRIMARY KEY REFERENCES repositories(id),
  active_policy_version_id uuid NOT NULL REFERENCES repository_policy_versions(id),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1)
);

CREATE TABLE workflow_policy_snapshots (
  id uuid PRIMARY KEY,
  workflow_run_id uuid NOT NULL UNIQUE,
  policy_version_id uuid NOT NULL REFERENCES repository_policy_versions(id),
  canonical_hash text NOT NULL,
  snapshot_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_snapshot_run ON workflow_policy_snapshots (workflow_run_id);

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  workflow_run_id uuid,
  action_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'stale', 'executing', 'executed', 'failed')),
  risk_class text NOT NULL CHECK (risk_class IN ('read', 'reversible_write', 'sensitive_write', 'destructive', 'external_side_effect')),
  reason_code text NOT NULL,
  reason_summary text NOT NULL DEFAULT '',
  proposed_operation_json jsonb NOT NULL DEFAULT '{}',
  operation_hash text NOT NULL,
  fingerprint_hash text NOT NULL,
  checkpoint_ref_json jsonb,
  expires_at timestamptz NOT NULL,
  stale_reason_code text,
  resolved_by text,
  resolution_comment text,
  resolved_at timestamptz,
  execution_status text CHECK (execution_status IN ('executing', 'executed', 'failed')),
  executed_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1)
);
CREATE INDEX idx_approvals_pending ON approvals (repository_id, status, expires_at) WHERE status = 'pending';
CREATE INDEX idx_approvals_workflow ON approvals (workflow_run_id);
CREATE INDEX idx_approvals_expiry ON approvals (expires_at) WHERE status = 'pending';

CREATE TABLE approval_transitions (
  id uuid PRIMARY KEY,
  approval_id uuid NOT NULL REFERENCES approvals(id),
  from_status text NOT NULL,
  to_status text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_id text NOT NULL,
  reason_code text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  command_key text NOT NULL,
  UNIQUE (approval_id, command_key)
);
CREATE INDEX idx_approval_transitions ON approval_transitions (approval_id, occurred_at DESC);
