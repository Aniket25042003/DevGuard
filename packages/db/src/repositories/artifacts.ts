/**
 * CP012 (C012/C071) — durable artifact metadata store.
 *
 * Only SAFE + non-deleted artifacts are ever listed/downloaded. Object bytes
 * live in `@devguard/artifact-storage` behind the `object_key`.
 */
export interface StoredArtifact {
  readonly id: string;
  readonly runId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly objectKey: string;
  readonly scanState: 'SAFE' | 'QUARANTINED' | 'REJECTED';
}

interface Queryish {
  query<T>(config: { text: string; values?: readonly unknown[] }): Promise<T[]>;
}

const COLS = `id::text AS id, run_id::text AS run_id, filename, content_type, size_bytes::text AS size_bytes, sha256, object_key::text AS object_key, scan_state`;

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
      text: `INSERT INTO artifacts (id, run_id, filename, content_type, size_bytes, sha256, object_key, scan_state)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING
RETURNING ${COLS}`,
      values: [
        input.id,
        input.runId,
        input.filename,
        input.contentType ?? 'application/octet-stream',
        input.sizeBytes,
        input.sha256,
        input.objectKey,
        input.scanState ?? 'SAFE',
      ],
    });
    const row = rows[0];
    if (row === undefined) throw new Error('ARTIFACT_WRITE_CONFLICT');
    return map(row);
  }

  /** List SAFE, non-deleted artifacts for a run (C071). */
  async listFor(runId: string): Promise<StoredArtifact[]> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT ${COLS} FROM artifacts WHERE run_id = $1 AND scan_state = 'SAFE' AND deleted_at IS NULL ORDER BY created_at DESC`,
      values: [runId],
    });
    return rows.map(map);
  }

  /** Get a single SAFE artifact or undefined (non-enumerating 404 for others). */
  async getSafe(id: string): Promise<StoredArtifact | undefined> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT ${COLS} FROM artifacts WHERE id = $1 AND scan_state = 'SAFE' AND deleted_at IS NULL`,
      values: [id],
    });
    const row = rows[0];
    return row === undefined ? undefined : map(row);
  }
}
