/** CP021 — GitHub issue-comment ack service unit tests. */
import { describe, expect, it } from 'vitest';
import {
  GitHubBaseClient,
  GitHubIssueCommentAckService,
  InMemoryTokenLeaseCache,
  OP_CREATE_ISSUE_COMMENT,
  TokenLeaseManager,
  secretFrom,
  type GitHubTransport,
  type RawTransportResponse,
} from '@devguard/github-adapter';

const INSTALLATION_ID = '42';
const REPO_ID = '555';
const TOKEN = secretFrom('ghs_ack_test');

function transportPosting(
  captured: Array<{ method: string; path: string; body?: string }>,
): GitHubTransport {
  return {
    request: async (input) => {
      captured.push({ method: input.method, path: input.path, body: input.body });
      if (input.path.includes('/access_tokens')) {
        return {
          status: 201,
          headers: {},
          bodyText: JSON.stringify({
            token: TOKEN.expose(),
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        } satisfies RawTransportResponse;
      }
      return {
        status: 201,
        headers: { 'x-github-request-id': 'gh-ack-1' },
        bodyText: JSON.stringify({ id: 9001, body: 'Queued workflow run `run-1`.' }),
      } satisfies RawTransportResponse;
    },
  };
}

function makeService(captured: Array<{ method: string; path: string; body?: string }>) {
  const transport = transportPosting(captured);
  const tokenLeases = new TokenLeaseManager(
    new InMemoryTokenLeaseCache(),
    {
      mint: async () => ({
        token: TOKEN,
        expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    },
    () => Date.now(),
  );
  return new GitHubIssueCommentAckService({
    client: new GitHubBaseClient({ transport, apiVersion: '2022-11-28' }),
    tokenLeases,
    credentialVersion: 'test-key',
  });
}

describe('GitHubIssueCommentAckService (CP021)', () => {
  it('posts a sanitized ack body via github.create-issue-comment', async () => {
    const captured: Array<{ method: string; path: string; body?: string }> = [];
    const service = makeService(captured);
    const result = await service.postAck({
      correlationId: 'corr-ack',
      installationId: INSTALLATION_ID,
      githubRepositoryId: REPO_ID,
      owner: 'octo',
      repo: 'demo',
      issueNumber: 7,
      triggerCommentId: 100,
      body: 'Queued workflow run `run-1`.',
    });
    expect(result).toEqual({ ok: true, githubCommentId: 9001 });
    const write = captured.find((r) => r.path.includes('/issues/7/comments'));
    expect(write?.method).toBe('POST');
    expect(JSON.parse(write?.body ?? '{}')).toEqual({ body: 'Queued workflow run `run-1`.' });
    expect(OP_CREATE_ISSUE_COMMENT.operationId).toBe('github.create-issue-comment');
  });

  it('rejects ack bodies that look like secrets', async () => {
    const captured: Array<{ method: string; path: string; body?: string }> = [];
    const service = makeService(captured);
    const result = await service.postAck({
      correlationId: 'corr-bad',
      installationId: INSTALLATION_ID,
      githubRepositoryId: REPO_ID,
      owner: 'octo',
      repo: 'demo',
      issueNumber: 1,
      triggerCommentId: 2,
      body: 'token = supersecretvalue123456',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('VALIDATION');
    expect(captured.some((r) => r.path.includes('/comments'))).toBe(false);
  });
});
