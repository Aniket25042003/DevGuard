/**
 * CP021 — durable dedup for GitHub comment ack posts.
 */
interface Queryish {
  query<T>(config: { text: string; values?: readonly unknown[] }): Promise<T[]>;
}

export class PostgresCommentAckDedupStore {
  constructor(private readonly pool: Queryish) {}

  /** Returns true when this (comment, ack) pair is newly claimed. */
  async tryClaim(githubCommentId: number, ackDigest: string): Promise<boolean> {
    const rows = await this.pool.query<{ github_comment_id: string }>({
      text: `INSERT INTO github_comment_acks (github_comment_id, ack_digest, status)
VALUES ($1, $2, 'pending')
ON CONFLICT (github_comment_id, ack_digest) DO NOTHING
RETURNING github_comment_id`,
      values: [githubCommentId, ackDigest],
    });
    return rows.length > 0;
  }

  async markApplied(githubCommentId: number, ackDigest: string): Promise<void> {
    await this.pool.query({
      text: `UPDATE github_comment_acks
SET status = 'applied'
WHERE github_comment_id = $1 AND ack_digest = $2 AND status = 'pending'`,
      values: [githubCommentId, ackDigest],
    });
  }

  async releaseClaim(githubCommentId: number, ackDigest: string): Promise<void> {
    await this.pool.query({
      text: `DELETE FROM github_comment_acks
WHERE github_comment_id = $1 AND ack_digest = $2 AND status = 'pending'`,
      values: [githubCommentId, ackDigest],
    });
  }
}

export class InMemoryCommentAckDedupStore {
  readonly #seen = new Set<string>();

  async tryClaim(githubCommentId: number, ackDigest: string): Promise<boolean> {
    const key = `${githubCommentId}:${ackDigest}`;
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    return true;
  }

  async markApplied(githubCommentId: number, ackDigest: string): Promise<void> {
    this.#seen.add(`${githubCommentId}:${ackDigest}`);
  }

  async releaseClaim(githubCommentId: number, ackDigest: string): Promise<void> {
    this.#seen.delete(`${githubCommentId}:${ackDigest}`);
  }
}
