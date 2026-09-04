-- Durable agent execution contract.
-- Existing migrations are immutable; this migration expands the C011 tables
-- so the provider-neutral agent session/turn domain can be persisted safely.

BEGIN;

ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_status_check;
UPDATE agent_sessions
SET status = CASE status
  WHEN 'connecting' THEN 'CREATING'
  WHEN 'active' THEN 'TURN_ACTIVE'
  WHEN 'paused' THEN 'READY'
  WHEN 'ended' THEN 'COMPLETED'
  WHEN 'lost' THEN 'RECONCILING'
  ELSE status
END;
ALTER TABLE agent_sessions
  ALTER COLUMN provider_session_id DROP NOT NULL,
  ALTER COLUMN status SET DEFAULT 'CREATING';
ALTER TABLE agent_sessions
  ADD CONSTRAINT agent_sessions_status_check CHECK (status IN (
    'CREATING','READY','TURN_ACTIVE','CANCELLING','CANCELLED',
    'COMPLETED','FAILED','RECONCILING'
  ));
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS command_key text,
  ADD COLUMN IF NOT EXISTS agent_definition_id text,
  ADD COLUMN IF NOT EXISTS agent_version text,
  ADD COLUMN IF NOT EXISTS contract_snapshot_digest char(64),
  ADD COLUMN IF NOT EXISTS provider_thread_id text,
  ADD COLUMN IF NOT EXISTS current_turn_id uuid,
  ADD COLUMN IF NOT EXISTS cancellation_generation bigint NOT NULL DEFAULT 0;
UPDATE agent_sessions
SET command_key = COALESCE(command_key, 'legacy:session:' || id::text),
    agent_definition_id = COALESCE(agent_definition_id, 'legacy'),
    agent_version = COALESCE(agent_version, 'legacy'),
    contract_snapshot_digest = COALESCE(contract_snapshot_digest, repeat('0', 64));
ALTER TABLE agent_sessions
  ALTER COLUMN command_key SET NOT NULL,
  ALTER COLUMN agent_definition_id SET NOT NULL,
  ALTER COLUMN agent_version SET NOT NULL,
  ALTER COLUMN contract_snapshot_digest SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_command_key
  ON agent_sessions(command_key);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_recovery
  ON agent_sessions(status, updated_at)
  WHERE status IN ('CREATING','TURN_ACTIVE','CANCELLING','RECONCILING');

ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_status_check;
UPDATE agent_turns
SET status = CASE status
  WHEN 'pending' THEN 'REQUESTED'
  WHEN 'running' THEN 'RUNNING'
  WHEN 'completed' THEN 'SUCCEEDED'
  WHEN 'failed' THEN 'FAILED'
  ELSE status
END;
ALTER TABLE agent_turns
  ALTER COLUMN status SET DEFAULT 'REQUESTED';
ALTER TABLE agent_turns
  ADD CONSTRAINT agent_turns_status_check CHECK (status IN (
    'REQUESTED','SUBMITTING','RUNNING','PAUSED','SUCCEEDED',
    'FAILED','CANCELLED','RECONCILING'
  ));
ALTER TABLE agent_turns
  ADD COLUMN IF NOT EXISTS command_key text,
  ADD COLUMN IF NOT EXISTS purpose text,
  ADD COLUMN IF NOT EXISTS input_digest char(64),
  ADD COLUMN IF NOT EXISTS tool_profile_id text,
  ADD COLUMN IF NOT EXISTS provider_terminal_reason text,
  ADD COLUMN IF NOT EXISTS final_response_digest text,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1;
UPDATE agent_turns
SET command_key = COALESCE(command_key, 'legacy:turn:' || id::text),
    purpose = COALESCE(purpose, 'WORKFLOW'),
    input_digest = COALESCE(input_digest, request_hash, repeat('0', 64)),
    tool_profile_id = COALESCE(tool_profile_id, 'legacy'),
    started_at = COALESCE(started_at, created_at);
ALTER TABLE agent_turns
  ALTER COLUMN command_key SET NOT NULL,
  ALTER COLUMN purpose SET NOT NULL,
  ALTER COLUMN input_digest SET NOT NULL,
  ALTER COLUMN tool_profile_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turns_command_key
  ON agent_turns(command_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turns_one_active
  ON agent_turns(session_id)
  WHERE status IN ('REQUESTED','SUBMITTING','RUNNING','PAUSED','RECONCILING');
CREATE INDEX IF NOT EXISTS idx_agent_turns_recovery
  ON agent_turns(status, created_at)
  WHERE status IN ('REQUESTED','SUBMITTING','RUNNING','PAUSED','RECONCILING');

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS execution_lease_owner text,
  ADD COLUMN IF NOT EXISTS execution_lease_token text,
  ADD COLUMN IF NOT EXISTS execution_lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE workflow_steps
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancellation_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_workflow_steps_recovery
  ON workflow_steps(status, lease_expires_at, available_at);

CREATE TABLE IF NOT EXISTS workflow_definition_snapshots (
  id uuid PRIMARY KEY,
  workflow_run_id uuid NOT NULL UNIQUE REFERENCES workflow_runs(id) ON DELETE CASCADE,
  definition_id text NOT NULL,
  semantic_version text NOT NULL,
  normalized_json jsonb NOT NULL,
  digest char(64) NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approval_resolution_commands (
  approval_id uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  command_key text NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('approved','rejected')),
  resolution_version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (approval_id, command_key)
);

COMMIT;
