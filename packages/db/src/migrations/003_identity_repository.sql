-- 003_identity_repository.sql
-- C009: users, external identities, GitHub installations, connected repositories,
-- metadata snapshots, authorization evidence.

CREATE TABLE users (
  id uuid PRIMARY KEY,
  login text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE external_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  login_snapshot text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE INDEX idx_ext_identity_user ON external_identities (user_id);

CREATE TABLE github_installations (
  id uuid PRIMARY KEY,
  github_installation_id bigint NOT NULL UNIQUE,
  account_type text NOT NULL CHECK (account_type IN ('User', 'Organization')),
  account_id bigint NOT NULL,
  account_login text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  permissions_json jsonb NOT NULL DEFAULT '{}',
  repository_selection text NOT NULL DEFAULT 'selected',
  suspended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_installation_links (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'member')),
  verified_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (user_id, installation_id)
);

CREATE TABLE repositories (
  id uuid PRIMARY KEY,
  github_repository_id bigint NOT NULL UNIQUE,
  installation_id uuid NOT NULL REFERENCES github_installations(id),
  owner text NOT NULL,
  name text NOT NULL,
  full_name text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  archived boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'degraded', 'disconnected')),
  autonomy_level text NOT NULL DEFAULT 'assist' CHECK (autonomy_level IN ('assist', 'developer', 'trusted', 'autonomous')),
  connected_by uuid REFERENCES users(id),
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1)
);
CREATE INDEX idx_repositories_installation ON repositories (installation_id);
CREATE INDEX idx_repositories_status ON repositories (status) WHERE status != 'disconnected';

CREATE TABLE repository_metadata_snapshots (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  provider_updated_at timestamptz,
  etag text,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  schema_version int NOT NULL DEFAULT 1,
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_repo_snapshot_repo_captured ON repository_metadata_snapshots (repository_id, captured_at DESC);

CREATE TABLE repository_access_evidence (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id),
  user_id uuid NOT NULL REFERENCES users(id),
  capability text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow', 'deny')),
  source text NOT NULL CHECK (source IN ('local', 'github', 'cache')),
  snapshot_hash text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  request_id text
);
CREATE INDEX idx_access_evidence_subj_repo ON repository_access_evidence (user_id, repository_id, expires_at)
  WHERE decision = 'allow';
