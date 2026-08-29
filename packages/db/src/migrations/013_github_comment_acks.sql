-- CP021 — durable dedup for GitHub issue-comment ack posts (webhook retries).
CREATE TABLE github_comment_acks (
  github_comment_id bigint NOT NULL,
  ack_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (github_comment_id, ack_digest)
);
