-- 008_api_tokens.sql
-- CP004: CLI/API bearer tokens for non-browser authentication.
--
-- Only the SHA-256 HASH of a token is ever stored (domain-separated prefix).
-- The raw `dgv1_` plaintext is returned to the caller exactly once at
-- issuance and can never be recovered from the database (C005 "tokens hashed").
-- Expiry is enforced at authenticate time; revoked/expired rows are kept for
-- audit and may be purged by a later cleanup job. The GitHub App installation
-- is never a principal (C005), so nothing here links to installations.

CREATE TABLE api_tokens (
  token_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0)
);
CREATE INDEX idx_api_tokens_user ON api_tokens (user_id, created_at DESC);