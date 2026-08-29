-- CP021 — durable dedup for GitHub issue-comment ack posts (webhook retries).
CREATE TABLE github_comment_acks (
  github_comment_id bigint NOT NULL,
  ack_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied')),
  PRIMARY KEY (github_comment_id, ack_digest)
);
