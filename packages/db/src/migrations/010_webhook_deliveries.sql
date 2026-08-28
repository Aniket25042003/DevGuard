-- CP011 (C022 §8): durable GitHub webhook delivery ledger.
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_delivery_id text NOT NULL UNIQUE,
  github_event      text NOT NULL,
  repository_id     uuid,
  payload_ref       text DEFAULT '',            -- object-reference / truncated body
  raw_payload_hash  char(64) NOT NULL,          -- sha256 of the raw body (never store body)
  state             text NOT NULL DEFAULT 'ACCEPTED',
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  retry_count       integer NOT NULL DEFAULT 0,
  unique_key        text NOT NULL DEFAULT '',
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_state ON github_webhook_deliveries(state);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_repo ON github_webhook_deliveries(repository_id);