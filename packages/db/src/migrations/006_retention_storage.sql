-- 006_retention_storage.sql
-- C012: storage objects, retention policies, holds, storage operations.

CREATE TABLE storage_objects (
  id uuid PRIMARY KEY,
  provider text NOT NULL DEFAULT 'local',
  bucket_class text NOT NULL DEFAULT 'default',
  object_key_hash text NOT NULL,
  object_version text,
  upload_status text NOT NULL DEFAULT 'staging'
    CHECK (upload_status IN ('staging','available','quarantined','deleting','deleted','delete_failed')),
  checksum_sha256 text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  classification text NOT NULL DEFAULT 'internal' CHECK (classification IN ('public','internal','restricted')),
  encryption_key_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  deleted_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (provider, object_key_hash)
);
CREATE INDEX idx_objects_status ON storage_objects (upload_status);

CREATE TABLE retention_policies (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('global','repository','workflow')),
  scope_id text NOT NULL DEFAULT '*',
  artifact_type text NOT NULL DEFAULT '*',
  classification text NOT NULL DEFAULT '*' CHECK (classification IN ('*','public','internal','restricted')),
  ttl_seconds int NOT NULL CHECK (ttl_seconds > 0),
  min_audit_ttl_seconds int NOT NULL DEFAULT 0,
  delete_mode text NOT NULL DEFAULT 'hard' CHECK (delete_mode IN ('hard', 'tombstone')),
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (scope_type, scope_id, artifact_type, classification)
);

CREATE TABLE retention_holds (
  id uuid PRIMARY KEY,
  resource_type text NOT NULL CHECK (resource_type IN ('artifact', 'run', 'repository')),
  resource_id uuid NOT NULL,
  reason text NOT NULL,
  placed_by text NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  released_by text,
  released_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1)
);
CREATE INDEX idx_holds_resource ON retention_holds (resource_type, resource_id) WHERE released_at IS NULL;

CREATE TABLE storage_operations (
  id uuid PRIMARY KEY,
  object_id uuid NOT NULL REFERENCES storage_objects(id),
  operation_type text NOT NULL CHECK (operation_type IN ('upload','finalize','delete')),
  operation_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed','dead_lettered')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version >= 1)
);
CREATE INDEX idx_ops_eligible ON storage_operations (status, lease_expires_at) WHERE status != 'completed';
