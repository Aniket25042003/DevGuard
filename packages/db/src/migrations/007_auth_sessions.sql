-- 007_auth_sessions.sql
-- CP003: durable OAuth login transactions and server-side sessions.
--
-- Session and transaction identifiers are SHA-256 HASHES of opaque tokens;
-- the raw session token and raw OAuth state are NEVER stored (C005 §8). The
-- PKCE verifier is single-use and TTL-bounded by the login window (10 min);
-- expired transactions may be purged by the CP008 cleanup job. Idle/absolute
-- session expiry is enforced at read time by AuthenticationService.

CREATE TABLE auth_transactions (
  state_hash text PRIMARY KEY,
  pkce_verifier text NOT NULL,
  return_to_path text NOT NULL DEFAULT '/',
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0)
);

-- Sessions reference a DevGuard user created by C009 identity linkage.
CREATE TABLE auth_sessions (
  session_id_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_issuer text NOT NULL,
  provider_subject text NOT NULL,
  provider_login text,
  provider_display_name text,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0)
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX idx_auth_transactions_expiry ON auth_transactions (expires_at);