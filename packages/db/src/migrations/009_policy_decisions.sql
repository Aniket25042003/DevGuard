-- CP009 (C030/C031): durable policy decisions, linked to a workflow run.
-- The policy DECISION is persisted BEFORE any GitHub/sandbox side effect; the
-- worker refuses to mutate an external system until a decision row exists.
CREATE TABLE IF NOT EXISTS policy_decisions (
  run_id            uuid PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  policy_version    text NOT NULL,
  effect            text NOT NULL CHECK (effect IN ('allow', 'deny', 'require_approval')),
  reason_code       text NOT NULL DEFAULT 'allow_standard',
  decision_json     jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_by        text NOT NULL DEFAULT 'policy_engine',
  decided_at        timestamptz NOT NULL DEFAULT now(),
  row_version       bigint NOT NULL DEFAULT 1
);