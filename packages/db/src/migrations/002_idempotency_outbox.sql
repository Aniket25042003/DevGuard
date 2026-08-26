-- 002_idempotency_outbox (C008 §8): idempotency records and transactional outbox.
-- Conventions: uuid PKs generated app-side, timestamptz UTC, row_version >= 1
-- optimistic concurrency, created_at/updated_at on every mutable table.

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY,
  scope text NOT NULL,
  key_hash text NOT NULL,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed_retriable')),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  owner_token uuid,
  lease_expires_at timestamptz,
  request_fingerprint text,
  response_json jsonb,
  response_code integer,
  resource_type text,
  resource_id text,
  error_code text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_scope_key_unique UNIQUE (scope, key_hash)
);

CREATE TRIGGER idempotency_records_touch_updated_at
BEFORE UPDATE ON idempotency_records
FOR EACH ROW EXECUTE FUNCTION devguard_touch_updated_at();

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  aggregate_type text,
  aggregate_id text,
  aggregate_version bigint,
  event_type text,
  schema_version integer,
  payload_json jsonb NOT NULL,
  correlation_json jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'publishing', 'published', 'dead_lettered')),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  published_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1)
);

CREATE INDEX outbox_events_status_available_idx ON outbox_events (status, available_at, id);

CREATE TRIGGER outbox_events_touch_updated_at
BEFORE UPDATE ON outbox_events
FOR EACH ROW EXECUTE FUNCTION devguard_touch_updated_at();
