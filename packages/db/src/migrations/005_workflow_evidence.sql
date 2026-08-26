-- 005_workflow_evidence.sql
-- C011: workflow runs, steps, sessions, turns, actions, decisions,
-- ordered events, artifacts, validations, findings, occurrences.

CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  workflow_type text NOT NULL,
  definition_version int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','waiting_for_approval','resuming','verifying',
      'completed','failed','cancelled','rejected','timed_out')),
  trigger_type text NOT NULL CHECK (trigger_type IN ('manual', 'webhook', 'api')),
  trigger_reference_json jsonb NOT NULL DEFAULT '{}',
  idempotency_key_hash text UNIQUE,
  policy_snapshot_id uuid REFERENCES workflow_policy_snapshots(id),
  branch_name text,
  pr_number int,
  cancel_requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failure_code text,
  failure_message text,
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1)
);
CREATE INDEX idx_runs_repo_status ON workflow_runs (repository_id, status) WHERE status NOT IN ('completed', 'failed', 'cancelled');
CREATE INDEX idx_runs_recoverable ON workflow_runs (status, updated_at)
  WHERE status IN ('running', 'waiting_for_approval', 'resuming', 'verifying');

CREATE TABLE workflow_steps (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  attempt int NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','succeeded','failed','skipped','cancelled')),
  input_hash text,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  output_summary_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (run_id, step_key, attempt)
);

CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'trueforge',
  provider_session_id text NOT NULL,
  status text NOT NULL DEFAULT 'connecting'
    CHECK (status IN ('connecting','active','paused','ended','lost')),
  last_event_cursor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (provider, provider_session_id),
  UNIQUE (id, run_id)
);
CREATE INDEX idx_sessions_run ON agent_sessions (run_id);

CREATE TABLE agent_turns (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  turn_index int NOT NULL CHECK (turn_index >= 0),
  request_hash text,
  provider_turn_ref text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (session_id, turn_index)
);

CREATE TABLE actions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES agent_sessions(id),
  step_id uuid REFERENCES workflow_steps(id),
  action_type text NOT NULL,
  risk_class text NOT NULL CHECK (risk_class IN ('read','reversible_write','sensitive_write','destructive','external_side_effect')),
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','authorized','executing','executed','failed','denied')),
  provider text NOT NULL DEFAULT 'github_adapter',
  provider_reference text,
  operation_key_hash text UNIQUE,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1)
);
CREATE INDEX idx_actions_run ON actions (run_id);
ALTER TABLE actions ADD CONSTRAINT fk_actions_session_run
  FOREIGN KEY (session_id, run_id) REFERENCES agent_sessions(id, run_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX idx_actions_pending ON actions (run_id, status) WHERE status = 'proposed';

CREATE TABLE policy_decisions (
  id uuid PRIMARY KEY,
  action_id uuid NOT NULL UNIQUE REFERENCES actions(id),
  policy_version_id uuid REFERENCES repository_policy_versions(id),
  effect text NOT NULL CHECK (effect IN ('ALLOW', 'REQUIRE_APPROVAL', 'DENY')),
  reason_code text NOT NULL,
  context_hash text NOT NULL,
  evidence_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflow_events (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  sequence_number bigint NOT NULL CHECK (sequence_number >= 0),
  event_type text NOT NULL,
  schema_version int NOT NULL DEFAULT 1,
  payload_json jsonb NOT NULL DEFAULT '{}',
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('public', 'internal', 'restricted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence_number)
);
CREATE INDEX idx_events_run_cursor ON workflow_events (run_id, sequence_number);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  action_id uuid REFERENCES actions(id),
  type text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_SCAN'
    CHECK (status IN ('COLLECTED','PENDING_SCAN','SCANNING','SAFE','QUARANTINED','EXPIRED','DELETED')),
  storage_object_id uuid,
  checksum_sha256 text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  classification text NOT NULL DEFAULT 'internal' CHECK (classification IN ('public','internal','restricted')),
  retention_expires_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1)
);
CREATE INDEX idx_artifacts_run ON artifacts (run_id);
CREATE INDEX idx_artifacts_expiry ON artifacts (retention_expires_at) WHERE status = 'SAFE';

CREATE TABLE validation_results (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id uuid REFERENCES workflow_steps(id),
  validator_id text NOT NULL,
  attempt int NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status text NOT NULL CHECK (status IN ('passed','failed','skipped','blocked')),
  duration_ms int,
  summary text,
  details_artifact_id uuid REFERENCES artifacts(id),
  evidence_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, validator_id, attempt)
);

CREATE TABLE security_findings (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  first_run_id uuid REFERENCES workflow_runs(id),
  last_run_id uuid REFERENCES workflow_runs(id),
  fingerprint text NOT NULL,
  severity text NOT NULL DEFAULT 'unknown' CHECK (severity IN ('unknown','low','medium','high','critical')),
  category text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','fixed','dismissed','suppressed')),
  title text NOT NULL,
  description_summary text,
  file_path text,
  line int,
  remediation_summary text,
  auto_fixable boolean NOT NULL DEFAULT false,
  fixed_by_run_id uuid REFERENCES workflow_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (repository_id, fingerprint)
);
CREATE INDEX idx_findings_repo ON security_findings (repository_id, status);

CREATE TABLE finding_occurrences (
  id uuid PRIMARY KEY,
  finding_id uuid NOT NULL REFERENCES security_findings(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES workflow_runs(id),
  scanner_id text NOT NULL,
  evidence_artifact_id uuid REFERENCES artifacts(id),
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (finding_id, run_id, scanner_id)
);
