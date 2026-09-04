/**
 * CP012 (C012/C071) — durable artifact metadata store.
 *
 * Only SAFE + non-deleted artifacts are ever listed/downloaded. Object bytes
 * live in `@devguard/artifact-storage`; the canonical relational record is
 * the richer C011 artifact row (`name`, `status`, `storage_object_id`).
 */
export interface StoredArtifact {
  readonly id: string;
  readonly runId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly objectKey: string;
  readonly scanState: 'SAFE' | 'QUARANTINED' | 'REJECTED' | 'PENDING_SCAN';
}

interface Queryish {
  query<T>(config: { text: string; values?: readonly unknown[] }): Promise<T[]>;
}

const COLS = `id::text AS id, run_id::text AS run_id, name AS filename,
  content_type, size_bytes::text AS size_bytes, checksum_sha256 AS sha256,
  COALESCE(metadata_json->>'objectKey', storage_object_id::text) AS object_key,
  CASE status WHEN 'SAFE' THEN 'SAFE' WHEN 'QUARANTINED' THEN 'QUARANTINED'
    WHEN 'PENDING_SCAN' THEN 'PENDING_SCAN' ELSE 'REJECTED' END AS scan_state`;

function map(row: Record<string, unknown>): StoredArtifact {
  return {
    id: String(row['id']),
    runId: String(row['run_id']),
    filename: String(row['filename']),
    contentType: String(row['content_type']),
    sizeBytes: Number(row['size_bytes'] ?? 0),
    sha256: String(row['sha256']),
    objectKey: String(row['object_key']),
    scanState: String(row['scan_state']) as StoredArtifact['scanState'],
  };
}

export class PostgresArtifactStore {
  constructor(private readonly pool: Queryish) {}

  async insert(input: {
    readonly id: string;
    readonly runId: string;
    readonly filename: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly objectKey: string;
    readonly contentType?: string | undefined;
    readonly scanState?: StoredArtifact['scanState'] | undefined;
  }): Promise<StoredArtifact> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `INSERT INTO artifacts
  (id, run_id, type, name, content_type, size_bytes, checksum_sha256, status, metadata_json)
VALUES ($1, $2, 'workflow-output', $3, $4, $5, $6,
  CASE $8 WHEN 'SAFE' THEN 'SAFE' WHEN 'QUARANTINED' THEN 'QUARANTINED'
    ELSE 'PENDING_SCAN' END,
  jsonb_build_object('objectKey', $7)) ON CONFLICT (id) DO NOTHING
RETURNING ${COLS}`,
      values: [
        input.id,
        input.runId,
        input.filename,
        input.contentType ?? 'application/octet-stream',
        input.sizeBytes,
        input.sha256,
        input.objectKey,
        input.scanState ?? 'PENDING_SCAN',
      ],
    });
    const row = rows[0];
    if (row === undefined) throw new Error('ARTIFACT_WRITE_CONFLICT');
    return map(row);
  }

  /** List SAFE, non-deleted artifacts for a run (C071). */
  async listFor(runId: string): Promise<StoredArtifact[]> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT ${COLS} FROM artifacts WHERE run_id = $1 AND status = 'SAFE' ORDER BY created_at DESC`,
      values: [runId],
    });
    return rows.map(map);
  }

  /** Get a single SAFE artifact or undefined (non-enumerating 404 for others). */
  async getSafe(id: string): Promise<StoredArtifact | undefined> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT ${COLS} FROM artifacts WHERE id = $1 AND status = 'SAFE'`,
      values: [id],
    });
    const row = rows[0];
    return row === undefined ? undefined : map(row);
  }
}
