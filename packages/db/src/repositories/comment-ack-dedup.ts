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
      text: `INSERT INTO github_comment_acks (github_comment_id, ack_digest)
VALUES ($1, $2)
ON CONFLICT (github_comment_id, ack_digest) DO NOTHING
RETURNING github_comment_id`,
      values: [githubCommentId, ackDigest],
    });
    return rows.length > 0;
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
}
