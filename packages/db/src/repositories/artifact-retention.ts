/**
 * C012 — tombstone SAFE artifacts older than the global default retention window.
 */
const DEFAULT_RETENTION_DAYS = 30;

export class PostgresArtifactRetentionCleaner {
  constructor(
    private readonly poolLike: {
      query<T>(config: { text: string; values?: unknown[] }): Promise<T[]>;
    },
    private readonly retentionDays = DEFAULT_RETENTION_DAYS,
  ) {}

  async expireEligible(batchSize: number): Promise<number> {
    const rows = await this.poolLike.query<{ id: string }>({
      text: `
WITH candidates AS (
  SELECT id
  FROM artifacts
  WHERE deleted_at IS NULL
    AND scan_state = 'SAFE'
    AND created_at < now() - ($2::int * interval '1 day')
  ORDER BY created_at
  LIMIT $1
)
UPDATE artifacts
SET deleted_at = now()
WHERE id IN (SELECT id FROM candidates)
RETURNING id::text AS id`,
      values: [batchSize, this.retentionDays],
    });
    return rows.length;
  }
}
