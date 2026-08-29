/** CP021 — worker GitHub comment ack adapter tests. */
import { describe, expect, it, vi } from 'vitest';
import type { IssueCommentWebhookEvent } from '@devguard/workflows';
import { InMemoryCommentAckDedupStore } from '@devguard/db';
import { WorkerGitHubCommentAckAdapter } from './github-comment-acks.js';
import type { PostIssueCommentAckResult } from '@devguard/github-adapter';

const EVENT: IssueCommentWebhookEvent = {
  action: 'created',
  comment: { id: 42, body: '@devguard help', user: { id: 1, login: 'octo' } },
  issue: { number: 3 },
  repository: { id: 99, owner: { login: 'octo' }, name: 'demo' },
  installation: { id: 7 },
};

describe('WorkerGitHubCommentAckAdapter (CP021)', () => {
  it('deduplicates identical ack posts for the same comment', async () => {
    const postAck = vi.fn(async (): Promise<PostIssueCommentAckResult> => ({
      ok: true,
      githubCommentId: 1,
    }));
    const dedup = new InMemoryCommentAckDedupStore();
    const adapter = new WorkerGitHubCommentAckAdapter({ postAck } as never, dedup);
    await adapter.postAck({ event: EVENT, message: 'help text' });
    await adapter.postAck({ event: EVENT, message: 'help text' });
    expect(postAck).toHaveBeenCalledTimes(1);
  });

  it('throws when installation id is missing', async () => {
    const adapter = new WorkerGitHubCommentAckAdapter(
      { postAck: async () => ({ ok: true, githubCommentId: 1 }) } as never,
      new InMemoryCommentAckDedupStore(),
    );
    await expect(
      adapter.postAck({
        event: { ...EVENT, installation: undefined },
        message: 'nope',
      }),
    ).rejects.toThrow(/missing_installation/);
  });
});
