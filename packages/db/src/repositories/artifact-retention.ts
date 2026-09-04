/**
 * C012 — expire SAFE artifacts older than the global default retention window.
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
  WHERE status = 'SAFE'
    AND COALESCE(retention_expires_at, created_at + ($2::int * interval '1 day')) <= now()
  ORDER BY created_at
  LIMIT $1
)
UPDATE artifacts
SET status = 'EXPIRED', updated_at = now(), row_version = row_version + 1
WHERE id IN (SELECT id FROM candidates)
RETURNING id::text AS id`,
      values: [batchSize, this.retentionDays],
    });
    return rows.length;
  }
}
